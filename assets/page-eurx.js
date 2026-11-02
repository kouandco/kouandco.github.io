import { $, el, fmt, frame, hashParam, loadJSON, plot, segmented, setHash, showError } from "./common.js";
import { parseDate, yieldFromPrice } from "./bond.js";
import { prepare } from "./futures.js";

frame("EURX");
const app = $("#app");
const CODES = ["DU", "OE", "RX", "UB", "OAT", "BTS", "IK"];

// ---- small statistics helpers
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : undefined);
function quantile(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return undefined;
  const i = (s.length - 1) * p, lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
}
const median = (xs) => quantile(xs, 0.5);

// All trades of a series in sequence; VWAP and its running total restart each day.
function withVwap(rows) {
  let pq = 0, q = 0, day = null;
  return rows.map((r, i) => {
    const d = r.t.slice(0, 10);
    if (d !== day) { pq = 0; q = 0; day = d; }
    pq += r.v * r.q; q += r.q;
    return { ...r, i, day: d, time: r.t.slice(11, 16), vwap: pq / q, prev: i ? rows[i - 1].v : r.v, first: i === 0 || rows[i - 1].t.slice(0, 10) !== d };
  });
}

// Outliers are left out of the charts and VWAP but kept, flagged, in the trade table.
// Stage 1 (gross misprints): more than k median absolute deviations, and at least `floor`, from the series median.
function grossSplit(rows, floor, k = 8) {
  const med = median(rows.map((r) => r.v));
  const mad = median(rows.map((r) => Math.abs(r.v - med))) || 0;
  const limit = Math.max(floor, k * mad);
  return { kept: rows.filter((r) => Math.abs(r.v - med) <= limit), dropped: rows.filter((r) => Math.abs(r.v - med) > limit) };
}
// Stage 2 (off-market prints): more than k typical deviations, and at least `floor`, from that day's median.
function localSplit(rows, floor, k = 8) {
  const byDay = new Map();
  for (const r of rows) (byDay.get(r.t.slice(0, 10)) ?? byDay.set(r.t.slice(0, 10), []).get(r.t.slice(0, 10))).push(r.v);
  const dayMedian = new Map([...byDay].map(([d, vs]) => [d, median(vs)]));
  const dev = (r) => Math.abs(r.v - dayMedian.get(r.t.slice(0, 10)));
  const limit = Math.max(floor, k * (median(rows.map(dev)) || 0));
  return { kept: rows.filter((r) => dev(r) <= limit), dropped: rows.filter((r) => dev(r) > limit) };
}
const withOutliers = (rows, outliers) => [...rows, ...outliers.map((r) => ({ ...r, outlier: true, time: r.t.slice(11, 16) }))]
  .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));

// Matched EFS print in two clusters ~15–30 bp apart on the same swap dates, consistent with €STR OIS vs 6m Euribor
// floating legs (the trade file has no index field). Split them with a 1-D two-means so each VWAP is like-for-like.
function twoMeans(values) {
  let lo = quantile(values, 0.1), hi = quantile(values, 0.9);
  for (let k = 0; k < 20; k++) {
    const mid = (lo + hi) / 2;
    lo = mean(values.filter((v) => v <= mid)) ?? lo;
    hi = mean(values.filter((v) => v > mid)) ?? hi;
  }
  return { lo, hi, cut: (lo + hi) / 2, split: hi - lo >= 8 };
}

