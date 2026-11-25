import { $, COLORS, el, fmt, footnotes, frame, hashParam, loadJSON, plot, segmented, setHash, showError } from "./common.js";

frame("DTCC");
const app = $("#app");

// ---- statistics (as on EURX)
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
function quantile(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return undefined;
  const i = (s.length - 1) * p, lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
}
const median = (xs) => quantile(xs, 0.5);
// Off-market prints: more than k median absolute deviations, and at least `floor` (%), from the median.
function split(rows, floor, k = 8, key = () => "") {
  const groups = new Map();
  for (const r of rows) (groups.get(key(r)) ?? groups.set(key(r), []).get(key(r))).push(r.rate);
  const med = new Map([...groups].map(([g, vs]) => [g, median(vs)]));
  const dev = (r) => Math.abs(r.rate - med.get(key(r)));
  const limit = Math.max(floor, k * (median(rows.map(dev)) || 0));
  return { kept: rows.filter((r) => dev(r) <= limit), dropped: rows.filter((r) => dev(r) > limit) };
}
// Gross misprints against the whole series, then off-market prints against that day's median. Floors in % of
// the value: swap rates 50bp / 5bp; traded spreads (bp series stored as % / 100) 10bp / 1.5bp.
function filtered(rows, floors = [0.5, 0.05]) {
  const a = split(rows, floors[0]);
  const b = split(a.kept, floors[1], 8, (r) => r.day);
  return { kept: b.kept, dropped: [...a.dropped, ...b.dropped] };
}
const vwap = (rows) => (rows.length ? sum(rows.map((r) => r.rate * r.q)) / sum(rows.map((r) => r.q)) : null);

// ---- formatting
const london = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const londonHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" });
const timeOf = (r) => london.format(r.ms);
const amount = (mm) => (mm >= 1000 ? `${fmt.n(mm / 1000, 1)}bn` : `${fmt.n(mm, mm >= 10 ? 0 : 1)}m`);
const bucketLabel = (b) => (b ? `${b}Y` : "<9M");
const BUCKETS = [0, 1, 2, 3, 5, 7, 10, 15, 20, 30];
const KEY = BUCKETS.filter((b) => b).map((b) => `${b}Y`);   // key-rate tenors
// Days loaded and shown: the archive holds every day since November 2024, too much to load at once by default.
const RANGES = [{ code: "1W", label: "1W", days: 5 }, { code: "1M", label: "1M", days: 22 }, { code: "3M", label: "3M", days: 65 },
  { code: "6M", label: "6M", days: 130 }, { code: "1Y", label: "1Y", days: 260 }, { code: "All", label: "All", days: Infinity }];
const MAX_TRADES_CHART = 6000;   // above this the trades chart draws one candle per day
const MAX_TABLE_ROWS = 1000;     // latest trades listed
const TYPE_LABEL = { outright: "Outright", curve: "Curve", fly: "Fly", spread: "Swap spread", invoice: "Invoice", package: "Other package" };
const START_LABEL = { spot: "Spot", imm: "IMM", fwd: "Forward" };
const VENUE_NOTE = { XOFF: "off facility", XXXX: "none", "": "not reported" };

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Column-wise, dictionary-coded trades (scripts/dtcc.py page_file) back to rows.
function decode(f) {
  const base = Date.parse(`${f.base}T00:00:00Z`);
  const F = f.flags;
  return f.t.map((s, k) => {
    const ms = base + s * 1000;
    const t = new Date(ms).toISOString().slice(0, 19);
    const day = t.slice(0, 10);
    const eff = addDays(day, f.e[k]);
    const x = f.x[k];
    return {
      k, t, ms, day, idx: f.idx[f.i[k]], start: f.starts[f.s[k]], tenor: f.labels[f.n[k]], bucket: f.b[k],
      fwd: f.f[k] >= 0 ? f.labels[f.f[k]] : "", fc: f.fc && f.fc[k] >= 0 ? f.contracts[f.fc[k]] : "", eff, mat: addDays(eff, f.m[k]), rate: f.r[k], q: f.q[k], venue: f.venues[f.v[k]],
      cap: !!(x & F.cap), pkg: !!(x & F.pkg), upf: !!(x & F.upf), spr: !!(x & F.spr), pp: !!(x & F.pp), blk: !!(x & F.blk),
      std: !!(x & F.std), unc: !!(x & F.unc),
      type: f.types?.[f.y[k]] ?? "outright", sp: f.sp?.[k] ?? null, grp: f.g && f.g[k] >= 0 ? `${f.day}/${f.g[k]}` : null,
    };
  });
}

// DV01 in thousands of the currency per bp: notional × annuity × 1bp, the annuity of an annual fixed leg from
// start to end discounted at the trade's own rate (as scripts/dtcc.py dv01).
function dv01Of(r) {
  const yr = (d) => (Date.parse(d) - Date.parse(r.day)) / 3.15576e10;
  const rate = Math.max(r.rate / 100, 1e-4);
  return (r.q * (Math.exp(-rate * yr(r.eff)) - Math.exp(-rate * yr(r.mat)))) / rate * 0.1;
}

// A trade at a market rate: no upfront payment and not post-priced.
const market = (r) => !r.upf && !r.pp;
const tenorYears = (t) => (t.endsWith("Y") ? parseFloat(t) : parseFloat(t) / 12);
const standardSpot = (r) => r.start === "spot" && r.std && market(r);

