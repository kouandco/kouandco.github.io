import { $, COLORS, MARKETS, el, fmt, frame, heat, plot, segmented, showError } from "./common.js";
import { ASW_INDEX, IRS_TENORS, KR, SIDES, SWAP_INDEX, TYPES, krWeights, legNow, loadUniverse } from "./positions.js";
import { tradeBuilder } from "./tradebuilder.js";

frame("BLOT");
const app = $("#app");
const KEY = "blotPortfolio";
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { return null; } };
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(book)); } catch { /* storage unavailable */ } };

let U, book, builder = null;   // builder: the open "Add trade" panel

// Risk basis: two independent curves per currency; the third is implied (ASW ≈ govt yield − swap rate).
const BASES = [
  { code: "GA", label: "Govt + ASW", implied: "swap", note: "IRS rates are implied: govt yield − ASW" },
  { code: "SA", label: "IRS + ASW", implied: "govt", note: "government yields are implied: IRS rate + ASW" },
  { code: "GS", label: "Govt + IRS", implied: "asw", note: "ASW is implied: govt yield − IRS rate" },
];
// Government curve a swap index is expressed against in the Govt + ASW basis (no gilts on the site: SONIA stays on its own curve).
const SWAP_GOVT = { "USD SOFR": "UST", "EUR €STR": "DE", "EUR 6M": "DE", "GBP SONIA": null };
let basisCode = (() => { try { return localStorage.getItem("blotBasis") ?? "GA"; } catch { return "GA"; } })();
const posBox = el("div"), tiles = el("div", { class: "tiles" });
const tables = { curves: el("div"), basis: el("div") };
const chart = el("div", { class: "plot" });

app.append(
  el("div", { class: "page-title" }, el("h1", {}, "Portfolio risk"),
    el("span", { class: "muted" }, "value change for a 1bp rise in one point, everything else unchanged · portfolio saved in this browser")),
  el("section", { class: "panel" }, el("h2", {}, "Positions"), posBox),
  el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "Totals"), tiles),
  el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "Curve risk: ΔV for +1bp at each maturity"), tables.curves),
  el("div", { class: "grid cols-2", style: { marginTop: "10px" } },
    el("section", { class: "panel" }, el("h2", {}, "Bond futures gross basis: ΔV for +1 tick"), tables.basis),
    el("section", { class: "panel" }, el("h2", {}, "Rate risk by bucket"), chart)),
  methodNote());

loadUniverse().then((u) => { U = u; book = load() ?? sample(); render(); }).catch((e) => showError(app, e));

function bondNear(market, t, needAsw) {
  return [...U.bonds.values()].filter((b) => b.market === market && (!needAsw || b.asw != null)).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0].id;
}
function defaultLeg(type, market = "UST") {
  if (type === "bond" || type === "asw") return { type, market, id: bondNear(market, 10, type === "asw"), side: 1, qtyMode: "notional", qty: 10e6 };
  if (type === "fut") return { type, id: Object.keys(U.futs).find((k) => U.futs[k].market === market) ?? Object.keys(U.futs)[0], side: 1, qtyMode: "notional", qty: 100 };
  return { type, id: "USD SOFR", tenor: 10, fixed: null, side: 1, qtyMode: "dv01", qty: 10000 };
}
// Example book: US Treasuries hedged two ways, each hedge DV01-matched to its bond:
// the TY CTD bought against sold TY futures (a basis position), and a 5Y Treasury bought against a SOFR payer
// to the bond's maturity (a bond + swap, i.e. an asset swap).
function sample() {
  const futBond = U.futs.TY?.ctd?.id ?? bondNear("UST", 7, false);
  const swapBond = bondNear("UST", 5, false);
  const dv = (id, qty) => Math.round((qty * U.bonds.get(id).dv01) / 100);
  return [
    { ...defaultLeg("bond", "UST"), id: futBond, qty: 50e6, trade: "TY basis: CTD vs futures" },
    { ...defaultLeg("fut", "UST"), id: "TY", side: -1, qtyMode: "dv01", qty: dv(futBond, 50e6), trade: "TY basis: CTD vs futures" },
    { ...defaultLeg("bond", "UST"), id: swapBond, qty: 50e6, trade: "5Y Treasury vs SOFR payer" },
    { type: "irs", id: "USD SOFR", maturity: U.bonds.get(swapBond).maturity, tenor: 5, fixed: null, side: -1, qtyMode: "dv01", qty: dv(swapBond, 50e6), trade: "5Y Treasury vs SOFR payer" },
  ];
}

