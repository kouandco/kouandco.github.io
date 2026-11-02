import { $, MARKETS, PAGES, el, fmt, frame, loadJSON } from "./common.js";

frame("HOME");
const app = $("#app");

const BLURB = {
  CTD: "Cheapest-to-deliver probabilities, fair futures price and fair net basis for UST, Bund, OAT and BTP futures. Drag the generic curve, set drift and vol per point, edit the basket.",
  BMNT: "Every nominal UST, Bund, OAT and BTP: realised vol, 3-month carry and roll down, editable repo, futures fly hedge and hedged return on book and on capital.",
  EURX: "Trade-by-trade EFP gross basis and EFS invoice spreads in Eurex Schatz, Bobl, Bund, Buxl, OAT and BTP futures, with daily VWAP.",
  FIHG: "Hedge a bond position by DV01 with futures or bonds, single or fly: lots or nominal per leg and the residual risk.",
};

app.append(
  el("div", { class: "page-title" }, el("h1", {}, "Rates tools"), el("span", { class: "muted" }, "government bond futures and cash · data refreshed weekdays at 10:00 London")),
  el("nav", { class: "menu", "aria-label": "Tools" }, PAGES.filter((p) => p.code !== "HOME").map((p) =>
    el("a", { href: p.href }, el("span", { class: "code" }, p.code), el("span", { class: "name" }, p.title), el("p", {}, BLURB[p.code])))));

const snapshot = el("section", { class: "panel", style: { marginTop: "12px" } }, el("h2", {}, "Generic yields (fitted curve)"));
app.append(snapshot);

Promise.all(MARKETS.map((m) => loadJSON(`data/markets/${m.code}.json`))).then((list) => {
  const tenors = [2, 5, 10, 30];
  const at = (mk, t) => mk.nodes.find((n) => n.t === t)?.yield;
  const de = list.find((mk) => mk.market === "DE");
  const rows = list.map((mk) => {
    const y = tenors.map((t) => at(mk, t));
    return el("tr", {},
      el("td", { class: "l" }, el("a", { href: `BMNT.html#m=${mk.market}` }, mk.name)),
      ...y.map((v) => el("td", {}, v == null ? "–" : v.toFixed(3))),
      el("td", {}, fmt.s((y[2] - y[0]) * 100, 1)),
      el("td", {}, fmt.s((y[3] - y[2]) * 100, 1)),
      el("td", {}, mk.market === "DE" || mk.currency !== "€" ? "–" : fmt.s((y[2] - at(de, 10)) * 100, 1)),
      el("td", {}, mk.asOf));
  });
  snapshot.append(el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, ["Market", "2Y %", "5Y %", "10Y %", "30Y %", "2s10s bp", "10s30s bp", "10Y vs Bund bp", "As of"].map((h, i) => el("th", { class: i ? "" : "l" }, h)))),
    el("tbody", {}, rows))),
  el("p", { class: "note" }, "Nelson-Siegel curve fitted to each market's nominal bonds at the latest close; not on-the-run benchmark yields."));
}).catch((err) => snapshot.append(el("p", { class: "down" }, `Could not load data: ${err.message}`)));
