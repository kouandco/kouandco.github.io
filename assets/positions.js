// Instruments shared by TEST (backtests) and BLOT (portfolio risk): bonds, asset swap packages, bond futures
// and interest rate swaps. Today's prices and DV01s, key-rate weights, and the daily history of each one's level.
//
// Sign convention for every position: side +1 gains when rates fall (long bond, long ASW package = long bond +
// pay fixed, long futures, receive fixed). DV01 = gain for a 1bp fall, so ΔV for a 1bp rise = −DV01.

import { MARKETS, loadJSON } from "./common.js";
import { addMonths, parseDate, pricer, yearsBetween, yieldFromPrice } from "./bond.js";
import { anchorMarket, contractSummary } from "./futures.js";

const DAY = 864e5;
export const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(d.getTime() + n * DAY);
export function addBusinessDays(d, n) {
  let x = d;
  while (n > 0) { x = addDays(x, 1); if (x.getUTCDay() % 6) n--; }
  return x;
}

export const TYPES = [
  { code: "bond", label: "Bond" }, { code: "asw", label: "ASW" }, { code: "fut", label: "Bond futures" }, { code: "irs", label: "IRS" },
];
export const SIDES = {
  bond: [{ v: 1, label: "Buy" }, { v: -1, label: "Sell" }],
  asw: [{ v: 1, label: "Buy ASW (long bond, pay fixed)" }, { v: -1, label: "Sell ASW (short bond, rec. fixed)" }],
  fut: [{ v: 1, label: "Buy" }, { v: -1, label: "Sell" }],
  irs: [{ v: 1, label: "Receive fixed" }, { v: -1, label: "Pay fixed" }],
};

// Key-rate buckets (years) and the triangular weights of a maturity t across them (sum to 1).
export const KR = [1, 2, 3, 5, 7, 10, 15, 20, 30];
export function krWeights(t) {
  const w = KR.map(() => 0);
  if (t <= KR[0]) { w[0] = 1; return w; }
  if (t >= KR[KR.length - 1]) { w[KR.length - 1] = 1; return w; }
  const i = KR.findIndex((k, j) => t >= k && t <= KR[j + 1]);
  const x = (t - KR[i]) / (KR[i + 1] - KR[i]);
  w[i] = 1 - x; w[i + 1] = x;
  return w;
}

// Swap indices: projection / discount curves (Eurex Clearing), fixed and floating legs. Labels match the
// archived par-rate history (data/gp/swaps.json).
export const SWAP_INDEX = {
  "USD SOFR": { ccy: "$", proj: "USD.SOFR.1D", disc: "USD.SOFR.1D", fixM: 12, fltM: 12, fixDc: 360 },
  "EUR €STR": { ccy: "€", proj: "EUR.ESTR.1D", disc: "EUR.ESTR.1D", fixM: 12, fltM: 12, fixDc: 360 },
  "EUR 6M": { ccy: "€", proj: "EUR.EURIBOR.6M", disc: "EUR.ESTR.1D", fixM: 12, fltM: 6, fixDc: "30/360" },
  "GBP SONIA": { ccy: "£", proj: "GBP.SONIA.1D", disc: "GBP.SONIA.1D", fixM: 12, fltM: 12, fixDc: 365 },
};
// The swap each market's asset swap spread is quoted against (as on BMNT).
export const ASW_INDEX = { UST: "USD SOFR", DE: "EUR 6M", FR: "EUR 6M", IT: "EUR 6M" };
export const IRS_TENORS = [1, 2, 3, 5, 7, 10, 15, 20, 30];

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

// Period ends rolled back from `end` (short first period), as [start, end] pairs.
function periods(start, end, months) {
  const ends = [];
  for (let k = 0; ; k++) { const d = addMonths(end, -months * k); if (d <= addDays(start, 7)) break; ends.unshift(d); }
  return ends.map((e, i) => [i ? ends[i - 1] : start, e]);
}

// Annuity (PV of 1 a year on the fixed leg, per unit notional) of a swap with fixed months m, day basis dc.
function annuityOf(disc, start, end, m, dc) {
  const d0 = disc(start);
  return periods(start, end, m).reduce((a, [s, e]) => a + (dc === "30/360" ? m / 12 : (e - s) / DAY / dc) * disc(e) / d0, 0);
}

