import { $, COLORS, MARKETS, el, fmt, frame, heat, plot, showError } from "./common.js";
import { ASW_INDEX, IRS_TENORS, KR, SIDES, SWAP_INDEX, TYPES, krWeights, legNow, loadUniverse } from "./positions.js";

frame("BLOT");
const app = $("#app");
const KEY = "blotPortfolio";
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { return null; } };
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(book)); } catch { /* storage unavailable */ } };

let U, book;
const posBox = el("div"), tiles = el("div", { class: "tiles" });
const tables = { govt: el("div"), asw: el("div"), basis: el("div"), swap: el("div") };
const chart = el("div", { class: "plot" });

app.append(
  el("div", { class: "page-title" }, el("h1", {}, "Portfolio risk"),
    el("span", { class: "muted" }, "value change for a 1bp rise in one point, everything else unchanged · portfolio saved in this browser")),
  el("section", { class: "panel" }, el("h2", {}, "Positions"), posBox),
  el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "Totals"), tiles),
  el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "Government yield curve: ΔV for +1bp at each point"), tables.govt),
  el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "Swap curve: ΔV for +1bp in each par swap rate"), tables.swap),
  el("div", { class: "grid cols-2", style: { marginTop: "10px" } },
    el("section", { class: "panel" }, el("h2", {}, "Asset swap spread: ΔV for +1bp"), tables.asw),
    el("section", { class: "panel" }, el("h2", {}, "Bond futures gross basis: ΔV for +1 tick"), tables.basis)),
  el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "Rate risk by bucket"), chart),
  methodNote());

loadUniverse().then((u) => { U = u; book = load() ?? sample(); render(); }).catch((e) => showError(app, e));

function bondNear(market, t, needAsw) {
  return [...U.bonds.values()].filter((b) => b.market === market && (!needAsw || b.asw != null)).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0].id;
}
function defaultLeg(type, market = "DE") {
  if (type === "bond" || type === "asw") return { type, market, id: bondNear(market, 10, type === "asw"), side: 1, qtyMode: "notional", qty: 10e6 };
  if (type === "fut") return { type, id: Object.keys(U.futs).find((k) => U.futs[k].market === market) ?? Object.keys(U.futs)[0], side: 1, qtyMode: "notional", qty: 100 };
  return { type, id: "EUR €STR", tenor: 10, fixed: null, side: 1, qtyMode: "dv01", qty: 10000 };
}
// A small example book: Bund vs futures, a UST ASW, a SOFR payer and a €STR receiver.
function sample() {
  return [
    { ...defaultLeg("bond", "DE"), id: bondNear("DE", 9, false), qty: 50e6 },
    { ...defaultLeg("fut", "DE"), id: "RX", side: -1, qtyMode: "dv01", qty: 40000 },
    { ...defaultLeg("asw", "UST"), id: bondNear("UST", 5, true), qty: 25e6 },
    { type: "irs", id: "USD SOFR", tenor: 10, fixed: null, side: -1, qtyMode: "dv01", qty: 15000 },
    { type: "irs", id: "EUR €STR", tenor: 2, fixed: null, side: 1, qtyMode: "dv01", qty: 20000 },
  ];
}

// `scale`: the field shows obj[key] / scale and stores what is typed × scale (DV01 in k, notional in mm).
function input(obj, key, { type = "number", step = "any", title, placeholder, scale = 1 } = {}) {
  const i = el("input", { type, step, value: obj[key] == null ? "" : type === "number" ? +(obj[key] / scale).toPrecision(12) : obj[key], title, placeholder: placeholder ?? "" });
  i.addEventListener("change", () => { obj[key] = type === "number" ? (i.value === "" ? null : Number(i.value) * scale) : i.value; render(); });
  return i;
}
function select(obj, key, options, { numeric = false, onchange } = {}) {
  const s = el("select", {}, options.map((o) => el("option", { value: o.v, selected: String(o.v) === String(obj[key]) ? true : null }, o.label)));
  s.addEventListener("change", () => { obj[key] = numeric ? Number(s.value) : s.value; onchange?.(); render(); });
  return s;
}