// Trades (bundles): legs sharing a `trade` name. Kept next to each other in the book, in order of first appearance;
// positions with no trade stay single.
function regroup(list) {
  const order = [...new Set(list.map((l, i) => l.trade ?? `\u0000${i}`))];
  const rank = new Map(order.map((k, i) => [k, i]));
  return list.map((l, i) => [l, i]).sort((a, b) => rank.get(a[0].trade ?? `\u0000${a[1]}`) - rank.get(b[0].trade ?? `\u0000${b[1]}`) || a[1] - b[1]).map(([l]) => l);
}
function uniqueTrade(name) {
  const used = new Set(book.map((l) => l.trade).filter(Boolean));
  let n = name || "Trade", k = 2;
  while (used.has(n)) n = `${name || "Trade"} (${k++})`;
  return n;
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
  book = regroup(book);
  save();
  const pos = book.map((leg) => ({ leg, now: legNow(U, leg) }));

  // ---- risk aggregation. Each position is broken into bond-like exposure (a yield at maturity t in a market:
  // bonds, the CTD of a future, the bond in an ASW package) and swap-like exposure (a par rate in an index: IRS,
  // the swap in an ASW package), each with its DV01 D. The basis then maps them onto two independent curves.
  // ΔV for +1bp = −D.
  const B = BASES.find((b) => b.code === basisCode) ?? BASES[0];
  const govt = {}, swap = {}, asw = {}, basis = {};
  const add = (store, key, ccy, t, dv) => {
    const row = (store[key] ??= { ccy, kr: KR.map(() => 0) });
    krWeights(t).forEach((w, k) => { row.kr[k] += dv * w; });
  };
  const bondRisk = (m, ccy, t, D) => {
    if (B.code === "SA") { add(swap, ASW_INDEX[m], ccy, t, -D); add(asw, m, ccy, t, -D); }   // yield = swap + ASW
    else add(govt, m, ccy, t, -D);
  };
  const swapRisk = (ix, ccy, t, D) => {
    const g = SWAP_GOVT[ix];
    if (B.code === "GA" && g) { add(govt, g, ccy, t, -D); add(asw, g, ccy, t, D); }           // swap = govt − ASW
    else add(swap, ix, ccy, t, -D);
  };
  for (const { leg, now } of pos) {
    if (!now) continue;
    if (leg.type === "bond") bondRisk(now.market, now.ccy, now.t, now.dv01);
    else if (leg.type === "asw") { bondRisk(now.market, now.ccy, now.t, now.dv01); swapRisk(now.swapIndex, now.ccy, now.t, now.swapDv01); }
    else if (leg.type === "fut") {
      bondRisk(now.market, now.ccy, now.t, now.dv01);
      const k = `${leg.id} ${U.futs[leg.id].expiry}`;
      const tickLabel = now.market === "UST" ? "1/32" : "1c";
      const dv = (leg.side * now.lots * now.face / 100) * (-now.tick / now.cf);
      basis[k] = { ccy: now.ccy, dv: (basis[k]?.dv ?? 0) + dv, tick: tickLabel, ctd: U.futs[leg.id].ctd.name };
    } else swapRisk(leg.id, now.ccy, now.t, now.dv01);
  }

  // ---- positions table
  posBox.replaceChildren(
    el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Type", "Market", "Security", "Side", "Size by", "Quantity", "Fixed %", "Level", "Maturity", "Size", "DV01", "Value", ""]
        .map((h, i) => el("th", { class: i < 5 ? "l" : "" }, h)))),
      el("tbody", {}, pos.flatMap(({ leg, now }, i) => {
        const head = leg.trade && leg.trade !== book[i - 1]?.trade ? tradeRow(leg.trade, pos) : null;
        const ccy = now?.ccy ?? "";
        const security = leg.type === "bond" || leg.type === "asw"
          ? select(leg, "id", [...U.bonds.values()].filter((b) => b.market === leg.market && (leg.type === "bond" || b.asw != null)).sort((a, b) => a.t - b.t)
            .map((b) => ({ v: b.id, label: `${b.name}  ${leg.type === "asw" ? `${fmt.n(b.asw, 1)}bp` : `${b.yield.toFixed(3)}%`}` })))
          : leg.type === "fut" ? select(leg, "id", Object.values(U.futs).map((f) => ({ v: f.code, label: `${f.code} ${f.expiry}` })))
            : el("span", { class: "row", style: { gap: "4px" } }, select(leg, "id", Object.keys(SWAP_INDEX).map((k) => ({ v: k, label: k }))),
              leg.maturity ? el("span", { class: "muted", title: "Swap to a date (from a trade template)" }, `${leg.start ? `${leg.start} → ` : "to "}${leg.maturity}`)
                : select(leg, "tenor", IRS_TENORS.map((y) => ({ v: y, label: `${y}Y` })), { numeric: true }));
        return [head, el("tr", { class: leg.trade ? "in-trade" : null },
          el("td", { class: "l", style: leg.trade ? { paddingLeft: "18px" } : null }, select(leg, "type", TYPES.map((x) => ({ v: x.code, label: x.label })), { onchange: () => { book[i] = { ...defaultLeg(leg.type, leg.market ?? "UST"), ...(leg.trade ? { trade: leg.trade } : {}) }; } })),
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
          el("td", {}, el("button", { class: "btn", title: leg.trade ? `Remove this leg from ${leg.trade}` : "Remove", onclick: () => { book.splice(i, 1); render(); } }, "×")))].filter(Boolean);
      })))),
    builder ?? "",
    el("div", { class: "row", style: { marginTop: "6px" } },
      el("button", { class: "btn", onclick: () => {
        builder = builder ? null : tradeBuilder(U, {
          createLabel: "Add to portfolio",
          onCreate: ({ legs, name }) => { const trade = uniqueTrade(name); book.push(...legs.map((l) => ({ ...l, trade }))); builder = null; render(); },
          onCancel: () => { builder = null; render(); },
        });
        render();
      } }, builder ? "Close trade builder" : "+ Add trade"),
      el("button", { class: "btn", onclick: () => { book.push(defaultLeg("bond")); render(); } }, "+ Add position"),
      el("button", { class: "btn", title: "Bundle every single position (not in a trade) into one new trade", onclick: () => {
        const singles = book.filter((l) => !l.trade);
        if (!singles.length) return;
        const trade = uniqueTrade("Trade");
        singles.forEach((l) => { l.trade = trade; });
        render();
      } }, "Bundle singles"),
      el("button", { class: "btn", onclick: importTest, title: "Add every leg of the trades saved on TEST" }, "Add TEST trades"),
      el("button", { class: "btn", onclick: () => { if (confirm("Replace the portfolio with the example?")) { book = sample(); render(); } } }, "Example"),
      el("button", { class: "btn", onclick: () => { if (confirm("Remove every position?")) { book = []; render(); } } }, "Clear"),
      el("span", { class: "muted small" }, "DV01: gain for a 1bp fall in rates. Value: dirty market value (bonds), MTM at today's par rate (swaps).")));

  // ---- totals by currency
  const byCcy = {};
  const tot = (ccy) => (byCcy[ccy] ??= { govt: 0, swap: 0, asw: 0, basis: 0 });
  for (const [k, s] of [["govt", govt], ["swap", swap], ["asw", asw]]) for (const r of Object.values(s)) tot(r.ccy)[k] += r.kr.reduce((a, b) => a + b, 0);
  for (const r of Object.values(basis)) tot(r.ccy).basis += r.dv;
  // Rates +1bp: government and swap curves both up 1bp, spreads unchanged — the same in every basis.
  tiles.replaceChildren(...Object.entries(byCcy).flatMap(([c, t]) => [
    tileEl(`${c} rates +1bp`, fmt.ccy(c, t.govt + t.swap), "govt and IRS curves together, spreads unchanged"),
    B.implied !== "asw" ? tileEl(`${c} ASW +1bp`, fmt.ccy(c, t.asw), "every ASW, rates otherwise unchanged") : null,
    tileEl(`${c} basis +1 tick`, fmt.ccy(c, t.basis), "every futures gross basis"),
  ].filter(Boolean)));

  const mkt = (k) => MARKETS.find((m) => m.code === k)?.label ?? k;
  // Fixed columns: every market and swap index, whether or not the book has positions on it.
  const mccy = (k) => U.markets[k].currency;
  const codes = MARKETS.map((m) => m.code);
  tables.curves.replaceChildren(
    el("div", { class: "row", style: { marginBottom: "6px" } }, el("span", { class: "amber" }, "Risk basis"),
      segmented(BASES, B.code, (v) => { basisCode = v; try { localStorage.setItem("blotBasis", v); } catch { /* storage unavailable */ } render(); })),
    curveTable([
      { id: "govt", label: "Govt", store: govt, keys: codes, ccy: mccy, name: mkt },
      // In Govt + ASW, SONIA has no government curve on the site and keeps its IRS risk.
      { id: "swap", label: "IRS", store: swap, keys: Object.keys(SWAP_INDEX), ccy: (k) => SWAP_INDEX[k].ccy,
        name: (k) => ({ "EUR 6M": "Euribor", "EUR €STR": "€STR" })[k] ?? k.split(" ")[1], note: (k) => (k === "EUR 6M" ? 1 : null),
        live: (k) => B.implied !== "swap" || !SWAP_GOVT[k] },
      { id: "asw", label: "ASW", groupNote: 2, store: asw, keys: codes, ccy: mccy, name: mkt },
    ].map((g) => ({ ...g, implied: g.id === B.implied })), B));
  const bRows = Object.values(U.futs).map((f) => {
    const k = `${f.code} ${f.expiry}`;
    return [k, basis[k] ?? { ccy: f.ccy, dv: 0, tick: f.market === "UST" ? "1/32" : "1c", ctd: f.ctd.name }];
  });
  tables.basis.replaceChildren(el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, ["Contract", "CTD", "Tick", "ΔV"].map((h, i) => el("th", { class: i < 2 ? "l" : "" }, h)))),
    el("tbody", {}, bRows.map(([k, r]) => el("tr", {}, el("td", { class: "l" }, k), el("td", { class: "l" }, r.ctd), el("td", {}, r.tick),
      el("td", { class: Math.abs(r.dv) < 0.5 ? "" : r.dv > 0 ? "pos" : "neg" }, Math.abs(r.dv) < 0.5 ? "·" : fmt.ccy(r.ccy, r.dv))))))),
    el("p", { class: "small muted", style: { margin: "6px 0 0" } }, "Gross basis = CTD price − futures × CF. +1 tick (1/32 UST, 0.01 Eurex) with the CTD's "
      + "yield unchanged lowers the futures by tick / CF: ΔV = −lots × face / 100 × tick / CF. Bonds and IRS carry none; a CTD-vs-futures position "
      + "(long bond, short futures) gains when the basis widens."));

  // ---- chart: government + swap + ASW risk per bucket, one bar series per curve
  const series = [...Object.entries(govt).map(([k, r]) => [`${k} govt`, r]), ...Object.entries(swap).map(([k, r]) => [`${k} IRS`, r]), ...Object.entries(asw).map(([k, r]) => [`${k} ASW`, r])];
  plot(chart, series.map(([name, r], i) => ({ x: KR.map((k) => `${k}Y`), y: r.kr, type: "bar", name: `${name} (${r.ccy})`, marker: { color: COLORS[i % COLORS.length] } })),
    { barmode: "group", yaxis: { title: { text: "ΔV for +1bp (each in its currency)" } }, legend: { orientation: "h", y: -0.15 } }, 440);
}