// Annuity of a par swap from its par rate r (%) and years T, annual fixed: used where only the par rate
// history exists.
export function parAnnuity(r, T) {
  const y = r / 100;
  if (T <= 0) return 0;
  const n = Math.floor(T), f = T - n;
  let a = 0;
  for (let k = 1; k <= n; k++) a += 1 / (1 + y) ** (k + f);
  return a + f / (1 + y) ** f;
}

// ---------------------------------------------------------------- today's universe

export async function loadUniverse(prefix = "") {
  const [futures, curvesRaw, ...list] = await Promise.all([
    loadJSON(`${prefix}data/futures.json`), loadJSON(`${prefix}data/curves.json`),
    ...MARKETS.map((m) => loadJSON(`${prefix}data/markets/${m.code}.json`))]);
  const markets = Object.fromEntries(MARKETS.map((m, i) => [m.code, list[i]]));
  const bonds = new Map();
  for (const [m, mk] of Object.entries(markets)) {
    const settle = parseDate(mk.settle);
    for (const b of mk.bonds) {
      const p = pricer(b.coupon, parseDate(b.maturity), settle, mk.freq);
      bonds.set(b.id, { ...b, market: m, ccy: mk.currency, freq: mk.freq, t: yearsBetween(settle, parseDate(b.maturity)), accrued: p.accrued, dirty: b.price + p.accrued });
    }
  }
  const contracts = futures.contracts;
  const futs = {};
  for (const [code, c] of Object.entries(contracts)) {
    const s = contractSummary(code, c, anchorMarket(markets[c.market], contracts));
    if (!s) continue;
    futs[code] = { code, market: c.market, ccy: markets[c.market].currency, expiry: c.expiry, face: c.face, name: c.name ?? c.product,
      price: s.futures, priceSource: s.futuresSource, dv01: s.dv01, ctd: s.ctd, t: s.ctd.t, tick: c.market === "UST" ? 1 / 32 : 0.01 };
  }
  const asOf = parseDate(curvesRaw.asOf);
  const dfs = Object.fromEntries(Object.entries(curvesRaw.curves).map(([k, v]) => [k, baseCurve(asOf, v)]));
  const spot = addBusinessDays(asOf, 2);
  // Today's par rate (%), annuity and maturity of a spot-starting swap of `years` (or to a given end date).
  const swap = (key, years, end) => {
    const ix = SWAP_INDEX[key], disc = dfs[ix.disc], proj = dfs[ix.proj];
    const e = end ?? addMonths(spot, Math.round(12 * years));
    const start = e <= spot ? e : spot;
    const ann = annuityOf(disc, start, e, ix.fixM, ix.fixDc);
    const d0 = disc(start);
    const flt = periods(start, e, ix.fltM).reduce((a, [s, t]) => a + (proj(s) / proj(t) - 1) * disc(t) / d0, 0);
    return { rate: ann ? (100 * flt) / ann : NaN, annuity: ann * d0, end: e, t: yearsBetween(asOf, e) };
  };
  // Overnight (or 6M for Euribor) rate from the projection curve: the floating leg's current accrual.
  const floatRate = (key) => {
    const ix = SWAP_INDEX[key], proj = dfs[ix.proj], e = ix.fltM === 6 ? addMonths(spot, 6) : addDays(spot, 7);
    return (100 * (proj(spot) / proj(e) - 1)) / ((e - spot) / DAY / 360);
  };
  return { markets, bonds, futs, contracts, curvesAsOf: curvesRaw.asOf, swap, floatRate };
}

// ---------------------------------------------------------------- positions today

