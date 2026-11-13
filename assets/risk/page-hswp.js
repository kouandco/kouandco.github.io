import { $, COLORS, el, fmt, plot, showError } from "../common.js";
import { field, hashState, mm, riskFrame, saveHash, tile } from "./common.js";
import { DEBT_DEFAULTS, debtFor, debtForm } from "./debtform.js";
import {
  annuity, bachelier, curveFor, loadMarket, mean, onCurve, optionPV, quantile, runStrategy, simulateRates, stdev, swapFair, zeroCostFloor,
} from "./rates.js";

riskFrame("HSWP");
const app = $("#app");

const DEFAULTS = {
  ...DEBT_DEFAULTS, vol: null, capK: null, swCs: 12, colCs: 6, lockup: 1.1, dflt: 1.05, paths: 2000, sel: "swapH",
};
const state = hashState(DEFAULTS);

const formBox = el("div");
const tiles = el("div", { class: "tiles" });
const tableBox = el("div");
const advice = el("ul", { class: "advice" });
const charts = { profile: el("div", { class: "plot" }), dist: el("div", { class: "plot" }), payoff: el("div", { class: "plot" }), fan: el("div", { class: "plot" }) };
const scheduleBox = el("div");
const rfpLink = el("a", { class: "btn", href: "RFP.html" }, "Price the execution on RFP →");

app.append(
  el("div", { class: "page-title" }, el("h1", {}, "Debt hedging strategy"),
    el("span", { class: "muted" }, "compare hedges of an amortising loan · every input is editable · scenario saved in the URL")),
  el("div", { class: "grid hedge-layout" },
    el("section", { class: "panel" }, el("h2", {}, "Financing and hedge"), formBox),
    el("section", { class: "panel stack" }, el("h2", {}, "Hedge pricing at mid"), tiles,
      el("h2", { style: { marginTop: "10px" } }, "Recommendation"), advice, el("div", { class: "row" }, rfpLink))),
  el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "Strategies compared (click a row to chart it)"), tableBox),
  el("div", { class: "grid cols-2", style: { marginTop: "10px" } },
    el("section", { class: "panel" }, el("h2", {}, "Debt and hedge profile"), charts.profile),
    el("section", { class: "panel" }, el("h2", {}, "All-in cost of debt across simulated rate paths"), charts.dist),
    el("section", { class: "panel" }, el("h2", {}, "All-in rate per period: selected vs unhedged (5th–95th pct)"), charts.fan),
    el("section", { class: "panel" }, el("h2", {}, "Payoff: hedged index cost vs floating rate"), charts.payoff)),
  el("section", { class: "panel", style: { marginTop: "10px" } }, el("details", {}, el("summary", {}, "Debt schedule"), scheduleBox)),
  methodNote());

let mkt;
loadMarket().then((m) => { mkt = m; render(); }).catch((e) => showError(app, e));

