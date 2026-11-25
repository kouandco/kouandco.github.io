// Trade templates shared by BLOT (adds the legs to the portfolio) and TEST (creates a backtest trade): a main
// instrument plus DV01 hedges, with the trade level's weights (bp):
//   basis      bond − futures (CTD yield implied by the futures), single or barbell
//   curve      bond vs bond (spread), single or barbell (fly)
//   asw        bond − swap to the bond's maturity
//   invoice    swap from delivery to the CTD's maturity − futures
// Barbell weights split the main leg's DV01 between the two hedges linearly by maturity, so the hedge sits at the
// main leg's point on the curve. Hedges are sized by DV01 (qtyMode "dv01"): re-solved at the start date on TEST.

import { MARKETS, el, fmt } from "./common.js";
import { ASW_INDEX, SWAP_INDEX, legNow } from "./positions.js";

export const TRADE_TYPES = [
  { code: "basis1", label: "Bond-futures basis · single hedge", main: "bond", hedge: "fut", n: 1 },
  { code: "basis2", label: "Bond-futures basis · barbell hedge", main: "bond", hedge: "fut", n: 2 },
  { code: "curve1", label: "Bond curve · hedged by a bond", main: "bond", hedge: "bond", n: 1 },
  { code: "curve2", label: "Bond curve · barbell (fly)", main: "bond", hedge: "bond", n: 2 },
  { code: "asw", label: "ASW · bond hedged by IRS", main: "bond", hedge: "irs", n: 1 },
  { code: "invoice", label: "Invoice spread · futures hedged by IRS", main: "fut", hedge: "irs", n: 1 },
];

const SIDE_LABELS = {
  basis1: ["Buy basis (long bond, short futures)", "Sell basis (short bond, long futures)"],
  basis2: ["Buy basis (long bond, short futures)", "Sell basis (short bond, long futures)"],
  curve1: ["Buy bond, sell hedge bond", "Sell bond, buy hedge bond"],
  curve2: ["Buy body, sell wings", "Sell body, buy wings"],
  asw: ["Buy bond, pay fixed", "Sell bond, receive fixed"],
  invoice: ["Buy futures, pay fixed", "Sell futures, receive fixed"],
};

// Split of a maturity t between two hedge maturities (t1 < t2): linear inside, all to the nearer one outside.
export function barbellWeight(t, t1, t2) {
  if (t2 <= t1) return 0.5;
  return Math.min(Math.max((t2 - t) / (t2 - t1), 0), 1);
}

function bondsOf(U, market) { return [...U.bonds.values()].filter((b) => b.market === market).sort((a, b) => a.t - b.t); }
const nearestBond = (U, market, t, not = []) => bondsOf(U, market).filter((b) => !not.includes(b.id)).reduce((a, b) => (!a || Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a), null);
// Futures a bond in `market` can be hedged with (the dropdown): same currency, sorted by CTD maturity.
function futsFor(U, market) {
  const ccy = U.markets[market].currency;
  return Object.values(U.futs).filter((f) => f.ccy === ccy).sort((a, b) => a.t - b.t || (b.market === market) - (a.market === market));
}
// Default hedge contracts per market (as on FIHG): the market's own contracts; OATs barbell with Bobl / OAT / Buxl.
const FAMILY = { UST: ["TU", "FV", "TY", "UXY", "US", "WN"], DE: ["DU", "OE", "RX", "UB"], FR: ["OE", "OAT", "UB"], IT: ["BTS", "IK"] };
const SINGLE = { UST: FAMILY.UST, DE: FAMILY.DE, FR: ["OAT"], IT: FAMILY.IT };
const family = (U, market, list) => list[market].map((c) => U.futs[c]).filter(Boolean).sort((a, b) => a.t - b.t);

