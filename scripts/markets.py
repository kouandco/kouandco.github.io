"""Build data/markets/<UST|DE|FR|IT>.json: every nominal fixed-coupon government bond with
price, yield, DV01, 3-month realised yield volatility and beta to the curve; a Nelson-Siegel
curve per issue type (used for roll down); generic curve points; a repo curve proxy.

Sources
- UST: TreasuryDirect FedInvest end-of-day prices, one date per query, so yields are archived
  in data/history/UST.csv; TreasuryDirect auction records for original terms; SOFR (NY Fed)
  and Treasury bill par yields for the repo curve.
- Bunds: Bundesbank prices and yields of listed Federal securities (monthly Excel files,
  one sheet per trading day).
- OATs and BTPs: Borsa Italiana (MOT / EuroMOT) bond lists and daily closing prices.
- EUR repo proxy: €STR and the ECB AAA euro area government spot curve.
"""

import csv
import io
import json
import re
import time
from datetime import date, datetime, timedelta, timezone
from functools import cache

import numpy as np
import pandas as pd
import requests
from pandas.tseries.holiday import USFederalHolidayCalendar

import curves
from common import (DATA, UA, accrued, add_business_days, curve_eval, dv01, frac_name, get, isin_from_cusip, ns_fit,
                    pricer, session, write_json, years, yield_from_price)

