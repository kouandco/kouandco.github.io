import { $, COLORS, MARKETS, el, fmt, frame, heat, loadJSON, plot, segmented, showError } from "./common.js";
import { parseDate, pricer } from "./bond.js";

frame("GP");
const app = $("#app");

// Series keys (also stored in the URL):
//   B|market|id|y·p·a     bond yield, price or asset swap spread
//   G|market|tenor|y·p·a  generic: the current benchmark bond at that tenor
//   S|label               par swap rate          F|contract|expiry           Eurex futures daily VWAP
//   X|contract|expiry|isin gross basis           I|contract|expiry|leg       invoice spread
//   W|bank|meeting        implied policy rate (or a constant-horizon pricing series, e.g. W|Fed|Next meeting move bp)
//   C|market|tenor        fitted curve           P|name                      policy rate or overnight fixing
//   =expression|name      formula over basket letters
const MEASURES = { y: { label: "Yield", unit: "%" }, p: { label: "Price", unit: "pts" }, a: { label: "ASW", unit: "bp" } };
const KINDS = [
  { code: "bond", label: "Bond" }, { code: "generic", label: "Generic" }, { code: "fitted", label: "Fitted curve" },
  { code: "swap", label: "Swap" }, { code: "fut", label: "Futures" }, { code: "basis", label: "Basis" },
  { code: "inv", label: "Invoice spread" }, { code: "policy", label: "Policy rate" }, { code: "wirp", label: "WIRP" },
  { code: "formula", label: "Formula" },
];
const RANGES = [{ code: "1M", label: "1M", days: 31 }, { code: "3M", label: "3M", days: 92 }, { code: "6M", label: "6M", days: 183 },
  { code: "1Y", label: "1Y", days: 366 }, { code: "All", label: "All", days: Infinity }];
const VIEWS = [{ code: "level", label: "Level" }, { code: "rebased", label: "Change since start" }, { code: "diff", label: "Daily change" }];
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

const store = { markets: {}, gp: {} };
const gpData = (m) => (store.gp[m] ??= loadJSON(`data/gp/${m}.json`));

// ---------------------------------------------------------------- series

const bondName = (m, id) => store.markets[m].bonds.find((b) => b.id === id)?.name ?? id;
const basketBondName = (c, isin) => store.futures[c]?.basket.find((b) => b.id === isin)?.name
  ?? Object.values(store.markets).flatMap((mk) => mk.bonds).find((b) => b.id === isin)?.name ?? isin;

// Business-day settlement after a trade date (weekends only).
function settleAfter(d, n) {
  const t = parseDate(d);
  while (n > 0) { t.setUTCDate(t.getUTCDate() + 1); if (t.getUTCDay() % 6) n--; }
  return t;
}

async function resolve(key) {
  const [kind, ...p] = key.split("|");
  if (kind === "B" || kind === "G") {
    const [m, ref, measure] = p;
    const id = kind === "G" ? store.markets[m].benchmarks?.find((b) => String(b.tenor) === ref)?.id : ref;
    if (!id) throw new Error(`no ${m} ${ref}Y benchmark`);
    const gp = await gpData(m);
    const bond = gp.bonds.find((b) => b.id === id);
    if (!bond) throw new Error(`${id} is not in the ${m} history`);
    const name = kind === "G" ? `${m} ${ref}Y (${bond.name})` : `${bond.name}`;
    let points;
    if (measure === "a") {
      points = (gp.asw[id] ?? []).map((v, i) => [gp.aswDates[i], v]);
    } else {
      points = gp.yield[id].map((v, i) => [gp.dates[i], v]);
      if (measure === "p") {
        const maturity = parseDate(bond.maturity);
        points = points.map(([d, y]) => [d, y == null ? null : pricer(bond.coupon, maturity, settleAfter(d, gp.settleDays), gp.freq).price(y)]);
      }
    }
    return { label: `${name} ${MEASURES[measure].label.toLowerCase()}`, unit: MEASURES[measure].unit, points };
  }
  if (kind === "C") {
    const gp = await gpData(p[0]);
    const v = gp.fit?.[p[1]];
    if (!v) throw new Error(`no ${p[0]} fitted curve history`);
    return { label: `${p[0]} ${p[1]}Y fitted curve`, unit: "%", points: gp.fitDates.map((d, i) => [d, v[i]]) };
  }
  if (kind === "P") return fromTable(store.policy, p[0], p[0], "%");
  if (kind === "W" && !/^\d{4}-/.test(p[1])) return fromTable(store.wirp, `${p[0]}|${p[1]}`, `${p[0]} ${p[1].replace(/ (bp|%)$/, "")}`, p[1].endsWith("%") ? "%" : "bp");
  if (kind === "S") return fromTable(store.swaps, p[0], `${p[0]} swap`, "%");
  if (kind === "F") return fromTable(store.eurex, `FUT|${p[0]}|${p[1]}`, `${p[0]} ${p[1]} futures`, "pts");
  if (kind === "X") return fromTable(store.eurex, `BASIS|${p.join("|")}`, `${p[0]} ${p[1]} basis ${basketBondName(p[0], p[2])}`, "c");
  if (kind === "I") return fromTable(store.eurex, `INV|${p.join("|")}`, `${p[0]} ${p[1]} invoice spread${p[2] === "all" ? "" : ` (${p[2]})`}`, "bp");
  if (kind === "W") return fromTable(store.wirp, `${p[0]}|${p[1]}`, `${p[0]} ${p[1]} meeting implied`, "%");
  throw new Error(`unknown series ${key}`);
}

