import { $, COLORS, el, fmt, plot, showError } from "../common.js";
import { field, hashState, mm, riskFrame, saveHash, store, tile } from "./common.js";
import { DEBT_DEFAULTS, debtFor, debtForm } from "./debtform.js";
import { annuity, curveFor, loadMarket, onCurve, optionPV, swapFair } from "./rates.js";

riskFrame("RFP");
const m2 = (sym, x) => mm(sym, x, 2);
const app = $("#app");

// Indicative long-dated credit spreads (bp) by rating, for a market-implied default intensity λ = spread / LGD.
// Banks price CVA off market spreads (CDS or proxy curves), not historical default rates.
const SPREAD = { AAA: 30, AA: 45, A: 70, BBB: 120, BB: 250, B: 450, CCC: 1000 };
const ILLUSTRATIVE = { swap: [10, 13, 16, 21], cap: [0.04, 0.06, 0.09, 0.12] };   // bp over mid / % over mid premium

const DEFAULTS = {
  ...DEBT_DEFAULTS, product: "swap", capK: null, vol: null, shift: 0, rating: "BBB", lgd: 60, capChg: 4, tol: 3, alloc: "prorata",
  banks: [{ name: "Bank A", share: 30, q: null }, { name: "Bank B", share: 30, q: null }, { name: "Bank C", share: 20, q: null }, { name: "Bank D", share: 20, q: null }],
};
const state = hashState(DEFAULTS);

const formBox = el("div"), tiles = el("div", { class: "tiles" }), bankBox = el("div"), chart = el("div", { class: "plot" });
const summary = el("div", { class: "tiles" }), note = el("div", { class: "copybox" }), checklist = el("ul", { class: "checklist" });

app.append(
  el("div", { class: "page-title" }, el("h1", {}, "Execution and bank quotes"),
    el("span", { class: "muted" }, "mid-market benchmark, fair credit charge and quote comparison for an amortising hedge")),
  el("div", { class: "grid hedge-layout" },
    el("section", { class: "panel" }, el("h2", {}, "Hedge being executed"), formBox),
    el("section", { class: "panel stack" }, el("h2", {}, "Mid-market benchmark"), tiles,
      el("h2", { style: { marginTop: "10px" } }, "Allocation outcome"), summary)),
  el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "Bank quotes"), bankBox),
  el("div", { class: "grid cols-2", style: { marginTop: "10px" } },
    el("section", { class: "panel" }, el("h2", {}, "Spread over mid vs fair charge"), chart),
    el("section", { class: "panel" }, el("h2", {}, "Execution checklist"), checklist)),
  el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "Post-trade transparency note"), note,
    el("div", { class: "row", style: { marginTop: "6px" } }, el("button", { class: "btn", onclick: () => navigator.clipboard?.writeText(note.textContent) }, "Copy"))),
  methodNote());

let mkt;
loadMarket().then((m) => { mkt = m; render(); }).catch((e) => showError(app, e));

// Credit valuation adjustment of a payer swap (client pays fixed) from the bank's side: the bank is exposed
// when rates fall below the fixed rate. Expected positive exposure at t ≈ σ·√t·φ(0)·(remaining annuity),
// the value of an ATM option on the remaining swap; default intensity implied by the credit spread.
function cva(per, n, vol, spreadBp, lgd) {
  const lam = spreadBp / 1e4 / lgd;
  let cvaPv = 0, prevS = 1;
  per.forEach((q) => {
    const t = Math.max(q.tE, 1e-6);
    let rem = 0;
    per.forEach((r, j) => { if (r.tS >= t - 1e-9) rem += n[j] * r.tau * r.df; });
    const epe = vol * Math.sqrt(t) * 0.3989423 * rem;
    const S = Math.exp(-lam * t);
    cvaPv += epe * (prevS - S);
    prevS = S;
  });
  return lgd * cvaPv;
}

