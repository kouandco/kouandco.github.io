"""Shared helpers for the data builders: HTTP, dates, bond maths and curve fitting.

Bond conventions: clean prices per 100, yields in percent compounded at the coupon
frequency (street convention), accrued interest actual/actual (ICMA).
"""

import json
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/130 Safari/537.36"}

session = requests.Session()
session.headers.update(UA)


def get(url, retries=3, **kw):
    for attempt in range(retries):
        try:
            r = session.get(url, timeout=kw.pop("timeout", 60), **kw)
            r.raise_for_status()
            return r
        except requests.RequestException:
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), allow_nan=False))


# ---------------------------------------------------------------- dates

def add_months(d, months):
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    last = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)).day
    return date(y, m, min(d.day, last))


def add_business_days(d, n):
    while n > 0:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


def years(a, b):
    return (b - a).days / 365.25


def parse_date(s):
    return datetime.strptime(s[:10], "%Y-%m-%d").date()


# ---------------------------------------------------------------- bonds

def schedule(maturity, settle, freq):
    """Previous and next coupon dates around `settle`, and the number of remaining coupons."""
    step = 12 // freq
    k = 0
    while add_months(maturity, -step * (k + 1)) > settle:
        k += 1
    return add_months(maturity, -step * (k + 1)), add_months(maturity, -step * k), k + 1


def pricer(coupon, maturity, settle, freq):
    """Clean price per 100 as a function of yield (percent) for a fixed settlement date."""
    prev, nxt, n = schedule(maturity, settle, freq)
    w = (nxt - settle).days / (nxt - prev).days
    c = coupon / freq

    def price(y):
        d = 1 / (1 + y / 100 / freq)
        annuity = n if abs(1 - d) < 1e-12 else (1 - d ** n) / (1 - d)
        return d ** w * (c * annuity + 100 * d ** (n - 1)) - c * (1 - w)

    return price


def yield_from_price(price, coupon, maturity, settle, freq):
    f = pricer(coupon, maturity, settle, freq)
    lo, hi = -5.0, 30.0
    for _ in range(50):
        mid = (lo + hi) / 2
        if f(mid) > price:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def dv01(y, coupon, maturity, settle, freq):
    """Price change per 100 nominal for a 1bp fall in yield."""
    f = pricer(coupon, maturity, settle, freq)
    return (f(y - 0.01) - f(y + 0.01)) / 2


def frac_name(c):
    """3.125 -> '3 1/8' (Treasury style)."""
    whole = int(c)
    eighths = round((c - whole) * 8)
    if eighths == 0:
        return f"{whole}"
    if eighths == 8:
        return f"{whole + 1}"
    num, den = eighths, 8
    while num % 2 == 0:
        num, den = num // 2, den // 2
    return f"{whole} {num}/{den}" if whole else f"{num}/{den}"


def isin_from_cusip(cusip):
    """US ISIN = 'US' + CUSIP + Luhn check digit over the letters-as-numbers string."""
    digits = "".join(str(int(ch, 36)) for ch in "US" + cusip)
    total = 0
    for i, ch in enumerate(reversed(digits)):
        n = int(ch) * (2 if i % 2 == 0 else 1)
        total += n // 10 + n % 10
    return f"US{cusip}{(10 - total % 10) % 10}"


# ---------------------------------------------------------------- curves

NS_TAU = 2.0


def ns_basis(t, tau=NS_TAU):
    t = np.maximum(np.asarray(t, dtype=float), 1e-6)
    x = t / tau
    f1 = (1 - np.exp(-x)) / x
    return np.column_stack([np.ones_like(t), f1, f1 - np.exp(-x)])


def ns_fit(t, y, tau=NS_TAU):
    """Nelson-Siegel with a fixed decay, fitted by least squares. Falls back to fewer factors
    (linear in maturity, then flat) when there are too few bonds for a stable fit."""
    t, y = np.asarray(t, float), np.asarray(y, float)
    if len(t) >= 5 and t.max() - t.min() > 1:
        beta, *_ = np.linalg.lstsq(ns_basis(t, tau), y, rcond=None)
        return {"kind": "ns", "tau": tau, "beta": [float(b) for b in beta]}
    if len(t) >= 2 and t.max() - t.min() > 0.5:
        slope, level = np.polyfit(t, y, 1)
        return {"kind": "linear", "beta": [float(level), float(slope)]}
    return {"kind": "flat", "beta": [float(np.mean(y))]}


def curve_eval(fit, t):
    t = np.asarray(t, float)
    b = fit["beta"]
    if fit["kind"] == "ns":
        return ns_basis(t, fit["tau"]) @ np.array(b)
    if fit["kind"] == "linear":
        return b[0] + b[1] * t
    return np.full_like(t, b[0])
