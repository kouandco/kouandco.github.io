"""Build data/wirp.json: the policy rate path priced by overnight index swaps for the Fed, ECB and BoE,
meeting by meeting, and archive it in data/history/wirp.csv.

- Curves: Eurex Clearing end-of-day OIS discount curves (data/curves.json): USD.FEDFUNDS.1D for the Fed,
  EUR.ESTR.1D for the ECB, GBP.SONIA.1D for the BoE.
- Meeting dates: the central banks' own calendars (federalreserve.gov, ecb.europa.eu, bankofengland.co.uk).
- Current rates: NY Fed (EFFR and the target range), ECB Data Portal (deposit facility rate, €STR),
  Bank of England database (Bank Rate, SONIA).

Method: the average overnight rate the curve implies between two decisions taking effect is
(DF(start) / DF(end) − 1) × basis / days. A meeting's priced move is the change in that average from the
period before; the implied policy rate is today's rate plus the cumulative change, so the spread of the
overnight fixing to the policy rate (EFFR − mid of the Fed range, €STR − DFR, SONIA − Bank Rate) drops out.
Decisions take effect the next day (Fed), the following Wednesday (ECB) and the same day (BoE).
"""

import csv
import io
import json
import re
import time
from datetime import date, datetime, timedelta

import pandas as pd

import curves
from common import DATA, get, session, write_json

MONTHS = {m: i for i, m in enumerate(["January", "February", "March", "April", "May", "June", "July", "August",
                                       "September", "October", "November", "December"], 1)}
FOMC = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
ECB = "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html"
BOE = "https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates"
HORIZON_DAYS = 2 * 366


def fomc_dates(unscheduled=False):
    page = get(FOMC).text
    heads = list(re.finditer(r"(\d{4}) FOMC Meetings", page))
    out = []
    for i, h in enumerate(heads):
        block = page[h.end():heads[i + 1].start() if i + 1 < len(heads) else len(page)]
        year = int(h.group(1))
        months = re.findall(r'fomc-meeting__month[^>]*><strong>([^<]+)</strong>', block)
        days = re.findall(r'fomc-meeting__date[^>]*>([^<]+)<', block)
        for month, day in zip(months, days):
            if "notation" in day.lower() or ("unscheduled" in day.lower() and not unscheduled):
                continue
            last = month.split("/")[-1].strip()            # "Apr/May" meetings end in the second month
            m = re.findall(r"\d+", day)
            if last in MONTHS and m:
                out.append(date(year, MONTHS[last], int(m[-1])))
    return sorted(set(out))


def ecb_dates():
    page = get(ECB).text
    out = []
    for d, text in re.findall(r"<dt>\s*(\d\d/\d\d/\d{4})\s*</dt>\s*<dd>(.*?)</dd>", page, re.S):
        text = re.sub(r"<[^>]+>", " ", text).lower()
        # Two-day meetings decide on day 2; single-day meetings have no day marker.
        if "monetary policy meeting" in text and "non-monetary" not in text and "day 1" not in text:
            out.append(datetime.strptime(d, "%d/%m/%Y").date())
    out = sorted(set(out))
    # A two-day meeting whose first day is not labelled "Day 1" would appear twice: keep its last day.
    return [d for i, d in enumerate(out) if i + 1 == len(out) or (out[i + 1] - d).days > 2]


def boe_dates():
    text = re.sub(r"<script.*?</script>|<style.*?</style>", "", get(BOE).text, flags=re.S)
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>|&nbsp;", " ", text))
    out = []
    # Dates are listed per year under headings like "2026 dates" / "2027 confirmed dates", day and month only.
    parts = re.split(r"\b(20\d\d)(?: provisional| confirmed)? dates\b", text)
    for year, chunk in zip(parts[1::2], parts[2::2]):
        for day, month in re.findall(r"(?:Monday|Tuesday|Wednesday|Thursday|Friday) (\d\d?) (" + "|".join(MONTHS) + r")", chunk):
            out.append(date(int(year), MONTHS[month], int(day)))
    if not out:
        raise RuntimeError("no MPC dates found on the Bank of England page")
    return sorted(set(out))


def ecb_series(key):
    text = get(f"https://data-api.ecb.europa.eu/service/data/{key}?lastNObservations=5&format=csvdata").text
    rows = [r for r in csv.DictReader(io.StringIO(text)) if r["OBS_VALUE"]]
    rows = [r for r in rows if r["TIME_PERIOD"] <= str(date.today())]
    return rows[-1]["TIME_PERIOD"], float(rows[-1]["OBS_VALUE"])