function start(trades, contracts, markets) {
  const state = {
    code: hashParam("c", "RX", CODES),
    tab: hashParam("t", "efp", ["efp", "efs"]),
    bond: "CTD", view: "Waterfall", efsType: "Matched", efsLeg: "Lower",
  };
  const header = el("div");
  const body = el("div");
  app.append(
    el("div", { class: "page-title" }, el("h1", {}, "Eurex Flow"),
      el("span", { class: "muted" }, "basis trades (EFP) and invoice spreads (EFS) in Eurex government bond futures")),
    header, body, methodNote());

  function ranked() {
    const c = contracts[state.code];
    const model = prepare(c, markets[c.market]);
    return { contract: c, bonds: [...model.bonds].sort((a, b) => a.ratio0 - b.ratio0), model };
  }

  function render() {
    setHash({ c: state.code, t: state.tab });
    const { contract, bonds } = ranked();
    const [ctd1, ctd2] = bonds;
    header.replaceChildren(
      el("div", { class: "row", style: { marginBottom: "6px" } },
        segmented(CODES.map((k) => ({ code: k, label: k })), state.code, (k) => { state.code = k; render(); }),
        el("span", { class: "muted small" }, `${contract.name} ${contract.expiry} · trade data updated ${trades.updated} · times as published by Eurex`)),
      el("nav", { class: "tabs subtabs" },
        el("button", { class: state.tab === "efp" ? "active" : "", onclick: () => { state.tab = "efp"; render(); } }, "Basis trades (EFP)"),
        el("button", { class: state.tab === "efs" ? "active" : "", onclick: () => { state.tab = "efs"; render(); } }, "Invoice spreads (EFS)")));
    if (!ctd1) { body.replaceChildren(el("p", { class: "down" }, "No priced deliverables for this contract.")); return; }
    body.replaceChildren(...(state.tab === "efp" ? efp(contract, ctd1, ctd2) : efs(contract, ctd1)));
  }

  function controls(items) {
    return el("div", { class: "row", style: { margin: "10px 0" } }, items.map(([label, opts, key]) =>
      el("span", { class: "row" }, el("span", { class: "amber" }, label), segmented(opts, state[key], (v) => { state[key] = v; render(); }))));
  }

  function efp(contract, ctd1, ctd2) {
    const bond = state.bond === "CTD" || !ctd2 ? ctd1 : ctd2;
    const gross = grossSplit(trades.efp.filter((r) => r.c === state.code && r.x === contract.expiry && r.isin === bond.id)
      .map((r) => ({ ...r, v: (r.cash - r.f * bond.cf) * 100 })), 25);
    const local = localSplit(gross.kept, 2);
    const rows = withVwap(local.kept);
    const dropped = [...gross.dropped, ...local.dropped];
    return [
      controls([
        ["Bond", [{ code: "CTD", label: `CTD: ${ctd1.name}` }, ...(ctd2 ? [{ code: "2nd", label: `2nd CTD: ${ctd2.name}` }] : [])], "bond"],
        ["View", [{ code: "Waterfall", label: "Waterfall" }, { code: "Bubbles", label: "Bubbles" }], "view"]]),
      el("p", { class: "note" }, `${bond.name} (${bond.id}), CF ${bond.cf.toFixed(6)}. Gross basis = cash price − futures × CF, in cents (0.01 points).`),
      tiles(rows, "c", 1),
      el("section", { class: "panel" }, el("h2", {}, "All trades: gross basis, daily VWAP (resets each morning) and lots"), chart(rows, "c"), outlierNote(dropped.length)),
      tradeTable(withOutliers(rows, dropped), [
        ["Time", (r) => r.t.replace("T", " ")], ["Lots", (r) => fmt.int(r.q)], ["Futures", (r) => r.f.toFixed(3)],
        ["Cash", (r) => r.cash.toFixed(4)], ["Gross basis (c)", (r) => r.v.toFixed(1)], ["Day VWAP (c)", (r) => (r.outlier ? "–" : r.vwap.toFixed(1))]]),
    ];
  }

  function efs(contract, ctd1) {
    // Invoice spread in bp: swap fixed rate − CTD yield implied by the futures price (forward price = futures × CF).
    // Matched EFS: swap starts around delivery and ends within 45 days of the CTD's maturity.
    const ctdMaturity = parseDate(ctd1.maturity);
    const isMatched = (r) => Math.abs(parseDate(`${r.e.slice(0, 4)}-${r.e.slice(4, 6)}-${r.e.slice(6)}`) - ctdMaturity) <= 45 * 864e5
      && r.s >= contract.delivery.replaceAll("-", "").slice(0, 6) + "01";
    const matched = state.efsType === "Matched";
    const gross = grossSplit(trades.efs.filter((r) => r.c === state.code && r.x === contract.expiry && isMatched(r) === matched)
      .map((r) => {
        const y = yieldFromPrice(ctd1.price, r.f * ctd1.cf);
        return { ...r, y, v: (r.rate - y) * 100 };
      }), 40);
    const clusters = twoMeans(gross.kept.map((r) => r.v));
    const all = matched && clusters.split ? gross.kept.filter((r) => (r.v > clusters.cut) === (state.efsLeg === "Upper")) : gross.kept;
    const local = localSplit(all, 3);
    const rows = withVwap(local.kept);
    const dropped = [...gross.dropped, ...local.dropped];
    const fmtDate = (s) => `${s.slice(2, 4)}/${s.slice(4, 6)}/${s.slice(6)}`;
    return [
      controls([
        ["Swap", [{ code: "Matched", label: "Matched to CTD (invoice spread)" }, { code: "Other", label: "Other tenors" }], "efsType"],
        ...(matched && clusters.split ? [["Cluster", [{ code: "Lower", label: "Lower (likely €STR OIS)" }, { code: "Upper", label: "Upper (likely 6m Euribor)" }], "efsLeg"]] : []),
        ["View", [{ code: "Waterfall", label: "Waterfall" }, { code: "Bubbles", label: "Bubbles" }], "view"]]),
      el("p", { class: "note" }, matched
        ? `Invoice spread = fixed rate of a forward swap from delivery to the ${ctd1.name} maturity − the CTD yield implied by the futures price (forward price = futures × ${ctd1.cf.toFixed(6)}, settling ${contract.delivery}), in bp. Positive: swap above the futures-implied yield.`
          + (clusters.split ? ` Matched trades fall in two clusters (centres ${clusters.lo.toFixed(1)} and ${clusters.hi.toFixed(1)} bp), most likely €STR OIS and 6m Euribor swaps; Eurex's file does not say which, so the split is inferred.` : "")
        : "EFS against swaps not matched to the CTD (other start or end dates, e.g. spot-starting 10-year swaps): swap rate − futures-implied CTD yield, in bp. The tenor mismatch adds curve slope, so compare like tenors."),
      tiles(rows, "bp", 1),
      el("section", { class: "panel" }, el("h2", {}, "All trades: invoice spread, daily VWAP (resets each morning) and lots"), chart(rows, "bp"), outlierNote(dropped.length)),
      tradeTable(withOutliers(rows, dropped), [
        ["Time", (r) => r.t.replace("T", " ")], ["Lots", (r) => fmt.int(r.q)], ["Futures", (r) => r.f.toFixed(3)],
        ["Implied CTD yield", (r) => `${r.y.toFixed(3)}%`], ["Swap rate", (r) => `${r.rate.toFixed(4)}%`],
        ["Swap", (r) => `${fmtDate(r.s)} → ${fmtDate(r.e)}`], ["Invoice spread (bp)", (r) => r.v.toFixed(1)], ["Day VWAP (bp)", (r) => (r.outlier ? "–" : r.vwap.toFixed(1))]]),
    ];
  }

  // Stats for the latest trading day in the series.
  function tiles(rows, unit, d) {
    if (!rows.length) return el("p", { class: "muted" }, "No trades in this series.");
    const r = rows[rows.length - 1];
    const today = rows.filter((x) => x.day === r.day);
    const vals = today.map((x) => x.v);
    const tile = (k, v, n = "") => el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v), el("div", { class: "n" }, n));
    return el("div", { class: "tiles", style: { marginBottom: "10px" } },
      tile("Latest day", r.day, `${fmt.int(today.length)} trades`),
      tile("Lots", fmt.int(sum(today.map((x) => x.q)))),
      tile("VWAP", `${r.vwap.toFixed(d)} ${unit}`),
      tile("Last", `${r.v.toFixed(d)} ${unit}`, r.time),
      tile("Day range", `${Math.min(...vals).toFixed(d)} – ${Math.max(...vals).toFixed(d)}`));
  }

  // Every trade in sequence: level (waterfall or bubbles), the day's running VWAP and lots. Thin rules mark each day.
  function chart(rows, unit) {
    const node = el("div", { class: "plot" });
    if (!rows.length) return node;
    const idx = rows.map((r) => r.i);
    const starts = rows.filter((r) => r.first);
    const hover = rows.map((r) => `${r.day} ${r.time} · ${fmt.int(r.q)} lots<br>${r.v.toFixed(2)} ${unit} (${fmt.s(r.v - r.prev, 2)})<br>day VWAP ${r.vwap.toFixed(2)} ${unit}`);
    const vx = [], vy = [];
    rows.forEach((r, k) => { if (r.first && k) { vx.push(null); vy.push(null); } vx.push(r.i); vy.push(r.vwap); });
    const perTrade = 820 / rows.length;
    const labelled = [];
    for (const r of starts) if (!labelled.length || (r.i - labelled[labelled.length - 1]) * perTrade >= 40) labelled.push(r.i);
    const maxQ = Math.max(...rows.map((r) => r.q));
    const level = state.view === "Waterfall"
      ? [{ type: "bar", name: "Trade", x: idx, base: rows.map((r) => r.prev), y: rows.map((r) => r.v - r.prev || 1e-9),
          marker: { color: rows.map((r) => (r.v > r.prev ? "#3ddc84" : r.v < r.prev ? "#ff5c5c" : "#5c5c5c")) }, hovertext: hover, hoverinfo: "text", showlegend: false },
         { type: "scatter", mode: "markers", name: "Print", x: idx, y: rows.map((r) => r.v), marker: { symbol: "line-ew-open", size: 7, color: "#e9e9e9", line: { width: 1 } }, hoverinfo: "skip", showlegend: false }]
      : [{ type: "scatter", mode: "markers", name: "Trade (size = lots)", x: idx, y: rows.map((r) => r.v),
          marker: { size: rows.map((r) => r.q), sizemode: "area", sizeref: (2 * maxQ) / 22 ** 2, sizemin: 2, color: "rgba(95,168,255,0.35)", line: { color: "#5fa8ff", width: 1 } },
          hovertext: hover, hoverinfo: "text" }];
    requestAnimationFrame(() => plot(node, [
      ...level,
      { type: "scatter", mode: "lines", name: "Day VWAP", x: vx, y: vy, line: { color: "#ff9e1b", width: 2, shape: "hv" }, connectgaps: false, hoverinfo: "skip" },
      { type: "bar", name: "Lots", x: idx, y: rows.map((r) => r.q), yaxis: "y2", marker: { color: "rgba(255,158,27,0.35)" }, hovertext: hover, hoverinfo: "text", showlegend: false },
    ], {
      bargap: 0.15,
      xaxis: { tickvals: labelled, ticktext: labelled.map((i) => rows[i].day.slice(5)), range: [-0.5, rows.length - 0.5], showgrid: false },
      yaxis: { domain: [0.3, 1], title: { text: unit } },
      yaxis2: { domain: [0, 0.22], title: { text: "Lots" } },
      shapes: starts.slice(1).map((r) => ({ type: "line", x0: r.i - 0.5, x1: r.i - 0.5, y0: 0, y1: 1, yref: "paper", line: { color: "rgba(255,255,255,0.08)", width: 1 } })),
    }, 460));
    return node;
  }

  function outlierNote(n) {
    return n ? el("p", { class: "note" }, `${n} print${n > 1 ? "s" : ""} flagged as outliers (far from the series or that day's median) ${n > 1 ? "are" : "is"} left out of the chart and VWAP, and marked in the table below.`) : "";
  }

  function tradeTable(rows, cols) {
    return el("div", { class: "table-wrap", style: { maxHeight: "380px", marginTop: "10px" } }, el("table", {},
      el("thead", {}, el("tr", {}, cols.map(([h], i) => el("th", { class: i ? "" : "l" }, h)), el("th", {}))),
      el("tbody", {}, [...rows].reverse().map((r) => el("tr", { style: r.outlier ? { color: "#6b6b6b" } : null },
        cols.map(([, f], i) => el("td", { class: i ? "" : "l" }, f(r))),
        el("td", { class: "l" }, r.outlier ? el("span", { class: "amber small" }, "outlier") : ""))))));
  }

  render();
}

