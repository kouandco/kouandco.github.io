import { $, COLORS, dataTable, el, fmt, footnotes, frame, hashParam, loadJSON, MARKETS, plot, segmented, setHash, showError, signClass } from "./common.js";
import { Phi, couponsBetween, linear, parseDate, phi, pricer, repoAt, yearsBetween } from "./bond.js";
import { curveEditor } from "./curve-editor.js";
import { FUTURES_BY_MARKET, anchorMarket, basisUnit, ctdIndex, curveDynamics, evaluate, marketFutures, oaDV01, prepare, sweep, yieldForRatio } from "./futures.js";

// The generic yield each contract's probability analysis is anchored to (fitted-curve point, years): every
// deliverable moves by its beta to it.
const ANCHOR = { TU: 2, FV: 5, TY: 10, UXY: 10, US: 30, WN: 30, DU: 2, OE: 5, RX: 10, UB: 30, OAT: 10, BTS: 2, IK: 10 };
const BETA_DAYS = 63;   // 3 months of daily changes

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


// Each bond's beta to the generic yield: regression of its daily yield changes on the fitted curve's change at
// the anchor point over the last 3 months (data/gp/<market>.json), clipped to 0.3-2.
function anchorBetas(gp, tA) {
  const g = gp.fit?.[String(tA)];
  if (!g) return {};
  const gAt = new Map(gp.fitDates.map((d, i) => [d, g[i]]));
  const out = {};
  for (const [id, ys] of Object.entries(gp.yield)) {
    const pairs = [];
    for (let i = 1; i < gp.dates.length; i++) {
      const y0 = ys[i - 1], y1 = ys[i], g0 = gAt.get(gp.dates[i - 1]), g1 = gAt.get(gp.dates[i]);
      if (y0 != null && y1 != null && g0 != null && g1 != null) pairs.push([g1 - g0, y1 - y0]);
    }
    const p = pairs.slice(-BETA_DAYS);
    if (p.length < 20) continue;
    const mx = p.reduce((a, [x]) => a + x, 0) / p.length, my = p.reduce((a, [, y]) => a + y, 0) / p.length;
    const vx = p.reduce((a, [x]) => a + (x - mx) ** 2, 0);
    if (!vx) continue;
    const b = p.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / vx;
    out[id] = Math.min(2, Math.max(0.3, b));
  }
  return out;
}

