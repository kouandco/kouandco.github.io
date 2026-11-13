// Rates maths for the risk pages: Eurex Clearing curves, a project-finance debt profile, amortising
// swap / cap / floor / collar pricing (Bachelier, normal vol) and a one-factor rate simulation.

import { loadJSON } from "../common.js";
import { Phi, phi } from "../bond.js";

export const DAY = 864e5;
export const parse = (s) => new Date(`${s}T00:00:00Z`);
export const iso = (d) => d.toISOString().slice(0, 10);
export const yrs = (a, b) => (b - a) / DAY / 365.25;
export const addDays = (d, n) => new Date(d.getTime() + n * DAY);
export function addMonths(d, n) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}
export function addBusinessDays(d, n) {
  let x = d;
  while (n > 0) { x = addDays(x, 1); if (x.getUTCDay() % 6) n--; }
  return x;
}

// Index per currency: projection and discount curves, the day basis of the floating rate, whether it is
// a compounded overnight rate (fixes over the period) or a term rate (fixes at the start), and a default
// flat normal volatility (bp a year) for caps and floors. No free source publishes cap vols: edit them.
export const INDICES = {
  GBP: { ccy: "GBP", sym: "£", label: "SONIA (compounded)", proj: "GBP.SONIA.1D", disc: "GBP.SONIA.1D", dc: 365, rfr: true, vol: 90, freq: 3 },
  EUR: { ccy: "EUR", sym: "€", label: "6M Euribor", proj: "EUR.EURIBOR.6M", disc: "EUR.ESTR.1D", dc: 360, rfr: false, vol: 80, freq: 6 },
  USD: { ccy: "USD", sym: "$", label: "SOFR (compounded)", proj: "USD.SOFR.1D", disc: "USD.SOFR.1D", dc: 360, rfr: true, vol: 95, freq: 3 },
};

function baseCurve(asOf, dfs) {
  const days = Object.keys(dfs).map(Number).sort((a, b) => a - b);
  const logs = days.map((d) => Math.log(dfs[d]));
  if (days[0] !== 0) { days.unshift(0); logs.unshift(0); }
  const last = days.length - 1;
  return (date) => {
    const x = (date - asOf) / DAY;
    if (x <= 0) return 1;
    if (x >= days[last]) return Math.exp((logs[last] * x) / days[last]);
    let lo = 0, hi = last;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (days[mid] <= x) lo = mid; else hi = mid; }
    return Math.exp(logs[lo] + ((x - days[lo]) / (days[hi] - days[lo])) * (logs[hi] - logs[lo]));
  };
}

export async function loadMarket() {
  const data = await loadJSON("../data/curves.json");
  const asOf = parse(data.asOf);
  const curves = Object.fromEntries(Object.entries(data.curves).map(([k, v]) => [k, baseCurve(asOf, v)]));
  return { asOf, asOfIso: data.asOf, spot: addBusinessDays(asOf, 2), curves };
}

// Projection and discount curves for a currency, moved in parallel by shiftBp (continuously compounded).
export function curveFor(mkt, ccy, shiftBp = 0) {
  const idx = INDICES[ccy];
  const sh = (f) => (shiftBp ? (d) => f(d) * Math.exp((-shiftBp / 1e4) * Math.max(0, yrs(mkt.asOf, d))) : f);
  return { idx, asOf: mkt.asOf, proj: sh(mkt.curves[idx.proj]), disc: sh(mkt.curves[idx.disc]) };
}

// Forward rate, discount factor and option expiry of each period on curve c.
export function onCurve(periods, c) {
  return periods.map((q) => {
    const tau = (q.e - q.s) / DAY / c.idx.dc;
    const fwd = (c.proj(q.s) / c.proj(q.e) - 1) / tau;
    const tS = yrs(c.asOf, q.s), tE = yrs(c.asOf, q.e);
    // Compounded overnight rates fix over the whole period: the variance to the end of the accrual is
    // σ²(tS + (tE − tS)/3) (Lyashenko–Mercurio); a term rate fixes at the start.
    let T = Math.max(tS, 0);
    if (c.idx.rfr) T = tS >= 0 ? tS + (tE - tS) / 3 : tE > 0 ? tE ** 3 / (3 * (tE - tS) ** 2) : 0;
    return { ...q, tau, fwd, df: c.disc(q.e), tS, tE, T };
  });
}

