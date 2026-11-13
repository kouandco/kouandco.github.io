import { $, COLORS, MARKETS, el, fmt, frame, plot, showError } from "./common.js";
import { repoAt } from "./bond.js";
import { IRS_TENORS, SIDES, SWAP_INDEX, TYPES, addDays, iso, legHistory, legNow, loadUniverse } from "./positions.js";

frame("TEST");
const app = $("#app");
const KEY = "testTrades";
const MAX_LEGS = 5;

const load = () => { try { return JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { return null; } };
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(trades)); } catch { /* storage unavailable */ } };

let U, trades, sel = 0, token = 0;
const results = new Map();   // trade id -> computed backtest
const pending = new Set();   // trade ids being backtested in the background

const listBox = el("div"), setupBox = el("div"), legsBox = el("div"), tiles = el("div", { class: "tiles" }), notes = el("div", { class: "note" });
const charts = { pnl: el("div", { class: "plot" }), level: el("div", { class: "plot" }), ret: el("div", { class: "plot" }), all: el("div", { class: "plot" }) };

app.append(
  el("div", { class: "page-title" }, el("h1", {}, "Strategy backtest"),
    el("span", { class: "muted" }, "bonds, ASW, futures and swaps, up to 5 legs · trades saved in this browser")),
  el("section", { class: "panel" }, el("h2", {}, "Trades"), listBox),
  el("div", { class: "grid hedge-layout", style: { marginTop: "10px" } },
    el("section", { class: "panel" }, el("h2", {}, "Trade set-up"), setupBox),
    el("section", { class: "panel" }, el("h2", {}, "Result"), tiles, notes)),
  el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "Legs"), legsBox),
  el("div", { class: "grid cols-2", style: { marginTop: "10px" } },
    el("section", { class: "panel" }, el("h2", {}, "Cash P&L"), charts.pnl),
    el("section", { class: "panel" }, el("h2", {}, "Trade level vs entry, target and stop"), charts.level),
    el("section", { class: "panel" }, el("h2", {}, "Return on capital and on balance sheet"), charts.ret),
    el("section", { class: "panel" }, el("h2", {}, "All trades: return on capital by day held"), charts.all)),
  methodNote());

loadUniverse().then((u) => {
  U = u;
  trades = load() ?? [newTrade(1)];
  const want = new URLSearchParams(location.hash.slice(1)).get("t");
  sel = Math.max(0, trades.findIndex((t) => t.id === want));
  renderAll();
}).catch((e) => showError(app, e));

// ---------------------------------------------------------------- defaults

function defaultBond(market, target = 10, needAsw = false) {
  return [...U.bonds.values()].filter((b) => b.market === market && (!needAsw || b.asw != null))
    .sort((a, b) => Math.abs(a.t - target) - Math.abs(b.t - target))[0]?.id;
}
function defaultLeg(type = "bond", market = "DE") {
  const repo = repoAt(U.markets[market].repo.points, 30 / 365);
  if (type === "bond" || type === "asw") return { type, market, id: defaultBond(market, 10, type === "asw"), side: 1, qtyMode: "notional", qty: 10e6, repo: +repo.toFixed(3), haircut: 2, repoSpread: 0 };
  if (type === "fut") { const code = Object.keys(U.futs).find((k) => U.futs[k].market === market) ?? Object.keys(U.futs)[0]; return { type, id: code, side: 1, qtyMode: "notional", qty: 100 }; }
  return { type, id: "EUR €STR", tenor: 10, fixed: null, side: 1, qtyMode: "dv01", qty: 10000 };
}
function newTrade(n) {
  const start = iso(addDays(new Date(), -60));
  return { id: Math.random().toString(36).slice(2, 9), name: `Trade ${n}`, start, legs: [defaultLeg()], weights: [1], entry: null, target: null, stop: null, hold: 30, imBp: 30 };
}
// Default level weights: outright, spread (leg 2 − leg 1), fly (2 × leg 2 − leg 1 − leg 3), else all +1.
function defaultWeights(n) { return n === 1 ? [1] : n === 2 ? [-1, 1] : n === 3 ? [-1, 2, -1] : Array(n).fill(1); }

// ---------------------------------------------------------------- rendering