function render() {
  saveHash(state);
  const { debt, base } = debtFor(state, mkt);
  const c = curveFor(mkt, state.ccy, state.shift);
  const per = onCurve(debt.per, c).map((q, i) => ({ ...q, out: debt.per[i].out }));
  const idx = c.idx, sym = idx.sym, swap = state.product === "swap";
  const n = base.map((x) => (x * state.hedgeRatio) / 100);
  const vol = (state.vol ?? idx.vol) / 1e4;
  const A = annuity(per, n);
  const mid = swapFair(per, n).rate;
  const capK = state.capK != null ? state.capK / 100 : Math.ceil((mid + 0.01) * 400) / 400;
  const capMid = optionPV(per, n, capK, vol, "call");
  const capLo = optionPV(per, n, capK, vol - 0.001, "call"), capHi = optionPV(per, n, capK, vol + 0.001, "call");
  const cvaPv = swap ? cva(per, n, vol, SPREAD[state.rating], state.lgd / 100) : 0;
  const cvaBp = (cvaPv / A) * 1e4;
  const fairBp = swap ? cvaBp + state.capChg : 0;
  const maxBp = fairBp + state.tol;
  const peak = Math.max(...n);

  formBox.replaceChildren(debtForm(state, render, [
    field("Product", state, "product", render, { options: [{ v: "swap", label: "Amortising swap" }, { v: "cap", label: "Amortising cap" }] }),
    ...(swap ? [] : [field("Cap strike (%)", state, "capK", render, { step: 0.25, fallback: +(capK * 100).toFixed(2) })]),
  ]), el("div", { class: "form-group" }, el("div", { class: "lbl" }, "Market and credit"),
    el("div", { class: "form" },
      field("Mid move since close (bp)", state, "shift", render, { step: 0.5, title: "Parallel move of the curve from the Eurex close to the live screen at execution" }),
      field("Normal vol (bp)", state, "vol", render, { step: 5, fallback: idx.vol }),
      field("Client rating", state, "rating", render, { options: Object.keys(SPREAD).map((v) => ({ v, label: `${v} (${SPREAD[v]}bp)` })) }),
      field("LGD (%)", state, "lgd", render, { step: 5, title: "Loss given default: senior secured project hedges rank with the lenders" }),
      field("Capital + funding (bp)", state, "capChg", render, { step: 0.5, title: "Running charge for regulatory capital and funding on top of CVA" }),
      field("Tolerance (bp)", state, "tol", render, { step: 0.5, title: "Margin over the fair charge still accepted as competitive" }),
      field("Allocation", state, "alloc", render, { options: [{ v: "prorata", label: "Pro rata to shares" }, { v: "best", label: "Competitive: best price" }] }))));

  tiles.replaceChildren(
    swap ? tile("Mid swap rate", `${(mid * 100).toFixed(4)}%`, `${idx.label} · close ${mkt.asOfIso}${state.shift ? ` ${fmt.s(state.shift, 1)}bp` : ""}`)
      : tile(`Mid cap ${(capK * 100).toFixed(2)}%`, m2(sym, capMid), `${fmt.n((capMid / peak) * 1e4, 0)}bp of peak notional`),
    swap ? tile("PV01", fmt.ccy(sym, A / 1e4), "per bp running") : tile("Vol ±10bp", `${m2(sym, capLo)} – ${m2(sym, capHi)}`, "premium range"),
    tile("Peak notional", `${sym}${fmt.n(peak / 1e6, 0)}mm`, `${state.hedgeRatio}% of debt`),
    tile("Hedge WAL", `${(per.reduce((s, q, i) => s + n[i] * q.tau, 0) / peak).toFixed(1)}y`, "notional-years / peak"),
    swap ? tile("Fair credit charge", `${fairBp.toFixed(1)}bp`, `CVA ${cvaBp.toFixed(1)} + capital ${state.capChg} · ${state.rating} at ${SPREAD[state.rating]}bp spread`)
      : tile("Credit charge", "none", "bought option: no exposure to the client"),
    tile("Accept up to", swap ? `${maxBp.toFixed(1)}bp` : `+${state.tol}bp`, swap ? `${m2(sym, (maxBp * A) / 1e4)} PV` : "running, over mid premium"));

  // ---- quotes: swap rate (%) or cap premium (mm); blank = illustrative
  const banks = state.banks;
  const quoteOf = (b, k) => (b.q != null ? b.q : swap ? (mid * 1e4 + fairBp + ILLUSTRATIVE.swap[k % 4] - 10) / 100
    : +(((capMid * (1 + ILLUSTRATIVE.cap[k % 4])) / 1e6).toFixed(3)));
  const rows = banks.map((b, k) => {
    const q = quoteOf(b, k);
    const spreadBp = swap ? q * 100 - mid * 1e4 : (((q * 1e6 - capMid) / A) * 1e4);
    const pv = swap ? (spreadBp / 1e4) * A : q * 1e6 - capMid;
    const verdict = spreadBp <= maxBp ? ["ok", "fair"] : spreadBp <= maxBp + 5 ? ["warn", "high"] : ["bad", "challenge"];
    return { b, k, q, spreadBp, pv, verdict, illus: b.q == null };
  });
  const shareSum = banks.reduce((s, b) => s + (+b.share || 0), 0);
  const bestRow = rows.reduce((a, r) => (r.spreadBp < a.spreadBp ? r : a), rows[0]);
  const upd = (k, key, v) => { banks[k][key] = key === "name" ? v : v === "" ? null : Number(v); render(); };
  const inp = (k, key, v, type = "number", step = "any") => {
    const i = el("input", { type, step, value: v ?? "" });
    i.addEventListener("change", () => upd(k, key, i.value));
    return el("td", { class: "edit" }, i);
  };
  bankBox.replaceChildren(el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, [["Bank", "l"], ["Share %"], [swap ? "Quote %" : `Premium ${sym}mm`], ["Over mid bp"], ["Cost vs mid"],
      ["vs fair bp"], ["Verdict"], [""]].map(([t, l]) => el("th", { class: l ?? "" }, t)))),
    el("tbody", {}, rows.map((r) => el("tr", { class: r === bestRow ? "best" : null },
      inp(r.k, "name", r.b.name, "text"), inp(r.k, "share", r.b.share, "number", 5),
      (() => { const td = inp(r.k, "q", r.illus ? null : r.q, "number", swap ? 0.0001 : 0.01); td.firstChild.placeholder = swap ? r.q.toFixed(4) : r.q.toFixed(3); return td; })(),
      el("td", {}, fmt.n(r.spreadBp, 1)), el("td", {}, m2(sym, r.pv * (state.alloc === "best" ? (r === bestRow ? 1 : 0) : (r.b.share || 0) / Math.max(shareSum, 1e-9)))),
      el("td", { class: r.spreadBp - fairBp > state.tol ? "neg" : "pos" }, fmt.s(r.spreadBp - fairBp, 1)),
      el("td", {}, el("span", { class: `pill ${r.verdict[0]}` }, r.verdict[1])),
      el("td", {}, el("button", { class: "btn", title: "Remove", onclick: () => { banks.splice(r.k, 1); render(); } }, "×"))))))),
  el("div", { class: "row", style: { marginTop: "6px" } },
    el("button", { class: "btn", onclick: () => { banks.push({ name: `Bank ${String.fromCharCode(65 + banks.length)}`, share: 0, q: null }); render(); } }, "+ Add bank"),
    el("button", { class: "btn", onclick: () => { banks.forEach((b) => { b.q = null; }); render(); } }, "Clear quotes"),
    shareSum !== 100 ? el("span", { class: "pill bad" }, `Shares add to ${shareSum}%, not 100%`) : null,
    rows.some((r) => r.illus) ? el("span", { class: "muted small" }, "Grey quotes are illustrative (mid + fair charge + 0–11bp); type the banks' quotes over them.") : null),
  el("p", { class: "note" }, swap ? "Cost vs mid: the bank's spread times its share of the hedge's PV01, i.e. what the client pays above mid in present value. "
    + "Project-finance hedges are usually allocated pro rata to the lenders; a competitive RFP awards the trade to the best price."
    : "Cap quotes as upfront premium; spread over mid converted to bp running over the cap's annuity."));

  // ---- allocation outcome
  const w = (r) => (state.alloc === "best" ? (r === bestRow ? 1 : 0) : (r.b.share || 0) / Math.max(shareSum, 1e-9));
  const blendBp = rows.reduce((s, r) => s + w(r) * r.spreadBp, 0);
  const cost = rows.reduce((s, r) => s + w(r) * r.pv, 0);
  const avgBp = rows.reduce((s, r) => s + r.spreadBp, 0) / rows.length;
  const proBp = rows.reduce((s, r) => s + ((r.b.share || 0) / Math.max(shareSum, 1e-9)) * r.spreadBp, 0);
  const execRate = swap ? mid + blendBp / 1e4 : null;
  summary.replaceChildren(
    swap ? tile("Executed rate", `${(execRate * 100).toFixed(4)}%`, state.alloc === "best" ? `all with ${bestRow.b.name}` : "share-weighted")
      : tile("Premium paid", m2(sym, capMid + cost), state.alloc === "best" ? bestRow.b.name : "share-weighted"),
    tile("Over mid", `${blendBp.toFixed(1)}bp`, `${m2(sym, cost)} PV`, blendBp > maxBp ? "down" : "up"),
    tile("vs fair charge", fmt.s(blendBp - fairBp, 1) + "bp", `${m2(sym, ((blendBp - fairBp) / 1e4) * A)} PV`),
    tile("Competition saves", `${(proBp - bestRow.spreadBp).toFixed(1)}bp`, `${m2(sym, ((proBp - bestRow.spreadBp) / 1e4) * A)} best vs pro rata`),
    tile("vs simple average", `${(avgBp - blendBp).toFixed(1)}bp`, `${m2(sym, ((avgBp - blendBp) / 1e4) * A)} PV`));

  // ---- chart
  plot(chart, [
    { x: rows.map((r) => r.b.name), y: rows.map((r) => r.spreadBp), type: "bar", name: "Spread over mid",
      marker: { color: rows.map((r) => (r.verdict[0] === "ok" ? "#3ddc84" : r.verdict[0] === "warn" ? "#ffd24d" : "#ff5c5c")) },
      text: rows.map((r) => r.spreadBp.toFixed(1)), textposition: "outside" },
    { x: rows.map((r) => r.b.name), y: rows.map(() => fairBp), type: "scatter", mode: "lines", name: "Fair charge", line: { color: COLORS[1], dash: "dot" } },
    { x: rows.map((r) => r.b.name), y: rows.map(() => maxBp), type: "scatter", mode: "lines", name: "Accept up to", line: { color: COLORS[0], dash: "dash" } },
  ], { yaxis: { title: { text: "bp running" }, range: [Math.min(0, ...rows.map((r) => r.spreadBp)) * 1.2, Math.max(maxBp, ...rows.map((r) => r.spreadBp)) * 1.2 + 1] } }, 300);

  // ---- checklist (per browser)
  renderChecklist();

  // ---- transparency note
  const lines = [
    `${state.product === "swap" ? "Amortising interest rate swap" : `Amortising interest rate cap, strike ${(capK * 100).toFixed(2)}%`} on ${idx.label}, `
    + `peak notional ${sym}${fmt.n(peak / 1e6, 1)}mm (${state.hedgeRatio}% of the ${sym}${state.notional}mm facility), `
    + `${per.find((q, i) => n[i])?.s.toISOString().slice(0, 10)} to ${per.filter((q, i) => n[i]).pop()?.e.toISOString().slice(0, 10)}.`,
    swap ? `Mid-market rate at execution: ${(mid * 100).toFixed(4)}% (curve close ${mkt.asOfIso}${state.shift ? `, moved ${fmt.s(state.shift, 1)}bp to execution` : ""}).`
      : `Mid-market premium: ${m2(sym, capMid)} at ${(vol * 1e4).toFixed(0)}bp normal vol.`,
    `Executed with ${state.alloc === "best" ? bestRow.b.name : rows.map((r) => `${r.b.name} (${r.b.share}%)`).join(", ")}`
    + (swap ? ` at ${(execRate * 100).toFixed(4)}%` : "") + `: ${blendBp.toFixed(1)}bp running over mid, ${m2(sym, cost)} in present value.`,
    swap ? `Fair credit and capital charge for a ${state.rating} counterparty: ${fairBp.toFixed(1)}bp; execution ${blendBp - fairBp <= state.tol ? "within" : "outside"} the `
      + `${state.tol}bp tolerance (${fmt.s(blendBp - fairBp, 1)}bp).` : "No credit charge applies to a bought cap.",
    `Best quote ${bestRow.b.name} at ${bestRow.spreadBp.toFixed(1)}bp over mid; quote range ${Math.min(...rows.map((r) => r.spreadBp)).toFixed(1)}–${Math.max(...rows.map((r) => r.spreadBp)).toFixed(1)}bp.`,
  ];
  note.textContent = lines.join("\n");
}

