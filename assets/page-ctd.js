import { $, COLORS, MARKETS, dataTable, el, fmt, frame, hashParam, loadJSON, plot, segmented, setHash, showError, signClass } from "./common.js";
import { Phi, linear, parseDate, phi, pricer, repoAt, yearsBetween } from "./bond.js";
import { curveEditor } from "./curve-editor.js";
import { FUTURES_BY_MARKET, anchorMarket, basisUnit, ctdIndex, curveDynamics, evaluate, marketFutures, oaDV01, prepare, sweep, yieldForRatio } from "./futures.js";

frame("CTD");
const app = $("#app");

try {
  const [futures, ...list] = await Promise.all([loadJSON("data/futures.json"), ...MARKETS.map((m) => loadJSON(`data/markets/${m.code}.json`))]);
  // Bond curves anchored to the futures and EFP gross basis (closing yields kept as closeYield).
  start(futures.contracts, Object.fromEntries(MARKETS.map((m, i) => [m.code, anchorMarket(list[i], futures.contracts)])));
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
  const ctdRepo = {};          // contract -> CTD repo overrides {sn, box, dlv} (% S/N, to boxing, to delivery; null = GC)
  const added = {};            // contract -> bonds added to the basket {id, name, coupon, maturity, cf, yield?, beta?, custom}
  for (const m of codes) nodes[m] = freshNodes(markets[m]);

  // The selected contract and its market with the user's added bonds included.
  function current() {
    const market = markets[mcode];
    const contract = contracts[ccode];
    const extra = added[ccode] ?? [];
    return {
      contract: { ...contract, basket: [...contract.basket, ...extra.map(({ id, name, coupon, maturity, cf }) => ({ id, name, coupon, maturity, cf }))] },
      market: { ...market, bonds: [...market.bonds, ...extra.filter((b) => b.custom)] },
    };
  }

  // Conversion factor of a bond added by hand: CME formula for Treasuries, otherwise Eurex's price per 1 nominal
  // at the notional coupon (4% for the Buxl, 6% otherwise) on the delivery date.
  function conversionFactor(coupon, maturity) {
    const contract = contracts[ccode];
    const first = parseDate(contract.firstDelivery);
    if (mcode === "UST") return cmeConversionFactor(coupon, parseDate(maturity), first, ["TU", "FV"].includes(ccode) ? 1 : 3);
    const notional = ccode === "UB" ? 4 : 6;
    return Math.round(pricer(coupon, parseDate(maturity), parseDate(contract.delivery), markets[mcode].freq).price(notional) * 1e4) / 1e6;
  }

  function defaultContract(m) {
    return { UST: "TY", DE: "RX", FR: "OAT", IT: "IK" }[m];
  }
  function freshNodes(market) {
    return market.nodes.map((n) => ({ t: n.t, base: n.yield, y: n.yield, drift: 0, vol: n.vol, baseVol: n.vol }));
  }

  // ---- static layout
  const title = el("div", { class: "page-title" },
    el("h1", {}, "Bond Futures CTD"),
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
  const anchorHost = el("div");
  const repoEditorHost = el("div");
  const repoControls = el("div", { class: "row", style: { marginTop: "6px" } });
  const addHost = el("div", { class: "stack", style: { marginTop: "8px" } });
  const sweepProb = el("div", { class: "plot" });
  const sweepDV01 = el("div", { class: "plot" });
  const sweepNote = el("p", { class: "note" });
  app.append(
    title,
    el("div", { class: "row", style: { marginBottom: "8px" } }, marketTabs, contractTabs),
    tiles,
    el("section", { class: "panel", style: { marginTop: "10px" } },
      el("h2", {}, "CTD repo to delivery, with the boxing option (other deliverables at GC)"),
      el("div", { class: "grid cols-2", style: { alignItems: "start" } },
        repoEditorHost,
        el("div", { class: "stack" }, repoControls,
          el("p", { class: "note" }, "S/N, S/Box and S/Dlv start on the GC repo curve (proxy); drag them or type the CTD's term repo to delivery "
            + "(special = GC − CTD repo). The boxing premium is the extra forward rate priced between boxing and delivery (red); typing it moves S/Box "
            + "with S/Dlv held. The CTD is financed at S/Dlv; the Bond Monitor's net basis uses GC.")))),
    el("div", { class: "grid cols-2", style: { marginTop: "10px" } },
      el("section", { class: "panel" },
        el("div", { class: "row", style: { justifyContent: "space-between" } },
          el("h2", {}, "Generic curve: yield, drift and volatility by point"),
          el("button", { class: "btn", onclick: () => { nodes[mcode] = freshNodes(markets[mcode]); refreshCurve(); } }, "Reset curve")),
        editorHost, nodesHost, spreadsHost),
      el("section", { class: "panel" },
        el("h2", {}, "Distribution of the CTD yield at delivery, coloured by CTD"),
        payoff, switchesHost,
        el("h2", { style: { marginTop: "8px" } }, "CTD probability"), probs)),
    el("section", { class: "panel", style: { marginTop: "10px" } },
      el("h2", {}, "How the answer changes with today's yield level"),
      el("div", { class: "grid cols-2" }, sweepProb, sweepDV01), sweepNote),
    el("section", { class: "panel", style: { marginTop: "10px" } },
      el("div", { class: "row", style: { justifyContent: "space-between" } },
        el("h2", {}, "Deliverable basket"),
        el("button", { class: "btn", onclick: () => { inputs[ccode] = {}; added[ccode] = []; renderAddForm(); recompute(); } }, "Reset bonds")),
      basketHost, addHost, basketNote, anchorHost),
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
    const { market, contract } = current();
    const settle = parseDate(market.settle);
    const shift = shiftAt();
    const byId = new Map(market.bonds.map((b) => [b.id, b]));
    const ins = {};
    for (const d of contract.basket) {
      if (!byId.has(d.id)) continue;
      const o = inputs[ccode]?.[d.id] ?? {};
      ins[d.id] = { ...o, y: (o.y ?? byId.get(d.id).yield) + shift(yearsBetween(settle, parseDate(d.maturity))) };
    }
    // The CTD (cheapest at GC repo) is financed at its own term repo to delivery; every other bond at GC.
    const gc = prepare(contract, market, { inputs: ins });
    if (!gc.bonds.length) return { inputs: ins };
    const ctdId = gc.bonds[ctdIndex(gc)].id;
    return { inputs: ins, repoById: { [ctdId]: repoBox().rD }, ctdId };
  }

  // ---- CTD repo with boxing
  // Three term rates for the CTD: S/N (O/N for UST), S/Box (to the boxing date, 5 business days before delivery)
  // and S/Dlv (to delivery). By default they sit on the GC repo curve; each can be dragged, and S/Dlv typed.
  // The CTD is financed at S/Dlv. The boxing premium is the forward rate between boxing and delivery minus that
  // forward on GC; typing a premium moves S/Box with S/Dlv held.
  function repoBox() {
    const { market, contract } = current();
    const st = (ctdRepo[ccode] ??= { sn: null, box: null, dlv: null });
    const settle = parseDate(market.settle);
    const delivery = parseDate(contract.delivery);
    let box = delivery;
    for (let n = 0; n < 5;) {
      box = new Date(box - 864e5);
      if (box.getUTCDay() % 6) n++;
    }
    const gc = market.repo.points;
    const tD = Math.max(yearsBetween(settle, delivery), 2 / 365);
    const tB = Math.min(Math.max(yearsBetween(settle, box), 1 / 365), tD - 1 / 365);
    const rB0 = repoAt(gc, tB), rD0 = repoAt(gc, tD);
    const rB = st.box ?? rB0, rD = st.dlv ?? rD0;
    const fwd = (b, d) => (d * tD - b * tB) / (tD - tB);
    const tN = gc[0].t, rN = st.sn ?? gc[0].rate;
    return { st, box, delivery, tN, rN, tB, tD, rB, rD, rB0, rD0, fwd: fwd(rB, rD), fwd0: fwd(rB0, rD0),
      premium: (fwd(rB, rD) - fwd(rB0, rD0)) * 100, sn: mcode === "UST" ? "O/N" : "S/N" };
  }
  // x in days from settlement (ticks follow the range: delivery is weeks to months away).
  const repoEditor = curveEditor({
    width: 720, height: 220, xTitle: "Days from settlement", yTitle: "Repo (%)", yDigits: 3, step: 0.005, xPad: 0.18,
    onChange: (pts, i) => {
      const b = repoBox();
      b.st[["sn", "box", "dlv"][i]] = pts[i].y;
      recompute({ draggingRepo: true });
    },
  });
  repoEditorHost.append(repoEditor.node);

  function renderRepoBox(model, ctdName, dragging = false) {
    const b = repoBox();
    const day = (d) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
    const days = (t) => t * 365.25;
    repoEditor.update(
      [{ x: days(b.tN), y: b.rN, label: b.sn }, { x: days(b.tB), y: b.rB, label: "S/Box", anchor: "end" },
        { x: days(b.tD), y: b.rD, label: "S/Dlv", anchor: "end" }],
      [],
      { keepRange: dragging, extra: { lines: [{ x: days(b.tB), label: `Box ${day(b.box)}` }, { x: days(b.tD), label: `Dlv ${day(b.delivery)}` }],
        segments: [{ x0: days(b.tB), x1: days(b.tD), y: b.fwd }] } });
    const summary = () => [`${ctdName}: ${b.sn} ${b.rN.toFixed(3)}%, S/Box (${day(b.box)}) ${b.rB.toFixed(3)}%, S/Dlv (${day(b.delivery)}) `,
      el("b", { class: "amber" }, `${b.rD.toFixed(3)}%`), ` (GC ${b.rD0.toFixed(3)}%, special ${fmt.s((b.rD0 - b.rD) * 100, 1)}bp); `
      + `forward boxing → delivery ${b.fwd.toFixed(3)}% vs ${b.fwd0.toFixed(3)}% on GC. Other deliverables: GC ${model.repo.toFixed(3)}%.`];
    if (dragging) {
      repoInputs.dlv.value = b.rD.toFixed(3);
      repoInputs.premium.value = b.premium.toFixed(1);
      repoInputs.summary.replaceChildren(...summary());
      return;
    }
    const dlv = el("input", { type: "number", step: "0.01", value: b.rD.toFixed(3), "aria-label": "CTD repo to delivery" });
    dlv.addEventListener("change", () => { b.st.dlv = +dlv.value; recompute(); });
    const premium = el("input", { type: "number", step: "1", value: b.premium.toFixed(1), "aria-label": "Boxing premium in bp" });
    premium.addEventListener("change", () => {
      // Hold delivery, solve the boxing rate for the requested forward between boxing and delivery.
      const target = b.fwd0 + (+premium.value || 0) / 100;
      b.st.box = (b.rD * b.tD - target * (b.tD - b.tB)) / b.tB;
      recompute();
    });
    repoInputs = { dlv, premium, summary: el("span", { class: "small" }, ...summary()) };
    repoControls.replaceChildren(
      el("label", {}, "CTD repo to delivery % ", dlv),
      el("label", {}, "Boxing premium bp ", premium),
      el("button", { class: "btn", onclick: () => { b.st.sn = b.st.box = b.st.dlv = null; recompute(); } }, "Reset to GC"),
      repoInputs.summary);
  }
  let repoInputs = null;
  function setInput(id, patch) {
    inputs[ccode] ??= {};
    inputs[ccode][id] = { ...inputs[ccode][id], ...patch };
    recompute();
  }

  const background = () => {
    const { market, contract } = current();
    const ids = new Set(contract.basket.map((d) => d.id));
    const settle = parseDate(market.settle);
    return market.bonds.map((b) => ({
      x: yearsBetween(settle, parseDate(b.maturity)), y: b.yield, name: `${b.name}  ${b.yield.toFixed(3)}%`,
      color: ids.has(b.id) ? "#3ddc84" : "#2f5b8f",
    }));
  };

  // ---- recompute and render outputs
  let last = null;
  function recompute({ draggingRepo = false } = {}) {
    const { market, contract } = current();
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
    const richCheap = mkt ? (mkt.price - res.fair) * unit.mult : null;
    const ctdRate = model.bonds.find((b) => b.id === opts.ctdId)?.repo;
    tiles.replaceChildren(
      tile("Contract", `${ccode} ${contract.expiry}`, contract.name),
      tile("Delivery", contract.delivery, `${days} days from settlement ${market.settle}`),
      tile("Repo to delivery", ctdRate == null ? `${model.repo.toFixed(3)}%` : `CTD ${ctdRate.toFixed(3)}%`,
        `others GC ${model.repo.toFixed(3)}% (repo curve proxy)`),
      tile("Futures (market)", mkt ? priceText(mcode, mkt.price) : "n/a",
        mkt ? `EFP VWAP ${mkt.date}, ${fmt.int(mkt.lots)} lots` : mcode === "UST" ? "no free CME source" : `no EFPs on ${market.asOf}`),
      tile("Futures (fair)", priceText(mcode, res.fair), "E[min P/CF] at delivery"),
      tile("Market − fair", richCheap == null ? "–" : `${fmt.s(richCheap, 1)}${unit.label}`, richCheap == null ? "" : richCheap > 0 ? "futures rich" : "futures cheap"),
      tile("Curve anchor", market.anchor ? `${fmt.s(market.anchor.bondShift(ctd.id, ctd.t) * 100, 1)}bp at the CTD` : "none",
        market.anchor ? `futures + EFP basis VWAP, ${market.anchor.points.length} bonds; closing yields ${market.asOf}` : mcode === "UST" ? "no free CME futures prices: closing yields" : "no EFPs: closing yields"),
      tile("CTD today", ctd.name, `probability ${fmt.pct(res.prob[i0], 0)}`),
      tile("OA DV01", fmt.n(dv * contract.face / 100, 0), `per contract (${fmt.n(dv, 4)} per 100); CTD β × DV01 / CF ${fmt.n((ctd.beta * ctd.dv01 / ctd.cf) * contract.face / 100, 0)}`),
    );
    renderRepoBox(model, model.bonds.find((b) => b.id === opts.ctdId)?.name ?? "CTD", draggingRepo);
    renderPayoff(model, res);
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
    // Same colour per bond as the distribution chart; bonds that only become CTD after a shift take the unused colours.
    const spare = COLORS.filter((c) => ![...colours.values()].includes(c));
    let next = 0;
    const colourFor = (id) => colours.get(id) ?? spare[next++ % Math.max(spare.length, 1)] ?? "#94a3b8";
    plot(sweepProb, active.map((i) => ({
      type: "scatter", mode: "lines", name: model.bonds[i].name, x: SHIFTS, y: grid.map((g) => g.prob[i] * 100),
      line: { color: colourFor(model.bonds[i].id), width: 2 }, hovertemplate: `${model.bonds[i].name}: %{y:.0f}%<extra></extra>`,
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

  let colours = new Map();     // bond id -> chart colour, shared by the distribution, probability and sweep charts
  // Normal distribution of the CTD's yield at delivery; each region is filled with the colour of the bond
  // that is cheapest to deliver there. The probability bars use the same colours.
  function renderPayoff(model, res) {
    const { bonds } = model;
    const c = ctdIndex(model);
    const sdBp = res.sd[c] * 100;
    const xOf = (z) => (res.mu[c] + res.sd[c] * z) * 100;
    const colourOf = new Map();
    bonds.map((_, i) => i).filter((i) => res.prob[i] >= 0.0005).sort((a, b) => res.prob[b] - res.prob[a])
      .forEach((i, k) => colourOf.set(i, COLORS[k % COLORS.length]));
    colours = new Map([...colourOf].map(([i, c]) => [bonds[i].id, c]));
    const Z = 3.5;
    const cuts = res.switches.filter((s) => Math.abs(s.z) < Z);
    const bounds = [-Z, ...cuts.map((s) => s.z), Z];
    const startOwner = res.switches.filter((s) => s.z <= -Z).reduce((_, s) => s.to, res.ctd[0]);
    const shown = new Set();
    const traces = bounds.slice(0, -1).map((a, k) => {
      const b = bounds[k + 1];
      const owner = k === 0 ? startOwner : cuts[k - 1].to;
      const zs = Array.from({ length: 41 }, (_, j) => a + ((b - a) * j) / 40);
      const colour = colourOf.get(owner) ?? "#5c5c5c";
      const first = !shown.has(owner);
      shown.add(owner);
      return {
        type: "scatter", mode: "lines", x: zs.map(xOf), y: zs.map((z) => phi(z) / sdBp), fill: "tozeroy",
        name: `${bonds[owner].name} ${fmt.pct(res.prob[owner], 1)}`, legendgroup: String(owner), showlegend: first,
        line: { color: colour, width: 1.5 }, fillcolor: hexAlpha(colour, 0.35),
        hovertemplate: `CTD ${bonds[owner].name}<br>CTD yield %{x:+.0f}bp<extra></extra>`,
      };
    });
    plot(payoff, traces, {
      xaxis: { title: { text: `Change in CTD (${bonds[c].name}) yield to delivery, bp` }, zeroline: true },
      yaxis: { title: { text: "Probability density (per bp)" }, rangemode: "tozero" },
      shapes: cuts.map((s) => ({ type: "line", x0: xOf(s.z), x1: xOf(s.z), yref: "paper", y0: 0, y1: 1,
        line: { color: "#ffd24d", dash: "dot", width: 1 } })),
      legend: { y: -0.3 }, margin: { b: 90 },
    }, 380);
    const near = res.switches.filter((s) => Math.abs(s.z) <= 3);
    switchesHost.replaceChildren(...near.map((s) => el("div", {},
      `CTD switches ${bonds[s.from].name} → ${bonds[s.to].name} at ${fmt.s(xOf(s.z), 0)}bp in the CTD yield (z = ${fmt.s(s.z, 2)}, `,
      `${fmt.pct(s.z > 0 ? 1 - Phi(s.z) : Phi(s.z), 1)} chance of moving beyond it).`)),
      near.length ? "" : el("div", {}, "No CTD switch within ±3 standard deviations of the CTD yield at delivery."),
      el("div", {}, `Mean ${fmt.s(xOf(0), 0)}bp (drift), standard deviation ${sdBp.toFixed(0)}bp to delivery.`));
    const ranked = bonds.map((b, i) => ({ b, i, p: res.prob[i] })).filter((x) => x.p >= 0.0005).sort((a, b) => a.p - b.p);
    plot(probs, [{ type: "bar", orientation: "h", x: ranked.map((r) => 100 * r.p), y: ranked.map((r) => r.b.name),
      marker: { color: ranked.map((r) => colourOf.get(r.i)) }, text: ranked.map((r) => `${(100 * r.p).toFixed(1)}%`), textposition: "outside",
      cliponaxis: false, hovertemplate: "%{y}: %{x:.1f}%<extra></extra>" }],
    { xaxis: { title: { text: "%" }, range: [0, 115] }, margin: { l: 140 }, showlegend: false }, Math.max(140, 34 * ranked.length + 60));
  }

  const basketTable = dataTable([
    { key: "rm", label: "", value: (r) => (r.added ? 1 : 0), fmt: (r) => (r.added
      ? el("button", { class: "btn", title: "Remove from basket", "aria-label": `Remove ${r.name}`, onclick: (e) => { e.stopPropagation(); removeBond(r.id); } }, "✕")
      : ""), left: true },
    { key: "name", label: "Bond", fmt: (r) => `${r.isCtd ? "◆ " : ""}${r.name}${r.added ? " (added)" : ""}`, value: (r) => r.t, left: true },
    { key: "mat", label: "Maturity", fmt: (r) => r.maturity, value: (r) => r.t },
    { key: "close", label: "Close yield", unit: "%", fmt: (r) => (r.closeYield == null ? "–" : r.closeYield.toFixed(3)), value: (r) => r.closeYield,
      title: "Closing yield before the futures anchor" },
    { key: "y", label: "Yield", unit: "%", title: "Anchored to the futures and EFP basis; edit to override",
      edit: { get: (r) => r.y.toFixed(4), set: (r, v) => setInput(r.id, { y: clampYield(v, r.y) - r.shift }), changed: (r) => inputs[ccode]?.[r.id]?.y != null } },
    { key: "beta", label: "Beta", edit: { get: (r) => r.beta.toFixed(2), set: (r, v) => setInput(r.id, { beta: +v }), changed: (r) => inputs[ccode]?.[r.id]?.beta != null } },
    { key: "cf", label: "CF", edit: { get: (r) => r.cf.toFixed(4), set: (r, v) => setInput(r.id, { cf: +v }), changed: (r) => inputs[ccode]?.[r.id]?.cf != null } },
    { key: "fy", label: "Fwd yield", unit: "%", fmt: (r) => r.fwdYield.toFixed(3), value: (r) => r.fwdYield },
    { key: "ratio", label: "P/CF at delivery", edit: { get: (r) => r.ratio0.toFixed(4), set: (r, v) => {
      const y = yieldForRatio(last.model, markets[mcode], r.id, +v);
      setInput(r.id, { y: y - r.shift });
    } } },
    { key: "efp", label: "EFP basis VWAP", get unit() { return basisUnit(mcode).label; }, fmt: (r) => (r.efp == null ? "–" : fmt.n(r.efp, 1)), value: (r) => r.efp,
      title: "Daily VWAP gross basis of the bond's EFP trades (EURX page), the anchor" },
    { key: "gross", label: "Gross basis", get unit() { return basisUnit(mcode).label; }, fmt: (r) => fmt.n(r.gross, 1), value: (r) => r.gross },
    { key: "repo", label: "Repo", unit: "%", fmt: (r) => r.repo.toFixed(3), value: (r) => r.repo, cls: (r) => (r.repo < last.model.repo - 1e-6 ? "amber" : ""),
      title: "Term repo to delivery: the CTD's own rate (set above), GC for the others" },
    { key: "carry", label: "Carry", get unit() { return basisUnit(mcode).label; }, fmt: (r) => fmt.n(r.carryT, 1), value: (r) => r.carryT },
    { key: "nbm", label: "Net basis", get unit() { return basisUnit(mcode).label; }, fmt: (r) => (r.nbMkt == null ? "–" : fmt.n(r.nbMkt, 1)), value: (r) => r.nbMkt,
      title: "Gross basis − carry: the output" },
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
    const extra = new Set((added[ccode] ?? []).map((a) => a.id));
    const market = markets[mcode];
    const close = new Map(market.bonds.map((b) => [b.id, b.closeYield ?? b.yield]));
    const contract = contracts[ccode];
    const efpDate = market.anchor?.dates[contract.product];
    basketTable.update(model.bonds.map((b, i) => ({
      ...b, isCtd: i === c, prob: res.prob[i], shift: shift(b.t), added: extra.has(b.id), closeYield: close.get(b.id),
      efp: efpDate && contract.basis?.[b.id]?.[efpDate] ? contract.basis[b.id][efpDate].c * unit.mult / 100 : null,
      gross: (b.clean - fut * b.cf) * unit.mult, carryT: b.carry * unit.mult,
      nbFair: res.nbFair[i] * unit.mult, nbMkt: mkt ? (b.fwdClean - mkt.price * b.cf) * unit.mult : null,
    })));
    basketNote.textContent = (market.anchor
      ? `Yields anchored to the futures: bonds with EFP trades on ${efpDate} take the yield of futures VWAP × CF + their EFP gross basis VWAP, `
        + `so their gross basis is the EURX VWAP; other bonds move with the shift interpolated across contracts (closing yields of ${market.asOf} in Close yield). `
      : `Yields as of ${market.asOf} (end-of-day prices). `) +
      `Gross basis = clean price − futures × CF using ${mkt ? "the market" : "the model's fair"} futures price; carry = clean − forward clean ` +
      `price at delivery (the CTD at its own repo, set above; the others at GC ${model.repo.toFixed(3)}%); net basis = gross − carry, the output. Fair net basis uses the fair futures price. ` +
      `◆ = CTD at forward prices. Edited inputs are highlighted; P/CF edits solve for the yield.`;
    renderAnchor(market, unit);
  }

  // The anchor points behind the curve shift for this market.
  function renderAnchor(market, unit) {
    const a = market.anchor;
    if (!a) { anchorHost.replaceChildren(); return; }
    anchorHost.replaceChildren(el("section", { class: "panel", style: { marginTop: "10px" } },
      el("h2", {}, `Curve anchor: ${market.name} moved onto the futures`),
      el("div", { class: "table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ["Bond", "Contract", "Date", "Futures VWAP", "CF", `EFP basis ${unit.label}`, "Lots", "Implied yield %", "Close yield %", "Shift bp"]
          .map((h, i) => el("th", { class: i < 3 ? "l" : "" }, h)))),
        el("tbody", {}, [...a.points].sort((x, y) => x.t - y.t).map((p) => el("tr", {},
          el("td", { class: "l" }, p.name), el("td", { class: "l" }, p.contract), el("td", { class: "l" }, p.date),
          el("td", {}, p.futures.toFixed(3)), el("td", {}, p.cf.toFixed(6)), el("td", {}, fmt.n(p.basis * unit.mult / 100, 1)),
          el("td", {}, fmt.int(p.lots)), el("td", {}, p.implied.toFixed(4)), el("td", {}, p.close.toFixed(4)),
          el("td", { class: signClass(p.shift * 100, 0.5) }, fmt.s(p.shift * 100, 1))))))),
      el("p", { class: "note" }, "Implied yield: the yield at the market's settlement of clean price = futures VWAP × CF + EFP gross basis VWAP. "
        + `Interpolation points (lot-weighted per contract): ${a.perContract.map((p) => `${p.contract} ${p.t.toFixed(1)}y ${fmt.s(p.shift * 100, 1)}bp`).join(", ")}; flat beyond.`)));
  }

  // ---- adding bonds to the basket
  function addBond(bond) {
    (added[ccode] ??= []).push(bond);
    renderAddForm();
    editor.update(points(), background());
    recompute();
  }
  function removeBond(id) {
    added[ccode] = (added[ccode] ?? []).filter((b) => b.id !== id);
    if (inputs[ccode]) delete inputs[ccode][id];
    renderAddForm();
    editor.update(points(), background());
    recompute();
  }
  function renderAddForm() {
    const market = markets[mcode];
    const contract = contracts[ccode];
    const inBasket = new Set([...contract.basket, ...(added[ccode] ?? [])].map((b) => b.id));
    const pick = el("select", { "aria-label": "Bond to add" },
      el("option", { value: "" }, "choose a bond…"),
      market.bonds.filter((b) => !inBasket.has(b.id) && b.maturity > contract.delivery).sort((a, b) => a.maturity.localeCompare(b.maturity))
        .map((b) => el("option", { value: b.id }, `${b.name}  ${b.yield.toFixed(3)}%`)));
    const addPick = el("button", { class: "btn", onclick: () => {
      const b = market.bonds.find((x) => x.id === pick.value);
      if (b) addBond({ id: b.id, name: b.name, coupon: b.coupon, maturity: b.maturity, cf: conversionFactor(b.coupon, b.maturity), custom: false });
    } }, "Add");
    const f = {
      name: el("input", { type: "text", placeholder: "name", style: { width: "11em" }, "aria-label": "New bond name" }),
      coupon: el("input", { type: "number", step: "0.125", placeholder: "coupon %", "aria-label": "Coupon %" }),
      maturity: el("input", { type: "date", "aria-label": "Maturity" }),
      yield: el("input", { type: "number", step: "0.001", placeholder: "yield %", "aria-label": "Yield %" }),
      beta: el("input", { type: "number", step: "0.01", value: "1", "aria-label": "Beta" }),
      cf: el("input", { type: "number", step: "0.0001", placeholder: "auto", "aria-label": "Conversion factor (blank = computed)" }),
    };
    const status = el("span", { class: "muted" });
    const addCustom = el("button", { class: "btn", onclick: () => {
      const coupon = parseFloat(f.coupon.value), y = parseFloat(f.yield.value), maturity = f.maturity.value;
      if (!isFinite(coupon) || !isFinite(y) || !maturity) { status.textContent = "Coupon, maturity and yield are required."; return; }
      if (maturity <= contract.delivery) { status.textContent = `Maturity must be after delivery (${contract.delivery}).`; return; }
      const n = (added[ccode] ?? []).filter((b) => b.custom).length + 1;
      const cf = parseFloat(f.cf.value);
      addBond({ id: `CUSTOM-${ccode}-${n}`, name: f.name.value.trim() || `Custom ${coupon} ${maturity}`, coupon, maturity,
        cf: isFinite(cf) && cf > 0 ? cf : conversionFactor(coupon, maturity), yield: clampYield(y, 4), beta: parseFloat(f.beta.value) || 1, custom: true });
    } }, "Add");
    addHost.replaceChildren(
      el("div", { class: "row" }, el("span", { class: "amber" }, "Add a bond from the market:"), pick, addPick),
      el("div", { class: "row" }, el("span", { class: "amber" }, "Or a new bond (e.g. a future issue):"),
        f.name, f.coupon, el("label", {}, "maturity ", f.maturity), f.yield, el("label", {}, "β ", f.beta), el("label", {}, "CF ", f.cf), addCustom, status));
  }

  // ---- selection
  function selectMarket(m) {
    mcode = m;
    ccode = defaultContract(m);
    setHash({ m: mcode, c: ccode });
    renderContracts();
    renderNodes();
    renderAddForm();
    editor.update(points(), background());
    recompute();
  }
  function renderContracts() {
    contractTabs.replaceChildren(segmented(FUTURES_BY_MARKET[mcode].map((k) => ({ code: k, label: `${k} (${expiryLabel(contracts[k].expiry)})` })), ccode, (k) => {
      ccode = k;
      setHash({ m: mcode, c: ccode });
      renderAddForm();
      editor.update(points(), background());
      recompute();
    }));
  }
  marketTabs.append(segmented(MARKETS, mcode, selectMarket));
  setHash({ m: mcode, c: ccode });
  renderContracts();
  renderNodes();
  renderAddForm();
  editor.update(points(), background());
  recompute();
}

function hexAlpha(hex, a) {
  return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
}

// CME conversion factor (6% notional coupon), term from the first delivery day rounded down to whole
// months (TU, FV) or quarters (other contracts).
function cmeConversionFactor(coupon, maturity, first, roundMonths) {
  let months = (maturity.getUTCFullYear() - first.getUTCFullYear()) * 12 + maturity.getUTCMonth() - first.getUTCMonth();
  if (maturity.getUTCDate() < first.getUTCDate()) months -= 1;
  months -= months % roundMonths;
  const n = Math.floor(months / 12), z = months % 12;
  const v = z < 7 ? z : roundMonths === 3 ? 3 : z - 6;
  const c = coupon / 100;
  const a = 1 / 1.03 ** (v / 6);
  const b = (c / 2) * (6 - v) / 6;
  const cc = z < 7 ? 1 / 1.03 ** (2 * n) : 1 / 1.03 ** (2 * n + 1);
  return Math.round((a * (c / 2 + cc + (c / 0.06) * (1 - cc)) - b) * 1e4) / 1e4;
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
      el("li", {}, "The futures delivers the lowest price / conversion factor. The points on the z line where the cheapest bond changes are solved exactly, so CTD probabilities are differences of normal CDFs; the fair futures price is the expected lower envelope (Simpson's rule over ±5 standard deviations). Nothing is simulated."),
      el("li", {}, "Bonds can be added to the basket, from the market or by hand (e.g. a new issue). Their conversion factor is computed with the CME formula (UST) or as Eurex does (price per 1 nominal at the 6% notional coupon, 4% for the Buxl, on the delivery date) unless typed in. Check eligibility against the exchange's rules."),
      el("li", {}, "Moving a curve point shifts today's yields of the deliverables by the interpolated change at their maturity; the forward yields then follow from repo. Drift is your expected yield change per year to delivery; vol is the normal (bp) volatility per year, defaulting to the realised 3-month volatility of that curve point."),
      el("li", {}, "Bond yields: TreasuryDirect (UST), Bundesbank (Bunds), Borsa Italiana closing prices (OATs, BTPs). Conversion factors: CME formula (UST), Eurex notified factors. Market futures prices: daily VWAP of the futures leg of Eurex EFP trades; none for UST (CME data cannot be republished), so the UST tiles show the model only."),
      el("li", {}, "Curve anchor (Eurex markets): on each contract's latest EFP day, a deliverable's clean price = futures VWAP × CF + its EFP gross basis VWAP (as on the EURX page). "
        + "Those bonds take the implied yield; other bonds and the generic curve points move by the lot-weighted shift of each contract, interpolated by maturity and flat beyond. "
        + "Gross basis is then the EURX VWAP for traded bonds, and net basis = gross basis − carry is the output. The Bond Monitor uses the same net basis."),
      el("li", {}, "Beta: regression of each bond's daily yield change on the fitted curve's change at its maturity over 3 months (clipped to 0.5–1.5).")));
}
