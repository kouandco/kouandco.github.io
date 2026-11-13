import { $, COLORS, el, fmt, plot, showError } from "../common.js";
import { field, hashState, riskFrame, saveHash, tile } from "./common.js";
import { loadMarket, mean, quantile, rng } from "./rates.js";
import { SYM, corr, forward, last, loadFX, returns, series, vol } from "./fxdata.js";

riskFrame("FXHG");
const app = $("#app");

const CCYS = ["USD", "EUR", "GBP"];
const PRESETS = {
  pe: { label: "PE fund: USD, European assets", base: "USD", baseAssets: 300, exps: [{ ccy: "EUR", nav: 400, h: null }, { ccy: "GBP", nav: 250, h: null }],
    ratio: 50, tenor: 3, hold: 5, irr: 15, facility: 100, stress: 10 },
  credit: { label: "€7bn credit fund, 100% hedged", base: "EUR", baseAssets: 2400, exps: [{ ccy: "USD", nav: 3500, h: null }, { ccy: "GBP", nav: 1200, h: null }],
    ratio: 100, tenor: 3, hold: 4, irr: 9, facility: 350, stress: 10 },
  infra: { label: "GBP infra fund, EUR assets", base: "GBP", baseAssets: 900, exps: [{ ccy: "EUR", nav: 600, h: null }, { ccy: "USD", nav: 0, h: null }],
    ratio: 75, tenor: 6, hold: 8, irr: 10, facility: 60, stress: 10 },
};
const state = hashState({ preset: "pe", ...PRESETS.pe, drift: "spot", paths: 4000 });

const formBox = el("div"), expBox = el("div"), tiles = el("div", { class: "tiles" }), advice = el("ul", { class: "advice" });
const charts = { ratio: el("div", { class: "plot" }), liq: el("div", { class: "plot" }), irr: el("div", { class: "plot" }), cum: el("div", { class: "plot" }) };

app.append(
  el("div", { class: "page-title" }, el("h1", {}, "Fund-level FX hedging"),
    el("span", { class: "muted" }, "hedge ratio, carry and the liquidity cost of rolling forwards · scenario saved in the URL")),
  el("div", { class: "grid hedge-layout" },
    el("section", { class: "panel" }, el("h2", {}, "Fund and programme"), formBox),
    el("section", { class: "panel stack" }, el("h2", {}, "Programme at a glance"), tiles,
      el("h2", { style: { marginTop: "10px" } }, "Recommendation"), advice)),
  el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "Exposures and forwards"), expBox),
  el("div", { class: "grid cols-2", style: { marginTop: "10px" } },
    el("section", { class: "panel" }, el("h2", {}, "Hedge ratio: FX volatility vs carry"), charts.ratio),
    el("section", { class: "panel" }, el("h2", {}, "Cash to settle one roll vs FX move"), charts.liq),
    el("section", { class: "panel" }, el("h2", {}, "Fund IRR in base currency by hedge ratio"), charts.irr),
    el("section", { class: "panel" }, el("h2", {}, "Cumulative hedge settlements over the hold (5–95%)"), charts.cum)),
  methodNote());

let mkt, fx;
Promise.all([loadMarket(), loadFX()]).then(([m, f]) => { mkt = m; fx = f; render(); }).catch((e) => showError(app, e));

function chol(S) {   // Cholesky of a small covariance matrix
  const n = S.length, L = S.map(() => Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = S[i][j];
    for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-14)) : s / L[j][j];
  }
  return L;
}

