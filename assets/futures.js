// Bond futures: deliverable basket set-up, the parametric CTD model and hedge helpers.
//
// Model. At delivery each deliverable's yield is
//   Y_i(z) = fwd_i + drift(m_i)·T + beta_i · vol(m_i) · √T · z,   z ~ N(0, 1),
// with drift and vol read off the generic curve points at the bond's maturity m_i and fwd_i the
// forward yield implied by today's price and repo. The futures converges to the cheapest P/CF, so
// once the points on the z line where the cheapest bond changes are found exactly, each bond's CTD
// probability is a difference of normal CDFs and the fair futures price is the normal expectation
// of the lower envelope of P/CF (integrated numerically). No simulation is involved. Prices carry a
// convexity adjustment so that with zero drift each bond's expected price equals its forward price.

import { forwardPrice, linear, parseDate, Phi, phi, pricer, repoAt, yearsBetween, yieldFromPrice } from "./bond.js";

export const FUTURES_BY_MARKET = {
  UST: ["TU", "FV", "TY", "UXY", "US", "WN"],
  DE: ["DU", "OE", "RX", "UB"],
  FR: ["OAT"],
  IT: ["BTS", "IK"],
};

// Basis quoting: 32nds for Treasury futures, cents (0.01 points) for Eurex.
export const basisUnit = (market) => (market === "UST" ? { mult: 32, label: "/32" } : { mult: 100, label: "c" });

// Deliverables priced for delivery. `inputs` maps bond id -> {y, beta, cf} overrides; `repo` (%) finances
// every bond from settlement to delivery.
export function prepare(contract, market, { inputs = {}, repo } = {}) {
  const settle = parseDate(market.settle);
  const delivery = parseDate(contract.delivery);
  const T = Math.max(yearsBetween(settle, delivery), 0);
  const r = repo ?? repoAt(market.repo.points, T);
  const byId = new Map(market.bonds.map((b) => [b.id, b]));
  const bonds = contract.basket.filter((d) => byId.has(d.id)).map((d) => {
    const mb = byId.get(d.id);
    const o = inputs[d.id] ?? {};
    const bond = { coupon: d.coupon, maturity: parseDate(d.maturity), freq: market.freq };
    const spot = pricer(bond.coupon, bond.maturity, settle, bond.freq);
    const atDelivery = pricer(bond.coupon, bond.maturity, delivery, bond.freq);
    const y = o.y ?? mb.yield;
    const cf = o.cf ?? d.cf;
    const clean = spot.price(y);
    const fwdClean = forwardPrice(bond, clean, settle, delivery, r);
    return {
      id: d.id, name: mb.name, coupon: d.coupon, maturity: d.maturity, t: yearsBetween(settle, bond.maturity),
      y, beta: o.beta ?? mb.beta ?? 1, cf, clean, dv01: spot.dv01(y),
      fwdClean, fwdYield: yieldFromPrice(atDelivery.price, fwdClean), price: atDelivery.price,
      ratio0: fwdClean / cf, carry: clean - fwdClean,
    };
  });
  return { T, repo: r, settle, delivery, bonds };
}

// Set a bond's yield so that its forward P/CF equals `target`.
export function yieldForRatio(model, market, id, target) {
  const b = model.bonds.find((x) => x.id === id);
  const settle = model.settle;
  const bond = { coupon: b.coupon, maturity: parseDate(b.maturity), freq: market.freq };
  const spot = pricer(bond.coupon, bond.maturity, settle, bond.freq);
  const f = (y) => forwardPrice(bond, spot.price(y), settle, model.delivery, model.repo) / b.cf;
  return yieldFromPrice(f, target);
}

const Z_MAX = 5;
const STEP = 0.02;

