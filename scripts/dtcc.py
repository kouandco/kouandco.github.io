"""Build the DTCC page data: interest rate swaps publicly reported to the DTCC swap data repository
(CFTC public dissemination), by currency and floating index.

Source: DTCC's cumulative CFTC rates report, one zipped CSV per day (URL below). It covers swaps with a
US person on at least one side, so USD dominates and other currencies show only part of their market.
A day's file is complete once the day is over (midnight New York), so the 10:00 London run brings in the
previous US business day.

Each trade is typed (outright, curve, fly, swap spread, invoice or other package: see trade_types).

Kept: USD SOFR, EUR 6M Euribor and €STR, and GBP SONIA swaps: new trades and corrections of fixed / floating swaps and OIS ("NA/Swap OIS ...", "NA/Swap Fxd Flt
..."), with a fixed rate, that do not start before the trade date (back-dated swaps are compressions and
unwinds at off-market rates). Errors cancel the trade they point at and corrections replace it, across
the days read. Notionals above the dissemination cap are published as the cap with a "+": kept at the
cap and flagged.

Every day is kept: data/dtcc/<CCY>/<date>.json holds the trades of one currency in DTCC's file of that
date, column-wise and dictionary-coded, and is never deleted. Each run re-reads the last WINDOW business
days (about 1.5MB zipped a day) and rewrites their files, so corrections and cancellations reported within
that window are applied; a correction of a trade from an older file is dropped rather than duplicated.
Outputs:
- data/dtcc/<CCY>/<date>.json: the archive above (the page loads every file).
- data/dtcc/summary.json: currencies, indices, trades per day and index, and the check of spot-starting trades
  against the Eurex Clearing par swap rates of the same day (data/history/swaps.csv): the day's VWAP and
  the VWAP of the two hours before 17:30 Frankfurt (SNAP).
- data/history/dtcc.csv, data/gp/dtcc.json: daily VWAP of spot-starting standard tenors (GP page); for USD
  SOFR also the VWAP of 14:30-16:30 New York ("@NY"), matched to Treasury's par curve for swap spreads.
- data/dtcc/agg/<CCY>/<YYYY-MM>.json: trades, notional and DV01 by day, index, London hour and tenor bracket,
  venue or start (Flow tab); `python scripts/dtcc.py agg` rebuilds them all from the archive.
- data/history/dtcc_trades.csv, data/gp/dtcc_trades.json: daily curves and flies (bp), traded swap spreads
  (bp) and invoice swap rates (%) from the typed trades (GP); `python scripts/dtcc.py series` rebuilds them.
- data/history/dtcc_flow.csv: daily trades and notional by currency, index, tenor bucket and start.

Run `python scripts/dtcc.py 30` to backfill the archive and the histories over 30 business days.
"""

import io
import json
import re
import sys
import zipfile
from datetime import date, datetime, time, timedelta, timezone
from functools import cache
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests

import futures
from common import DATA, ROOT, add_business_days, add_months, frac_name, get, pricer, write_json

URL = "https://pddata.dtcc.com/ppd/api/report/cumulative/cftc/CFTC_CUMULATIVE_RATES_{:%Y_%m_%d}.zip"
OUT = DATA / "dtcc"
CACHE = ROOT / ".cache" / "dtcc"      # local re-runs only (git-ignored); empty on GitHub Actions
WINDOW = 5                            # business days re-read on each run (late corrections)
TENORS = (1, 2, 3, 5, 7, 10, 15, 20, 30)
# Currencies (in page order) and the indices kept in each.
INDICES = {"USD": ("SOFR",), "EUR": ("EURIBOR 6M", "€STR"), "GBP": ("SONIA",)}
# DTCC index -> label of the Eurex Clearing par rates in data/history/swaps.csv.
EUREX = {("USD", "SOFR"): "USD SOFR", ("EUR", "€STR"): "EUR €STR", ("EUR", "EURIBOR 6M"): "EUR 6M", ("GBP", "SONIA"): "GBP SONIA"}
# The "Eurex window" VWAP uses trades in the two hours before 17:30 Frankfurt time. Eurex does not publish when
# its curves are marked; over Oct-Nov 2026 trades sat closest to them around then in all three currencies
# (USD 10:00-12:00 New York, EUR 15:00-18:00 Frankfurt, GBP 14:00-16:00 London).
SNAP = ("Europe/Berlin", time(17, 30))
# Treasury's daily par yield curve is read from bid-side quotes at about 15:30 New York: SOFR trades in the two
# hours around it (14:30-16:30) give a time-matched swap rate for the swap spread.
TREASURY = ("America/New_York", time(16, 30))
STARTS = ["spot", "imm", "fwd"]
FLAGS = {"cap": 1, "pkg": 2, "upf": 4, "spr": 8, "pp": 16, "blk": 32, "std": 64, "unc": 128}


# ---------------------------------------------------------------- download and parse

def fetch(day):
    """The day's raw rates file, or None if DTCC has none (weekend, holiday, not yet published)."""
    path = CACHE / f"{day}.zip"
    if path.exists():
        content = path.read_bytes()
    else:
        try:
            content = get(URL.format(day), retries=2, timeout=180).content
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code in (400, 403, 404):
                return None
            raise
        if CACHE.parent.exists() and day < datetime.now(timezone.utc).date() - timedelta(days=1):
            CACHE.mkdir(exist_ok=True)
            path.write_bytes(content)
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
        return pd.read_csv(z.open(name), dtype=str, low_memory=False)


def number(s):
    """'22,000,000' -> 22000000.0; '650,000,000+' (above the cap) -> 650000000.0, flagged."""
    s = s.fillna("")
    return pd.to_numeric(s.str.replace(r"[,+\s]", "", regex=True), errors="coerce"), s.str.endswith("+")


INDEX_NAMES = {"EuroSTR": "€STR", "Federal Funds": "Fed Funds", "SOFR CME Term": "Term SOFR",
               # Source tags that split one index in two: 'BBR BBSW' = 'BBSW', 'STIBOR SIDE' = 'STIBOR', ...
               "BBR BBSW": "BBSW", "BBR FRA": "BKBM", "BKBM FRA": "BKBM", "BKBM Bid": "BKBM", "STIBOR SIDE": "STIBOR",
               "NIBOR NIBR": "NIBOR", "NIBOR OIBOR": "NIBOR", "TONA Compounded Index": "TONA"}
INDEX_NOISE = re.compile(r"(-OIS[ -]Compound|-OIS-COMPOUND|-COMPOUND|-Compound|-Reuters|-Bloomberg|-Telerate|-ISDA|-H\.15|-OIS)", re.I)