function render() {
  save();
  const pos = book.map((leg) => ({ leg, now: legNow(U, leg) }));

  // ---- risk aggregation: rows keyed by curve, KR bucket arrays of ΔV for +1bp
  const govt = {}, swap = {}, asw = {}, basis = {};
  const add = (store, key, ccy, t, dv) => {
    const row = (store[key] ??= { ccy, kr: KR.map(() => 0) });
    krWeights(t).forEach((w, k) => { row.kr[k] += dv * w; });
  };
  for (const { leg, now } of pos) {
    if (!now) continue;
    if (leg.type === "bond") add(govt, now.market, now.ccy, now.t, -now.dv01);
    else if (leg.type === "asw") {
      // Inside the package the bond is priced at swap rate + ASW: the spread carries the bond's DV01, the swap
      // curve the difference between the bond and the swap leg; the government curve none.
      add(asw, now.market, now.ccy, now.t, -now.dv01);
      add(swap, now.swapIndex, now.ccy, now.t, -(now.dv01 + now.swapDv01));
    } else if (leg.type === "fut") {
      add(govt, now.market, now.ccy, now.t, -now.dv01);
      const k = `${leg.id} ${U.futs[leg.id].expiry}`;
      const tickLabel = now.market === "UST" ? "1/32" : "1c";
      const dv = (leg.side * now.lots * now.face / 100) * (-now.tick / now.cf);
      basis[k] = { ccy: now.ccy, dv: (basis[k]?.dv ?? 0) + dv, tick: tickLabel, ctd: U.futs[leg.id].ctd.name };
    } else add(swap, leg.id, now.ccy, now.t, -now.dv01);
  }

  // ---- positions table
  posBox.replaceChildren(
    el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Type", "Market", "Security", "Side", "Size by", "Quantity", "Fixed %", "Level", "Maturity", "Size", "DV01", "Value", ""]
        .map((h, i) => el("th", { class: i < 5 ? "l" : "" }, h)))),
      el("tbody", {}, pos.map(({ leg, now }, i) => {
        const ccy = now?.ccy ?? "";
        const security = leg.type === "bond" || leg.type === "asw"
          ? select(leg, "id", [...U.bonds.values()].filter((b) => b.market === leg.market && (leg.type === "bond" || b.asw != null)).sort((a, b) => a.t - b.t)
            .map((b) => ({ v: b.id, label: `${b.name}  ${leg.type === "asw" ? `${fmt.n(b.asw, 1)}bp` : `${b.yield.toFixed(3)}%`}` })))
          : leg.type === "fut" ? select(leg, "id", Object.values(U.futs).map((f) => ({ v: f.code, label: `${f.code} ${f.expiry}` })))
            : el("span", { class: "row", style: { gap: "4px" } }, select(leg, "id", Object.keys(SWAP_INDEX).map((k) => ({ v: k, label: k }))),
              select(leg, "tenor", IRS_TENORS.map((y) => ({ v: y, label: `${y}Y` })), { numeric: true }));
        return el("tr", {},
          el("td", { class: "l" }, select(leg, "type", TYPES.map((x) => ({ v: x.code, label: x.label })), { onchange: () => { book[i] = defaultLeg(leg.type, leg.market ?? "DE"); } })),
          el("td", { class: "l" }, leg.type === "bond" || leg.type === "asw"
            ? select(leg, "market", MARKETS.map((m) => ({ v: m.code, label: m.label })), { onchange: () => { leg.id = bondNear(leg.market, 10, leg.type === "asw"); } }) : "–"),
          el("td", { class: "l" }, security),
          el("td", { class: "l" }, select(leg, "side", SIDES[leg.type], { numeric: true })),
          el("td", { class: "l" }, select(leg, "qtyMode", [{ v: "notional", label: leg.type === "fut" ? "Lots" : "Notional (mm)" }, { v: "dv01", label: "DV01 (k)" }])),
          el("td", { class: "edit" }, (() => { const i = input(leg, "qty", { step: leg.qtyMode === "dv01" ? 1 : leg.type === "fut" ? 10 : 1,
            scale: leg.qtyMode === "dv01" ? 1e3 : leg.type === "fut" ? 1 : 1e6,
            title: leg.qtyMode === "dv01" ? "DV01 in thousands (100 = 100k)" : leg.type === "fut" ? "lots" : "notional in millions (10 = 10mm)" }); i.style.minWidth = "9em"; return i; })()),
          el("td", { class: "edit" }, leg.type === "irs" ? input(leg, "fixed", { step: 0.01, placeholder: now ? now.level.toFixed(4) : "", title: "Blank: at par today" }) : "–"),
          el("td", {}, now ? (leg.type === "asw" ? `${fmt.n(now.level, 1)}bp` : leg.type === "fut" ? now.price.toFixed(3) : `${now.level.toFixed(3)}%`) : "–"),
          el("td", {}, now?.maturity ?? "–"),
          el("td", {}, now ? (leg.type === "fut" ? `${fmt.int(now.lots)} lots` : fmt.ccy(ccy, now.notional)) : "–"),
          el("td", { class: now?.dv01 >= 0 ? "pos" : "neg" }, now ? fmt.ccy(ccy, now.dv01) : "–"),
          el("td", {}, now?.mv ? fmt.ccy(ccy, now.mv) : "–"),
          el("td", {}, el("button", { class: "btn", title: "Remove", onclick: () => { book.splice(i, 1); render(); } }, "×")));
      })))),
    el("div", { class: "row", style: { marginTop: "6px" } },
      el("button", { class: "btn", onclick: () => { book.push(defaultLeg("bond")); render(); } }, "+ Add position"),
      el("button", { class: "btn", onclick: importTest, title: "Add every leg of the trades saved on TEST" }, "Add TEST trades"),
      el("button", { class: "btn", onclick: () => { if (confirm("Replace the portfolio with the example?")) { book = sample(); render(); } } }, "Example"),
      el("button", { class: "btn", onclick: () => { if (confirm("Remove every position?")) { book = []; render(); } } }, "Clear"),
      el("span", { class: "muted small" }, "DV01: gain for a 1bp fall in rates. Value: dirty market value (bonds), MTM at today's par rate (swaps).")));

  // ---- totals by currency
  const byCcy = {};
  const tot = (ccy) => (byCcy[ccy] ??= { govt: 0, swap: 0, asw: 0, basis: 0 });
  for (const [k, s] of [["govt", govt], ["swap", swap], ["asw", asw]]) for (const r of Object.values(s)) tot(r.ccy)[k] += r.kr.reduce((a, b) => a + b, 0);
  for (const r of Object.values(basis)) tot(r.ccy).basis += r.dv;
  tiles.replaceChildren(...Object.entries(byCcy).flatMap(([c, t]) => [
    tileEl(`${c} government curve`, fmt.ccy(c, t.govt), "ΔV, all points +1bp"),
    tileEl(`${c} swap curve`, fmt.ccy(c, t.swap), "ΔV, all tenors +1bp"),
    tileEl(`${c} ASW`, fmt.ccy(c, t.asw), "ΔV, spreads +1bp"),
    tileEl(`${c} basis`, fmt.ccy(c, t.basis), "ΔV, every basis +1 tick"),
  ]));

  tables.govt.replaceChildren(krTable(govt, (k) => MARKETS.find((m) => m.code === k)?.label ?? k));
  tables.swap.replaceChildren(krTable(swap, (k) => k));
  tables.asw.replaceChildren(krTable(asw, (k) => `${MARKETS.find((m) => m.code === k)?.label ?? k} vs ${ASW_INDEX[k]}`));
  const bRows = Object.entries(basis);
  tables.basis.replaceChildren(bRows.length ? el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, ["Contract", "CTD", "Tick", "ΔV"].map((h, i) => el("th", { class: i < 2 ? "l" : "" }, h)))),
    el("tbody", {}, bRows.map(([k, r]) => el("tr", {}, el("td", { class: "l" }, k), el("td", { class: "l" }, r.ctd), el("td", {}, r.tick),
      el("td", { class: r.dv >= 0 ? "pos" : "neg" }, fmt.ccy(r.ccy, r.dv))))))) : el("p", { class: "muted" }, "No futures positions."));

  // ---- chart: government + swap + ASW risk per bucket, one bar series per curve
  const series = [...Object.entries(govt).map(([k, r]) => [`${k} govt`, r]), ...Object.entries(swap).map(([k, r]) => [`${k} swap`, r]), ...Object.entries(asw).map(([k, r]) => [`${k} ASW`, r])];
  plot(chart, series.map(([name, r], i) => ({ x: KR.map((k) => `${k}Y`), y: r.kr, type: "bar", name: `${name} (${r.ccy})`, marker: { color: COLORS[i % COLORS.length] } })),
    { barmode: "group", yaxis: { title: { text: "ΔV for +1bp (each in its currency)" } } }, 340);
}