WINDOW = 63           # trading days in the realised-vol window (3 months)
HISTORY_DAYS = 100    # calendar days of history the analytics need
HISTORY_KEEP = 730    # calendar days of yield history kept for the GP page
FEDINVEST_PER_RUN = 30
MARKETS = {
    "UST": {"name": "US Treasuries", "currency": "$", "freq": 2, "settle": 1, "nodes": [2, 5, 7, 10, 20, 30]},
    "DE": {"name": "German Bunds", "currency": "€", "freq": 1, "settle": 2, "nodes": [2, 5, 10, 15, 30]},
    "FR": {"name": "French OATs", "currency": "€", "freq": 1, "settle": 2, "nodes": [2, 5, 10, 15, 30]},
    "IT": {"name": "Italian BTPs", "currency": "€", "freq": 2, "settle": 2, "nodes": [2, 5, 10, 15, 30]},
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
    hist = hist.dropna(how="all")
    static = pd.read_csv(static_path, dtype={"cusip": str}) if static_path.exists() else pd.DataFrame(
        columns=["cusip", "coupon", "maturity", "term"])
    known = {d.date() for d in hist.index}
    start = date.today() - timedelta(days=HISTORY_KEEP)
    holidays = {d.date() for d in USFederalHolidayCalendar().holidays(start, date.today())}
    missing = [start + timedelta(days=i) for i in range((date.today() - start).days)]
    missing = [d for d in missing if d.weekday() < 5 and d not in known and d not in holidays]
    # Newest first, capped per run: a first run backfills the history over several days. Days that come
    # back empty (not yet published, Good Friday, a FedInvest outage) are not stored, so they are retried.
    queried = missing[::-1][:FEDINVEST_PER_RUN]
    rows = {}
    for day in queried:
        px = fedinvest(day)
        print(f"  FedInvest {day}: {len(px)} notes and bonds")
        time.sleep(0.5)
        if not len(px):
            continue
        settle = add_business_days(day, 1)
        rows[pd.Timestamp(day)] = {
            r.cusip: round(yield_from_price(r.price, r.coupon, r.maturity, settle, 2), 5) for r in px.itertuples()
        }
        new = px[~px.cusip.isin(static.cusip)][["cusip", "coupon", "maturity"]]
        static = pd.concat([static, new.assign(term=np.nan)], ignore_index=True)
    recent = [d for d in queried if d >= date.today() - timedelta(days=7)]
    if len(recent) >= 2 and not any(pd.Timestamp(d) in rows for d in recent):
        raise RuntimeError(f"FedInvest returned no prices for {', '.join(map(str, sorted(recent)))}")
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
    on = float(sofr["percentRate"])
    points = [{"label": "O/N", "t": 1 / 365, "rate": on}]
    # Bills yield more than GC repo, so only their slope is used: term point = SOFR + (bill − 1-month bill).
    anchor = float(bills["1 Mo"])
    for col, label, t in (("1 Mo", "1M", 1 / 12), ("2 Mo", "2M", 2 / 12), ("3 Mo", "3M", 0.25), ("4 Mo", "4M", 4 / 12),
                          ("6 Mo", "6M", 0.5), ("1 Yr", "1Y", 1.0)):
        if col in bills and pd.notna(bills[col]):
            points.append({"label": label, "t": t, "rate": round(on + float(bills[col]) - anchor, 4)})
    return {
        "source": f"O/N: SOFR {sofr['effectiveDate']} (NY Fed). Term: SOFR plus the slope of the Treasury bill curve "
                  f"({bills['Date']:%Y-%m-%d}) beyond 1 month, as a proxy for term GC.",
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
    raw = raw[raw.date >= pd.Timestamp(date.today() - timedelta(days=HISTORY_KEEP))]
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
    """Daily closing prices. Bars are [time, open, open, high, low, close, volume]; today's bar is still
    forming during the session, so it is left out."""
    body = {"request": {"SampleTime": "1d", "TimeFrame": "2y", "RequestedDataSetType": "ohlc", "ChartPriceType": "price",
                        "Key": f"{isin}.MOT", "OffSetTime": 0, "FromDate": None, "ToDate": None, "UseDelay": True,
                        "KeyType": "Topic", "KeyType2": "Topic", "Language": "en-US"}}
    r = session.post("https://charts.borsaitaliana.it/charts/services/ChartWService.asmx/GetPricesWithVolume",
                     json=body, headers={"Referer": "https://www.borsaitaliana.it/"}, timeout=60)
    r.raise_for_status()
    bars = ((datetime.fromtimestamp(p[0] / 1000, tz=timezone.utc).date(), p[5]) for p in r.json().get("d", []))
    return {d: px for d, px in bars if px and d < date.today()}


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
        px = {d: p for d, p in px.items() if d >= date.today() - timedelta(days=HISTORY_KEEP)}
        if sum(d >= date.today() - timedelta(days=HISTORY_DAYS) for d in px) < 20:
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


@cache  # one fetch per run serves DE, FR and IT
def eur_repo():
    day, estr = ecb_last("EST/B.EU000A2X2A25.WT")
    points = [{"label": "S/N", "t": 1 / 365, "rate": estr}]  # no free S/N GC rate; €STR stands in
    for code, label, t in (("SR_3M", "3M", 0.25), ("SR_6M", "6M", 0.5), ("SR_9M", "9M", 0.75), ("SR_1Y", "1Y", 1.0)):
        aaa_day, rate = ecb_last(f"YC/B.U2.EUR.4F.G_N_A.SV_C_YM.{code}")
        points.append({"label": label, "t": t, "rate": round(rate, 4)})
    return {
        "source": f"S/N: €STR {day} (ECB). Term: ECB AAA euro area government spot curve {aaa_day}, a proxy for term "
                  "GC (country GC repo is not published freely). Adjust for Bund / OAT / BTP GC.",
        "points": points,
    }


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


BENCHMARK_TENORS = {"UST": [2, 3, 5, 7, 10, 20, 30], "DE": [2, 5, 10, 30], "FR": [2, 5, 10, 30], "IT": [2, 5, 10, 30]}


def benchmarks(code, bonds, settle):
    """The actual bond quoted as each generic tenor. UST: the latest issue of each original term (on the run).
    Bunds: the latest Schatz and Bobl, the newest Bund in the 10-year window and the longest Bund. OATs and BTPs, whose original terms
    are not published in the price data: the most recently issued line (highest ISIN, as the issuers number
    lines sequentially) maturing within the tenor's window."""
    nominal = [b for b in bonds if b["group"] != "Green"]
    t = lambda b: years(settle, date.fromisoformat(b["maturity"]))
    out = []
    for tenor in BENCHMARK_TENORS[code]:
        if code == "UST":
            pool, pick = [b for b in nominal if b["group"] == f"{tenor}Y"], lambda b: b["maturity"]
        elif code == "DE":
            group = {2: "Schatz", 5: "Bobl"}.get(tenor, "Bund")
            # Old 30-year Bunds roll into the 10-year window, so the 10-year is the newest line there.
            pool = [b for b in nominal if b["group"] == group and (tenor != 10 or 8.5 <= t(b) <= 10.75)]
            pick = (lambda b: b["id"]) if tenor == 10 else (lambda b: b["maturity"])
        else:
            lo, hi = {2: (1.5, 2.6), 5: (4, 5.6), 10: (8.5, 10.6), 30: (24, 32)}[tenor]
            pool, pick = [b for b in nominal if lo <= t(b) <= hi], lambda b: b["id"]
        if pool:
            b = max(pool, key=pick)
            out.append({"tenor": tenor, "id": b["id"], "name": b["name"], "yield": b["yield"], "asw": b.get("asw")})
    return out


def merge_history(code, yields):
    """Euro-area sources only serve a few months to two years of prices: keep everything seen in
    data/history/<code>.csv, newer values winning."""
    path = DATA / "history" / f"{code}.csv"
    if path.exists():
        old = pd.read_csv(path, index_col=0, parse_dates=True)
        yields = yields.combine_first(old) if len(old) else yields
    yields = yields[yields.index >= pd.Timestamp(date.today() - timedelta(days=HISTORY_KEEP))].sort_index()
    yields.to_csv(path, float_format="%.5f")
    return yields


def add_asw(code, data, curve_set):
    if not curve_set:
        return
    settle = date.fromisoformat(data["settle"])
    for b in data["bonds"]:
        maturity = date.fromisoformat(b["maturity"])
        dirty = b["price"] + accrued(b["coupon"], maturity, settle, data["freq"])
        b["asw"] = round(curves.asw(curve_set, code, b["coupon"], maturity, settle, data["freq"], dirty), 1)
    data["aswSource"] = (f"Par-par asset swap spread vs {'SOFR' if code == 'UST' else '6M Euribor'} "
                         f"({'SOFR' if code == 'UST' else '€STR'} discounting), Eurex Clearing curves of "
                         f"{curve_set[next(iter(curve_set))].as_of}.")


FIT_TENORS = [2, 5, 10, 30]


def fit_history(bonds, yields):
    """The all-bond Nelson-Siegel curve at 2, 5, 10 and 30 years for every day of the history, fitted as
    in analyse(): maturities from that day, bad prints (> 40bp off a first fit) dropped, at least 8 bonds."""
    maturity = dict(zip(bonds.id, bonds.maturity))
    ids = [i for i in yields.columns if i in maturity]
    mats = np.array([pd.Timestamp(maturity[i]).value for i in ids], dtype=float)
    out = {t: [] for t in FIT_TENORS}
    for day, row in yields[ids].iterrows():
        t = (mats - day.value) / (365.25 * 864e11)
        y = row.values.astype(float)
        ok = ~np.isnan(y) & (t > 0.25)
        nodes = [None] * len(FIT_TENORS)
        if ok.sum() >= 8:
            fit = ns_fit(t[ok], y[ok])
            keep = ok & (np.abs(y - curve_eval(fit, t)) < 0.4)
            if keep.sum() >= 8:
                nodes = [round(float(v), 4) for v in curve_eval(ns_fit(t[keep], y[keep]), FIT_TENORS)]
        for k, v in zip(FIT_TENORS, nodes):
            out[k].append(v)
    return out


def write_gp(code, data, yields, bonds):
    """data/gp/<code>.json: daily yield (and ASW, archived from the day it was added) of every current bond."""
    ids = [b["id"] for b in data["bonds"]]
    y = yields.reindex(columns=ids).dropna(how="all")
    asw_path = DATA / "history" / f"ASW_{code}.csv"
    asw = pd.read_csv(asw_path, index_col=0) if asw_path.exists() else pd.DataFrame()
    if any("asw" in b for b in data["bonds"]):
        today = pd.DataFrame({b["id"]: b["asw"] for b in data["bonds"]}, index=[data["asOf"]])
        asw = pd.concat([asw.drop(index=data["asOf"], errors="ignore"), today]).sort_index()
        asw = asw[asw.index >= str(date.today() - timedelta(days=HISTORY_KEEP))]
        asw.index.name = "date"
        asw.to_csv(asw_path, float_format="%.1f")
    col = lambda df, i, d: [None if pd.isna(v) else round(float(v), d) for v in df[i]] if i in df else None
    all_days = yields.dropna(how="all").sort_index()
    write_json(DATA / "gp" / f"{code}.json", {
        "fitDates": [str(d.date()) for d in all_days.index],
        "fit": {str(k): v for k, v in fit_history(bonds, all_days).items()},
        "market": code, "freq": data["freq"], "settleDays": MARKETS[code]["settle"],
        "dates": [str(d.date()) for d in y.index],
        "bonds": [{"id": b["id"], "name": b["name"], "group": b["group"], "coupon": b["coupon"], "maturity": b["maturity"]}
                  for b in data["bonds"]],
        "yield": {i: col(y, i, 4) for i in ids},
        "aswDates": list(asw.index.astype(str)),
        "asw": {i: col(asw, i, 1) for i in ids if i in asw},
    })


def build(code):
    bonds, yields = SOURCES[code]()
    if code != "UST":
        yields = merge_history(code, yields)
    data = analyse(code, bonds, yields)
    add_asw(code, data, curves.load())
    data["benchmarks"] = benchmarks(code, data["bonds"], date.fromisoformat(data["settle"]))
    write_gp(code, data, yields, bonds)
    path = DATA / "markets" / f"{code}.json"
    try:
        data["repo"] = us_repo() if code == "UST" else eur_repo()
    except Exception as e:
        # A repo source outage shouldn't discard fresh bond prices: keep the last repo curve.
        prev = json.loads(path.read_text()).get("repo") if path.exists() else None
        if not prev:
            raise
        print(f"{code}: repo fetch failed ({type(e).__name__}: {e}); keeping previous repo curve")
        source = re.sub(r" \(stale: .*\)$", "", prev["source"])
        data["repo"] = {**prev, "source": f"{source} (stale: refresh failed {date.today()})"}
    write_json(path, data)
    print(f"{code}: {len(data['bonds'])} bonds as of {data['asOf']}")


if __name__ == "__main__":
    import sys
    for code in sys.argv[1:] or SOURCES:
        build(code)