function renderAll() {
  save();
  const t = trades[sel];
  history.replaceState(null, "", `#t=${t.id}`);
  renderList();
  renderSetup(t);
  renderLegs(t);
  compute(t);
}

function renderList() {
  const head = ["Trade", "Start", "Legs", "Status", "Days", "Cash P&L", "RoC %", "RoBS %", "RoC % ann.", "DV01", "Capital"];
  const rows = trades.map((t, i) => {
    const r = results.get(t.id);
    const ccy = r?.ccy ?? "";
    return el("tr", { class: i === sel ? "hl" : null, style: { cursor: "pointer" }, onclick: () => { sel = i; renderAll(); } },
      el("td", { class: "l" }, t.name), el("td", { class: "l" }, t.start), el("td", {}, t.legs.length),
      el("td", { class: "l" }, r ? r.status : "…"), el("td", {}, r ? r.days : ""),
      el("td", { class: r?.pnl >= 0 ? "pos" : "neg" }, r ? fmt.ccy(ccy, r.pnl) : ""),
      el("td", {}, r ? fmt.n(100 * r.roc, 2) : ""), el("td", {}, r ? fmt.n(100 * r.robs, 2) : ""),
      el("td", {}, r && r.days >= 7 ? fmt.n(100 * r.rocAnn, 1) : r ? "–" : ""), el("td", {}, r ? fmt.ccy(ccy, r.dv01) : ""), el("td", {}, r ? fmt.ccy(ccy, r.capital) : ""));
  });
  const fileIn = el("input", { type: "file", accept: "application/json", style: { display: "none" } });
  fileIn.addEventListener("change", async () => {
    try {
      const data = JSON.parse(await fileIn.files[0].text());
      if (Array.isArray(data) && data.length) { trades = data; sel = 0; results.clear(); renderAll(); }
    } catch (e) { alert(`Could not import: ${e.message}`); }
  });
  listBox.replaceChildren(
    el("div", { class: "table-wrap" }, el("table", {}, el("thead", {}, el("tr", {}, head.map((h, i) => el("th", { class: i < 2 || i === 3 ? "l" : "" }, h)))), el("tbody", {}, rows))),
    el("div", { class: "row", style: { marginTop: "6px" } },
      el("button", { class: "btn", onclick: () => { trades.push(newTrade(trades.length + 1)); sel = trades.length - 1; renderAll(); } }, "+ New trade"),
      el("button", { class: "btn", onclick: () => { const c = structuredClone(trades[sel]); c.id = Math.random().toString(36).slice(2, 9); c.name += " (copy)"; trades.push(c); sel = trades.length - 1; renderAll(); } }, "Duplicate"),
      el("button", { class: "btn", onclick: () => { if (trades.length > 1 && confirm(`Delete ${trades[sel].name}?`)) { results.delete(trades[sel].id); trades.splice(sel, 1); sel = 0; renderAll(); } } }, "Delete"),
      el("button", { class: "btn", onclick: () => {
        const a = el("a", { href: URL.createObjectURL(new Blob([JSON.stringify(trades, null, 1)], { type: "application/json" })), download: "trades.json" });
        a.click();
      } }, "Export"),
      el("button", { class: "btn", onclick: () => fileIn.click() }, "Import"), fileIn,
      el("span", { class: "muted small" }, "Trades are kept in this browser only; export to move them.")));
}

// A labelled input editing obj[key]. Blank number → null.
// `scale`: the field shows obj[key] / scale and stores what is typed × scale (DV01 in k, notional in mm).
function input(label, obj, key, { type = "number", step = "any", width, placeholder, title, scale = 1 } = {}) {
  const i = el("input", { type, step, value: obj[key] == null ? "" : type === "number" ? +(obj[key] / scale).toPrecision(12) : obj[key], placeholder: placeholder ?? "", title });
  if (width) i.style.width = width;
  i.addEventListener("change", () => { obj[key] = type === "number" ? (i.value === "" ? null : Number(i.value) * scale) : i.value; renderAll(); });
  return label ? el("label", { class: "row", style: { gap: "6px" } }, el("span", {}, label), i) : i;
}
function select(obj, key, options, { numeric = false, onchange } = {}) {
  const s = el("select", {}, options.map((o) => el("option", { value: o.v, selected: String(o.v) === String(obj[key]) ? true : null }, o.label)));
  s.addEventListener("change", () => { obj[key] = numeric ? Number(s.value) : s.value; onchange?.(); renderAll(); });
  return s;
}

