import { $, COLORS, dataTable, el, fmt, frame, loadJSON, plot, segmented, showError } from "./common.js";
import { linear } from "./bond.js";
import { curveEditor } from "./curve-editor.js";

frame("IRS");
const app = $("#app");
const DAY = 864e5;

// ---------------------------------------------------------------- conventions

// Market-standard swaps per index: the curve that projects the floating rate, the curve that discounts,
// and each leg's payment frequency (months) and day count. Overnight indices compound daily, which the
// projection curve's discount factors already price exactly: forward = (DF(start) / DF(end) − 1) / τ.
const INDICES = {
  USD: [
    { code: "SOFR", label: "SOFR (compounded)", proj: "USD.SOFR.1D", disc: "USD.SOFR.1D", fixed: [12, "ACT/360"], float: [12, "ACT/360"] },
    { code: "FF", label: "Fed funds (compounded)", proj: "USD.FEDFUNDS.1D", disc: "USD.FEDFUNDS.1D", fixed: [12, "ACT/360"], float: [12, "ACT/360"] },
  ],
  EUR: [
    { code: "E6M", label: "6M Euribor", proj: "EUR.EURIBOR.6M", disc: "EUR.ESTR.1D", fixed: [12, "30/360"], float: [6, "ACT/360"] },
    { code: "ESTR", label: "€STR (compounded)", proj: "EUR.ESTR.1D", disc: "EUR.ESTR.1D", fixed: [12, "ACT/360"], float: [12, "ACT/360"] },
  ],
};
const DAY_COUNTS = ["ACT/360", "ACT/365F", "30/360", "ACT/ACT"];
const FREQS = [{ m: 1, label: "Monthly" }, { m: 3, label: "Quarterly" }, { m: 6, label: "Semi-annual" }, { m: 12, label: "Annual" }];
const TENORS = [1, 2, 3, 5, 7, 10, 15, 20, 30];   // curve points (par swap rates)
const SWAP_TENORS = ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"];

const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
function addMonths(d, n) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}
// Modified following over weekends (holiday calendars are not applied).
function adjust(d) {
  let x = d;
  while (x.getUTCDay() % 6 === 0) x = addDays(x, 1);
  if (x.getUTCMonth() !== d.getUTCMonth()) { x = d; while (x.getUTCDay() % 6 === 0) x = addDays(x, -1); }
  return x;
}
function addBusinessDays(d, n) {
  let x = d;
  while (n > 0) { x = addDays(x, 1); if (x.getUTCDay() % 6) n--; }
  return x;
}

function yearFraction(a, b, dc) {
  if (dc === "ACT/360") return (b - a) / DAY / 360;
  if (dc === "ACT/365F") return (b - a) / DAY / 365;
  if (dc === "30/360") {
    const d1 = Math.min(a.getUTCDate(), 30), d2 = b.getUTCDate() === 31 && d1 === 30 ? 30 : b.getUTCDate();
    return (360 * (b.getUTCFullYear() - a.getUTCFullYear()) + 30 * (b.getUTCMonth() - a.getUTCMonth()) + d2 - d1) / 360;
  }
  // ACT/ACT ISDA: days in each calendar year over that year's length.
  let t = 0, x = a;
  while (x < b) {
    const next = new Date(Date.UTC(x.getUTCFullYear() + 1, 0, 1));
    const end = next < b ? next : b;
    const len = (Date.UTC(x.getUTCFullYear() + 1, 0, 1) - Date.UTC(x.getUTCFullYear(), 0, 1)) / DAY;
    t += (end - x) / DAY / len;
    x = end;
  }
  return t;
}

// Periods rolled back from the end date (a short first period if the term is not a whole number of periods).
function schedule(start, end, months) {
  const ends = [];
  for (let k = 0; ; k++) {
    const d = addMonths(end, -months * k);
    if (d <= addDays(start, 7)) break;   // a stub under a week is merged into the next period
    ends.unshift(d);
  }
  const unadj = [start, ...ends];
  return unadj.slice(1).map((e, i) => ({ start: i ? adjust(unadj[i]) : start, end: adjust(e) }));
}

// ---------------------------------------------------------------- curves

