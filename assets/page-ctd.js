import { $, COLORS, MARKETS, dataTable, el, fmt, frame, hashParam, loadJSON, plot, segmented, setHash, showError } from "./common.js";
import { Phi, linear, parseDate, yearsBetween } from "./bond.js";
import { curveEditor } from "./curve-editor.js";
import { FUTURES_BY_MARKET, basisUnit, ctdIndex, curveDynamics, evaluate, marketFutures, oaDV01, prepare, sweep, yieldForRatio } from "./futures.js";

frame("CTD");
const app = $("#app");

try {
  const [futures, ...list] = await Promise.all([loadJSON("data/futures.json"), ...MARKETS.map((m) => loadJSON(`data/markets/${m.code}.json`))]);
  start(futures.contracts, Object.fromEntries(MARKETS.map((m, i) => [m.code, list[i]])));
} catch (err) {
  showError(app, err);
}

// UST futures prices in points and 32nds (e.g. 112-16+), Eurex in decimals.
function priceText(market, x) {
  if (x == null || !isFinite(x)) return "–";
  if (market !== "UST") return x.toFixed(3);
  const whole = Math.floor(x);
  const ticks = (x - whole) * 32;
  const t = Math.floor(ticks);
  const rem = ticks - t;
  const frac = rem < 0.125 ? "" : rem < 0.375 ? "¼" : rem < 0.625 ? "+" : rem < 0.875 ? "¾" : "";
  return `${whole}-${String(rem >= 0.875 ? t + 1 : t).padStart(2, "0")}${frac}`;
}