// Default hedges for a spec: {type, market, main}.
export function defaultHedges(U, spec) {
  const T = TRADE_TYPES.find((x) => x.code === spec.type);
  const main = T.main === "bond" ? U.bonds.get(spec.main) : U.futs[spec.main];
  const t = main.t;
  if (T.hedge === "fut") {
    const fs = family(U, spec.market, T.n === 1 ? SINGLE : FAMILY);
    if (T.n === 1) return [fs.reduce((a, f) => (Math.abs(f.t - t) < Math.abs(a.t - t) ? f : a), fs[0]).code];
    if (fs.length < 2) return fs.map((f) => f.code);
    // The pair whose CTDs bracket the bond; the shortest or longest two if it lies outside them.
    let i = fs.findIndex((f) => f.t >= t);
    if (i === -1) i = fs.length - 1;
    else if (i === 0) i = 1;
    return [fs[i - 1].code, fs[i].code];
  }
  if (T.hedge === "bond") {
    if (T.n === 1) return [nearestBond(U, spec.market, t > 5 ? 2 : 10, [main.id]).id];
    const nodes = U.markets[spec.market].nodes.map((n) => n.t);
    const lo = [...nodes].reverse().find((n) => n < t - 0.5) ?? nodes[0];
    const hi = nodes.find((n) => n > t + 0.5) ?? nodes[nodes.length - 1];
    return [nearestBond(U, spec.market, lo, [main.id]).id, nearestBond(U, spec.market, hi, [main.id]).id];
  }
  return [ASW_INDEX[spec.market]];
}

// The legs, level weights and a name for a spec:
// {type, market, main, side (+1/−1), size (notional mm, or lots for futures), sizeMode ("notional"|"dv01"), hedges, w1 (barbell, 0–1)}.
export function buildTrade(U, spec) {
  const T = TRADE_TYPES.find((x) => x.code === spec.type);
  const mainLeg = T.main === "bond"
    ? { type: "bond", market: spec.market, id: spec.main, side: spec.side, qtyMode: spec.sizeMode, qty: spec.sizeMode === "dv01" ? spec.size * 1e3 : spec.size * 1e6 }
    : { type: "fut", id: spec.main, side: spec.side, qtyMode: spec.sizeMode, qty: spec.sizeMode === "dv01" ? spec.size * 1e3 : spec.size };
  const now = legNow(U, mainLeg);
  const D = Math.abs(now.dv01);
  const main = T.main === "bond" ? U.bonds.get(spec.main) : U.futs[spec.main];
  let ws = [1];
  if (T.n === 2 && spec.hedges.length === 2) {
    const ts = spec.hedges.map((h) => (T.hedge === "fut" ? U.futs[h].t : U.bonds.get(h).t));
    const w1 = spec.w1 ?? barbellWeight(main.t, ts[0], ts[1]);
    ws = [w1, 1 - w1];
  }
  const hedgeLegs = spec.hedges.map((h, i) => {
    const qty = Math.round(ws[i] * D);
    if (T.hedge === "fut") return { type: "fut", id: h, side: -spec.side, qtyMode: "dv01", qty };
    if (T.hedge === "bond") return { type: "bond", market: spec.market, id: h, side: -spec.side, qtyMode: "dv01", qty };
    // IRS: to the bond's maturity (ASW), or from delivery to the CTD's maturity (invoice spread).
    return T.main === "bond"
      ? { type: "irs", id: h, maturity: main.maturity, side: -spec.side, qtyMode: "dv01", qty }
      : { type: "irs", id: h, start: U.contracts[main.code].delivery, maturity: main.ctd.maturity, side: -spec.side, qtyMode: "dv01", qty };
  }).filter((l, i) => ws[i] > 0);
  const legs = [mainLeg, ...hedgeLegs];
  // Level (bp): main − hedges for basis, curve and ASW; swap − futures for the invoice spread. Barbell hedges are
  // weighted by their DV01 share.
  const weights = spec.type === "invoice" ? [-1, 1] : [1, ...ws.filter((w) => w > 0).map((w) => -w)];
  const short = (l) => (l.type === "bond" ? U.bonds.get(l.id).name : l.type === "fut" ? l.id : l.id);
  const hedgeNames = hedgeLegs.map(short).join("/");
  const name = { basis1: "Basis", basis2: "Barbell basis", curve1: "Curve", curve2: "Fly", asw: "ASW", invoice: "Invoice spread" }[spec.type]
    + `: ${short(mainLeg)} vs ${hedgeNames}`;
  const risk = legs.map((l) => legNow(U, l));
  return { legs, weights, name, risk, residual: risk.reduce((a, r) => a + (r?.dv01 ?? 0), 0), ws };
}