// Par rate of a vanilla spot-starting swap (landing page): fixed and float legs with their own frequency.
export function parSwap(c, years, fixM = 12, fltM = 12, fixDc = c.idx.dc) {
  const start = addBusinessDays(c.asOf, 2), d0 = c.disc(start);
  let ann = 0, flt = 0;
  for (let k = 1; k <= (years * 12) / fixM; k++) {
    const s = addMonths(start, fixM * (k - 1)), e = addMonths(start, fixM * k);
    ann += (fixDc === "30/360" ? fixM / 12 : (e - s) / DAY / fixDc) * c.disc(e) / d0;
  }
  for (let k = 1; k <= (years * 12) / fltM; k++) {
    const s = addMonths(start, fltM * (k - 1)), e = addMonths(start, fltM * k);
    flt += (c.proj(s) / c.proj(e) - 1) * c.disc(e) / d0;   // τ·F = DF_proj(s)/DF_proj(e) − 1
  }
  return flt / ann;
}

// ---------------------------------------------------------------- debt profile

// p: {notional (mm), start (iso), constrMonths, tenorYears (repayment), freq (months), amort
// ("bullet" | "linear" | "annuity" | "sculpted"), balloon (% of notional left at maturity), margin (bp),
// cfads (mm a year in the first year of operations), growth (% a year)}.
// Returns periods with the balance outstanding over each, principal repaid at its end and CFADS.
export function buildDebt(p, c) {
  const N = p.notional * 1e6, f = p.freq;
  const start = parse(p.start);
  const nC = Math.max(0, Math.round(p.constrMonths / f));
  const nR = Math.max(1, Math.round((p.tenorYears * 12) / f));
  const raw = [];
  for (let k = 0; k < nC + nR; k++) raw.push({ s: addMonths(start, f * k), e: addMonths(start, f * (k + 1)), k });
  const per = onCurve(raw, c);
  const rep = per.slice(nC);
  // Flat rate used to size annuity / sculpted repayments: par rate over the repayment period plus margin.
  let a = 0, b = 0;
  for (const q of rep) { a += q.tau * q.df * q.fwd; b += q.tau * q.df; }
  const flat = a / b + p.margin / 1e4;
  const opsStart = rep[0].s;
  const cfadsOf = (q, cf) => cf * 1e6 * (f / 12) * (1 + (p.growth ?? 0) / 100) ** Math.floor(yrs(opsStart, q.s) + 1e-9);
  const target = (N * (p.balloon ?? 0)) / 100;

  // Principal repaid each period under a rule (q, B, interest) -> amount; the last period repays the rest.
  const run = (rule) => {
    let B = N;
    return rep.map((q, j) => {
      const P = j === nR - 1 ? B : Math.min(B, Math.max(0, rule(q, B, B * flat * q.tau)));
      const row = { out: B, prin: P };
      B -= P;
      return row;
    });
  };
  const beforeLast = (rule) => { const s = run(rule); return s[nR - 1].out; };
  // Bisection on the rule's parameter so the balance left for the final payment equals the balloon.
  // `rising`: the balance left rises with the parameter.
  const solve = (make, lo, hi, rising) => {
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      if ((beforeLast(make(mid)) > target) === rising) hi = mid; else lo = mid;
    }
    return make((lo + hi) / 2);
  };

  let rule;
  if (p.amort === "bullet") rule = () => 0;
  else if (p.amort === "linear") rule = () => (N - target) / nR;
  else if (p.amort === "annuity") rule = solve((A) => (q, B, i) => A - i, 0, N, false);   // level debt service A
  else rule = solve((D) => (q, B, i) => cfadsOf(q, p.cfads ?? 0) / D - i, 0.2, 20, true);  // sculpted to DSCR D

  const sched = run(rule);
  per.forEach((q, k) => {
    if (k < nC) { q.out = N * (k + 1) / nC; q.prin = 0; q.ops = false; q.cfads = 0; }
    else {
      const r = sched[k - nC];
      q.out = r.out; q.prin = r.prin; q.ops = true; q.cfads = cfadsOf(q, p.cfads ?? 0);
      // Debt service tested by the DSCR excludes a bullet or balloon, which is refinanced, not paid from CFADS.
      q.dsPrin = k === per.length - 1 ? (p.amort === "bullet" ? 0 : Math.max(0, r.prin - target)) : r.prin;
    }
  });
  const wal = per.reduce((s, q) => s + q.prin * q.tE, 0) / N;
  return { per, N, nC, nR, flat, wal, opsStart };
}

// Level annual debt service of the profile (for a sensible default CFADS).
export function levelDebtService(debt) {
  const ops = debt.per.filter((q) => q.ops);
  const ds = ops.reduce((s, q) => s + q.prin + q.out * debt.flat * q.tau, 0);
  return ds / Math.max(1e-9, yrs(ops[0].s, ops[ops.length - 1].e));
}

// ---------------------------------------------------------------- pricing (per unit of rate, decimals)

