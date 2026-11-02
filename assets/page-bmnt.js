import { $, COLORS, MARKETS, dataTable, el, fmt, frame, hashParam, heat, loadJSON, plot, segmented, setHash, showError, signClass } from "./common.js";
import { nsEval, parseDate, pricer, repoAt, yearsBetween } from "./bond.js";
import { curveEditor } from "./curve-editor.js";
import { FUTURES_BY_MARKET, contractSummary, hedgeWeights } from "./futures.js";

frame("BMNT");
const app = $("#app");
const HORIZON = 0.25; // years
const HAIRCUT = { UST: 2, DE: 2, FR: 3, IT: 5 };

try {
  const [futures, ...list] = await Promise.all([loadJSON("data/futures.json"), ...MARKETS.map((m) => loadJSON(`data/markets/${m.code}.json`))]);
  start(futures.contracts, Object.fromEntries(MARKETS.map((m, i) => [m.code, list[i]])));
} catch (err) {
  showError(app, err);
}

function start(contracts, markets) {
  const codes = MARKETS.map((m) => m.code);
  let mcode = hashParam("m", "DE", codes);
  const state = {};  // market -> {repo points, haircut, overrides: id -> {gc, special}, group, search}
  const stateFor = (m) => (state[m] ??= {
    repo: markets[m].repo.points.map((p) => ({ ...p })), haircut: HAIRCUT[m], overrides: {}, group: "All", search: "", short: false,
  });

  const marketTabs = el("div");
  const newsHost = el("div");
  const chart = el("div", { class: "plot" });
  const repoHost = el("div");
  const repoNote = el("p", { class: "note" });
  const hedgeHost = el("div");
  const controls = el("div", { class: "row" });
  const tableHost = el("div");
  const tableNote = el("p", { class: "note" });
  app.append(
    el("div", { class: "page-title" }, el("h1", {}, "Bond Monitor"), el("span", { class: "muted" }, "nominal government bonds: carry, roll down, repo and futures-hedged returns over 3 months")),
    el("div", { style: { marginBottom: "8px" } }, marketTabs),
    newsHost,
    el("div", { class: "grid cols-2", style: { marginTop: "10px" } },
      el("section", { class: "panel" }, el("h2", {}, "Yields and fitted curve by issue type"), chart),
      el("section", { class: "panel" },
        el("div", { class: "row", style: { justifyContent: "space-between" } }, el("h2", {}, "Repo curve (GC)"),
          el("button", { class: "btn", onclick: () => { stateFor(mcode).repo = markets[mcode].repo.points.map((p) => ({ ...p })); renderRepo(); recompute(); } }, "Reset")),
        repoHost, repoNote)),
    el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "Hedge futures (front contracts)"), hedgeHost),
    el("section", { class: "panel", style: { marginTop: "10px" } }, controls, tableHost, tableNote),
    methodNote());

  const repoEditor = curveEditor({
    width: 720, height: 260, xTitle: "Term", yTitle: "Rate (%)", yDigits: 3, step: 0.005,
    xTicks: [0, 0.25, 0.5, 0.75, 1],
    onChange: (pts, i) => { stateFor(mcode).repo[i].rate = pts[i].y; recompute(); },
  });
  repoHost.append(repoEditor.node);
  function renderRepo() {
    repoEditor.update(stateFor(mcode).repo.map((p) => ({ x: p.t, y: p.rate, label: p.label })), []);
    repoNote.textContent = markets[mcode].repo.source + " Drag points to change the GC curve; the 3M point sets the GC rate column (each row can be overwritten).";
  }

  // ---- news banner
  function renderNews() {
    const items = markets[mcode].news ?? [];
    if (!items.length) { newsHost.replaceChildren(el("div", { class: "news" }, el("span", { class: "lead" }, "NEWS"), el("span", { class: "top muted" }, "No recent headlines."))); return; }
    const [first, ...rest] = items;
    const link = (n) => el("a", { href: n.link, target: "_blank", rel: "noopener" }, n.title);
    const track = el("div", { class: "track" }, ...[...rest, ...rest].map((n) => el("span", {}, link(n), el("span", { class: "src" }, `${n.source} ${n.date.slice(5)}`), "  ")));
    newsHost.replaceChildren(
      el("div", { class: "news" }, el("span", { class: "lead" }, "TOP NEWS"),
        el("span", { class: "top" }, link(first), el("span", { class: "src" }, `${first.source} · ${first.date} UTC`))),
      rest.length ? el("div", { class: "ticker", "aria-label": "More headlines" }, track) : "");
  }

  // ---- calculations
  function compute() {
    const market = markets[mcode];
    const st = stateFor(mcode);
    const settle = parseDate(market.settle);
    const gc3m = repoAt(st.repo, HORIZON);
    const curveFor = (g) => market.groups[g]?.fit ?? market.curve;
    const shortest = Math.min(...market.bonds.map((b) => yearsBetween(settle, parseDate(b.maturity))));
    const rows = market.bonds.map((b) => {
      const t = yearsBetween(settle, parseDate(b.maturity));
      const fit = curveFor(b.group);
      const roll = (nsEval(fit, t) - nsEval(fit, Math.max(t - HORIZON, 0.01))) * 100;
      // Rolling below the shortest bond the curve was fitted to is an extrapolation.
      const extrap = t - HORIZON < (market.groups[b.group]?.tmin ?? shortest) - 0.05;
      const o = st.overrides[b.id] ?? {};
      const gc = o.gc ?? gc3m;
      const special = o.special ?? 0;
      const repo = gc + special / 100;
      const accrued = pricer(b.coupon, parseDate(b.maturity), settle, market.freq).accrued;
      return { ...b, t, roll, extrap, gc, special, repo, carry: ((b.yield - repo) / 4) * 100, dirty: b.price + accrued, fitted: nsEval(fit, t) };
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const repoMarket = { ...market, repo: { ...market.repo, points: st.repo } };
    const legs = FUTURES_BY_MARKET[mcode].map((code) => {
      const s = contractSummary(code, contracts[code], repoMarket);
      if (!s) return null;
      const row = byId.get(s.ctd.id);
      return row ? { ...s, t: row.t, row } : null;
    }).filter(Boolean).sort((a, b) => a.t - b.t);
    for (const r of rows) {
      r.w = hedgeWeights(r.t, legs);
      let c = r.carry, rd = r.roll, nb = 0;
      for (const leg of legs) {
        const w = r.w[leg.code];
        if (!w) continue;
        c -= w * leg.row.carry;
        rd -= w * leg.row.roll;
        nb += w * (r.dv01 / leg.ctd.dv01) * leg.netBasis;
      }
      r.carryH = c;
      r.rollH = rd;
      r.nb = nb * 100;                                          // cents per 100 nominal
      r.rob = (((c + rd) * r.dv01 - nb) / r.dirty) * 100;       // % of the bond's dirty price
      r.roc = r.rob / (st.haircut / 100);
    }
    return { rows, legs, gc3m };
  }

  // ---- render
  let table = null;
  function recompute() {
    const market = markets[mcode];
    const st = stateFor(mcode);
    const { rows, legs, gc3m } = compute();
    renderHedge(legs);
    renderChart(rows, legs);
    const q = st.search.toLowerCase();
    const shown = rows.filter((r) => (st.short || r.t >= 0.5) && (st.group === "All" || r.group === st.group)
      && (!q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)));
    const scale = (key) => {
      const v = rows.map((r) => Math.abs(r[key])).filter(isFinite).sort((a, b) => a - b);
      return v[Math.floor(v.length * 0.9)] || 1;
    };
    const sc = Object.fromEntries(["carry", "roll", "carryH", "rollH", "rob", "roc"].map((k) => [k, scale(k)]));
    const num = (key, label, unit, d, title, colour = true) => ({
      key, label, unit, title, fmt: (r) => fmt.n(r[key], d), value: (r) => r[key],
      cls: colour ? (r) => signClass(r[key], 0.5 * 10 ** -d) : null, bg: colour ? (r) => heat(r[key], sc[key]) : null,
    });
    const columns = [
      { key: "name", label: "Bond", fmt: (r) => `${legs.some((l) => l.ctd.id === r.id) ? "◆ " : ""}${r.name}`, value: (r) => r.t, left: true,
        tip: (r) => `${r.name}  coupon ${r.coupon}%  maturity ${r.maturity}  price ${r.price.toFixed(3)}  beta ${r.beta}` },
      { key: "group", label: "Type", fmt: (r) => r.group, left: true },
      { key: "yield", label: "Yield", unit: "%", fmt: (r) => r.yield.toFixed(3), value: (r) => r.yield },
      { key: "t", label: "Tenor", unit: "y", fmt: (r) => r.t.toFixed(2), value: (r) => r.t },
      { key: "isin", label: "ISIN", fmt: (r) => r.id, left: true },
      { key: "vol", label: "Vol 3m", unit: "bp", fmt: (r) => (r.vol == null ? "–" : r.vol.toFixed(0)), value: (r) => r.vol,
        title: "Realised volatility of daily yield changes over the last 3 months, annualised (bp per year)" },
      num("carry", "Carry 3m", "bp", 1, "(yield − repo) / 4"),
      { ...num("roll", "Roll 3m", "bp", 1, "Fall in yield along the issue type's fitted curve as maturity shortens by 3 months"),
        cls: (r) => (r.extrap ? "extrap" : signClass(r.roll, 0.05)),
        tip: (r) => (r.extrap ? "Extrapolated: the curve is rolled below the shortest bond of this type" : null) },
      { key: "gc", label: "GC", unit: "%", edit: { get: (r) => r.gc.toFixed(3), set: (r, v) => override(r.id, { gc: v === "" ? undefined : +v }), changed: (r) => st.overrides[r.id]?.gc != null } },
      { key: "special", label: "Special", unit: "bp", edit: { get: (r) => r.special, set: (r, v) => override(r.id, { special: +v || 0 }), changed: (r) => !!st.overrides[r.id]?.special } },
      { key: "repo", label: "Repo", unit: "%", fmt: (r) => r.repo.toFixed(3), value: (r) => r.repo },
      ...legs.map((l) => ({ key: `w_${l.code}`, label: l.code, unit: "%", value: (r) => r.w[l.code], fmt: (r) => (r.w[l.code] ? (100 * r.w[l.code]).toFixed(0) : "·"),
        title: `${l.code} weight (share of the bond's DV01 hedged with ${l.code}, CTD ${l.ctd.name})` })),
      num("carryH", "Carry hedged", "bp", 1, "Carry minus weighted carry of the hedge CTDs"),
      num("rollH", "Roll hedged", "bp", 1, "Roll minus weighted roll of the hedge CTDs"),
      { key: "nb", label: "Hedge net basis", unit: "ct", fmt: (r) => fmt.n(r.nb, 1), value: (r) => r.nb,
        title: "Net basis of the hedge CTDs, risk-weighted to the bond (cents per 100 nominal). Paid away by a short futures hedge." },
      num("rob", "Return on book", "%", 3, "(hedged carry + roll) × DV01 − hedge net basis, as % of the bond's dirty price, over 3 months"),
      num("roc", "Return on capital", "%", 2, `Return on book / repo haircut (${st.haircut}%), over 3 months`),
    ];
    const groupsHead = [{ span: 11, label: "" }, { span: legs.length, label: "Futures hedge weight" }, { span: 5, label: "After hedge, 3 months" }];
    table = dataTable(columns, { sortKey: "t", sortAsc: true, groups: groupsHead, rowClass: (r) => (legs.some((l) => l.ctd.id === r.id) ? "hl" : null) });
    table.node.classList.add("sticky-first");
    table.update(shown);
    tableHost.replaceChildren(table.node);

    count.textContent = `${shown.length} of ${rows.length} bonds · prices as of ${market.asOf} · GC 3M ${gc3m.toFixed(3)}%`;
    tableNote.textContent = "◆ = CTD of a front futures contract. Click a header to sort. GC and special are editable per bond (special: negative when the bond trades special in repo). " +
      "Carry, roll and returns are over 3 months; returns are not annualised.";
  }

  const count = el("span", { class: "muted" });
  function renderControls() {
    const st = stateFor(mcode);
    const haircut = el("input", { type: "number", step: "0.5", min: "0.5", value: st.haircut, "aria-label": "Repo haircut" });
    haircut.addEventListener("change", () => { st.haircut = Math.max(+haircut.value || HAIRCUT[mcode], 0.1); recompute(); });
    const groups = ["All", ...new Set(markets[mcode].bonds.map((b) => b.group))];
    const groupSel = el("select", { "aria-label": "Issue type" }, groups.map((g) => el("option", { value: g, selected: g === st.group }, g)));
    groupSel.addEventListener("change", () => { st.group = groupSel.value; recompute(); });
    const search = el("input", { type: "search", placeholder: "bond or ISIN", value: st.search, "aria-label": "Search bonds" });
    search.addEventListener("input", () => { st.search = search.value; recompute(); });
    const short = el("input", { type: "checkbox", checked: st.short });
    short.addEventListener("change", () => { st.short = short.checked; recompute(); });
    controls.replaceChildren(el("label", {}, "Haircut % ", haircut), el("label", {}, "Type ", groupSel), el("label", {}, "Find ", search),
      el("label", { title: "Bonds with less than 6 months to maturity behave like bills; hidden by default" }, short, " Include < 6M"), count);
  }

  function override(id, patch) {
    const st = stateFor(mcode);
    st.overrides[id] = { ...st.overrides[id], ...patch };
    recompute();
  }

  function renderHedge(legs) {
    const market = markets[mcode];
    hedgeHost.replaceChildren(el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Contract", "Expiry", "CTD", "CTD tenor", "Futures", "Source", "Net basis (ct)", "Fair net basis (ct)", "CTD prob", "DV01 / contract"]
        .map((h, i) => el("th", { class: i < 3 ? "l" : "" }, h)))),
      el("tbody", {}, legs.map((l) => el("tr", {},
        el("td", { class: "l" }, `${l.code} ${l.contract.name}`), el("td", { class: "l" }, l.contract.expiry), el("td", { class: "l" }, l.ctd.name),
        el("td", {}, l.t.toFixed(2)), el("td", {}, l.futures.toFixed(3)),
        el("td", {}, l.futuresSource === "market" ? `EFP VWAP ${market.asOf}` : "model fair value"),
        el("td", {}, fmt.n(l.netBasis * 100, 1)), el("td", {}, fmt.n(l.fairNetBasis * 100, 1)),
        el("td", {}, fmt.pct(l.prob, 0)), el("td", {}, fmt.n(l.dv01, 0))))))),
    el("p", { class: "note" }, mcode === "UST"
      ? "No free Treasury futures prices, so UST net basis is the model's fair value (the delivery option); see the CTD page."
      : `Market net basis uses the daily VWAP of the futures leg of EFP trades on ${market.asOf}; contracts without EFPs that day use the model's fair value.`));
  }

  function renderChart(rows, legs) {
    const market = markets[mcode];
    const groups = [...new Set(rows.map((r) => r.group))];
    const traces = [];
    groups.forEach((g, k) => {
      const color = COLORS[k % COLORS.length];
      const rs = rows.filter((r) => r.group === g);
      traces.push({ type: "scatter", mode: "markers", name: g, x: rs.map((r) => r.t), y: rs.map((r) => r.yield), marker: { color, size: 6, line: { width: 0 } },
        text: rs.map((r) => `${r.name}<br>${r.id}<br>yield ${r.yield.toFixed(3)}% · vs curve ${fmt.s((r.yield - r.fitted) * 100, 1)}bp<br>roll 3m ${fmt.s(r.roll, 1)}bp`),
        hovertemplate: "%{text}<extra></extra>" });
      const fit = market.groups[g];
      if (fit) {
        const xs = Array.from({ length: 80 }, (_, i) => Math.max(fit.tmin, 0.1) + ((fit.tmax - Math.max(fit.tmin, 0.1)) * i) / 79);
        traces.push({ type: "scatter", mode: "lines", name: `${g} curve`, x: xs, y: xs.map((x) => nsEval(fit.fit, x)), line: { color, width: 1.5 }, hoverinfo: "skip", showlegend: false });
      }
    });
    traces.push({ type: "scatter", mode: "markers+text", name: "Futures CTD", x: legs.map((l) => l.t), y: legs.map((l) => l.row.yield),
      text: legs.map((l) => l.code), textposition: "top center", textfont: { color: "#ffd24d", size: 11 },
      marker: { symbol: "diamond-open", size: 12, color: "#ffd24d", line: { width: 2 } }, hovertemplate: "%{text} CTD<extra></extra>" });
    plot(chart, traces, { xaxis: { title: { text: "Years to maturity" } }, yaxis: { title: { text: "Yield (%)" } }, legend: { y: -0.22 } }, 330);
  }

  function selectMarket(m) {
    mcode = m;
    setHash({ m });
    renderNews();
    renderRepo();
    renderControls();
    recompute();
  }
  marketTabs.append(segmented(MARKETS, mcode, selectMarket));
  selectMarket(mcode);
}

