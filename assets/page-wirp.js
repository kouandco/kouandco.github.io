import { $, COLORS, el, fmt, footnotes, frame, hashParam, loadJSON, plot, segmented, setHash, showError } from "./common.js";

frame("WIRP");
const app = $("#app");
const BANKS = [
  { code: "Fed", label: "Fed" },
  { code: "ECB", label: "ECB" },
  { code: "BoE", label: "BoE" },
];
const STEP = 25;  // bp per standard move

const monthLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

// "+0.83" moves at a meeting as words: 83% chance of a 25bp hike (or one hike plus a share of a second).
function probability(bp) {
  const n = bp / STEP;
  if (Math.abs(n) < 0.05) return "no change";
  const dir = n > 0 ? "hike" : "cut";
  const whole = Math.floor(Math.abs(n));
  const part = Math.round((Math.abs(n) - whole) * 100);
  if (!whole) return `${part}% ${dir}`;
  return part ? `${whole} ${dir}${whole > 1 ? "s" : ""} + ${part}% of another` : `${whole} ${dir}${whole > 1 ? "s" : ""}`;
}


// The policy rate series in data/gp/policy.json for each bank (the Fed: mid of the target range).
const POLICY_SERIES = { Fed: "Fed funds target (mid)", ECB: "ECB deposit rate", BoE: "Bank Rate" };

function decisionLabel(change) {
  return change > 0 ? `Hike +${change}bp` : change < 0 ? `Cut −${-change}bp` : "Hold";
}

