import { $, COLORS, el, fmt, frame, hashParam, loadJSON, plot, segmented, setHash, showError } from "./common.js";

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
  const state = { bank: hashParam("b", "Fed", BANKS.map((b) => b.code)) };
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
    setHash({ b: state.bank });
    const b = wirp.banks[state.bank];
    const rows = b.meetings.map((m) => ({
      ...m,
      d1: (v) => (v == null ? null : (m.implied - v) * 100),
      prev: earlier(state.bank, m.date, prevIndex),
      week: earlier(state.bank, m.date, weekIndex),
    }));
    const head = ["Meeting", "Effective", "Implied rate %", "Δ at meeting bp", "Moves", "Probability", "Cumulative bp", "Cumulative moves",
      prevIndex != null ? `Δ vs ${hist.dates[prevIndex]} bp` : null, weekIndex >= 0 && weekIndex !== prevIndex ? "Δ 1w bp" : null].filter(Boolean);
    const table = el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, head.map((h, i) => el("th", { class: i < 2 ? "l" : "" }, h)))),
      el("tbody", {}, rows.map((r) => el("tr", {},
        el("td", { class: "l" }, dayLabel(r.date)),
        el("td", { class: "l muted" }, dayLabel(r.effective)),
        el("td", {}, r.implied.toFixed(3)),
        el("td", { class: r.change > 0.5 ? "neg" : r.change < -0.5 ? "pos" : "" }, fmt.s(r.change, 1)),
        el("td", {}, fmt.s(r.change / STEP, 2)),
        el("td", { class: "l" }, probability(r.change)),
        el("td", {}, fmt.s(r.cumulative, 1)),
        el("td", {}, fmt.s(r.cumulative / STEP, 2)),
        prevIndex != null ? el("td", {}, fmt.s(r.d1(r.prev), 1)) : null,
        weekIndex >= 0 && weekIndex !== prevIndex ? el("td", {}, fmt.s(r.d1(r.week), 1)) : null)))));

    const past = b.decisions ?? [];
    const decisions = el("div", { class: "table-wrap tall" }, el("table", {},
      el("thead", {}, el("tr", {}, ["Meeting", "Decision", "Rate before %", "Rate after %", state.bank === "BoE" ? "MPC vote" : null, "Statement"]
        .filter(Boolean).map((h, i) => el("th", { class: i === 0 || i === 1 || h === "Statement" ? "l" : "" }, h)))),
      el("tbody", {}, past.map((d) => el("tr", {},
        el("td", { class: "l" }, dayLabel(d.date)),
        el("td", { class: `l ${d.change > 0 ? "neg" : d.change < 0 ? "pos" : ""}` }, decisionLabel(d.change)),
        el("td", {}, d.before), el("td", {}, d.after),
        state.bank === "BoE" ? el("td", {}, d.vote ?? "–") : null,
        el("td", { class: "l" }, el("a", { href: d.link, target: "_blank", rel: "noopener" }, linkLabel(state.bank))))))));

    const pathChart = el("div", { class: "plot" });
    const cumChart = el("div", { class: "plot" });
    const fwdChart = el("div", { class: "plot" });
    body.replaceChildren(
      el("div", { class: "tiles" },
        tile("Policy rate", b.policyLabel),
        tile(`${b.overnightName} fixing`, `${b.overnight.toFixed(3)}% (${b.fixingDate})`),
        tile(`${b.overnightName} priced to next meeting`, `${b.priced.toFixed(3)}%`),
        tile("Curve", `${b.curve} · Eurex Clearing`)),
      el("section", { class: "panel" }, el("h2", {}, `${b.name}: policy rate over two years and the path priced ahead`), pathChart),
      el("section", { class: "panel" }, el("h2", {}, "Meeting by meeting"), table,
        el("p", { class: "note" }, `Moves = bp ÷ ${STEP}. Probability reads a priced move as a share of one ${STEP}bp step, e.g. +20bp = 80% of a hike; `
          + "it ignores larger or opposite moves and any term premium in the OIS curve.")),
      el("section", { class: "panel" }, el("h2", {}, `Decisions over the last two years (${past.filter((d) => d.change).length} moves in ${past.length} meetings)`),
        past.length ? decisions : el("p", { class: "muted" }, "No decision history available."),
        el("p", { class: "note" }, "Rates before and after from the official series (NY Fed target range, ECB deposit facility rate, Bank Rate); links to each decision's statement."
          + (state.bank === "BoE" ? " MPC vote: majority–minority, or unanimous." : ""))),
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
