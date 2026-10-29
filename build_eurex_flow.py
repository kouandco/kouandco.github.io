"""Build eurex_flow.json: monthly open interest and volume of Eurex bond futures,
with the move in the underlying yield and a positioning classification.

Sources
- Eurex monthly statistics (XLS): month-end open interest and traded contracts per
  product, with the previous month and the same month a year earlier. Eurex only
  lists the latest five files, so every month read is kept in eurex_flow_history.csv
  and the history grows each time this script runs.
- Yields: Bundesbank Federal securities curve (month-end) for German contracts;
  FRED / OECD 10-year yields (monthly averages) for France and Italy.

Run: python build_eurex_flow.py
"""

import json
import re
from io import StringIO
from pathlib import Path

import pandas as pd
import requests

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/130 Safari/537.36"}
HERE = Path(__file__).parent
HISTORY = HERE / "eurex_flow_history.csv"
OUT = HERE / "eurex_flow.json"

CONTRACTS = {
    # Eurex product: code, name, market, yield series
    "FGBS": ("DU", "Euro-Schatz", "Bund", "DE2"),
    "FGBM": ("OE", "Euro-Bobl", "Bund", "DE5"),
    "FGBL": ("RX", "Euro-Bund", "Bund", "DE10"),
    "FGBX": ("UB", "Euro-Buxl", "Bund", "DE30"),
    "FOAT": ("OAT", "Euro-OAT", "OAT", "FR10"),
    "FBTS": ("BTS", "Short-Term Euro-BTP", "BTP", "IT10"),
    "FBTP": ("IK", "Euro-BTP", "BTP", "IT10"),
}
YIELD_LABELS = {
    "DE2": "German 2y", "DE5": "German 5y", "DE10": "German 10y", "DE30": "German 30y",
    "FR10": "French 10y (monthly avg)", "IT10": "Italian 10y (monthly avg)",
}

# Column positions in the "Eurex Monthly Statistics" sheet.
COL_PRODUCT, COL_VOL, COL_VOL_PREV, COL_VOL_YOY = 4, 5, 7, 9
COL_OI, COL_OI_PREV, COL_OI_YOY = 35, 36, 38


def monthly_files():
    page = requests.get("https://www.eurex.com/ex-en/data/statistics/monthly-statistics", headers=UA, timeout=60).text
    return sorted(set(re.findall(r'href="([^"]*monthlystat_\d{6}\.xls)"', page)))


def read_month(url):
    """Rows of (month, product, oi, volume) from one monthly file, including the
    previous month and the same month a year earlier."""
    raw = requests.get(url, headers=UA, timeout=120).content
    df = pd.read_excel(raw, sheet_name="Eurex Monthly Statistics", header=None)
    month = pd.Period(re.search(r"monthlystat_(\d{6})", url).group(1), "M")
    rows = df[df[COL_PRODUCT].isin(CONTRACTS)]
    out = []
    for r in rows.itertuples(index=False):
        p = r[COL_PRODUCT]
        out += [
            (month, p, r[COL_OI], r[COL_VOL]),
            (month - 1, p, r[COL_OI_PREV], r[COL_VOL_PREV]),
            (month - 12, p, r[COL_OI_YOY], r[COL_VOL_YOY]),
        ]
    return out


def update_history():
    rows = []
    for url in monthly_files():
        print("  ", url.rsplit("/", 1)[-1])
        rows += read_month(url)
    new = pd.DataFrame(rows, columns=["month", "product", "oi", "volume"])
    new["month"] = new["month"].astype(str)
    if HISTORY.exists():
        new = pd.concat([pd.read_csv(HISTORY), new])
    # Latest file wins when the same month appears more than once.
    hist = new.drop_duplicates(["month", "product"], keep="last").sort_values(["product", "month"])
    hist.to_csv(HISTORY, index=False)
    return hist


def yields():
    """Month-end (Germany) or monthly-average (France, Italy) yields, by month."""
    series = {}
    for key, n in (("DE2", 2), ("DE5", 5), ("DE10", 10), ("DE30", 30)):
        sid = f"BBSIS/D.I.ZST.ZI.EUR.S1311.B.A604.R{n:02d}XX.R.A.A._Z._Z.A"
        text = requests.get(
            f"https://api.statistiken.bundesbank.de/rest/data/{sid}?startPeriod=2024-01-01&format=csv&lang=en", timeout=60
        ).text
        pts = [l.split(",")[:2] for l in text.splitlines() if re.match(r"^\d{4}-\d\d-\d\d,", l)]
        s = pd.Series({pd.Timestamp(d): float(v) for d, v in pts if v not in ("", ".")})
        series[key] = s.groupby(s.index.to_period("M")).last()
    fred = pd.read_csv(
        StringIO(requests.get(
            "https://fred.stlouisfed.org/graph/fredgraph.csv?id=IRLTLT01FRM156N,IRLTLT01ITM156N", timeout=60
        ).text),
        parse_dates=["observation_date"], na_values=["."],
    ).set_index("observation_date")
    fred.index = fred.index.to_period("M")
    series["FR10"] = fred["IRLTLT01FRM156N"].dropna()
    series["IT10"] = fred["IRLTLT01ITM156N"].dropna()
    return series


def classify(d_oi, d_yield):
    if pd.isna(d_oi) or pd.isna(d_yield) or d_oi == 0 or d_yield == 0:
        return None
    price_up = d_yield < 0
    if d_oi > 0:
        return "New longs" if price_up else "New shorts"
    return "Short covering" if price_up else "Long liquidation"


if __name__ == "__main__":
    print("Eurex monthly statistics ...")
    hist = update_history()
    print("Yields ...")
    ys = yields()
    contracts = {}
    for product, (code, name, market, ykey) in CONTRACTS.items():
        h = hist[hist["product"] == product].copy()
        h["period"] = pd.PeriodIndex(h["month"], freq="M")
        h = h.set_index("period").sort_index()
        full = pd.period_range(h.index.min(), h.index.max(), freq="M")
        h = h.reindex(full)
        y = ys[ykey].reindex(full)
        months = []
        for i, p in enumerate(full):
            prev = full[i - 1] if i else None
            oi, vol = h.loc[p, "oi"], h.loc[p, "volume"]
            d_oi = oi - h.loc[prev, "oi"] if prev is not None else float("nan")
            d_y = (y[p] - y[prev]) * 100 if prev is not None else float("nan")
            months.append({
                "month": str(p),
                "oi": None if pd.isna(oi) else int(oi),
                "volume": None if pd.isna(vol) else int(vol),
                "dOI": None if pd.isna(d_oi) else int(d_oi),
                "yield": None if pd.isna(y[p]) else round(float(y[p]), 3),
                "dYieldBp": None if pd.isna(d_y) else round(float(d_y), 1),
                "flow": classify(d_oi, d_y),
            })
        contracts[code] = {
            "product": product, "name": name, "market": market,
            "yieldLabel": YIELD_LABELS[ykey], "months": months,
        }
    OUT.write_text(json.dumps({"built": str(pd.Timestamp.today().date()), "contracts": contracts}, indent=1))
    for code, c in contracts.items():
        last = [m for m in c["months"] if m["oi"] is not None][-1]
        print(f"{code:4} {len(c['months'])} months, last {last['month']}: OI {last['oi']:,} dOI {last['dOI']} dy {last['dYieldBp']} -> {last['flow']}")
