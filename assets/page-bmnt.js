import { $, COLORS, MARKETS, dataTable, el, fmt, frame, hashParam, heat, loadJSON, plot, segmented, setHash, showError, signClass } from "./common.js";
import { nsEval, parseDate, pricer, repoAt, yearsBetween } from "./bond.js";
import { curveEditor } from "./curve-editor.js";
import { FUTURES_BY_MARKET, contractSummary, hedgeWeights } from "./futures.js";

frame("BMNT");
const app = $("#app");
const HORIZON = 0.25; // years
const HAIRCUT = { UST: 2, DE: 2, FR: 3, IT: 5 };
// Contract whose delivery sets the boxing window on the repo curve.
const MAIN = { UST: "TY", DE: "RX", FR: "OAT", IT: "IK" };
const REPO_TICKS = [0, 1, 2, 3, 4, 5, 6].map((m) => ({ x: m / 12, label: m ? `${m}M` : "0" }));

try {
  const [futures, auctions, ...list] = await Promise.all([loadJSON("data/futures.json"), loadJSON("data/auctions.json").catch(() => null),
    ...MARKETS.map((m) => loadJSON(`data/markets/${m.code}.json`))]);
  start(futures.contracts, auctions, Object.fromEntries(MARKETS.map((m, i) => [m.code, list[i]])));
} catch (err) {
  showError(app, err);
}

