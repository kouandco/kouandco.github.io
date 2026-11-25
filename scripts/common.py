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


def accrued(coupon, maturity, settle, freq):
    prev, nxt, _ = schedule(maturity, settle, freq)
    return coupon / freq * (settle - prev).days / (nxt - prev).days


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


# Svensson: Nelson-Siegel plus a second hump. The two decays are chosen on a grid (the betas are then linear
# least squares), so the curve can bend at both the short end and the long end. Bonds that sit far off the curve
# for structural reasons (old high-coupon lines, off-the-runs trading rich) are trimmed from the fit by a robust
# rule (more than 4 × the median absolute deviation and at least 3bp away), so they do not drag the curve.
SV_TAU1 = np.geomspace(0.3, 6, 14)
SV_TAU2 = np.geomspace(4, 30, 12)


def sv_basis(t, tau1, tau2):
    t = np.maximum(np.asarray(t, dtype=float), 1e-6)
    x1, x2 = t / tau1, t / tau2
    f1, f2 = (1 - np.exp(-x1)) / x1, (1 - np.exp(-x2)) / x2
    return np.column_stack([np.ones_like(t), f1, f1 - np.exp(-x1), f2 - np.exp(-x2)])


def _sv_lstsq(t, y, taus):
    best = None
    for a, b in taus:
        X = sv_basis(t, a, b)
        beta, *_ = np.linalg.lstsq(X, y, rcond=None)
        sse = float(((y - X @ beta) ** 2).sum())
        if best is None or sse < best[0]:
            best = (sse, a, b, beta)
    return best[1:]


def curve_fit(t, y, taus=None):
    """The government curve through bond yields (%): Svensson with grid-searched decays (or the given `taus`,
    for fast daily refits), robustly trimmed. Returns (fit, keep mask). Few bonds: Nelson-Siegel, linear, flat."""
    t, y = np.asarray(t, float), np.asarray(y, float)
    keep = np.ones(len(t), bool)
    if len(t) < 10 or t.max() - t.min() < 5:
        return ns_fit(t, y), keep
    grid = [taus] if taus else [(a, b) for a in SV_TAU1 for b in SV_TAU2 if b >= 1.5 * a]
    for _ in range(3):
        a, b, beta = _sv_lstsq(t[keep], y[keep], grid)
        r = y - sv_basis(t, a, b) @ beta
        mad = 1.4826 * np.median(np.abs(r[keep] - np.median(r[keep])))
        new = np.abs(r) < max(4 * mad, 0.03)
        if new.sum() < 10 or (new == keep).all():
            break
        keep = new
    a, b, beta = _sv_lstsq(t[keep], y[keep], grid)
    return {"kind": "sv", "tau": [round(float(a), 4), round(float(b), 4)], "beta": [float(v) for v in beta]}, keep


SPREAD_KNOTS = (0, 1, 2, 3, 5, 7, 10, 12, 15, 17, 20, 25, 30, 50)


def _hat(t, knots):
    """Piecewise-linear interpolation weights of t on the knots (flat beyond the ends)."""
    t = np.clip(np.asarray(t, float), knots[0], knots[-1])
    w = np.zeros((len(t), len(knots)))
    j = np.clip(np.searchsorted(knots, t, side="right") - 1, 0, len(knots) - 2)
    x = (t - knots[j]) / (knots[j + 1] - knots[j])
    w[np.arange(len(t)), j] = 1 - x
    w[np.arange(len(t)), j + 1] = x
    return w


def sector_spread(t, r, smooth=1.0):
    """An issue type's gap to the market curve (bp) as a smooth piecewise-linear function of maturity: knots
    within the type's range and a penalty on their second differences. Captures sectors such as old 30-year bonds
    trading rich in the 10-15 year area while new long bonds sit on the curve. Not trimmed: those clusters are
    exactly what it should follow (bad prints are dropped before, at 40bp)."""
    t, r = np.asarray(t, float), np.asarray(r, float)
    lo, hi = t.min(), t.max()
    knots = np.unique(np.r_[lo, [k for k in SPREAD_KNOTS if lo < k < hi], hi]) if hi - lo > 0.5 else np.array([lo, lo + 1])
    n = len(knots)
    D = np.diff(np.eye(n), 2, axis=0) if n > 2 else np.zeros((0, n))
    A = np.vstack([_hat(t, knots), np.sqrt(smooth) * D, 1e-3 * np.eye(n)])
    s, *_ = np.linalg.lstsq(A, np.r_[r, np.zeros(len(D) + n)], rcond=None)
    return {"t": [round(float(k), 3) for k in knots], "s": [round(float(v), 2) for v in s]}


def curve_eval(fit, t):
    t = np.asarray(t, float)
    b = fit["beta"]
    if fit.get("spread"):   # an issue type's curve: market curve + its sector spread (bp)
        sp = fit["spread"]
        base = curve_eval({k: v for k, v in fit.items() if k != "spread"}, t)
        return base + _hat(np.atleast_1d(t), np.array(sp["t"])) @ np.array(sp["s"]) / 100
    if fit["kind"] == "sv":
        return sv_basis(t, *fit["tau"]) @ np.array(b)
    if fit["kind"] == "ns":
        return ns_basis(t, fit["tau"]) @ np.array(b)
    if fit["kind"] == "linear":
        return b[0] + b[1] * t
    return np.full_like(t, b[0])