def current_rates():
    effr = get("https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json").json()["refRates"][0]
    dfr_day, dfr = ecb_series("FM/D.U2.EUR.4F.KR.DFR.LEV")
    estr_day, estr = ecb_series("EST/B.EU000A2X2A25.WT")
    start = (date.today() - timedelta(days=20)).strftime("%d/%b/%Y")
    iadb = get("https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes"
               f"&Datefrom={start}&Dateto=now&SeriesCodes=IUDBEDR,IUDSOIA&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N").text
    boe = pd.read_csv(io.StringIO(iadb))
    boe["DATE"] = [str(datetime.strptime(d, "%d %b %Y").date()) for d in boe.DATE]
    bank_rate = boe.dropna(subset=["IUDBEDR"]).iloc[-1]
    sonia = boe.dropna(subset=["IUDSOIA"]).iloc[-1]
    lo, hi = float(effr["targetRateFrom"]), float(effr["targetRateTo"])
    return {
        "Fed": {"policy": (lo + hi) / 2, "policyLabel": f"Target range {lo:.2f}–{hi:.2f}% (mid)", "range": [lo, hi],
                "overnight": float(effr["percentRate"]), "overnightName": "EFFR", "fixingDate": effr["effectiveDate"]},
        "ECB": {"policy": dfr, "policyLabel": f"Deposit facility rate {dfr:.2f}% ({dfr_day})",
                "overnight": estr, "overnightName": "€STR", "fixingDate": estr_day},
        "BoE": {"policy": float(bank_rate["IUDBEDR"]), "policyLabel": f"Bank Rate {float(bank_rate['IUDBEDR']):.2f}% ({bank_rate['DATE']})",
                "overnight": float(sonia["IUDSOIA"]), "overnightName": "SONIA", "fixingDate": sonia["DATE"]},
    }


BANKS = {  # name, curve, day basis, decision -> effective date, calendar
    "Fed": ("Federal Reserve (FOMC)", "USD.FEDFUNDS.1D", 360, lambda d: d + timedelta(days=1), FOMC, fomc_dates),
    "ECB": ("European Central Bank", "EUR.ESTR.1D", 360, lambda d: d + timedelta(days=(2 - d.weekday()) % 7 or 7), ECB, ecb_dates),
    "BoE": ("Bank of England (MPC)", "GBP.SONIA.1D", 365, lambda d: d, BOE, boe_dates),
}


# ---------------------------------------------------------------- decision history

HISTORY_DAYS = 2 * 366
MONTH_NAMES = {v: k.lower() for k, v in MONTHS.items()}


def rate_history():
    """Daily policy rates and overnight fixings over the last two years, as {series: {date: rate}}."""
    start = date.today() - timedelta(days=HISTORY_DAYS + 30)
    effr = get("https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json"
               f"?startDate={start}&endDate={date.today()}").json()["refRates"]
    out = {"Fed target lower": {}, "Fed target upper": {}, "EFFR": {}}
    for r in effr:
        out["Fed target lower"][r["effectiveDate"]] = float(r["targetRateFrom"])
        out["Fed target upper"][r["effectiveDate"]] = float(r["targetRateTo"])
        out["EFFR"][r["effectiveDate"]] = float(r["percentRate"])
    for name, key in (("ECB deposit rate", "FM/D.U2.EUR.4F.KR.DFR.LEV"), ("€STR", "EST/B.EU000A2X2A25.WT")):
        text = get(f"https://data-api.ecb.europa.eu/service/data/{key}?startPeriod={start}&format=csvdata").text
        out[name] = {r["TIME_PERIOD"]: float(r["OBS_VALUE"]) for r in csv.DictReader(io.StringIO(text))
                     if r["OBS_VALUE"] and r["TIME_PERIOD"] <= str(date.today())}
    iadb = get("https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes"
               f"&Datefrom={start:%d/%b/%Y}&Dateto=now&SeriesCodes=IUDBEDR,IUDSOIA&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N").text
    boe = pd.read_csv(io.StringIO(iadb))
    days = [str(datetime.strptime(d, "%d %b %Y").date()) for d in boe.DATE]
    out["Bank Rate"] = {d: float(v) for d, v in zip(days, boe.IUDBEDR) if pd.notna(v)}
    out["SONIA"] = {d: float(v) for d, v in zip(days, boe.IUDSOIA) if pd.notna(v)}
    return out


def rate_on(series, d, after=False):
    """The rate in force on day `d` (last observation on or before it), or the first one after it."""
    days = sorted(series)
    if after:
        later = [x for x in days if x > str(d)]
        return series[later[0]] if later else None
    earlier = [x for x in days if x <= str(d)]
    return series[earlier[-1]] if earlier else None