function renderSetup(t) {
  const r = results.get(t.id);
  const unit = r?.unit ?? "";
  setupBox.replaceChildren(el("div", { class: "stack" },
    el("div", { class: "row" }, input("Name", t, "name", { type: "text", width: "14em" }), input("Start date", t, "start", { type: "date" })),
    el("div", { class: "row" },
      input(`Entry ${unit}`, t, "entry", { placeholder: r?.levelAtStart != null ? r.levelAtStart.toFixed(3) : "", title: "Blank: the level at the start date" }),
      input(`Target ${unit}`, t, "target"), input(`Stop ${unit}`, t, "stop")),
    el("div", { class: "row" },
      input("Holding period (days)", t, "hold", { step: 1 }),
      input("Initial margin (bp of DV01)", t, "imBp", { step: 5, title: "Margin on futures and swaps, as a move in bp times the DV01" })),
    el("p", { class: "note" }, "Level = Σ weight × leg level (legs table). One leg: its yield %, ASW bp, futures price or swap rate %. "
      + "Several legs: all in bp (futures as the CTD yield they imply). A target above entry means the trade profits when the level rises.")));
}

function renderLegs(t) {
  const n = t.legs.length;
  if (!t.weights || t.weights.length !== n) t.weights = defaultWeights(n);
  const rows = t.legs.map((leg, i) => {
    const now = legNow(U, leg);
    const securities = () => {
      if (leg.type === "bond" || leg.type === "asw") {
        const list = [...U.bonds.values()].filter((b) => b.market === leg.market && (leg.type === "bond" || b.asw != null)).sort((a, b) => a.t - b.t);
        return select(leg, "id", list.map((b) => ({ v: b.id, label: `${b.name}  ${leg.type === "asw" ? `${fmt.n(b.asw, 1)}bp` : `${b.yield.toFixed(3)}%`}` })));
      }
      if (leg.type === "fut") return select(leg, "id", Object.values(U.futs).map((f) => ({ v: f.code, label: `${f.code} ${f.expiry} · ${f.price.toFixed(3)}` })));
      return el("span", { class: "row", style: { gap: "4px" } }, select(leg, "id", Object.keys(SWAP_INDEX).map((k) => ({ v: k, label: k }))),
        select(leg, "tenor", IRS_TENORS.map((y) => ({ v: y, label: `${y}Y` })), { numeric: true }));
    };
    const typeSel = select(leg, "type", TYPES.map((x) => ({ v: x.code, label: x.label })), {
      onchange: () => { t.legs[i] = defaultLeg(leg.type, leg.market ?? "DE"); },
    });
    const marketSel = leg.type === "bond" || leg.type === "asw"
      ? select(leg, "market", MARKETS.map((m) => ({ v: m.code, label: m.label })), { onchange: () => { leg.id = defaultBond(leg.market, 10, leg.type === "asw"); leg.repo = +repoAt(U.markets[leg.market].repo.points, 30 / 365).toFixed(3); } })
      : el("span", { class: "muted" }, "–");
    const qtyLabel = leg.qtyMode === "dv01" ? "DV01 in thousands (100 = 100k)" : leg.type === "fut" ? "lots" : "notional in millions (10 = 10mm)";
    const qtyScale = leg.qtyMode === "dv01" ? 1e3 : leg.type === "fut" ? 1 : 1e6;
    const cash = leg.type === "bond" || leg.type === "asw";
    const ccy = now?.ccy ?? "";
    return el("tr", {},
      el("td", { class: "l" }, i + 1), el("td", { class: "l" }, typeSel), el("td", { class: "l" }, marketSel), el("td", { class: "l" }, securities()),
      el("td", { class: "l" }, select(leg, "side", SIDES[leg.type], { numeric: true })),
      el("td", { class: "l" }, select(leg, "qtyMode", [{ v: "notional", label: leg.type === "fut" ? "Lots" : "Notional (mm)" }, { v: "dv01", label: "DV01 (k)" }])),
      el("td", { class: "edit" }, (() => { const q = input(null, leg, "qty", { step: leg.qtyMode === "dv01" ? 1 : leg.type === "fut" ? 10 : 1, title: qtyLabel, scale: qtyScale }); q.style.minWidth = "9em"; return q; })()),
      el("td", { class: "edit" }, leg.type === "bond" ? input(null, leg, "repo", { step: 0.01, title: "Repo rate %, act/360" })
        : leg.type === "asw" ? input(null, leg, "repoSpread", { step: 1, title: "Repo minus the swap's floating rate, bp (ASW carry = spread − this)" }) : "–"),
      el("td", { class: "edit" }, cash ? input(null, leg, "haircut", { step: 0.5, title: "Repo haircut %: the share of the bond's value funded with capital" }) : "–"),
      el("td", { class: "edit" }, input(null, t.weights, i, { step: 1, title: "Weight of this leg in the trade level" })),
      el("td", {}, now ? (leg.type === "fut" ? now.price.toFixed(3) : leg.type === "irs" ? `${now.level.toFixed(4)}%` : leg.type === "asw" ? `${fmt.n(now.level, 1)}bp` : `${now.price.toFixed(3)} / ${now.level.toFixed(3)}%`) : "–"),
      el("td", {}, now?.maturity ?? "–"),
      el("td", {}, now ? `${now.unitDv01.toFixed(leg.type === "bond" || leg.type === "asw" ? 4 : 1)} ${now.unitLabel}` : "–"),
      el("td", {}, now ? (leg.type === "fut" ? `${fmt.int(now.lots)} lots` : fmt.ccy(ccy, now.notional)) : "–"),
      el("td", { class: now?.dv01 >= 0 ? "pos" : "neg" }, now ? fmt.ccy(ccy, now.dv01) : "–"),
      el("td", {}, el("button", { class: "btn", title: "Remove leg", disabled: n === 1 ? true : null, onclick: () => { t.legs.splice(i, 1); t.weights = defaultWeights(t.legs.length); renderAll(); } }, "×")));
  });
  legsBox.replaceChildren(
    el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ["#", "Type", "Market", "Security", "Side", "Size by", "Quantity", "Repo % / spread", "Haircut %", "Level wt",
        "Price / level", "Maturity", "DV01", "Size", "Leg DV01 today", ""].map((h, i) => el("th", { class: i < 6 ? "l" : "" }, h)))),
      el("tbody", {}, rows))),
    el("div", { class: "row", style: { marginTop: "6px" } },
      n < MAX_LEGS ? el("button", { class: "btn", onclick: () => { t.legs.push(defaultLeg(t.legs[0]?.type === "irs" ? "irs" : "bond", t.legs[0]?.market ?? "DE")); t.weights = defaultWeights(t.legs.length); renderAll(); } }, "+ Add leg") : null,
      el("span", { class: "muted small" }, "Prices, DV01 and size are today's (DV01 sizing re-solved at the start date in the backtest). Leg DV01: gain for a 1bp fall in rates.")));
}