def index_label(name, ccy, period, mult, fixed_float):
    """'USD-SOFR-OIS Compound' -> 'SOFR'; 'EUR-EURIBOR-Reuters' with 6-month resets -> 'EURIBOR 6M'."""
    s = name if isinstance(name, str) and name and not name.startswith("NA/") else ""
    s = INDEX_NOISE.sub("", re.sub(rf"^{ccy}-", "", s)).replace("-", " ").strip()
    for k, v in INDEX_NAMES.items():
        s = s.replace(k, v)
    s = s or ("IBOR" if fixed_float else "OIS")
    if fixed_float and period in ("MNTH", "WEEK") and not re.search(r"\d+\s?[DWMY]\b", s):
        s += f" {mult}{'M' if period == 'MNTH' else 'W'}"
    return s


def parse(raw, day):
    """Compact trades (corrections keyed by the id of the trade they replace) and the ids errors cancel."""
    act = raw["Action type"]
    cancels = set(raw.loc[act == "EROR", "Original Dissemination Identifier"].dropna())
    kind = raw["UPI FISN"].fillna("").str.extract(r"^NA/Swap (OIS|Fxd Flt) ([A-Z]{3})$")
    keep = kind[0].notna() & (((act == "NEWT") & (raw["Event type"] == "TRAD")) | (act == "CORR"))
    df = raw[keep]
    fixed1 = pd.to_numeric(df["Fixed rate-Leg 1"], errors="coerce")
    fixed2 = pd.to_numeric(df["Fixed rate-Leg 2"], errors="coerce")
    one = fixed1.notna() ^ fixed2.notna()
    df, kind, fixed1, fixed2 = df[one], kind[keep][one], fixed1[one], fixed2[one]
    leg = np.where(fixed1.notna(), "2", "1")       # the floating leg
    period = np.where(leg == "2", df["Floating rate reset frequency period-leg 2"], df["Floating rate reset frequency period-leg 1"])
    mult = np.where(leg == "2", df["Floating rate reset frequency period multiplier-leg 2"], df["Floating rate reset frequency period multiplier-leg 1"])
    n1, c1 = number(df["Notional amount-Leg 1"])
    n2, c2 = number(df["Notional amount-Leg 2"])
    ts = pd.to_datetime(df["Execution Timestamp"], errors="coerce", utc=True)
    flag = lambda s: (s.fillna("").str.upper() == "TRUE")
    out = pd.DataFrame({
        "id": np.where(df["Action type"] == "CORR", df["Original Dissemination Identifier"], df["Dissemination Identifier"]),
        "t": ts.dt.strftime("%Y-%m-%dT%H:%M:%S"),
        "ccy": kind[1].values,
        "idx": [index_label(n, c, p, m, k == "Fxd Flt") for n, c, p, m, k in zip(df["UPI Underlier Name"], kind[1], period, mult, kind[0])],
        "eff": df["Effective Date"].str[:10],
        "mat": df["Expiration Date"].str[:10],
        "rate": (fixed1.fillna(fixed2) * 100).round(5),
        "ntl": (n1.fillna(n2) / 1e6).round(3),
        "cap": (c1 | c2),
        "pkg": flag(df["Package indicator"]),
        "upf": df["Package transaction price"].notna() | df["Other payment amount"].notna(),
        "spr": df["Package transaction spread"].notna(),
        "ps": pd.to_numeric(df["Package transaction spread"].fillna("").str.replace(",", ""), errors="coerce"),
        "psn": df["Package transaction spread notation"].fillna("").values,
        "pp": flag(df["Post-priced swap indicator"]),
        "blk": flag(df["Block trade election indicator"]),
        "unc": df["Cleared"].fillna("") != "I",
        "venue": df["Platform identifier"].fillna("").values,
        "corr": (df["Action type"] == "CORR").values,
        "rep": str(day),
    }, index=df.index)
    trade_day = out["t"].fillna("").str[:10]
    wanted = [i in INDICES.get(c, ()) for c, i in zip(out["ccy"], out["idx"])]
    ok = (pd.Series(wanted, index=out.index) & out["t"].notna() & out["ntl"].gt(0) & out["rate"].between(-5, 60) & out["eff"].notna() & out["mat"].notna()
          & (out["eff"] >= trade_day) & (out["mat"] > out["eff"]) & (trade_day >= str(day - timedelta(days=7))))
    return out[ok], cancels


def read(days):
    """Trades of the given days, with every error and correction applied; `days` actually found."""
    frames, cancels, found = [], set(), []
    for d in days:
        raw = fetch(d)
        if raw is None:
            continue
        trades, c = parse(raw, d)
        frames.append(trades)
        cancels |= c
        found.append(d)
    if not frames:
        raise RuntimeError(f"no DTCC files for {days[0]}..{days[-1]}")
    df = pd.concat(frames, ignore_index=True)
    # A correction of a trade first reported before these days would duplicate it in the archive: dropped.
    originals = set(df.loc[~df["corr"], "id"])
    df = df[~df["corr"] | df["id"].isin(originals)].drop_duplicates("id", keep="last")
    df = df[~df["id"].isin(cancels)].sort_values("t", kind="stable").reset_index(drop=True)
    return trade_types(classify(df)), found


# ---------------------------------------------------------------- classification

def third_wednesday(y, m):
    d = date(y, m, 15)
    return d + timedelta(days=(2 - d.weekday()) % 7)


def term(a, b):
    """Whole months from a to b when b is within 4 days of a month anniversary, else None."""
    months = (b.year - a.year) * 12 + b.month - a.month
    for m in (months, months - 1, months + 1):
        if m > 0 and abs((add_months(a, m) - b).days) <= 4:
            return m
    return None


def label(months):
    return f"{months // 12}Y" if months % 12 == 0 else f"{months}M"


@cache
def shape(trade_day, eff, mat):
    """(start, tenor label, nearest standard tenor in years (0 under 9 months), standard flag, forward label)."""
    td, ed, md = date.fromisoformat(trade_day), date.fromisoformat(eff), date.fromisoformat(mat)
    imm = ed.month % 3 == 0 and ed == third_wednesday(ed.year, ed.month)
    start = "spot" if np.busday_count(td, ed) <= 3 else "imm" if imm else "fwd"
    months = term(ed, md)
    years = (md - ed).days / 365.25
    bucket = min(TENORS, key=lambda x: abs(x - years)) if years >= 0.75 else 0
    fwd = ""
    if start == "fwd":
        f = term(add_business_days(td, 2), ed)
        fwd = label(f) if f else f"{(ed - td).days / 365.25:.1f}Y"
    return start, label(months) if months else f"{years:.1f}Y", bucket, months is not None, fwd


def classify(df):
    cols = list(zip(*[shape(t[:10], e, m) for t, e, m in zip(df["t"], df["eff"], df["mat"])])) or [[]] * 5
    df = df.assign(**dict(zip(["start", "tenor", "bucket", "std", "fwd"], cols)))
    df["day"] = df["t"].str[:10]
    return df


# ---------------------------------------------------------------- trade types

