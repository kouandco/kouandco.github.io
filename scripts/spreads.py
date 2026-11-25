"""Build the USD swap spread: SOFR swap rate − Treasury par yield at the same tenor, in bp.

- Treasury par yields: US Treasury's Daily Treasury Par Yield Curve Rates (home.treasury.gov), read from
  indicative bid-side quotes at about 15:30 New York, archived in data/history/UST_par.csv.
- SOFR: the notional-weighted average rate of spot-starting SOFR swaps of exactly that tenor executed
  14:30-16:30 New York, reported to DTCC (data/history/dtcc.csv, "@NY"), so both legs are taken at the same
  time of day. Missing on days with no such trades.
The spread is the raw difference of the quoted rates (SOFR annual act/360, Treasuries semi-annual bond
equivalent), as swap spreads are quoted in the market. Negative: swaps below Treasuries.

Output: data/gp/spreads.json (GP page) and the latest values in data/spreads.json (DTCC page).
"""

from datetime import date

import pandas as pd

from common import DATA, get, write_json

URL = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all"
       "?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv")
COLUMNS = {"1 Yr": 1, "2 Yr": 2, "3 Yr": 3, "5 Yr": 5, "7 Yr": 7, "10 Yr": 10, "20 Yr": 20, "30 Yr": 30}
TENORS = tuple(COLUMNS.values())


def par_curve():
    """Treasury par yields by date (%), the archive extended with this year's file (and last year's in January)."""
    path = DATA / "history" / "UST_par.csv"
    old = pd.read_csv(path, index_col=0) if path.exists() else pd.DataFrame()
    today = date.today()
    # This year's file every run (and last year's in January); earlier years once, back to the first DTCC date.
    dtcc = DATA / "history" / "dtcc.csv"
    first = int(pd.read_csv(dtcc, usecols=[0]).iloc[:, 0].min()[:4]) if dtcc.exists() else today.year
    have = {int(d[:4]) for d in old.index} if len(old) else set()
    years = {today.year} | ({today.year - 1} if today.month == 1 else set()) | {y for y in range(first, today.year) if y not in have}
    frames = []
    for y in sorted(years):
        raw = pd.read_csv(pd.io.common.StringIO(get(URL.format(year=y)).text))
        if raw.empty:
            continue
        raw.index = pd.to_datetime(raw["Date"], format="%m/%d/%Y").dt.strftime("%Y-%m-%d")
        frames.append(raw[[c for c in COLUMNS if c in raw.columns]].rename(columns=lambda c: f"{COLUMNS[c]}Y"))
    if not frames:
        raise RuntimeError("no Treasury par yield file")
    new = pd.concat(frames)
    out = new.combine_first(old) if len(old) else new
    out = out[[f"{t}Y" for t in TENORS]].sort_index()
    out.index.name = "date"
    out.to_csv(path, float_format="%.2f")
    return out


def build():
    ust = par_curve()
    dtcc = pd.read_csv(DATA / "history" / "dtcc.csv", index_col=0)
    series = {}
    for t in TENORS:
        series[f"UST par {t}Y"] = ust[f"{t}Y"]
        if f"USD SOFR {t}Y @NY" in dtcc.columns:
            series[f"USD swap spread {t}Y"] = (dtcc[f"USD SOFR {t}Y @NY"] - ust[f"{t}Y"]) * 100
    table = pd.DataFrame(series).sort_index()
    table = table[table.index >= dtcc.index.min()]
    table = table.dropna(how="all", subset=[c for c in table.columns if not c.startswith("UST")])
    # GP gets the swap spread only (Treasury yields are there as generic yields already).
    write_json(DATA / "gp" / "spreads.json", {
        "dates": list(table.index),
        "series": {k: [None if pd.isna(v) else round(float(v), 2) for v in table[k]] for k in table.columns if not k.startswith("UST")},
    })
    latest = []
    for t in TENORS:
        row = {"tenor": t}
        for key, col, scale in (("ust", f"UST par {t}Y", 100), ("spread", f"USD swap spread {t}Y", 1)):
            s = table[col].dropna() if col in table.columns else pd.Series(dtype=float)
            row[key] = None if s.empty else {"date": s.index[-1], "value": round(float(s.iat[-1]), 4 if key == "ust" else 2),
                                             "chg": None if len(s) < 2 else round(float(s.iat[-1] - s.iat[-2]) * scale, 2)}
        s = dtcc[f"USD SOFR {t}Y @NY"].dropna() if f"USD SOFR {t}Y @NY" in dtcc.columns else pd.Series(dtype=float)
        row["sofr"] = None if s.empty else {"date": s.index[-1], "value": round(float(s.iat[-1]), 4)}
        latest.append(row)
    write_json(DATA / "spreads.json", {"source": "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve",
                                       "ustAsOf": ust.index[-1], "latest": latest})
    ten = next(r for r in latest if r["tenor"] == 10)
    print(f"USD swap spread: Treasury par curve {ust.index[-1]}; 10Y {ten['spread']['value'] if ten['spread'] else '–'}bp")

if __name__ == "__main__":
    build()