function start(summary, spreads, otr, markets) {
  const list = summary.currencies;
  const codes = list.map((c) => c.ccy);
  const files = new Map();
  // The archived days of a currency in the selected range (one file per DTCC report date, each fetched once), in time order.
  const dayFile = (ccy, d) => files.get(`${ccy}/${d}`) ?? files.set(`${ccy}/${d}`, loadJSON(`data/dtcc/${ccy}/${d}.json`).then(decode)).get(`${ccy}/${d}`);
  const rangeDays = (ccy) => {
    const all = Object.keys(list.find((c) => c.ccy === ccy).byDay).sort();
    return all.slice(Math.max(0, all.length - RANGES.find((r) => r.code === state.range).days));
  };
  const load = async (ccy) => (await Promise.all(rangeDays(ccy).map((d) => dayFile(ccy, d)))).flat().sort((a, b) => a.ms - b.ms);
  const state = {
    ccy: hashParam("c", "USD", codes),
    idx: hashParam("i", null),
    tab: hashParam("t", "trades", ["trades", "flow", "check"]),
    tenor: hashParam("n", "10Y", KEY),
    group: hashParam("g", "0", ["0", "1"]) === "1",
    start: hashParam("s", "spot", ["spot", "imm", "fwd", "all"]),
    ttype: hashParam("y", "all", ["all", ...Object.keys(TYPE_LABEL)]),
    structure: hashParam("q", null),      // curve / fly: e.g. 2s10s
    bond: hashParam("b", null),           // swap spread: bond id (or a key tenor)
    future: hashParam("f", null),         // invoice: e.g. TY Mar-27
    invLevel: hashParam("v", "spread", ["spread", "rate"]),   // invoice: reported invoice spread or swap rate
    range: hashParam("r", "1M", RANGES.map((r) => r.code)),
    day: hashParam("d", null),
    cat: hashParam("k", "tenor", ["tenor", "venue", "start", "type"]),
    measure: hashParam("m", "q", ["q", "dv"]),
    period: hashParam("p", "1M", RANGES.map((r) => r.code)),
    view: "Waterfall",
    offMarket: "Exclude",
  };
  const header = el("div");
  const body = el("div");
  app.append(
    el("div", { class: "page-title" }, el("h1", {}, "Swap Flow"),
      el("span", { class: "muted" }, "interest rate swaps reported to DTCC, trade by trade: USD SOFR, EUR 6M Euribor and €STR, GBP SONIA")),
    header, body, methodNote(summary));

  async function render() {
    const info = list.find((c) => c.ccy === state.ccy);
    const indices = Object.keys(info.indices);
    if (!indices.includes(state.idx)) state.idx = indices[0];
    const loadedDays = rangeDays(state.ccy);
    const allDays = Object.keys(info.byDay).sort();
    if (!allDays.includes(state.day)) state.day = allDays.at(-1);
    setHash({ c: state.ccy, i: state.idx, t: state.tab, n: state.tenor, g: state.group ? 1 : 0, s: state.start, y: state.ttype,
      ...(state.structure ? { q: state.structure } : {}), ...(state.bond ? { b: state.bond } : {}), ...(state.future ? { f: state.future } : {}), v: state.invLevel, r: state.range,
      d: state.day, k: state.cat, m: state.measure, p: state.period });

    const groupBox = el("input", { type: "checkbox", id: "dtcc-group", checked: state.group || null });
    groupBox.addEventListener("change", () => { state.group = groupBox.checked; render(); });
    header.replaceChildren(
      el("div", { class: "row", style: { marginBottom: "6px" } },
        segmented(list.map((c) => ({ code: c.ccy, label: c.ccy })), state.ccy, (k) => { state.ccy = k; state.idx = null; render(); }),
        el("span", { class: "row" }, el("span", { class: "amber" }, "Range"), segmented(RANGES, state.range, (v) => { state.range = v; render(); })),
        el("span", { class: "muted small" }, `showing ${loadedDays[0]} to ${loadedDays.at(-1)} · archive from ${summary.days[0]} (${fmt.int(summary.days.length)} days)${state.range === "All" ? ", slow to load" : ""} · updated ${summary.updated} · times in London`)),
      el("div", { class: "row", style: { marginBottom: "6px" } },
        el("span", { class: "amber" }, "Index"),
        segmented(indices.map((k) => ({ code: k, label: k })), state.idx, (k) => { state.idx = k; render(); }),
        el("label", { for: "dtcc-group", class: "row", style: { gap: "6px", cursor: "pointer" }, title: "Unticked: only trades whose tenor is exactly a key-rate tenor (2Y, 5Y, 10Y…). "
          + "Ticked: every trade, put in the bracket of the nearest key-rate tenor by length (9.5Y and 10.3Y count as 10Y; under 9 months as <9M)." },
          groupBox, "Group all trades into key-rate brackets")),
      el("nav", { class: "tabs subtabs" },
        [["trades", "Trades"], ["flow", "Flow"], ["check", "Curve check & swap spreads"]].map(([code, text]) =>
          el("button", { class: state.tab === code ? "active" : "", onclick: () => { state.tab = code; render(); } }, text))));
    if (state.tab === "check") { body.replaceChildren(...check()); return; }
    const token = (renderToken = {});
    if (state.tab === "flow") {
      body.replaceChildren(el("p", { class: "muted" }, "Loading…"));
      const nodes = await flowTab(allDays, loadedDays);
      if (token === renderToken) body.replaceChildren(...nodes);
      return;
    }
    if (loadedDays.some((d) => !files.has(`${state.ccy}/${d}`))) body.replaceChildren(el("p", { class: "muted" }, `Loading ${fmt.int(loadedDays.length)} days of ${state.ccy} trades…`));
    const trades = (await load(state.ccy)).filter((r) => r.idx === state.idx && r.day >= loadedDays[0]);
    if (token !== renderToken) return;
    if (!trades.length) { body.replaceChildren(el("p", { class: "muted" }, "No trades in this index.")); return; }
    body.replaceChildren(...tradesTab(trades));
  }
  let renderToken = null;
  // Key-rate tenors only, unless every trade is grouped into the bracket of its nearest key-rate tenor.
  const inScope = (trades) => (state.group ? trades : trades.filter((r) => r.std && KEY.includes(r.tenor)));

  function controls(items) {
    return el("div", { class: "row", style: { margin: "10px 0" } }, items.map(([label, opts, key]) =>
      el("span", { class: "row" }, el("span", { class: "amber" }, label), segmented(opts, state[key], (v) => { state[key] = v; render(); }))));
  }
  const tile = (k, v, n = "") => el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v), el("div", { class: "n" }, n));

  // ---------------------------------------------------------------- flow

  // Monthly aggregates (scripts/dtcc.py update_aggregates): per day, index, scope and category, rows of
  // [London hour, category, trades, notional mm, DV01 k].
  const aggFiles = new Map();
  const aggMonth = (ccy, m) => aggFiles.get(`${ccy}/${m}`) ?? aggFiles.set(`${ccy}/${m}`,
    loadJSON(`data/dtcc/agg/${ccy}/${m}.json`).catch(() => ({ days: {} }))).get(`${ccy}/${m}`);
  const CATS = [{ code: "tenor", label: "Tenor" }, { code: "venue", label: "Venue" }, { code: "start", label: "Spot / IMM / Fwd" }, { code: "type", label: "Trade type" }];
  const MEASURES = [{ code: "q", label: "Notional" }, { code: "dv", label: "DV01" }];

  async function flowTab(allDays, rangeList) {
    const ccy = state.ccy;
    const span = RANGES.find((r) => r.code === state.period).days;
    const before = allDays.filter((d) => d < state.day);
    const periodDays = before.slice(Math.max(0, before.length - span));
    const months = [...new Set([...rangeList, ...periodDays, state.day].map((d) => d.slice(0, 7)))];
    const aggs = new Map((await Promise.all(months.map((m) => aggMonth(ccy, m)))).map((a, i) => [months[i], a]));
    // The chosen day's trades (tiles and the table by tenor), loaded before any chart is drawn so the charts
    // are on the page when Plotly sizes them.
    const ofDay = async (d) => (d ? inScope((await dayFile(ccy, d)).filter((r) => r.idx === state.idx && r.day === d)) : []);
    const [today, prev] = await Promise.all([ofDay(state.day), ofDay(before.at(-1))]);
    const scope = state.group ? "a" : "k";
    const col = state.measure === "q" ? 3 : 4;
    const entries = (d) => aggs.get(d.slice(0, 7))?.days[d]?.[state.idx]?.[scope]?.[state.cat] ?? [];
    const unit = state.measure === "q" ? `${ccy} bn` : `${ccy} m / bp`;     // both measures stored in mm / k: ÷ 1000
    // Categories in a fixed order; venues: the eight largest over everything shown, the rest as Other.
    let cats;
    if (state.cat === "tenor") cats = BUCKETS.map(bucketLabel);
    else if (state.cat === "start") cats = ["spot", "imm", "fwd"];
    else if (state.cat === "type") cats = Object.keys(TYPE_LABEL);
    else {
      const tot = new Map();
      for (const d of new Set([...rangeList, ...periodDays, state.day])) for (const e of entries(d)) tot.set(e[1], (tot.get(e[1]) ?? 0) + e[col]);
      cats = [...tot].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([v]) => v);
    }
    const catOf = (c) => (cats.includes(c) ? c : "Other");
    if (state.cat === "venue") cats = [...cats, "Other"];
    const catLabel = (c) => (state.cat === "start" ? START_LABEL[c] : state.cat === "type" ? TYPE_LABEL[c] : state.cat === "venue" && VENUE_NOTE[c] ? `${c} (${VENUE_NOTE[c]})` : c);
    const color = (i) => COLORS[i % COLORS.length];

    // Per day over the range.
    const daily = new Map(cats.map((c) => [c, rangeList.map(() => 0)]));
    rangeList.forEach((d, k) => { for (const e of entries(d)) daily.get(catOf(e[1]))[k] += e[col] / 1000; });
    const dayNode = el("div", { class: "plot" });
    requestAnimationFrame(() => plot(dayNode, cats.map((c, i) => ({
      type: "bar", name: catLabel(c), x: rangeList, y: daily.get(c), marker: { color: color(i) },
      hovertemplate: `${catLabel(c)} %{x}: %{y:,.${state.measure === "q" ? 1 : 2}f} ${unit}<extra></extra>`,
    })).filter((t) => t.y.some((v) => v > 0)), {
      barmode: "stack", yaxis: { title: { text: unit } },
      xaxis: { type: "date", rangebreaks: [{ bounds: ["sat", "mon"] }], tickformat: "%d %b %y" },
    }, 340));

    // Per London hour: the chosen day as bars, the period's average day as areas behind them.
    const hours = Array.from({ length: 24 }, (_, h) => h);
    const grid = () => new Map(cats.map((c) => [c, hours.map(() => 0)]));
    const bars = grid(), area = grid();
    for (const e of entries(state.day)) bars.get(catOf(e[1]))[e[0]] += e[col] / 1000;
    for (const d of periodDays) for (const e of entries(d)) area.get(catOf(e[1]))[e[0]] += e[col] / 1000 / periodDays.length;
    const hourNode = el("div", { class: "plot" });
    const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
    const dec = state.measure === "q" ? 2 : 3;
    requestAnimationFrame(() => plot(hourNode, [
      ...cats.map((c, i) => ({
        type: "scatter", mode: "lines", stackgroup: "period", name: `${catLabel(c)} (period avg)`, legendgroup: c, showlegend: false,
        x: hours, y: area.get(c), line: { width: 0.5, color: rgba(color(i), 0.6), shape: "spline" }, fillcolor: rgba(color(i), 0.18),
        hovertemplate: `${catLabel(c)} %{x}:00, average day: %{y:,.${dec}f} ${unit}<extra></extra>`,
      })),
      ...cats.map((c, i) => ({
        type: "bar", name: catLabel(c), legendgroup: c, x: hours, y: bars.get(c), marker: { color: color(i) }, width: 0.6,
        hovertemplate: `${catLabel(c)} %{x}:00 on ${state.day}: %{y:,.${dec}f} ${unit}<extra></extra>`,
      })),
    ].filter((t) => t.y.some((v) => v > 0)), {
      barmode: "stack", yaxis: { title: { text: unit } }, xaxis: { title: { text: "London hour" }, dtick: 2, range: [-0.5, 23.5] },
    }, 340));

    const daySel = el("select", { "aria-label": "Day for the bars", onchange: (e) => { state.day = e.target.value; render(); } },
      [...allDays].reverse().map((d) => el("option", { value: d, selected: d === state.day || null }, d)));
    const periodNote = periodDays.length ? `average day over ${periodDays[0]} to ${periodDays.at(-1)} (${fmt.int(periodDays.length)} days)` : "no earlier days";

    const notional = sum(today.map((r) => r.q));
    const largest = today.reduce((a, r) => (!a || r.q > a.q ? r : a), null);
    const share = (f) => (today.length ? sum(today.filter(f).map((r) => r.q)) / notional : 0);
    const tiles = el("div", { class: "tiles", style: { marginBottom: "10px" } },
      tile("Day", state.day, `${fmt.int(today.length)} trades`),
      tile("Notional", `${ccy} ${amount(notional)}`, `${fmt.int(today.filter((r) => r.cap).length)} above the reporting cap`),
      tile("Spot starting", fmt.pct(share((r) => r.start === "spot"), 0), `IMM ${fmt.pct(share((r) => r.start === "imm"), 0)} · forward ${fmt.pct(share((r) => r.start === "fwd"), 0)}`),
      tile("In packages", fmt.pct(share((r) => r.pkg), 0), `${fmt.pct(share((r) => r.spr), 0)} quoted as a spread`),
      tile("Largest", largest ? `${ccy} ${amount(largest.q)}${largest.cap ? "+" : ""}` : "–", largest ? `${largest.fwd ? `${largest.fwd} fwd ` : ""}${largest.tenor} at ${largest.rate.toFixed(4)}%` : ""));

    // Per tenor bucket: activity and the level of spot-starting standard trades.
    const level = (rows, b) => {
      const s = rows.filter((r) => standardSpot(r) && r.tenor === `${b}Y`);
      return s.length ? filtered(s).kept : [];
    };
    const rows = BUCKETS.filter((b) => b || state.group).map((b) => {
      const all = today.filter((r) => r.bucket === b);
      const spot = level(today, b);
      const v = vwap(spot), pv = vwap(level(prev, b));
      return { b, n: all.length, q: sum(all.map((r) => r.q)), spotN: spot.length, vwap: v, chg: v != null && pv != null ? (v - pv) * 100 : null,
        last: spot.at(-1), imm: all.filter((r) => r.start === "imm").length, fwd: all.filter((r) => r.start === "fwd").length,
        pkg: all.length ? sum(all.filter((r) => r.pkg).map((r) => r.q)) / sum(all.map((r) => r.q)) : null,
        dv: sum(all.map(dv01Of)) };
    }).filter((r) => r.n);
    const totalDv = sum(rows.map((r) => r.dv));
    const table = el("div", { class: "table-wrap", style: { marginTop: "10px" } }, el("table", {},
      el("thead", {}, el("tr", {}, ["Tenor", "Trades", `Notional ${ccy}`, `DV01 ${ccy}k`, "Share of DV01", "Spot std trades", "Spot VWAP %", "vs prior day bp", "Last spot %", "Last at", "IMM", "Forward", "In packages"]
        .map((h, i) => el("th", { class: i ? "" : "l", title: i === 3 ? "Notional × annuity × 1bp, in thousands per bp" : null }, h)))),
      el("tbody", {}, rows.map((r) => el("tr", { style: { cursor: "pointer" }, title: "Show these trades", onclick: () => { if (r.b) { state.tab = "trades"; state.tenor = `${r.b}Y`; render(); } } },
        el("td", { class: "l amber" }, bucketLabel(r.b)), el("td", {}, fmt.int(r.n)), el("td", {}, amount(r.q)),
        el("td", {}, fmt.int(r.dv)), el("td", {}, fmt.pct(r.dv / totalDv, 0)), el("td", {}, r.spotN ? fmt.int(r.spotN) : "–"),
        el("td", {}, r.vwap == null ? "–" : r.vwap.toFixed(4)),
        el("td", { class: r.chg > 0.05 ? "pos" : r.chg < -0.05 ? "neg" : "" }, fmt.s(r.chg, 1)),
        el("td", {}, r.last ? r.last.rate.toFixed(4) : "–"), el("td", {}, r.last ? timeOf(r.last).slice(0, 5) : "–"),
        el("td", {}, r.imm || "–"), el("td", {}, r.fwd || "–"), el("td", {}, fmt.pct(r.pkg, 0)))))));


    return [
      el("div", { class: "row", style: { margin: "10px 0" } },
        el("span", { class: "row" }, el("span", { class: "amber" }, "Category"), segmented(CATS, state.cat, (v) => { state.cat = v; render(); })),
        el("span", { class: "row" }, el("span", { class: "amber" }, "Quantity"), segmented(MEASURES, state.measure, (v) => { state.measure = v; render(); }))),
      el("section", { class: "panel" }, el("h2", {}, `Per day: ${state.idx} ${state.measure === "q" ? "notional" : "DV01"} by ${CATS.find((c) => c.code === state.cat).label.toLowerCase()}, ${rangeList[0]} to ${rangeList.at(-1)}`),
        dayNode, footnotes("Days follow Range at the top.", "Click a legend entry to hide a category; double-click to show it alone.")),
      el("section", { class: "panel", style: { marginTop: "10px" } },
        el("h2", {}, `Per hour: ${state.day} against the ${periodNote}`),
        el("div", { class: "row", style: { margin: "4px 0 6px" } },
          el("span", { class: "row" }, el("span", { class: "amber" }, "Bars: day"), daySel),
          el("span", { class: "row" }, el("span", { class: "amber" }, "Areas: period before it"), segmented(RANGES, state.period, (v) => { state.period = v; render(); }))),
        hourNode,
        footnotes("Bars: the chosen day, by London time of execution.",
          "Areas: the average day of the chosen period before it, stacked in the same colours; a bar above its area is a busier hour than usual.")),
      tiles,
      el("section", { class: "panel" }, el("h2", {}, `${state.idx}: trades by tenor on ${state.day}`), table,
        footnotes(state.group
          ? "Rows: all trades, each in the bracket of the nearest key-rate tenor by its length (start to end)."
          : "Rows: only trades whose length is exactly a key-rate tenor; tick \"Group all trades into key-rate brackets\" to include broken dates and other tenors.",
          "Spot VWAP: spot-starting trades of exactly that tenor at a market rate (no upfront payment, not post-priced), off-market prints dropped, weighted by notional.",
          "Click a row for its trades.")),
    ];
  }

  // ---------------------------------------------------------------- trades

  // Bonds by currency: maturity -> bond, and the benchmark (key maturity) at each tenor.
  const BOND_MARKETS = { USD: ["UST"], EUR: ["DE", "FR", "IT"], GBP: [] };
  const bondsOf = (ccy) => {
    const byMat = new Map(), keys = new Map();
    for (const m of BOND_MARKETS[ccy] ?? []) {
      for (const b of markets[m]?.bonds ?? []) if (!byMat.has(b.maturity)) byMat.set(b.maturity, { ...b, market: m });
      if (m === BOND_MARKETS[ccy][0]) for (const b of markets[m]?.benchmarks ?? []) keys.set(`${b.tenor}Y`, { ...b, market: m });
    }
    return { byMat, keys };
  };

  // On-the-run Treasury maturity of a term on a date (scripts/dtcc.py ust_otr: from a week before issue).
  const otrMaturity = (day, term) => {
    let m = null;
    for (const [from, mat] of otr[term] ?? []) if (from <= day) m = mat;
    return m;
  };
  const OTR_TERMS = [2, 3, 5, 7, 10, 20, 30];

  // What a swap spread trade is against. USD: the Treasury the swap matures with, the one on the run that day or
  // another (null when the swap ends on no Treasury's maturity: not counted). EUR / GBP: the bond maturing on the
  // swap's end date, else the benchmark of a whole-year tenor.
  function bondKey(r, bonds) {
    if (state.ccy === "USD") {
      const on = OTR_TERMS.find((t) => otrMaturity(r.day, t) === r.mat);
      if (on) return { code: `OTR${on}`, label: `${on}Y on-the-run`, key: true, years: on };
      const b = bonds.byMat.get(r.mat);
      if (b) return { code: b.id, label: b.name, key: false, years: tenorYears(r.tenor) };
      const d = new Date(`${r.mat}T00:00:00Z`);
      const treasuryDate = d.getUTCDate() === 15 || new Date(d.getTime() + 864e5).getUTCDate() === 1;
      return treasuryDate ? { code: `M${r.mat}`, label: `Treasury maturing ${r.mat}`, key: false, years: tenorYears(r.tenor) } : null;
    }
    const b = bonds.byMat.get(r.mat);
    if (b) {
      const key = [...bonds.keys].find(([, k]) => k.id === b.id);
      return { code: b.id, label: key ? `${key[0]} · ${b.name}` : b.name, key: !!key, years: tenorYears(r.tenor) };
    }
    if (r.std && bonds.keys.has(r.tenor)) {
      const k = bonds.keys.get(r.tenor);
      return { code: k.id, label: `${r.tenor} · ${k.name}`, key: true, years: tenorYears(r.tenor) };
    }
    if (r.std && KEY.includes(r.tenor)) return { code: r.tenor, label: `${r.tenor} (key tenor)`, key: true, years: tenorYears(r.tenor) };
    return { code: `M${r.mat}`, label: `Bond maturing ${r.mat}`, key: false, years: tenorYears(r.tenor) };
  }

  // The bond futures contract of an invoice swap, as assigned by scripts/dtcc.py (invoice_contract), e.g. "TY Dec-26".
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function futureKey(r) {
    const [contract, month = ""] = (r.fc || "? ?").split(" ");
    const [mon, yy] = month.split("-");
    return { code: r.fc, label: r.fc, key: true, contract, month, order: (2000 + Number(yy)) * 100 + MONTHS.indexOf(mon) + 1 };
  }

  // Curve and fly packages rebuilt from their legs: level in bp (curve: long − short; fly: 2 × belly − wings),
  // size = the legs' average DV01 (k), structure from the leg tenors (2s10s, 2s5s10s).
  function packagesOf(trades, type) {
    const groups = new Map();
    for (const r of trades) if (r.type === type && r.grp) (groups.get(r.grp) ?? groups.set(r.grp, []).get(r.grp)).push(r);
    const out = [];
    for (const legs of groups.values()) {
      if (legs.length !== (type === "curve" ? 2 : 3)) continue;
      legs.sort((x, y) => (x.mat < y.mat ? -1 : 1));
      const whole = legs.every((x) => /^\d+Y$/.test(x.tenor));
      const structure = whole ? legs.map((x) => parseInt(x.tenor, 10)).join("s") + "s" : legs.map((x) => x.tenor).join("/");
      const bp = type === "curve" ? (legs[1].rate - legs[0].rate) * 100 : (2 * legs[1].rate - legs[0].rate - legs[2].rate) * 100;
      const first = legs[0];
      out.push({ ...first, structure, rate: bp / 100, q: sum(legs.map(dv01Of)) / legs.length, legRates: legs.map((x) => x.rate.toFixed(4)).join(" / "),
        tenor: legs.map((x) => x.tenor).join(" / "), mat: legs.at(-1).mat, upf: legs.some((x) => x.upf), pp: legs.some((x) => x.pp), cap: legs.some((x) => x.cap) });
    }
    return out.sort((x, y) => x.ms - y.ms || x.k - y.k);
  }

  // A row of buttons for the main choices and a list for the rest; `options` = [{code, label, key, n}].
  function picker(title, options, value, onPick, keyFirst = true) {
    const main = options.filter((o) => o.key || !keyFirst);
    const rest = options.filter((o) => !o.key && keyFirst);
    const sel = rest.length ? el("select", { "aria-label": title, onchange: (e) => { if (e.target.value) onPick(e.target.value); } },
      el("option", { value: "" }, `Other (${rest.length})`),
      rest.map((o) => el("option", { value: o.code, selected: o.code === value || null }, `${o.label} (${fmt.int(o.n)})`))) : null;
    return el("div", { class: "row", style: { margin: "10px 0 0" } }, el("span", { class: "amber" }, title),
      segmented(main.map((o) => ({ code: o.code, label: `${o.label} (${fmt.int(o.n)})` })), value, onPick), sel);
  }

  // Invoice swaps by contract (columns, short to long) and delivery month (rows, latest first); each cell a button
  // with the number of trades.
  const CONTRACTS = { USD: ["TU", "Z3N", "FV", "TY", "UXY", "US", "WN"], EUR: ["DU", "OE", "RX", "UB", "BTS", "IK", "OAT"] };
  function futuresGrid(opts, value, onPick) {
    const order = CONTRACTS[state.ccy] ?? [];
    const cols = [...new Set(opts.map((o) => o.contract))].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    const months = [...new Map(opts.map((o) => [o.month, o.order])).entries()].sort((a, b) => b[1] - a[1]).map(([mth]) => mth);
    const cell = new Map(opts.map((o) => [`${o.contract}|${o.month}`, o]));
    return el("div", { style: { margin: "10px 0 0" } },
      el("div", { class: "amber", style: { marginBottom: "4px" } }, "Futures: contract × delivery month (trades in the range)"),
      el("div", { class: "table-wrap", style: { maxHeight: "260px", display: "inline-block", maxWidth: "100%" } }, el("table", { style: { width: "auto" } },
        el("thead", {}, el("tr", {}, el("th", { class: "l" }, "Delivery"), cols.map((c) => el("th", {}, c)))),
        el("tbody", {}, months.map((mth) => el("tr", {},
          el("td", { class: "l amber" }, mth),
          cols.map((c) => {
            const o = cell.get(`${c}|${mth}`);
            return el("td", { style: { padding: "2px 4px" } }, o
              ? el("button", { class: `btn${o.code === value ? " on" : ""}`, style: { minWidth: "4.5em" }, title: o.label, onclick: () => onPick(o.code) }, fmt.int(o.n))
              : el("span", { class: "muted" }, "–"));
          })))))));
  }

  // Options counted over the trades in scope; the current choice kept if present, else the most traded (or 10Y).
  function options(rows, keyOf, sortBy) {
    const m = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      const o = m.get(k.code) ?? m.set(k.code, { ...k, n: 0 }).get(k.code);
      o.n++;
    }
    return [...m.values()].sort(sortBy);
  }
  const pick = (opts, current, preferred) => (opts.some((o) => o.code === current) ? current
    : opts.find((o) => preferred?.(o))?.code ?? [...opts].sort((x, y) => y.n - x.n)[0]?.code ?? null);

  function tradesTab(all) {
    const ccy = state.ccy;
    const type = state.ttype;
    const startOk = (r) => state.start === "all" || r.start === state.start;
    const marketOk = (r) => state.offMarket === "Include" || market(r);
    const packMode = type === "curve" || type === "fly";
    let series, selector, subject, valueLabel;
    if (packMode) {
      const packs = packagesOf(all, type).filter((r) => startOk(r) && marketOk(r));
      const opts = options(packs, (r) => ({ code: r.structure, label: r.structure, key: false }), (x, y) => y.n - x.n)
        .map((o, i) => ({ ...o, key: i < 8 }));
      state.structure = pick(opts, state.structure);
      series = packs.filter((r) => r.structure === state.structure);
      selector = picker(type === "curve" ? "Curve" : "Fly", opts, state.structure, (v) => { state.structure = v; render(); });
      subject = `${state.structure} ${type === "curve" ? "curve (long − short leg)" : "fly (2 × belly − wings)"}`;
      valueLabel = type === "curve" ? "curve spread" : "fly level";
    } else if (type === "spread") {
      const bonds = bondsOf(ccy);
      const rows = all.filter((r) => r.type === "spread" && r.sp != null && startOk(r) && marketOk(r)).map((r) => ({ ...r, bondKey: bondKey(r, bonds) }))
        .filter((r) => r.bondKey);
      const opts = options(rows, (r) => r.bondKey, (x, y) => x.years - y.years);
      state.bond = pick(opts, state.bond, (o) => o.code === "OTR10" || (o.key && o.label.startsWith("10Y")));
      series = rows.filter((r) => r.bondKey.code === state.bond).map((r) => ({ ...r, swapRate: r.rate, rate: r.sp / 100 }));
      selector = picker("Bond", opts, state.bond, (v) => { state.bond = v; render(); });
      subject = `swap spread vs ${opts.find((o) => o.code === state.bond)?.label ?? "–"}`;
      valueLabel = "traded swap spread (package spread)";
    } else if (type === "invoice") {
      const rows = all.filter((r) => r.type === "invoice" && r.fc && marketOk(r)).map((r) => ({ ...r, futKey: futureKey(r) }));
      const opts = options(rows, (r) => r.futKey, (x, y) => x.code.split(" ")[0].localeCompare(y.code.split(" ")[0]) || x.order - y.order);
      // Default: the latest TY (RX) delivery month with real activity, i.e. the front contract.
      const main = ccy === "EUR" ? "RX" : "TY";
      const front = opts.filter((o) => o.contract === main && o.n >= 20).sort((x, y) => y.order - x.order)[0];
      state.future = pick(opts, state.future, (o) => o.code === front?.code);
      series = rows.filter((r) => r.futKey.code === state.future);
      if (state.invLevel === "spread") series = series.filter((r) => r.sp != null).map((r) => ({ ...r, swapRate: r.rate, rate: r.sp / 100 }));
      selector = el("div", {}, futuresGrid(opts, state.future, (v) => { state.future = v; render(); }),
        el("div", { class: "row", style: { marginTop: "6px" } }, el("span", { class: "amber" }, "Level"),
          segmented([{ code: "spread", label: "Invoice spread (reported)" }, { code: "rate", label: "Swap rate" }], state.invLevel, (v) => { state.invLevel = v; render(); })));
      subject = `invoice swaps against ${state.future ?? "–"}`;
      valueLabel = state.invLevel === "spread" ? "invoice spread (package spread)" : "swap rate";
    } else {
      // All, outright, other package: key-rate tenors (exact, or every trade in its bracket).
      const scoped = inScope(all).filter((r) => type === "all" || r.type === type);
      const inTenor = (r, t) => (state.group ? `${r.bucket}Y` === t : r.tenor === t);
      const counts = new Map(KEY.map((t) => [t, 0]));
      for (const r of scoped) { const t = state.group ? `${r.bucket}Y` : r.tenor; if (counts.has(t)) counts.set(t, counts.get(t) + 1); }
      series = scoped.filter((r) => inTenor(r, state.tenor) && startOk(r) && marketOk(r));
      selector = picker(state.group ? "Key-rate bracket" : "Key-rate tenor", KEY.map((t) => ({ code: t, label: t, key: true, n: counts.get(t) })),
        state.tenor, (t) => { state.tenor = t; render(); });
      subject = state.group ? `trades nearest ${state.tenor} in length` : state.tenor;
      valueLabel = "fixed rate";
    }
    const spreadSeries = type === "spread" || (type === "invoice" && state.invLevel === "spread");
    const { kept, dropped } = filtered(series, spreadSeries ? [0.1, 0.015] : undefined);
    const rows = withVwap(kept);
    const legsOf = new Map();
    if (!packMode) for (const r of all) if (r.grp && (r.type === "curve" || r.type === "fly")) (legsOf.get(r.grp) ?? legsOf.set(r.grp, []).get(r.grp)).push(r.tenor);
    const cols = [
      ["Day", (r) => r.day.slice(5)], ["London", (r) => timeOf(r)], ["Start", (r) => (r.start === "fwd" ? `${r.fwd} fwd` : START_LABEL[r.start])],
      ["Tenor", (r) => r.tenor], ["Effective", (r) => r.eff], ["Maturity", (r) => r.mat],
      [packMode ? "Leg rates %" : "Rate %", (r) => r.legRates ?? (r.swapRate ?? r.rate).toFixed(4)],
      [packMode ? `DV01 ${ccy}k` : `Notional ${ccy}`, (r) => `${sizeText(r.q)}${r.cap ? "+" : ""}`],
      [`Day VWAP${scale() === 1 ? " %" : ""}`, (r) => (r.outlier || r.vwap == null ? "–" : level(r.vwap))],
      ["Type", (r) => TYPE_LABEL[r.type]],
      ["Package", (r) => (packMode ? `${level(r.rate)}` : legsOf.has(r.grp) ? [...legsOf.get(r.grp)].sort((a, b) => tenorYears(a) - tenorYears(b)).join(" / ")
        : r.sp != null ? `${fmt.s(r.sp, 1)}bp` : "")],
      ["Venue", (r) => r.venue || "–"],
      ["Flags", (r) => [r.pkg && "package", r.spr && "spread", r.upf && "upfront", r.pp && "post-priced", r.blk && "block", r.unc && "uncleared"].filter(Boolean).join(", ")],
    ];
    const notes = {
      curve: ["Curve trades: two legs of one package (same second and venue). Level = long leg rate − short leg rate, bp; size = the legs' average DV01.",
        "DTCC does not say who paid which leg, so a trade could be a steepener or a flattener."],
      fly: ["Flies: three legs of one package. Level = 2 × belly − wings, bp; size = the legs' average DV01.", "The side is not published."],
      spread: ["Swap spread trades: the swap leg of a package against a bond (the bond leg is not a swap, so it is not reported). Level = the reported package spread, bp.",
        "Each spread is checked against swap rate − the bond's yield that day: flipped when only the sign differs (reporters use both conventions), dropped when more than 12bp away.",
        "USD: only swaps maturing on the same day as a Treasury. On-the-run = the Treasury on the run on the trade date (a new issue from a week before it is issued), "
          + "so the history follows each new issue; swaps ending on no Treasury's maturity are left out.",
        "EUR / GBP: the bond maturing on the swap's end date, else the benchmark of a whole-year tenor."],
      invoice: ["Invoice swaps: forward swaps from a futures delivery date to a deliverable bond's maturity, traded against the futures.",
        "Contract: from the delivery month (start date) and the bond's remaining life within the contract's deliverable range (CME: from the first day of the delivery month; Eurex: from the delivery day).",
        "Invoice spread: the package spread (swap rate − futures-implied yield, bp), reported for about one trade in ten; checked against swap rate − the bond's yield "
          + "(flipped when only the sign differs, dropped when more than 20bp away). Swap rate: every invoice trade."],
    };
    return [
      controls([
        ["Type", [{ code: "all", label: "All" }, ...Object.entries(TYPE_LABEL).map(([code, label]) => ({ code, label }))], "ttype"],
        ["Start", [{ code: "spot", label: "Spot" }, { code: "imm", label: "IMM" }, { code: "fwd", label: "Forward" }, { code: "all", label: "All" }], "start"],
        ["Off-market", [{ code: "Exclude", label: "Exclude" }, { code: "Include", label: "Include" }], "offMarket"],
        // Waterfall / bubbles only apply when every trade is drawn (not to the daily candles of long ranges).
        ...(rows.length > MAX_TRADES_CHART ? [] : [["View", [{ code: "Waterfall", label: "Waterfall" }, { code: "Bubbles", label: "Bubbles" }], "view"]])]),
      selector,
      footnotes(
        `${ccy} ${state.idx} ${subject}, ${state.start === "all" ? "any start" : START_LABEL[state.start].toLowerCase() + " starting"}: `
          + `${valueLabel} of every trade in sequence, the day's running VWAP (resets each day) and ${packMode ? "DV01" : "notional"}.`,
        notes[type] ?? [state.group ? "Lengths around the key rate are mixed (see Maturity)." : null,
          "Forward and IMM trades of one tenor start on different dates, so their rates are not like for like."],
        state.offMarket === "Exclude" ? "Trades with an upfront payment or post-priced are left out: their rate is not the market rate." : null),
      tradeTiles(rows),
      rows.length > MAX_TRADES_CHART
        ? el("section", { class: "panel" }, el("h2", {}, `Daily: VWAP and range, with ${packMode ? "DV01" : "notional"}`), dailyChart(rows),
          footnotes(`${fmt.int(rows.length)} trades: too many to draw one by one, so each day is one candle (first, highest, lowest and last trade) with its VWAP.`,
            "Pick a shorter range to draw every trade, as a waterfall or as bubbles."))
        : el("section", { class: "panel" }, el("h2", {}, `All trades: ${valueLabel} and ${packMode ? "DV01" : "notional"}`), chart(rows),
        dropped.length ? footnotes(`${dropped.length} print${dropped.length > 1 ? "s" : ""} far from the series or that day's median ${dropped.length > 1 ? "are" : "is"} left out of the chart and VWAP, and greyed in the table.`) : ""),
      tradeTable([...rows, ...dropped.map((r) => ({ ...r, outlier: true }))].sort((a, b) => a.ms - b.ms || a.k - b.k), cols),
    ];
  }

  // Swap rates in %, traded spreads (stored as % / 100 so the same code works) in bp.
  const inBp = () => ["spread", "curve", "fly"].includes(state.ttype) || (state.ttype === "invoice" && state.invLevel === "spread");
  const scale = () => (inBp() ? 100 : 1);
  const level = (x) => (inBp() ? `${fmt.s(x * 100, 1)}bp` : `${x.toFixed(4)}%`);
  const unitOf = () => (inBp() ? "bp" : "%");
  // Size: notional (millions), or DV01 (thousands per bp) for curve and fly packages.
  const packSize = () => state.ttype === "curve" || state.ttype === "fly";
  const sizeText = (q) => (packSize() ? `${fmt.int(q)}k` : amount(q));

  function withVwap(rows) {
    let pq = 0, q = 0, day = null;
    return rows.map((r, i) => {
      if (r.day !== day) { pq = 0; q = 0; day = r.day; }
      pq += r.rate * r.q; q += r.q;
      return { ...r, i, vwap: pq / q, prev: i ? rows[i - 1].rate : r.rate, first: i === 0 || rows[i - 1].day !== r.day };
    });
  }

  function tradeTiles(rows) {
    if (!rows.length) return el("p", { class: "muted" }, "No trades in this series.");
    const r = rows.at(-1);
    const today = rows.filter((x) => x.day === r.day);
    const vals = today.map((x) => x.rate);
    return el("div", { class: "tiles", style: { marginBottom: "10px" } },
      tile("Latest day", r.day, `${fmt.int(today.length)} trades`),
      tile(packSize() ? "DV01" : "Notional", `${state.ccy} ${sizeText(sum(today.map((x) => x.q)))}`),
      tile("VWAP", level(r.vwap)),
      tile("Last", level(r.rate), timeOf(r)),
      tile("Day range", `${level(Math.min(...vals))} – ${level(Math.max(...vals))}`, `${((Math.max(...vals) - Math.min(...vals)) * 100).toFixed(1)}bp`));
  }

  function chart(rows) {
    const node = el("div", { class: "plot" });
    if (!rows.length) return node;
    const idx = rows.map((r) => r.i);
    const starts = rows.filter((r) => r.first);
    const hover = rows.map((r) => `${r.day} ${timeOf(r)} · ${state.ccy} ${sizeText(r.q)}${r.cap ? "+" : ""}${r.legRates ? ` (legs ${r.legRates})` : ""}<br>${level(r.rate)} (${fmt.s((r.rate - r.prev) * 100, 1)}bp)<br>day VWAP ${level(r.vwap)}`);
    const vx = [], vy = [];
    const S = scale();
    rows.forEach((r, k) => { if (r.first && k) { vx.push(null); vy.push(null); } vx.push(r.i); vy.push(r.vwap * S); });
    const perTrade = 820 / rows.length;
    const labelled = [];
    for (const r of starts) if (!labelled.length || (r.i - labelled.at(-1)) * perTrade >= 40) labelled.push(r.i);
    const maxQ = Math.max(...rows.map((r) => r.q));
    const traces = state.view === "Waterfall"
      ? [{ type: "bar", name: "Trade", x: idx, base: rows.map((r) => r.prev * S), y: rows.map((r) => (r.rate - r.prev) * S || 1e-9),
          marker: { color: rows.map((r) => (r.rate > r.prev ? "#3ddc84" : r.rate < r.prev ? "#ff5c5c" : "#5c5c5c")) }, hovertext: hover, hoverinfo: "text", showlegend: false },
         { type: "scatter", mode: "markers", name: "Print", x: idx, y: rows.map((r) => r.rate * S), marker: { symbol: "line-ew-open", size: 7, color: "#e9e9e9", line: { width: 1 } }, hoverinfo: "skip", showlegend: false }]
      : [{ type: "scatter", mode: "markers", name: "Trade (size = notional)", x: idx, y: rows.map((r) => r.rate * S),
          marker: { size: rows.map((r) => r.q), sizemode: "area", sizeref: (2 * maxQ) / 22 ** 2, sizemin: 2, color: "rgba(95,168,255,0.35)", line: { color: "#5fa8ff", width: 1 } },
          hovertext: hover, hoverinfo: "text" }];
    requestAnimationFrame(() => plot(node, [
      ...traces,
      { type: "scatter", mode: "lines", name: "Day VWAP", x: vx, y: vy, line: { color: "#ff9e1b", width: 2, shape: "hv" }, connectgaps: false, hoverinfo: "skip" },
      { type: "bar", name: "Notional", x: idx, y: rows.map((r) => r.q), yaxis: "y2", marker: { color: "rgba(255,158,27,0.35)" }, hovertext: hover, hoverinfo: "text", showlegend: false },
    ], {
      bargap: 0.15,
      xaxis: { tickvals: labelled, ticktext: labelled.map((i) => rows[i].day.slice(5)), range: [-0.5, rows.length - 0.5], showgrid: false },
      yaxis: { domain: [0.3, 1], title: { text: unitOf() }, tickformat: scale() === 1 ? ".3f" : ".1f" },
      yaxis2: { domain: [0, 0.22], title: { text: packSize() ? `${state.ccy}k DV01` : `${state.ccy}m` } },
      shapes: starts.slice(1).map((r) => ({ type: "line", x0: r.i - 0.5, x1: r.i - 0.5, y0: 0, y1: 1, yref: "paper", line: { color: "rgba(255,255,255,0.08)", width: 1 } })),
    }, 460));
    return node;
  }

  // One candle per day (first, highest, lowest and last trade), the day's VWAP and its notional.
  function dailyChart(rows) {
    const node = el("div", { class: "plot" });
    const days = [];
    for (const r of rows) {
      let d = days.at(-1);
      if (!d || d.day !== r.day) days.push(d = { day: r.day, open: r.rate, high: r.rate, low: r.rate, close: r.rate, pq: 0, q: 0, n: 0 });
      d.high = Math.max(d.high, r.rate); d.low = Math.min(d.low, r.rate); d.close = r.rate;
      d.pq += r.rate * r.q; d.q += r.q; d.n++;
    }
    const x = days.map((d) => d.day);
    const S = scale();
    requestAnimationFrame(() => plot(node, [
      { type: "candlestick", name: "Trades", x, open: days.map((d) => d.open * S), high: days.map((d) => d.high * S), low: days.map((d) => d.low * S), close: days.map((d) => d.close * S),
        increasing: { line: { color: "#3ddc84" } }, decreasing: { line: { color: "#ff5c5c" } }, showlegend: false,
        text: days.map((d) => `${fmt.int(d.n)} trades · VWAP ${level(d.pq / d.q)}`), hoverinfo: "x+text+y" },
      { type: "scatter", mode: "lines", name: "Day VWAP", x, y: days.map((d) => (d.pq / d.q) * S), line: { color: "#ff9e1b", width: 2 } },
      { type: "bar", name: "Size", x, y: days.map((d) => d.q / 1000), yaxis: "y2", marker: { color: "rgba(255,158,27,0.35)" }, showlegend: false,
        hovertemplate: `%{x}: ${state.ccy} %{y:.1f}${packSize() ? "m DV01" : "bn"}<extra></extra>` },
    ], {
      xaxis: { type: "date", rangebreaks: [{ bounds: ["sat", "mon"] }], rangeslider: { visible: false }, tickformat: "%d %b %y" },
      yaxis: { domain: [0.3, 1], title: { text: unitOf() }, tickformat: scale() === 1 ? ".3f" : ".1f" },
      yaxis2: { domain: [0, 0.22], title: { text: packSize() ? `${state.ccy}m DV01` : `${state.ccy}bn` } },
    }, 460));
    return node;
  }

  function tradeTable(rows, cols) {
    const shown = rows.slice(-MAX_TABLE_ROWS);
    return el("div", { class: "table-wrap", style: { maxHeight: "380px", marginTop: "10px" } }, el("table", {},
      el("thead", {}, el("tr", {}, cols.map(([h], i) => el("th", { class: i < 2 || i > 8 ? "l" : "" }, h)), el("th", {}))),
      rows.length > shown.length ? el("caption", { class: "note", style: { captionSide: "bottom", textAlign: "left", padding: "4px 8px" } },
        `Latest ${fmt.int(shown.length)} of ${fmt.int(rows.length)} trades.`) : null,
      el("tbody", {}, [...shown].reverse().map((r) => el("tr", { style: r.outlier ? { color: "#6b6b6b" } : null },
        cols.map(([, f], i) => el("td", { class: i < 2 || i > 8 ? "l" : "" }, f(r))),
        el("td", { class: "l" }, r.outlier ? el("span", { class: "amber small" }, "outlier") : ""))))));
  }

  // ---------------------------------------------------------------- curve check and swap spreads

  function check() {
    const rows = summary.check;
    const date = rows[0]?.date;
    const off = (x) => (x == null ? "" : Math.abs(x) > 1 ? "neg" : "");
    const gpLink = (keys, text) => el("a", { href: `GP.html#${new URLSearchParams({ s: keys.map((k, i) => `${"ABCDEFGH"[i]}~${k}`).join(","), r: "All", v: "level" })}` }, text);
    const checkPanel = el("section", { class: "panel" }, el("h2", {}, `DTCC trades vs Eurex Clearing par swap rates${date ? `, ${date}` : ""}`),
      rows.length ? el("div", { class: "table-wrap" }, el("table", {},
        el("thead", {},
          el("tr", {}, [["", 2], ["Whole day", 3], ["Two hours to 17:30 Frankfurt", 3], ["", 1]].map(([g, span]) => el("th", { colspan: span, class: g ? "th-group" : "" }, g))),
          el("tr", {}, ["Series", "Eurex par %", "DTCC VWAP %", "Trades", "Diff bp", "DTCC VWAP %", "Trades", "Diff bp", ""].map((h, i) => el("th", { class: i ? "" : "l" }, h)))),
        el("tbody", {}, rows.map((r) => el("tr", { class: r.series.startsWith(state.ccy) ? "hl" : "" },
          el("td", { class: "l" }, r.series), el("td", {}, r.eurex.toFixed(4)),
          el("td", {}, r.vwap.toFixed(4)), el("td", {}, fmt.int(r.n)), el("td", {}, fmt.s(r.diff, 2)),
          el("td", {}, r.snap == null ? "–" : r.snap.toFixed(4)), el("td", {}, r.nSnap ? fmt.int(r.nSnap) : "–"),
          el("td", { class: off(r.diffSnap) }, r.snap == null ? "–" : fmt.s(r.diffSnap, 2)),
          el("td", { class: "l" }, gpLink([`S|${r.series}`, `D|${r.series}`, `=(B-A)*100|DTCC − Eurex ${r.series} bp`], "history")))))))
        : el("p", { class: "muted" }, "No day with both DTCC trades and Eurex curves yet."),
      footnotes(
        "Eurex par: spot-starting par swap rate from the Eurex Clearing end-of-day curves (the curves behind ASW, IRS, WIRP and TEST).",
        "DTCC VWAP: spot-starting trades of exactly that tenor at a market rate, off-market prints dropped.",
        "Snap window: the two hours before 17:30 Frankfurt (11:30 New York), where trades sat closest to the Eurex curves over Oct–Nov 2026; red = more than 1bp apart there.",
        "EUR and GBP have few trades per window (the repository only covers trades with a US party), so single points are noisy."));

    const l = spreads.latest;
    const spreadPanel = el("section", { class: "panel", style: { marginTop: "10px" } },
      el("h2", {}, `USD swap spread: SOFR swap − Treasury par yield, ${spreads.ustAsOf}`),
      el("div", { class: "table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Tenor", "UST par %", "Chg bp", "SOFR %", "Spread bp", "Chg bp", "As of", ""]
          .map((h, i) => el("th", { class: i ? "" : "l" }, h)))),
        el("tbody", {}, l.map((r) => el("tr", {},
          el("td", { class: "l amber" }, `${r.tenor}Y`),
          el("td", {}, r.ust ? r.ust.value.toFixed(2) : "–"), el("td", {}, r.ust ? fmt.s(r.ust.chg, 0) : "–"),
          el("td", {}, r.sofr ? r.sofr.value.toFixed(4) : "–"),
          el("td", {}, r.spread ? fmt.s(r.spread.value, 1) : "–"),
          el("td", { class: r.spread?.chg > 0 ? "pos" : r.spread?.chg < 0 ? "neg" : "" }, r.spread ? fmt.s(r.spread.chg, 1) : "–"),
          el("td", {}, r.spread?.date ?? "–"),
          el("td", { class: "l" }, gpLink([`SS|USD swap spread ${r.tenor}Y`], "history"))))))),
      footnotes(
        "UST par: US Treasury's daily par yield curve, from bid-side quotes at about 15:30 New York.",
        "SOFR: notional-weighted rate of spot-starting SOFR swaps of exactly that tenor executed 14:30–16:30 New York, the same time as the Treasury quotes (blank, or an earlier date, when none traded).",
        "Spread = SOFR − Treasury par yield as quoted (annual act/360 vs semi-annual); negative when swaps yield less than Treasuries. Changes: from the previous day with data.",
        "Traded swap spreads themselves are on the Trades tab, Type = Swap spread."));
    return [checkPanel, spreadPanel];
  }

  render();
}

