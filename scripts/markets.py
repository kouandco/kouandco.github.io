"""Build data/markets/<UST|DE|FR|IT>.json: every nominal fixed-coupon government bond with
price, yield, DV01, 3-month realised yield volatility and beta to the curve; a Nelson-Siegel
curve per issue type (used for roll down); generic curve points; a repo curve proxy; news.

Sources
- UST: TreasuryDirect FedInvest end-of-day prices, one date per query, so yields are archived
  in data/history/UST.csv; TreasuryDirect auction records for original terms; SOFR (NY Fed)
  and Treasury bill par yields for the repo curve.
- Bunds: Bundesbank prices and yields of listed Federal securities (monthly Excel files,
  one sheet per trading day).
- OATs and BTPs: Borsa Italiana (MOT / EuroMOT) bond lists and daily closing prices.
- EUR repo proxy: €STR and the ECB AAA euro area government spot curve.
- News: Google News RSS search.
"""

import csv
import io
import re
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import numpy as np
import pandas as pd
import requests

from common import (DATA, UA, add_business_days, curve_eval, dv01, frac_name, get, isin_from_cusip, ns_fit,
                    pricer, session, write_json, years, yield_from_price)

WINDOW = 63           # trading days in the realised-vol window (3 months)
HISTORY_DAYS = 100    # calendar days of history fetched / kept
MARKETS = {
    "UST": {"name": "US Treasuries", "currency": "$", "freq": 2, "settle": 1, "nodes": [2, 5, 7, 10, 20, 30],
            "news": "Treasury yields"},
    "DE": {"name": "German Bunds", "currency": "€", "freq": 1, "settle": 2, "nodes": [2, 5, 10, 15, 30],
           "news": "Bund yields"},
    "FR": {"name": "French OATs", "currency": "€", "freq": 1, "settle": 2, "nodes": [2, 5, 10, 15, 30],
           "news": "French government bonds OAT"},
    "IT": {"name": "Italian BTPs", "currency": "€", "freq": 2, "settle": 2, "nodes": [2, 5, 10, 15, 30],
           "news": "Italian government bonds BTP"},
}


# ---------------------------------------------------------------- UST

def fedinvest(day):
    """End-of-day prices of marketable Treasuries for one date (empty on holidays)."""
    s = requests.Session()
    s.headers.update(UA)
    url = "https://www.treasurydirect.gov/GA-FI/FedInvest/selectSecurityPriceDate"
    form = s.get(url, timeout=60).text
    token = re.search(r'name="_csrf" value="([^"]+)"', form).group(1)
    r = s.post(url, data={"_csrf": token, "priceDate": day.isoformat(), "submit": "Show Prices"}, timeout=90)
    r.raise_for_status()
    try:
        t = pd.read_html(io.StringIO(r.text))[0]
    except ValueError:
        return pd.DataFrame()
    t = t[t["SECURITY TYPE"].isin(["MARKET BASED NOTE", "MARKET BASED BOND"]) & (t["END OF DAY"] > 0)]
    return pd.DataFrame({
        "cusip": t["CUSIP"],
        "coupon": t["RATE"].str.rstrip("%").astype(float),
        "maturity": pd.to_datetime(t["MATURITY DATE"], format="%m/%d/%Y").dt.date,
        "price": t["END OF DAY"].astype(float),
    })


def treasury_terms():
    """Original term in years (2, 3, 5, 7, 10, 20, 30) by CUSIP, from auction records."""
    terms = {}
    for kind, names in (("Note", ["2-Year", "3-Year", "5-Year", "7-Year", "10-Year"]), ("Bond", ["20-Year", "30-Year"])):
        for term in names:
            url = ("https://www.treasurydirect.gov/TA_WS/securities/search?format=json"
                   f"&type={kind}&securityTerm={term}&startDate=1985-01-01&endDate={date.today()}")
            for r in get(url, timeout=120).json():
                terms.setdefault(r["cusip"], int(r["originalSecurityTerm"].split("-")[0]))
    return terms