// One table, maturities down the side: a column per curve, grouped into government yield, swap and ASW, then
// per currency the sum across every curve (all of them +1bp at that maturity).
function curveTable(groups, B) {
  const cols = groups.flatMap((g) => g.keys.map((k, j) => ({ group: g.label, groupImplied: g.implied, groupNote: g.groupNote, first: j === 0, label: g.name(k), colNote: g.note?.(k), ccy: g.ccy(k),
    rate: g.id !== "asw", implied: g.implied && !(g.live?.(k)), kr: g.store[k]?.kr ?? KR.map(() => 0) })));
  const ccys = [...new Set(cols.map((c) => c.ccy))];
  const all = ccys.map((c, j) => ({ group: "Total", groupNote: 3, first: j === 0, label: "Rates", ccy: c, total: true,
    kr: KR.map((_, k) => cols.filter((x) => x.ccy === c && x.rate).reduce((a, x) => a + x.kr[k], 0)) }));
  const shown = [...cols, ...all];
  const scale = Math.max(1, ...cols.flatMap((c) => c.kr.map(Math.abs)));
  const sep = (c) => (c.first ? { borderLeft: "1px solid #3a3a3a" } : null);
  const cell = (v, c, bold) => {
    if (c.implied) return el("td", { class: "muted", style: { ...sep(c), background: "#0d0d0d" } }, "–");
    const td = el("td", { class: Math.abs(v) < 0.5 ? "" : v > 0 ? "pos" : "neg", style: sep(c) }, Math.abs(v) < 0.5 ? "·" : bold ? el("b", {}, fmt.int(v)) : fmt.int(v));
    const bg = !c.total && heat(v, scale);
    if (bg) td.style.background = bg;
    return td;
  };
  const spans = [];
  for (const c of shown) { const last = spans[spans.length - 1]; if (last?.label === c.group) last.n++; else spans.push({ label: c.group, n: 1, implied: c.groupImplied, note: c.groupNote }); }
  const sup = (n) => (n ? el("sup", { class: "muted" }, String(n)) : null);
  const table = el("div", { class: "table-wrap" }, el("table", { class: "compact" },
    el("thead", {},
      el("tr", {}, el("th", { class: "l" }, ""), spans.map((g) => el("th", { colspan: g.n, class: "th-group", style: { borderLeft: "1px solid #3a3a3a", ...(g.implied ? { color: "#6a6a6a" } : {}) } },
        g.label, sup(g.note), g.implied ? sup(4) : null))),
      el("tr", {}, el("th", { class: "l" }, "Maturity"), shown.map((c) => el("th", { style: { ...sep(c), ...(c.implied ? { color: "#6a6a6a" } : {}) } }, c.label, sup(c.colNote), el("div", { class: "unit" }, c.ccy))))),
    el("tbody", {},
      KR.map((m, k) => el("tr", {}, el("td", { class: "l" }, `${m}Y`), shown.map((c) => cell(c.kr[k], c, c.total)))),
      el("tr", { style: { borderTop: "1px solid #3a3a3a" } }, el("td", { class: "l" }, el("b", {}, "Total")),
        shown.map((c) => cell(c.kr.reduce((a, b) => a + b, 0), c, true))))));
  const notes = [
    "Euribor: 6M Euribor IRS, projected on the 6M Euribor curve and discounted on €STR. SOFR, €STR and SONIA are overnight-index swaps.",
    "ASW: bond yield − IRS rate at the same maturity; UST against SOFR, Bund, OAT and BTP against 6M Euribor.",
    "Total: every government and IRS curve +1bp at that maturity together, spreads unchanged, summed per currency. The same in every risk basis.",
    `Grey: implied in the ${B.label} basis (${B.note}), so it carries no risk of its own.`
      + (B.code === "GA" ? " SONIA has no government curve here and keeps its IRS risk." : ""),
  ];
  return el("div", {}, table, el("ol", { class: "small muted", style: { margin: "6px 0 0", paddingLeft: "18px" } }, notes.map((n) => el("li", {}, n))));
}