# Packages are not linked in the public data, but the legs of one package share the execution time to the
# second and the venue. A leg's type comes from its group:
#   curve     2 legs of different maturities (steepener or flattener: the side is not published)
#   fly       3 legs of different maturities
#   invoice   a forward swap from a bond futures delivery date to a deliverable bond's maturity (swap vs futures,
#             EFS), whether or not it is flagged as a package (invoice_contract); or a packaged USD swap from a
#             contract's first notice day to that contract's CTD maturity on the trade date (fnd_invoice)
#   spread    1 spot-starting leg quoted as a spread, or ending on a government bond's maturity: a swap spread
#             or asset swap against a bond (the bond leg is not a swap, so it is not reported)
#   package   any other package; outright: not part of a package
TYPES = ["outright", "curve", "fly", "spread", "invoice", "package"]
INVOICE_HORIZON = 300          # days from trade to start: the third listed quarterly contract is at most ~9 months out


@cache
def bond_maturities():
    """Maturities of the government bonds on the site by currency: {maturity: market} (EUR: Bunds, OATs, BTPs)."""
    out = {"USD": {}, "EUR": {}, "GBP": {}}
    for market, ccy in (("UST", "USD"), ("DE", "EUR"), ("FR", "EUR"), ("IT", "EUR")):
        path = DATA / "markets" / f"{market}.json"
        if path.exists():
            for b in json.loads(path.read_text())["bonds"]:
                out[ccy].setdefault(b["maturity"], market)
    return out


# Deliverable remaining life in years: Treasury futures from the first day of the delivery month (CME rules),
# Eurex futures from the delivery day; Eurex contracts by issuer.
CME_RANGES = [("TU", 1.75, 2.084), ("Z3N", 2.75, 3.084), ("FV", 4.167, 5.25), ("TY", 6.5, 8.0), ("UXY", 9.417, 10.0),
              ("US", 15.0, 25.0), ("WN", 25.0, 30.01)]
EUREX_RANGES = {"DE": [("DU", 1.75, 2.25), ("OE", 4.5, 5.5), ("RX", 8.5, 10.5), ("UB", 24.0, 35.0)],
                "FR": [("OAT", 8.5, 10.5)], "IT": [("BTS", 2.0, 3.25), ("IK", 8.5, 11.0)]}
MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


@cache
def invoice_contract(ccy, eff, mat):
    """The bond futures contract a forward swap from `eff` to `mat` hedges, e.g. 'TY Sep-26', or None: the swap must
    start on a delivery date and end on a deliverable bond's maturity, within the contract's deliverable range."""
    e, m = pd.Timestamp(eff), pd.Timestamp(mat)
    if not invoice_start(ccy, e):
        return None
    bonds = bond_maturities().get(ccy, {})
    if ccy == "USD":
        if not (mat in bonds or m.day == 15 or month_end(m)):
            return None
        month, year = (e.month, e.year) if e.month % 3 == 0 else ((12, e.year - 1) if e.month == 1 else (e.month - 1, e.year))
        rem = (m - pd.Timestamp(year, month, 1)).days / 365.25
        ranges = CME_RANGES
    elif ccy == "EUR":
        if mat not in bonds:
            return None
        month, year = e.month, e.year
        rem = (m - e).days / 365.25
        ranges = EUREX_RANGES[bonds[mat]]
    else:
        return None
    code = next((c for c, lo, hi in ranges if lo <= rem < hi), None)
    return f"{code} {MONTH_NAMES[month - 1]}-{str(year)[2:]}" if code else None


def month_end(d):
    return (d + pd.offsets.MonthEnd(0)).date() == d.date()


def invoice_start(ccy, eff):
    """Futures delivery dates. Treasury futures: the first or last business day of March, June, September or
    December (first delivery; last delivery of TY, UXY, US, WN), or the first three business days of the next
    month (last delivery of TU and FV). Eurex bond futures: the 10th of those months, or the next business day."""
    m = eff.month
    if ccy == "USD":
        if m % 3 == 0:
            first = eff.replace(day=1) + pd.offsets.BDay(0)
            last = eff + pd.offsets.BMonthEnd(0)
            return eff == first or eff == last
        if m % 3 == 1:
            return eff <= eff.replace(day=1) + pd.offsets.BDay(0) + pd.offsets.BDay(2)
        return False
    if ccy == "EUR":
        return m % 3 == 0 and eff == eff.replace(day=10) + pd.offsets.BDay(0)
    return False


def spread_bp(value, notation, rate):
    """Package spread in bp. Reporters write a percentage spread both as a decimal (-0.0039875 = -39.9bp) and as a
    percentage (-0.485 = -48.5bp): read as a decimal unless that exceeds 200bp. Values equal to the swap rate, or
    zero, carry no spread (invoice packages often report 0)."""
    if value is None or np.isnan(value) or value == 0:
        return None
    if notation == "4":
        return value
    if notation != "3" or abs(value * 100 - rate) < 0.01 or abs(value - rate) < 0.01:
        return None
    bp = value * 1e4 if abs(value * 1e4) <= 200 else value * 100
    return bp if abs(bp) <= 200 else None


def trade_types(df):
    """Adds `type`, `sbp` (package spread in bp, single-leg spread trades), `grp` (legs of one package share it)
    and `fc` (invoice swaps: the futures contract)."""
    maturities = bond_maturities()
    types = pd.Series("outright", index=df.index)
    # Invoice swaps first, package or not (the futures leg is not a swap, and many are reported without the flag).
    # A whole-year forward swap (7Y from the delivery date) is an ordinary forward, not an invoice swap; bond
    # futures are listed about three quarters ahead, so the start must be within INVOICE_HORIZON days of the trade.
    whole = df["tenor"].str.fullmatch(r"\d+Y")
    near = (pd.to_datetime(df["eff"]) - pd.to_datetime(df["t"].str[:10])).dt.days <= INVOICE_HORIZON
    fc = pd.Series([invoice_contract(c, e, m) if s != "spot" and not w and n else None
                    for c, e, m, s, w, n in zip(df["ccy"], df["eff"], df["mat"], df["start"], whole, near)], index=df.index, dtype=object)
    # Also packaged USD swaps from a contract's first notice day to its CTD's maturity.
    fnd_rows = df["pkg"] & (df["ccy"] == "USD") & fc.isna() & near & (df["start"] != "spot")
    for i in df.index[fnd_rows]:
        c = fnd_invoice(df.at[i, "t"][:10], df.at[i, "eff"], df.at[i, "mat"])
        if c:
            fc[i] = c
    sbp = pd.Series(np.nan, index=df.index)
    grp = pd.Series(-1, index=df.index)
    pk = df[df["pkg"]]
    for n, (_, g) in enumerate(pk.groupby(["rep", "t", "venue", "ccy", "idx"], sort=False)):
        grp[g.index] = n
        mats = g["mat"].nunique()
        if len(g) == 2 and mats == 2:
            types[g.index] = "curve"
        elif len(g) == 3 and mats == 3:
            types[g.index] = "fly"
        elif len(g) == 1:
            r = g.iloc[0]
            eff, mat = pd.Timestamp(r["eff"]), pd.Timestamp(r["mat"])
            on_bond = r["mat"] in maturities.get(r["ccy"], {}) or (r["ccy"] == "USD" and (mat.day == 15 or month_end(mat)))
            bp = spread_bp(r["ps"], r["psn"], r["rate"])
            if r["start"] == "spot" and (bp is not None or (on_bond and not r["std"])):
                types[g.index] = "spread"
                if bp is not None:
                    sbp[g.index] = round(bp, 2)
            else:
                types[g.index] = "package"
        else:
            types[g.index] = "package"
    types[fc.notna()] = "invoice"
    # Invoice swaps quoted as a spread (swap vs futures-implied yield): the package spread, in bp.
    for i in fc[fc.notna()].index:
        bp = spread_bp(df.at[i, "ps"], df.at[i, "psn"], df.at[i, "rate"])
        if bp is not None:
            sbp[i] = round(bp, 2)
    df = df.assign(type=types, sbp=sbp, grp=grp, fc=fc.fillna(""))
    df["sbp"] = clean_spreads(df, "spread", 12).where(df["type"] == "spread", df["sbp"])
    df["sbp"] = clean_spreads(df, "invoice", 20).where(df["type"] == "invoice", df["sbp"])
    df.loc[~df["type"].isin(["spread", "invoice"]), "sbp"] = np.nan
    return df


