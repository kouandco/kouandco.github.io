import { $, COLORS, el, fmt, footnotes, frame, hashParam, loadJSON, plot, segmented, setHash, showError } from "./common.js";
import { contractSummary } from "./futures.js";

frame("CFTC");
const app = $("#app");

const ORDER = ["TU", "FV", "TY", "UXY", "US", "WN"];
const GROUP_COLORS = { asset: COLORS[1], lev: COLORS[3], dealer: COLORS[2], other: COLORS[4], nonrep: COLORS[9] };
const MEASURES = [{ code: "dv01", label: "DV01" }, { code: "ty", label: "10Y equivalents" }, { code: "contracts", label: "Contracts" }];
const RANGES = [{ code: "1Y", label: "1Y", weeks: 52 }, { code: "3Y", label: "3Y", weeks: 156 }, { code: "5Y", label: "5Y", weeks: 260 },
  { code: "10Y", label: "10Y", weeks: 520 }, { code: "All", label: "All", weeks: Infinity }];
const LOOKBACK = [{ code: "1", label: "1W", weeks: 1 }, { code: "4", label: "4W", weeks: 4 }, { code: "13", label: "13W", weeks: 13 }, { code: "52", label: "52W", weeks: 52 }];

function start(data, dv01) {
  const codes = ORDER.filter((c) => data.contracts[c]);
  const groups = Object.keys(data.groups);
  const state = {
    contract: hashParam("c", "ALL", ["ALL", ...codes]),
    measure: hashParam("m", "dv01", MEASURES.map((m) => m.code)),
    range: hashParam("r", "5Y", RANGES.map((r) => r.code)),
    back: hashParam("b", "4", LOOKBACK.map((l) => l.code)),
    group: hashParam("g", "lev", groups),
  };
  const body = el("div");
  app.append(
    el("div", { class: "page-title" }, el("h1", {}, "Treasury Positioning"),
      el("span", { class: "muted" }, `CFTC Commitments of Traders, Treasury futures · positions as of Tuesday ${data.asOf} · updated ${data.updated}`)),
    body, methodNote(data, dv01));

  // Every contract on the union of report dates (all six report on the same Tuesdays; Ultra 10Y starts in 2016).
  const dates = [...new Set(codes.flatMap((c) => data.contracts[c].dates))].sort();
  const index = Object.fromEntries(codes.map((c) => [c, new Map(data.contracts[c].dates.map((d, i) => [d, i]))]));
  // Net (or long / short) position of a group in a contract on a date, in contracts; null when not reported.
  const pos = (c, g, d, side = "net") => {
    const i = index[c].get(d);
    if (i == null) return null;
    const x = data.contracts[c][g];
    return side === "long" ? x.long[i] : side === "short" ? x.short[i] : x.long[i] - x.short[i];
  };
  // Contracts -> measure: DV01 in $m per bp, or 10-year note equivalents (DV01 / TY DV01), at today's DV01 per contract.
  const conv = (c) => (state.measure === "contracts" ? 1 : state.measure === "dv01" ? dv01[c] / 1e6 : dv01[c] / dv01.TY);
  const measureOf = (c, g, d, side) => {
    if (c !== "ALL") { const v = pos(c, g, d, side); return v == null ? null : v * conv(c); }
    let tot = 0, any = false;
    for (const k of codes) { const v = pos(k, g, d, side); if (v != null) { tot += v * conv(k); any = true; } }
    return any ? tot : null;
  };
  const unit = () => (state.measure === "dv01" ? "$m / bp" : state.measure === "ty" ? "10Y eq. (k)" : "contracts (k)");
  const scaleOut = (v) => (v == null ? null : state.measure === "dv01" ? v : v / 1000);     // thousands of contracts
  const show = (v, d = 1) => (v == null ? "–" : fmt.n(scaleOut(v), d));
  const pct = (xs, v) => (v == null || !xs.length ? null : xs.filter((x) => x <= v).length / xs.length);

  function render() {
    if (state.contract === "ALL" && state.measure === "contracts") state.measure = "dv01";
    setHash({ c: state.contract, m: state.measure, r: state.range, b: state.back, g: state.group });
    const last = dates.at(-1);
    const backWeeks = LOOKBACK.find((l) => l.code === state.back).weeks;
    const prior = dates[dates.length - 1 - backWeeks];
    const span = RANGES.find((r) => r.code === state.range).weeks;
    const shown = dates.slice(Math.max(0, dates.length - span));
    const measures = state.contract === "ALL" ? MEASURES.filter((m) => m.code !== "contracts") : MEASURES;

    // ---- table: net by group (rows) and contract (columns), change over the lookback, percentile since 2006
    const cols = [...codes, "ALL"];
    const cell = (c, g) => {
      const v = measureOf(c, g, last), p = prior ? measureOf(c, g, prior) : null;
      const hist = dates.map((d) => measureOf(c, g, d)).filter((x) => x != null);
      const rank = pct(hist, v);
      return el("td", { title: `${data.groups[g]} ${c === "ALL" ? "all contracts" : c}: ${show(v)} ${unit()}, ${state.back}W change ${p == null ? "–" : fmt.s(scaleOut(v - p), 1)}, `
        + `percentile of history ${rank == null ? "–" : fmt.pct(rank, 0)}` },
        el("div", { class: v > 0 ? "up" : v < 0 ? "down" : "" }, show(v)),
        el("div", { class: "small muted" }, `${p == null ? "–" : fmt.s(scaleOut(v - p), 1)} · ${rank == null ? "–" : `p${Math.round(rank * 100)}`}`));
    };
    const table = el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", { class: "l" }, `Net, ${unit()}`),
        cols.map((c) => el("th", { class: c === state.contract ? "sorted" : "", style: { cursor: c === "ALL" || state.measure !== "contracts" ? "pointer" : null },
          onclick: () => { state.contract = c; render(); } }, c === "ALL" ? "All UST futures" : `${c}`)))),
      el("tbody", {}, groups.map((g) => el("tr", { class: g === state.group ? "hl" : "", style: { cursor: "pointer" }, onclick: () => { state.group = g; render(); } },
        el("td", { class: "l", style: { color: GROUP_COLORS[g] } }, data.groups[g]),
        cols.map((c) => (state.measure === "contracts" && c === "ALL" ? el("td", { class: "muted" }, "–") : cell(c, g))))),
        el("tr", {}, el("td", { class: "l muted" }, "Open interest"),
          cols.map((c) => {
            if (c === "ALL" && state.measure === "contracts") return el("td", { class: "muted" }, "–");
            const oi = (k) => { const i = index[k].get(last); return i == null ? 0 : data.contracts[k].oi[i] * conv(k); };
            return el("td", { class: "muted" }, show(c === "ALL" ? codes.reduce((s, k) => s + oi(k), 0) : oi(c)));
          })))));

    // ---- tiles for the selected contract
    const tile = (k, g) => {
      const v = measureOf(state.contract, g, last), p = prior ? measureOf(state.contract, g, prior) : null;
      return el("div", { class: "tile", style: { borderLeftColor: GROUP_COLORS[g] } }, el("div", { class: "k" }, k),
        el("div", { class: "v" }, `${show(v)} `, el("span", { class: "small muted" }, unit())),
        el("div", { class: "n" }, `${state.back}W ${p == null ? "–" : fmt.s(scaleOut(v - p), 1)}`));
    };
    const name = state.contract === "ALL" ? "All UST futures" : `${state.contract} · ${data.contracts[state.contract].name}`;
    const tiles = el("div", { class: "tiles", style: { margin: "10px 0" } },
      el("div", { class: "tile" }, el("div", { class: "k" }, "Report"), el("div", { class: "v" }, last), el("div", { class: "n" }, `vs ${prior ?? "–"}`)),
      tile("Leveraged funds net", "lev"), tile("Asset managers net", "asset"), tile("Dealers net", "dealer"), tile("Other + non-reportables", "other"));

    // ---- net history by group
    const netNode = el("div", { class: "plot" });
    requestAnimationFrame(() => plot(netNode, groups.map((g) => ({
      type: "scatter", mode: "lines", name: data.groups[g], x: shown, y: shown.map((d) => scaleOut(measureOf(state.contract, g, d))),
      line: { color: GROUP_COLORS[g], width: g === state.group ? 2.5 : 1.5 }, connectgaps: false,
      hovertemplate: `${data.groups[g]} %{x}: %{y:,.1f} ${unit()}<extra></extra>`,
    })), { yaxis: { title: { text: unit() }, zeroline: true }, hovermode: "x unified" }, 380));

    // ---- across the curve: net by contract, latest (bars) and the lookback date (markers)
    const curveNode = el("div", { class: "plot" });
    const curveCodes = codes;
    requestAnimationFrame(() => plot(curveNode, groups.flatMap((g) => [
      { type: "bar", name: data.groups[g], x: curveCodes, y: curveCodes.map((c) => scaleOut(pos(c, g, last) == null ? null : pos(c, g, last) * (state.measure === "contracts" ? 1 : conv(c)))),
        marker: { color: GROUP_COLORS[g] }, offsetgroup: g, legendgroup: g, hovertemplate: `${data.groups[g]} %{x} ${last}: %{y:,.1f}<extra></extra>` },
      { type: "scatter", mode: "markers", name: `${data.groups[g]} ${prior}`, x: curveCodes, y: curveCodes.map((c) => scaleOut(pos(c, g, prior) == null ? null : pos(c, g, prior) * (state.measure === "contracts" ? 1 : conv(c)))),
        marker: { symbol: "line-ew-open", size: 16, color: "#e9e9e9", line: { width: 2 } }, offsetgroup: g, legendgroup: g, showlegend: false,
        hovertemplate: `${data.groups[g]} %{x} ${prior}: %{y:,.1f}<extra></extra>` },
    ]), { barmode: "group", yaxis: { title: { text: unit() } } }, 340));

    // ---- one group: gross long, gross short and net, with the number of traders
    const g = state.group;
    const grossNode = el("div", { class: "plot" });
    const traders = (side) => (state.contract === "ALL" ? shown.map(() => null) : shown.map((d) => {
      const i = index[state.contract].get(d);
      return i == null ? null : data.contracts[state.contract][g][side][i];
    }));
    requestAnimationFrame(() => plot(grossNode, [
      { type: "scatter", mode: "lines", name: "Long", x: shown, y: shown.map((d) => scaleOut(measureOf(state.contract, g, d, "long"))), fill: "tozeroy",
        line: { color: "#3ddc84", width: 1 }, fillcolor: "rgba(61,220,132,0.15)" },
      { type: "scatter", mode: "lines", name: "Short", x: shown, y: shown.map((d) => { const v = scaleOut(measureOf(state.contract, g, d, "short")); return v == null ? null : -v; }), fill: "tozeroy",
        line: { color: "#ff5c5c", width: 1 }, fillcolor: "rgba(255,92,92,0.15)" },
      { type: "scatter", mode: "lines", name: "Net", x: shown, y: shown.map((d) => scaleOut(measureOf(state.contract, g, d))), line: { color: GROUP_COLORS[g], width: 2.5 } },
      ...(state.contract === "ALL" || g === "nonrep" ? [] : [
        { type: "scatter", mode: "lines", name: "Traders long", x: shown, y: traders("tLong"), yaxis: "y2", line: { color: "#3ddc84", width: 1, dash: "dot" } },
        { type: "scatter", mode: "lines", name: "Traders short", x: shown, y: traders("tShort"), yaxis: "y2", line: { color: "#ff5c5c", width: 1, dash: "dot" } }]),
    ], {
      yaxis: { title: { text: `${unit()} (short below zero)` }, domain: state.contract === "ALL" || g === "nonrep" ? [0, 1] : [0.3, 1] },
      yaxis2: { domain: [0, 0.22], title: { text: "Traders" } }, hovermode: "x unified", xaxis: { range: [shown[0], shown.at(-1)] },
    }, 420));

    body.replaceChildren(
      el("div", { class: "row", style: { marginBottom: "6px" } },
        el("span", { class: "amber" }, "Contract"),
        segmented([{ code: "ALL", label: "All" }, ...codes.map((c) => ({ code: c, label: c }))], state.contract, (v) => { state.contract = v; render(); }),
        el("span", { class: "amber" }, "Measure"), segmented(measures, state.measure, (v) => { state.measure = v; render(); }),
        el("span", { class: "amber" }, "Change over"), segmented(LOOKBACK, state.back, (v) => { state.back = v; render(); }),
        el("span", { class: "amber" }, "Range"), segmented(RANGES, state.range, (v) => { state.range = v; render(); })),
      tiles,
      el("section", { class: "panel" }, el("h2", {}, `Net positions, ${last}`), table,
        footnotes("Each cell: net long (green) or short (red).",
          `Below it: the ${state.back}-week change, and the percentile of that net position since 2006 (p100: the longest ever, p0: the shortest).`,
          "Click a column for its charts, a row for its long / short history.")),
      el("div", { class: "grid cols-2", style: { marginTop: "10px" } },
        el("section", { class: "panel" }, el("h2", {}, `Net by trader group: ${name}`), netNode),
        el("section", { class: "panel" }, el("h2", {}, `Across the curve: net by contract, ${last} vs ${prior}`), curveNode)),
      el("section", { class: "panel", style: { marginTop: "10px" } },
        el("h2", {}, `${data.groups[g]}: long, short and net, ${name}`),
        el("div", { class: "row", style: { marginBottom: "4px" } }, el("span", { class: "amber" }, "Group"),
          segmented(groups.map((k) => ({ code: k, label: data.groups[k] })), state.group, (v) => { state.group = v; render(); })),
        grossNode));
  }
  render();
}