def ust():
    hist_path, static_path = DATA / "history" / "UST.csv", DATA / "history" / "UST_bonds.csv"
    hist = pd.read_csv(hist_path, index_col=0, parse_dates=True) if hist_path.exists() else pd.DataFrame()
    static = pd.read_csv(static_path, dtype={"cusip": str}) if static_path.exists() else pd.DataFrame(
        columns=["cusip", "coupon", "maturity", "term"])
    known = {d.date() for d in hist.index}
    start = date.today() - timedelta(days=HISTORY_DAYS)
    missing = [start + timedelta(days=i) for i in range((date.today() - start).days)]
    missing = [d for d in missing if d.weekday() < 5 and d not in known]
    rows = {}
    for day in missing:
        px = fedinvest(day)
        settle = add_business_days(day, 1)
        rows[pd.Timestamp(day)] = {
            r.cusip: round(yield_from_price(r.price, r.coupon, r.maturity, settle, 2), 5) for r in px.itertuples()
        }
        if len(px):
            new = px[~px.cusip.isin(static.cusip)][["cusip", "coupon", "maturity"]]
            static = pd.concat([static, new.assign(term=np.nan)], ignore_index=True)
        print(f"  FedInvest {day}: {len(px)} notes and bonds")
        time.sleep(0.5)
    if rows:
        hist = pd.concat([hist, pd.DataFrame.from_dict(rows, orient="index")]).sort_index()
    hist = hist[hist.index >= pd.Timestamp(start)]
    if static.term.isna().any():
        terms = treasury_terms()
        static["term"] = static.term.fillna(static.cusip.map(terms))
    hist_path.parent.mkdir(parents=True, exist_ok=True)
    hist.to_csv(hist_path, float_format="%.5f")
    static.to_csv(static_path, index=False)

    static["maturity"] = pd.to_datetime(static.maturity).dt.date
    bonds = pd.DataFrame({
        "id": static.cusip.map(isin_from_cusip),
        "cusip": static.cusip,
        "name": [f"T {frac_name(c)} {m:%m/%d/%y}" for c, m in zip(static.coupon, static.maturity)],
        "coupon": static.coupon,
        "maturity": static.maturity,
        "group": [f"{int(t)}Y" if t == t else "Other" for t in static.term],
    })
    yields = hist.dropna(how="all").rename(columns=dict(zip(static.cusip, bonds.id)))
    return bonds, yields


def us_repo():
    sofr = get("https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json").json()["refRates"][0]
    year = date.today().year
    url = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/"
           f"{year}/all?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv")
    bills = pd.read_csv(io.StringIO(get(url).text), parse_dates=["Date"]).sort_values("Date").iloc[-1]
    points = [{"label": "O/N", "t": 1 / 365, "rate": float(sofr["percentRate"])}]
    for col, label, t in (("1 Mo", "1M", 1 / 12), ("2 Mo", "2M", 2 / 12), ("3 Mo", "3M", 0.25), ("4 Mo", "4M", 4 / 12),
                          ("6 Mo", "6M", 0.5), ("1 Yr", "1Y", 1.0)):
        if col in bills and pd.notna(bills[col]):
            points.append({"label": label, "t": t, "rate": float(bills[col])})
    return {
        "source": f"O/N: SOFR {sofr['effectiveDate']} (NY Fed). Term: Treasury bill par yields "
                  f"{bills['Date']:%Y-%m-%d} as a proxy for term GC.",
        "points": points,
    }


# ---------------------------------------------------------------- Bunds