# Reference spreads for cleaning reported package spreads: swap rate − yield of the bond the trade is against.
@cache
def yield_histories():
    """{ccy: (yields by date × bond, {maturity: [bond ids]}, Treasury par curve by date × tenor)} from data/history."""
    out = {}
    hist = DATA / "history"
    ust = pd.read_csv(hist / "UST.csv", index_col=0) if (hist / "UST.csv").exists() else pd.DataFrame()
    bonds = pd.read_csv(hist / "UST_bonds.csv", dtype={"cusip": str}) if (hist / "UST_bonds.csv").exists() else pd.DataFrame(columns=["cusip", "maturity"])
    par = pd.read_csv(hist / "UST_par.csv", index_col=0) if (hist / "UST_par.csv").exists() else pd.DataFrame()
    by_mat = {}
    for c, m in zip(bonds["cusip"], bonds["maturity"]):
        if c in ust.columns:
            by_mat.setdefault(m, []).append(c)
    out["USD"] = (ust, by_mat, par)
    frames, by_mat = [], {}
    for market in ("DE", "FR", "IT"):
        path, mk = hist / f"{market}.csv", DATA / "markets" / f"{market}.json"
        if path.exists() and mk.exists():
            frames.append(pd.read_csv(path, index_col=0))
            for b in json.loads(mk.read_text())["bonds"]:
                by_mat.setdefault(b["maturity"], []).append(b["id"])
    eur = pd.concat(frames, axis=1) if frames else pd.DataFrame()
    out["EUR"] = (eur, {m: [i for i in ids if i in eur.columns] for m, ids in by_mat.items()}, pd.DataFrame())
    return out


def bond_yield(ccy, day, mat, tenor):
    """Yield (%) of the bond maturing on `mat` on `day` (or the last close within 5 days before), else for a
    whole-year tenor the Treasury par yield; None when unknown."""
    hist = yield_histories().get(ccy)
    if not hist:
        return None
    yields, by_mat, par = hist
    for frame, cols in ((yields, by_mat.get(mat, [])), (par, [tenor] if tenor in par.columns else [])):
        if cols and len(frame):
            near = frame.loc[(frame.index <= day) & (frame.index >= str(pd.Timestamp(day) - pd.Timedelta(days=5))[:10]), cols]
            v = near.ffill().iloc[-1].mean() if len(near) else np.nan
            if not pd.isna(v):
                return float(v)
    return None


def clean_spreads(df, kind, tolerance):
    """Reported package spreads (bp) of one trade type, made comparable: a spread of the opposite sign to the
    reference (swap rate − bond yield) but its size is a convention difference and is flipped; one more than
    `tolerance` bp from the reference is not a spread against that bond and is dropped. Without a bond yield, the
    median of the day's trades against the same bond (or contract) is the reference."""
    rows = df[(df["type"] == kind) & df["sbp"].notna()]
    out = df["sbp"].copy()
    refs = pd.Series([None if (y := bond_yield(c, t[:10], m, n)) is None else (r - y) * 100
                      for c, t, m, n, r in zip(rows["ccy"], rows["t"], rows["mat"], rows["tenor"], rows["rate"])], index=rows.index, dtype=float)
    for _, g in rows.groupby([rows["t"].str[:10], rows["ccy"], rows["idx"], rows["mat"]]):
        med = g["sbp"].abs().median() * np.sign(g["sbp"].median() or 1)
        for i, v in g["sbp"].items():
            ref = refs[i] if not pd.isna(refs[i]) else med
            if abs(ref) >= 3 and np.sign(v) != np.sign(ref) and abs(v + ref) < abs(v - ref):
                v = -v
            out[i] = v if abs(v - ref) <= tolerance else np.nan
    return out


# ---------------------------------------------------------------- statistics

def clean(g, floor=0.05, k=8):
    """Drop off-market prints: more than k median absolute deviations, and at least `floor` (%), from the median."""
    if len(g) < 3:
        return g
    med = g["rate"].median()
    dev = (g["rate"] - med).abs()
    return g[dev <= max(floor, k * dev.median())]


def vwap(g):
    return float(np.average(g["rate"], weights=g["ntl"])) if len(g) else None


def standard_spot(df):
    """Spot-starting trades of a whole-month tenor at a market rate (no upfront payment, not post-priced)."""
    return df[(df["start"] == "spot") & df["std"] & ~df["upf"] & ~df["pp"]]


