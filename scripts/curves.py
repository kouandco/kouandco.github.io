"""Build data/curves.json: end-of-day OIS and IBOR curves from Eurex Clearing (EurexOTC Clear
settlement prices), and archive par swap rates in data/history/swaps.csv.

Eurex Clearing publishes one CSV per day with the discount factors of every curve it uses to
value cleared swaps, one point per calendar day out to 50+ years. Only five are kept:

- USD.FEDFUNDS.1D (Fed funds OIS: Fed pricing), USD.SOFR.1D (SOFR swaps: UST asset swaps)
- EUR.ESTR.1D (€STR OIS: ECB pricing, EUR discounting), EUR.EURIBOR.6M (EUR asset swaps)
- GBP.SONIA.1D (SONIA OIS: BoE pricing)

Discount factors are stored daily for three years, then on the curve date's day of each month,
and interpolated log-linearly in between (exact at the stored points).
"""

import csv
import io
import json
import math
import re
from datetime import date, datetime, timedelta

import pandas as pd

from common import DATA, add_business_days, add_months, get, write_json

PAGE = "https://www.eurex.com/ec-en/clear/eurex-otc-clear/settlement-prices"
KEEP = ("USD.FEDFUNDS.1D", "USD.SOFR.1D", "EUR.ESTR.1D", "EUR.EURIBOR.6M", "GBP.SONIA.1D")
DAILY_YEARS = 3
SWAPS = {  # label: (projection, discounting, fixed-leg months, float-leg months, fixed day count, float day basis)
    "USD SOFR": ("USD.SOFR.1D", "USD.SOFR.1D", 12, 12, 360, 360),
    "EUR €STR": ("EUR.ESTR.1D", "EUR.ESTR.1D", 12, 12, 360, 360),
    "EUR 6M": ("EUR.EURIBOR.6M", "EUR.ESTR.1D", 12, 6, "30/360", 360),
    "GBP SONIA": ("GBP.SONIA.1D", "GBP.SONIA.1D", 12, 12, 365, 365),
}
SWAP_TENORS = (2, 5, 10, 30)


def download():
    page = get(PAGE).text
    href = re.search(r'href="([^"]+settlement-prices_(\d{8})\.csv)"', page)
    if not href:
        raise RuntimeError(f"no settlement-prices file listed on {PAGE}")
    text = get("https://www.eurex.com" + href.group(1), timeout=300).text
    points = {k: {} for k in KEEP}
    as_of = None
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 6 or row[1] not in points or row[4] != "S":
            continue
        as_of = as_of or row[0][:10]
        points[row[1]][int(row[2])] = float(row[5])
    missing = [k for k, v in points.items() if len(v) < 1000]
    if missing:
        raise RuntimeError(f"curves missing from the Eurex file: {missing}")
    return as_of, points


class Curve:
    """Discount factors by date from a {days after the curve date: DF} map (DF = 1 on the curve date)."""

    def __init__(self, as_of, dfs):
        self.as_of = as_of if isinstance(as_of, date) else datetime.strptime(as_of, "%Y-%m-%d").date()
        self.days = sorted(int(k) for k in dfs)
        self.logs = [math.log(dfs[k] if k in dfs else dfs[str(k)]) for k in self.days]
        if self.days[0] != 0:
            self.days.insert(0, 0)
            self.logs.insert(0, 0.0)

    def df(self, d):
        x = (d - self.as_of).days
        days, logs = self.days, self.logs
        if x <= 0:
            return 1.0
        if x >= days[-1]:
            return math.exp(logs[-1] * x / days[-1])
        lo, hi = 0, len(days) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if days[mid] <= x:
                lo = mid
            else:
                hi = mid
        w = (x - days[lo]) / (days[hi] - days[lo])
        return math.exp(logs[lo] + w * (logs[hi] - logs[lo]))


def load():
    """Curves from data/curves.json as {curve id: Curve}, or None if the file is missing."""
    path = DATA / "curves.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    return {k: Curve(data["asOf"], v) for k, v in data["curves"].items()}


