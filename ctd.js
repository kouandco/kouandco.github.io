// Single-factor Monte Carlo model for bond futures CTD analysis.
// Yields are in decimal (0.04 = 4%), prices per 100 face, conversion factors per 1 face.

const DAY = 86400000;

export function parseDate(s) {
  const [y, m, d] = s.trim().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addMonths(date, months) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(date.getUTCDate(), last)));
}

// Fixed-coupon bond (actual/actual, `freq` coupons a year: 2 for UST and BTP,
// 1 for Bund and OAT) priced for a fixed settlement date.
// Returns a fast clean-price function of yield.
export function makeBond(coupon, maturity, settle, freq = 2) {
  const step = 12 / freq;
  let k = 0;
  while (addMonths(maturity, -step * (k + 1)) > settle) k++;
  const next = addMonths(maturity, -step * k);
  const prev = addMonths(maturity, -step * (k + 1));
  const periodDays = (next - prev) / DAY;
  const w = (next - settle) / DAY / periodDays;
  const nFlows = k + 1;
  const c = coupon * 100 / freq;
  const accrued = c * (1 - w);
  // Coupons at w, w+1, ..., w+nFlows-1 periods from settlement; principal with the last.
  const price = (y) => {
    const d = 1 / (1 + y / freq);
    const annuity = Math.abs(1 - d) < 1e-12 ? nFlows : (1 - Math.pow(d, nFlows)) / (1 - d);
    return Math.pow(d, w) * (c * annuity + 100 * Math.pow(d, nFlows - 1)) - accrued;
  };
  return { price, accrued };
}

// CME conversion factor for Treasury futures (6% notional coupon).
// Remaining term is measured from the first day of the delivery month and
// rounded down to whole quarters (`roundMonths` = 3, as for TY / US / UB)
// or whole months (`roundMonths` = 1, as for TU / Z3N / FV).
export function conversionFactor(coupon, maturity, firstDeliveryDay, roundMonths = 3) {
  let months =
    (maturity.getUTCFullYear() - firstDeliveryDay.getUTCFullYear()) * 12 +
    (maturity.getUTCMonth() - firstDeliveryDay.getUTCMonth());
  if (maturity.getUTCDate() < firstDeliveryDay.getUTCDate()) months -= 1;
  months -= months % roundMonths;
  const n = Math.floor(months / 12);
  const z = months % 12;
  const v = z < 7 ? z : roundMonths === 3 ? 3 : z - 6;
  const a = 1 / Math.pow(1.03, v / 6);
  const b = (coupon / 2) * (6 - v) / 6;
  const cc = z < 7 ? 1 / Math.pow(1.03, 2 * n) : 1 / Math.pow(1.03, 2 * n + 1);
  const d = (coupon / 0.06) * (1 - cc);
  return Math.round((a * (coupon / 2 + cc + d) - b) * 10000) / 10000;
}

// Parse "name, coupon %, maturity, yield %, beta[, conversion factor]" lines.
export function parseBasket(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [name, cpn, mat, yld, beta, cf] = l.split(",").map((s) => s.trim());
      return {
        name,
        coupon: Number(cpn) / 100,
        maturity: parseDate(mat),
        y0: Number(yld) / 100,
        beta: Number(beta),
        cf: cf ? Number(cf) : null,
      };
    })
    .filter((b) => b.name && isFinite(b.coupon) && isFinite(b.y0) && isFinite(b.beta));
}

// Seeded standard normals (mulberry32 + Box-Muller) so every run, and every
// bumped run, uses the same scenarios.
export function normals(n, seed = 1) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = 1 - rand();
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    out[i] = r * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  return out;
}

// Eurex-style conversion factor: clean price per 1 face at the notional coupon
// yield on the delivery date. Used only when a bond has no published factor.
export function eurexConversionFactor(coupon, maturity, deliveryDate, freq, notional = 0.06) {
  return Math.round(makeBond(coupon, maturity, deliveryDate, freq).price(notional) * 1e4) / 1e6;
}