def window_utc(day, tz, end, hours=2):
    e = datetime.combine(day, end, ZoneInfo(tz)).astimezone(timezone.utc).replace(tzinfo=None)
    return (e - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S"), e.strftime("%Y-%m-%dT%H:%M:%S")


def daily_vwaps(df, day):
    """{'USD SOFR 10Y': {day: VWAP, n: trades, snap / nSnap: in the Eurex window, ny / nNy: in the Treasury
    window (USD only)}} for one day. Off-market prints are dropped from the whole day first."""
    out = {}
    g = standard_spot(df[df["day"] == day])
    d = date.fromisoformat(day)
    snap, ny = window_utc(d, *SNAP), window_utc(d, *TREASURY)
    inside = lambda x, w: x[(x["t"] >= w[0]) & (x["t"] <= w[1])]
    for (ccy, idx), name in EUREX.items():
        for n in TENORS:
            x = clean(g[(g["ccy"] == ccy) & (g["idx"] == idx) & (g["tenor"] == f"{n}Y")])
            if len(x):
                a, b = inside(x, snap), inside(x, ny)
                out[f"{name} {n}Y"] = {"day": vwap(x), "n": len(x), "snap": vwap(a), "nSnap": len(a),
                                       **({"ny": vwap(b), "nNy": len(b)} if ccy == "USD" else {})}
    return out


# ---------------------------------------------------------------- hourly aggregates (Flow tab)

AGG = OUT / "agg"
KEY_TENORS = {f"{n}Y" for n in TENORS}
DIMENSIONS = ("tenor", "venue", "start", "type")


def load_day(ccy, day):
    """The archived trades of one currency and DTCC file date back as a frame (inverse of page_file)."""
    f = json.loads((OUT / ccy / f"{day}.json").read_text())
    if not f["t"]:
        return pd.DataFrame()
    t = pd.Timestamp(f["base"], tz="UTC") + pd.to_timedelta(f["t"], unit="s")
    flags = np.array(f["x"])
    trade_day = t.tz_localize(None).normalize()
    eff = trade_day + pd.to_timedelta(f["e"], unit="D")
    return pd.DataFrame({
        "ts": t, "idx": [f["idx"][i] for i in f["i"]], "start": [f["starts"][i] for i in f["s"]],
        "tenor": [f["labels"][i] for i in f["n"]], "bucket": f["b"], "std": (flags & FLAGS["std"]) > 0,
        "te": (eff - trade_day).days / 365.25, "tm": (eff - trade_day).days / 365.25 + np.array(f["m"]) / 365.25,
        "rate": f["r"], "ntl": f["q"], "venue": [f["venues"][i] or "n/a" for i in f["v"]],
        "type": [f["types"][i] for i in f["y"]] if "y" in f else "outright",
        "eff": eff.strftime("%Y-%m-%d"), "mat": (eff + pd.to_timedelta(f["m"], unit="D")).strftime("%Y-%m-%d"),
        "mkt": ((flags & FLAGS["upf"]) == 0) & ((flags & FLAGS["pp"]) == 0),
        "sp": [np.nan if v is None else v for v in f["sp"]] if "sp" in f else np.nan,
        "grp": [f"{day}/{g}" if g >= 0 else None for g in f["g"]] if "g" in f else None,
        "fc": [f["contracts"][i] if i >= 0 else "" for i in f["fc"]] if "fc" in f else "",
    })


def dv01(df):
    """DV01 in thousands of the currency per bp: notional × annuity × 1bp, the annuity of an annual fixed leg
    from start to end discounted at the trade's own rate (continuous approximation)."""
    r = np.maximum(df["rate"].to_numpy() / 100, 1e-4)
    annuity = (np.exp(-r * df["te"].to_numpy()) - np.exp(-r * df["tm"].to_numpy())) / r
    return df["ntl"].to_numpy() * annuity * 0.1


def aggregate(df):
    """{day: {index: {scope: {dimension: [[London hour, category, trades, notional mm, DV01 k], ...]}}}}.
    Scope 'a' holds every trade (tenor = bracket of the nearest key-rate tenor); 'k' only key-rate tenors."""
    df = df.assign(day=df["ts"].dt.strftime("%Y-%m-%d"), hour=df["ts"].dt.tz_convert("Europe/London").dt.hour, dv=dv01(df),
                   tenor_cat=[f"{b}Y" if b else "<9M" for b in df["bucket"]])
    out = {}
    for scope, part in (("a", df), ("k", df[df["std"] & df["tenor"].isin(KEY_TENORS)])):
        for dim, col in (("tenor", "tenor_cat"), ("venue", "venue"), ("start", "start"), ("type", "type")):
            g = part.groupby(["day", "idx", "hour", col]).agg(n=("ntl", "size"), q=("ntl", "sum"), dv=("dv", "sum")).reset_index()
            for r in g.itertuples(index=False):
                cell = out.setdefault(r.day, {}).setdefault(r.idx, {}).setdefault(scope, {}).setdefault(dim, [])
                cell.append([int(r.hour), getattr(r, col), int(r.n), round(float(r.q), 1), round(float(r.dv), 1)])
    return out


def update_aggregates(months=None):
    """Rebuild the monthly aggregate files data/dtcc/agg/<CCY>/<YYYY-MM>.json from the archive, for the given
    months (all when None). A month reads its own files and the next week's, for trades reported late."""
    for ccy in INDICES:
        files = sorted(p.stem for p in (OUT / ccy).glob("*.json"))
        for month in months or sorted({d[:7] for d in files}):
            end = (pd.Timestamp(f"{month}-01") + pd.offsets.MonthEnd(1) + pd.Timedelta(days=8)).strftime("%Y-%m-%d")
            frames = [load_day(ccy, d) for d in files if month <= d[:7] and d <= end]
            frames = [f for f in frames if len(f)]
            if not frames:
                continue
            df = pd.concat(frames, ignore_index=True)
            df = df[df["ts"].dt.strftime("%Y-%m") == month]
            write_json(AGG / ccy / f"{month}.json", {"ccy": ccy, "month": month, "days": dict(sorted(aggregate(df).items()))})


# ---------------------------------------------------------------- on-the-run Treasuries

OTR_TERMS = (2, 3, 5, 7, 10, 20, 30)


@cache
def ust_otr():
    """On-the-run history per original term: [(from date, maturity, name)], from the Treasuries in the yield
    history (data/history/UST_bonds.csv). A new issue is on the run from its auction, taken as a week before its
    issue date (maturity − term)."""
    path = DATA / "history" / "UST_bonds.csv"
    if not path.exists():
        return {}
    bonds = pd.read_csv(path, dtype={"cusip": str}).dropna(subset=["term"])
    out = {}
    for term in OTR_TERMS:
        b = bonds[bonds["term"] == term].drop_duplicates("maturity").sort_values("maturity")
        out[term] = [(str((pd.Timestamp(m) - pd.DateOffset(years=term) - pd.Timedelta(days=7)).date()), m,
                      f"T {frac_name(c)} {pd.Timestamp(m):%m/%d/%y}") for m, c in zip(b["maturity"], b["coupon"])]
    return out


def otr_maturity(day, term):
    """Maturity of the on-the-run Treasury of `term` years on `day`, or None."""
    hist = ust_otr().get(term, [])
    on = [m for start, m, _ in hist if start <= day]
    return on[-1] if on else None


def write_otr():
    write_json(DATA / "dtcc" / "ust_otr.json", {str(t): [list(x) for x in v] for t, v in ust_otr().items()})


# ---------------------------------------------------------------- Treasury futures CTD history

@cache
def ust_ctd():
    """CTD of each Treasury futures contract month on each date of the yield history: {(code, 'YYYY-MM'):
    {date: maturity}}. Basket: CME deliverable rules (futures.ust_eligible); CTD: the lowest clean price /
    conversion factor at that day's closing yield (a spot proxy for the forward ratio, so close calls between
    two bonds can go either way). Each contract month from 300 days before its delivery month to its end."""
    hist = DATA / "history"
    if not (hist / "UST.csv").exists() or not (hist / "UST_bonds.csv").exists():
        return {}
    yields = pd.read_csv(hist / "UST.csv", index_col=0)
    bonds = pd.read_csv(hist / "UST_bonds.csv", dtype={"cusip": str}).dropna(subset=["term"])
    bonds = bonds[bonds["cusip"].isin(yields.columns)]
    dates = list(yields.index)
    out = {}
    first_month = pd.Timestamp(dates[0]).to_period("Q").start_time
    for m in pd.date_range(first_month, pd.Timestamp(dates[-1]) + pd.DateOffset(months=9), freq="QS-MAR"):
        first = m.date()
        last = futures.last_business_day(first.year, first.month)
        for code, (_, round_months, _, _) in futures.UST_CONTRACTS.items():
            basket = [(r.cusip, r.coupon, pd.Timestamp(r.maturity).date(), futures.cme_conversion_factor(r.coupon, pd.Timestamp(r.maturity).date(), first, round_months))
                      for r in bonds.itertuples() if futures.ust_eligible(code, int(r.term), pd.Timestamp(r.maturity).date(), first, last)]
            if not basket:
                continue
            ctd = {}
            for d in dates:
                day = pd.Timestamp(d).date()
                if not (first - pd.Timedelta(days=300).to_pytimedelta() <= day <= last):
                    continue
                settle = add_business_days(day, 1)
                best = None
                for cusip, coupon, mat, cf in basket:
                    y = yields.at[d, cusip]
                    if pd.isna(y) or mat <= settle:
                        continue
                    ratio = pricer(coupon, mat, settle, 2)(y) / cf
                    if best is None or ratio < best[0]:
                        best = (ratio, str(mat))
                if best:
                    ctd[d] = best[1]
            if ctd:
                out[(code, f"{first:%Y-%m}")] = ctd
    return out


def fnd(month_start):
    """First notice day of a Treasury futures contract: the last business day of the month before delivery."""
    prev = month_start - pd.Timedelta(days=1)
    return futures.last_business_day(prev.year, prev.month)


def fnd_invoice(day, eff, mat):
    """Contract label of a packaged swap starting on a contract's first notice day and maturing on that
    contract's CTD (as of the trade date, or the last close before it), else None."""
    e = pd.Timestamp(eff)
    nxt = (e + pd.offsets.MonthBegin(1)).date()
    if nxt.month % 3 or fnd(pd.Timestamp(nxt)) != e.date():
        return None
    table = ust_ctd()
    for code in futures.UST_CONTRACTS:
        ctd = table.get((code, f"{nxt:%Y-%m}"), {})
        known = [d for d in ctd if d <= day]
        if known and ctd[max(known)] == mat:
            return f"{code} {MONTH_NAMES[nxt.month - 1]}-{str(nxt.year)[2:]}"
    return None


def write_ctd():
    """data/dtcc/ust_ctd.json: each contract month's CTD changes, [[from date, maturity], ...]."""
    out = {}
    for (code, month), ctd in sorted(ust_ctd().items()):
        steps, prev = [], None
        for d in sorted(ctd):
            if ctd[d] != prev:
                steps.append([d, ctd[d]])
                prev = ctd[d]
        out[f"{code} {month}"] = steps
    write_json(DATA / "dtcc" / "ust_ctd.json", out)


# ---------------------------------------------------------------- daily trade series (GP)

KEY_YEARS = set(TENORS)


def weighted(g, col, weight, floor):
    """Weighted mean of `col` after dropping prints more than 8 MADs (and at least `floor`) from the median."""
    if len(g) >= 3:
        dev = (g[col] - g[col].median()).abs()
        g = g[dev <= max(floor, 8 * dev.median())]
    if not len(g):
        return None, 0
    w = g[weight].clip(lower=0)
    return (float(np.average(g[col], weights=w)) if w.sum() > 0 else float(g[col].mean())), len(g)


def trade_series(ccy, df):
    """Daily series of one currency's trades: [date, series, value, trades].
    CURVE / FLY: spot packages of key-rate tenors, level in bp weighted by DV01 (curve: long − short; fly: 2 × belly − wings).
    SPREAD: traded swap spreads (bp, notional-weighted) of spot trades. USD: swaps maturing with the Treasury on
    the run that day ("10Y on-the-run") or with another Treasury; EUR, GBP: by standard tenor or matched bond.
    INV: invoice swap rates (%, notional-weighted) by futures contract; INVSPREAD: their reported invoice spreads (bp)."""
    bonds = {}
    for market in {"USD": ["UST"], "EUR": ["DE", "FR", "IT"]}.get(ccy, []):
        path = DATA / "markets" / f"{market}.json"
        if path.exists():
            for b in json.loads(path.read_text())["bonds"]:
                bonds.setdefault(b["maturity"], (market, b["name"]))
    df = df.assign(day=df["ts"].dt.strftime("%Y-%m-%d"), dv=dv01(df))
    rows = []
    for (day, idx), g in df[df["mkt"]].groupby(["day", "idx"]):
        name = f"{ccy} {idx}"
        for kind, legs_n in (("curve", 2), ("fly", 3)):
            packs = []
            for _, legs in g[(g["type"] == kind) & g["grp"].notna()].groupby("grp"):
                if len(legs) != legs_n or not (legs["start"] == "spot").all() or not legs["std"].all():
                    continue
                legs = legs.sort_values("mat")
                years = [int(t[:-1]) for t in legs["tenor"] if t.endswith("Y")]
                if len(years) != legs_n or not set(years) <= KEY_YEARS:
                    continue
                r = legs["rate"].to_numpy()
                bp = (r[1] - r[0]) * 100 if kind == "curve" else (2 * r[1] - r[0] - r[2]) * 100
                packs.append(("s".join(map(str, years)) + "s", bp, legs["dv"].mean()))
            p = pd.DataFrame(packs, columns=["structure", "bp", "dv"])
            for structure, x in p.groupby("structure"):
                v, n = weighted(x, "bp", "dv", 2)
                if v is not None:
                    rows.append([day, f"{kind.upper()}|{name} {structure}", round(v, 2), n])
        sp = g[(g["type"] == "spread") & g["sp"].notna() & (g["start"] == "spot")].copy()
        if len(sp):
            # USD: only swaps that mature with a Treasury: the one on the run that day, else another matched on
            # maturity (a whole-year swap ending on no Treasury's maturity is not counted). EUR and GBP: standard
            # tenor or bond.
            otr = {t: otr_maturity(day, t) for t in OTR_TERMS} if ccy == "USD" else {}
            def key(t, s, m):
                on = next((n for n, mm in otr.items() if mm == m), None)
                if on:
                    return f"{on}Y on-the-run"
                if ccy != "USD" and s and t in KEY_TENORS:
                    return f"{t}"
                return bonds[m][1] if m in bonds else None
            sp["key"] = [key(t, s, m) for t, s, m in zip(sp["tenor"], sp["std"], sp["mat"])]
            for key, x in sp[sp["key"].notna()].groupby("key"):
                v, n = weighted(x, "sp", "ntl", 3)
                if v is not None:
                    rows.append([day, f"SPREAD|{name} {key}", round(v, 2), n])
        inv = g[(g["type"] == "invoice") & (g["fc"] != "")]
        for c, x in inv[inv["sp"].notna()].groupby("fc"):
            v, n = weighted(x, "sp", "ntl", 3)
            if v is not None:
                rows.append([day, f"INVSPREAD|{name} {c}", round(v, 2), n])
        if len(inv):
            for c, x in inv.groupby("fc"):
                v, n = weighted(x, "rate", "ntl", 0.05)
                if v is not None:
                    rows.append([day, f"INV|{name} {c}", round(v, 4), n])
    return rows


def update_trade_series(days=None):
    """Rebuild data/history/dtcc_trades.csv for the given DTCC file dates (all when None) from the archive, and
    data/gp/dtcc_trades.json (series with at least 5 days of data)."""
    path = DATA / "history" / "dtcc_trades.csv"
    old = pd.read_csv(path, dtype={"date": str}) if path.exists() and days else pd.DataFrame(columns=["date", "series", "value", "trades"])
    rows, recomputed = [], set()
    for ccy in INDICES:
        files = sorted(p.stem for p in (OUT / ccy).glob("*.json"))
        core = files if days is None else [d for d in files if d in set(map(str, days))]
        # In chunks; each also reads the next 5 files (trades reported late) and keeps only its own dates.
        for chunk in range(0, len(core), 40):
            dates = core[chunk:chunk + 40]
            recomputed |= set(dates)
            nxt = [d for d in files if d > dates[-1]][:5]
            frames = [f for f in (load_day(ccy, d) for d in dates + nxt) if len(f)]
            if frames:
                rows += [r for r in trade_series(ccy, pd.concat(frames, ignore_index=True)) if dates[0] <= r[0] <= dates[-1]]
    new = pd.DataFrame(rows, columns=["date", "series", "value", "trades"])
    # The dates recomputed replace all their old rows.
    out = pd.concat([old[~old["date"].isin(recomputed)], new])
    out = out.sort_values(["date", "series"]).reset_index(drop=True)
    out.to_csv(path, index=False)
    counts = out.groupby("series")["date"].nunique()
    wide = out[out["series"].isin(counts[counts >= 5].index)].pivot_table(index="date", columns="series", values="value")
    write_otr()
    write_ctd()
    write_json(DATA / "gp" / "dtcc_trades.json", {
        "dates": list(wide.index),
        "series": {k: [None if pd.isna(v) else float(v) for v in wide[k]] for k in sorted(wide.columns)},
    })
    return out


# ---------------------------------------------------------------- outputs

def page_file(g, day):
    """One currency's trades of one DTCC file, column-wise; strings are coded into the lists `idx`, `venues`
    and `labels`, times are seconds from midnight UTC of the file's date (negative for trades reported late)."""
    base = datetime.fromisoformat(day)
    idx = list(g.groupby("idx")["ntl"].sum().sort_values(ascending=False).index)
    venues = sorted(set(g["venue"]))
    labels = sorted((set(g["tenor"]) | set(g["fwd"])) - {""}, key=lambda s: (s[-1], float(s[:-1])))
    trade_day = pd.to_datetime(g["day"])
    flags = sum(g[k].astype(int) * v for k, v in FLAGS.items())
    code = lambda values, table: [table.index(v) for v in values]
    return {
        "ccy": g["ccy"].iat[0], "day": day, "base": day, "idx": idx, "venues": venues, "labels": labels,
        "flags": FLAGS, "starts": STARTS, "types": TYPES,
        "t": ((pd.to_datetime(g["t"]) - base).dt.total_seconds()).astype(int).tolist(),
        "i": code(g["idx"], idx),
        "s": code(g["start"], STARTS),
        "n": code(g["tenor"], labels),
        "b": g["bucket"].tolist(),
        "f": [labels.index(v) if v else -1 for v in g["fwd"]],
        "e": (pd.to_datetime(g["eff"]) - trade_day).dt.days.tolist(),
        "m": (pd.to_datetime(g["mat"]) - pd.to_datetime(g["eff"])).dt.days.tolist(),
        "r": g["rate"].round(5).tolist(),
        "q": g["ntl"].round(2).tolist(),
        "x": flags.astype(int).tolist(),
        "v": code(g["venue"], venues),
        "y": code(g["type"], TYPES),
        "contracts": (contracts := sorted(set(g["fc"]) - {""})),
        "fc": [contracts.index(v) if v else -1 for v in g["fc"]],
        "sp": [None if pd.isna(v) else float(v) for v in g["sbp"]],
        "g": [int(v) for v in g["grp"]],
    }


def merge_history(path, rows, index_cols=None):
    """Replace the given dates in a CSV history and keep the rest."""
    old = pd.read_csv(path, dtype={"date": str}) if path.exists() else pd.DataFrame()
    new = pd.DataFrame(rows)
    if new.empty:
        return old
    if len(old):
        old = old[~old["date"].isin(set(new["date"]))]
    out = pd.concat([old, new], ignore_index=True).sort_values(["date", *(index_cols or [])], kind="stable")
    path.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(path, index=False, float_format="%.4f")
    return out


def series_order(name):
    head, n, *ny = name.split(" @")[0].rsplit(" ", 1) + name.split(" @")[1:]
    return list(EUREX.values()).index(head), int(n[:-1]), len(ny)


def update_histories(df, days):
    vw = []
    for d in days:
        v = daily_vwaps(df, str(d))
        if v:
            row = {"date": str(d), **{k: round(x["day"], 4) for k, x in v.items()}}
            row.update({f"{k} @NY": round(x["ny"], 4) for k, x in v.items() if x.get("ny") is not None})
            vw.append(row)
    hist = merge_history(DATA / "history" / "dtcc.csv", vw).set_index("date")
    hist = hist[sorted(hist.columns, key=series_order)]
    write_json(DATA / "gp" / "dtcc.json", {
        "dates": list(hist.index.astype(str)),
        "series": {k: [None if pd.isna(v) else float(v) for v in hist[k]] for k in hist.columns},
    })
    flow = (df[df["day"].isin({str(d) for d in days})]
            .groupby(["day", "ccy", "idx", "bucket", "start"]).agg(trades=("ntl", "size"), notional=("ntl", "sum")).reset_index()
            .rename(columns={"day": "date"}))
    flow["notional"] = flow["notional"].round(1)
    merge_history(DATA / "history" / "dtcc_flow.csv", flow.to_dict("records"), ["ccy", "idx", "bucket", "start"])
    return hist


def curve_check(df, days):
    """Spot-starting standard-tenor trades vs the Eurex Clearing par rate of the same day, in bp: the latest day with both."""
    path = DATA / "history" / "swaps.csv"
    if not path.exists():
        return []
    eurex = pd.read_csv(path, index_col=0)
    for d in reversed([str(x) for x in days]):
        if d not in eurex.index:
            continue
        out = []
        for k, x in daily_vwaps(df, d).items():
            par = eurex.at[d, k] if k in eurex.columns else None
            if par is None or pd.isna(par):
                continue
            out.append({"date": d, "series": k, "eurex": round(float(par), 4), "vwap": round(x["day"], 4), "n": x["n"],
                        "snap": None if x["snap"] is None else round(x["snap"], 4), "nSnap": x["nSnap"],
                        "diff": round((x["day"] - par) * 100, 2), "diffSnap": None if x["snap"] is None else round((x["snap"] - par) * 100, 2)})
        if out:
            return out
    return []


def business_days(n):
    days, d = [], datetime.now(timezone.utc).date()
    while len(days) < n:
        d -= timedelta(days=1)
        if d.weekday() < 5:
            days.append(d)
    return sorted(days)


def build(backfill=WINDOW):
    df, found = read(business_days(max(backfill, WINDOW)))
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.json"):          # page files of the earlier layout (one per currency)
        if old.stem != "summary":
            old.unlink()
    path = OUT / "summary.json"
    previous = json.loads(path.read_text()) if path.exists() else {}
    daily = {c["ccy"]: c.get("byDay", {}) for c in previous.get("currencies", [])}
    for d in map(str, found):
        for ccy in INDICES:
            g = df[(df["rep"] == d) & (df["ccy"] == ccy)]
            f = OUT / ccy / f"{d}.json"
            if len(g):
                f.parent.mkdir(exist_ok=True)
                write_json(f, page_file(g, d))
                daily.setdefault(ccy, {})[d] = {k: [int(len(x)), round(float(x["ntl"].sum()), 1)] for k, x in g.groupby("idx")}
            else:
                f.unlink(missing_ok=True)
                daily.get(ccy, {}).pop(d, None)

    update_aggregates(sorted({d.strftime("%Y-%m") for d in found}))
    update_trade_series(found)
    hist = update_histories(df, found)
    check = curve_check(df, found)
    days = sorted({d for v in daily.values() for d in v})
    currencies = []
    for ccy in INDICES:
        by_day = dict(sorted(daily.get(ccy, {}).items()))
        totals = {}
        for v in by_day.values():
            for k, (n, q) in v.items():
                totals[k] = [totals.get(k, [0, 0])[0] + n, round(totals.get(k, [0, 0])[1] + q, 1)]
        currencies.append({"ccy": ccy, "trades": sum(n for n, _ in totals.values()),
                           "indices": {k: totals[k] for k in INDICES[ccy] if k in totals}, "byDay": by_day})
    write_json(path, {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "source": "https://pddata.dtcc.com/ppd/cftcdashboard",
        "days": days,
        "currencies": currencies,
        "check": check,
    })
    off = [c["series"] for c in check if c["diffSnap"] is not None and abs(c["diffSnap"]) > 1]
    print(f"DTCC: rewrote {found[0]}..{found[-1]}; archive {days[0]}..{days[-1]} ({len(days)} days, "
          f"{sum(c['trades'] for c in currencies)} trades); history {len(hist)} dates; curve check "
          f"{check[0]['date'] if check else '–'}: {len(off)} of {len(check)} points more than 1bp from Eurex in its window {off}")

def add_fnd_invoices():
    """Apply the first-notice-day rule to the archive without re-reading DTCC: packaged USD swaps starting on a
    contract's first notice day and maturing on its CTD become invoice swaps."""
    changed = 0
    for path in sorted((OUT / "USD").glob("*.json")):
        f = json.loads(path.read_text())
        if "fc" not in f:
            continue
        base = pd.Timestamp(f["base"])
        inv = f["types"].index("invoice")
        add = {}
        for k, x in enumerate(f["x"]):
            if not x & FLAGS["pkg"] or f["fc"][k] >= 0 or f["s"][k] == STARTS.index("spot") or f["e"][k] > INVOICE_HORIZON:
                continue
            day = (base + pd.Timedelta(seconds=f["t"][k])).strftime("%Y-%m-%d")
            eff = pd.Timestamp(day) + pd.Timedelta(days=f["e"][k])
            mat = eff + pd.Timedelta(days=f["m"][k])
            c = fnd_invoice(day, eff.strftime("%Y-%m-%d"), mat.strftime("%Y-%m-%d"))
            if c:
                add[k] = c
        if add:
            contracts = sorted(set(f["contracts"]) | set(add.values()))
            f["fc"] = [contracts.index(add[k]) if k in add else (contracts.index(f["contracts"][i]) if i >= 0 else -1) for k, i in enumerate(f["fc"])]
            f["contracts"] = contracts
            for k in add:
                f["y"][k] = inv
            write_json(path, f)
            changed += len(add)
    print(f"first notice day invoice swaps added: {changed}")


def retype_invoices():
    """Apply INVOICE_HORIZON to the archive without re-reading DTCC: an invoice swap starting too far ahead gets
    the type its package would have had (curve / fly / package by its legs, outright if not in a package)."""
    changed = 0
    for ccy in INDICES:
        for path in sorted((OUT / ccy).glob("*.json")):
            f = json.loads(path.read_text())
            if "fc" not in f:
                continue
            legs = {}
            for k, g in enumerate(f["g"]):
                if g >= 0:
                    legs.setdefault(g, []).append(k)
            inv = f["types"].index("invoice")
            dirty = False
            for k, c in enumerate(f["fc"]):
                if c >= 0 and f["e"][k] > INVOICE_HORIZON:
                    g = f["g"][k]
                    group = legs.get(g, [])
                    mats = {f["e"][j] + f["m"][j] + f["t"][j] // 86400 for j in group}
                    t = ("curve" if len(group) == 2 and len(mats) == 2 else "fly" if len(group) == 3 and len(mats) == 3
                         else "package") if g >= 0 else "outright"
                    f["y"][k], f["fc"][k], dirty = f["types"].index(t), -1, True
                    changed += 1
            if dirty:
                used = sorted({f["contracts"][i] for i in f["fc"] if i >= 0})
                f["fc"] = [used.index(f["contracts"][i]) if i >= 0 else -1 for i in f["fc"]]
                f["contracts"] = used
                write_json(path, f)
    print(f"retyped {changed} trades starting more than {INVOICE_HORIZON} days ahead")


if __name__ == "__main__":
    if sys.argv[1:] == ["agg"]:          # rebuild every monthly aggregate from the archive
        update_aggregates()
    elif sys.argv[1:] == ["retype"]:     # apply the invoice rules to the archive, then rebuild what depends on it
        retype_invoices()
        add_fnd_invoices()
        update_aggregates()
        update_trade_series()
    elif sys.argv[1:] == ["series"]:     # rebuild the daily curve / fly / swap spread / invoice series from the archive
        update_trade_series()
    else:
        build(int(sys.argv[1]) if len(sys.argv) > 1 else WINDOW)