// Leg: {type, id (bond id / futures code / swap index), tenor (IRS years), fixed (IRS %), side, qtyMode ("notional"|"dv01"),
// qty, repo (%), haircut (%), repoSpread (bp, ASW)}. Returns the instrument and its risk today.
export function legNow(U, leg) {
  if (leg.type === "bond" || leg.type === "asw") {
    const b = U.bonds.get(leg.id);
    if (!b) return null;
    const unitDv01 = b.dv01;                        // per 100 nominal
    const notional = leg.qtyMode === "dv01" ? Math.round((Math.abs(leg.qty) / (unitDv01 / 100)) / 1e3) * 1e3 : Math.abs(leg.qty);
    const dv01 = (leg.side * notional * unitDv01) / 100;
    const mv = (leg.side * notional * b.dirty) / 100;
    const aswIdx = ASW_INDEX[b.market];
    const sw = leg.type === "asw" ? U.swap(aswIdx, null, parseDate(b.maturity)) : null;
    return {
      ccy: b.ccy, market: b.market, label: `${b.name}`, sub: b.id, maturity: b.maturity, t: b.t,
      level: leg.type === "bond" ? b.yield : b.asw, levelUnit: leg.type === "bond" ? "%" : "bp", price: b.price,
      unitDv01, unitLabel: "per 100", notional, dv01, mv,
      swapIndex: aswIdx, swapDv01: sw ? (-leg.side * notional * sw.annuity) / 1e4 : 0,   // payer swap on the package's long side
    };
  }
  if (leg.type === "fut") {
    const f = U.futs[leg.id];
    if (!f) return null;
    const lots = leg.qtyMode === "dv01" ? Math.round(Math.abs(leg.qty) / f.dv01) : Math.abs(leg.qty);
    return {
      ccy: f.ccy, market: f.market, label: `${f.code} ${f.expiry}`, sub: `CTD ${f.ctd.name}`, maturity: f.ctd.maturity, t: f.t,
      level: f.price, levelUnit: "", price: f.price, priceNote: f.priceSource, unitDv01: f.dv01, unitLabel: "per lot",
      notional: lots, lots, dv01: leg.side * lots * f.dv01, mv: 0, face: f.face, tick: f.tick, cf: f.ctd.cf,
    };
  }
  const ix = SWAP_INDEX[leg.id];
  const s = U.swap(leg.id, leg.tenor);
  const unit = s.annuity / 1e4;                    // per 1 notional
  const notional = leg.qtyMode === "dv01" ? Math.round(Math.abs(leg.qty) / unit / 1e5) * 1e5 : Math.abs(leg.qty);
  const fixed = leg.fixed ?? s.rate;
  return {
    ccy: ix.ccy, market: leg.id, label: `${leg.id} ${leg.tenor}Y`, sub: `fixed ${fixed.toFixed(4)}%`, maturity: iso(s.end), t: s.t,
    level: s.rate, levelUnit: "%", price: null, unitDv01: unit * 1e6, unitLabel: "per 1mm", notional,
    dv01: leg.side * notional * unit, mv: (leg.side * notional * (fixed - s.rate) * s.annuity) / 100, fixed,
  };
}

// ---------------------------------------------------------------- history

const gpCache = {};

// One-day spikes in a yield series (a print that jumps more than 8bp and fully reverses the next day) are bad
// closes in the source: they are dropped (set to null). Genuine moves persist and are kept.
const cleanCache = new Map();
export function clean(ys) {
  if (cleanCache.has(ys)) return cleanCache.get(ys);
  const out = ys.slice();
  for (let i = 1; i < ys.length - 1; i++) {
    const a = ys[i - 1], b = ys[i], c = ys[i + 1];
    if (a == null || b == null || c == null) continue;
    const up = b - a, down = c - b;
    if (Math.abs(up) > 0.08 && Math.abs(down) > 0.08 && up * down < 0 && Math.abs(c - a) < Math.min(Math.abs(up), Math.abs(down)) / 3) out[i] = null;
  }
  cleanCache.set(ys, out);
  return out;
}
const gp = (prefix, name) => (gpCache[name] ??= loadJSON(`${prefix}data/gp/${name}.json`));

// Daily history of a leg from `start` (iso): [{date, level, pnl (cumulative, currency), dv01}], plus notes.
// Bond: clean + accrued + coupons − financing at repo on (1 − haircut) of the dirty value.
// ASW: −Δspread × DV01 + (spread − repo spread) carry. Futures: Eurex VWAP (else the CTD's price / CF).
// IRS: (fixed − par at the residual maturity) × annuity + (fixed − floating) carry.
export async function legHistory(U, leg, start, prefix = "") {
  if (leg.type === "bond" || leg.type === "asw") return bondHistory(U, leg, start, prefix);
  if (leg.type === "fut") return futHistory(U, leg, start, prefix);
  return irsHistory(U, leg, start, prefix);
}