function baseCurve(asOf, dfs) {
  const days = Object.keys(dfs).map(Number).sort((a, b) => a - b);
  const logs = days.map((d) => Math.log(dfs[d]));
  if (days[0] !== 0) { days.unshift(0); logs.unshift(0); }
  const last = days.length - 1;
  return (date) => {
    const x = (date - asOf) / DAY;
    if (x <= 0) return 1;
    if (x >= days[last]) return Math.exp((logs[last] * x) / days[last]);
    let lo = 0, hi = last;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (days[mid] <= x) lo = mid; else hi = mid; }
    return Math.exp(logs[lo] + ((x - days[lo]) / (days[hi] - days[lo])) * (logs[hi] - logs[lo]));
  };
}

// A curve moved by a continuously compounded zero-rate shift z(t) (decimal), linear between the curve
// points and flat beyond, plus an optional parallel shift: DF'(t) = DF(t) · exp(−(z(t) + p) · t).
function shifted(asOf, df, z, parallel = 0) {
  const zf = linear(TENORS, z);
  return (date) => {
    const t = (date - asOf) / DAY / 365.25;
    return t <= 0 ? 1 : df(date) * Math.exp(-(zf(t) + parallel) * t);
  };
}

// ---------------------------------------------------------------- pricing

// Both legs of a swap on notional 1. Returns PVs per unit notional, the annuities and the cashflows.
function legs(c, spec) {
  const { proj, disc } = c;
  const d0 = disc(spec.start);
  const fixed = schedule(spec.start, spec.end, spec.fixedFreq).map((p) => {
    const tau = yearFraction(p.start, p.end, spec.fixedDc), df = disc(p.end) / d0;
    return { ...p, tau, df, rate: spec.fixed / 100, cf: tau * spec.fixed / 100, pv: tau * spec.fixed / 100 * df };
  });
  const float = schedule(spec.start, spec.end, spec.floatFreq).map((p) => {
    const tau = yearFraction(p.start, p.end, spec.floatDc), df = disc(p.end) / d0;
    const fwd = (proj(p.start) / proj(p.end) - 1) / tau;
    const rate = fwd + spec.spread / 1e4;
    return { ...p, tau, df, fwd, rate, cf: rate * tau, pv: rate * tau * df };
  });
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  return {
    fixed, float,
    pvFixed: sum(fixed, (p) => p.pv), pvFloat: sum(float, (p) => p.pv),
    annFixed: sum(fixed, (p) => p.tau * p.df), annFloat: sum(float, (p) => p.tau * p.df),
    pvFloat0: sum(float, (p) => p.fwd * p.tau * p.df),
  };
}

// Par rate of the index's standard swap from `start` over `years`.
function parRate(c, idx, start, years) {
  const l = legs(c, { start, end: addMonths(start, 12 * years), fixed: 0, spread: 0,
    fixedFreq: idx.fixed[0], fixedDc: idx.fixed[1], floatFreq: idx.float[0], floatDc: idx.float[1] });
  return (100 * l.pvFloat0) / l.annFixed;
}

// ---------------------------------------------------------------- page

try {
  const data = await loadJSON("data/curves.json");
  start(data);
} catch (err) {
  showError(app, err);
}