def bundesbank():
    page = get("https://www.bundesbank.de/en/service/federal-securities/prices-and-yields").text
    links = sorted(set(re.findall(r'href="(/resource/blob/[^"]+/(\d{4}-\d\d)-excel-data\.xlsx)"', page)), key=lambda x: x[1])
    frames = []
    for href, _ in links[-5:]:
        book = pd.read_excel(io.BytesIO(get("https://www.bundesbank.de" + href).content), sheet_name=None, header=None)
        for sheet, df in book.items():
            day = datetime.strptime(sheet.strip(), "%d.%m.%Y").date()
            df = df.iloc[2:, [0, 1, 2, 3, 6, 7]].dropna(subset=[0, 7])
            df.columns = ["id", "coupon", "desc", "maturity", "price", "yield"]
            frames.append(df.assign(date=pd.Timestamp(day)))
    raw = pd.concat(frames)
    raw["desc"] = raw.desc.astype(str).str.strip()
    raw = raw[raw.desc.str.match(r"^(BKO|OBL|DBR) ")]
    raw = raw[raw.date >= pd.Timestamp(date.today() - timedelta(days=HISTORY_DAYS))]
    last = raw.sort_values("date").groupby("id").last()
    group = {"BKO": "Schatz", "OBL": "Bobl", "DBR": "Bund"}
    bonds = pd.DataFrame({
        "id": last.index,
        "name": [re.sub(r" (\d{3}|TWIN)\b", "", re.sub(r"\s+", " ", d)) for d in last.desc],
        "coupon": last.coupon.astype(float).values,
        "maturity": pd.to_datetime(last.maturity).dt.date.values,
        "group": ["Green" if d.endswith(" G") else group[d[:3]] for d in last.desc],
    })
    yields = raw.pivot_table(index="date", columns="id", values="yield", aggfunc="last").astype(float)
    return bonds, yields


# ---------------------------------------------------------------- OATs and BTPs (Borsa Italiana)

def borsa_list(path, prefix):
    """All bonds on a Borsa Italiana list page whose ISIN starts with `prefix` (lists are sorted by ISIN)."""
    rows, seen = [], set()
    for page in range(1, 200):
        html = get(f"https://www.borsaitaliana.it/borsa/obbligazioni/mot/{path}/lista.html?lang=en&page={page}").text
        try:
            t = pd.read_html(io.StringIO(html))[0]
        except ValueError:
            break
        isins = t.Isin.astype(str).str[:12]  # the cell also repeats the row's text for the mobile layout
        t = t.assign(Isin=isins)
        if set(isins) <= seen:
            break
        seen |= set(isins)
        rows.append(t[isins.str.startswith(prefix)])
        if (isins.str[:2] > prefix).all():
            break
    df = pd.concat(rows)
    return pd.DataFrame({"id": df.Isin.astype(str), "desc": df.Description.astype(str),
                         "maturity": pd.to_datetime(df.Expiry, format="%Y/%m/%d").dt.date, "couponCol": df.Coupon})


def parse_coupon(desc, coupon_col, freq):
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*%", desc) or re.search(r"Eur\s+(\d+(?:[.,]\d+)?)$", desc)
    if m:
        return float(m.group(1).replace(",", "."))
    return float(coupon_col) * freq if pd.notna(coupon_col) else None


def borsa_history(isin):
    body = {"request": {"SampleTime": "1d", "TimeFrame": "6m", "RequestedDataSetType": "ohlc", "ChartPriceType": "price",
                        "Key": f"{isin}.MOT", "OffSetTime": 0, "FromDate": None, "ToDate": None, "UseDelay": True,
                        "KeyType": "Topic", "KeyType2": "Topic", "Language": "en-US"}}
    r = session.post("https://charts.borsaitaliana.it/charts/services/ChartWService.asmx/GetPricesWithVolume",
                     json=body, headers={"Referer": "https://www.borsaitaliana.it/"}, timeout=60)
    r.raise_for_status()
    return {datetime.fromtimestamp(p[0] / 1000, tz=timezone.utc).date(): p[1] for p in r.json().get("d", []) if p[1]}


def borsa_market(path, prefix, keep, prefix_name, freq):
    lst = borsa_list(path, prefix)
    lst = lst[lst.desc.map(keep) & (lst.maturity > date.today() + timedelta(days=30))]
    static, series = [], {}
    for r in lst.itertuples():
        coupon = parse_coupon(r.desc, r.couponCol, freq)
        if coupon is None:
            continue
        px = borsa_history(r.id)
        time.sleep(0.2)
        px = {d: p for d, p in px.items() if d >= date.today() - timedelta(days=HISTORY_DAYS)}
        if len(px) < 20:
            continue
        series[r.id] = {pd.Timestamp(d): round(yield_from_price(p, coupon, r.maturity, add_business_days(d, 2), freq), 5)
                        for d, p in px.items()}
        green = "green" in r.desc.lower()
        static.append({"id": r.id, "name": f"{prefix_name} {coupon:g} {r.maturity:%m/%d/%y}" + (" G" if green else ""),
                       "coupon": coupon, "maturity": r.maturity, "group": "Green" if green else prefix_name})
    if len(series) < len(lst) / 2:
        raise RuntimeError(f"price history for only {len(series)} of {len(lst)} {prefix_name} bonds")
    return pd.DataFrame(static), pd.DataFrame(series).sort_index()