function start(contracts, markets) {
  const codes = MARKETS.map((m) => m.code);
  let mcode = hashParam("m", "DE", codes);
  let ccode = hashParam("c", null, FUTURES_BY_MARKET[mcode]) ?? defaultContract(mcode);
  const nodes = {};            // market -> generic curve points {t, base, y, drift, vol}
  const inputs = {};           // contract -> bond id -> {y (before curve shift), beta, cf}
  const repo = {};             // contract -> repo override (%)
  for (const m of codes) nodes[m] = freshNodes(markets[m]);

  function defaultContract(m) {
    return { UST: "TY", DE: "RX", FR: "OAT", IT: "IK" }[m];
  }
  function freshNodes(market) {
    return market.nodes.map((n) => ({ t: n.t, base: n.yield, y: n.yield, drift: 0, vol: n.vol, baseVol: n.vol }));
  }

  // ---- static layout
  const title = el("div", { class: "page-title" },
    el("h1", {}, "Bond Futures CTD Monte Carlo"),
    el("span", { class: "muted" }, "parametric: CTD regions and fair value from the normal distribution, no simulation"));
  const marketTabs = el("div");
  const contractTabs = el("div");
  const tiles = el("div", { class: "tiles" });
  const editorHost = el("div");
  const nodesHost = el("div");
  const spreadsHost = el("div", { class: "row small" });
  const payoff = el("div", { class: "plot" });
  const probs = el("div", { class: "plot", style: { minHeight: "0" } });
  const switchesHost = el("div", { class: "note" });
  const basketHost = el("div");
  const basketNote = el("p", { class: "note" });
  const sweepProb = el("div", { class: "plot" });
  const sweepDV01 = el("div", { class: "plot" });
  const sweepNote = el("p", { class: "note" });
  app.append(
    title,
    el("div", { class: "row", style: { marginBottom: "8px" } }, marketTabs, contractTabs),
    tiles,
    el("div", { class: "grid cols-2", style: { marginTop: "10px" } },
      el("section", { class: "panel" },
        el("div", { class: "row", style: { justifyContent: "space-between" } },
          el("h2", {}, "Generic curve: yield, drift and volatility by point"),
          el("button", { class: "btn", onclick: () => { nodes[mcode] = freshNodes(markets[mcode]); refreshCurve(); } }, "Reset curve")),
        editorHost, nodesHost, spreadsHost),
      el("section", { class: "panel" },
        el("h2", {}, "Futures at delivery: P/CF of each deliverable"),
        payoff, switchesHost,
        el("h2", { style: { marginTop: "8px" } }, "CTD probability"), probs)),
    el("section", { class: "panel", style: { marginTop: "10px" } },
      el("h2", {}, "How the answer changes with today's yield level"),
      el("div", { class: "grid cols-2" }, sweepProb, sweepDV01), sweepNote),
    el("section", { class: "panel", style: { marginTop: "10px" } },
      el("div", { class: "row", style: { justifyContent: "space-between" } },
        el("h2", {}, "Deliverable basket"),
        el("button", { class: "btn", onclick: () => { inputs[ccode] = {}; recompute(); } }, "Reset bonds")),
      basketHost, basketNote),
    methodNote());

  const editor = curveEditor({
    xTitle: "Maturity (years)", yTitle: "Yield (%)", yDigits: 3, step: 0.001,
    onChange: (pts, i) => { nodes[mcode][i].y = pts[i].y; renderNodes(); recompute(); },
  });
  editorHost.append(editor.node);

  // ---- nodes table and spreads
  const nodeTable = dataTable([
    { key: "t", label: "Point", fmt: (n) => `${n.t}Y`, left: true },
    { key: "y", label: "Yield", unit: "%", edit: { get: (n) => n.y.toFixed(3), set: (n, v) => { n.y = clampYield(v, n.y); refreshCurve(); }, changed: (n) => Math.abs(n.y - n.base) > 1e-9 } },
    { key: "d", label: "Shift", unit: "bp", fmt: (n) => fmt.s((n.y - n.base) * 100, 1), cls: (n) => (n.y > n.base ? "neg" : n.y < n.base ? "pos" : "") },
    { key: "drift", label: "Drift", unit: "bp/yr", edit: { get: (n) => n.drift, set: (n, v) => { n.drift = +v || 0; recompute(); renderNodes(); }, changed: (n) => n.drift !== 0 } },
    { key: "vol", label: "Vol", unit: "bp/yr", edit: { get: (n) => n.vol, set: (n, v) => { n.vol = Math.max(+v || 0, 0); recompute(); renderNodes(); }, changed: (n) => n.vol !== n.baseVol } },
  ]);
  nodeTable.node.classList.remove("tall");
  nodesHost.append(nodeTable.node);

  function renderNodes() {
    nodeTable.update(nodes[mcode]);
    const ns = nodes[mcode];
    spreadsHost.replaceChildren(el("span", { class: "amber" }, "Curve spreads (bp):"),
      ...ns.slice(1).map((n, k) => {
        const a = ns[k];
        const input = el("input", { type: "number", step: "0.1", value: ((n.y - a.y) * 100).toFixed(1), "aria-label": `${a.t}s${n.t}s spread` });
        input.addEventListener("change", () => {
          // Move this point and every longer point, leaving the other spreads unchanged.
          const delta = (+input.value - (n.y - a.y) * 100) / 100;
          for (let j = k + 1; j < ns.length; j++) ns[j].y += delta;
          refreshCurve();
        });
        return el("label", {}, `${a.t}s${n.t}s `, input);
      }));
  }

  function refreshCurve() {
    renderNodes();
    editor.update(points(), background());
    recompute();
  }
  const points = () => nodes[mcode].map((n) => ({ x: n.t, y: n.y, label: `${n.t}Y` }));

  // ---- model inputs
  const shiftAt = () => {
    const ns = nodes[mcode];
    return linear(ns.map((n) => n.t), ns.map((n) => n.y - n.base));
  };
  const curve = () => curveDynamics(nodes[mcode]);
  function options() {
    const market = markets[mcode];
    const contract = contracts[ccode];
    const settle = parseDate(market.settle);
    const shift = shiftAt();
    const byId = new Map(market.bonds.map((b) => [b.id, b]));
    const ins = {};
    for (const d of contract.basket) {
      if (!byId.has(d.id)) continue;
      const o = inputs[ccode]?.[d.id] ?? {};
      ins[d.id] = { ...o, y: (o.y ?? byId.get(d.id).yield) + shift(yearsBetween(settle, parseDate(d.maturity))) };
    }
    return { inputs: ins, repo: repo[ccode] };
  }
  function setInput(id, patch) {
    inputs[ccode] ??= {};
    inputs[ccode][id] = { ...inputs[ccode][id], ...patch };
    recompute();
  }

  const background = () => {
    const market = markets[mcode];
    const ids = new Set(contracts[ccode].basket.map((d) => d.id));
    const settle = parseDate(market.settle);
    return market.bonds.map((b) => ({
      x: yearsBetween(settle, parseDate(b.maturity)), y: b.yield, name: `${b.name}  ${b.yield.toFixed(3)}%`,
      color: ids.has(b.id) ? "#3ddc84" : "#2f5b8f",
    }));
  };

  // ---- recompute and render outputs
  let last = null;
  function recompute() {
    const market = markets[mcode];
    const contract = contracts[ccode];
    const unit = basisUnit(mcode);
    const opts = options();
    const model = prepare(contract, market, opts);
    if (!model.bonds.length) {
      tiles.replaceChildren(el("div", { class: "panel down" }, "No priced deliverables for this contract."));
      return;
    }
    const cv = curve();
    const res = evaluate(model, cv);
    const dv = oaDV01(contract, market, opts, cv);
    const i0 = ctdIndex(model);
    const ctd = model.bonds[i0];
    const mkt = marketFutures(contract, market);
    const fut = mkt?.price ?? res.fair;
    last = { model, res };
    const days = Math.round((model.delivery - model.settle) / 864e5);
    const repoInput = el("input", { type: "number", step: "0.01", value: model.repo.toFixed(3), "aria-label": "Repo rate to delivery" });
    repoInput.addEventListener("change", () => { repo[ccode] = +repoInput.value; recompute(); });
    const richCheap = mkt ? (mkt.price - res.fair) * unit.mult : null;
    tiles.replaceChildren(
      tile("Contract", `${ccode} ${contract.expiry}`, contract.name),
      tile("Delivery", contract.delivery, `${days} days from settlement ${market.settle}`),
      el("div", { class: "tile" }, el("div", { class: "k" }, "Repo to delivery %"), repoInput,
        el("div", { class: "n" }, repo[ccode] != null ? "manual" : "from repo curve proxy")),
      tile("Futures (market)", mkt ? priceText(mcode, mkt.price) : "n/a",
        mkt ? `EFP VWAP ${mkt.date}, ${fmt.int(mkt.lots)} lots` : mcode === "UST" ? "no free CME source" : `no EFPs on ${market.asOf}`),
      tile("Futures (fair)", priceText(mcode, res.fair), "E[min P/CF] at delivery"),
      tile("Market − fair", richCheap == null ? "–" : `${fmt.s(richCheap, 1)}${unit.label}`, richCheap == null ? "" : richCheap > 0 ? "futures rich" : "futures cheap"),
      tile("CTD today", ctd.name, `probability ${fmt.pct(res.prob[i0], 0)}`),
      tile("OA DV01", fmt.n(dv * contract.face / 100, 0), `per contract (${fmt.n(dv, 4)} per 100); CTD β × DV01 / CF ${fmt.n((ctd.beta * ctd.dv01 / ctd.cf) * contract.face / 100, 0)}`),
    );
    renderPayoff(model, res, fut, mkt, unit);
    renderBasket(model, res, fut, mkt, unit);
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(() => renderSweep(contract, market, opts, cv, model), 250);
  }

  // Probability and DV01 across shifts in today's generic yield (redrawn once editing pauses).
  let sweepTimer = null;
  const SHIFTS = Array.from({ length: 51 }, (_, i) => -200 + 10 * i);
  function renderSweep(contract, market, opts, cv, model) {
    const grid = sweep(contract, market, opts, cv, SHIFTS);
    const per = contract.face / 100;
    const ccy = market.currency;
    const active = model.bonds.map((b, i) => i).filter((i) => grid.some((g) => g.prob[i] > 0.01));
    const zero = [{ type: "line", x0: 0, x1: 0, y0: 0, y1: 1, yref: "paper", line: { color: "#5c5c5c", dash: "dot", width: 1 } }];
    plot(sweepProb, active.map((i, k) => ({
      type: "scatter", mode: "lines", name: model.bonds[i].name, x: SHIFTS, y: grid.map((g) => g.prob[i] * 100),
      line: { color: COLORS[k % COLORS.length], width: 2 }, hovertemplate: `${model.bonds[i].name}: %{y:.0f}%<extra></extra>`,
    })), {
      hovermode: "x unified", shapes: zero, legend: { y: -0.3 }, margin: { b: 80 },
      xaxis: { title: { text: "Shift in today's generic yield (bp)" } },
      yaxis: { title: { text: "CTD probability (%)" }, range: [0, 100] },
    }, 340);
    plot(sweepDV01, [
      { name: "Option-adjusted", y: grid.map((g) => g.oaDV01 * per), color: "#ff9e1b" },
      { name: "CTD β × DV01 / CF", y: grid.map((g) => g.ctdDV01 * per), color: "#5fa8ff" },
    ].map((t) => ({ type: "scatter", mode: "lines", name: t.name, x: SHIFTS, y: t.y, line: { color: t.color, width: 2 },
      hovertemplate: `${t.name}: ${ccy}%{y:.1f}<extra></extra>` })), {
      hovermode: "x unified", shapes: zero, legend: { y: -0.3 }, margin: { b: 80 },
      xaxis: { title: { text: "Shift in today's generic yield (bp)" } },
      yaxis: { title: { text: `DV01 per contract (${ccy})` } },
    }, 340);
    sweepNote.textContent = "Each point re-solves the model with today's yields shifted (every deliverable moves by β × shift), " +
      "keeping your drift, vol and curve edits. When a CTD switch is likely, the futures DV01 departs from the current CTD's " +
      "DV01 / CF, so hedge ratios based on the CTD alone over- or under-hedge.";
  }

  function tile(k, v, n) {
    return el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v), el("div", { class: "n" }, n));
  }

  function renderPayoff(model, res, fut, mkt, unit) {
    const { bonds } = model;
    const c = ctdIndex(model);
    const xOf = (z) => (res.mu[c] + res.sd[c] * z) * 100;
    const idx = res.zs.map((_, k) => k).filter((k) => k % 4 === 0 && Math.abs(res.zs[k]) <= 3.5);
    const xs = idx.map((k) => xOf(res.zs[k]));
    const order = bonds.map((_, i) => i).sort((a, b) => res.prob[b] - res.prob[a]).slice(0, 8);
    const traces = order.map((i, n) => ({
      type: "scatter", mode: "lines", name: bonds[i].name, x: xs, y: idx.map((k) => res.ratio(i, res.zs[k])),
      line: { color: COLORS[n % COLORS.length], width: 1.2, dash: res.prob[i] < 0.005 ? "dot" : "solid" },
      hovertemplate: `${bonds[i].name}<br>CTD yield %{x:+.0f}bp: P/CF %{y:.3f}<extra></extra>`,
    }));
    traces.push({
      type: "scatter", mode: "lines", name: "Futures (cheapest)", x: xs, y: idx.map((k) => res.env[k]),
      line: { color: "#ffffff", width: 3 }, hovertemplate: "Futures %{y:.3f}<extra></extra>",
    });
    traces.push({
      type: "scatter", mode: "lines", name: "Probability density", x: xs, y: idx.map((k) => Math.exp(-0.5 * res.zs[k] ** 2)),
      yaxis: "y2", fill: "tozeroy", line: { color: "rgba(255,158,27,0.5)", width: 1 }, fillcolor: "rgba(255,158,27,0.08)", hoverinfo: "skip",
    });
    const shapes = res.switches.filter((s) => Math.abs(s.z) <= 3.5).map((s) => ({
      type: "line", x0: xOf(s.z), x1: xOf(s.z), yref: "paper", y0: 0, y1: 1, line: { color: "#ffd24d", dash: "dot", width: 1 },
    }));
    if (mkt) shapes.push({ type: "line", xref: "paper", x0: 0, x1: 1, y0: mkt.price, y1: mkt.price, line: { color: "#5fa8ff", dash: "dash", width: 1 } });
    plot(payoff, traces, {
      xaxis: { title: { text: `Change in CTD (${bonds[c].name}) yield to delivery, bp` }, zeroline: true },
      yaxis: { title: { text: "Price / CF at delivery" } },
      yaxis2: { overlaying: "y", side: "right", range: [0, 4], visible: false },
      shapes, legend: { y: -0.3 }, margin: { b: 90 },
    }, 400);
    const near = res.switches.filter((s) => Math.abs(s.z) <= 3);
    switchesHost.replaceChildren(...near.map((s) => el("div", {},
      `CTD switches ${bonds[s.from].name} → ${bonds[s.to].name} at ${fmt.s(xOf(s.z), 0)}bp in the CTD yield (z = ${fmt.s(s.z, 2)}, `,
      `${fmt.pct(s.z > 0 ? 1 - Phi(s.z) : Phi(s.z), 1)} chance of moving beyond it).`)),
      near.length ? "" : el("div", {}, "No CTD switch within ±3 standard deviations of the CTD yield at delivery."),
      mkt ? el("div", {}, `Blue dashed line: market futures ${priceText(mcode, mkt.price)}.`) : "");
    const ranked = bonds.map((b, i) => ({ b, p: res.prob[i] })).filter((x) => x.p >= 0.0005).sort((a, b) => a.p - b.p);
    plot(probs, [{ type: "bar", orientation: "h", x: ranked.map((r) => 100 * r.p), y: ranked.map((r) => r.b.name),
      marker: { color: "#ff9e1b" }, text: ranked.map((r) => `${(100 * r.p).toFixed(1)}%`), textposition: "outside",
      cliponaxis: false, hovertemplate: "%{y}: %{x:.1f}%<extra></extra>" }],
    { xaxis: { title: { text: "%" }, range: [0, 115] }, margin: { l: 140 }, showlegend: false }, Math.max(140, 34 * ranked.length + 60));
  }

  const basketTable = dataTable([
    { key: "name", label: "Bond", fmt: (r) => `${r.isCtd ? "◆ " : ""}${r.name}`, value: (r) => r.t, left: true },
    { key: "mat", label: "Maturity", fmt: (r) => r.maturity, value: (r) => r.t },
    { key: "y", label: "Yield", unit: "%", edit: { get: (r) => r.y.toFixed(4), set: (r, v) => setInput(r.id, { y: clampYield(v, r.y) - r.shift }), changed: (r) => inputs[ccode]?.[r.id]?.y != null } },
    { key: "beta", label: "Beta", edit: { get: (r) => r.beta.toFixed(2), set: (r, v) => setInput(r.id, { beta: +v }), changed: (r) => inputs[ccode]?.[r.id]?.beta != null } },
    { key: "cf", label: "CF", edit: { get: (r) => r.cf.toFixed(4), set: (r, v) => setInput(r.id, { cf: +v }), changed: (r) => inputs[ccode]?.[r.id]?.cf != null } },
    { key: "fy", label: "Fwd yield", unit: "%", fmt: (r) => r.fwdYield.toFixed(3), value: (r) => r.fwdYield },
    { key: "ratio", label: "P/CF at delivery", edit: { get: (r) => r.ratio0.toFixed(4), set: (r, v) => {
      const y = yieldForRatio(last.model, markets[mcode], r.id, +v);
      setInput(r.id, { y: y - r.shift });
    } } },
    { key: "gross", label: "Gross basis", get unit() { return basisUnit(mcode).label; }, fmt: (r) => fmt.n(r.gross, 1), value: (r) => r.gross },
    { key: "carry", label: "Carry", get unit() { return basisUnit(mcode).label; }, fmt: (r) => fmt.n(r.carryT, 1), value: (r) => r.carryT },
    { key: "nbm", label: "Net basis mkt", get unit() { return basisUnit(mcode).label; }, fmt: (r) => (r.nbMkt == null ? "–" : fmt.n(r.nbMkt, 1)), value: (r) => r.nbMkt },
    { key: "nbf", label: "Net basis fair", get unit() { return basisUnit(mcode).label; }, fmt: (r) => fmt.n(r.nbFair, 1), value: (r) => r.nbFair },
    { key: "p", label: "CTD prob", unit: "%", fmt: (r) => fmt.n(100 * r.prob, 1), value: (r) => r.prob, cls: (r) => (r.prob > 0.5 ? "pos" : "") },
    { key: "dv01", label: "DV01", unit: "/100", fmt: (r) => r.dv01.toFixed(4), value: (r) => r.dv01 },
  ], { sortKey: "name", rowClass: (r) => (r.isCtd ? "hl" : null) });
  basketTable.node.classList.remove("tall");
  basketHost.append(basketTable.node);

  function renderBasket(model, res, fut, mkt, unit) {
    const shift = shiftAt();
    const c = ctdIndex(model);
    basketTable.node.classList.toggle("tall", model.bonds.length > 15);
    basketTable.update(model.bonds.map((b, i) => ({
      ...b, isCtd: i === c, prob: res.prob[i], shift: shift(b.t),
      gross: (b.clean - fut * b.cf) * unit.mult, carryT: b.carry * unit.mult,
      nbFair: res.nbFair[i] * unit.mult, nbMkt: mkt ? (b.fwdClean - mkt.price * b.cf) * unit.mult : null,
    })));
    basketNote.textContent = `Yields as of ${markets[mcode].asOf} (end-of-day prices). ` +
      `Gross basis = clean price − futures × CF using ${mkt ? "the market" : "the model's fair"} futures price; carry = clean − forward clean ` +
      `price at delivery (repo ${model.repo.toFixed(3)}%); net basis = gross − carry. Fair net basis uses the fair futures price. ` +
      `◆ = CTD at forward prices. Edited inputs are highlighted; P/CF edits solve for the yield.`;
  }

  // ---- selection
  function selectMarket(m) {
    mcode = m;
    ccode = defaultContract(m);
    setHash({ m: mcode, c: ccode });
    renderContracts();
    renderNodes();
    editor.update(points(), background());
    recompute();
  }
  function renderContracts() {
    contractTabs.replaceChildren(segmented(FUTURES_BY_MARKET[mcode].map((k) => ({ code: k, label: `${k} (${expiryLabel(contracts[k].expiry)})` })), ccode, (k) => {
      ccode = k;
      setHash({ m: mcode, c: ccode });
      editor.update(points(), background());
      recompute();
    }));
  }
  marketTabs.append(segmented(MARKETS, mcode, selectMarket));
  setHash({ m: mcode, c: ccode });
  renderContracts();
  renderNodes();
  editor.update(points(), background());
  recompute();
}

