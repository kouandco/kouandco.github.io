import { $, MARKETS, PAGES, el, fmt, frame, loadJSON } from "./common.js";

frame("HOME");
const app = $("#app");

const BLURB = {
  CTD: "Cheapest-to-deliver probabilities, fair futures price and fair net basis for UST, Bund, OAT and BTP futures. Drag the generic curve, set drift and vol per point, edit the basket.",
  BMNT: "Every nominal UST, Bund, OAT and BTP: realised vol, 3-month carry and roll down, editable repo, futures fly hedge and hedged return on book and on capital.",
  EURX: "Trade-by-trade EFP gross basis and EFS invoice spreads in Eurex Schatz, Bobl, Bund, Buxl, OAT and BTP futures, with daily VWAP.",
  DTCC: "Every USD SOFR, EUR 6M Euribor and €STR, and GBP SONIA swap reported to the DTCC repository, archived daily: key-rate tenors, flow by tenor, venue and hour, "
    + "spot VWAPs checked against the Eurex curves, and USD swap spreads to Treasuries.",
  CFTC: "Who is long and short Treasury futures: asset managers, leveraged funds and dealers from the CFTC Commitments of Traders, weekly since 2006, "
    + "in contracts, DV01 or 10-year equivalents, across the curve.",
  FIHG: "Hedge a bond position by DV01 with futures or bonds, single or fly: lots or nominal per leg and the residual risk.",
  GP: "History of any bond's yield, price or asset swap spread, generic yields, swap rates, Eurex futures, basis and invoice spreads. Build spreads and flies, chart them and regress one on another.",
  WIRP: "Fed, ECB and BoE moves priced meeting by meeting by the OIS curves: implied policy rate, bp and probability of a 25bp move.",
  TEST: "Backtest a trade of up to five legs (bonds, ASW, futures, swaps) from a start date: sized by notional or DV01, with repo and haircuts, "
    + "entry, target, stop and holding period. Cash P&L, return on capital and on balance sheet.",
  BLOT: "Risk of a portfolio of bonds, ASW, futures and swaps by point: government curve, swap curve, ASW and futures basis, each moved 1bp "
    + "with everything else unchanged.",
  IRS: "Price a USD or EUR swap: notional, fixed rate, spread, conventions and dates in, NPV out (or NPV in, rate out). Drag the swap curve to reprice.",
};

app.append(
  el("div", { class: "page-title" }, el("h1", {}, "Rates tools"), el("span", { class: "muted" }, "government bond futures and cash · data refreshed weekdays at 10:00, 19:00 and 23:30 London")),
  el("nav", { class: "menu", "aria-label": "Tools" }, PAGES.filter((p) => p.code !== "HOME").map((p) =>
    el("a", { href: p.href }, el("span", { class: "code" }, p.code), el("span", { class: "name" }, p.title), el("p", {}, BLURB[p.code])))));

const snapshot = el("section", { class: "panel", style: { marginTop: "12px" } }, el("h2", {}, "Generic yields (benchmark bonds)"));
app.append(snapshot);

const TENORS = [2, 5, 10, 30];

// Daily change (bp) of a bond's yield or ASW: the value on the market's latest date less the previous one on file.
function change(dates, values, asOf) {
  if (!values) return null;
  let i = dates.lastIndexOf(asOf);
  if (i < 0) i = dates.length - 1;
  let j = i - 1;
  while (j >= 0 && values[j] == null) j--;
  return values[i] == null || j < 0 ? null : values[i] - values[j];
}

Promise.all(MARKETS.map((m) => loadJSON(`data/markets/${m.code}.json`))).then((list) => {
  const bench = (mk, t) => mk.benchmarks?.find((b) => b.tenor === t);
  const de10 = bench(list.find((mk) => mk.market === "DE"), 10);
  const tbody = el("tbody");
  // Value with its daily change in bp beside it (blank until the histories have loaded). Yields are coloured as
  // prices move: a rise in yield red, a fall green (`inverse`); spreads green when they widen.
  const withChg = (text, d, title, sub, inverse = false) => el("td", { title },
    text, d == null ? "" : el("span", { class: `small ${Math.abs(d) <= 0.05 ? "muted" : (d > 0) !== inverse ? "up" : "down"}` }, ` ${fmt.s(d, 1)}`), sub);
  const render = (gps) => tbody.replaceChildren(...list.map((mk, k) => {
    const gp = gps?.[k];
    const b = TENORS.map((t) => bench(mk, t));
    const y = b.map((x) => x?.yield);
    const dy = b.map((x) => (gp && x ? change(gp.dates, gp.yield[x.id], mk.asOf) : null)).map((v) => (v == null ? null : v * 100));
    const deGp = gps?.[list.findIndex((m) => m.market === "DE")];
    const dDe10 = deGp && de10 ? change(deGp.dates, deGp.yield[de10.id], list.find((m) => m.market === "DE").asOf) * 100 : null;
    const diff = (a, c) => (a == null || c == null ? null : a - c);
    const dAsw = gp && b[2] ? change(gp.aswDates, gp.asw?.[b[2].id], mk.asOf) : null;
    const vsBund = mk.market !== "DE" && mk.currency === "€";
    return el("tr", {},
      el("td", { class: "l" }, el("a", { href: `BMNT.html#m=${mk.market}` }, mk.name)),
      ...b.map((x, i) => withChg(x ? x.yield.toFixed(3) : "–", dy[i], x ? `${x.name} (${x.id}); change in bp from the previous close` : null,
        x ? el("div", { class: "muted small" }, x.name) : null, true)),
      withChg(fmt.s((y[2] - y[0]) * 100, 1), diff(dy[2], dy[0])),
      withChg(fmt.s((y[3] - y[2]) * 100, 1), diff(dy[3], dy[2])),
      vsBund ? withChg(fmt.s((y[2] - de10?.yield) * 100, 1), diff(dy[2], dDe10)) : el("td", {}, "–"),
      withChg(fmt.s(b[2]?.asw, 1), dAsw),
      el("td", {}, mk.asOf));
  }));
  render(null);
  Promise.all(MARKETS.map((m) => loadJSON(`data/gp/${m.code}.json`))).then(render).catch((err) => console.warn("daily changes unavailable", err));
  snapshot.append(el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, ["Market", "2Y %", "5Y %", "10Y %", "30Y %", "2s10s bp", "10s30s bp", "10Y vs Bund bp", "10Y ASW bp", "As of"]
      .map((h, i) => el("th", { class: i ? "" : "l" }, h)))),
    tbody)),
  el("p", { class: "note" }, "Closing yield of the actual benchmark bond at each tenor. UST: the latest issue of each original term (on the run). "
    + "Bunds: the latest Schatz and Bobl, the newest Bund in the 10-year window and the longest Bund. OATs and BTPs: the most recently issued line "
    + "maturing in the tenor's window. Small figures: change in bp from the previous close of the same bond (each market on its own dates). ASW: par-par asset swap spread vs SOFR (UST) or 6M Euribor (euro area), positive when the bond yields more than swaps. "
    + "History of every series is on GP."));
}).catch((err) => snapshot.append(el("p", { class: "down" }, `Could not load data: ${err.message}`)));