function start(wirp, hist, policy) {
  const dots = wirp.banks.Fed.dots ?? [];
  const sepDates = dots.map((d) => d.date);
  const state = { bank: hashParam("b", "Fed", BANKS.map((b) => b.code)), sep: hashParam("s", sepDates.at(-1) ?? null, sepDates) };
  // Implied rate per meeting on an earlier snapshot, to show how pricing moved.
  const prevIndex = hist && hist.dates.length > 1 ? hist.dates.length - 2 : null;
  const weekIndex = hist ? hist.dates.findLastIndex((d) => d <= shiftDays(wirp.curveDate, -7)) : -1;
  const earlier = (bank, meeting, i) => (i == null || i < 0 ? null : hist.series[`${bank}|${meeting}`]?.[i] ?? null);

  const tiles = el("div", { class: "tiles", style: { marginBottom: "10px" } });
  const body = el("div", { class: "stack" });
  app.append(
    el("div", { class: "page-title" }, el("h1", {}, "Policy Rate Pricing"),
      el("span", { class: "muted" }, `moves priced by the OIS curves at each Fed, ECB and BoE meeting · curves of ${dayLabel(wirp.curveDate)}`)),
    tiles,
    el("div", { class: "row", style: { marginBottom: "8px" } },
      segmented(BANKS.map((b) => ({ ...b, label: wirp.banks[b.code].name })), state.bank, (b) => { state.bank = b; render(); })),
    body, method(wirp));

  tiles.append(...BANKS.map(({ code }) => {
    const b = wirp.banks[code];
    const next = b.meetings[0];
    const year = b.meetings.filter((m) => m.date <= shiftDays(wirp.curveDate, 366)).at(-1);
    return el("div", { class: "tile" },
      el("div", { class: "k" }, `${code} · ${b.policyLabel.split(" (")[0]}`),
      el("div", { class: "v" }, `${b.policy.toFixed(3)}%`),
      el("div", { class: "n" }, `Next ${dayLabel(next.date)}: ${fmt.s(next.change, 1)}bp (${probability(next.change)})`),
      el("div", { class: "n" }, `Priced by ${monthLabel(year.date)}: ${fmt.s(year.cumulative, 0)}bp to ${year.implied.toFixed(2)}%`));
  }));

  function render() {
    setHash(state.bank === "Fed" && state.sep ? { b: state.bank, s: state.sep } : { b: state.bank });
    const b = wirp.banks[state.bank];
    const rows = b.meetings.map((m) => ({
      ...m,
      d1: (v) => (v == null ? null : (m.implied - v) * 100),
      prev: earlier(state.bank, m.date, prevIndex),
      week: earlier(state.bank, m.date, weekIndex),
    }));
    // One table, oldest first: decisions taken over two years, a marker for today, then the moves priced ahead.
    const past = [...(b.decisions ?? [])].sort((x, y) => (x.date < y.date ? -1 : 1));
    const showPrev = prevIndex != null, showWeek = weekIndex >= 0 && weekIndex !== prevIndex;
    const boe = state.bank === "BoE", fed = state.bank === "Fed";
    const sepOf = new Map(dots.map((d) => [d.date, d]));
    // Dot plot summary for a meeting with projections: median (low–high) at the end of the meeting's year, the next
    // year and the longer run.
    const dotCell = (d, k) => {
      const sep = sepOf.get(d.date);
      const lab = sep && (k === 2 ? "Longer run" : String(+d.date.slice(0, 4) + k));
      const st = sep?.stats[lab];
      return el("td", { class: "l", title: st ? `${lab}: median ${st.median.toFixed(3)}%, range ${st.low.toFixed(3)}–${st.high.toFixed(3)}%, ${st.n} participants` : null },
        st ? el("span", { style: { whiteSpace: "nowrap" } }, el("b", {}, st.median.toFixed(2)), el("span", { class: "muted", style: { fontSize: "0.85em" } }, ` ${st.low.toFixed(2)}–${st.high.toFixed(2)}`)) : "");
    };
    // Columns: [label, footnote, hover title, left-aligned]. Units and definitions are in the footnotes below the table.
    const head = [["Meeting", null, null, true], ["Eff.", "eff", "Date the decision takes effect", true], ["Rate %", "rate", "Rate after the decision / implied rate"],
      ["Δ bp", null, "Move at the meeting (bp)"], ["Moves", "moves", "Move ÷ 25bp"], ["Outcome", "outcome", "Decision / probability of the priced move", true],
      ["Cum.", "cum", "Cumulative move priced from today (bp)"],
      showPrev ? ["Δ1d", "delta", `Change in the implied rate since ${hist.dates[prevIndex]} (bp)`] : null, showWeek ? ["Δ1w", "delta", "Change in the implied rate over a week (bp)"] : null,
      boe ? ["Vote", "vote", "MPC vote", true] : null,
      ...(fed ? [["YE", "dots", "Dots: end of the meeting's year", true], ["YE+1", "dots", "Dots: end of the next year", true], ["LR", "dots", "Dots: longer run", true]] : []),
      ["", null, null, true]].filter(Boolean);
    const noteNo = {};
    for (const [, n] of head) if (n && !(n in noteNo)) noteNo[n] = Object.keys(noteNo).length + 1;
    const moveCls = (bp) => (bp > 0.5 ? "neg" : bp < -0.5 ? "pos" : "");
    const pad = (n) => Array.from({ length: n }, () => el("td", {}, ""));
    const todayRow = el("tr", { class: "hl" }, el("td", { class: "l amber", colspan: head.length },
      `Today (curves of ${dayLabel(wirp.curveDate)}): ${b.policyLabel}`));
    const table = el("div", { class: "table-wrap tall" }, el("table", {},
      el("thead", {}, el("tr", {}, head.map(([h, n, title, left]) => el("th", { class: left ? "l" : "", title }, h, n ? el("sup", { class: "muted" }, String(noteNo[n])) : null)))),
      el("tbody", {},
        past.map((d) => el("tr", fed && sepOf.has(d.date)
          ? { class: d.date === state.sep ? "hl" : null, style: { cursor: "pointer" }, title: "Show this meeting's dot plot", onclick: () => { state.sep = d.date; render(); } } : {},
          el("td", { class: "l", style: { whiteSpace: "nowrap" } }, shortDay(d.date), fed && sepOf.has(d.date) ? el("span", { class: "amber small", title: "Summary of Economic Projections: click for the dot plot" }, " ●") : null),
          el("td", { class: "l muted" }, ""),
          el("td", {}, d.after),
          el("td", { class: moveCls(d.change) }, fmt.s(d.change, 0)),
          el("td", {}, fmt.s(d.change / STEP, 2)),
          el("td", { class: `l ${moveCls(d.change)}` }, decisionLabel(d.change)),
          el("td", {}, ""),
          ...pad(showPrev + showWeek),
          boe ? el("td", {}, d.vote ?? "–") : null,
          ...(fed ? [0, 1, 2].map((k) => dotCell(d, k)) : []),
          el("td", { class: "l" }, el("a", { href: d.link, target: "_blank", rel: "noopener", title: linkLabel(state.bank), onclick: (e) => e.stopPropagation() }, "↗")))),
        todayRow,
        rows.map((r) => el("tr", { class: "upcoming" },
          el("td", { class: "l", style: { whiteSpace: "nowrap" } }, shortDay(r.date)),
          el("td", { class: "l muted", style: { whiteSpace: "nowrap" } }, shortDay(r.effective)),
          el("td", {}, r.implied.toFixed(3)),
          el("td", { class: moveCls(r.change) }, fmt.s(r.change, 1)),
          el("td", {}, fmt.s(r.change / STEP, 2)),
          el("td", { class: "l" }, probability(r.change)),
          el("td", {}, fmt.s(r.cumulative, 1)),
          showPrev ? el("td", {}, fmt.s(r.d1(r.prev), 1)) : null,
          showWeek ? el("td", {}, fmt.s(r.d1(r.week), 1)) : null,
          boe ? el("td", {}, "") : null,
          ...(fed ? pad(3) : []),
          el("td", { class: "l" }, ""))))));
    // Open the table with today near the top: the priced meetings in view, past decisions a scroll up.
    requestAnimationFrame(() => { table.scrollTop = Math.max(0, todayRow.offsetTop - 120); });

    const pathChart = el("div", { class: "plot" });
    const cumChart = el("div", { class: "plot" });
    const fwdChart = el("div", { class: "plot" });
    const dotPanel = fed && dots.length ? dotPlot(dots, state, b, wirp.curveDate, () => render()) : null;
    body.replaceChildren(
      el("div", { class: "tiles" },
        tile("Policy rate", b.policyLabel),
        tile(`${b.overnightName} fixing`, `${b.overnight.toFixed(3)}% (${b.fixingDate})`),
        tile(`${b.overnightName} priced to next meeting`, `${b.priced.toFixed(3)}%`),
        tile("Curve", `${b.curve} · Eurex Clearing`)),
      el("section", { class: "panel" }, el("h2", {}, `${b.name}: policy rate, last two years and priced path`), pathChart),
      el("section", { class: "panel" },
        el("h2", {}, `Meeting by meeting: ${past.filter((d) => d.change).length} moves in the last ${past.length} meetings, then the priced path`), table,
        meetingNotes(noteNo, {
          eff: "Eff.: the date a priced decision takes effect (the Fed: the day after; ECB: the following Wednesday; BoE: the same day). "
            + "Rows above Today are decided, below are priced by the OIS curve.",
          rate: "Rate: after the decision, from the official series (NY Fed target range, ECB deposit facility rate, Bank Rate); priced rows: the implied rate.",
          moves: `Moves: the move in bp ÷ ${STEP}.`,
          outcome: `Outcome: the decision; for priced rows the move as a share of one ${STEP}bp step, e.g. +20bp = 80% of a hike (ignores larger or opposite moves and term premium).`,
          cum: "Cum.: cumulative move priced from today's policy rate, bp.",
          delta: `Δ1d / Δ1w: change in the implied rate since the previous curve${showPrev ? ` (${hist.dates[prevIndex]})` : ""} / a week ago, bp.`,
          vote: "Vote: MPC majority–minority, or unanimous.",
          dots: "Dots: FOMC participants' projected midpoint of the target range at the end of the meeting's year (YE), the next year (YE+1) and the longer run (LR): "
            + "median in bold, then the lowest–highest dot (rounded to 2 decimals; the dot plot below has 3). Only at meetings with a Summary of Economic Projections (●); click such a row for its dot plot.",
        }, `↗: ${linkLabel(state.bank)}.`)),
      dotPanel,
      el("div", { class: "grid cols-2" },
        el("section", { class: "panel" }, el("h2", {}, "Cumulative move priced: Fed, ECB, BoE"), cumChart),
        el("section", { class: "panel" }, el("h2", {}, "1-week forward overnight rate (OIS)"), fwdChart)));

    // Step path of the implied policy rate, with bars for the move priced at each meeting.
    const xs = [wirp.curveDate, ...rows.flatMap((r) => [r.effective, r.effective])];
    const ys = [b.policy, ...rows.flatMap((r, i) => [i ? rows[i - 1].implied : b.policy, r.implied])];
    // Realised policy rate over two years, with each move marked, joined to the priced path.
    const series = policy?.series[POLICY_SERIES[state.bank]];
    const realised = series ? policy.dates.map((d, i) => [d, series[i]]).filter(([d, v]) => v != null && d <= wirp.curveDate) : [];
    const moves = past.filter((d) => d.change);
    plot(pathChart, [
      { x: realised.map((p) => p[0]), y: realised.map((p) => p[1]), mode: "lines", line: { color: "#bdbdbd", width: 1.6, shape: "hv" },
        name: "Policy rate (realised)", hovertemplate: "%{x|%d %b %Y}: %{y:.3f}%<extra></extra>" },
      { x: moves.map((d) => d.date), y: moves.map((d) => +d.after.split("–").at(-1) - (state.bank === "Fed" ? 0.125 : 0)), mode: "markers",
        marker: { size: 9, symbol: moves.map((d) => (d.change > 0 ? "triangle-up" : "triangle-down")), color: moves.map((d) => (d.change > 0 ? "#ff5c5c" : "#3ddc84")) },
        name: "Hike / cut", text: moves.map((d) => decisionLabel(d.change)), hovertemplate: "%{x|%d %b %Y}: %{text}<extra></extra>" },
      { x: rows.map((r) => r.date), y: rows.map((r) => r.change), type: "bar", name: "Δ priced at meeting (bp)", yaxis: "y2",
        marker: { color: rows.map((r) => (r.change >= 0 ? "rgba(255,92,92,0.55)" : "rgba(61,220,132,0.55)")) },
        hovertemplate: "%{x|%d %b %Y}: %{y:+.1f}bp<extra></extra>" },
      { x: xs, y: ys, mode: "lines", line: { color: COLORS[0], width: 2 }, name: "Implied policy rate (%)",
        hovertemplate: "%{x|%d %b %Y}: %{y:.3f}%<extra></extra>" },
      { x: [xs[0], xs.at(-1)], y: [b.policy, b.policy], mode: "lines", line: { color: "#8c8c8c", dash: "dot", width: 1 }, name: "Current", hoverinfo: "skip" },
    ], { yaxis: { title: { text: "%" }, tickformat: ".2f" }, yaxis2: { title: { text: "bp" }, overlaying: "y", side: "right", showgrid: false, zeroline: true } }, 380);

    plot(cumChart, BANKS.map(({ code }, i) => {
      const m = wirp.banks[code].meetings;
      return { x: [wirp.curveDate, ...m.map((r) => r.effective)], y: [0, ...m.map((r) => r.cumulative)], mode: "lines+markers", line: { shape: "hv", color: COLORS[i + 1] },
        name: code, text: ["today", ...m.map((r) => dayLabel(r.date))], hovertemplate: `${code} %{text}: %{y:+.1f}bp<extra></extra>` };
    }), { yaxis: { title: { text: "bp vs current" }, zeroline: true } });

    plot(fwdChart, BANKS.map(({ code }, i) => {
      const f = wirp.banks[code].forwards;
      return { x: f.map((p) => p.date), y: f.map((p) => p.rate), mode: "lines", line: { color: COLORS[i + 1] }, name: `${code} (${wirp.banks[code].overnightName})`,
        hovertemplate: `${code} %{x|%d %b %Y}: %{y:.3f}%<extra></extra>` };
    }), { yaxis: { title: { text: "%" }, tickformat: ".2f" } });
  }
  render();
}

