import { $, COLORS, el, fmt, plot, showError } from "../common.js";
import { RISK_PAGES, riskFrame } from "./common.js";
import { addMonths, curveFor, loadMarket, parSwap } from "./rates.js";
import { corr, forward, last, loadFX, returns, series, vol } from "./fxdata.js";

riskFrame("RISK");
const app = $("#app");

const BLURB = {
  HSWP: "Hedge a project or acquisition loan: amortising swap, cap, zero-cost collar or a mix, priced off the SONIA, Euribor or SOFR curve. "
    + "Simulated cost of debt, DSCR covenant risk and break cost per strategy, with a written recommendation.",
  RFP: "Mid-market price of the hedge being executed, bank quotes against mid in bp running and PV, the fair credit charge for the "
    + "client's rating, pro-rata or competitive allocation, execution-day checklist and a post-trade transparency note.",
  FXHG: "Fund-level FX hedging for a PE or credit fund: hedge ratio against FX volatility and carry, the cash needed to settle "
    + "rolling forwards in a stress, and the spread of fund IRR hedged and unhedged.",
};

app.append(
  el("div", { class: "page-title" }, el("h1", {}, "Risk advisory tools"),
    el("span", { class: "muted" }, "interest rate and FX hedging for financings and funds: strategy, pricing, execution")),
  el("nav", { class: "menu", "aria-label": "Tools" }, RISK_PAGES.filter((p) => p.code !== "RISK").map((p) =>
    el("a", { href: p.href }, el("span", { class: "code" }, p.code), el("span", { class: "name" }, p.title), el("p", {}, BLURB[p.code])))));

const swaps = el("section", { class: "panel" }, el("h2", {}, "Par swap rates"));
const fwds = el("section", { class: "panel" }, el("h2", {}, "Forward curves (what a swap locks in, period by period)"));
const fxp = el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "FX: spot, realised vol and forwards"));
app.append(el("div", { class: "grid cols-2", style: { marginTop: "12px" } }, swaps, fwds), fxp);

const TENORS = [1, 2, 3, 5, 7, 10, 15, 20, 25, 30];

loadMarket().then((mkt) => {
  const estr = { ...curveFor(mkt, "EUR"), proj: mkt.curves["EUR.ESTR.1D"], idx: { dc: 360, rfr: true } };
  const rows = [
    { name: "GBP SONIA", c: curveFor(mkt, "GBP"), args: [12, 12] },
    { name: "EUR 6M Euribor", c: curveFor(mkt, "EUR"), args: [12, 6, "30/360"] },
    { name: "EUR €STR", c: estr, args: [12, 12] },
    { name: "USD SOFR", c: curveFor(mkt, "USD"), args: [12, 12] },
  ].map((r) => ({ ...r, rates: TENORS.map((t) => 100 * parSwap(r.c, t, ...r.args)) }));
  const i2 = TENORS.indexOf(2), i10 = TENORS.indexOf(10), i30 = TENORS.indexOf(30);
  swaps.append(el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, ["Index", ...TENORS.map((t) => `${t}Y`), "2s10s", "10s30s"].map((h, i) => el("th", { class: i ? "" : "l" }, h)))),
    el("tbody", {}, rows.map((r) => el("tr", {},
      el("td", { class: "l" }, r.name), ...r.rates.map((x) => el("td", {}, x.toFixed(3))),
      el("td", {}, fmt.s((r.rates[i10] - r.rates[i2]) * 100, 1)), el("td", {}, fmt.s((r.rates[i30] - r.rates[i10]) * 100, 1))))))),
  el("p", { class: "note" }, `Eurex Clearing settlement curves of ${mkt.asOfIso}, spot start. Annual fixed vs the compounded overnight rate; `
    + "EUR 6M: annual 30/360 fixed vs 6M Euribor, discounted on €STR. Spreads in bp."));

  const traces = [
    ["SONIA 3M", curveFor(mkt, "GBP"), 3], ["€STR 3M", estr, 3], ["Euribor 6M", curveFor(mkt, "EUR"), 6], ["SOFR 3M", curveFor(mkt, "USD"), 3],
  ].map(([name, c, m], k) => {
    const x = [], y = [];
    for (let i = 0; i < 120; i++) {
      const s = addMonths(mkt.spot, 3 * i), e = addMonths(s, m);
      x.push(s.toISOString().slice(0, 10));
      y.push(100 * (c.proj(s) / c.proj(e) - 1) / ((e - s) / 864e5 / c.idx.dc));
    }
    return { x, y, name, type: "scatter", mode: "lines", line: { color: COLORS[k], width: 1.6 } };
  });
  const div = el("div", { class: "plot" });
  fwds.append(div, el("p", { class: "note" }, "Forward rate for each future period implied by today's curve. A swap's fixed rate is the "
    + "notional- and discount-weighted average of these over the hedged periods, which is why amortisation shape changes the rate."));
  plot(div, traces, { yaxis: { title: { text: "%" } } }, 300);

  return loadFX().then((fx) => {
    const PAIRS = [["EUR", "USD"], ["GBP", "USD"], ["EUR", "GBP"], ["USD", "JPY"], ["USD", "CHF"], ["USD", "SGD"], ["USD", "AED"]];
    const ser = PAIRS.map(([b, q]) => series(fx, b, q));
    const rows2 = PAIRS.map(([b, q], k) => {
      const s = ser[k], S = last(s), prev = s[s.length - 2];
      const [r] = returns([s]);
      const curve = ["EUR", "USD", "GBP"].includes(b) && ["EUR", "USD", "GBP"].includes(q);
      const F = curve ? forward(mkt, S, b, q, 12) : null;
      const dp = q === "JPY" ? 100 : 1e4;
      return el("tr", {},
        el("td", { class: "l" }, `${b}${q}`), el("td", {}, S.toFixed(q === "JPY" ? 2 : 4)),
        el("td", { class: (S / prev - 1) > 0 ? "pos" : "neg" }, fmt.s(100 * (S / prev - 1), 2)),
        el("td", {}, q === "AED" ? "peg" : fmt.n(100 * vol(r), 1)),
        el("td", {}, F ? F.toFixed(4) : "–"), el("td", {}, F ? fmt.s((F - S) * dp, 1) : "–"),
        el("td", {}, F ? fmt.s(100 * (F / S - 1), 2) : "–"));
    });
    const [rEU, rGU] = returns([ser[0], ser[1]]);
    fxp.append(el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Pair", "Spot", "1d %", "1y vol %", "12m fwd", "12m pts", "Fwd vs spot %"].map((h, i) => el("th", { class: i ? "" : "l" }, h)))),
      el("tbody", {}, rows2))),
    el("p", { class: "note" }, `ECB reference rates of ${fx.asOf}. Vol: realised, last 260 fixings. Forwards by covered interest parity on the `
      + `OIS curves (SOFR, €STR, SONIA), no cross-currency basis. Positive forward-vs-spot: selling the first currency forward `
      + `(e.g. a USD fund hedging EUR assets) earns the rate differential; negative: it costs. EURUSD–GBPUSD correlation over the year: ${corr(rEU, rGU).toFixed(2)}. AED is derived from USD at the 3.6725 peg.`));
  });
}).catch((e) => showError(app, e));