function methodNote(data, dv01) {
  return el("details", { class: "method panel" }, el("summary", {}, "Data and method"),
    el("ul", { class: "small" },
      el("li", {}, "Source: CFTC Commitments of Traders, Traders in Financial Futures report, futures only (",
        el("a", { href: data.source, target: "_blank", rel: "noopener" }, "CFTC public reporting"),
        "). Positions at Tuesday's close, published Friday 15:30 New York; the site picks them up at the Friday 23:30 London refresh. Weekly since June 2006 (Ultra 10-Year since 2016, Ultra Bond since 2010)."),
      el("li", {}, "Groups (CFTC definitions): dealers / intermediaries (sell-side), asset managers / institutional (pension funds, insurers, mutual funds), "
        + "leveraged funds (hedge funds, CTAs, proprietary traders), other reportables, and non-reportable (positions below the reporting level). "
        + "Net = long − short; spread positions are equal on both sides and left out. Every long has a short, so the groups' nets sum to zero."),
      el("li", {}, `DV01 and 10-year equivalents use today's DV01 per contract (the CTD's DV01 / conversion factor, from the CTD page model): `
        + ORDER.filter((c) => dv01[c]).map((c) => `${c} $${fmt.int(dv01[c])}`).join(", ")
        + ". Earlier weeks are converted at the same DV01, so the history shows positions at today's risk per contract, not the risk at the time."),
      el("li", {}, "Leveraged funds' large shorts against asset managers' longs are largely the cash-futures basis trade: funds buy Treasuries and sell futures to asset managers who want duration through futures."),
      el("li", {}, "Net positions by contract and group are also on GP (kind CFTC), in contracts.")));
}

try {
  const [data, futures, ust] = await Promise.all(["data/cftc.json", "data/futures.json", "data/markets/UST.json"].map(loadJSON));
  // DV01 per contract ($ per bp) from the CTD model; falls back to typical values if a contract cannot be priced.
  const fallback = { TU: 38, FV: 45, TY: 65, UXY: 90, US: 130, WN: 220 };
  const dv01 = Object.fromEntries(ORDER.map((c) => {
    const s = futures.contracts[c] ? contractSummary(c, futures.contracts[c], ust) : null;
    return [c, s?.dv01 > 0 ? s.dv01 : fallback[c]];
  }));
  start(data, dv01);
} catch (err) {
  showError(app, err);
}