// FOMC dot plot of the chosen SEP meeting: one dot per participant at each year-end and the longer run (dots at the
// same rate side by side, as the Fed draws them), the median, and today's OIS-implied rate at each year-end.
function dotPlot(dots, state, b, curveDate, rerender) {
  const sep = dots.find((d) => d.date === state.sep) ?? dots.at(-1);
  const pick = el("select", {}, [...dots].reverse().map((d) => el("option", { value: d.date, selected: d.date === sep.date || null }, `${dayLabel(d.date)} SEP`)));
  pick.addEventListener("change", () => { state.sep = pick.value; rerender(); });
  const chart = el("div", { class: "plot" });
  const xs = [], ys = [], txt = [];
  sep.years.forEach((lab, j) => {
    for (const [rate, n] of sep.dots[lab]) {
      for (let k = 0; k < n; k++) { xs.push(j + (k - (n - 1) / 2) * 0.06); ys.push(rate); txt.push(`${lab}: ${rate.toFixed(3)}% · ${n} participant${n > 1 ? "s" : ""}`); }
    }
  });
  const med = sep.years.map((lab) => sep.stats[lab]?.median ?? null);
  // Today's pricing: implied rate after the last meeting of each projection year (the Fed path is on the mid of the range).
  const implied = sep.years.map((lab) => {
    if (!/^\d{4}$/.test(lab) || +lab < +curveDate.slice(0, 4)) return null;
    const last = b.meetings.filter((m) => m.date.slice(0, 4) === lab).at(-1);
    return last ? last.implied : +lab === +curveDate.slice(0, 4) ? b.policy : null;
  });
  const idx = sep.years.map((_, j) => j);
  requestAnimationFrame(() => plot(chart, [
    { x: xs, y: ys, mode: "markers", type: "scatter", name: "Participant", marker: { size: 9, color: "#4da3ff", line: { width: 0 } }, text: txt, hovertemplate: "%{text}<extra></extra>" },
    { x: idx, y: med, mode: "markers", name: "Median", marker: { symbol: "line-ew-open", size: 34, line: { width: 3, color: "#ffb000" } },
      text: sep.years, hovertemplate: "%{text} median: %{y:.3f}%<extra></extra>" },
    { x: idx, y: implied, mode: "markers+lines", name: `OIS implied (${dayLabel(curveDate)})`, line: { color: "#ff5c5c", dash: "dot", width: 1.5 },
      marker: { symbol: "diamond", size: 9, color: "#ff5c5c" }, connectgaps: false, text: sep.years, hovertemplate: "%{text} year-end priced: %{y:.3f}%<extra></extra>" },
  ], { xaxis: { tickvals: idx, ticktext: sep.years, range: [-0.6, sep.years.length - 0.4], zeroline: false },
    yaxis: { title: { text: "Midpoint of target range (%)" }, tickformat: ".2f", dtick: 0.25 }, legend: { orientation: "h", y: -0.12 } }, 420));
  const table = el("div", { class: "table-wrap" }, el("table", { class: "compact" },
    el("thead", {}, el("tr", {}, el("th", { class: "l" }, ""), sep.years.map((y) => el("th", {}, y)))),
    el("tbody", {},
      [["Median", "median"], ["Lowest", "low"], ["Highest", "high"]].map(([k, f]) => el("tr", {}, el("td", { class: "l" }, k),
        sep.years.map((y) => el("td", {}, sep.stats[y] ? sep.stats[y][f].toFixed(3) : "–")))),
      el("tr", {}, el("td", { class: "l" }, "Participants"), sep.years.map((y) => el("td", {}, sep.stats[y]?.n ?? "–"))),
      el("tr", {}, el("td", { class: "l" }, "OIS implied now"), implied.map((v) => el("td", {}, v == null ? "–" : v.toFixed(3)))))));
  return el("section", { class: "panel" },
    el("div", { class: "row", style: { justifyContent: "space-between", alignItems: "center" } },
      el("h2", {}, `FOMC dot plot: ${dayLabel(sep.date)}`),
      el("span", { class: "row", style: { gap: "8px" } }, pick, el("a", { href: sep.link, target: "_blank", rel: "noopener", class: "small" }, "SEP tables"))),
    el("div", { class: "grid cols-2" }, chart, el("div", {}, table,
      footnotes(
        "Each dot: one participant's projected midpoint of the federal funds target range (or target level) at the end of the year, to the nearest 1/8 point.",
        "Median: the middle participant (the Fed's convention).",
        "OIS implied: today's priced rate after the last FOMC of that year, for comparison."))));
}