function start(contracts, auctions, markets) {
  const codes = MARKETS.map((m) => m.code);
  let mcode = hashParam("m", "DE", codes);
  // market -> {repo pillars, boxing / delivery rates (null = interpolated), haircut, overrides: id -> {gc, special},
  //            table filters, carry / roll chart mode}
  const state = {};
  const stateFor = (m) => (state[m] ??= {
    repo: markets[m].repo.points.map((p) => ({ ...p })), box: null, dlv: null, haircut: HAIRCUT[m], overrides: {},
    group: "All", search: "", short: false, crMode: "outright",
  });

  const marketTabs = el("div");
  const chart = el("div", { class: "plot" });
  const repoHost = el("div");
  const boxHost = el("div", { class: "row small", style: { marginTop: "6px" } });
  const repoNote = el("p", { class: "note" });
  const auctionHost = el("div");
  const hedgeHost = el("div");
  const crModeHost = el("div");
  const crChart = el("div", { class: "plot" });
  const crNote = el("p", { class: "note" });
  const controls = el("div", { class: "row" });
  const tableHost = el("div");
  const tableNote = el("p", { class: "note" });
  app.append(
    el("div", { class: "page-title" }, el("h1", {}, "Bond Monitor"), el("span", { class: "muted" }, "nominal government bonds: carry, roll down, repo and futures-hedged returns over 3 months")),
    el("div", { style: { marginBottom: "8px" } }, marketTabs),
    el("div", { class: "grid cols-2" },
      el("section", { class: "panel" }, el("h2", {}, "Yields and fitted curve by issue type"), chart),
      el("section", { class: "panel" },
        el("div", { class: "row", style: { justifyContent: "space-between" } }, el("h2", {}, "Repo curve (GC) to 6 months"),
          el("button", { class: "btn", onclick: () => {
            const st = stateFor(mcode);
            st.repo = markets[mcode].repo.points.map((p) => ({ ...p }));
            st.box = st.dlv = null;
            recompute();
          } }, "Reset")),
        repoHost, boxHost, repoNote)),
    el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "Auctions and syndications: recent and upcoming"), auctionHost),
    el("section", { class: "panel", style: { marginTop: "10px" } }, el("h2", {}, "Hedge futures (front contracts)"), hedgeHost),
    el("section", { class: "panel", style: { marginTop: "10px" } },
      el("div", { class: "row", style: { justifyContent: "space-between" } }, el("h2", {}, "Carry and roll down by maturity, 3 months"), crModeHost),
      crChart, crNote),
    el("section", { class: "panel", style: { marginTop: "10px" } }, controls, tableHost, tableNote),
    methodNote());

  // ---- repo curve with boxing and delivery points
  // The curve runs from S/N (O/N for UST) flat to the boxing date (5 business days before the main contract's
  // delivery), then to the delivery date and on to the pillars beyond it. Boxing and delivery are points of their own:
  // by default boxing sits on the flat S/N rate and delivery is interpolated towards the next pillar; both can be
  // dragged. The boxing premium is the forward rate between boxing and delivery minus that default forward, so
  // typing a premium moves the boxing rate (with delivery held).
  const repoEditor = curveEditor({
    width: 720, height: 260, xTitle: "Term", yTitle: "Rate (%)", yDigits: 3, step: 0.005, xTicks: REPO_TICKS,
    onChange: (pts, i) => {
      const st = stateFor(mcode);
      const p = repoCurve().points.filter((q) => q.t <= 0.5 + 1e-9)[i];
      if (p.kind === "box") st.box = pts[i].y;
      else if (p.kind === "dlv") st.dlv = pts[i].y;
      else if (p.kind === "first") st.repo[0].rate = pts[i].y;
      else p.rate = pts[i].y;  // a pillar of st.repo beyond delivery
      recompute({ dragging: true });
    },
  });
  repoHost.append(repoEditor.node);

  function repoCurve() {
    const market = markets[mcode];
    const st = stateFor(mcode);
    const contract = contracts[MAIN[mcode]];
    const settle = parseDate(market.settle);
    const delivery = parseDate(contract.delivery);
    let box = delivery;
    for (let n = 0; n < 5;) {
      box = new Date(box - 864e5);
      if (box.getUTCDay() % 6) n++;
    }
    const [first, ...rest] = st.repo;
    const tD = Math.max(yearsBetween(settle, delivery), first.t + 2 / 365);
    const tB = Math.min(Math.max(yearsBetween(settle, box), first.t + 1 / 365), tD - 1 / 365);
    const after = rest.filter((p) => p.t > tD + 1e-9);
    const rB0 = first.rate;
    const next = after[0] ?? { t: tD + 1, rate: rB0 };
    const rD0 = rB0 + ((next.rate - rB0) * (tD - tB)) / (next.t - tB);
    const rB = st.box ?? rB0;
    const rD = st.dlv ?? rD0;
    const fwd = (b, d) => (d * tD - b * tB) / (tD - tB);
    return {
      code: MAIN[mcode], box, delivery, tB, tD, rB, rD, fwd: fwd(rB, rD), fwd0: fwd(rB0, rD0),
      premium: (fwd(rB, rD) - fwd(rB0, rD0)) * 100,
      points: [{ ...first, label: mcode === "UST" ? "O/N" : "S/N", kind: "first" }, { t: tB, rate: rB, label: "Box", kind: "box" },
        { t: tD, rate: rD, label: "Dlv", kind: "dlv" }, ...after],
    };
  }

  function renderRepo(bx, dragging = false) {
    const st = stateFor(mcode);
    const day = (d) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
    const anchor = { box: "end", dlv: "start" };
    repoEditor.update(bx.points.filter((p) => p.t <= 0.5 + 1e-9).map((p) => ({ x: p.t, y: p.rate, label: p.label, anchor: anchor[p.kind] })), [], {
      keepRange: dragging,
      extra: {
        lines: [{ x: bx.tB, label: `Box ${day(bx.box)}` }, { x: bx.tD, label: `Dlv ${day(bx.delivery)}` }],
        segments: [{ x0: bx.tB, x1: bx.tD, y: bx.fwd }],
      },
    });
    if (dragging) {
      if (premiumInput) premiumInput.value = bx.premium.toFixed(1);
      return;
    }
    premiumInput = el("input", { type: "number", step: "1", value: bx.premium.toFixed(1), "aria-label": "Boxing premium in bp" });
    premiumInput.addEventListener("change", () => {
      // Hold delivery, solve the boxing rate for the requested forward between boxing and delivery.
      const target = bx.fwd0 + (+premiumInput.value || 0) / 100;
      st.box = (bx.rD * bx.tD - target * (bx.tD - bx.tB)) / bx.tB;
      recompute();
    });
    boxHost.replaceChildren(
      el("label", {}, "Boxing premium (bp) ", premiumInput),
      el("span", {}, `${bx.code}: repo to boxing (${day(bx.box)}) ${bx.rB.toFixed(3)}%, to delivery (${day(bx.delivery)}) `,
        el("b", { class: "amber" }, `${bx.rD.toFixed(3)}%`),
        `; forward boxing → delivery ${bx.fwd.toFixed(3)}% (red) vs ${bx.fwd0.toFixed(3)}% unboxed.`));
    repoNote.textContent = `${markets[mcode].repo.source}${mcode === "UST" ? "" : " €STR stands in for S/N."} Drag any point; ` +
      "the curve is flat from the first point to the boxing date. The boxing premium is the extra forward rate priced between " +
      "boxing and delivery; changing it moves the boxing rate. The delivery rate is the term repo for the hedge futures' net basis; " +
      "the 3M point sets the GC column (each row can be overwritten).";
  }
  let premiumInput = null;

  // ---- auctions and syndications
  function renderAuctions() {
    const info = auctions?.markets?.[mcode];
    if (!info) { auctionHost.replaceChildren(el("p", { class: "muted" }, "Auction data unavailable.")); return; }
    const deals = [...info.deals].sort((a, b) => (a.status === b.status ? a.date.localeCompare(b.date) : a.status === "upcoming" ? -1 : 1));
    auctionHost.replaceChildren(
      deals.length ? el("div", { class: "table-wrap", style: { maxHeight: "300px" } }, el("table", {},
        el("thead", {}, el("tr", {}, ["Date", "Status", "Type", "Bond", "ISIN", "Maturity", "Coupon", "Size", "Result", "Source"]
          .map((h, i) => el("th", { class: i < 5 || i === 9 ? "l" : "" }, h)))),
        el("tbody", {}, deals.map((d) => el("tr", { class: d.status === "upcoming" ? "upcoming" : "" },
          el("td", { class: "l" }, d.date), el("td", { class: `l ${d.status === "upcoming" ? "pos" : "muted"}` }, d.status),
          el("td", { class: "l" }, d.kind), el("td", { class: "l" }, d.name + (d.reopening ? " (reopening)" : d.reopening === false ? " (new)" : "")),
          el("td", { class: "l" }, d.id ?? "–"), el("td", {}, d.maturity ?? "–"), el("td", {}, d.coupon == null ? "–" : `${d.coupon}%`),
          el("td", {}, d.size ?? "–"), el("td", {}, d.result ?? "–"),
          el("td", { class: "l" }, d.link ? el("a", { href: d.link, target: "_blank", rel: "noopener" }, "official ↗") : "–")))))) :
        el("p", { class: "muted" }, "No auctions or syndications in the window."),
      el("p", { class: "note" }, `Source: ${info.source} (`, info.calendar ? el("a", { href: info.calendar, target: "_blank", rel: "noopener" }, "calendar") : "–",
        `). Last 3 weeks and next 6 weeks; sizes as announced (planned volume or offered range). Starred on the yield chart.`));
  }

  // ---- calculations
  function compute() {
    const market = markets[mcode];
    const st = stateFor(mcode);
    const settle = parseDate(market.settle);
    const bx = repoCurve();
    const gc3m = repoAt(bx.points, HORIZON);
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
    // Each contract's CTD is financed at the curve's term repo to its delivery (the delivery point for the main contract).
    const repoMarket = { ...market, repo: { ...market.repo, points: bx.points } };
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
      r.nbBp = -nb / r.dv01;                                    // the same cost as a yield move of the bond, bp
      r.rob = (((c + rd) * r.dv01 - nb) / r.dirty) * 100;       // % of the bond's dirty price
      r.roc = r.rob / (st.haircut / 100);
    }
    return { rows, legs, gc3m, bx };
  }

  // ---- render
  let table = null;
  function recompute({ dragging = false } = {}) {
    const market = markets[mcode];
    const st = stateFor(mcode);
    const { rows, legs, gc3m, bx } = compute();
    renderRepo(bx, dragging);
    renderHedge(legs);
    renderChart(rows, legs);
    const q = st.search.toLowerCase();
    const shown = rows.filter((r) => (st.short || r.t >= 0.5) && (st.group === "All" || r.group === st.group)
      && (!q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)));
    renderCarryRoll(shown, legs);
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
      { key: "name", label: "Bond", fmt: (r) => {
        const ctdOf = legs.filter((l) => l.ctd.id === r.id).map((l) => l.code);
        return ctdOf.length ? `◆ ${r.name}  ${ctdOf.join("/")} CTD` : r.name;
      }, value: (r) => r.t, left: true,
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
    table = dataTable(columns, { sortKey: "t", sortAsc: true, groups: groupsHead, rowClass: (r) => (legs.some((l) => l.ctd.id === r.id) ? "ctd" : null) });
    table.node.classList.add("sticky-first");
    table.update(shown);
    tableHost.replaceChildren(table.node);

    count.textContent = `${shown.length} of ${rows.length} bonds · prices as of ${market.asOf} · GC 3M ${gc3m.toFixed(3)}%`;
    tableNote.textContent = "Highlighted ◆ rows are the CTDs of the front futures contracts. Click a header to sort. GC and special are editable per bond (special: negative when the bond trades special in repo). " +
      "Carry, roll and returns are over 3 months; returns are not annualised.";
  }

  // Stacked bars per bond at its maturity: outright carry and roll, or after the futures hedge with the net basis
  // paid away expressed in bp of the bond's yield. White dots mark the total.
  function renderCarryRoll(rows, legs) {
    const st = stateFor(mcode);
    const hedged = st.crMode === "hedged";
    const parts = hedged
      ? [["carryH", "Carry after hedge", "#ff9e1b"], ["rollH", "Roll after hedge", "#5fa8ff"], ["nbBp", "Net basis", "#ff5c5c"]]
      : [["carry", "Carry", "#ff9e1b"], ["roll", "Roll down", "#5fa8ff"]];
    const ts = rows.map((r) => r.t);
    const width = Math.max(0.04, Math.min(0.25, (Math.max(...ts) - Math.min(...ts)) / Math.max(rows.length, 1) * 0.7));
    // Bonds sharing a maturity (e.g. a green bond and its twin) sit side by side rather than stacked on each other.
    const seen = new Map();
    const xs = ts.map((t) => {
      const key = t.toFixed(2);
      const k = seen.get(key) ?? 0;
      seen.set(key, k + 1);
      return t + k * width * 1.1;
    });
    const names = rows.map((r) => r.name + (legs.some((l) => l.ctd.id === r.id) ? " ◆" : ""));
    const total = rows.map((r) => parts.reduce((s, [k]) => s + (isFinite(r[k]) ? r[k] : 0), 0));
    plot(crChart, [
      ...parts.map(([k, label, color]) => ({
        type: "bar", name: label, x: xs, y: rows.map((r) => r[k]), width, marker: { color },
        customdata: names, hovertemplate: `%{customdata}<br>${label} %{y:+.1f}bp<extra></extra>`,
      })),
      { type: "scatter", mode: "markers", name: "Total", x: xs, y: total, customdata: names,
        marker: { color: "#ffffff", size: 4 }, hovertemplate: "%{customdata}<br>Total %{y:+.1f}bp<extra></extra>" },
    ], {
      barmode: "relative", hovermode: "closest",
      xaxis: { title: { text: "Years to maturity" } }, yaxis: { title: { text: "bp over 3 months" }, zeroline: true },
    }, 340);
    crNote.textContent = hedged
      ? "After a DV01-neutral futures hedge (weights as in the table): carry and roll minus the hedge CTDs', and the hedge net basis " +
        "turned into bp of the bond's yield (net basis cost / bond DV01; negative = cost). Positive = gain."
      : "Outright: carry = (yield − repo) / 4; roll down along the issue type's fitted curve. Positive = gain. Same bonds as the table below (its filters apply).";
  }

  const count = el("span", { class: "muted" });
  function renderControls() {
    const st = stateFor(mcode);
    crModeHost.replaceChildren(segmented([{ code: "outright", label: "Outright" }, { code: "hedged", label: "Hedged" }], st.crMode,
      (v) => { st.crMode = v; recompute(); }));
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
    // Auctions / syndications: existing lines at their yield, new issues on the fitted curve at their maturity.
    const settle = parseDate(market.settle);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const deals = (auctions?.markets?.[mcode]?.deals ?? []).map((d) => {
      const r = d.id && byId.get(d.id);
      if (r) return { d, x: r.t, y: r.yield };
      if (!d.maturity) return null;
      const t = yearsBetween(settle, parseDate(d.maturity));
      return t > 0 ? { d, x: t, y: nsEval(market.curve, t) } : null;
    }).filter(Boolean);
    for (const [status, color] of [["upcoming", "#3ddc84"], ["recent", "#c58cff"]]) {
      const ds = deals.filter((p) => p.d.status === status);
      if (!ds.length) continue;
      traces.push({ type: "scatter", mode: "markers", name: `${status === "upcoming" ? "Upcoming" : "Recent"} auction / syndicate`,
        x: ds.map((p) => p.x), y: ds.map((p) => p.y), marker: { symbol: "star", size: 15, color: "rgba(0,0,0,0)", line: { color, width: 2 } },
        text: ds.map((p) => `${p.d.date} ${p.d.kind}: ${p.d.name}${p.d.id ? ` ${p.d.id}` : ""}<br>size ${p.d.size ?? "–"}`),
        hovertemplate: "%{text}<extra></extra>" });
    }
    plot(chart, traces, { xaxis: { title: { text: "Years to maturity" } }, yaxis: { title: { text: "Yield (%)" } }, legend: { y: -0.22 } }, 330);
  }

  function selectMarket(m) {
    mcode = m;
    setHash({ m });
    renderAuctions();
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
      el("li", {}, "Return on book = [(hedged carry + roll) × DV01 − hedge net basis] / dirty price. Return on capital = return on book / haircut. Both over 3 months, not annualised."),
      el("li", {}, "Repo curve: S/N for euro markets (€STR as proxy), O/N for UST, flat to the boxing date (5 business days before the main contract's delivery, when shorts box the CTD), then the delivery date and the pillars beyond. Boxing defaults to the flat rate and delivery to the interpolation towards the next pillar; both can be dragged. Boxing premium = forward rate from boxing to delivery − that default forward, where forward = (r_dlv × t_dlv − r_box × t_box) / (t_dlv − t_box); setting it moves the boxing rate with delivery held. Each contract's CTD is financed at the curve's term repo to its delivery."),
      el("li", {}, "Carry / roll chart: hedged mode converts the hedge net basis into bp of the bond's yield (net basis cost per 100 nominal / bond DV01), so all three bars are comparable yield moves over 3 months."),
      el("li", {}, "Auctions and syndications: TreasuryDirect (UST), Finanzagentur issuance calendar and syndicates (Bunds), MEF auction announcements (BTPs). AFT does not allow automated access to its site, so OAT dates follow its standing calendar (long-term OATs on the first Thursday, medium-term on the third); the lines and amounts AFT announces shortly before each auction are on its site.")));
}