function render() {
  saveHash(state);
  const { c, debt, base } = debtFor(state, mkt);
  const per = debt.per, idx = c.idx, sym = idx.sym;
  const h = state.hedgeRatio / 100;
  const vol = (state.vol ?? idx.vol) / 1e4;
  const fair = swapFair(per, base);
  const K = fair.rate;
  const capK = state.capK != null ? state.capK / 100 : Math.ceil((K + 0.01) * 400) / 400;
  const margin = state.margin / 1e4, swCs = state.swCs / 1e4, colCs = state.colCs / 1e4;
  const scale = (f) => base.map((x) => x * f);

  // ---- strategies
  const pct = (x) => `${Math.round(x * 100)}%`;
  const mk = (key, label, sw, cap, col) => {
    const s = { key, label, sw: sw ? scale(sw) : null, cap: cap ? scale(cap) : null, col: col ? scale(col) : null,
      swK: K, swCs, capK, capRun: 0, colKc: capK, colKf: 0, colCs, premium: 0 };
    if (s.cap) { s.premium = optionPV(per, s.cap, capK, vol, "call"); s.capRun = s.premium / annuity(per, s.cap); }
    if (s.col) s.colKf = zeroCostFloor(per, s.col, capK, vol);
    return s;
  };
  const strats = [
    mk("none", "Unhedged"),
    mk("swap100", "Swap 100%", 1),
    mk("swapH", `Swap ${pct(h)}`, h),
    mk("capH", `Cap ${pct(h)} @ ${(capK * 100).toFixed(2)}%`, 0, h),
    mk("collarH", `Zero-cost collar ${pct(h)}`, 0, 0, h),
    mk("mix", `Swap ${pct(h / 2)} + cap ${pct(h / 2)}`, h / 2, h / 2),
  ];
  if (!strats.some((s) => s.key === state.sel)) state.sel = "swapH";

  // ---- simulation
  const R = simulateRates(per, vol, state.paths);
  for (const s of strats) {
    const r = runStrategy(debt, R, state.paths, s, margin, s.key === state.sel || s.key === "none");
    Object.assign(s, r, {
      exp: mean(r.allIn), p5: quantile(r.allIn, 0.05), p95: quantile(r.allIn, 0.95), p99: quantile(r.allIn, 0.99), sd: stdev(r.allIn),
      pLock: r.minD.filter((d) => d < state.lockup).length / state.paths,
      pDef: r.minD.filter((d) => d < state.dflt).length / state.paths,
      dscr5: quantile(r.minD, 0.05),
    });
  }
  // Mark-to-market of the hedges (client's side, after the upfront premium) if curves move ±100bp.
  const mtm = (s, shift) => {
    const p2 = onCurve(per, curveFor(mkt, state.ccy, shift));
    let v = 0;
    p2.forEach((q, i) => {
      const w = q.tau * q.df;
      if (s.sw) v += s.sw[i] * w * (q.fwd - s.swK - s.swCs);
      if (s.cap) v += s.cap[i] * w * bachelier(q.fwd, s.capK, vol, q.T, "call");
      if (s.col) v += s.col[i] * w * (bachelier(q.fwd, s.colKc, vol, q.T, "call") - bachelier(q.fwd, s.colKf, vol, q.T, "put") - s.colCs);
    });
    return v - s.premium;
  };
  strats.forEach((s) => { s.dn = mtm(s, -100); s.up = mtm(s, 100); });

  // ---- form (rebuilt so derived defaults show)
  formBox.replaceChildren(debtForm(state, render, [
    field("Cap strike (%)", state, "capK", render, { step: 0.25, fallback: +(capK * 100).toFixed(2), title: "Blank: mid swap rate + 1%, rounded up to 0.25%" }),
  ]), el("div", { class: "form-group" }, el("div", { class: "lbl" }, "Pricing and risk"),
    el("div", { class: "form" },
      field("Normal vol (bp)", state, "vol", render, { step: 5, fallback: idx.vol, title: "Flat normal (bp) vol for caps, floors and the simulation" }),
      field("Swap credit (bp)", state, "swCs", render, { step: 1, title: "Credit and execution charge the hedge banks add to the swap rate" }),
      field("Collar credit (bp)", state, "colCs", render, { step: 1, title: "A sold floor creates credit exposure to the client, so collars carry a smaller charge" }),
      field("Lock-up DSCR", state, "lockup", render, { step: 0.05 }),
      field("Default DSCR", state, "dflt", render, { step: 0.05 }),
      field("Paths", state, "paths", render, { options: [500, 1000, 2000, 5000].map((v) => ({ v, label: String(v) })) }))));

  // ---- tiles
  const hedgedAvg = annuity(per, base) / annuity(per, per.map((q) => q.out));
  const swH = strats.find((s) => s.key === "swapH"), capS = strats.find((s) => s.key === "capH"), colS = strats.find((s) => s.key === "collarH");
  const pv01 = annuity(per, scale(h)) / 1e4;
  tiles.replaceChildren(
    tile("Mid swap rate", `${(K * 100).toFixed(3)}%`, `${idx.label}, hedged profile`),
    tile("All-in fixed", `${((K + swCs + margin) * 100).toFixed(3)}%`, `mid + ${state.swCs}bp credit + ${state.margin}bp margin`),
    tile(`Cap ${(capK * 100).toFixed(2)}% premium`, mm(sym, capS.premium), `${(capS.capRun * 1e4).toFixed(1)}bp running · ${fmt.pct(capS.premium / (base.reduce((a, b) => Math.max(a, b), 0) * h), 2)} of peak`),
    tile("Zero-cost floor", `${(colS.colKf * 100).toFixed(3)}%`, `for a ${(capK * 100).toFixed(2)}% cap`),
    tile("Hedge PV01", fmt.ccy(sym, pv01), `swap ${pct(h)}, per bp`),
    tile("Debt WAL", `${debt.wal.toFixed(1)}y`, `${pct(hedgedAvg)} of debt PV in hedge tenor`),
    tile("CFADS yr 1", `${sym}${state.cfads}mm`, state.cfadsAuto ? "sized for 1.35x level DS" : "input"),
    tile("Curve date", mkt.asOfIso, "Eurex Clearing close"));

  // ---- table
  const b = (x) => `${(x * 100).toFixed(2)}`;
  const terms = (s) => s.key === "none" ? "–"
    : s.key.startsWith("swap") ? `${(s.swK * 100).toFixed(3)}% + ${state.swCs}bp`
    : s.key === "capH" ? `strike ${b(s.capK)}%`
    : s.key === "collarH" ? `${b(s.colKf)}% – ${b(s.colKc)}%`
    : `${(s.swK * 100).toFixed(2)}% / cap ${b(s.capK)}%`;
  const best = (key, lowIsGood = true) => strats.reduce((a, s) => ((lowIsGood ? s[key] < a[key] : s[key] > a[key]) ? s : a));
  const bP95 = best("p95");
  tableBox.replaceChildren(el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, [
      ["Strategy", "l"], ["Terms"], ["Upfront"], ["Expected", "all-in %"], ["Best 5%", "all-in %"], ["Worst 5%", "all-in %"], ["Worst 1%", "all-in %"],
      ["Spread", "sd bp"], ["P(lock-up)"], ["P(default)"], ["Min DSCR", "5th pct"], ["MTM −100bp"], ["MTM +100bp"],
    ].map(([t, u]) => el("th", { class: u === "l" ? "l" : "" }, t, u && u !== "l" ? el("span", { class: "unit" }, ` ${u}`) : null)))),
    el("tbody", {}, strats.map((s) => el("tr", { class: s.key === state.sel ? "sel" : null, style: { cursor: "pointer" }, onclick: () => { state.sel = s.key; render(); } },
      el("td", { class: "l" }, s.label), el("td", {}, terms(s)), el("td", {}, s.premium ? mm(sym, s.premium) : "–"),
      el("td", {}, b(s.exp)), el("td", {}, b(s.p5)), el("td", { class: s === bP95 ? "pos" : "" }, b(s.p95)), el("td", {}, b(s.p99)),
      el("td", {}, (s.sd * 1e4).toFixed(0)), el("td", { class: s.pLock > 0.1 ? "neg" : "" }, fmt.pct(s.pLock, 1)),
      el("td", { class: s.pDef > 0.02 ? "neg" : "" }, fmt.pct(s.pDef, 1)), el("td", {}, isFinite(s.dscr5) ? `${s.dscr5.toFixed(2)}x` : "–"),
      el("td", { class: s.dn < 0 ? "neg" : "" }, s.key === "none" ? "–" : mm(sym, s.dn)), el("td", { class: s.up < 0 ? "neg" : "" }, s.key === "none" ? "–" : mm(sym, s.up))))))),
  el("p", { class: "note" }, `All-in = index cost of the hedged mix + margin, PV-weighted over the life of the debt, on ${state.paths} paths. `
    + "Upfront premiums are spread over the hedged notional as a running cost. P(lock-up) / P(default): share of paths where the "
    + "DSCR falls below the threshold in at least one period. MTM: value of the hedges to the client after any premium paid; negative is a "
    + "break cost, e.g. if the debt is refinanced or the asset sold."));

  // ---- advice
  const none = strats[0], sel = strats.find((s) => s.key === state.sel);
  const minExp = best("exp"), minLock = best("pLock");
  const line = (...parts) => el("li", {}, ...parts);
  advice.replaceChildren(
    line(el("b", {}, "Risk: "), `unhedged, the all-in cost ranges ${b(none.p5)}–${b(none.p95)}% (5th–95th pct) and the DSCR breaches ${state.lockup}x lock-up on `
      + `${fmt.pct(none.pLock, 0)} of paths. Rates explain ${(none.sd * 1e4).toFixed(0)}bp of spread in cost of debt.`),
    line(el("b", {}, `Swap ${pct(h)}: `), `fixes the hedged debt at ${b(K + swCs + margin)}% all-in; worst 5% falls to ${b(swH.p95)}%. `
      + `Simplest for lenders and costs only the ${state.swCs}bp credit charge over the forwards in expectation, but carries a `
      + `${mm(sym, -swH.dn)} break cost if rates fall 100bp and the debt is prepaid.`),
    line(el("b", {}, "Cap: "), `${mm(sym, capS.premium)} upfront (${(capS.capRun * 1e4).toFixed(0)}bp running) limits the index to ${b(capK)}%, keeps the `
      + "benefit if rates fall and needs no credit line or ISDA credit support, as the client owes the bank nothing after paying. Suits a likely exit or refinancing."),
    line(el("b", {}, "Collar: "), `no premium; the client pays at least ${b(colS.colKf)}% and at most ${b(capK)}% on the index. `
      + `Gives up rates below ${b(colS.colKf)}% and carries a credit charge, as the sold floor is exposure for the bank.`),
    line(el("b", {}, "On these inputs: "), `lowest tail cost (worst 5%) is ${bP95.label}; lowest expected cost ${minExp.label}; `
      + `fewest DSCR lock-ups ${minLock.label}. Project lenders usually require 75–100% of senior debt hedged for most of its life, which `
      + `favours the swap for the core and a cap or partial hedge where flexibility is worth the premium.`));

  // ---- charts
  const x = per.map((q) => q.s.toISOString().slice(0, 10));
  const hedgedOf = (s) => per.map((_, i) => ((s.sw?.[i] ?? 0) + (s.cap?.[i] ?? 0) + (s.col?.[i] ?? 0)) / 1e6);
  plot(charts.profile, [
    { x, y: per.map((q) => q.out / 1e6), type: "bar", name: "Debt outstanding", marker: { color: "#3a3a3a" } },
    { x, y: hedgedOf(sel), type: "scatter", mode: "lines", line: { shape: "hv", color: COLORS[0], width: 2 }, name: `Hedged: ${sel.label}` },
    { x, y: per.map((q) => q.fwd * 100), type: "scatter", mode: "lines", yaxis: "y2", line: { color: COLORS[1], width: 1.4 }, name: `Forward ${idx.label}` },
    { x, y: per.map(() => K * 100), type: "scatter", mode: "lines", yaxis: "y2", line: { color: COLORS[1], dash: "dot", width: 1 }, name: "Mid swap rate" },
  ], { barmode: "overlay", yaxis: { title: { text: `${sym}mm` } }, yaxis2: { overlaying: "y", side: "right", title: { text: "%" }, showgrid: false } }, 330);

  plot(charts.dist, strats.map((s, k) => ({
    y: Array.from(s.allIn, (v) => v * 100), type: "box", name: s.label, boxpoints: false, marker: { color: k ? COLORS[k - 1] : "#8c8c8c" },
    line: { width: s.key === state.sel ? 2.5 : 1.2 },
  })), { showlegend: false, yaxis: { title: { text: "all-in %" } }, xaxis: { tickfont: { size: 10 } } }, 330);

  const n = per.length;
  const band = (s, q) => per.map((q0, i) => { if (!q0.out) return null; const col = new Float64Array(state.paths); for (let p = 0; p < state.paths; p++) col[p] = s.byPeriod[p * n + i]; return 100 * quantile(col, q); });
  const unhedged = strats[0];
  plot(charts.fan, [
    { x, y: band(unhedged, 0.95), type: "scatter", mode: "lines", line: { color: "#8c8c8c", width: 0 }, showlegend: false, hoverinfo: "skip" },
    { x, y: band(unhedged, 0.05), type: "scatter", mode: "lines", fill: "tonexty", fillcolor: "rgba(140,140,140,0.18)", line: { color: "#8c8c8c", width: 0 }, name: "Unhedged 5–95%" },
    { x, y: band(sel, 0.95), type: "scatter", mode: "lines", line: { color: COLORS[0], width: 0 }, showlegend: false, hoverinfo: "skip" },
    { x, y: band(sel, 0.05), type: "scatter", mode: "lines", fill: "tonexty", fillcolor: "rgba(255,158,27,0.28)", line: { color: COLORS[0], width: 0 }, name: `${sel.label} 5–95%` },
    { x, y: band(sel, 0.5), type: "scatter", mode: "lines", line: { color: COLORS[0], width: 1.6 }, name: `${sel.label} median` },
  ], { yaxis: { title: { text: "all-in %" } } }, 330);

  const xs = [], lo = Math.min(0, K - 0.03), hi = K + 0.04;
  for (let r = lo; r <= hi + 1e-9; r += (hi - lo) / 80) xs.push(r);
  const unit = (s) => {   // per unit of hedged-period debt, ignoring amortisation
    const w = { sw: s.sw ? s.sw.find((v) => v) / base.find((v) => v) : 0, cap: s.cap ? s.cap.find((v) => v) / base.find((v) => v) : 0,
      col: s.col ? s.col.find((v) => v) / base.find((v) => v) : 0 };
    return xs.map((r) => 100 * (w.sw * (s.swK + s.swCs) + w.cap * (Math.min(r, s.capK) + s.capRun)
      + w.col * (Math.min(Math.max(r, s.colKf), s.colKc) + s.colCs) + (1 - w.sw - w.cap - w.col) * r));
  };
  plot(charts.payoff, strats.map((s, k) => ({ x: xs.map((r) => r * 100), y: unit(s), type: "scatter", mode: "lines", name: s.label,
    line: { color: k ? COLORS[k - 1] : "#8c8c8c", width: s.key === state.sel ? 2.6 : 1.3, dash: k ? "solid" : "dot" } })),
  { xaxis: { title: { text: `${idx.label} fixing %` } }, yaxis: { title: { text: "index cost %" } } }, 330);

  // ---- schedule
  const hedgedSel = hedgedOf(sel);
  const selMid = (q, i) => ((sel.sw?.[i] ?? 0) * (K + swCs) + (sel.cap?.[i] ?? 0) * (Math.min(q.fwd, capK) + sel.capRun)
    + (sel.col?.[i] ?? 0) * (Math.min(Math.max(q.fwd, sel.colKf), capK) + colCs) + (q.out - hedgedSel[i] * 1e6) * q.fwd) / q.out + margin;
  scheduleBox.replaceChildren(el("div", { class: "table-wrap tall" }, el("table", {},
    el("thead", {}, el("tr", {}, ["Start", "End", "Phase", "Outstanding", "Principal", "Hedged (sel.)", "Forward %", "DF", "CFADS", "DSCR at fwds"].map((t, i) => el("th", { class: i < 3 ? "l" : "" }, t)))),
    el("tbody", {}, per.map((q, i) => {
      const r = selMid(q, i), ds = q.out * r * q.tau + (q.dsPrin ?? 0);
      return el("tr", {}, el("td", { class: "l" }, x[i]), el("td", { class: "l" }, q.e.toISOString().slice(0, 10)), el("td", { class: "l" }, q.ops ? "ops" : "constr."),
        el("td", {}, fmt.n(q.out / 1e6, 1)), el("td", {}, fmt.n(q.prin / 1e6, 1)), el("td", {}, fmt.n(hedgedSel[i], 1)),
        el("td", {}, (q.fwd * 100).toFixed(3)), el("td", {}, q.df.toFixed(4)), el("td", {}, q.ops ? fmt.n(q.cfads / 1e6, 1) : "–"),
        el("td", {}, q.ops && ds > 0 ? `${(q.cfads / ds).toFixed(2)}x` : "–"));
    })))), el("p", { class: "note" }, `${sym}mm. Unadjusted period dates; construction-period interest assumed funded (no capitalisation). The DSCR excludes a bullet or balloon (refinanced).`));

  // ---- hand-off to RFP
  const product = sel.key === "capH" ? "cap" : "swap";
  const ratio = sel.key === "swap100" ? 100 : sel.key === "mix" ? state.hedgeRatio / 2 : state.hedgeRatio;
  const keys = Object.keys(DEBT_DEFAULTS);
  const hand = Object.fromEntries(keys.map((k) => [k, state[k]]));
  Object.assign(hand, { hedgeRatio: ratio, product, capK: +(capK * 100).toFixed(4), vol: state.vol ?? idx.vol, cfadsAuto: state.cfadsAuto });
  rfpLink.href = `RFP.html#${encodeURIComponent(JSON.stringify(hand))}`;
  rfpLink.textContent = `Price the ${product === "cap" ? "cap" : `swap (${ratio}%)`} on RFP →`;
}