// "2026-12" -> "Dec 26".
function expiryLabel(expiry) {
  const month = new Date(`${expiry}-01T00:00:00Z`).toLocaleString("en-GB", { month: "short", timeZone: "UTC" }).slice(0, 3);
  return `${month} ${expiry.slice(2, 4)}`;
}

// Typed yields outside −5%..30% (or not numbers) are ignored.
function clampYield(v, current) {
  const y = parseFloat(v);
  return isFinite(y) && y > -5 && y < 30 ? y : current;
}

function methodNote() {
  return el("details", { class: "method panel" }, el("summary", {}, "Method and data"),
    el("ul", { class: "small" },
      el("li", {}, "Each deliverable's yield at delivery is its forward yield + drift × T + beta × vol × √T × z, with one standard normal z for all bonds (a single-factor, parallel-plus-beta curve model). Drift and vol are read off the generic curve points at the bond's maturity."),
      el("li", {}, "The futures delivers the lowest price / conversion factor. The points on the z line where the cheapest bond changes are solved exactly, so CTD probabilities are differences of normal CDFs; the fair futures price is the expected lower envelope (Simpson's rule over ±5 standard deviations). Nothing is simulated, despite the page's name."),
      el("li", {}, "Moving a curve point shifts today's yields of the deliverables by the interpolated change at their maturity; the forward yields then follow from repo. Drift is your expected yield change per year to delivery; vol is the normal (bp) volatility per year, defaulting to the realised 3-month volatility of that curve point."),
      el("li", {}, "Bond yields: TreasuryDirect (UST), Bundesbank (Bunds), Borsa Italiana closing prices (OATs, BTPs). Conversion factors: CME formula (UST), Eurex notified factors. Market futures prices: daily VWAP of the futures leg of Eurex EFP trades on the date of the bond prices; none for UST (CME data cannot be republished), so the UST tiles show the model only."),
      el("li", {}, "Beta: regression of each bond's daily yield change on the fitted curve's change at its maturity over 3 months (clipped to 0.5–1.5).")));
}