// ---------------------------------------------------------------- backtest

async function compute(t) {
  const my = ++token;
  tiles.replaceChildren(el("span", { class: "muted" }, "Computing…"));
  let r;
  try { r = await backtest(t); } catch (e) { console.error(e); r = { error: e.message }; }
  if (my !== token) return;
  if (r.error) { tiles.replaceChildren(el("span", { class: "down" }, r.error)); notes.replaceChildren(); return; }
  results.set(t.id, r);
  renderList();
  renderSetup(t);
  showResult(t, r);
  allTradesChart();
}

async function backtest(t) {
  let hs = await Promise.all(t.legs.map((leg) => legHistory(U, leg, t.start)));
  const empty = hs.findIndex((h) => !h.rows.length);
  if (empty >= 0) throw new Error(`Leg ${empty + 1}: ${hs[empty].note ?? "no history from the start date"}`);
  // The trade starts when every leg has a price: if one leg's history begins later, all legs are sized and
  // started on that date.
  const first = hs.map((h) => h.rows[0].date).sort().pop();
  const late = first > t.start ? hs.findIndex((h) => h.rows[0].date === first) : -1;
  if (hs.some((h) => h.rows[0].date < first)) hs = await Promise.all(t.legs.map((leg) => legHistory(U, leg, first)));
  const multi = t.legs.length > 1;
  // Several legs: everything in bp (yields, swap rates, ASW; futures as the CTD yield they imply).
  const conv = (leg, row) => (!multi ? row.level : leg.type === "fut" ? row.yieldLevel * 100 : leg.type === "asw" ? row.level : row.level * 100);
  const unit = multi ? "bp" : t.legs[0].type === "asw" ? "bp" : t.legs[0].type === "fut" ? "" : "%";
  // Common dates: every date any leg has from the common start; each leg forward-filled.
  const dates = [...new Set(hs.flatMap((h) => h.rows.map((r) => r.date)))].filter((d) => d >= first).sort();
  const ptr = hs.map(() => 0);
  const path = dates.map((d) => {
    let level = 0, pnl = 0, dv01 = 0;
    const legPnl = [];
    hs.forEach((h, i) => {
      while (ptr[i] + 1 < h.rows.length && h.rows[ptr[i] + 1].date <= d) ptr[i]++;
      const row = h.rows[ptr[i]];
      level += t.weights[i] * conv(t.legs[i], row);
      pnl += row.pnl; dv01 += row.dv01; legPnl.push(row.pnl);
    });
    return { date: d, level, pnl, dv01, legPnl };
  });
  // P&L relative to the common first date.
  const base = path[0];
  path.forEach((p) => { p.pnl -= base.pnl; p.legPnl = p.legPnl.map((x, i) => x - base.legPnl[i]); });

  // Capital: haircut on cash bonds, initial margin (imBp × |DV01|) on futures and swaps (and the ASW's swap).
  // Balance sheet: bond market value plus margin posted.
  let capital = 0, bs = 0, finPerDay = 0;
  const ccys = new Set();
  t.legs.forEach((leg, i) => {
    const h = hs[i], im = Math.abs(h.dv01) * t.imBp;
    ccys.add(legNow(U, leg)?.ccy);
    if (leg.type === "bond") { capital += Math.abs(h.mv0) * (leg.haircut ?? 0) / 100; bs += Math.abs(h.mv0); finPerDay += h.finPerDay ?? 0; }
    else if (leg.type === "asw") { capital += Math.abs(h.mv0) * (leg.haircut ?? 0) / 100 + im; bs += Math.abs(h.mv0) + im; }
    else { capital += im; bs += im; }
  });
  const levelAtStart = path[0].level;
  const entry = t.entry ?? levelAtStart;
  const dir = t.target != null ? Math.sign(t.target - entry) : t.stop != null ? Math.sign(entry - t.stop) : 0;
  const d0 = new Date(`${path[0].date}T00:00:00Z`);
  let exit = null;
  for (let k = 1; k < path.length; k++) {
    const p = path[k], days = (new Date(`${p.date}T00:00:00Z`) - d0) / 864e5;
    if (dir && t.target != null && (p.level - t.target) * dir >= 0) { exit = { k, why: "target hit" }; break; }
    if (dir && t.stop != null && (p.level - t.stop) * dir <= 0) { exit = { k, why: "stopped out" }; break; }
    if (t.hold && days >= t.hold) { exit = { k, why: "holding period ended" }; break; }
  }
  const end = exit ? path[exit.k] : path[path.length - 1];
  const days = Math.max(1, (new Date(`${end.date}T00:00:00Z`) - d0) / 864e5);
  // P&L per unit of level: one leg analytically; several legs by regression of P&L on level over the path.
  let slope = null;
  if (!multi) {
    const leg = t.legs[0], h = hs[0];
    slope = leg.type === "fut" ? (leg.side * h.notional * U.futs[leg.id].face) / 100 : -h.dv01 * (leg.type === "asw" ? 1 : 100);
  } else if (path.length >= 5) {
    const xs = path.map((p) => p.level), ys = path.map((p) => p.pnl);
    const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    if (sxx > 1e-12) slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx;
  }
  return {
    ccy: [...ccys].length === 1 ? [...ccys][0] : "", mixed: ccys.size > 1, unit, path, exit, end, days, levelAtStart, entry, dir, slope,
    status: exit ? exit.why : "open", pnl: end.pnl, capital, bs, roc: end.pnl / capital, robs: end.pnl / bs, rocAnn: (end.pnl / capital) * 365 / days,
    dv01: hs.reduce((a, h) => a + h.dv01, 0), gross: hs.reduce((a, h) => a + Math.abs(h.dv01), 0), finPerDay,
    notes: [late >= 0 ? (multi ? `Starts ${first}, the first date with a price for leg ${late + 1}; every leg is sized on that date.` : `History starts ${first}.`) : null,
      ...hs.map((h, i) => (h.note ? `Leg ${i + 1}: ${h.note}.` : null))].filter(Boolean), legs: hs,
  };
}