def accrual(s, t, basis):
    if basis == "30/360":
        return (360 * (t.year - s.year) + 30 * (t.month - s.month) + min(t.day, 30) - min(s.day, 30)) / 360
    return (t - s).days / basis


def schedule(start, end, months):
    """Period end dates from `end` back to just after `start` (short first period)."""
    dates, k = [], 0
    while add_months(end, -months * k) > start:
        dates.append(add_months(end, -months * k))
        k += 1
    return sorted(dates)


def par_rate(curves, label, start, end):
    proj_id, disc_id, fixed_m, float_m, fixed_dc, _ = SWAPS[label]
    proj, disc = curves[proj_id], curves[disc_id]
    d0 = disc.df(start)
    fixed_ends = schedule(start, end, fixed_m)
    fixed = sum(accrual(s, t, fixed_dc) * disc.df(t) / d0 for s, t in zip([start] + fixed_ends[:-1], fixed_ends))
    ends = schedule(start, end, float_m)
    flt = sum((proj.df(s) / proj.df(t) - 1) * disc.df(t) / d0 for s, t in zip([start] + ends[:-1], ends))
    return 100 * flt / fixed


def asw(curves, market, coupon, maturity, settle, freq, dirty):
    """Par-par asset swap spread in bp: the spread over the floating leg (SOFR for USD, 6M Euribor for EUR)
    that makes bond + swap worth par. Positive = bond yields more than swaps (cheap)."""
    proj_id, disc_id, _, float_m, _, basis = SWAPS["USD SOFR" if market == "UST" else "EUR 6M"]
    proj, disc = curves[proj_id], curves[disc_id]
    d0 = disc.df(settle)
    pv_coupons = sum(coupon / freq * disc.df(t) / d0 for t in schedule(settle, maturity, 12 // freq))
    ends = schedule(settle, maturity, float_m)
    starts = [settle] + ends[:-1]
    pv_float = sum(100 * (proj.df(s) / proj.df(t) - 1) * disc.df(t) / d0 for s, t in zip(starts, ends))
    annuity = sum((t - s).days / basis * disc.df(t) / d0 for s, t in zip(starts, ends))
    return (100 - dirty - pv_float + pv_coupons) / (100 * annuity) * 1e4


def build():
    as_of, points = download()
    d = datetime.strptime(as_of, "%Y-%m-%d").date()
    cutoff = (add_months(d, 12 * DAILY_YEARS) - d).days
    keep_days = set(range(cutoff + 1)) | {(add_months(d, m) - d).days for m in range(0, 12 * 61)}
    stored = {k: {str(x): round(v[x], 12) for x in sorted(v) if x in keep_days} for k, v in points.items()}
    write_json(DATA / "curves.json", {"asOf": as_of, "source": PAGE, "curves": stored})

    curves = {k: Curve(as_of, v) for k, v in points.items()}
    spot = add_business_days(d, 2)
    rates = {f"{label} {n}Y": round(par_rate(curves, label, spot, add_months(spot, 12 * n)), 4)
             for label in SWAPS for n in SWAP_TENORS}
    path = DATA / "history" / "swaps.csv"
    hist = pd.read_csv(path, index_col=0) if path.exists() else pd.DataFrame()
    hist = pd.concat([hist.drop(index=as_of, errors="ignore"), pd.DataFrame(rates, index=[as_of])]).sort_index()
    hist.index.name = "date"
    hist.to_csv(path, float_format="%.4f")
    write_json(DATA / "gp" / "swaps.json", {
        "dates": list(hist.index.astype(str)),
        "series": {k: [None if pd.isna(v) else float(v) for v in hist[k]] for k in hist.columns},
    })
    print(f"Curves {as_of}: " + ", ".join(f"{k} {v:.3f}" for k, v in rates.items() if k.endswith(" 10Y")))
    return curves


if __name__ == "__main__":
    build()