function fromTable(table, id, label, unit) {
  const v = table.series[id];
  if (!v) throw new Error(`no data for ${label}`);
  return { label, unit, points: table.dates.map((d, i) => [d, v[i]]) };
}

// Formula over basket letters, e.g. "(B-A)*100" or "2*B-A-C". Only letters, numbers and arithmetic.
function compileFormula(expr, letters) {
  const clean = expr.toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9+\-*/().]+$/.test(clean)) throw new Error("use letters, numbers, + − × ÷ and brackets only");
  const used = [...new Set(clean.match(/[A-Z]/g) ?? [])];
  const unknown = used.filter((l) => !letters.includes(l));
  if (unknown.length) throw new Error(`no series ${unknown.join(", ")} in the basket`);
  if (!used.length) throw new Error("the formula uses no series");
  const fn = new Function(...used, `return (${clean});`);
  fn(...used.map(() => 1));
  return { used, fn, text: clean };
}

// ---------------------------------------------------------------- statistics

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };

function ols(x, y) {
  const n = x.length, mx = mean(x), my = mean(y);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); syy += (y[i] - my) ** 2; }
  const beta = sxy / sxx, alpha = my - beta * mx;
  const resid = y.map((v, i) => v - alpha - beta * x[i]);
  const se = Math.sqrt(resid.reduce((a, r) => a + r * r, 0) / (n - 2));
  return { alpha, beta, r: sxy / Math.sqrt(sxx * syy), r2: (sxy * sxy) / (sxx * syy), se, resid, n,
    tBeta: beta / (se / Math.sqrt(sxx)) };
}

// Pairs of values on dates both series have; with `diff`, consecutive differences of those pairs.
function align(a, b, diff) {
  const mb = new Map(b.map(([d, v]) => [d, v]));
  const rows = a.filter(([d, v]) => v != null && mb.get(d) != null).map(([d, v]) => [d, v, mb.get(d)]);
  if (!diff) return rows;
  return rows.slice(1).map((r, i) => [r[0], r[1] - rows[i][1], r[2] - rows[i][2]]);
}

// ---------------------------------------------------------------- page