export function bachelier(F, K, vol, T, type) {
  const s = vol * Math.sqrt(Math.max(T, 0));
  if (s < 1e-12) return Math.max(type === "call" ? F - K : K - F, 0);
  const d = (F - K) / s;
  return type === "call" ? (F - K) * Phi(d) + s * phi(d) : (K - F) * Phi(-d) + s * phi(d);
}

// Fair fixed rate and annuity (Σ notional · τ · DF) of an amortising swap with notionals n[i].
export function swapFair(per, n) {
  let a = 0, b = 0;
  per.forEach((q, i) => { const w = n[i] * q.tau * q.df; a += w * q.fwd; b += w; });
  return { rate: b ? a / b : NaN, annuity: b };
}
export const annuity = (per, n) => per.reduce((s, q, i) => s + n[i] * q.tau * q.df, 0);

// Premium (currency) of a cap ("call") or floor ("put") strip on notionals n[i], strike K, normal vol.
export function optionPV(per, n, K, vol, type) {
  return per.reduce((s, q, i) => s + (n[i] ? n[i] * q.tau * q.df * bachelier(q.fwd, K, vol, q.T, type) : 0), 0);
}

// Floor strike that makes a collar cost nothing upfront for cap strike Kc.
export function zeroCostFloor(per, n, Kc, vol) {
  const cap = optionPV(per, n, Kc, vol, "call");
  let lo = -0.05, hi = Kc;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (optionPV(per, n, mid, vol, "put") < cap) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------- simulation

export function rng(seed = 7) {   // mulberry32 + Box–Muller: repeatable normal draws
  let a = seed >>> 0, spare = null;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    if (spare != null) { const s = spare; spare = null; return s; }
    let x, y, r;
    do { x = 2 * u() - 1; y = 2 * u() - 1; r = x * x + y * y; } while (!r || r >= 1);
    const m = Math.sqrt((-2 * Math.log(r)) / r);
    spare = y * m;
    return x * m;
  };
}

// Paths of the floating rate fixed in each period: r_i = F_i + σ·W(T_i), one Brownian motion per path
// (a one-factor normal model centred on the forward curve, the model the cap prices come from).
export function simulateRates(per, vol, nPaths, seed = 11) {
  const n = per.length, R = new Float64Array(nPaths * n), z = rng(seed);
  for (let p = 0; p < nPaths; p++) {
    let W = 0, t = 0;
    for (let i = 0; i < n; i++) {
      const dt = Math.max(per[i].T - t, 0);
      W += Math.sqrt(dt) * z();
      t = Math.max(t, per[i].T);
      R[p * n + i] = per[i].fwd + vol * W;
    }
  }
  return R;
}

// Cost of debt on every path for a hedge mix. h: {sw, cap, col} notionals per period, plus strikes and
// running costs (decimals). Returns the PV-weighted all-in rate per path, the lowest DSCR per path and,
// if keepPeriods, the all-in rate of every period on every path.
export function runStrategy(debt, R, nPaths, h, margin, keepPeriods = false) {
  const per = debt.per, n = per.length;
  const allIn = new Float64Array(nPaths), minD = new Float64Array(nPaths);
  const byPeriod = keepPeriods ? new Float64Array(nPaths * n) : null;
  for (let p = 0; p < nPaths; p++) {
    let acc = 0, w = 0, md = Infinity;
    for (let i = 0; i < n; i++) {
      const q = per[i], O = q.out, r = R[p * n + i];
      const sw = h.sw?.[i] ?? 0, cp = h.cap?.[i] ?? 0, cl = h.col?.[i] ?? 0;
      const idx = sw * (h.swK + h.swCs) + cp * (Math.min(r, h.capK) + h.capRun)
        + cl * (Math.min(Math.max(r, h.colKf), h.colKc) + h.colCs) + (O - sw - cp - cl) * r;
      const rate = O ? idx / O + margin : 0;
      if (byPeriod) byPeriod[p * n + i] = rate;
      const ww = O * q.tau * q.df;
      acc += ww * rate; w += ww;
      if (q.ops) {
        const ds = O * rate * q.tau + q.dsPrin;
        if (ds > 0) md = Math.min(md, q.cfads / ds);
      }
    }
    allIn[p] = acc / w;
    minD[p] = md;
  }
  return { allIn, minD, byPeriod };
}

export function quantile(arr, q) {
  const a = Float64Array.from(arr).sort();
  const x = (a.length - 1) * q, lo = Math.floor(x), hi = Math.ceil(x);
  return a[lo] + (a[hi] - a[lo]) * (x - lo);
}
export const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
export const stdev = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
