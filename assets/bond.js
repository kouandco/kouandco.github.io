// Bond maths shared by the pages. Prices per 100 nominal, yields and rates in percent,
// coupons compounded at the coupon frequency, accrued interest actual/actual (ICMA),
// repo money-market actual/360.

const DAY = 864e5;

export const parseDate = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
export const yearsBetween = (a, b) => (b - a) / DAY / 365.25;

export function addMonths(date, months) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(date.getUTCDate(), last)));
}

// Coupon schedule around `settle`: previous and next coupon dates and remaining coupons.
function schedule(maturity, settle, freq) {
  const step = 12 / freq;
  let k = 0;
  while (addMonths(maturity, -step * (k + 1)) > settle) k++;
  return { prev: addMonths(maturity, -step * (k + 1)), next: addMonths(maturity, -step * k), n: k + 1 };
}

// Pricer for one settlement date: clean price as a function of yield, accrued and DV01.
export function pricer(coupon, maturity, settle, freq) {
  const { prev, next, n } = schedule(maturity, settle, freq);
  const w = (next - settle) / (next - prev);
  const c = coupon / freq;
  const accrued = c * (1 - w);
  const price = (y) => {
    const d = 1 / (1 + y / 100 / freq);
    const annuity = Math.abs(1 - d) < 1e-12 ? n : (1 - d ** n) / (1 - d);
    return d ** w * (c * annuity + 100 * d ** (n - 1)) - accrued;
  };
  const dv01 = (y) => (price(y - 0.01) - price(y + 0.01)) / 2;
  return { price, accrued, dv01 };
}

export function yieldFromPrice(price, target, lo = -5, hi = 30) {
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (price(mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Coupons paid after `from` up to and including `to`.
function couponsBetween(maturity, from, to, freq) {
  const out = [];
  const step = 12 / freq;
  for (let k = 0; ; k++) {
    const d = addMonths(maturity, -step * k);
    if (d <= from) break;
    if (d <= to) out.push(d);
  }
  return out;
}

// Forward clean price at `fwd` from a spot clean price at `settle`, financed at `repo` (%, act/360):
// carry = coupon income − financing cost.
export function forwardPrice(bond, spotClean, settle, fwd, repo) {
  const spot = pricer(bond.coupon, bond.maturity, settle, bond.freq);
  const later = pricer(bond.coupon, bond.maturity, fwd, bond.freq);
  const r = repo / 100 / 360;
  let dirty = (spotClean + spot.accrued) * (1 + r * (fwd - settle) / DAY);
  for (const d of couponsBetween(bond.maturity, settle, fwd, bond.freq)) {
    dirty -= (bond.coupon / bond.freq) * (1 + r * (fwd - d) / DAY);
  }
  return dirty - later.accrued;
}

// ---------------------------------------------------------------- curves

export function nsEval(fit, t) {
  const b = fit.beta;
  if (fit.kind === "ns") {
    const x = Math.max(t, 1e-6) / fit.tau;
    const f1 = (1 - Math.exp(-x)) / x;
    return b[0] + b[1] * f1 + b[2] * (f1 - Math.exp(-x));
  }
  if (fit.kind === "linear") return b[0] + b[1] * t;
  return b[0];
}

// Monotone cubic (Fritsch–Carlson) through (xs, ys), flat beyond the ends.
export function monotone(xs, ys) {
  const n = xs.length;
  if (n === 1) return () => ys[0];
  const h = [], s = [];
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); s.push((ys[i + 1] - ys[i]) / h[i]); }
  const m = [s[0]];
  for (let i = 1; i < n - 1; i++) m.push(s[i - 1] * s[i] <= 0 ? 0 : (3 * (h[i - 1] + h[i])) / ((2 * h[i] + h[i - 1]) / s[i - 1] + (h[i] + 2 * h[i - 1]) / s[i]));
  m.push(s[n - 2]);
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

export function linear(xs, ys) {
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    return ys[i] + ((ys[i + 1] - ys[i]) * (x - xs[i])) / (xs[i + 1] - xs[i]);
  };
}

// Repo rate (%) at a term in years from the repo curve points.
export const repoAt = (points, t) => linear(points.map((p) => p.t), points.map((p) => p.rate))(t);

// ---------------------------------------------------------------- normal distribution

export const phi = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

// Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf, |error| < 1.5e-7).
export function Phi(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}