function methodNote(summary) {
  return el("details", { class: "method panel" }, el("summary", {}, "Data and method"),
    el("ul", { class: "small" },
      el("li", {}, "Source: DTCC's public price dissemination of the CFTC rates report (", el("a", { href: summary.source, target: "_blank", rel: "noopener" }, "pddata.dtcc.com"),
        "): every swap with a US person on at least one side, reported in real time and published by DTCC each day. USD dominates; other currencies show only the part of their market with a US party. "
        + "Every day is archived, from 22 November 2024 (DTCC serves only about two years of files, so the archive keeps them). "
        + "Range sets how many days are loaded; All loads everything and is slow. Each weekday's 10:00 London refresh brings in the previous day's file (DTCC completes it after midnight New York), and every refresh re-reads the last five business days, "
        + "so corrections and cancellations reported within that time are applied; a later correction of an older trade is not."),
      el("li", {}, "Currencies and indices: USD SOFR, EUR 6M Euribor and €STR, GBP SONIA."),
      el("li", {}, "Key-rate tenors: 1, 2, 3, 5, 7, 10, 15, 20 and 30 years. By default only trades of exactly those lengths are shown; "
        + "\"Group all trades into key-rate brackets\" puts every trade in the bracket of the nearest key-rate tenor by length instead (trades under nine months in <9M)."),
      el("li", {}, "Kept: new trades and corrections of fixed / floating swaps and OIS with a fixed rate (no basis swaps, cross-currency, inflation, swaptions or FRAs), "
        + "that do not start before the trade date: back-dated trades are compressions and unwinds at off-market rates."),
      el("li", {}, "Start: spot if the swap starts within three business days of the trade, IMM if it starts on a third Wednesday of March, June, September or December, otherwise forward (labelled by the time to the start). "
        + "Tenor: start to end in whole months when the end falls within four days of an anniversary, else in years to one decimal."),
      el("li", {}, "Notional: in millions of the currency. Trades above the reporting cap are published at the cap with a +, so large trades are understated. "
        + "Flags: package (part of a multi-leg trade, e.g. a curve or a spread-over), spread (the package was quoted as a spread), upfront (the package has a price or the swap an upfront fee: the fixed rate is off market), "
        + "post-priced (rate fixed after execution), block, uncleared."),
      el("li", {}, "Trade types. DTCC does not link the legs of a package or say who paid or received, so types are inferred: legs of one package share the execution time to the second and the venue. "
        + "Curve: two legs of different maturities (a steepener or a flattener; the side is not published). Fly: three. "
        + "Invoice: a forward swap from a bond futures delivery date (Treasury futures: the first or last business day of March, June, September or December, or early the next month for TU and FV; Eurex: the 10th) "
        + "to a deliverable bond's maturity, not a whole number of years, whether or not it is reported as a package; the contract follows from the bond's remaining life (CME and Eurex deliverable ranges). "
        + "Swap spread: one spot-starting leg quoted as a spread, or ending on a government bond's maturity (an asset swap); the bond leg is not a swap, so it is not reported. "
        + "Its traded spread is the package spread, read in bp (reporters write it as a decimal or a percentage; read as a decimal unless that exceeds 200bp). "
        + "Other package: anything else in a package (e.g. legs reported at different seconds, or with swaptions). Outright: not in a package."),
      el("li", {}, "Off-market prints are left out of the charts and VWAPs: more than eight median absolute deviations, and at least 50bp, from the series median, or 5bp from that day's median."),
      el("li", {}, "History of the daily VWAPs of spot-starting standard tenors (SOFR, €STR, 6M Euribor, SONIA) and of the USD swap spreads is on GP.")));
}

try {
  const [summary, spreads, otr, ...mk] = await Promise.all([loadJSON("data/dtcc/summary.json"), loadJSON("data/spreads.json"),
    loadJSON("data/dtcc/ust_otr.json").catch(() => ({})),
    ...["UST", "DE", "FR", "IT"].map((m) => loadJSON(`data/markets/${m}.json`).catch(() => null))]);
  start(summary, spreads, otr, Object.fromEntries(["UST", "DE", "FR", "IT"].map((m, i) => [m, mk[i]]).filter(([, v]) => v)));
} catch (err) {
  showError(app, err);
}
