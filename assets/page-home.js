import { $, MARKETS, PAGES, el, fmt, frame, loadJSON } from "./common.js";

frame("HOME");
const app = $("#app");

const BLURB = {
  CTD: "Cheapest-to-deliver probabilities, fair futures price and fair net basis for UST, Bund, OAT and BTP futures. Drag the generic curve, set drift and vol per point, edit the basket.",
  BMNT: "Every nominal UST, Bund, OAT and BTP: realised vol, 3-month carry and roll down, editable repo, futures fly hedge and hedged return on book and on capital.",
  EURX: "Trade-by-trade EFP gross basis and EFS invoice spreads in Eurex Schatz, Bobl, Bund, Buxl, OAT and BTP futures, with daily VWAP.",
  FIHG: "Hedge a bond position by DV01 with futures or bonds, single or fly: lots or nominal per leg and the residual risk.",
  GP: "History of any bond's yield, price or asset swap spread, generic yields, swap rates, Eurex futures, basis and invoice spreads. Build spreads and flies, chart them and regress one on another.",
  WIRP: "Fed, ECB and BoE moves priced meeting by meeting by the OIS curves: implied policy rate, bp and probability of a 25bp move.",
  IRS: "Price a USD or EUR swap: notional, fixed rate, spread, conventions and dates in, NPV out (or NPV in, rate out). Drag the swap curve to reprice.",
};

app.append(
  el("div", { class: "page-title" }, el("h1", {}, "Rates tools"), el("span", { class: "muted" }, "government bond futures and cash · data refreshed weekdays at 10:00 London")),
  el("nav", { class: "menu", "aria-label": "Tools" }, PAGES.filter((p) => p.code !== "HOME").map((p) =>
    el("a", { href: p.href }, el("span", { class: "code" }, p.code), el("span", { class: "name" }, p.title), el("p", {}, BLURB[p.code])))));

const snapshot = el("section", { class: "panel", style: { marginTop: "12px" } }, el("h2", {}, "Generic yields (benchmark bonds)"));
app.append(snapshot);

const TENORS = [2, 5, 10, 30];

Promise.all(MARKETS.map((m) => loadJSON(`data/markets/${m.code}.json`))).then((list) => {
  const bench = (mk, t) => mk.benchmarks?.find((b) => b.tenor === t);
  const de10 = bench(list.find((mk) => mk.market === "DE"), 10);
  const cell = (b) => el("td", { title: b ? `${b.name} (${b.id})` : null },
    b ? b.yield.toFixed(3) : "–", b ? el("div", { class: "muted small" }, b.name) : null);
  const rows = list.map((mk) => {
    const b = TENORS.map((t) => bench(mk, t));
    const y = b.map((x) => x?.yield);
    return el("tr", {},
      el("td", { class: "l" }, el("a", { href: `BMNT.html#m=${mk.market}` }, mk.name)),
      ...b.map(cell),
      el("td", {}, fmt.s((y[2] - y[0]) * 100, 1)),
      el("td", {}, fmt.s((y[3] - y[2]) * 100, 1)),
      el("td", {}, mk.market === "DE" || mk.currency !== "€" ? "–" : fmt.s((y[2] - de10?.yield) * 100, 1)),
      el("td", {}, fmt.s(b[2]?.asw, 1)),
      el("td", {}, mk.asOf));
  });
  snapshot.append(el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, ["Market", "2Y %", "5Y %", "10Y %", "30Y %", "2s10s bp", "10s30s bp", "10Y vs Bund bp", "10Y ASW bp", "As of"]
      .map((h, i) => el("th", { class: i ? "" : "l" }, h)))),
    el("tbody", {}, rows))),
  el("p", { class: "note" }, "Closing yield of the actual benchmark bond at each tenor. UST: the latest issue of each original term (on the run). "
    + "Bunds: the latest Schatz and Bobl, the newest Bund in the 10-year window and the longest Bund. OATs and BTPs: the most recently issued line "
    + "maturing in the tenor's window. ASW: par-par asset swap spread vs SOFR (UST) or 6M Euribor (euro area), positive when the bond yields more than swaps. "
    + "History of every series is on GP."));
}).catch((err) => snapshot.append(el("p", { class: "down" }, `Could not load data: ${err.message}`)));