// Build the priced basket for a given contract setup. Bonds with a `cf` keep it;
// otherwise the CME formula (cfMethod "cme") or the Eurex definition is used.
export function setup({ basket, analysisDate, deliveryDate, firstDeliveryDay, roundMonths, freq = 2, cfMethod = "cme", notional = 0.06 }) {
  const T = Math.max((deliveryDate - analysisDate) / DAY / 365.25, 0);
  const bonds = basket.map((b) => {
    const { price } = makeBond(b.coupon, b.maturity, deliveryDate, freq);
    const cf = b.cf ?? (cfMethod === "cme"
      ? conversionFactor(b.coupon, b.maturity, firstDeliveryDay, roundMonths)
      : eurexConversionFactor(b.coupon, b.maturity, deliveryDate, freq, notional));
    const p0 = price(b.y0);
    const dv01 = (price(b.y0 - 0.0001) - price(b.y0 + 0.0001)) / 2;
    return { ...b, price, cf, p0, f0: p0 / cf, dv01 };
  });
  const ctd0 = bonds.reduce((best, b, i) => (b.f0 < bonds[best].f0 ? i : best), 0);
  return { bonds, T, ctd0 };
}

// Run the Monte Carlo for a parallel shift `shift` (decimal) in today's generic yield.
// drift and vol are annualised, in decimal yield units.
export function simulate(model, W, { drift, vol, shift = 0, keepScenarios = false }) {
  const { bonds, T } = model;
  const I = bonds.length;
  const N = W.length;
  const ctdCount = new Float64Array(I);
  const basisSum = new Float64Array(I);
  const px = new Float64Array(I);
  let futSum = 0;
  const scenarios = keepScenarios ? new Array(N) : null;
  const mu = drift * T;
  const sd = vol * Math.sqrt(T);
  for (let n = 0; n < N; n++) {
    const dy = shift + mu + sd * W[n];
    let ctd = 0;
    let fmin = Infinity;
    for (let i = 0; i < I; i++) {
      const b = bonds[i];
      px[i] = b.price(b.y0 + b.beta * dy);
      const f = px[i] / b.cf;
      if (f < fmin) {
        fmin = f;
        ctd = i;
      }
    }
    ctdCount[ctd]++;
    futSum += fmin;
    for (let i = 0; i < I; i++) basisSum[i] += px[i] - fmin * bonds[i].cf;
    if (keepScenarios) scenarios[n] = { dy: (dy - shift) * 10000, ctd: bonds[ctd].name };
  }
  return {
    prob: Array.from(ctdCount, (c) => c / N),
    fvBasis: Array.from(basisSum, (s) => s / N),
    futures: futSum / N,
    scenarios,
  };
}

// Option-adjusted DV01 of the futures: change in expected futures price at delivery
// for a 1bp move in today's generic yield (common random numbers, central difference).
export function optionAdjustedDV01(model, W, params, shift = 0) {
  const h = 0.0001;
  const up = simulate(model, W, { ...params, shift: shift + h }).futures;
  const dn = simulate(model, W, { ...params, shift: shift - h }).futures;
  return (dn - up) / 2;
}

// CTD probabilities and DV01s across a grid of shifts in today's generic yield.
export function sweep(model, W, params, shiftsBp) {
  return shiftsBp.map((s) => {
    const shift = s / 10000;
    const run = simulate(model, W, { ...params, shift });
    const oaDV01 = optionAdjustedDV01(model, W, params, shift);
    const fwd = model.bonds.map((b) => b.price(b.y0 + b.beta * shift) / b.cf);
    const ctd = fwd.indexOf(Math.min(...fwd));
    const c = model.bonds[ctd];
    const y = c.y0 + c.beta * shift;
    const ctdDV01 = (c.beta * (c.price(y - 0.0001) - c.price(y + 0.0001))) / 2 / c.cf;
    return { shift: s, prob: run.prob, oaDV01, ctdDV01 };
  });
}

// Price in points -> "points-32nds" string, e.g. 0.53125 -> "0-17".
export function to32nds(x) {
  const sign = x < 0 ? "-" : "";
  const ticks = Math.abs(x) * 32;
  const whole = Math.floor(ticks / 32);
  const rem = ticks - whole * 32;
  return `${sign}${whole}-${rem.toFixed(1).padStart(4, "0")}`;
}

// Yield (decimal) at which a bond's clean-price function returns `target`, by bisection.
export function yieldFromPrice(price, target, lo = -0.05, hi = 0.25) {
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (price(mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