async function bondHistory(U, leg, start, prefix) {
  const b = U.bonds.get(leg.id);
  const h = await gp(prefix, b.market);
  const maturity = parseDate(b.maturity);
  const settleOf = (d) => addBusinessDays(parseDate(d), h.settleDays);
  if (leg.type === "asw") {
    const dates = h.aswDates, a = h.asw[leg.id] ?? [];
    const rows = dates.map((d, i) => ({ date: d, level: a[i] })).filter((r) => r.date >= start && r.level != null);
    if (!rows.length) return { rows: [], note: `ASW history starts ${dates[0]} (archived daily since then)` };
    const ys = h.yield[leg.id] ?? [];
    const yAt = (d) => { const i = h.dates.indexOf(d); return i >= 0 && ys[i] != null ? ys[i] : b.yield; };
    const p0 = pricer(b.coupon, maturity, settleOf(rows[0].date), b.freq);
    const unit = p0.dv01(yAt(rows[0].date));
    const notional = leg.qtyMode === "dv01" ? Math.round((Math.abs(leg.qty) / (unit / 100)) / 1e3) * 1e3 : Math.abs(leg.qty);
    const dv01 = (leg.side * notional * unit) / 100;
    const s0 = rows[0].level, d0 = parseDate(rows[0].date);
    const carry = (leg.side * notional * (s0 - (leg.repoSpread ?? 0))) / 1e4 / 360;
    const dirty0 = p0.price(yAt(rows[0].date)) + p0.accrued;
    return {
      notional, dv01, mv0: (leg.side * notional * dirty0) / 100,
      rows: rows.map((r) => ({ date: r.date, level: r.level, pnl: -dv01 * (r.level - s0) + carry * ((parseDate(r.date) - d0) / DAY), dv01 })),
    };
  }
  if (!h.yield[leg.id]) return { rows: [], note: "no yield history for this bond" };
  const ys = clean(h.yield[leg.id]);
  const idx = h.dates.map((d, i) => i).filter((i) => h.dates[i] >= start && ys[i] != null);
  if (!idx.length) return { rows: [], note: `history from ${h.dates[ys.findIndex((y) => y != null)]}` };
  const i0 = idx[0], set0 = settleOf(h.dates[i0]);
  const p0 = pricer(b.coupon, maturity, set0, b.freq);
  const unit = p0.dv01(ys[i0]);
  const notional = leg.qtyMode === "dv01" ? Math.round((Math.abs(leg.qty) / (unit / 100)) / 1e3) * 1e3 : Math.abs(leg.qty);
  const n = (leg.side * notional) / 100;
  const dirty0 = p0.price(ys[i0]) + p0.accrued;
  const fin = ((leg.repo ?? 0) / 100) * (1 - (leg.haircut ?? 0) / 100) * dirty0 * n / 360;   // per day, + = cost for a long
  const step = 12 / b.freq;
  const rows = idx.map((i) => {
    const set = settleOf(h.dates[i]);
    const p = pricer(b.coupon, maturity, set, b.freq);
    let cpn = 0;   // coupons paid after the first settlement up to this one
    for (let k = 0; ; k++) { const c = addMonths(maturity, -step * k); if (c <= set0) break; if (c <= set) cpn += b.coupon / b.freq; }
    const dirty = p.price(ys[i]) + p.accrued;
    return { date: h.dates[i], level: ys[i], pnl: n * (dirty - dirty0 + cpn) - fin * ((set - set0) / DAY), dv01: (n * p.dv01(ys[i])) };
  });
  return { notional, dv01: n * unit, mv0: n * dirty0, finPerDay: fin, rows };
}