function showResult(t, r) {
  const c = r.ccy;
  const lv = (x) => (x == null ? "–" : `${x.toFixed(r.unit === "%" ? 3 : 2)}${r.unit}`);
  const est = (x) => (r.slope == null || x == null ? "–" : fmt.ccy(c, r.slope * (x - r.entry)));
  const rr = t.target != null && t.stop != null ? Math.abs(t.target - r.entry) / Math.abs(t.stop - r.entry) : null;
  tiles.replaceChildren(
    tileEl("Status", r.status, r.exit ? `on ${r.end.date}` : `as of ${r.end.date}`),
    tileEl("Cash P&L", fmt.ccy(c, r.pnl), `${Math.round(r.days)} days`, r.pnl >= 0 ? "up" : "down"),
    tileEl("Return on capital", fmt.pct(r.roc, 2), r.days >= 7 ? `${fmt.pct(r.rocAnn, 1)} annualised` : "annualised after 7 days"),
    tileEl("Return on balance sheet", fmt.pct(r.robs, 3), r.days >= 7 ? `${fmt.pct((r.robs * 365) / r.days, 2)} annualised` : ""),
    tileEl("DV01 used", fmt.ccy(c, r.dv01), `net · gross ${fmt.ccy(c, r.gross)}`),
    tileEl("Capital used", fmt.ccy(c, r.capital), "haircuts + initial margin"),
    tileEl("Balance sheet", fmt.ccy(c, r.bs), "bond value + margin"),
    tileEl("Financing / day", r.finPerDay ? fmt.ccy(c, -r.finPerDay) : "–", "repo on bond legs"),
    tileEl("Level", lv(r.end.level), `entry ${lv(r.entry)} · start ${lv(r.levelAtStart)}`),
    tileEl("At target / stop", `${est(t.target)} / ${est(t.stop)}`, rr ? `reward:risk ${rr.toFixed(2)}` : "est. from the trade's sensitivity"));
  notes.replaceChildren(...[
    r.mixed ? "Legs are in different currencies: P&L is summed without FX conversion." : null,
    ...r.notes,
    r.dir === 0 ? "Set a target or stop to define the trade's direction." : null,
    r.dir && r.slope != null && r.slope * r.dir < 0 ? "Warning: these legs lose money as the level moves towards the target. Check the sides, or the level weights' signs." : null,
  ].filter(Boolean).map((x) => el("p", {}, x)));

  const x = r.path.map((p) => p.date);
  const endMark = r.exit ? [{ type: "line", x0: r.end.date, x1: r.end.date, yref: "paper", y0: 0, y1: 1, line: { color: "#ff9e1b", dash: "dot" } }] : [];
  plot(charts.pnl, [
    ...t.legs.map((leg, i) => ({ x, y: r.path.map((p) => p.legPnl[i]), type: "scatter", mode: "lines", name: `Leg ${i + 1}`, line: { width: 1, color: COLORS[(i + 1) % COLORS.length] } })),
    { x, y: r.path.map((p) => p.pnl), type: "scatter", mode: "lines", name: "Trade", line: { width: 2.4, color: COLORS[0] } },
  ], { yaxis: { title: { text: c || "P&L" } }, shapes: endMark }, 320);
  const hline = (y, color, name) => (y == null ? null : { x: [x[0], x[x.length - 1]], y: [y, y], type: "scatter", mode: "lines", name, line: { color, dash: "dash", width: 1.2 } });
  plot(charts.level, [
    { x, y: r.path.map((p) => p.level), type: "scatter", mode: "lines", name: "Level", line: { color: COLORS[1], width: 2 } },
    hline(r.entry, "#bdbdbd", "Entry"), hline(t.target, COLORS[2], "Target"), hline(t.stop, COLORS[3], "Stop"),
  ].filter(Boolean), { yaxis: { title: { text: r.unit || "level" } }, shapes: endMark }, 320);
  plot(charts.ret, [
    { x, y: r.path.map((p) => (100 * p.pnl) / r.capital), type: "scatter", mode: "lines", name: "Return on capital %", line: { color: COLORS[0], width: 2 } },
    { x, y: r.path.map((p) => (100 * p.pnl) / r.bs), type: "scatter", mode: "lines", name: "Return on balance sheet %", yaxis: "y2", line: { color: COLORS[2], width: 2 } },
  ], { yaxis: { title: { text: "on capital %" } }, yaxis2: { overlaying: "y", side: "right", title: { text: "on balance sheet %" }, showgrid: false }, shapes: endMark }, 320);
}