function importTest() {
  let trades;
  try { trades = JSON.parse(localStorage.getItem("testTrades") ?? "[]"); } catch { trades = []; }
  if (!trades.length) { alert("No trades saved on TEST in this browser."); return; }
  const legs = trades.flatMap((t) => { const trade = uniqueTrade(t.name); return t.legs.map(({ repo, haircut, repoSpread, ...leg }) => ({ ...leg, trade })); });
  book.push(...legs);
  render();
}

// Header row of a trade: its name (editable), net DV01 and value per currency, and trade-level actions.
function tradeRow(name, pos) {
  const legs = pos.filter((p) => p.leg.trade === name);
  const net = {};
  for (const { now } of legs) if (now) { const c = (net[now.ccy] ??= { dv: 0, mv: 0 }); c.dv += now.dv01; c.mv += now.mv ?? 0; }
  const ccys = Object.keys(net);
  const nameIn = el("input", { type: "text", value: name, style: { minWidth: "22em", fontWeight: "600" }, title: "Trade name" });
  nameIn.addEventListener("change", () => { const n = nameIn.value.trim() || name; const t = n === name ? name : uniqueTrade(n); book.forEach((l) => { if (l.trade === name) l.trade = t; }); render(); });
  return el("tr", { class: "trade-row", style: { background: "rgba(255, 170, 0, 0.06)", borderTop: "1px solid #3a3a3a" } },
    el("td", { class: "l", colspan: 10 }, el("span", { class: "row", style: { gap: "8px" } }, nameIn,
      el("span", { class: "muted small" }, `${legs.length} leg${legs.length === 1 ? "" : "s"} · net`))),
    el("td", {}, ccys.map((c, k) => el("div", { class: net[c].dv >= 0 ? "pos" : "neg" }, fmt.ccy(c, net[c].dv)))),
    el("td", {}, ccys.map((c) => el("div", {}, net[c].mv ? fmt.ccy(c, net[c].mv) : "–"))),
    el("td", { style: { whiteSpace: "nowrap" } },
      el("button", { class: "btn", title: "Add a position to this trade", onclick: () => { const last = legs.at(-1).leg; book.splice(book.lastIndexOf(last) + 1, 0, { ...defaultLeg(last.type === "fut" ? "bond" : last.type, last.market ?? "UST"), trade: name }); render(); } }, "+"),
      el("button", { class: "btn", title: "Unbundle: keep the legs as single positions", onclick: () => { book.forEach((l) => { if (l.trade === name) delete l.trade; }); render(); } }, "⇢"),
      el("button", { class: "btn", title: "Remove the whole trade", onclick: () => { book = book.filter((l) => l.trade !== name); render(); } }, "×")));
}