async function futHistory(U, leg, start, prefix) {
  const f = U.futs[leg.id];
  const c = U.contracts[leg.id];
  const h = await gp(prefix, f.market);
  const ys = clean(h.yield[f.ctd.id] ?? []);
  const settleOf = (d) => addBusinessDays(parseDate(d), h.settleDays);
  const maturity = parseDate(f.ctd.maturity);
  // Synthetic price from the CTD's yield: P_ctd / CF, shifted so that it matches the latest market price
  // (the basis is held at that level). Eurex dates with EFP prints use the market VWAP instead.
  const synth = (i) => pricer(f.ctd.coupon, maturity, settleOf(h.dates[i]), U.markets[f.market].freq).price(ys[i]) / f.ctd.cf;
  const lastI = ys.length - 1 - [...ys].reverse().findIndex((y) => y != null);
  const offset = f.price - synth(lastI);
  let market = {};
  if (f.market !== "UST") {
    const e = await gp(prefix, "eurex");
    const s = e.series[`FUT|${leg.id}|${c.expiry}`] ?? [];
    market = Object.fromEntries(e.dates.map((d, i) => [d, s[i]]).filter(([, v]) => v != null));
  }
  // The CTD yield implied by the futures (clean price = F × CF, zero gross basis): lets a futures leg sit in a
  // yield spread with bonds or swaps.
  const implied = (i, F) => yieldFromPrice(pricer(f.ctd.coupon, maturity, settleOf(h.dates[i]), U.markets[f.market].freq).price, F * f.ctd.cf);
  const rows = h.dates.map((d, i) => ({ d, i })).filter(({ d, i }) => d >= start && ys[i] != null)
    .map(({ d, i }) => { const F = market[d] ?? synth(i) + offset; return { date: d, level: F, yieldLevel: implied(i, F), src: market[d] != null ? "market" : "model" }; });
  if (!rows.length) return { rows: [], note: "no CTD history" };
  const lots = leg.qtyMode === "dv01" ? Math.round(Math.abs(leg.qty) / f.dv01) : Math.abs(leg.qty);
  const k = (leg.side * lots * f.face) / 100;
  const F0 = rows[0].level;
  return {
    notional: lots, dv01: leg.side * lots * f.dv01, mv0: 0,
    note: f.market === "UST" ? "UST futures: modelled from the CTD's yield (basis held at today's level)" : "Eurex VWAP where EFP prints exist, else modelled from the CTD",
    rows: rows.map((r) => ({ ...r, pnl: k * (r.level - F0), dv01: leg.side * lots * f.dv01 })),
  };
}

async function irsHistory(U, leg, start, prefix) {
  const h = await gp(prefix, "swaps");
  const tenors = IRS_TENORS.filter((n) => h.series[`${leg.id} ${n}Y`]);
  const parAt = (i, T) => {
    const pts = tenors.map((n) => [n, h.series[`${leg.id} ${n}Y`][i]]).filter(([, v]) => v != null);
    if (!pts.length) return null;
    if (T <= pts[0][0]) return pts[0][1];
    if (T >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    const j = pts.findIndex(([n], k) => T >= n && T <= pts[k + 1][0]);
    const [a, ra] = pts[j], [b, rb] = pts[j + 1];
    return ra + ((rb - ra) * (T - a)) / (b - a);
  };
  const idx = h.dates.map((d, i) => i).filter((i) => h.dates[i] >= start && parAt(i, leg.tenor) != null);
  if (!idx.length) return { rows: [], note: `swap history starts ${h.dates[0]} (archived daily since then)` };
  const d0 = parseDate(h.dates[idx[0]]);
  const K = leg.fixed ?? parAt(idx[0], leg.tenor);
  const a0 = parAnnuity(K, leg.tenor);
  const notional = leg.qtyMode === "dv01" ? Math.round(Math.abs(leg.qty) / (a0 / 1e4) / 1e5) * 1e5 : Math.abs(leg.qty);
  const flt = U.floatRate(leg.id);
  return {
    notional, dv01: (leg.side * notional * a0) / 1e4, mv0: 0, fixed: K,
    note: "Floating leg accrues at today's fixing; MTM from archived par rates at the residual maturity",
    rows: idx.map((i) => {
      const el = (parseDate(h.dates[i]) - d0) / DAY;
      const T = leg.tenor - el / 365.25, par = parAt(i, T), A = parAnnuity(par, T);
      return { date: h.dates[i], level: par, dv01: (leg.side * notional * A) / 1e4,
        pnl: (leg.side * notional * ((K - par) * A + (K - flt) * (el / 360))) / 100 };
    }),
  };
}