// The builder panel. onCreate({legs, weights, name}) is called with the built trade.
// bondSize: default notional (mm) of a bond-led trade; lots: default size of a futures-led trade.
export function tradeBuilder(U, { onCreate, onCancel, createLabel = "Add", bondSize = 10, lots = 100 }) {
  const spec = { type: "basis2", market: "UST", side: 1, size: bondSize, sizeMode: "notional" };
  const box = el("div", { class: "panel", style: { margin: "8px 0", borderColor: "#5c4a14" } });
  const resetMain = () => {
    const T = TRADE_TYPES.find((x) => x.code === spec.type);
    if (T.main === "bond") spec.main = nearestBond(U, spec.market, spec.type.startsWith("curve2") ? 5 : 9).id;
    else spec.main = (family(U, spec.market, FAMILY).find((f) => f.market === spec.market) ?? futsFor(U, spec.market)[0]).code;
    if (T.main === "fut" && spec.sizeMode === "notional") spec.size = lots;
    if (T.main === "bond" && spec.sizeMode === "notional" && spec.size === lots) spec.size = bondSize;
    resetHedges();
  };
  const resetHedges = () => { spec.hedges = defaultHedges(U, spec); spec.w1 = null; };
  const sel = (key, options, after) => {
    const s = el("select", {}, options.map((o) => el("option", { value: o.v, selected: String(o.v) === String(spec[key]) ? true : null }, o.label)));
    s.addEventListener("change", () => { spec[key] = typeof options[0].v === "number" ? Number(s.value) : s.value; after?.(); render(); });
    return s;
  };
  const fld = (label, node) => el("label", { class: "row", style: { gap: "6px" } }, el("span", {}, label), node);
  resetMain();

  function render() {
    const T = TRADE_TYPES.find((x) => x.code === spec.type);
    const mainOpts = T.main === "bond"
      ? bondsOf(U, spec.market).map((b) => ({ v: b.id, label: `${b.name}  ${b.yield.toFixed(3)}%` }))
      : futsFor(U, spec.market).map((f) => ({ v: f.code, label: `${f.code} ${f.expiry} · CTD ${f.ctd.name}` }));
    const hedgeOpts = T.hedge === "fut" ? futsFor(U, spec.market).map((f) => ({ v: f.code, label: `${f.code} ${f.expiry} · CTD ${f.ctd.name}` }))
      : T.hedge === "bond" ? bondsOf(U, spec.market).filter((b) => b.id !== spec.main).map((b) => ({ v: b.id, label: `${b.name}  ${b.yield.toFixed(3)}%` }))
        : Object.keys(SWAP_INDEX).filter((k) => SWAP_INDEX[k].ccy === U.markets[spec.market].currency).map((k) => ({ v: k, label: k }));
    const hedgeSel = (i) => {
      const s = el("select", {}, hedgeOpts.map((o) => el("option", { value: o.v, selected: o.v === spec.hedges[i] ? true : null }, o.label)));
      s.addEventListener("change", () => { spec.hedges[i] = s.value; spec.w1 = null; render(); });
      return s;
    };
    let built, err = null;
    try { built = buildTrade(U, spec); } catch (e) { err = e.message; }
    const w1 = el("input", { type: "number", step: 5, min: 0, max: 100, value: built ? Math.round(built.ws[0] * 100) : "", style: { width: "5em" } });
    w1.addEventListener("change", () => { spec.w1 = Math.min(Math.max(+w1.value / 100, 0), 1); render(); });
    const size = el("input", { type: "number", step: 1, value: spec.size, style: { width: "7em" } });
    size.addEventListener("change", () => { spec.size = Math.abs(+size.value || 0); render(); });
    const sizeUnits = [{ v: "notional", label: T.main === "fut" ? "Lots" : "Notional (mm)" }, { v: "dv01", label: "DV01 (k)" }];
    const ccy = U.markets[spec.market].currency;

    box.replaceChildren(
      el("h2", {}, "New trade"),
      el("div", { class: "stack" },
        el("div", { class: "row" },
          fld("Type", sel("type", TRADE_TYPES.map((x) => ({ v: x.code, label: x.label })), resetMain)),
          fld("Market", sel("market", MARKETS.map((m) => ({ v: m.code, label: m.label })), resetMain)),
          fld("Direction", sel("side", SIDE_LABELS[spec.type].map((label, i) => ({ v: i ? -1 : 1, label }))))),
        el("div", { class: "row" },
          fld(T.main === "bond" ? (spec.type === "curve2" ? "Body" : "Bond") : "Futures", sel("main", mainOpts, resetHedges)),
          fld("Size", el("span", { class: "row", style: { gap: "4px" } }, size, sel("sizeMode", sizeUnits)))),
        el("div", { class: "row" },
          ...spec.hedges.map((h, i) => fld(T.n === 2 ? (T.hedge === "bond" ? `Wing ${i + 1}` : `Hedge ${i + 1}`) : T.hedge === "irs" ? "Swap index" : "Hedge", hedgeSel(i))),
          T.n === 2 ? fld("Hedge 1 share %", w1) : null,
          T.n === 2 ? el("span", { class: "muted small" }, "default: split by maturity") : null),
        err ? el("p", { class: "down" }, err) : el("div", { class: "table-wrap" }, el("table", {},
          el("thead", {}, el("tr", {}, ["Leg", "Instrument", "Side", "Size", "DV01", "Level weight"].map((h, i) => el("th", { class: i < 3 ? "l" : "" }, h)))),
          el("tbody", {}, built.legs.map((l, i) => {
            const r = built.risk[i];
            const side = l.type === "irs" ? (l.side > 0 ? "Receive fixed" : "Pay fixed") : l.side > 0 ? "Buy" : "Sell";
            return el("tr", {}, el("td", { class: "l" }, i ? `Hedge ${i}` : "Main"), el("td", { class: "l" }, r ? `${r.label}${l.type === "fut" ? ` (CTD ${U.futs[l.id].ctd.name})` : ""}` : l.id),
              el("td", { class: `l ${l.side > 0 ? "pos" : "neg"}` }, side),
              el("td", {}, r ? (l.type === "fut" ? `${fmt.int(r.lots)} lots` : fmt.ccy(r.ccy, r.notional)) : "–"),
              el("td", { class: r?.dv01 >= 0 ? "pos" : "neg" }, r ? fmt.ccy(r.ccy, r.dv01) : "–"), el("td", {}, fmt.n(built.weights[i], 2)));
          }),
          el("tr", {}, el("td", { class: "l", colspan: 4 }, el("b", {}, "Residual DV01 (after rounding)")), el("td", {}, el("b", {}, fmt.ccy(ccy, built.residual))), el("td", {}, ""))))),
        el("div", { class: "row" },
          el("button", { class: "btn on", disabled: err ? true : null, onclick: () => onCreate({ legs: built.legs, weights: built.weights, name: built.name }) }, createLabel),
          el("button", { class: "btn", onclick: () => onCancel?.() }, "Cancel"),
          built ? el("span", { class: "muted small" }, `${built.name}. Hedges are sized by DV01 and stay DV01-sized in the position list.`) : null)));
  }
  render();
  return box;
}