function tileEl(k, v, n) {
  return el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v), el("div", { class: "n" }, n));
}

function methodNote() {
  return el("details", { class: "method panel" }, el("summary", {}, "Method"), el("ul", { class: "small" },
    el("li", {}, "Each cell is the change in portfolio value if that one point rises 1bp and every other point, spread and basis stays where it is. "
      + "Points are key rates: a position at maturity t is split between the two nearest points (1, 2, 3, 5, 7, 10, 15, 20, 30Y) linearly, so the row sums to its DV01."),
    el("li", {}, "ASW ≈ government yield − swap rate at the same maturity, so only two of the three curves are independent. The risk basis picks two; "
      + "the third is implied and carries no risk of its own. Every position is split into a bond yield (bonds, a future's CTD, the bond in an ASW "
      + "package) and a swap rate (IRS, the swap in an ASW package) and mapped the same way, so a bond plus a separate swap shows the same risk as the "
      + "equivalent ASW package."),
    el("li", {}, "Govt + ASW: an IRS rate = the government yield (UST for USD, Bund for EUR) − that market's ASW; SONIA has no government curve "
      + "here and keeps its IRS risk. IRS + ASW: a bond yield = the IRS rate of its ASW index (SOFR for UST, 6M Euribor for EUR) + its ASW. "
      + "Govt + IRS: bond yields on the government curve, IRS on the IRS curve. €STR IRS use the 6M Euribor ASW (the €STR/6M basis is ignored)."),
    el("li", {}, "Rates +1bp: government and IRS curves up together with spreads unchanged. It is the same whichever basis is chosen. "
      + "Futures: the CTD's yield (futures DV01 = CTD DV01 / CF) plus the gross basis: futures = (CTD price − gross basis) / CF, so +1 tick of basis "
      + "lowers the futures by tick / CF."),
    el("li", {}, "Ticks: 1/32 for Treasury futures, 0.01 for Eurex. DV01s from today's closes; swap rates from the Eurex Clearing curves of the latest close."),
    el("li", {}, "Rows are not added across currencies; totals are per currency.")));
}