def btp():
    excluded = ("stripital", "valore", "futura", "italia", "hybrid", "strip", " sc ")
    keep = lambda d: re.match(r"^Btp(green|[- ])", d, re.I) is not None and not any(x in d.lower() for x in excluded)
    return borsa_market("btp", "IT", keep, "BTPS", 2)


def oat():
    keep = lambda d: d.startswith("Oat ") and not re.search(r"oatei|oati|strip", d, re.I)
    return borsa_market("euro-obbligazioni", "FR", keep, "FRTR", 1)


def ecb_last(key):
    text = get(f"https://data-api.ecb.europa.eu/service/data/{key}?lastNObservations=1&format=csvdata").text
    row = list(csv.DictReader(io.StringIO(text)))[-1]
    return row["TIME_PERIOD"], float(row["OBS_VALUE"])


def eur_repo():
    day, estr = ecb_last("EST/B.EU000A2X2A25.WT")
    points = [{"label": "O/N", "t": 1 / 365, "rate": estr}]
    for code, label, t in (("SR_3M", "3M", 0.25), ("SR_6M", "6M", 0.5), ("SR_9M", "9M", 0.75), ("SR_1Y", "1Y", 1.0)):
        aaa_day, rate = ecb_last(f"YC/B.U2.EUR.4F.G_N_A.SV_C_YM.{code}")
        points.append({"label": label, "t": t, "rate": round(rate, 4)})
    return {
        "source": f"O/N: €STR {day} (ECB). Term: ECB AAA euro area government spot curve {aaa_day}, a proxy for term "
                  "GC (country GC repo is not published freely). Adjust for Bund / OAT / BTP GC.",
        "points": points,
    }


# ---------------------------------------------------------------- news

def news(query):
    url = f"https://news.google.com/rss/search?q={requests.utils.quote(query)}+when:7d&hl=en-GB&gl=GB&ceid=GB:en"
    items = ET.fromstring(get(url).content).iter("item")
    out = []
    for it in items:
        source = it.findtext("source") or ""
        title = it.findtext("title") or ""
        if source and title.endswith(f" - {source}"):
            title = title[: -len(source) - 3]
        out.append({"title": title, "link": it.findtext("link"), "source": source,
                    "date": parsedate_to_datetime(it.findtext("pubDate")).strftime("%Y-%m-%d %H:%M")})
    return sorted(out, key=lambda x: x["date"], reverse=True)[:10]


# ---------------------------------------------------------------- analytics

def winsorise(x, k=4):
    """Clip daily changes to the median ± k robust standard deviations (1.4826 × MAD), so a stale
    or off-market closing price does not dominate the realised volatility of an illiquid line."""
    med = np.median(x)
    sd = 1.4826 * np.median(np.abs(x - med))
    return np.clip(x, med - k * sd, med + k * sd) if sd > 0 else x