function render() {
  saveHash(state);
  const sym = SYM[state.base];
  state.exps = state.exps.filter((e) => e.ccy !== state.base);
  for (const c of CCYS) if (c !== state.base && !state.exps.some((e) => e.ccy === c)) state.exps.push({ ccy: c, nav: 0, h: null });
  const exps = state.exps;
  const ser = exps.map((e) => series(fx, e.ccy, state.base));
  const rets = returns(ser);
  const vols = rets.map(vol);
  const C = rets.map((a) => rets.map((b) => corr(a, b)));
  const cov = C.map((row, i) => row.map((r, j) => r * vols[i] * vols[j]));
  const T = state.tenor / 12;
  const rows = exps.map((e, i) => {
    const S = last(ser[i]), F = forward(mkt, S, e.ccy, state.base, state.tenor), F12 = forward(mkt, S, e.ccy, state.base, 12);
    const h = (e.h ?? state.ratio) / 100, V = e.nav * S;
    return { e, i, S, F, carry: F12 / S - 1, h, V, H: h * V, vol: vols[i] };
  });
  const nav = state.baseAssets + rows.reduce((s, r) => s + r.V, 0);
  const qf = (u) => Math.sqrt(u.reduce((s, ui, i) => s + u.reduce((t, uj, j) => t + ui * uj * cov[i][j], 0), 0));
  const fxVol = (ratio) => qf(rows.map((r) => r.V * (1 - (ratio ?? r.h)))) / nav;
  const carryOf = (ratio) => rows.reduce((s, r) => s + (ratio ?? r.h) * r.V * r.carry, 0);
  const var99 = (ratio) => 2.326 * qf(rows.map((r) => (ratio ?? r.h) * r.V)) * Math.sqrt(T);
  const H = rows.reduce((s, r) => s + r.H, 0);
  const stressCash = H * state.stress / 100;

  // ---- simulation: roll by roll, hedges sell fixed foreign amounts (h × local NAV) forward
  const steps = Math.max(1, Math.round((state.hold * 12) / state.tenor));
  const L = chol(cov.map((r) => r.map((x) => x * T)));
  const M = (1 + state.irr / 100) ** state.hold;
  const sims = (ratios) => {
    const z = rng(23), out = ratios.map(() => ({ irr: new Float64Array(state.paths), worst: new Float64Array(state.paths), cumEnd: new Float64Array(state.paths) }));
    const cumPaths = ratios.map(() => Array.from({ length: steps + 1 }, () => new Float64Array(state.paths)));
    for (let p = 0; p < state.paths; p++) {
      const S = rows.map((r) => r.S), cum = ratios.map(() => 0), worst = ratios.map(() => 0);
      for (let k = 0; k < steps; k++) {
        const e = rows.map(() => z());
        const next = S.map((s, i) => {
          const shock = L[i].reduce((t, l, j) => t + l * e[j], 0);
          const drift = state.drift === "forward" ? Math.log(1 + rows[i].carry) * T : -0.5 * cov[i][i] * T;
          return s * Math.exp(drift + shock);
        });
        ratios.forEach((ra, m) => {
          rows.forEach((r, i) => {
            const h = ra ?? r.h;
            cum[m] += h * r.e.nav * (S[i] * (1 + r.carry * T) - next[i]);   // forward struck at S·(1 + carry·T), settled at the next spot
          });
          worst[m] = Math.min(worst[m], cum[m]);
          cumPaths[m][k + 1][p] = cum[m];
        });
        next.forEach((v, i) => { S[i] = v; });
      }
      ratios.forEach((ra, m) => {
        const proceeds = state.baseAssets * M + rows.reduce((s, r, i) => s + r.e.nav * M * S[i], 0) + cum[m];
        out[m].irr[p] = (Math.max(proceeds, 1e-9) / nav) ** (1 / state.hold) - 1;
        out[m].worst[p] = -worst[m];
        out[m].cumEnd[p] = cum[m];
      });
    }
    return { out, cumPaths };
  };
  const RATIOS = [0, 0.25, 0.5, 0.75, 1, null];
  const sim = sims(RATIOS);
  const cur = sim.out[RATIOS.length - 1];
  const pBreach = cur.worst.filter((w) => w > state.facility).length / state.paths;

  // ---- form
  formBox.replaceChildren(
    el("div", { class: "form-group" }, el("div", { class: "lbl" }, "Presets"),
      el("div", { class: "seg" }, Object.entries(PRESETS).map(([k, p]) => el("button", { class: `btn${state.preset === k ? " on" : ""}`,
        onclick: () => { Object.assign(state, structuredClone(p), { preset: k }); render(); } }, p.label)))),
    el("div", { class: "form-group" }, el("div", { class: "lbl" }, "Fund"),
      el("div", { class: "form" },
        field("Base currency", state, "base", render, { options: CCYS.map((v) => ({ v, label: v })) }),
        field(`Base-ccy assets (${sym}mm)`, state, "baseAssets", render, { step: 50 }),
        field("Local IRR (%)", state, "irr", render, { step: 1, title: "Asset return in local currency, the same for every currency" }),
        field("Hold (y)", state, "hold", render, { step: 1 }))),
    el("div", { class: "form-group" }, el("div", { class: "lbl" }, "Programme"),
      el("div", { class: "form" },
        field("Hedge ratio (%)", state, "ratio", render, { step: 5 }),
        field("Roll tenor", state, "tenor", render, { options: [1, 3, 6, 12].map((v) => ({ v, label: `${v}m` })) }),
        field(`Liquidity line (${sym}mm)`, state, "facility", render, { step: 10, title: "Subscription or hedging facility available to settle forwards" }),
        field("Stress move (%)", state, "stress", render, { step: 1, title: "Foreign currencies appreciating against the base over one roll" }),
        field("FX central case", state, "drift", render, { options: [{ v: "spot", label: "Spot unchanged" }, { v: "forward", label: "Forwards realised" }] }),
        field("Paths", state, "paths", render, { options: [1000, 2000, 4000, 8000].map((v) => ({ v, label: String(v) })) }))));

  // ---- exposures
  const inp = (e, key, step, ph) => {
    const i = el("input", { type: "number", step, value: e[key] ?? "", placeholder: ph ?? "" });
    i.addEventListener("change", () => { e[key] = i.value === "" ? null : Number(i.value); state.preset = null; render(); });
    return el("td", { class: "edit" }, i);
  };
  const dp = (r) => (r.S > 20 ? 100 : 1e4);
  expBox.replaceChildren(el("div", { class: "table-wrap" }, el("table", {},
    el("thead", {}, el("tr", {}, [["Currency", "l"], ["NAV local mm"], [`Spot ${state.base} per`], [`NAV ${sym}mm`], ["% of fund"], ["Hedge %"],
      [`Hedged ${sym}mm`], [`${state.tenor}m fwd`], ["Fwd pts"], ["Carry %/y"], [`Carry ${sym}mm/y`], ["1y vol %"]].map(([t, l]) => el("th", { class: l ?? "" }, t)))),
    el("tbody", {}, rows.map((r) => el("tr", {},
      el("td", { class: "l" }, `${r.e.ccy}${state.base}`), inp(r.e, "nav", 50), el("td", {}, r.S.toFixed(4)), el("td", {}, fmt.n(r.V, 0)),
      el("td", {}, fmt.pct(r.V / nav, 1)), inp(r.e, "h", 5, String(state.ratio)), el("td", {}, fmt.n(r.H, 0)), el("td", {}, r.F.toFixed(4)),
      el("td", {}, fmt.s((r.F - r.S) * dp(r), 1)), el("td", { class: r.carry > 0 ? "pos" : "neg" }, fmt.s(100 * r.carry, 2)),
      el("td", { class: r.carry > 0 ? "pos" : "neg" }, fmt.s(r.H * r.carry, 1)), el("td", {}, fmt.n(100 * r.vol, 1))))))),
  el("p", { class: "note" }, `Spot: ECB reference rates of ${fx.asOf}. Forwards by covered interest parity off the SOFR, €STR and SONIA curves `
    + `(${mkt.asOfIso}). Carry: what selling the currency forward for 12 months earns (+) or costs (−) a year, i.e. the rate differential. `
    + `Correlation ${rows.length > 1 ? `${rows[0].e.ccy}–${rows[1].e.ccy} vs ${state.base}: ${C[0][1].toFixed(2)}` : ""}. Blank hedge % uses the programme ratio.`));

  // ---- tiles
  const fxShare = (nav - state.baseAssets) / nav;
  tiles.replaceChildren(
    tile("Fund NAV", `${sym}${fmt.n(nav, 0)}mm`, `${fmt.pct(fxShare, 0)} in foreign currency`),
    tile("FX vol of NAV", `${fmt.pct(fxVol(0), 1)} → ${fmt.pct(fxVol(), 1)}`, "unhedged → programme, a year"),
    tile("Carry", `${carryOf() < 0 ? "−" : "+"}${sym}${fmt.n(Math.abs(carryOf()), 1)}mm/y`, `${fmt.s((carryOf() / nav) * 1e4, 0)}bp of NAV a year`, carryOf() >= 0 ? "up" : "down"),
    tile(`99% roll cash (${state.tenor}m)`, `${sym}${fmt.n(var99(), 0)}mm`, `${fmt.n(var99() / Math.max(state.facility, 1e-9), 1)}x the line`),
    tile(`${state.stress}% stress`, `${sym}${fmt.n(stressCash, 0)}mm`, `vs ${sym}${state.facility}mm line`, stressCash > state.facility ? "down" : "up"),
    tile("P(cum. outflow > line)", fmt.pct(pBreach, 1), `over ${state.hold}y, rolls not re-sized`, pBreach > 0.1 ? "down" : ""),
    tile("IRR median", fmt.pct(quantile(cur.irr, 0.5), 1), `5th pct ${fmt.pct(quantile(cur.irr, 0.05), 1)} (unhedged ${fmt.pct(quantile(sim.out[0].irr, 0.05), 1)})`));

  // ---- advice
  const fullVar = var99(1), halfVol = fxVol(0.5);
  const li = (b, t) => el("li", {}, el("b", {}, b), t);
  advice.replaceChildren(
    li("Exposure: ", `${fmt.pct(fxShare, 0)} of NAV is in ${rows.filter((r) => r.V > 0).map((r) => r.e.ccy).join(" and ")}; unhedged, FX adds `
      + `${fmt.pct(fxVol(0), 1)} a year of NAV volatility. Hedging 50% cuts it to ${fmt.pct(halfVol, 1)}, 100% removes it (on the hedged NAV).`),
    li("Carry: ", `at today's rate differentials the programme ${carryOf() >= 0 ? "earns" : "costs"} ${sym}${fmt.n(Math.abs(carryOf()), 1)}mm a year `
      + `(${fmt.n(Math.abs(carryOf() / nav) * 1e4, 0)}bp of NAV). ${carryOf() < 0 ? "A lower ratio or hedging only expected distributions limits the drag." : "Hedging pays here, which supports a high ratio."}`),
    li("Liquidity: ", `the binding constraint on a high ratio. One ${state.tenor}m roll can need ${sym}${fmt.n(var99(), 0)}mm at 99% `
      + `(${sym}${fmt.n(fullVar, 0)}mm if 100% hedged) against a ${sym}${state.facility}mm line. ${pBreach > 0.05 ? "Consider longer tenors, staggered maturities or a larger facility." : "The line covers the programme comfortably."}`),
    li("Structure: ", state.ratio >= 90 ? "A credit fund's cash flows (coupons, principal) are known, so a 100% rolling hedge on NAV plus coupons matches the risk; "
      + "stagger maturities so not every roll settles on one day."
      : "PE NAVs and exit timing are uncertain, so a partial ratio (50–75%) on NAV, re-sized at each valuation, avoids over-hedging an exit that is lower or later than planned."));

  // ---- charts
  const xs = Array.from({ length: 21 }, (_, i) => i * 5);
  plot(charts.ratio, [
    { x: xs, y: xs.map((x) => 100 * fxVol(x / 100)), type: "scatter", mode: "lines", name: "FX vol of NAV %", line: { color: COLORS[0], width: 2 } },
    { x: xs, y: xs.map((x) => (carryOf(x / 100) / nav) * 1e4), type: "scatter", mode: "lines", name: "Carry bp of NAV/y", yaxis: "y2", line: { color: COLORS[2], width: 2 } },
    { x: xs, y: xs.map((x) => (var99(x / 100) / nav) * 1e4), type: "scatter", mode: "lines", name: "99% roll cash bp of NAV", yaxis: "y2", line: { color: COLORS[3], dash: "dot" } },
  ], { xaxis: { title: { text: "hedge ratio %" } }, yaxis: { title: { text: "vol %" } }, yaxis2: { overlaying: "y", side: "right", title: { text: "bp of NAV" }, showgrid: false },
    shapes: [{ type: "line", x0: state.ratio, x1: state.ratio, yref: "paper", y0: 0, y1: 1, line: { color: "#555", dash: "dash" } }] }, 320);

  const mv = Array.from({ length: 26 }, (_, i) => i);
  plot(charts.liq, [
    { x: mv, y: mv.map((m) => (H * m) / 100), type: "scatter", mode: "lines", name: "Programme", line: { color: COLORS[0], width: 2 } },
    { x: mv, y: mv.map((m) => (rows.reduce((s, r) => s + r.V, 0) * m) / 100), type: "scatter", mode: "lines", name: "If 100% hedged", line: { color: COLORS[3], dash: "dot" } },
    { x: mv, y: mv.map(() => state.facility), type: "scatter", mode: "lines", name: "Liquidity line", line: { color: COLORS[1], dash: "dash" } },
  ], { xaxis: { title: { text: "foreign ccy appreciation vs base %" } }, yaxis: { title: { text: `${sym}mm to settle` } } }, 320);

  plot(charts.irr, RATIOS.map((ra, m) => {
    const name = ra == null ? "Programme" : `${ra * 100}% hedged`;
    return { y: Array.from(sim.out[m].irr, (v) => 100 * v), x: Array(state.paths).fill(name), type: "box", boxpoints: false, name,
      marker: { color: ra == null ? COLORS[0] : "#8c8c8c" } };
  }), { showlegend: false, xaxis: { type: "category" }, yaxis: { title: { text: "fund IRR %" } } }, 320);

  const cp = sim.cumPaths[RATIOS.length - 1], tx = Array.from({ length: steps + 1 }, (_, k) => (k * state.tenor) / 12);
  const qline = (q) => cp.map((col) => quantile(col, q));
  plot(charts.cum, [
    { x: tx, y: qline(0.95), type: "scatter", mode: "lines", line: { width: 0, color: COLORS[0] }, showlegend: false, hoverinfo: "skip" },
    { x: tx, y: qline(0.05), type: "scatter", mode: "lines", fill: "tonexty", fillcolor: "rgba(255,158,27,0.25)", line: { width: 0, color: COLORS[0] }, name: "5–95%" },
    { x: tx, y: qline(0.5), type: "scatter", mode: "lines", line: { color: COLORS[0] }, name: "Median" },
    { x: tx, y: tx.map(() => -state.facility), type: "scatter", mode: "lines", line: { color: COLORS[1], dash: "dash" }, name: "−Liquidity line" },
  ], { xaxis: { title: { text: "years" } }, yaxis: { title: { text: `${sym}mm received (+) / paid (−)` } } }, 320);
}

function methodNote() {
  return el("details", { class: "method panel" }, el("summary", {}, "Method and assumptions"), el("ul", {},
    el("li", {}, "Spot from ECB reference rates (crosses via EUR). Volatility and correlation: realised over the last 260 daily fixings."),
    el("li", {}, "Forwards: F = S · DF_foreign(T) / DF_base(T) on the OIS curves (SOFR, €STR, SONIA). No cross-currency basis, bid/offer or credit charge on the forwards."),
    el("li", {}, "Hedges sell a fixed foreign amount (hedge % × local NAV) forward each roll at S·(1 + carry·T) and settle against the next spot; "
      + "the notional is not re-sized for NAV growth. Settlements are paid in cash, which is what the liquidity line has to fund."),
    el("li", {}, "IRR: one investment at today's NAV and one exit after the hold; assets grow at the local IRR in every currency; FX follows correlated "
      + "lognormal paths with either spot unchanged or the forwards realised on average."),
    el("li", {}, "Only USD, EUR and GBP are modelled, the currencies with curves on this site.")));
}