function allTradesChart() {
  const traces = trades.map((t, i) => {
    const r = results.get(t.id);
    if (!r) return null;
    const d0 = new Date(`${r.path[0].date}T00:00:00Z`);
    const upto = r.exit ? r.exit.k + 1 : r.path.length;
    const pts = r.path.slice(0, upto);
    return { x: pts.map((p) => (new Date(`${p.date}T00:00:00Z`) - d0) / 864e5), y: pts.map((p) => (100 * p.pnl) / r.capital),
      type: "scatter", mode: "lines", name: t.name, line: { color: COLORS[i % COLORS.length], width: i === sel ? 2.6 : 1.3 } };
  }).filter(Boolean);
  plot(charts.all, traces, { xaxis: { title: { text: "days since start" } }, yaxis: { title: { text: "return on capital %" } } }, 320);
  // Results for the other trades are filled in the background so the table and this chart cover all of them.
  const missing = trades.find((t) => !results.has(t.id) && !pending.has(t.id));
  if (missing) {
    pending.add(missing.id);
    backtest(missing).then((r) => { results.set(missing.id, r); }).catch(() => { results.set(missing.id, null); })
      .finally(() => { pending.delete(missing.id); renderList(); allTradesChart(); });
  }
}

function tileEl(k, v, n, cls) {
  return el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: `v ${cls ?? ""}` }, v), el("div", { class: "n" }, n));
}