def analyse(code, bonds, yields):
    cfg = MARKETS[code]
    freq = cfg["freq"]
    yields = yields.sort_index()
    yields = yields[yields.index <= pd.Timestamp(date.today())]
    as_of = yields.index[-1].date()
    settle = add_business_days(as_of, cfg["settle"])
    # Latest yield per bond, if quoted in the last week.
    recent = yields[yields.index >= pd.Timestamp(as_of - timedelta(days=7))]
    last = recent.ffill().iloc[-1]
    bonds = bonds[bonds.id.isin(last.dropna().index)].copy()
    bonds["yield"] = bonds.id.map(last)
    bonds["t"] = [years(settle, m) for m in bonds.maturity]
    bonds = bonds[bonds.t > 0.1]

    # Drop bad prints: more than 40bp from a curve fitted to all bonds.
    fit_all = ns_fit(bonds.t, bonds["yield"])
    bonds = bonds[(bonds["yield"] - curve_eval(fit_all, bonds.t)).abs() < 0.4]
    fit_all = ns_fit(bonds.t, bonds["yield"])

    # Daily all-bond curve fits over the window: realised vols of generic points and bond betas.
    window = yields[bonds.id].iloc[-(WINDOW + 1):]
    t = bonds.t.values
    fits = []
    for _, row in window.iterrows():
        ok = row.notna().values & (t > 0.25)
        fits.append(ns_fit(t[ok], row.values[ok]) if ok.sum() >= 8 else None)
    valid = [i for i, f in enumerate(fits) if f]
    curve_at = np.array([curve_eval(fits[i], t) for i in valid])            # dates x bonds
    nodes_hist = np.array([curve_eval(fits[i], cfg["nodes"]) for i in valid])
    d_curve = np.diff(curve_at, axis=0)
    d_y = window.iloc[valid].diff().iloc[1:].values
    vols, betas = [], []
    for j in range(len(bonds)):
        ok = ~np.isnan(d_y[:, j])
        if ok.sum() >= 20:
            vols.append(float(np.std(winsorise(d_y[ok, j]), ddof=1) * np.sqrt(252) * 100))
            x, y = d_curve[ok, j], d_y[ok, j]
            betas.append(float(np.clip(np.cov(x, y)[0, 1] / np.var(x, ddof=1), 0.5, 1.5)) if np.var(x) > 0 else 1.0)
        else:
            vols.append(None)
            betas.append(1.0)
    node_vol = np.std(np.diff(nodes_hist, axis=0), axis=0, ddof=1) * np.sqrt(252) * 100

    groups = {}
    for g, sub in bonds.groupby("group"):
        if len(sub) >= 5:
            groups[g] = {"fit": ns_fit(sub.t, sub["yield"]), "tmin": float(sub.t.min()), "tmax": float(sub.t.max()), "n": len(sub)}

    out_bonds = []
    for (_, b), vol, beta in zip(bonds.iterrows(), vols, betas):
        price = pricer(b.coupon, b.maturity, settle, freq)(b["yield"])
        out_bonds.append({
            "id": b.id, "name": b["name"], "coupon": float(b.coupon), "maturity": str(b.maturity), "group": b.group,
            "price": round(price, 4), "yield": round(float(b["yield"]), 4),
            "dv01": round(dv01(b["yield"], b.coupon, b.maturity, settle, freq), 5),
            "vol": None if vol is None else round(vol, 1), "beta": round(beta, 2),
            **({"cusip": b.cusip} if "cusip" in b else {}),
        })
    out_bonds.sort(key=lambda x: x["maturity"])
    return {
        "market": code, "name": cfg["name"], "currency": cfg["currency"], "freq": freq,
        "asOf": str(as_of), "settle": str(settle),
        "curve": fit_all,
        "nodes": [{"t": n, "yield": round(float(y), 4), "vol": round(float(v))}
                  for n, y, v in zip(cfg["nodes"], curve_eval(fit_all, cfg["nodes"]), node_vol)],
        "groups": groups,
        "bonds": out_bonds,
    }


SOURCES = {"UST": ust, "DE": bundesbank, "FR": oat, "IT": btp}


def build(code):
    bonds, yields = SOURCES[code]()
    data = analyse(code, bonds, yields)
    data["repo"] = us_repo() if code == "UST" else eur_repo()
    try:
        data["news"] = news(MARKETS[code]["news"])
    except Exception as e:  # news is optional
        print(f"  news failed: {e}")
        data["news"] = []
    write_json(DATA / "markets" / f"{code}.json", data)
    print(f"{code}: {len(data['bonds'])} bonds as of {data['asOf']}")


if __name__ == "__main__":
    import sys
    for code in sys.argv[1:] or SOURCES:
        build(code)