function start(contracts, markets) {
  const codes = MARKETS.map((m) => m.code);
  const gpCache = {};       // market -> data/gp history (loaded on first use)
  const betaCache = {};     // market|anchor -> {bond id: beta}
  const anchorT = () => ANCHOR[ccode] ?? 10;
  function betasNow(then) {
    const m = mcode, tA = anchorT(), key = `${m}|${tA}`;
    if (betaCache[key]) return betaCache[key];
    (gpCache[m] ??= loadJSON(`data/gp/${m}.json`)).then((gp) => {
      if (!betaCache[key]) { betaCache[key] = anchorBetas(gp, tA); then?.(); }
    }).catch((e) => { console.warn("betas unavailable", e); betaCache[key] = {}; });
    return null;
  }
  let mcode = hashParam("m", "UST", codes);
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
    el("span", { class: "muted" }, "cheapest-to-deliver probabilities, delivery option value and basis payoff at delivery"));
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
  const basketNote = el("div");
  const anchorHost = el("div");
  const repoEditorHost = el("div");
  const repoControls = el("div", { class: "row", style: { marginTop: "6px" } });
  const addHost = el("div", { class: "stack", style: { marginTop: "8px" } });
  const basisCtl = el("div", { class: "row", style: { margin: "4px 0 8px" } });
  const basisLevel = el("div", { class: "plot" });   // basis P&L vs a parallel move in the generic yield
  const basisCurve = el("div", { class: "plot" });   // basis P&L vs a steepening of the deliverables' curve
  const basisNote = el("div", { class: "note" });
  const basisSel = { id: null, side: "long", view: "value" };   // bond (null = CTD) and side of the basis position
  const sweepProb = el("div", { class: "plot" });
  const sweepDV01 = el("div", { class: "plot" });
  const sweepNote = el("div");
  const repoNotes = el("div");
  // Results first; the input graphs (repo to delivery, generic curve) at the bottom.
  app.append(
    title,
    el("div", { class: "row", style: { marginBottom: "8px" } }, marketTabs, contractTabs),
    tiles,
    el("section", { class: "panel", style: { marginTop: "10px" } },
      el("h2", {}, "CTD yield at delivery: distribution by CTD"),
      el("div", { class: "grid cols-2", style: { alignItems: "start" } },
        el("div", {}, payoff, switchesHost),
        el("div", {}, el("h2", {}, "CTD probability"), probs))),
    el("section", { class: "panel", style: { marginTop: "10px" } },
      el("h2", {}, "Basis payoff at delivery"), basisCtl,
      el("div", { class: "grid cols-2" }, basisLevel, basisCurve), basisNote),
    el("section", { class: "panel", style: { marginTop: "10px" } },
      el("h2", {}, "Sensitivity to today's yield level"),
      el("div", { class: "grid cols-2" }, sweepProb, sweepDV01), sweepNote),
    el("section", { class: "panel", style: { marginTop: "10px" } },
      el("div", { class: "row", style: { justifyContent: "space-between" } },
        el("h2", {}, "Deliverable basket"),
        el("button", { class: "btn", onclick: () => { inputs[ccode] = {}; added[ccode] = []; renderAddForm(); recompute(); } }, "Reset bonds")),
      basketHost, addHost, basketNote, anchorHost),
    el("div", { class: "grid cols-2", style: { marginTop: "10px", alignItems: "start" } },
      el("section", { class: "panel" },
        el("h2", {}, "Input: CTD repo to delivery"),
        repoEditorHost, repoControls,
        repoNotes),
      el("section", { class: "panel" },
        el("div", { class: "row", style: { justifyContent: "space-between" } },
          el("h2", {}, "Input: generic curve"),
          el("button", { class: "btn", onclick: () => { nodes[mcode] = freshNodes(markets[mcode]); refreshCurve(); } }, "Reset curve")),
        editorHost, nodesHost, spreadsHost)),
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
    // Every deliverable moves with the generic yield at the contract's anchor point, by its beta to it.
    const anchor = { anchorT: anchorT(), betas: betasNow(() => recompute()) ?? {} };
    // The CTD (cheapest at GC repo) is financed at its own term repo to delivery; every other bond at GC.
    const gc = prepare(contract, market, { inputs: ins, ...anchor });
    if (!gc.bonds.length) return { inputs: ins, ...anchor };
    const ctdId = gc.bonds[ctdIndex(gc)].id;
    return { inputs: ins, repoById: { [ctdId]: repoBox().rD }, ctdId, ...anchor };
  }

  // ---- CTD repo with boxing
  // Three term rates for the CTD: S/N, S/Box (to the boxing date, 5 business days before delivery) and S/Dlv (to
  // delivery); O/N, O/Box and O/Dlv for UST, which settles T+1. By default they sit on the GC repo curve; each can be dragged, and S/Dlv typed.
  // The CTD is financed at S/Dlv. The boxing premium is the forward rate between boxing and delivery minus that
  // forward on GC; typing a premium moves S/Box with S/Dlv held.
  // UST settles T+1, so its repo terms run from today (O/N, O/Box, O/Dlv); euro markets settle T+2 (S/N, S/Box, S/Dlv).
  function repoLabels() {
    const p = mcode === "UST" ? "O" : "S";
    return { sn: `${p}/N`, sbox: `${p}/Box`, sdlv: `${p}/Dlv` };
  }
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
      premium: (fwd(rB, rD) - fwd(rB0, rD0)) * 100, ...repoLabels() };
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
    repoNotes.replaceChildren(footnotes(
      `${b.sn}, ${b.sbox} and ${b.sdlv} start on the GC repo curve (proxy): drag them or type the CTD's term repo to delivery (special = GC − CTD repo).`
        + (mcode === "UST" ? " Treasuries settle T+1, so the terms run from today (overnight)." : " Euro markets settle T+2, so the terms run from spot."),
      `Boxing premium: the extra forward rate priced between boxing and delivery (red). Typing it moves ${b.sbox} with ${b.sdlv} held.`,
      `The CTD is financed at ${b.sdlv}; the other deliverables at GC. The Bond Monitor's net basis uses GC.`));
    const day = (d) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
    const days = (t) => t * 365.25;
    repoEditor.update(
      [{ x: days(b.tN), y: b.rN, label: b.sn }, { x: days(b.tB), y: b.rB, label: b.sbox, anchor: "end" },
        { x: days(b.tD), y: b.rD, label: b.sdlv, anchor: "end" }],
      [],
      { keepRange: dragging, extra: { lines: [{ x: days(b.tB), label: `Box ${day(b.box)}` }, { x: days(b.tD), label: `Dlv ${day(b.delivery)}` }],
        segments: [{ x0: days(b.tB), x1: days(b.tD), y: b.fwd }] } });
    const summary = () => [`${ctdName}: ${b.sn} ${b.rN.toFixed(3)}%, ${b.sbox} (${day(b.box)}) ${b.rB.toFixed(3)}%, ${b.sdlv} (${day(b.delivery)}) `,
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
      tile("OA DV01", fmt.n(dv * 1000, 2), `per 100,000 notional; CTD β × DV01 / CF ${fmt.n((ctd.beta * ctd.dv01 / ctd.cf) * 1000, 2)}`),
    );
    renderRepoBox(model, model.bonds.find((b) => b.id === opts.ctdId)?.name ?? "CTD", draggingRepo);
    renderPayoff(model, res);
    renderBasis(model, res, fut, mkt, unit, market.currency, contract);
    renderBasket(model, res, fut, mkt, unit);
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(() => renderSweep(contract, market, opts, cv, model), 250);
  }

  // Probability and DV01 across shifts in today's generic yield (redrawn once editing pauses).
  let sweepTimer = null;
  const SHIFTS = Array.from({ length: 51 }, (_, i) => -200 + 10 * i);
  function renderSweep(contract, market, opts, cv, model) {
    const grid = sweep(contract, market, opts, cv, SHIFTS);
    const per = 1000;   // DV01 per 100,000 notional (values are per 100 face)
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
      yaxis: { title: { text: `DV01 per 100,000 notional (${ccy})` } },
    }, 340);
    sweepNote.replaceChildren(footnotes(
      "Each point re-solves the model with today's yields shifted (every deliverable by β × shift), keeping your drift, vol and curve edits.",
      "When a CTD switch is likely, the futures DV01 departs from the current CTD's DV01 / CF, so a hedge based on the CTD alone over- or under-hedges."));
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
    const gen = `generic ${model.anchorT}Y yield`;
    const sdBp = (res.sdG ?? res.sd[c]) * 100;
    const xOf = (z) => ((res.muG ?? res.mu[c]) + (res.sdG ?? res.sd[c]) * z) * 100;
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
        hovertemplate: `CTD ${bonds[owner].name}<br>${gen} %{x:+.0f}bp<extra></extra>`,
      };
    });
    plot(payoff, traces, {
      xaxis: { title: { text: `Change in the ${gen} to delivery, bp` }, zeroline: true },
      yaxis: { title: { text: "Probability density (per bp)" }, rangemode: "tozero" },
      shapes: cuts.map((s) => ({ type: "line", x0: xOf(s.z), x1: xOf(s.z), yref: "paper", y0: 0, y1: 1,
        line: { color: "#ffd24d", dash: "dot", width: 1 } })),
      legend: { y: -0.3 }, margin: { b: 90 },
    }, 380);
    const near = res.switches.filter((s) => Math.abs(s.z) <= 3);
    switchesHost.replaceChildren(...near.map((s) => el("div", {},
      `CTD switches ${bonds[s.from].name} → ${bonds[s.to].name} at ${fmt.s(xOf(s.z), 0)}bp in the ${gen} (z = ${fmt.s(s.z, 2)}, `,
      `${fmt.pct(s.z > 0 ? 1 - Phi(s.z) : Phi(s.z), 1)} chance of moving beyond it).`)),
      near.length ? "" : el("div", {}, `No CTD switch within ±3 standard deviations of the ${gen} at delivery.`),
      el("div", {}, `${gen[0].toUpperCase()}${gen.slice(1)}: mean ${fmt.s(xOf(0), 0)}bp (drift), standard deviation ${sdBp.toFixed(0)}bp to delivery; each deliverable moves by its β × that.`));
    const ranked = bonds.map((b, i) => ({ b, i, p: res.prob[i] })).filter((x) => x.p >= 0.0005).sort((a, b) => a.p - b.p);
    plot(probs, [{ type: "bar", orientation: "h", x: ranked.map((r) => 100 * r.p), y: ranked.map((r) => r.b.name),
      marker: { color: ranked.map((r) => colourOf.get(r.i)) }, text: ranked.map((r) => `${(100 * r.p).toFixed(1)}%`), textposition: "outside",
      cliponaxis: false, hovertemplate: "%{y}: %{x:.1f}%<extra></extra>" }],
    { xaxis: { title: { text: "%" }, range: [0, 115] }, margin: { l: 140 }, showlegend: false }, Math.max(140, 34 * ranked.length + 60));
  }

  // P&L to delivery of a basis position per 100 nominal of bond j: long the bond financed in repo, short CF_j
  // futures per 100 of bond at today's price F0, delivering or reversing at delivery when futures = min P/CF.
  //   bond leg     = P_j(T) − forward clean_j                    (carry is in the forward price)
  //   futures leg  = CF_j × (F0 − min_i P_i(T)/CF_i)
  //   net          = CF_j × (P_j/CF_j − min P/CF) − net basis today   (≥ −net basis: a long put on the CTD switch)
  // Two views: value at delivery = CF_j × (P_j/CF_j − min P/CF), zero while bond j is CTD; P&L to delivery = that
  // value − today's net basis, i.e. with the coupon income and the repo cost of holding the bond to delivery.
  // On the model's z line, so the x axis and the colours match the distribution chart above.
  function renderBasis(model, res, fut, mkt, unit, ccy, contract) {
    const { bonds } = model;
    const c = ctdIndex(model);
    let j = bonds.findIndex((b) => b.id === basisSel.id);
    if (j < 0) j = c;
    const sgn = basisSel.side === "long" ? 1 : -1;
    const Z = 3.5, N = 141;
    const zs = Array.from({ length: N }, (_, k) => -Z + (2 * Z * k) / (N - 1));
    const xOf = (z) => (res.mu[c] + res.sd[c] * z) * 100;
    const xs = zs.map(xOf);
    const env = (z) => Math.min(...bonds.map((_, i) => res.ratio(i, z)));
    const envs = zs.map(env);
    const nb = (i) => bonds[i].fwdClean - fut * bonds[i].cf;                 // net basis today, price per 100
    const pnlView = basisSel.view === "pnl";
    const start = (i) => (pnlView ? nb(i) : 0);   // P&L: less today's net basis (carry and repo in); value: nothing
    const net = (i, k) => sgn * (bonds[i].cf * (res.ratio(i, zs[k]) - envs[k]) - start(i));
    const m = unit.mult;
    // Bonds with a realistic chance of being delivered, plus the chosen one.
    const shown = bonds.map((_, i) => i).filter((i) => i === j || res.prob[i] >= 0.005 || i === c);
    // P&L at delivery for given yield moves of each deliverable (bp, on top of the expected path), on the model's
    // pricing: res.ratio(i, z) moves bond i's forward yield by sd_i × z, so a move of x bp is z = x / 100 / sd_i.
    const zFor = (i, bp) => (res.sd[i] > 0 ? bp / 100 / res.sd[i] : 0);
    const pnlAt = (moves) => {
      const r = bonds.map((_, i) => res.ratio(i, zFor(i, moves[i])));
      const e = Math.min(...r);
      return { ctd: r.indexOf(e), at: (i) => sgn * (bonds[i].cf * (r[i] - e) - start(i)) * m };
    };
    const zero = [{ type: "line", x0: 0, x1: 1, xref: "paper", y0: 0, y1: 0, line: { color: "#5c5c5c", width: 1 } }];
    const colourFor = (i, k) => colours.get(bonds[i].id) ?? COLORS[(k + 4) % COLORS.length];
    const yTitle = pnlView ? `${sgn > 0 ? "Long" : "Short"} basis P&L to delivery, incl. carry and repo (${unit.label} per 100)`
      : `${sgn > 0 ? "Long" : "Short"} basis value at delivery (${unit.label} per 100)`;
    // Lines for every shown bond over a grid of moves, with dotted lines where the CTD switches.
    const draw = (node, grid, movesOf, xTitle, extra = []) => {
      const pts = grid.map((x) => pnlAt(movesOf(x)));
      const cuts = [];
      for (let k = 1; k < grid.length; k++) if (pts[k].ctd !== pts[k - 1].ctd) {
        const x = (grid[k] + grid[k - 1]) / 2;
        cuts.push({ type: "line", x0: x, x1: x, yref: "paper", y0: 0, y1: 1, line: { color: "#ffd24d", dash: "dot", width: 1 } });
      }
      plot(node, [...extra, ...shown.map((i, k) => ({
        type: "scatter", mode: "lines", name: bonds[i].name, x: grid, y: pts.map((p) => p.at(i)),
        line: { color: colourFor(i, k), width: i === j ? 3 : 1.5, dash: i === j ? "solid" : "dot" },
        hovertemplate: `${bonds[i].name}: %{y:.1f}${unit.label}<extra></extra>`,
      }))], {
        hovermode: "x unified", shapes: [...zero, ...cuts], legend: { y: -0.3 }, margin: { b: 90 },
        xaxis: { title: { text: xTitle } }, yaxis: { title: { text: yTitle } },
        yaxis2: { overlaying: "y", side: "right", showgrid: false, showticklabels: false, rangemode: "tozero" },
      }, 400);
    };
    // 1) Generic yield: every deliverable moves by β × the shift; grey = the model's distribution of that shift.
    const sdG = (res.sdG ?? (bonds[c].beta ? res.sd[c] / bonds[c].beta : res.sd[c])) * 100;         // bp
    const gridL = Array.from({ length: 141 }, (_, k) => -3.5 * sdG + (7 * sdG * k) / 140);
    draw(basisLevel, gridL, (x) => bonds.map((bd) => bd.beta * x), `Move in the generic ${model.anchorT}Y yield to delivery (from its drift path), bp`,
      [{ type: "scatter", mode: "lines", name: "Density", x: gridL, y: gridL.map((x) => phi(x / sdG) / sdG), yaxis: "y2", fill: "tozeroy",
        line: { color: "rgba(140,140,140,0.5)", width: 1 }, fillcolor: "rgba(140,140,140,0.12)", hoverinfo: "skip", showlegend: false }]);
    // 2) Curve: a steepening pivoting on the CTD; x = change in the yield spread between the shortest and the
    // longest deliverable (bond i moves x × (t_i − t_CTD) / (t_max − t_min)), the level at its expected path.
    const ts = bonds.map((bd) => bd.t), span = Math.max(...ts) - Math.min(...ts) || 1;
    const gridC = Array.from({ length: 121 }, (_, k) => -60 + k);
    draw(basisCurve, gridC, (x) => bonds.map((bd) => (x * (bd.t - bonds[c].t)) / span),
      `Steepening of the deliverables' curve (longest − shortest), bp; pivot ${bonds[c].name}`);
    const b = bonds[j];
    const legNet = zs.map((_, k) => net(j, k) * m);
    // Expected P&L = CF × (F0 − fair futures), since E[min P/CF] is the fair price.
    // Expected P&L = CF × (futures − fair futures); expected value at delivery = that + net basis = fair net basis.
    const exp = sgn * (b.cf * (fut - res.fair) + (pnlView ? 0 : nb(j))) * m;
    const lo = Math.min(...legNet), hi = Math.max(...legNet);
    const per10 = (x) => `${x < 0 ? "−" : "+"}${ccy}${fmt.int(Math.abs((x / m) * 1e5))}`;                    // per 10mm nominal: price per 100 × 1e5
    const futLots = Math.round((1e7 * b.cf) / contract.face);
    basisCtl.replaceChildren(
      el("span", { class: "amber" }, "Bond"),
      el("select", { "aria-label": "Basis bond", onchange: (e) => { basisSel.id = e.target.value; recompute(); } },
        bonds.map((x, i) => el("option", { value: x.id, selected: i === j }, `${i === c ? "◆ " : ""}${x.name} · CTD ${fmt.pct(res.prob[i], 0)}`))),
      el("span", { class: "amber" }, "Position"),
      segmented([{ code: "long", label: "Long basis (buy bond, sell futures)" }, { code: "short", label: "Short basis (sell bond, buy futures)" }],
        basisSel.side, (v) => { basisSel.side = v; recompute(); }),
      el("span", { class: "amber" }, "Show"),
      segmented([{ code: "value", label: "Value at delivery" }, { code: "pnl", label: "P&L incl. carry & repo" }], basisSel.view, (v) => { basisSel.view = v; recompute(); }));
    basisNote.replaceChildren(
      el("div", {}, `${b.name}: net basis today ${fmt.n(nb(j) * m, 1)}${unit.label} (gross ${fmt.n((b.clean - fut * b.cf) * m, 1)} − carry ${fmt.n(b.carry * m, 1)}) at futures ${priceText(mcode, fut)}${mkt ? " (market)" : " (model fair)"}. `
        + `Expected ${pnlView ? "P&L to delivery, incl. carry and repo," : "value at delivery"} ${fmt.s(exp, 1)}${unit.label}; range over ±3.5 sd ${fmt.s(lo, 1)} to ${fmt.s(hi, 1)}${unit.label}. `
        + `Per ${ccy}10mm of bond (${fmt.int(futLots)} contracts): expected ${per10(exp)}, worst ${per10(lo)}.`),
      el("div", {}, sgn > 0
        ? `Long basis = long the delivery option: the most it loses is today's net basis, if the bond is still CTD at delivery; it gains when yields move far enough for another bond to become cheapest. `
          + "For a bond other than the CTD the floor is its delivery basis, which is above zero unless it becomes CTD."
        : `Short basis = short the delivery option: it earns the net basis if the bond is CTD at delivery and loses when the CTD switches away from it.`),
      footnotes(
        "Net P&L to delivery of each likely deliverable's basis position (the chosen bond solid), per 100 nominal of bond.",
        `Carry = coupon income − repo cost; for ${b.name}: ${fmt.n((b.carry + b.repoCost) * m, 1)} − ${fmt.n(b.repoCost * m, 1)} = ${fmt.n(b.carry * m, 1)}${unit.label} to delivery `
          + `(repo ${b.repo.toFixed(3)}%).`,
        "Value at delivery: CF × (P/CF − lowest P/CF), the basis then; zero while the bond is CTD, positive once another bond is cheapest.",
        "P&L incl. carry & repo: value at delivery − today's net basis. The bond earns its coupon and is financed at its repo until delivery (net basis = gross basis − carry).",
        "Futures hedge = CF per 100 of bond, held to delivery with no re-hedging.",
        "Left: P&L against a parallel move in the generic yield (each deliverable by β × the move); grey = its distribution to delivery. "
          + "Right: against a steepening pivoting on the CTD, with the level at its expected path.",
        "Yellow lines: CTD switch points. Drift, vol, repo and curve edits apply. Expected P&L and range above use the model's distribution of the CTD yield."));
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
    { key: "beta", label: "β to generic", edit: { get: (r) => r.beta.toFixed(2), set: (r, v) => setInput(r.id, { beta: +v }), changed: (r) => inputs[ccode]?.[r.id]?.beta != null } },
    { key: "cf", label: "CF", edit: { get: (r) => r.cf.toFixed(4), set: (r, v) => setInput(r.id, { cf: +v }), changed: (r) => inputs[ccode]?.[r.id]?.cf != null } },
    { key: "fy", label: "Fwd yield", unit: "%", fmt: (r) => r.fwdYield.toFixed(3), value: (r) => r.fwdYield },
    { key: "ratio", label: "P/CF at delivery", edit: { get: (r) => r.ratio0.toFixed(4), set: (r, v) => {
      const y = yieldForRatio(last.model, markets[mcode], r.id, +v);
      setInput(r.id, { y: y - r.shift });
    } } },
    { key: "efp", label: "EFP basis VWAP", get unit() { return basisUnit(mcode).label; }, fmt: (r) => (r.efp == null ? "–" : fmt.n(r.efp, 1)), value: (r) => r.efp,
      title: "Daily VWAP gross basis of the bond's EFP trades (EURX page), the anchor", hide: () => mcode === "UST" },
    { key: "gross", label: "Gross basis", get unit() { return basisUnit(mcode).label; }, fmt: (r) => fmt.n(r.gross, 1), value: (r) => r.gross },
    { key: "repo", label: "Repo", unit: "%", fmt: (r) => r.repo.toFixed(3), value: (r) => r.repo, cls: (r) => (r.repo < last.model.repo - 1e-6 ? "amber" : ""),
      title: "Term repo to delivery: the CTD's own rate (set above), GC for the others" },
    { key: "irr", label: "IRR", unit: "%", fmt: (r) => (r.irr == null ? "–" : r.irr.toFixed(3)), value: (r) => r.irr, cls: (r) => (r.irrMax ? "pos" : ""),
      title: "Implied repo rate: the return from buying the bond today and delivering it into the futures (act/360); the highest is the cheapest to deliver" },
    { key: "carry", label: "Carry", get unit() { return basisUnit(mcode).label; }, fmt: (r) => fmt.n(r.carryT, 1), value: (r) => r.carryT },
    { key: "nbm", label: "Net basis", get unit() { return basisUnit(mcode).label; }, fmt: (r) => (r.nbMkt == null ? "–" : fmt.n(r.nbMkt, 1)), value: (r) => r.nbMkt,
      title: "Gross basis − carry: the output" },
    { key: "nbf", label: "Net basis fair", get unit() { return basisUnit(mcode).label; }, fmt: (r) => fmt.n(r.nbFair, 1), value: (r) => r.nbFair },
    { key: "p", label: "CTD prob", unit: "%", fmt: (r) => fmt.n(100 * r.prob, 1), value: (r) => r.prob, cls: (r) => (r.prob > 0.5 ? "pos" : "") },
    { key: "dv01", label: "DV01", unit: "/100k", title: "Price change for 1bp per 100,000 notional", fmt: (r) => (r.dv01 * 1000).toFixed(2), value: (r) => r.dv01 },
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
    // Implied repo rate: buy the bond today (dirty), deliver it at futures × CF + accrued, coupons in between
    // reinvested at the same rate; money-market act/360.
    const D = (model.delivery - model.settle) / 864e5;
    const irrOf = (b) => {
      if (D <= 0) return null;
      const mat = parseDate(b.maturity);
      const dirty0 = b.clean + pricer(b.coupon, mat, model.settle, market.freq).accrued;
      const cpn = b.coupon / market.freq;
      const pays = couponsBetween(mat, model.settle, model.delivery, market.freq);
      const inflow = fut * b.cf + pricer(b.coupon, mat, model.delivery, market.freq).accrued + cpn * pays.length;
      const denom = dirty0 * D / 360 - pays.reduce((a, d) => a + cpn * ((model.delivery - d) / 864e5) / 360, 0);
      return ((inflow - dirty0) / denom) * 100;
    };
    const irrs = model.bonds.map(irrOf);
    const irrBest = Math.max(...irrs.filter((x) => x != null));
    basketTable.update(model.bonds.map((b, i) => ({
      ...b, isCtd: i === c, irr: irrs[i], irrMax: irrs[i] === irrBest, prob: res.prob[i], shift: shift(b.t), added: extra.has(b.id), closeYield: close.get(b.id),
      efp: efpDate && contract.basis?.[b.id]?.[efpDate] ? contract.basis[b.id][efpDate].c * unit.mult / 100 : null,
      gross: (b.clean - fut * b.cf) * unit.mult, carryT: b.carry * unit.mult,
      nbFair: res.nbFair[i] * unit.mult, nbMkt: mkt ? (b.fwdClean - mkt.price * b.cf) * unit.mult : null,
    })));
    basketNote.replaceChildren(footnotes(
      market.anchor
        ? `Yields anchored to the futures: bonds with EFP trades on ${efpDate} take the yield of futures VWAP × CF + their EFP gross basis VWAP `
          + `(so their gross basis is the EURX VWAP); the others move with the shift interpolated across contracts. Close yield: closing yields of ${market.asOf}.`
        : `Yields as of ${market.asOf} (end-of-day prices).`,
      `Gross basis = clean price − futures × CF, at ${mkt ? "the market" : "the model's fair"} futures price. Fair net basis uses the fair futures price.`,
      `Carry = clean − forward clean price at delivery: the CTD at its own repo (set below), the others at GC ${model.repo.toFixed(3)}%. Net basis = gross − carry.`,
      `IRR (implied repo rate): buy the bond today, deliver it at futures × CF + accrued (futures ${mkt ? "market" : "model fair"} price), coupons in between reinvested; act/360. `
        + "The highest IRR (green) is the cheapest to deliver; compare it with the bond's repo.",
      "◆ = CTD at forward prices. Edited inputs are highlighted; P/CF edits solve for the yield."));
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
      footnotes(
        "Implied yield: the yield, at the market's settlement, of clean price = futures VWAP × CF + EFP gross basis VWAP.",
        `Interpolation points (lot-weighted per contract): ${a.perContract.map((p) => `${p.contract} ${p.t.toFixed(1)}y ${fmt.s(p.shift * 100, 1)}bp`).join(", ")}; flat beyond.`)));
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
      el("li", {}, "One factor: the generic yield at the contract's anchor point (fitted curve: TU, DU, BTS 2Y; FV, OE 5Y; TY, UXY, RX, OAT, IK 10Y; US, WN, UB 30Y). Its move to delivery is drift × T + vol × √T × z, with z standard normal; drift and vol are read off the generic curve at that point. "
        + "Each deliverable's yield at delivery = its forward yield + β × the generic move, β being the bond's beta to the generic yield."),
      el("li", {}, "The futures delivers the lowest price / conversion factor. The points on the z line where the cheapest bond changes are solved exactly, so CTD probabilities are differences of normal CDFs; the fair futures price is the expected lower envelope (Simpson's rule over ±5 standard deviations). Nothing is simulated."),
      el("li", {}, "Bonds can be added to the basket, from the market or by hand (e.g. a new issue). Their conversion factor is computed with the CME formula (UST) or as Eurex does (price per 1 nominal at the 6% notional coupon, 4% for the Buxl, on the delivery date) unless typed in. Check eligibility against the exchange's rules."),
      el("li", {}, "Moving a curve point shifts today's yields of the deliverables by the interpolated change at their maturity; the forward yields then follow from repo. Drift is your expected yield change per year to delivery; vol is the normal (bp) volatility per year, defaulting to the realised 3-month volatility of that curve point."),
      el("li", {}, "Bond yields: TreasuryDirect (UST), Bundesbank (Bunds), Borsa Italiana closing prices (OATs, BTPs). Conversion factors: CME formula (UST), Eurex notified factors. Market futures prices: daily VWAP of the futures leg of Eurex EFP trades; none for UST (CME data cannot be republished), so the UST tiles show the model only."),
      el("li", {}, "Curve anchor (Eurex markets): on each contract's latest EFP day, a deliverable's clean price = futures VWAP × CF + its EFP gross basis VWAP (as on the EURX page). "
        + "Those bonds take the implied yield; other bonds and the generic curve points move by the lot-weighted shift of each contract, interpolated by maturity and flat beyond. "
        + "Gross basis is then the EURX VWAP for traded bonds, and net basis = gross basis − carry is the output. The Bond Monitor uses the same net basis."),
      el("li", {}, "Basis payoff: P&L to delivery of long bond (financed at its repo) and short CF futures per 100 nominal, at today's market futures price (model fair price when there is none). At delivery the futures equals the lowest P/CF, so the position is worth CF × (P/CF − min P/CF) and costs today's net basis. Expected P&L = CF × (futures − fair futures), so a futures trading rich to fair makes the long basis cheap."),
      el("li", {}, "β to generic: regression of each bond's daily yield change on the generic (fitted-curve) yield's change at the anchor point over the last 3 months, clipped to 0.3–2; editable per bond.")));
}