function krTable(store, label) {
  const rows = Object.entries(store);
  if (!rows.length) return el("p", { class: "muted" }, "No positions on these curves.");
  const scale = Math.max(1, ...rows.flatMap(([, r]) => r.kr.map(Math.abs)));
  const ccys = [...new Set(rows.map(([, r]) => r.ccy))];
  const totals = ccys.filter((c) => rows.filter(([, r]) => r.ccy === c).length > 1).map((c) => {
    const kr = KR.map((_, k) => rows.filter(([, r]) => r.ccy === c).reduce((a, [, r]) => a + r.kr[k], 0));
    return [`Total ${c}`, { ccy: c, kr }, true];
  });
  const line = ([k, r, isTotal]) => {
    const sum = r.kr.reduce((a, b) => a + b, 0);
    return el("tr", { style: isTotal ? { borderTop: "1px solid #3a3a3a" } : null },
      el("td", { class: "l" }, isTotal ? el("b", {}, k) : `${label(k)} (${r.ccy})`),
      ...r.kr.map((v) => { const td = el("td", { class: Math.abs(v) < 0.5 ? "" : v > 0 ? "pos" : "neg" }, Math.abs(v) < 0.5 ? "·" : fmt.int(v)); const bg = heat(v, scale); if (bg) td.style.background = bg; return td; }),
      el("td", { class: sum >= 0 ? "pos" : "neg" }, el("b", {}, fmt.int(sum))));
  };
  return el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, ["Curve", ...KR.map((k) => `${k}Y`), "Total"].map((h, i) => el("th", { class: i ? "" : "l" }, h)))),
    el("tbody", {}, [...rows.map(([k, r]) => [k, r, false]), ...totals].map(line))));
}