def fed_decisions(rates, since):
    page = get(FOMC).text
    meetings = set(fomc_dates(unscheduled=True))  # rate decisions only: notation votes also have press releases
    out = []
    for href, ymd in sorted(set(re.findall(r'href="(/newsevents/pressreleases/monetary(\d{8})a\.htm)"', page))):
        d = datetime.strptime(ymd, "%Y%m%d").date()
        if d in meetings and since <= d <= date.today():
            before = (rate_on(rates["Fed target lower"], d), rate_on(rates["Fed target upper"], d))
            after = (rate_on(rates["Fed target lower"], d, True), rate_on(rates["Fed target upper"], d, True))
            if None in before or None in after:
                continue
            out.append({"date": str(d), "link": "https://www.federalreserve.gov" + href,
                        "before": f"{before[0]:.2f}–{before[1]:.2f}", "after": f"{after[0]:.2f}–{after[1]:.2f}",
                        "change": round((after[1] - before[1]) * 100)})
    return out


def ecb_decisions(rates, since):
    out, seen = [], set()
    for year in range(since.year, date.today().year + 1):
        page = get(f"https://www.ecb.europa.eu/press/govcdec/mopo/{year}/html/index_include.en.html").text
        for href, ymd in re.findall(r'href="(/press/pr/date/\d{4}/html/ecb\.mp(\d{6})[^"]*\.en\.html)"', page):
            d = datetime.strptime(ymd, "%y%m%d").date()
            if d in seen or not since <= d <= date.today():
                continue
            seen.add(d)
            before = rate_on(rates["ECB deposit rate"], d)
            after = rate_on(rates["ECB deposit rate"], d + timedelta(days=7))  # in force from the following Wednesday
            if before is None or after is None:
                continue
            out.append({"date": str(d), "link": "https://www.ecb.europa.eu" + href, "before": f"{before:.2f}",
                        "after": f"{after:.2f}", "change": round((after - before) * 100)})
    return out


def boe_decisions(rates, since):
    """MPC decisions from the monthly 'Monetary Policy Summary and minutes' pages (a month without a meeting
    redirects to a 404). Pages found are cached in data/history/boe_mpc.json with their date and vote."""
    path = DATA / "history" / "boe_mpc.json"
    cache = json.loads(path.read_text()) if path.exists() else {}
    m = date(since.year, since.month, 1)
    while m <= date.today():
        key = f"{m.year}/{MONTH_NAMES[m.month]}-{m.year}"
        recent = m >= date(date.today().year, date.today().month, 1) - timedelta(days=40)
        if key not in cache or (cache[key] is None and recent):
            url = f"https://www.bankofengland.co.uk/monetary-policy-summary-and-minutes/{key}"
            r = session.get(url, timeout=60, allow_redirects=False)
            text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", r.text)).replace("&ndash;", "–")
            published = re.search(r"Published on\s+(\d+ \w+ \d{4})", text) if r.status_code == 200 else None
            vote = re.search(r"voted (?:by a majority of |unanimously )?([\d–]*)\s*to (maintain|reduce|increase|raise|cut) Bank Rate", text)
            cache[key] = {"date": str(datetime.strptime(published.group(1), "%d %B %Y").date()), "link": url,
                          "vote": (vote.group(1) or "unanimous") if vote else None} if published else None
            time.sleep(0.3)
        m = date(m.year + (m.month == 12), m.month % 12 + 1, 1)
    write_json(path, cache)
    out = []
    for v in cache.values():
        if not v or not since <= date.fromisoformat(v["date"]) <= date.today():
            continue
        d = date.fromisoformat(v["date"])
        before, after = rate_on(rates["Bank Rate"], d - timedelta(days=1)), rate_on(rates["Bank Rate"], d)
        if before is None or after is None:
            continue
        out.append({"date": v["date"], "link": v["link"], "before": f"{before:.2f}", "after": f"{after:.2f}",
                    "change": round((after - before) * 100), "vote": v["vote"]})
    return out


def write_policy_history(rates):
    """data/gp/policy.json: daily policy rates and fixings for the GP page."""
    series = {"Fed funds target (mid)": {d: (lo + rates["Fed target upper"][d]) / 2 for d, lo in rates["Fed target lower"].items()},
              **{k: rates[k] for k in ("EFFR", "ECB deposit rate", "€STR", "Bank Rate", "SONIA")}}
    days = sorted({d for s in series.values() for d in s})
    filled = {}
    for k, s in series.items():
        last, vals = None, []
        for d in days:
            last = s.get(d, last) if k in ("Fed funds target (mid)", "ECB deposit rate", "Bank Rate") else s.get(d)
            vals.append(None if last is None else round(last, 4))
        filled[k] = vals
    write_json(DATA / "gp" / "policy.json", {"dates": days, "series": filled})


def average_rate(curve, a, b, basis):
    return (curve.df(a) / curve.df(b) - 1) * basis / (b - a).days * 100


