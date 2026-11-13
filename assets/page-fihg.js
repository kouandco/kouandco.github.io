import { $, MARKETS, el, fmt, frame, hashParam, loadJSON, segmented, setHash, showError } from "./common.js";
import { parseDate, pricer, yearsBetween } from "./bond.js";
import { FUTURES_BY_MARKET, anchorMarket, contractSummary, hedgeWeights } from "./futures.js";

frame("FIHG");
const app = $("#app");

// Futures families offered for a fly hedge (OATs: Bobl / OAT / Buxl).
const FLY_FAMILY = { UST: FUTURES_BY_MARKET.UST, DE: FUTURES_BY_MARKET.DE, FR: ["OE", "OAT", "UB"], IT: FUTURES_BY_MARKET.IT };
const MODES = [
  { code: "fut1", label: "Futures (single)" },
  { code: "fut2", label: "Futures (fly)" },
  { code: "bond1", label: "Bond (single)" },
  { code: "bond2", label: "Bond (fly)" },
];

try {
  const [futures, ...list] = await Promise.all([loadJSON("data/futures.json"), ...MARKETS.map((m) => loadJSON(`data/markets/${m.code}.json`))]);
  start(futures.contracts, Object.fromEntries(MARKETS.map((m, i) => [m.code, list[i]])));
} catch (err) {
  showError(app, err);
}