const STEPS = [
  "Hedging strategy and policy signed off by the client (hedge ratio, tenor, products)",
  "Hedge banks confirmed; ISDA / schedule and credit terms agreed (intercreditor ranking for project hedges)",
  "Credit approvals in place at each bank for the notional and tenor",
  "Indicative pricing round: credit charges compared with the fair range",
  "Execution date, time, notional schedule and dates confirmed with the banks and the agent",
  "Live mid checked against screen; execution call held (voice), rates recorded with timestamps",
  "Trade confirmations matched to the term sheet (dates, notionals, rate, day counts)",
  "Post-trade transparency note sent to the client",
];
function renderChecklist() {
  const saved = store.get("rfpChecklist") ?? {};
  checklist.replaceChildren(...STEPS.map((t, i) => {
    const done = saved[i];
    const box = el("input", { type: "checkbox", checked: done ? true : null, "aria-label": t });
    box.addEventListener("change", () => {
      const s = store.get("rfpChecklist") ?? {};
      if (box.checked) s[i] = new Date().toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "short", timeStyle: "short" });
      else delete s[i];
      store.set("rfpChecklist", s);
      renderChecklist();
    });
    return el("li", { class: done ? "done" : null }, box, el("span", { class: "t" }, `${i + 1}. ${t}`), el("span", { class: "when" }, done ?? ""));
  }), el("li", {}, el("button", { class: "btn", onclick: () => { store.set("rfpChecklist", {}); renderChecklist(); } }, "Reset")));
}

function methodNote() {
  return el("details", { class: "method panel" }, el("summary", {}, "Method and assumptions"), el("ul", {},
    el("li", {}, "Mid: fair rate of the amortising swap on the Eurex Clearing close, moved in parallel by the 'mid move' input to match the live screen at execution."),
    el("li", {}, "Fair credit charge = CVA + capital/funding. CVA = LGD · Σ EPE(t) · (S(t₋) − S(t)), with EPE(t) ≈ σ√t·φ(0)·remaining annuity "
      + "(the value of an at-the-money option on the rest of the swap) and survival S(t) = exp(−λt), with λ = credit spread / LGD (market-implied). "
      + "It ignores wrong-way risk, netting with other trades and collateral; banks' own charges will differ, so use it as a sense check."),
    el("li", {}, "Spreads by rating (indicative, long-dated): AAA 30, AA 45, A 70, BBB 120, BB 250, B 450, CCC 1000bp. Capital and funding (KVA, FVA) "
      + "on uncollateralised project swaps are often as large as the CVA; the flat input stands in for both."),
    el("li", {}, "Caps: a bought option leaves the bank no credit exposure to the client, so there is no credit charge; the spread is premium over mid."),
    el("li", {}, "Checklist ticks are stored only in this browser.")));
}