def path(curve, basis, decisions, effective, policy):
    start = curve.as_of + timedelta(days=1)
    upcoming = [(d, effective(d)) for d in decisions if effective(d) > start and d <= curve.as_of + timedelta(days=HORIZON_DAYS)]
    if not upcoming:
        raise RuntimeError("no upcoming meetings within the curve horizon")
    ends = [e for _, e in upcoming[1:]] + [upcoming[-1][1] + timedelta(days=42)]
    base = average_rate(curve, start, upcoming[0][1], basis)
    rows, prev = [], base
    for (d, e), end in zip(upcoming, ends):
        avg = average_rate(curve, e, end, basis)
        rows.append({"date": str(d), "effective": str(e), "overnight": round(avg, 4),
                     "implied": round(policy + avg - base, 4), "change": round((avg - prev) * 100, 1),
                     "cumulative": round((avg - base) * 100, 1)})
        prev = avg
    return round(base, 4), rows


def forwards(curve, basis):
    """1-week forward overnight rate every week for two years, for the chart."""
    out, d = [], curve.as_of + timedelta(days=1)
    while d < curve.as_of + timedelta(days=HORIZON_DAYS):
        out.append({"date": str(d), "rate": round(average_rate(curve, d, d + timedelta(days=7), basis), 4)})
        d += timedelta(days=7)
    return out


def build():
    curve_set = curves.load()
    if not curve_set:
        raise RuntimeError("data/curves.json missing: run curves.py first")
    rates = current_rates()
    history = rate_history()
    write_policy_history(history)
    since = date.today() - timedelta(days=HISTORY_DAYS)
    decisions = {"Fed": fed_decisions, "ECB": ecb_decisions, "BoE": boe_decisions}
    out = {}
    for code, (name, curve_id, basis, effective, calendar, dates) in BANKS.items():
        curve = curve_set[curve_id]
        base, meetings = path(curve, basis, dates(), effective, rates[code]["policy"])
        past = sorted(decisions[code](history, since), key=lambda x: x["date"], reverse=True)
        out[code] = {"name": name, "curve": curve_id, "basis": basis, "calendar": calendar, **rates[code],
                     "priced": base, "meetings": meetings, "forwards": forwards(curve, basis), "decisions": past}
        nxt = meetings[0]
        print(f"{code}: {rates[code]['policyLabel']}; next {nxt['date']} {nxt['change']:+.1f}bp; "
              f"{meetings[min(7, len(meetings) - 1)]['date']} cumulative {meetings[min(7, len(meetings) - 1)]['cumulative']:+.1f}bp")
    as_of = str(next(iter(curve_set.values())).as_of)
    write_json(DATA / "wirp.json", {"built": str(date.today()), "curveDate": as_of, "source": curves.PAGE, "banks": out})

    path_csv = DATA / "history" / "wirp.csv"
    hist = pd.read_csv(path_csv, dtype=str) if path_csv.exists() else pd.DataFrame(columns=["date", "bank", "meeting", "implied"])
    new = pd.DataFrame([{"date": as_of, "bank": code, "meeting": m["date"], "implied": f"{m['implied']:.4f}"}
                        for code, b in out.items() for m in b["meetings"]])
    hist = pd.concat([hist[hist.date != as_of], new]).sort_values(["date", "bank", "meeting"])
    hist.to_csv(path_csv, index=False)
    wide = hist.assign(implied=hist.implied.astype(float)).pivot_table(index="date", columns=["bank", "meeting"], values="implied")

    # Constant-horizon pricing, comparable from one day to the next as meetings pass.
    gen_path = DATA / "history" / "wirp_generic.csv"
    gen = pd.read_csv(gen_path, index_col=0) if gen_path.exists() else pd.DataFrame()
    row = {}
    for code, b in out.items():
        ahead = lambda days: [m for m in b["meetings"] if m["date"] <= str(date.fromisoformat(as_of) + timedelta(days=days))]
        row[f"{code}|Next meeting move bp"] = b["meetings"][0]["change"]
        for label, days in (("6M", 183), ("1Y", 366)):
            last = ahead(days)[-1] if ahead(days) else None
            row[f"{code}|Cumulative move by {label} bp"] = last["cumulative"] if last else None
            row[f"{code}|Implied rate in {label} %"] = last["implied"] if last else None
    gen = pd.concat([gen.drop(index=as_of, errors="ignore"), pd.DataFrame(row, index=[as_of])]).sort_index()
    gen.index.name = "date"
    gen.to_csv(gen_path, float_format="%.4f")

    dates = sorted(set(wide.index) | set(gen.index.astype(str)))
    series = {k: [None if pd.isna(v) else float(v) for v in gen[k].reindex(dates)] for k in gen.columns}
    series.update({f"{b}|{m}": [None if pd.isna(v) else float(v) for v in wide[(b, m)].reindex(dates)] for b, m in wide.columns})
    write_json(DATA / "gp" / "wirp.json", {"dates": dates, "series": series})


if __name__ == "__main__":
    build()