// curve: {drift(t) bp/yr, vol(t) bp/yr}.
export function evaluate(model, curve) {
  const { bonds, T } = model;
  if (!bonds.length) return null;
  const sq = Math.sqrt(T);
  const mu = bonds.map((b) => (curve.drift(b.t) / 100) * T);
  const sd = bonds.map((b) => (b.beta * curve.vol(b.t) / 100) * sq);
  const n = Math.round((2 * Z_MAX) / STEP);
  const simpson = (f) => {
    let s = 0;
    for (let k = 0; k <= n; k++) {
      const z = -Z_MAX + k * STEP;
      s += (k === 0 || k === n ? 1 : k % 2 ? 4 : 2) * f(z) * phi(z);
    }
    return (s * STEP) / 3;
  };
  // Convexity: price is convex in yield, so centring yields on the forward yield would make the expected
  // price exceed the forward price. Subtract that difference so that, with zero drift, E[P] = forward price.
  const convexity = bonds.map((b, i) => simpson((z) => b.price(b.fwdYield + sd[i] * z)) - b.fwdClean);
  const ratio = (i, z) => (bonds[i].price(bonds[i].fwdYield + mu[i] + sd[i] * z) - convexity[i]) / bonds[i].cf;
  const cheapest = (z) => {
    let best = 0, v = Infinity;
    for (let i = 0; i < bonds.length; i++) {
      const r = ratio(i, z);
      if (r < v) { v = r; best = i; }
    }
    return [best, v];
  };
  // Lower envelope on a grid, then exact switch points between grid nodes by bisection.
  const zs = [], ctd = [], env = [];
  for (let k = 0; k <= n; k++) {
    const z = -Z_MAX + k * STEP;
    const [i, v] = cheapest(z);
    zs.push(z); ctd.push(i); env.push(v);
  }
  const switches = [];
  for (let k = 1; k <= n; k++) {
    if (ctd[k] === ctd[k - 1]) continue;
    const a = ctd[k - 1], b = ctd[k];
    let lo = zs[k - 1], hi = zs[k];
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (ratio(a, mid) <= ratio(b, mid)) lo = mid; else hi = mid;
    }
    switches.push({ z: (lo + hi) / 2, from: a, to: b });
  }
  const prob = new Array(bonds.length).fill(0);
  let left = -Infinity, current = ctd[0];
  for (const s of switches) {
    prob[current] += Phi(s.z) - Phi(left);
    left = s.z; current = s.to;
  }
  prob[current] += 1 - Phi(left);
  // Simpson's rule for E[min P/CF] (tails beyond ±5 sd are negligible).
  let fair = 0;
  for (let k = 0; k <= n; k++) fair += (k === 0 || k === n ? 1 : k % 2 ? 4 : 2) * env[k] * phi(zs[k]);
  fair *= STEP / 3;
  return {
    prob, fair, zs, env, ctd, switches, mu, sd, ratio,
    nbFair: bonds.map((b) => b.fwdClean - fair * b.cf),
  };
}

// Option-adjusted DV01 of the futures (price change for a 1bp parallel fall in spot yields).
export function oaDV01(contract, market, opts, curve) {
  const bump = (h) => {
    const inputs = {};
    const base = prepare(contract, market, opts);
    for (const b of base.bonds) inputs[b.id] = { ...(opts.inputs?.[b.id] ?? {}), y: b.y + h };
    return evaluate(prepare(contract, market, { ...opts, inputs }), curve).fair;
  };
  return (bump(-0.01) - bump(0.01)) / 2;
}

// Generic-curve dynamics from the curve points: drift and vol interpolated linearly in maturity.
export function curveDynamics(nodes) {
  const ts = nodes.map((n) => n.t);
  return { drift: linear(ts, nodes.map((n) => n.drift ?? 0)), vol: linear(ts, nodes.map((n) => n.vol)) };
}

// Today's CTD: lowest forward P/CF.
export const ctdIndex = (model) => model.bonds.reduce((best, b, i, all) => (b.ratio0 < all[best].ratio0 ? i : best), 0);

// Futures DV01 per contract from the CTD: CTD DV01 / CF × contract face / 100.
export const futuresDV01 = (ctd, face) => (ctd.dv01 / ctd.cf) * face / 100;

// Hedge split for a bond of maturity t (years) across futures legs sorted by CTD maturity:
// a bond between two CTDs is hedged by both, weighted linearly by maturity; a bond outside the
// range, or matching a CTD, by the nearest contract alone.
export function hedgeWeights(t, legs) {
  const w = Object.fromEntries(legs.map((l) => [l.code, 0]));
  if (!legs.length) return w;
  if (legs.length === 1 || t <= legs[0].t) { w[legs[0].code] = 1; return w; }
  const last = legs[legs.length - 1];
  if (t >= last.t) { w[last.code] = 1; return w; }
  for (let i = 0; i < legs.length - 1; i++) {
    const a = legs[i], b = legs[i + 1];
    if (t >= a.t && t <= b.t) {
      const x = (t - a.t) / (b.t - a.t);
      if (x < 0.02) w[a.code] = 1;
      else if (x > 0.98) w[b.code] = 1;
      else { w[a.code] = 1 - x; w[b.code] = x; }
      return w;
    }
  }
  return w;
}

// Market futures price on the date of the bond prices (daily VWAP of EFP futures legs), if any.
export function marketFutures(contract, market) {
  const price = contract.futures?.vwap?.[market.asOf];
  return price == null ? null : { price, date: market.asOf, lots: contract.futures.lots[market.asOf] };
}

// Front-contract summary used by the monitor and hedge pages: CTD, DV01 and net basis
// (market if a futures price exists, else the model's fair value).
export function contractSummary(code, contract, market, opts = {}) {
  const model = prepare(contract, market, opts);
  if (!model.bonds.length) return null;
  const curve = curveDynamics(market.nodes);
  const res = evaluate(model, curve);
  const i = ctdIndex(model);
  const ctd = model.bonds[i];
  const mkt = marketFutures(contract, market);
  const fut = mkt?.price ?? res.fair;
  return {
    code, contract, model, ctd, prob: res.prob[i],
    futures: fut, futuresSource: mkt ? "market" : "model",
    netBasis: ctd.fwdClean - fut * ctd.cf,
    fairNetBasis: res.nbFair[i],
    dv01: futuresDV01(ctd, contract.face),
  };
}