function importTest() {
  let trades;
  try { trades = JSON.parse(localStorage.getItem("testTrades") ?? "[]"); } catch { trades = []; }
  if (!trades.length) { alert("No trades saved on TEST in this browser."); return; }
  const legs = trades.flatMap((t) => t.legs.map(({ repo, haircut, repoSpread, ...leg }) => leg));
  book.push(...legs);
  render();
}

function tileEl(k, v, n) {
  return el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v), el("div", { class: "n" }, n));
}

function methodNote() {
  return el("details", { class: "method panel" }, el("summary", {}, "Method"), el("ul", { class: "small" },
    el("li", {}, "Each cell is the change in portfolio value if that one point rises 1bp and every other point, spread and basis stays where it is. "
      + "Points are key rates: a position at maturity t is split between the two nearest points (1, 2, 3, 5, 7, 10, 15, 20, 30Y) linearly, so the row sums to its DV01."),
    el("li", {}, "Each instrument is priced off its own factors. Bond: the government curve of its market. Futures: the CTD's yield on the government curve "
      + "(futures DV01 = CTD DV01 / CF) and the gross basis (futures = (CTD price − gross basis) / CF, so +1 tick of basis lowers the futures by tick / CF). "
      + "IRS: the swap curve of its index. ASW package (par-par, bond + swap of the same maturity): bond yield = swap rate + ASW, so the spread carries the bond's "
      + "DV01 and the swap curve only the difference between the bond's and the swap leg's DV01; the government curve sees none of it."),
    el("li", {}, "Ticks: 1/32 for Treasury futures, 0.01 for Eurex. DV01s from today's closes; swap rates from the Eurex Clearing curves of the latest close."),
    el("li", {}, "Rows are not added across currencies; totals are per currency.")));
}