function methodNote() {
  return el("details", { class: "method panel" }, el("summary", {}, "Method and data"),
    el("ul", { class: "small" },
      el("li", {}, "Universe: nominal fixed-coupon government bonds (no inflation-linked, floating, strips or retail issues); bills excluded. UST: TreasuryDirect end-of-day prices; Bunds: Bundesbank; OATs and BTPs: Borsa Italiana closing prices. Lines more than 40bp off the fitted curve or not quoted in the past week are left out."),
      el("li", {}, "Realised 3m vol: standard deviation of daily yield changes over the last 63 trading days, annualised (× √252), in bp. Daily changes beyond 4 robust standard deviations are clipped so a stale or off-market close does not dominate an illiquid line."),
      el("li", {}, "Carry 3m = (yield − repo) / 4, in bp. Repo = GC + special premium; GC is the 3-month point of the repo curve, a proxy built from SOFR and Treasury bills (US) or €STR and the ECB AAA government curve (euro), editable."),
      el("li", {}, "Roll 3m: a Nelson-Siegel curve is fitted separately to each issue type (e.g. 2y, 5y, 10y, 30y Treasuries; Schatz, Bobl, Bund, green Bunds; BTP; OAT). Assuming that curve is unchanged in 3 months, roll = curve(T) − curve(T − 0.25), in bp; positive means the yield falls."),
      el("li", {}, "Hedge: UST, Bund and BTP use a fly hedge across the two futures whose CTDs bracket the bond's maturity, split linearly by maturity; bonds beyond the shortest or longest CTD, and the CTDs themselves, use the nearest contract alone. OATs use the OAT future alone. Weights are shares of the bond's DV01."),
      el("li", {}, "Hedged carry and roll = bond − Σ weight × CTD (bp, so DV01-neutral). Hedge net basis = Σ weight × (bond DV01 / CTD DV01) × CTD net basis, in cents per 100 nominal of the bond: a short futures position pays away the net basis (the value of the delivery option) as delivery approaches. The front contract may deliver before the 3-month horizon."),
      el("li", {}, "Return on book = [(hedged carry + roll) × DV01 − hedge net basis] / dirty price. Return on capital = return on book / haircut. Both over 3 months, not annualised.")));
}