function start(data) {
  const asOf = parse(data.asOf);
  const spot = addBusinessDays(asOf, 2);
  const base = Object.fromEntries(Object.entries(data.curves).map(([k, v]) => [k, baseCurve(asOf, v)]));

  const state = {
    ccy: "EUR", idx: "E6M", notional: 10_000_000, pay: true, solve: "fixed",
    start: spot, end: addMonths(spot, 60), tenor: "5Y",
    fixed: null, spread: 0, fixedFreq: 12, fixedDc: "30/360", floatFreq: 6, floatDc: "ACT/360",
    z: {},        // index code -> zero-rate shift at each curve point (decimal)
    target: {},   // index code -> edited par rates at the curve points (%), null = market
  };
  const index = () => INDICES[state.ccy].find((i) => i.code === state.idx);
  const zOf = () => (state.z[state.idx] ??= TENORS.map(() => 0));
  const curvesFor = (parallel = 0) => {
    const i = index(), z = zOf();
    return { proj: shifted(asOf, base[i.proj], z, parallel), disc: shifted(asOf, base[i.disc], z, parallel) };
  };
  const marketPars = () => TENORS.map((t) => parRate({ proj: base[index().proj], disc: base[index().disc] }, index(), spot, t));
  const currentPars = () => TENORS.map((t) => parRate(curvesFor(), index(), spot, t));

  // Solve the zero-rate shifts so that every curve point prices at its target par rate (Newton on each
  // point's own shift, repeated until all points agree to 1e-7%).
  function solveCurve() {
    const target = state.target[state.idx];
    const z = zOf();
    if (!target) { z.fill(0); return; }
    for (let it = 0; it < 30; it++) {
      const pars = currentPars();
      let worst = 0;
      for (let i = 0; i < TENORS.length; i++) {
        const err = target[i] - pars[i];
        worst = Math.max(worst, Math.abs(err));
        const h = 1e-5;
        z[i] += h;
        const slope = (parRate(curvesFor(), index(), spot, TENORS[i]) - pars[i]) / h;
        z[i] -= h;
        z[i] += err / (slope || 100);
      }
      if (worst < 1e-7) break;
    }
  }

  const spec = () => ({ start: state.start, end: state.end, fixed: state.fixed, spread: state.spread,
    fixedFreq: state.fixedFreq, fixedDc: state.fixedDc, floatFreq: state.floatFreq, floatDc: state.floatDc });
  const sign = () => (state.pay ? 1 : -1);
  function price(c = curvesFor()) {
    const l = legs(c, spec());
    const N = state.notional;
    return { ...l, npv: sign() * N * (l.pvFloat - l.pvFixed), par: (100 * l.pvFloat) / l.annFixed, N };
  }

  // ---- layout
  const fields = el("div", { class: "grid cols-3" });
  const results = el("div", { class: "tiles", style: { marginTop: "10px" } });
  const message = el("p", { class: "small" });
  const editorHost = el("div");
  const nodesHost = el("div");
  const fwdChart = el("div", { class: "plot" });
  const flowsHost = el("div");
  app.append(
    el("div", { class: "page-title" }, el("h1", {}, "Swap Pricer"),
      el("span", { class: "muted" }, `price a USD or EUR interest rate swap off Eurex Clearing's curves of ${data.asOf} · every field is an input`)),
    el("section", { class: "panel" }, el("h2", {}, "Swap"), fields, message, results),
    el("div", { class: "grid cols-2", style: { marginTop: "10px" } },
      el("section", { class: "panel" }, el("h2", {}, "Swap curve: par rates (drag to edit)"), editorHost, nodesHost),
      el("section", { class: "panel" }, el("h2", {}, "Floating rate per period and discount factor"), fwdChart)),
    el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "Cashflows"), flowsHost),
    method(data));

  const editor = curveEditor({
    xTitle: "Tenor (years)", yTitle: "Par swap rate (%)", yDigits: 3, step: 0.001,
    xTicks: TENORS.map((t) => ({ x: t, label: `${t}Y` })),
    onChange: (pts, i) => {
      const target = (state.target[state.idx] ??= currentPars());
      target[i] = pts[i].y;
      solveCurve();
      render({ keepCurve: true });
    },
  });
  editorHost.append(editor.node);

  // ---- inputs (each is also an output: recomputed values are written back unless the field is being edited)
  const inputs = {};
  const numberField = (key, label, attrs, onSet) => {
    const input = el("input", { type: "number", step: "any", ...attrs, "aria-label": label });
    input.addEventListener("change", () => { const v = +input.value; if (isFinite(v) && input.value !== "") onSet(v); else render(); });
    inputs[key] = input;
    return el("label", { class: "row", style: { gap: "6px", justifyContent: "space-between" } }, label, input);
  };
  const selectField = (key, label, options, onSet, aria = label) => {
    const s = el("select", { "aria-label": aria });
    s.addEventListener("change", () => onSet(s.value));
    inputs[key] = s;
    s.setOptions = (opts, value) => s.replaceChildren(...opts.map(([v, t]) => el("option", { value: v, selected: String(v) === String(value) || null }, t)));
    s.setOptions(options, null);
    return el("label", { class: "row", style: { gap: "6px", justifyContent: "space-between" } }, label, s);
  };
  const dateField = (key, label, onSet) => {
    const input = el("input", { type: "date", "aria-label": label });
    input.addEventListener("change", () => { if (input.value) onSet(parse(input.value)); });
    inputs[key] = input;
    return el("label", { class: "row", style: { gap: "6px", justifyContent: "space-between" } }, label, input);
  };
  const legPanel = (title, ...rows) => el("div", { class: "stack" }, el("div", { class: "amber" }, title), ...rows);

  fields.append(
    legPanel("Trade",
      selectField("ccy", "Currency", [["USD", "USD"], ["EUR", "EUR"]], (v) => { state.ccy = v; useIndex(INDICES[v][0].code); }),
      selectField("idx", "Floating index", [], (v) => useIndex(v)),
      selectField("pay", "Direction", [["pay", "Pay fixed"], ["rec", "Receive fixed"]], (v) => { state.pay = v === "pay"; render(); }),
      numberField("notional", "Notional (mm)", { step: 1, min: 0 }, (v) => { state.notional = v * 1e6; render(); }),
      dateField("start", "Start date", (d) => { state.start = d; if (state.tenor !== "custom") state.end = addMonths(d, 12 * parseInt(state.tenor)); render(); }),
      selectField("tenor", "Tenor", [...SWAP_TENORS.map((t) => [t, t]), ["custom", "custom"]], (v) => {
        state.tenor = v;
        if (v !== "custom") state.end = addMonths(state.start, 12 * parseInt(v));
        render();
      }),
      dateField("end", "End date", (d) => { state.end = d; state.tenor = "custom"; render(); })),
    legPanel("Fixed leg",
      numberField("fixed", "Fixed rate %", { step: 0.0001 }, (v) => { state.fixed = v; render(); }),
      selectField("fixedFreq", "Frequency", FREQS.map((f) => [f.m, f.label]), (v) => { state.fixedFreq = +v; render(); }, "Fixed leg frequency"),
      selectField("fixedDc", "Day count", DAY_COUNTS.map((d) => [d, d]), (v) => { state.fixedDc = v; render(); }, "Fixed leg day count")),
    legPanel("Floating leg",
      numberField("spread", "Spread over index bp", { step: 0.1 }, (v) => { state.spread = v; render(); }),
      numberField("float1", "First-period rate %", { step: 0.0001 }, (v) => { state.spread = (v - last.float[0].fwd * 100) * 100; render(); }),
      selectField("floatFreq", "Frequency", FREQS.map((f) => [f.m, f.label]), (v) => { state.floatFreq = +v; render(); }, "Floating leg frequency"),
      selectField("floatDc", "Day count", DAY_COUNTS.map((d) => [d, d]), (v) => { state.floatDc = v; render(); }, "Floating leg day count"),
      el("div", { class: "amber", style: { marginTop: "8px" } }, "Value"),
      numberField("npv", "NPV", { step: 1000 }, (v) => solveFor(v)),
      selectField("solve", "Editing NPV solves for", [["fixed", "Fixed rate"], ["spread", "Floating spread"], ["notional", "Notional"]],
        (v) => { state.solve = v; })));

  function useIndex(code) {
    state.idx = code;
    const i = index();
    [state.fixedFreq, state.fixedDc] = i.fixed;
    [state.floatFreq, state.floatDc] = i.float;
    state.fixed = null;    // re-strike at par on the new curve
    state.spread = 0;
    render();
  }

  // NPV typed in: solve for the chosen field. NPV is linear in each of them.
  function solveFor(target) {
    const p = price();
    const N = state.notional, s = sign();
    if (state.solve === "fixed") {
      state.fixed = (100 * (p.pvFloat - target / (s * N))) / p.annFixed;
    } else if (state.solve === "spread") {
      state.spread = (1e4 * (target / (s * N) + p.pvFixed - p.pvFloat)) / p.annFloat;
    } else {
      // At (or very near) par the NPV hardly depends on notional: refuse rather than return an absurd size.
      const perUnit = p.npv / N;
      if (Math.abs(perUnit) < 1e-5) {
        render();
        message.className = "small down";
        message.textContent = "The swap is at par (NPV under 10 per million notional), so no notional gives that NPV: move the fixed rate or spread off par first.";
        return;
      }
      state.notional = target / perUnit;
    }
    render();
  }

  // ---- render
  let last = null;
  function render({ keepCurve = false } = {}) {
    message.className = "small"; message.textContent = "";
    if (state.start < asOf) {
      state.start = spot;
      message.className = "small down";
      message.textContent = `Start date moved to spot (${iso(spot)}): the curves begin on ${data.asOf}, so past fixings cannot be priced.`;
    }
    if (state.end <= addDays(state.start, 7)) state.end = addMonths(state.start, 12);
    if (state.fixed == null) state.fixed = Math.round(price().par * 1e4) / 1e4;
    const p = price();
    last = p;
    const dv = price(curvesFor(1e-4)).npv - p.npv;

    // Rendering happens only when an edit is committed, so every field (the one just edited too) shows the result.
    const set = (k, v) => { inputs[k].value = v; };
    inputs.ccy.value = state.ccy;
    inputs.idx.setOptions(INDICES[state.ccy].map((i) => [i.code, i.label]), state.idx);
    inputs.pay.value = state.pay ? "pay" : "rec";
    set("notional", +(state.notional / 1e6).toFixed(6));
    set("start", iso(state.start));
    set("end", iso(state.end));
    inputs.tenor.value = state.tenor;
    set("fixed", state.fixed.toFixed(4));
    inputs.fixedFreq.value = state.fixedFreq;
    inputs.fixedDc.value = state.fixedDc;
    set("spread", state.spread.toFixed(2));
    set("float1", (p.float[0].rate * 100).toFixed(4));
    inputs.floatFreq.value = state.floatFreq;
    inputs.floatDc.value = state.floatDc;
    set("npv", Math.round(p.npv));
    inputs.solve.value = state.solve;

    const ccy = state.ccy === "USD" ? "$" : "€";
    const tile = (k, v, n) => el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v), n ? el("div", { class: "n" }, n) : null);
    results.replaceChildren(
      tile("NPV", fmt.ccy(ccy, p.npv), `${state.pay ? "pay" : "receive"} fixed ${state.fixed.toFixed(4)}%`),
      tile("Par rate", `${p.par.toFixed(4)}%`, `fixed rate for NPV 0 at spread ${fmt.n(state.spread, 1)}bp`),
      tile("Fixed − par", `${fmt.s((state.fixed - p.par) * 100, 2)}bp`, ""),
      tile("PV01", fmt.ccy(ccy, p.N * p.annFixed * 1e-4), "value of 1bp on the fixed rate"),
      tile("DV01", fmt.ccy(ccy, dv), "NPV change for curves +1bp"),
      tile("Fixed leg PV", fmt.ccy(ccy, p.N * p.pvFixed), `${p.fixed.length} payments`),
      tile("Floating leg PV", fmt.ccy(ccy, p.N * p.pvFloat), `${p.float.length} payments`));

    renderCurve(!keepCurve);   // while a point is dragged, the editor redraws itself
    renderForwards(p);
    renderFlows(p, ccy);
  }

  function renderCurve(redrawEditor = true) {
    const market = marketPars();
    const now = currentPars();
    if (redrawEditor) {
      editor.update(TENORS.map((t, i) => ({ x: t, y: now[i], label: `${t}Y` })),
        TENORS.map((t, i) => ({ x: t, y: market[i], name: `market ${t}Y ${market[i].toFixed(3)}%`, color: "#5fa8ff" })));
    }
    const table = dataTable([
      { key: "t", label: "Tenor", fmt: (r) => `${r.t}Y`, left: true },
      { key: "m", label: "Market", unit: "%", fmt: (r) => r.market.toFixed(4) },
      { key: "y", label: "Curve", unit: "%", edit: { get: (r) => r.now.toFixed(4), set: (r, v) => {
        const target = (state.target[state.idx] ??= currentPars());
        target[r.i] = +v;
        solveCurve();
        render();
      }, changed: (r) => Math.abs(r.now - r.market) > 5e-5 } },
      { key: "d", label: "Change", unit: "bp", fmt: (r) => fmt.s((r.now - r.market) * 100, 1), cls: (r) => (r.now > r.market + 5e-5 ? "neg" : r.now < r.market - 5e-5 ? "pos" : "") },
    ]);
    table.node.classList.remove("tall");
    table.update(TENORS.map((t, i) => ({ t, i, market: market[i], now: now[i] })));
    const idx = index();
    nodesHost.replaceChildren(table.node,
      el("div", { class: "row", style: { marginTop: "6px" } },
        el("button", { class: "btn", onclick: () => { state.target[state.idx] = null; solveCurve(); render(); } }, "Reset to market"),
        el("span", { class: "note" }, `Spot-starting par rates of the standard ${idx.label} swap: fixed ${FREQS.find((f) => f.m === idx.fixed[0]).label.toLowerCase()} ${idx.fixed[1]}, `
          + `floating ${FREQS.find((f) => f.m === idx.float[0]).label.toLowerCase()} ${idx.float[1]}; projection ${idx.proj}, discounting ${idx.disc}. `
          + "Blue dots: market. Editing a rate moves both curves by a zero-rate shift solved so that every tenor reprices to its rate.")));
  }

  function renderForwards(p) {
    plot(fwdChart, [
      { x: p.float.map((f) => iso(f.start)), y: p.float.map((f) => f.fwd * 100), mode: "lines+markers", line: { shape: "hv", color: COLORS[0] },
        name: `${index().label} forward (%)`, hovertemplate: "%{x}: %{y:.4f}%<extra></extra>" },
      { x: p.fixed.map((f) => iso(f.end)), y: p.fixed.map((f) => f.df), mode: "lines", yaxis: "y2", line: { color: COLORS[1], dash: "dot" },
        name: "Discount factor", hovertemplate: "%{x}: %{y:.5f}<extra></extra>" },
    ], { yaxis: { title: { text: "%" }, tickformat: ".2f" }, yaxis2: { title: { text: "DF" }, overlaying: "y", side: "right", showgrid: false } }, 360);
  }

  function renderFlows(p, ccy) {
    const N = p.N, s = sign();
    const rows = [
      ...p.fixed.map((f) => ({ leg: "Fixed", ...f, cash: -s * N * f.cf, pvN: -s * N * f.pv })),
      ...p.float.map((f) => ({ leg: "Floating", ...f, cash: s * N * f.cf, pvN: s * N * f.pv })),
    ].sort((a, b) => a.end - b.end || (a.leg < b.leg ? -1 : 1));
    flowsHost.replaceChildren(el("div", { class: "table-wrap tall" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Leg", "Accrual start", "Payment", "Year fraction", "Rate %", "Cashflow", "Discount factor", "PV"]
        .map((h, i) => el("th", { class: i < 3 ? "l" : "" }, h)))),
      el("tbody", {}, rows.map((r) => el("tr", {},
        el("td", { class: `l ${r.leg === "Fixed" ? "amber" : ""}` }, r.leg), el("td", { class: "l" }, iso(r.start)), el("td", { class: "l" }, iso(r.end)),
        el("td", {}, r.tau.toFixed(5)), el("td", {}, (r.rate * 100).toFixed(4)),
        el("td", { class: r.cash < 0 ? "neg" : "pos" }, fmt.ccy(ccy, r.cash)), el("td", {}, r.df.toFixed(6)),
        el("td", { class: r.pvN < 0 ? "neg" : "pos" }, fmt.ccy(ccy, r.pvN))))))),
      el("p", { class: "note" }, `Signed from your side (${state.pay ? "paying fixed, receiving floating" : "receiving fixed, paying floating"}). `
        + "Floating rates are forwards from the projection curve plus the spread; payment dates are the accrual end dates, rolled modified following over weekends."));
  }

  render();
}