async function start() {
  const params = new URLSearchParams(location.hash.slice(1));
  const state = {
    kind: "generic",
    range: RANGES.some((r) => r.code === params.get("r")) ? params.get("r") : "All",
    view: VIEWS.some((v) => v.code === params.get("v")) ? params.get("v") : "level",
    scatterMode: params.get("sm") === "level" ? "level" : "diff",
    x: params.get("x"), y: params.get("y"), window: 20,
    basket: [],   // {letter, key, label, unit, points, right}
  };
  // Basket in the URL as letter~key pairs, so formulas keep pointing at the same letters.
  const saved = (params.get("s") ?? "A~G|DE|10|y,B~G|FR|10|y,C~=(B-A)*100|OAT − Bund 10Y bp").split(",").filter(Boolean);
  for (const item of saved) {
    const [letter, key] = item.includes("~") ? item.split("~") : [null, item];
    await addSeries(key, false, letter).catch((e) => console.warn(key, e));
  }
  for (const s of state.basket) if ((params.get("h") ?? "").includes(s.letter)) s.show = false;
  state.x ??= state.basket[0]?.letter;
  state.y ??= state.basket[1]?.letter ?? state.x;

  const picker = el("section", { class: "panel" });
  const basketPanel = el("section", { class: "panel" });
  const lineChart = el("div", { class: "plot" });
  const linePanel = el("section", { class: "panel" });
  const scatterPanel = el("section", { class: "panel" });
  const corrPanel = el("section", { class: "panel" });
  const statsPanel = el("section", { class: "panel" });
  app.append(
    el("div", { class: "page-title" }, el("h1", {}, "Historical Graphs"),
      el("span", { class: "muted" }, "daily history of every series on the site · build spreads and flies · correlation and regression")),
    el("div", { class: "grid cols-2", style: { marginBottom: "10px" } }, picker, basketPanel),
    el("div", { class: "stack" }, linePanel, el("div", { class: "grid cols-2" }, scatterPanel, corrPanel), statsPanel),
    methodNote());

  function saveHash() {
    const p = new URLSearchParams({ s: state.basket.map((s) => `${s.letter}~${s.key}`).join(","), r: state.range, v: state.view, sm: state.scatterMode });
    const hidden = state.basket.filter((s) => s.show === false).map((s) => s.letter).join("");
    if (hidden) p.set("h", hidden);
    if (state.x) p.set("x", state.x);
    if (state.y) p.set("y", state.y);
    history.replaceState(null, "", `#${p}`);
  }

  async function addSeries(key, redraw = true, wanted = null) {
    const used = new Set(state.basket.map((s) => s.letter));
    const letter = wanted && LETTERS.includes(wanted) && !used.has(wanted) ? wanted : [...LETTERS].find((l) => !used.has(l));
    if (!letter) throw new Error("the basket is full");
    if (state.basket.some((s) => s.key === key)) throw new Error("already in the basket");
    let s;
    if (key.startsWith("=")) {
      const [expr, name] = key.slice(1).split("|");
      const f = compileFormula(expr, state.basket.map((b) => b.letter));
      const maps = f.used.map((l) => new Map(state.basket.find((b) => b.letter === l).points.filter(([, v]) => v != null)));
      const dates = [...maps[0].keys()].filter((d) => maps.every((m) => m.has(d))).sort();
      const units = new Set(f.used.map((l) => state.basket.find((b) => b.letter === l).unit));
      s = { label: name || f.text, unit: /\*100\b/.test(f.text) && units.has("%") ? "bp" : units.size === 1 ? [...units][0] : "",
        points: dates.map((d) => [d, f.fn(...maps.map((m) => m.get(d)))]), formula: f.text };
    } else {
      s = await resolve(key);
    }
    // A series in a different unit from the first left-axis series starts on the right axis.
    const leftUnit = state.basket.find((b) => !b.right)?.unit;
    state.basket.push({ letter, key, ...s, right: leftUnit != null && s.unit !== leftUnit });
    state.basket.sort((a, b) => a.letter.localeCompare(b.letter));
    if (redraw) render();
  }

  // Letters stay with their series; a formula built on a removed series goes with it.
  function removeSeries(letter) {
    const gone = new Set([letter]);
    for (const s of state.basket) if (s.formula && [...s.formula].some((ch) => gone.has(ch))) gone.add(s.letter);
    state.basket = state.basket.filter((s) => !gone.has(s.letter));
    render();
  }

  // ---- picker
  function renderPicker() {
    const msg = el("span", { class: "small" });
    const add = (key) => addSeries(key).then(() => { msg.className = "small up"; msg.textContent = "Added"; })
      .catch((e) => { msg.className = "small down"; msg.textContent = e.message; });
    const select = (opts, value) => {
      const s = el("select", {}, opts.map(([v, t]) => el("option", { value: v, selected: v === value || null }, t)));
      return s;
    };
    const marketSel = select(MARKETS.map((m) => [m.code, m.label]), "DE");
    const measureSel = (withPrice = true) => select(Object.entries(MEASURES).filter(([k]) => withPrice || k !== "p").map(([k, m]) => [k, m.label]), "y");
    let controls;
    if (state.kind === "bond") {
      const bondSel = el("select", { style: { maxWidth: "22em" } });
      const fill = () => bondSel.replaceChildren(...store.markets[marketSel.value].bonds.map((b) => el("option", { value: b.id }, `${b.name} · ${b.yield.toFixed(3)}%`)));
      marketSel.addEventListener("change", fill);
      fill();
      const ms = measureSel();
      controls = [marketSel, bondSel, ms, el("button", { class: "btn", onclick: () => add(`B|${marketSel.value}|${bondSel.value}|${ms.value}`) }, "Add")];
    } else if (state.kind === "generic") {
      const tenorSel = el("select");
      const fill = () => tenorSel.replaceChildren(...(store.markets[marketSel.value].benchmarks ?? []).map((b) => el("option", { value: b.tenor, selected: b.tenor === 10 || null }, `${b.tenor}Y · ${b.name}`)));
      marketSel.addEventListener("change", fill);
      fill();
      const ms = measureSel();
      controls = [marketSel, tenorSel, ms, el("button", { class: "btn", onclick: () => add(`G|${marketSel.value}|${tenorSel.value}|${ms.value}`) }, "Add")];
    } else if (state.kind === "fitted") {
      const tenorSel = select([2, 5, 10, 30].map((t) => [t, `${t}Y`]), 10);
      controls = [marketSel, tenorSel, el("button", { class: "btn", onclick: () => add(`C|${marketSel.value}|${tenorSel.value}`) }, "Add")];
    } else if (state.kind === "policy") {
      const s = select(Object.keys(store.policy.series).map((k) => [k, k]));
      controls = [s, el("button", { class: "btn", onclick: () => add(`P|${s.value}`) }, "Add")];
    } else if (state.kind === "swap") {
      const s = select(Object.keys(store.swaps.series).map((k) => [k, k]), "EUR 6M 10Y");
      controls = [s, el("button", { class: "btn", onclick: () => add(`S|${s.value}`) }, "Add")];
    } else if (state.kind === "fut") {
      const s = select(Object.keys(store.eurex.series).filter((k) => k.startsWith("FUT|")).map((k) => [k.slice(4), k.slice(4).replace("|", " ")]));
      controls = [s, el("button", { class: "btn", onclick: () => add(`F|${s.value}`) }, "Add")];
    } else if (state.kind === "basis") {
      const keys = Object.keys(store.eurex.series).filter((k) => k.startsWith("BASIS|")).map((k) => k.split("|").slice(1));
      const contracts = [...new Set(keys.map(([c, x]) => `${c}|${x}`))];
      const cSel = select(contracts.map((c) => [c, c.replace("|", " ")]), contracts.find((c) => c.startsWith("RX|")));
      const bSel = el("select", { style: { maxWidth: "22em" } });
      const fill = () => bSel.replaceChildren(...keys.filter(([c, x]) => `${c}|${x}` === cSel.value).map(([c, , isin]) => el("option", { value: isin }, basketBondName(c, isin))));
      cSel.addEventListener("change", fill);
      fill();
      controls = [cSel, bSel, el("button", { class: "btn", onclick: () => add(`X|${cSel.value}|${bSel.value}`) }, "Add")];
    } else if (state.kind === "inv") {
      const s = select(Object.keys(store.eurex.series).filter((k) => k.startsWith("INV|")).map((k) => [k.slice(4), k.slice(4).replaceAll("|", " ")]));
      controls = [s, el("button", { class: "btn", onclick: () => add(`I|${s.value}`) }, "Add")];
    } else if (state.kind === "wirp") {
      const bankSel = select(["Fed", "ECB", "BoE"].map((b) => [b, b]), "Fed");
      const mSel = el("select");
      // Constant-horizon series first (they carry on as meetings pass), then each meeting's implied rate.
      const fill = () => mSel.replaceChildren(...Object.keys(store.wirp.series).filter((k) => k.startsWith(`${bankSel.value}|`))
        .sort((a, b) => /\|\d{4}-/.test(a) - /\|\d{4}-/.test(b) || a.localeCompare(b))
        .map((k) => el("option", { value: k }, /\|\d{4}-/.test(k) ? `${k.split("|")[1]} meeting: implied rate` : k.split("|")[1])));
      bankSel.addEventListener("change", fill);
      fill();
      controls = [bankSel, mSel, el("button", { class: "btn", onclick: () => add(`W|${mSel.value}`) }, "Add")];
    } else {
      const expr = el("input", { type: "text", placeholder: "(B-A)*100", style: { width: "12em" } });
      const name = el("input", { type: "text", placeholder: "name (optional)", style: { width: "14em" } });
      controls = [expr, name, el("button", { class: "btn", onclick: () => add(`=${expr.value.trim()}|${name.value.trim().replaceAll(",", " ").replaceAll("|", " ")}`) }, "Add")];
    }
    const hint = {
      bond: "Any bond in the four markets. Price is clean, from the closing yield. ASW history starts on the day it was first archived.",
      generic: "The bond that is the benchmark today, with its own history (a roll to a new benchmark is not spliced in).",
      swap: "Par swap rates from Eurex Clearing curves, archived daily from the day they were added.",
      fut: "Daily VWAP of the futures leg of Eurex EFP and EFS trades.",
      basis: "Gross basis = cash − futures × CF in cents, daily VWAP of EFP trades.",
      inv: "Invoice spread = swap rate − futures-implied yield of the matched deliverable, bp, daily VWAP of EFS trades. Lower / upper: the two clusters most likely €STR and 6M Euribor swaps.",
      fitted: "Nelson-Siegel curve fitted to all of the market's nominal bonds each day (bad prints over 40bp dropped). Bonds that have since matured are not in the OAT and BTP fits.",
      policy: "Policy rates and overnight fixings over two years: NY Fed, ECB Data Portal, Bank of England database.",
      wirp: "Pricing from the WIRP page, archived daily: the move priced at the next meeting, the cumulative move and implied rate 6M and 1Y ahead, or one meeting's implied rate.",
      formula: "Combine series by letter: (B-A)*100 for a spread in bp, (2*B-A-C)*100 for a fly. Dates where every series has a value.",
    }[state.kind];
    picker.replaceChildren(el("h2", {}, "Add a series"),
      segmented(KINDS, state.kind, (k) => { state.kind = k; renderPicker(); }),
      el("div", { class: "row", style: { margin: "10px 0 4px" } }, ...controls, msg),
      el("p", { class: "note" }, hint));
  }

  // ---- basket
  function renderBasket() {
    basketPanel.replaceChildren(el("h2", {}, "Basket"),
      state.basket.length ? el("div", { class: "table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["", "Series", "Unit", "Obs", "Last", "Show", "Right axis", ""].map((h, i) => el("th", { class: i < 2 ? "l" : "" }, h)))),
        el("tbody", {}, state.basket.map((s, i) => {
          const obs = s.points.filter(([, v]) => v != null);
          const last = obs.at(-1);
          const axis = el("input", { type: "checkbox", checked: s.right || null, "aria-label": `Right axis for ${s.letter}` });
          axis.addEventListener("change", () => { s.right = axis.checked; renderLine(); });
          // Hidden series stay in the basket for formulas, the scatter and the tables, but not on the chart.
          const show = el("input", { type: "checkbox", checked: s.show !== false || null, "aria-label": `Show ${s.letter} on the chart` });
          show.addEventListener("change", () => { s.show = show.checked; saveHash(); renderLine(); });
          return el("tr", {},
            el("td", { class: "l" }, el("span", { style: { color: COLORS[i % COLORS.length], fontWeight: 700 } }, s.letter)),
            el("td", { class: "l", title: s.key }, s.formula ? `${s.label} = ${s.formula}` : s.label),
            el("td", {}, s.unit),
            el("td", {}, obs.length),
            el("td", { title: last?.[0] }, last ? `${fmt.n(last[1], s.unit === "%" ? 3 : 2)} (${last[0]})` : "–"),
            el("td", {}, show),
            el("td", {}, axis),
            el("td", {}, el("button", { class: "btn", onclick: () => removeSeries(s.letter), "aria-label": `Remove ${s.letter}` }, "×")));
        })))) : el("p", { class: "muted" }, "Empty: add series on the left."),
      el("div", { class: "row", style: { marginTop: "8px" } },
        el("span", { class: "amber" }, "Range"), segmented(RANGES, state.range, (r) => { state.range = r; render(); }),
        el("button", { class: "btn", onclick: () => { state.basket = []; render(); } }, "Clear basket")));
  }

  const inRange = (points) => {
    const days = RANGES.find((r) => r.code === state.range).days;
    if (!isFinite(days)) return points;
    const all = state.basket.flatMap((s) => s.points.map(([d]) => d)).sort();
    const end = parseDate(all.at(-1) ?? "2000-01-01");
    const from = new Date(end - days * 864e5).toISOString().slice(0, 10);
    return points.filter(([d]) => d >= from);
  };
  const clean = (s) => inRange(s.points.filter(([, v]) => v != null && isFinite(v)));

  // ---- line chart
  function renderLine() {
    linePanel.replaceChildren(el("div", { class: "row", style: { justifyContent: "space-between" } },
      el("h2", {}, "History"), segmented(VIEWS, state.view, (v) => { state.view = v; saveHash(); renderLine(); })), lineChart);
    const shown = state.basket.filter((s) => s.show !== false);
    const leftUnits = new Set(shown.filter((s) => !s.right).map((s) => s.unit));
    const rightUnits = new Set(shown.filter((s) => s.right).map((s) => s.unit));
    const traces = state.basket.map((s, i) => ({ s, i })).filter(({ s }) => s.show !== false).map(({ s, i }) => {
      let pts = clean(s);
      if (state.view === "rebased" && pts.length) pts = pts.map(([d, v]) => [d, v - pts[0][1]]);
      if (state.view === "diff") pts = pts.slice(1).map(([d, v], j) => [d, v - pts[j][1]]);
      const few = pts.length < 30;
      return { x: pts.map((p) => p[0]), y: pts.map((p) => p[1]), name: `${s.letter}: ${s.label}`, yaxis: s.right ? "y2" : "y",
        type: state.view === "diff" ? "bar" : "scatter", mode: few ? "lines+markers" : "lines",
        line: { color: COLORS[i % COLORS.length], width: 1.6 }, marker: { color: COLORS[i % COLORS.length], size: 4 },
        hovertemplate: `${s.letter} %{x|%d %b %Y}: %{y:.4f} ${s.unit}<extra></extra>` };
    });
    if (!traces.length) {
      window.Plotly.purge(lineChart);
      lineChart.replaceChildren(el("p", { class: "muted" }, "Nothing to plot: every series is hidden or the basket is empty."));
      return;
    }
    plot(lineChart, traces, {
      xaxis: { type: "date" },
      yaxis: { title: { text: [...leftUnits].join(" / ") } },
      ...(rightUnits.size ? { yaxis2: { title: { text: [...rightUnits].join(" / ") }, overlaying: "y", side: "right", showgrid: false } } : {}),
      hovermode: "x unified", legend: { orientation: "h", y: -0.2 },
    }, 440);
  }

  // ---- scatter and regression
  function renderScatter() {
    const letters = state.basket.map((s) => [s.letter, `${s.letter}: ${s.label}`]);
    if (letters.length < 1) { scatterPanel.replaceChildren(el("h2", {}, "Scatter and regression"), el("p", { class: "muted" }, "Add at least two series.")); return; }
    if (!letters.some(([l]) => l === state.x)) state.x = letters[0][0];
    if (!letters.some(([l]) => l === state.y)) state.y = letters[Math.min(1, letters.length - 1)][0];
    const pick = (key) => {
      const s = el("select", { style: { maxWidth: "18em" } }, letters.map(([l, t]) => el("option", { value: l, selected: l === state[key] || null }, t)));
      s.addEventListener("change", () => { state[key] = s.value; saveHash(); renderScatter(); });
      return s;
    };
    const win = el("input", { type: "number", min: 5, step: 1, value: state.window, style: { width: "5em" }, "aria-label": "Rolling window" });
    win.addEventListener("change", () => { state.window = Math.max(5, Math.round(+win.value || 20)); renderScatter(); });
    const sx = state.basket.find((s) => s.letter === state.x), sy = state.basket.find((s) => s.letter === state.y);
    const diff = state.scatterMode === "diff";
    const rows = align(clean(sx), clean(sy), diff);
    const chart = el("div", { class: "plot" });
    const roll = el("div", { class: "plot" });
    const head = el("div", { class: "row", style: { marginBottom: "6px" } },
      el("span", { class: "amber" }, "Y"), pick("y"), el("span", { class: "amber" }, "on X"), pick("x"),
      segmented([{ code: "diff", label: "Daily changes" }, { code: "level", label: "Levels" }], state.scatterMode,
        (m) => { state.scatterMode = m; saveHash(); renderScatter(); }));
    if (rows.length < 5 || sx === sy) {
      scatterPanel.replaceChildren(el("h2", {}, "Scatter and regression"), head,
        el("p", { class: "muted" }, sx === sy ? "Pick two different series." : `Only ${rows.length} common observations: need at least 5.`));
      return;
    }
    const x = rows.map((r) => r[1]), y = rows.map((r) => r[2]);
    const fit = ols(x, y);
    const lastResid = fit.resid.at(-1);
    const xs = [Math.min(...x), Math.max(...x)];
    plot(chart, [
      { x, y, text: rows.map((r) => r[0]), mode: "markers", name: "Observations",
        marker: { size: 6, color: rows.map((_, i) => i), colorscale: [[0, "#3a3a3a"], [1, "#5fa8ff"]], showscale: false },
        hovertemplate: `%{text}<br>${state.x} %{x:.4f}<br>${state.y} %{y:.4f}<extra></extra>` },
      { x: [x.at(-1)], y: [y.at(-1)], mode: "markers", name: `Latest (${rows.at(-1)[0]})`, marker: { size: 11, color: COLORS[0], line: { color: "#fff", width: 1 } },
        hovertemplate: `Latest %{x:.4f}, %{y:.4f}<extra></extra>` },
      { x: xs, y: xs.map((v) => fit.alpha + fit.beta * v), mode: "lines", name: "OLS fit", line: { color: COLORS[3], dash: "dash" }, hoverinfo: "skip" },
    ], { xaxis: { title: { text: `${diff ? "Δ " : ""}${sx.label} (${sx.unit})` } }, yaxis: { title: { text: `${diff ? "Δ " : ""}${sy.label} (${sy.unit})` } } }, 380);

    // Rolling correlation of daily changes over the common dates.
    const ch = align(clean(sx), clean(sy), true);
    const w = state.window;
    const rc = ch.slice(w - 1).map((_, i) => {
      const seg = ch.slice(i, i + w);
      return [seg.at(-1)[0], ols(seg.map((r) => r[1]), seg.map((r) => r[2])).r];
    }).filter(([, r]) => isFinite(r));
    if (rc.length) {
      plot(roll, [{ x: rc.map((r) => r[0]), y: rc.map((r) => r[1]), mode: "lines", line: { color: COLORS[2] }, name: `${w}-day correlation of daily changes`,
        hovertemplate: "%{x|%d %b %Y}: %{y:.2f}<extra></extra>" }], { yaxis: { range: [-1.05, 1.05], title: { text: "ρ" } }, showlegend: false }, 200);
    } else {
      roll.replaceChildren(el("p", { class: "note" }, `Rolling correlation needs more than ${w} common daily changes (${ch.length} so far).`));
    }
    scatterPanel.replaceChildren(el("h2", {}, "Scatter and regression"), head, chart,
      el("div", { class: "tiles" },
        statTile("Fit", `${state.y} = ${fmt.n(fit.alpha, 4)} ${fit.beta < 0 ? "−" : "+"} ${fmt.n(Math.abs(fit.beta), 3)} × ${state.x}`),
        statTile("Beta (t-stat)", `${fmt.n(fit.beta, 3)} (${fmt.n(fit.tBeta, 1)})`),
        statTile("Correlation / R²", `${fmt.n(fit.r, 3)} / ${fmt.n(fit.r2, 3)}`),
        statTile("Observations", `${fit.n} (${rows[0][0]} → ${rows.at(-1)[0]})`),
        statTile("Residual σ", `${fmt.n(fit.se, 4)} ${sy.unit}`),
        statTile("Latest residual", `${fmt.s(lastResid, 4)} ${sy.unit} (${fmt.s(lastResid / fit.se, 2)}σ)`)),
      el("div", { class: "row", style: { marginTop: "8px" } }, el("span", { class: "amber" }, "Rolling window (days)"), win), roll,
      el("p", { class: "note" }, diff
        ? "Regression of daily changes (hedge ratio: units of X per unit of Y). A positive latest residual: Y moved more than the fit implies."
        : "Regression of levels: the latest residual is how rich or cheap Y is to X relative to the fit. Levels of trending series correlate spuriously; prefer daily changes to test co-movement."));
  }

  // ---- correlation matrix
  function renderCorr() {
    const series = state.basket;
    const mode = state.scatterMode;
    if (series.length < 2) { corrPanel.replaceChildren(el("h2", {}, "Correlation matrix"), el("p", { class: "muted" }, "Add at least two series.")); return; }
    const cell = (a, b) => {
      if (a === b) return 1;
      const r = align(clean(a), clean(b), mode === "diff");
      return r.length >= 5 ? ols(r.map((v) => v[1]), r.map((v) => v[2])).r : null;
    };
    corrPanel.replaceChildren(el("h2", {}, `Correlation matrix (${mode === "diff" ? "daily changes" : "levels"})`),
      el("div", { class: "table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, ""), series.map((s) => el("th", { title: s.label }, s.letter)))),
        el("tbody", {}, series.map((a) => el("tr", {}, el("td", { class: "l", title: a.label }, el("span", { class: "amber" }, a.letter), ` ${a.label}`),
          series.map((b) => {
            const r = cell(a, b);
            const td = el("td", {}, r == null ? "–" : r.toFixed(2));
            if (r != null && a !== b) td.style.background = heat(r, 1);
            return td;
          })))))),
      el("p", { class: "note" }, "Pearson correlation over common dates in the selected range; switch levels / daily changes under the scatter."));
  }

  // ---- statistics
  function renderStats() {
    const head = ["", "Series", "Unit", "Last", "Date", "Δ 1d", "Δ 1w", "Δ 1m", "Min", "Max", "Mean", "z-score"];
    statsPanel.replaceChildren(el("h2", {}, "Statistics over the range"), el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, head.map((h, i) => el("th", { class: i < 2 ? "l" : "" }, h)))),
      el("tbody", {}, state.basket.map((s) => {
        const pts = clean(s), v = pts.map((p) => p[1]);
        if (!v.length) return el("tr", {}, el("td", { class: "l" }, s.letter), el("td", { class: "l" }, s.label), el("td", { colspan: 10 }, "no data in range"));
        const d = 3, last = v.at(-1);
        const chg = (n) => (v.length > n ? last - v[v.length - 1 - n] : null);
        const m = mean(v), sd = v.length > 2 ? std(v) : null;
        return el("tr", {},
          el("td", { class: "l amber" }, s.letter), el("td", { class: "l" }, s.label), el("td", {}, s.unit),
          el("td", {}, fmt.n(last, d)), el("td", {}, pts.at(-1)[0]),
          el("td", {}, fmt.s(chg(1), d)), el("td", {}, fmt.s(chg(5), d)), el("td", {}, fmt.s(chg(21), d)),
          el("td", {}, fmt.n(Math.min(...v), d)), el("td", {}, fmt.n(Math.max(...v), d)), el("td", {}, fmt.n(m, d)),
          el("td", {}, sd ? fmt.s((last - m) / sd, 2) : "–"));
      })))),
      el("p", { class: "note" }, "Δ 1w and Δ 1m are over 5 and 21 observations. z-score: (last − mean) ÷ standard deviation over the range."));
  }

  function render() {
    saveHash();
    renderPicker();
    renderBasket();
    renderLine();
    renderScatter();
    renderCorr();
    renderStats();
  }
  render();
}

