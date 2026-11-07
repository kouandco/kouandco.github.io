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
import re
from datetime import date, datetime, timedelta

import pandas as pd

import curves
from common import DATA, get, write_json

MONTHS = {m: i for i, m in enumerate(["January", "February", "March", "April", "May", "June", "July", "August",
                                       "September", "October", "November", "December"], 1)}
FOMC = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
ECB = "https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html"
BOE = "https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates"
HORIZON_DAYS = 2 * 366


def fomc_dates():
    page = get(FOMC).text
    heads = list(re.finditer(r"(\d{4}) FOMC Meetings", page))
    out = []
    for i, h in enumerate(heads):
        block = page[h.end():heads[i + 1].start() if i + 1 < len(heads) else len(page)]
        year = int(h.group(1))
        months = re.findall(r'fomc-meeting__month[^>]*><strong>([^<]+)</strong>', block)
        days = re.findall(r'fomc-meeting__date[^>]*>([^<]+)<', block)
        for month, day in zip(months, days):
            if "notation" in day.lower() or "unscheduled" in day.lower():
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
    out = {}
    for code, (name, curve_id, basis, effective, calendar, dates) in BANKS.items():
        curve = curve_set[curve_id]
        base, meetings = path(curve, basis, dates(), effective, rates[code]["policy"])
        out[code] = {"name": name, "curve": curve_id, "basis": basis, "calendar": calendar, **rates[code],
                     "priced": base, "meetings": meetings, "forwards": forwards(curve, basis)}
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
    write_json(DATA / "gp" / "wirp.json", {
        "dates": list(wide.index),
        "series": {f"{b}|{m}": [None if pd.isna(v) else float(v) for v in wide[(b, m)]] for b, m in wide.columns},
    })


if __name__ == "__main__":
    build()