function methodNote() {
  return el("details", { class: "method panel" }, el("summary", {}, "Method and assumptions"), el("ul", {},
    el("li", {}, "Curves: Eurex Clearing end-of-day discount factors. GBP: SONIA projection and discounting; EUR: 6M Euribor projection, €STR discounting; "
      + "USD: SOFR. Forward for each loan period from the projection curve; for quarterly EUR periods this is the 6M curve's forward (no 3s6s basis)."),
    el("li", {}, "Swap: fair fixed rate = Σ N·τ·F·DF / Σ N·τ·DF over the hedged notional profile (same dates as the loan). The credit charge is added on top."),
    el("li", {}, "Caps and floors: Bachelier (normal) model with one flat normal vol. Compounded overnight rates use the Lyashenko–Mercurio expiry "
      + "(start + a third of the accrual). Market cap vols have a term structure and skew; the default is an editable round number, not a quote."),
    el("li", {}, "Simulation: one-factor normal model, r_i = F_i + σ·W(T_i), so paths are centred on the forwards and the simulated cap payoff matches the "
      + "premium. No mean reversion, so long-dated tails are wide; no term premium, so the forward is the central case."),
    el("li", {}, "Debt: drawn evenly over construction (interest assumed funded), then repaid bullet, straight-line, as a level annuity, or sculpted so "
      + "that debt service = CFADS / DSCR with the DSCR solved to repay the debt by maturity at the mid swap rate + margin."),
    el("li", {}, "DSCR per period = CFADS / (interest + principal) at the simulated rate. Not modelled: DSRA, cash sweeps, tax, hedge credit lines, "
      + "breakage on prepayment, inflation-linked revenue correlation with rates.")));
}