function meetingNotes(noteNo, text, extra) {
  return el("ol", { class: "footnotes" },
    Object.keys(noteNo).map((k) => el("li", {}, text[k])), extra ? el("li", { style: { listStyle: "none" } }, extra) : null);
}

function shortDay(d) {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" });
}

function linkLabel(bank) {
  return { Fed: "FOMC statement", ECB: "ECB press release", BoE: "MPC summary and minutes" }[bank];
}

function tile(k, v) {
  return el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: "v small" }, v));
}

function shiftDays(d, n) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function method(wirp) {
  const b = wirp.banks;
  return el("details", { class: "method" }, el("summary", {}, "Method and sources"), el("ul", {},
    el("li", {}, "Curves: end-of-day OIS discount curves published daily by Eurex Clearing (", el("a", { href: wirp.source }, "EurexOTC Clear settlement prices"),
      `): ${b.Fed.curve} for the Fed, ${b.ECB.curve} for the ECB, ${b.BoE.curve} for the BoE.`),
    el("li", {}, "Average overnight rate the curve implies between two decisions taking effect: (DF(start) ÷ DF(end) − 1) × basis ÷ days, act/360 for USD and EUR, act/365 for GBP."),
    el("li", {}, "Move priced at a meeting = that average minus the average over the previous period. Implied policy rate = today's policy rate + the cumulative move, "
      + "so the usual spread of the overnight fixing to the policy rate (EFFR − mid of the Fed range, €STR − deposit rate, SONIA − Bank Rate) cancels out."),
    el("li", {}, "Decisions take effect the day after the FOMC (Fed), the following Wednesday (ECB, start of the maintenance period) and the same day (BoE)."),
    el("li", {}, "Meeting dates: ", el("a", { href: b.Fed.calendar }, "Federal Reserve"), ", ", el("a", { href: b.ECB.calendar }, "ECB"), ", ",
      el("a", { href: b.BoE.calendar }, "Bank of England"), ". Rates: NY Fed (EFFR, target range), ECB Data Portal (deposit facility rate, €STR), Bank of England database (Bank Rate, SONIA)."),
    el("li", {}, "OIS forwards include term premium and month- and year-end effects, so far meetings are less clean than near ones."),
    el("li", {}, "Decisions: FOMC statements (federalreserve.gov), ECB monetary policy press releases, Bank of England Monetary Policy Summary and minutes; "
      + "rates before and after from the official rate series.")));
}

// Last, so that every constant above is initialised before the page starts.
try {
  const [wirp, hist, policy] = await Promise.all([loadJSON("data/wirp.json"), loadJSON("data/gp/wirp.json").catch(() => null),
    loadJSON("data/gp/policy.json").catch(() => null)]);
  start(wirp, hist, policy);
} catch (err) {
  showError(app, err);
}