function method(data) {
  return el("details", { class: "method" }, el("summary", {}, "Method and sources"), el("ul", {},
    el("li", {}, "Curves: end-of-day discount factors published by Eurex Clearing (", el("a", { href: data.source }, "EurexOTC Clear settlement prices"),
      `) for ${data.asOf}: USD SOFR and Fed funds, EUR €STR and 6M Euribor. 6M Euribor swaps are projected on the 6M Euribor curve and discounted on €STR; overnight-index swaps use one curve for both.`),
    el("li", {}, "Fixed leg PV = notional × fixed rate × Σ year fraction × DF. Floating leg PV = notional × Σ (forward + spread) × year fraction × DF, forward = (DF_proj(start) ÷ DF_proj(end) − 1) ÷ year fraction, "
      + "which for a daily-compounded overnight index is the compounded rate the curve implies. NPV = floating − fixed when paying fixed."),
    el("li", {}, "Typing an NPV solves for the fixed rate, the floating spread or the notional; the first-period floating rate sets the spread. PV01 = notional × fixed-leg annuity × 1bp; DV01 reprices with both curves shifted up 1bp."),
    el("li", {}, "Editing the curve: the edited par rates are matched by a zero-rate shift at each tenor (linear between tenors, flat beyond) applied to both the projection and discount curve, so the basis between them is kept."),
    el("li", {}, "Simplifications: weekend-only business days (no holiday calendars), no payment lag or observation shift on overnight legs, start dates from the curve date onwards (no past fixings).")));
}