function statTile(k, v) {
  return el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: "v small" }, v));
}

function methodNote() {
  return el("details", { class: "method" }, el("summary", {}, "Sources and history"), el("ul", {},
    el("li", {}, "Bond yields: closing prices from TreasuryDirect FedInvest (UST), the Bundesbank (Bunds) and Borsa Italiana MOT / EuroMOT (OATs, BTPs), "
      + "converted to yields at the market's settlement convention. Up to two years are kept; Bund history starts in July 2026, UST history is backfilled a month per daily run."),
    el("li", {}, "ASW: par-par asset swap spread vs SOFR (UST) or 6M Euribor with €STR discounting (euro area), from Eurex Clearing's daily curves; archived from November 2026."),
    el("li", {}, "Swap rates: spot-starting par rates from the same curves (fixed annual; EUR 6M floating semi-annual)."),
    el("li", {}, "Fitted curves: the Nelson-Siegel curve through all of a market's nominal bonds, refitted for every day of the yield history. "
      + "It sits above the on-the-run benchmarks where older, cheaper issues dominate (UST 10Y by about 15bp)."),
    el("li", {}, "Policy rates and fixings: NY Fed (target range, EFFR), ECB Data Portal (deposit facility rate, €STR), Bank of England database (Bank Rate, SONIA), two years."),
    el("li", {}, "WIRP pricing is archived from November 2026: the Eurex Clearing file holds only the latest curves, so earlier dates cannot be rebuilt."),
    el("li", {}, "Futures, gross basis and invoice spreads: daily volume-weighted averages of Eurex EFP and EFS trades (the trade archive starts in October 2026). "
      + "No free source exists for CME futures prices, so UST futures are not available."),
    el("li", {}, "Generic series follow today's benchmark bond back in time; they do not splice in the previous benchmark, so a new issue starts a short history.")));
}

// Last, so that every helper above is initialised before the page starts.
try {
  const [eurex, swaps, wirp, futures, ...mk] = await Promise.all([
    loadJSON("data/gp/eurex.json"), loadJSON("data/gp/swaps.json"), loadJSON("data/gp/wirp.json"), loadJSON("data/futures.json"),
    ...MARKETS.map((m) => loadJSON(`data/markets/${m.code}.json`))]);
  MARKETS.forEach((m, i) => { store.markets[m.code] = mk[i]; });
  store.policy = await loadJSON("data/gp/policy.json").catch(() => ({ dates: [], series: {} }));
  Object.assign(store, { eurex, swaps, wirp, futures: futures.contracts });
  await start();
} catch (err) {
  showError(app, err);
}