function methodNote() {
  return el("details", { class: "method panel" }, el("summary", {}, "Data and method"),
    el("ul", { class: "small" },
      el("li", {}, "EFP and EFS trades: Eurex EFP-Fin and EFS trade files. Eurex lists only about 20 trading days, so every file is archived and the archive extended each weekday at 10:00 London. Only the front contract is shown."),
      el("li", {}, "CTD and 2nd CTD: deliverables ranked by forward price / conversion factor at the latest closing yields, as on the CTD page. EFPs against any other bond are excluded."),
      el("li", {}, "Gross basis = cash price − futures × CF (cents). It includes carry to delivery, so it drifts down towards the net basis as delivery approaches."),
      el("li", {}, "Invoice spread = swap fixed rate − the CTD yield implied by the futures price, treating futures × CF as the CTD's forward price on the delivery date. Swap tenors in an EFS vary, so compare spreads across trades with similar tenors.")));
}

try {
  const [trades, futures, de, fr, it] = await Promise.all(["data/eurex_trades.json", "data/futures.json", "data/markets/DE.json",
    "data/markets/FR.json", "data/markets/IT.json"].map(loadJSON));
  start(trades, futures.contracts, { DE: de, FR: fr, IT: it });
} catch (err) {
  showError(app, err);
}