function start(contracts, markets) {
  const codes = MARKETS.map((m) => m.code);
  const currency = (m) => markets[m].currency;
  // Every bond with its risk at its market's settlement date.
  const bonds = new Map();
  for (const m of codes) {
    const mk = markets[m];
    const settle = parseDate(mk.settle);
    for (const b of mk.bonds) {
      const p = pricer(b.coupon, parseDate(b.maturity), settle, mk.freq);
      bonds.set(b.id, { ...b, market: m, t: yearsBetween(settle, parseDate(b.maturity)), accrued: p.accrued, dirty: b.price + p.accrued });
    }
  }
  const futs = {};
  for (const [code, c] of Object.entries(contracts)) {
    const s = contractSummary(code, c, anchorMarket(markets[c.market], contracts));
    if (s) futs[code] = { ...s, t: s.ctd.t, market: c.market };
  }
  const futLabel = (k) => `${k} ${contracts[k].expiry} · CTD ${futs[k].ctd.name}`;

  const state = {
    market: hashParam("m", "DE", codes),
    bond: hashParam("b", null),
    notional: 10_000_000,
    side: 1,
    mode: hashParam("h", "fut2", MODES.map((x) => x.code)),
    legs: null,     // [{kind, id}] chosen instruments
    w1: null,       // weight of leg 1 in a fly
  };
  if (!bonds.has(state.bond) || bonds.get(state.bond).market !== state.market) state.bond = defaultBond(state.market);

  function defaultBond(m) {
    const target = { UST: 10, DE: 8, FR: 10, IT: 10 }[m];
    return [...bonds.values()].filter((b) => b.market === m).sort((a, b) => Math.abs(a.t - target) - Math.abs(b.t - target))[0].id;
  }

  // Default hedge instruments for the current bond and mode.
  function defaultLegs() {
    const b = bonds.get(state.bond);
    if (state.mode.startsWith("fut")) {
      const family = (state.mode === "fut1" ? FUTURES_BY_MARKET[b.market] : FLY_FAMILY[b.market]).filter((k) => futs[k]);
      const legs = family.map((k) => ({ code: k, t: futs[k].t })).sort((x, y) => x.t - y.t);
      const w = hedgeWeights(b.t, legs);
      if (state.mode === "fut1") {
        const best = legs.reduce((a, l) => (Math.abs(l.t - b.t) < Math.abs(a.t - b.t) ? l : a), legs[0]);
        return [{ kind: "fut", id: best.code }];
      }
      let pair = legs.filter((l) => w[l.code] > 0).map((l) => l.code);
      if (pair.length < 2) {
        const i = legs.findIndex((l) => l.code === pair[0]);
        pair = i === 0 ? [legs[0].code, legs[1]?.code] : [legs[i - 1].code, legs[i].code];
      }
      return pair.filter(Boolean).map((k) => ({ kind: "fut", id: k }));
    }
    const peers = [...bonds.values()].filter((x) => x.market === b.market && x.id !== b.id);
    const nearest = (t) => peers.reduce((a, x) => (Math.abs(x.t - t) < Math.abs(a.t - t) ? x : a), peers[0]);
    if (state.mode === "bond1") return [{ kind: "bond", id: nearest(b.t).id }];
    const nodes = markets[b.market].nodes.map((n) => n.t);
    const lo = [...nodes].reverse().find((n) => n < b.t - 0.5) ?? nodes[0];
    const hi = nodes.find((n) => n > b.t + 0.5) ?? nodes[nodes.length - 1];
    return [{ kind: "bond", id: nearest(lo).id }, { kind: "bond", id: nearest(hi === lo ? nodes[nodes.length - 1] : hi).id }];
  }

  // Risk of a hedge instrument: DV01 per contract (futures) or per 100 nominal (bond), and its maturity.
  function instrument(leg) {
    if (leg.kind === "fut") {
      const f = futs[leg.id];
      return { label: futLabel(leg.id), dv01: f.dv01, t: f.t, unit: "lots", price: f.futures, priceNote: f.futuresSource, ccy: currency(f.market) };
    }
    const b = bonds.get(leg.id);
    return { label: `${b.name} (${b.id})`, dv01: b.dv01, t: b.t, unit: "nominal", price: b.price, priceNote: `yield ${b.yield.toFixed(3)}%`, ccy: currency(b.market) };
  }

  function defaultW1(legs) {
    if (legs.length < 2) return 1;
    const b = bonds.get(state.bond);
    const [a, c] = legs.map(instrument);
    if (c.t === a.t) return 0.5;
    return Math.min(Math.max((c.t - b.t) / (c.t - a.t), 0), 1);
  }

  // ---- layout
  const marketTabs = el("div");
  const positionHost = el("section", { class: "panel" });
  const hedgeHost = el("section", { class: "panel" });
  app.append(
    el("div", { class: "page-title" }, el("h1", {}, "Fixed Income Hedge"), el("span", { class: "muted" }, "DV01 hedge of a bond position with futures or bonds")),
    el("div", { style: { marginBottom: "8px" } }, marketTabs),
    el("div", { class: "grid hedge-layout" }, positionHost, hedgeHost),
    methodNote());

  function render() {
    setHash({ m: state.market, b: state.bond, h: state.mode });
    const b = bonds.get(state.bond);
    const mk = markets[b.market];
    const ccy = currency(b.market);
    const posDV01 = (b.dv01 / 100) * state.notional * state.side;
    const modDur = (b.dv01 / b.dirty) * 1e4;

    // Position panel
    const options = [...bonds.values()].filter((x) => x.market === state.market).sort((x, y) => x.t - y.t);
    const bondSel = el("select", { "aria-label": "Bond" }, options.map((x) =>
      el("option", { value: x.id, selected: x.id === state.bond }, `${x.name}  ${x.yield.toFixed(3)}%  ${x.id}`)));
    bondSel.addEventListener("change", () => { state.bond = bondSel.value; state.legs = null; render(); });
    const notional = el("input", { type: "number", step: "1", min: "0", value: +(state.notional / 1e6).toPrecision(12), style: { width: "8em" }, "aria-label": "Notional (mm)" });
    notional.addEventListener("change", () => { state.notional = Math.max(+notional.value || 0, 0) * 1e6; render(); });
    const side = segmented([{ code: "1", label: "Long" }, { code: "-1", label: "Short" }], String(state.side), (v) => { state.side = +v; render(); });
    positionHost.replaceChildren(
      el("h2", {}, "Position"),
      el("div", { class: "stack" },
        el("label", { class: "row" }, "Bond ", bondSel),
        el("div", { class: "row" }, el("label", {}, `Notional (${ccy}mm) `, notional), side),
        el("div", { class: "tiles" },
          tile("Price", b.price.toFixed(3), `accrued ${b.accrued.toFixed(3)} · settle ${mk.settle}`),
          tile("Yield", `${b.yield.toFixed(3)}%`, `as of ${mk.asOf}`),
          tile("Mod. duration", modDur.toFixed(2), `maturity ${b.maturity} (${b.t.toFixed(2)}y)`),
          tile("DV01 / 100", b.dv01.toFixed(4), "price change for 1bp"),
          tile("Position DV01", fmt.ccy(ccy, posDV01), "per bp, + = gains when yields fall"),
          tile("Market value", fmt.ccy(ccy, (b.dirty / 100) * state.notional * state.side), "dirty"))));

    // Hedge panel
    state.legs ??= defaultLegs();
    state.w1 ??= defaultW1(state.legs);
    const fly = state.legs.length === 2;
    const modeTabs = segmented(MODES, state.mode, (v) => { state.mode = v; state.legs = null; state.w1 = null; render(); });
    const pickers = state.legs.map((leg, i) => {
      let sel;
      if (leg.kind === "fut") {
        const eligible = Object.keys(futs).filter((k) => currency(futs[k].market) === ccy);
        sel = el("select", { "aria-label": `Hedge leg ${i + 1}` }, eligible.map((k) => el("option", { value: k, selected: k === leg.id }, futLabel(k))));
      } else {
        const eligible = [...bonds.values()].filter((x) => currency(x.market) === ccy && x.id !== b.id).sort((x, y) => x.market.localeCompare(y.market) || x.t - y.t);
        sel = el("select", { "aria-label": `Hedge leg ${i + 1}` }, eligible.map((x) => el("option", { value: x.id, selected: x.id === leg.id }, `${x.name}  ${x.yield.toFixed(3)}%`)));
      }
      sel.addEventListener("change", () => { state.legs[i] = { ...leg, id: sel.value }; state.w1 = defaultW1(state.legs); render(); });
      return el("label", { class: "row" }, `Leg ${i + 1} `, sel);
    });
    const w1 = el("input", { type: "number", step: "1", min: "0", max: "100", value: (100 * state.w1).toFixed(0), "aria-label": "Leg 1 weight" });
    w1.addEventListener("change", () => { state.w1 = Math.min(Math.max(+w1.value / 100, 0), 1); render(); });

    const weights = fly ? [state.w1, 1 - state.w1] : [1];
    let hedged = 0;
    const rows = state.legs.map((leg, i) => {
      const ins = instrument(leg);
      const risk = weights[i] * posDV01;
      // Quantity is signed: negative = sell. Its DV01 offsets the position's.
      let qty, qtyText, achieved;
      if (leg.kind === "fut") {
        const exact = -risk / ins.dv01;
        qty = Math.round(exact);
        achieved = qty * ins.dv01;
        qtyText = `${fmt.int(Math.abs(qty))} lots (${fmt.n(Math.abs(exact), 1)})`;
      } else {
        const exact = -risk / (ins.dv01 / 100);
        qty = Math.round(exact / 1000) * 1000;
        achieved = (qty * ins.dv01) / 100;
        qtyText = fmt.ccy(ccy, Math.abs(qty));
      }
      hedged += achieved;
      return el("tr", {},
        el("td", { class: "l" }, `${i + 1}`),
        el("td", { class: "l" }, ins.label),
        el("td", {}, `${(100 * weights[i]).toFixed(0)}%`),
        el("td", { class: qty < 0 ? "neg" : "pos" }, qty === 0 ? "–" : qty < 0 ? "SELL" : "BUY"),
        el("td", {}, qtyText),
        el("td", {}, fmt.int(risk)),
        el("td", {}, leg.kind === "fut" ? `${fmt.n(ins.dv01, 1)} / lot` : `${ins.dv01.toFixed(4)} / 100`),
        el("td", {}, `${ins.price.toFixed(3)} (${ins.priceNote})`));
    });
    const residual = posDV01 + hedged;
    hedgeHost.replaceChildren(
      el("h2", {}, "Hedge"),
      el("div", { class: "stack" },
        modeTabs,
        ...pickers,
        fly ? el("label", { class: "row" }, "Leg 1 weight % ", w1, el("span", { class: "muted" }, `leg 2 ${(100 * (1 - state.w1)).toFixed(0)}% · default splits by maturity`)) : "",
        el("div", { class: "table-wrap" }, el("table", {},
          el("thead", {}, el("tr", {}, ["Leg", "Instrument", "Weight", "Side", "Quantity", `Risk (${ccy}/bp)`, "DV01", "Price"]
            .map((h, i) => el("th", { class: i < 2 ? "l" : "" }, h)))),
          el("tbody", {}, rows))),
        el("div", { class: "tiles" },
          tile("Position DV01", fmt.ccy(ccy, posDV01), "per bp"),
          tile("Hedge DV01", fmt.ccy(ccy, hedged), "after rounding"),
          tile("Residual DV01", fmt.ccy(ccy, residual), `${fmt.n(Math.abs(residual / (posDV01 || 1)) * 100, 1)}% of position`),
          tile("Curve exposure", fly ? "fly" : "outright", fly ? "weights split risk across two points" : "all risk at one point"))));
  }

  function tile(k, v, n) {
    return el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v), el("div", { class: "n" }, n));
  }

  marketTabs.append(segmented(MARKETS, state.market, (m) => { state.market = m; state.bond = defaultBond(m); state.legs = null; state.w1 = null; render(); }));
  render();
}

function methodNote() {
  return el("details", { class: "method panel" }, el("summary", {}, "Method"),
    el("ul", { class: "small" },
      el("li", {}, "DV01: change in clean price per 100 nominal for a 1bp fall in yield (central difference), from the latest end-of-day yield. Position DV01 = DV01 / 100 × notional."),
      el("li", {}, "Futures DV01 per contract = CTD DV01 / conversion factor × contract size / 100, with the CTD the deliverable with the lowest forward price / CF. Lots are rounded to whole contracts; bond hedges to the nearest 1,000 nominal."),
      el("li", {}, "Fly: the risk is split between the two legs; by default linearly by maturity between the hedge instruments (futures: their CTDs), so the hedge matches the bond's position on the curve. Single: all risk to one instrument (default: the nearest futures CTD or the bond with the nearest maturity)."),
      el("li", {}, "Hedges are DV01-neutral (yield beta 1). Hedge instruments are limited to the position's currency; a Bund future can hedge an OAT or BTP position, but the spread risk remains.")));
}