function methodNote() {
  return el("details", { class: "method panel" }, el("summary", {}, "Method and data"), el("ul", { class: "small" },
    el("li", {}, "Bonds: daily closing yields (UST from Feb 2026, Bunds from Jul 2026, OATs and BTPs two years), repriced at each date's settlement; "
      + "one-day spikes that fully reverse the next day (bad closes in the source) are skipped. "
      + "P&L = change in dirty value + coupons − repo on (1 − haircut) of the starting dirty value (a short receives it)."),
    el("li", {}, "ASW: −Δ spread × DV01 + carry at (spread − repo spread) on the notional. The ASW and swap-rate archives began on 5–6 Nov 2026 "
      + "and grow by a day each refresh, so ASW and IRS legs backtest only from then."),
    el("li", {}, "Futures: Eurex daily VWAP of EFP futures legs where available; otherwise, and for every UST contract, the CTD's price / CF with the basis "
      + "held at today's level. Front contract only (no roll)."),
    el("li", {}, "IRS: spot-starting swap; MTM = (fixed − par at the residual maturity) × annuity, from the archived par rates (1–30Y); the floating leg "
      + "accrues at today's fixing."),
    el("li", {}, "DV01 sizing uses each leg's DV01 at the start date. Capital = haircut × bond value + initial margin (IM bp × |DV01|) on futures, swaps and "
      + "the ASW swap. Balance sheet = bond value + margin posted. Exits: first close beyond the target or stop, or the end of the holding period."),
    el("li", {}, "P&L at target / stop: one leg from its sensitivity; several legs from the regression of P&L on the trade level along the path.")));
}
