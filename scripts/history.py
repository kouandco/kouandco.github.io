"""Build data/gp/eurex.json: daily Eurex series for the GP page from the archived trade files
(data/eurex_trades.json) and the archived conversion factors (data/history/eurex_cf.csv).

- Futures: daily VWAP of the futures leg of all EFP and EFS trades, per contract and expiry.
- Gross basis: daily VWAP of cash − futures × CF over EFP trades, per deliverable bond, in cents, with the
  EURX page's outlier rules (futures.daily_basis).
- Invoice spread: daily VWAP of swap rate − futures-implied yield over EFS trades whose swap runs from
  delivery to (within 45 days of) a deliverable's maturity, in bp. Matched EFS print in two clusters
  (most likely €STR OIS and 6m Euribor swaps; the file does not say which), split as on the EURX page.

Outliers are dropped as on the EURX page: further than max(floor, 8 MAD) from the series median.
"""

import json
from collections import defaultdict
from datetime import date

import numpy as np
import pandas as pd

from common import DATA, parse_date, write_json, yield_from_price
from futures import daily_basis

FREQ = {"DU": 1, "OE": 1, "RX": 1, "UB": 1, "OAT": 1, "BTS": 2, "IK": 2}


def keep(values, floor):
    v = np.asarray(values, float)
    med = np.median(v)
    return np.abs(v - med) <= max(floor, 8 * np.median(np.abs(v - med)))


def two_means(values):
    lo, hi = np.quantile(values, 0.1), np.quantile(values, 0.9)
    for _ in range(20):
        mid = (lo + hi) / 2
        lo = values[values <= mid].mean() if (values <= mid).any() else lo
        hi = values[values > mid].mean() if (values > mid).any() else hi
    return (lo + hi) / 2, hi - lo >= 8


def vwap(df, value):
    g = df.assign(pq=df[value] * df.q).groupby("day")
    return (g.pq.sum() / g.q.sum()).round(4)


def build():
    trades = json.loads((DATA / "eurex_trades.json").read_text())
    cfs = pd.read_csv(DATA / "history" / "eurex_cf.csv", dtype={"cf": float, "coupon": float})
    cf = {(r.contract, r.expiry, r.isin): r for r in cfs.itertuples()}
    efp = pd.DataFrame(trades["efp"])
    efs = pd.DataFrame(trades["efs"])
    for df in (efp, efs):
        df["day"] = df.t.str[:10]
    days = sorted(set(efp.day) | set(efs.day))
    series = {}

    fut = pd.concat([efp[["c", "x", "day", "f", "q"]], efs[["c", "x", "day", "f", "q"]]])
    for (c, x), g in fut.groupby(["c", "x"]):
        series[f"FUT|{c}|{x}"] = vwap(g, "f")

    efp = efp[[(r.c, r.x, r.isin) in cf for r in efp.itertuples()]]
    for (c, x, isin), g in efp.groupby(["c", "x", "isin"]):
        daily = daily_basis(g.to_dict("records"), cf[(c, x, isin)].cf)
        if daily:
            series[f"BASIS|{c}|{x}|{isin}"] = pd.Series({d: v for d, (v, _) in daily.items()})

    baskets = defaultdict(list)
    for (c, x, isin), r in cf.items():
        baskets[(c, x)].append(r)
    rows = []
    for r in efs.itertuples():
        end = parse_date(f"{r.e[:4]}-{r.e[4:6]}-{r.e[6:]}")
        for b in baskets.get((r.c, r.x), []):
            delivery = parse_date(b.delivery)
            if abs((end - parse_date(b.maturity)).days) <= 45 and r.s >= f"{delivery:%Y%m}01":
                y = yield_from_price(r.f * b.cf, b.coupon, parse_date(b.maturity), delivery, FREQ[r.c])
                rows.append({"c": r.c, "x": r.x, "day": r.day, "q": r.q, "isin": b.isin, "v": (r.rate - y) * 100})
                break
    inv = pd.DataFrame(rows)
    for (c, x), g in inv.groupby(["c", "x"]) if len(inv) else []:
        g = g[keep(g.v, 40)]
        cut, split = two_means(g.v.values)
        legs = {"lower": g[g.v <= cut], "upper": g[g.v > cut]} if split else {"all": g}
        for leg, sub in legs.items():
            if len(sub):
                series[f"INV|{c}|{x}|{leg}"] = vwap(sub, "v").round(2)

    write_json(DATA / "gp" / "eurex.json", {
        "built": str(date.today()), "dates": days,
        "series": {k: [None if pd.isna(v) else float(v) for v in s.reindex(days)] for k, s in sorted(series.items())},
    })
    kinds = defaultdict(int)
    for k in series:
        kinds[k.split("|")[0]] += 1
    print(f"Eurex history: {len(days)} days, " + ", ".join(f"{n} {k}" for k, n in kinds.items()))


if __name__ == "__main__":
    build()
