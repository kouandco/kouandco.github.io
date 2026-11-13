// Shared page frame (top bar, function tabs, status bar), data loading, formatting,
// a sortable / editable table and the Plotly terminal theme.

export const PAGES = [
  { code: "HOME", href: "homepage.html", title: "Home" },
  { code: "CTD", href: "CTD.html", title: "Bond Futures CTD" },
  { code: "BMNT", href: "BMNT.html", title: "Bond Monitor" },
  { code: "EURX", href: "EURX.html", title: "Eurex Flow" },
  { code: "FIHG", href: "FIHG.html", title: "Fixed Income Hedge" },
  { code: "GP", href: "GP.html", title: "Historical Graphs" },
  { code: "WIRP", href: "WIRP.html", title: "Policy Rate Pricing" },
  { code: "IRS", href: "IRS.html", title: "Swap Pricer" },
  { code: "TEST", href: "TEST.html", title: "Strategy Backtest" },
  { code: "BLOT", href: "BLOT.html", title: "Portfolio Risk" },
];

export const MARKETS = [
  { code: "UST", label: "UST" },
  { code: "DE", label: "Bund" },
  { code: "FR", label: "OAT" },
  { code: "IT", label: "BTP" },
];

// ---------------------------------------------------------------- DOM

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------- frame

export function frame(code) {
  const page = PAGES.find((p) => p.code === code);
  document.title = `${page.code === "HOME" ? "Seankou" : page.code} · ${page.title}`;
  const clock = el("span", { class: "clock" });
  const tick = () => {
    const t = (tz) => new Date().toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
    clock.textContent = `LDN ${t("Europe/London")}  NY ${t("America/New_York")}  FRA ${t("Europe/Berlin")}`;
  };
  tick();
  setInterval(tick, 30000);
  const top = el("div", { class: "topbar" },
    el("span", { class: "brand" }, "SEANKOU"),
    el("span", { class: "fn" }, `${page.code} <GO>`),
    el("span", {}, page.title),
    clock);
  const tabs = el("nav", { class: "tabs", "aria-label": "Functions" },
    PAGES.map((p) => el("a", { href: p.href, class: p.code === code ? "active" : null },
      el("span", { class: "code" }, p.code === "HOME" ? "<MENU>" : p.code), p.code === "HOME" ? "" : p.title)));
  document.body.prepend(top, tabs);
  const status = el("footer", { class: "status" }, "Loading data status…");
  const codeNote = el("span");
  document.body.append(status);
  loadJSON("data/meta.json").then((meta) => {
    const failed = Object.entries(meta.steps).filter(([, s]) => !s.ok);
    status.replaceChildren(
      el("span", {}, `Data refreshed ${meta.refreshed} (weekdays at 10:00 London)`),
      codeNote,
      ...failed.map(([name, s]) => el("span", { class: "bad", title: s.error }, `${name}: refresh failed, showing data from ${s.lastGood ?? "earlier"}`)));
  }).catch(() => status.replaceChildren("Data status unavailable", codeNote));
  codeUpdated().then((when) => { if (when) codeNote.textContent = `Code updated ${when}`; });
}

// "2026-11-07 10:41 GMT": London time, in the same form as the data refresh time.
function londonTime(iso) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

// Time of the last commit to the page code (assets/) on main, from the GitHub API. Cached for an hour per
// browser, as unauthenticated API calls are rate-limited; nothing is shown if the API cannot be reached.
async function codeUpdated() {
  if (["localhost", "127.0.0.1"].includes(location.hostname)) return "(local preview)";
  try {
    const hit = JSON.parse(localStorage.getItem("codeUpdated") ?? "null");
    if (hit && Date.now() - hit.at < 36e5) return londonTime(hit.iso);
  } catch { /* storage unavailable */ }
  try {
    const r = await fetch("https://api.github.com/repos/kouandco/kouandco.github.io/commits?sha=main&path=assets&per_page=1");
    if (!r.ok) return null;
    const [c] = await r.json();
    if (!c) return null;
    const iso = c.commit.committer.date;
    try { localStorage.setItem("codeUpdated", JSON.stringify({ at: Date.now(), iso })); } catch { /* storage unavailable */ }
    return londonTime(iso);
  } catch {
    return null;
  }
}

// Market / contract selector buttons bound to the URL hash, e.g. #DE or #RX.
export function segmented(items, value, onChange, cls = "seg") {
  const wrap = el("div", { class: cls, role: "tablist" });
  const render = (v) => wrap.replaceChildren(...items.map((it) =>
    el("button", { class: `btn${it.code === v ? " on" : ""}`, role: "tab", "aria-selected": String(it.code === v),
      onclick: () => { render(it.code); onChange(it.code); } }, it.label)));
  render(value);
  return wrap;
}

export function hashParam(key, fallback, allowed) {
  const params = new URLSearchParams(location.hash.slice(1));
  const v = params.get(key);
  return v && (!allowed || allowed.includes(v)) ? v : fallback;
}

export function setHash(obj) {
  const params = new URLSearchParams(location.hash.slice(1));
  for (const [k, v] of Object.entries(obj)) params.set(k, v);
  history.replaceState(null, "", `#${params}`);
}

// ---------------------------------------------------------------- data

const cache = new Map();
// Data changes once a day; the query string only stops a stale copy being reused across refreshes.
const stamp = new Date().toISOString().slice(0, 13);
export function loadJSON(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(`${path}?v=${stamp}`).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    }));
  }
  return cache.get(path);
}

export function showError(container, err) {
  console.error(err);
  container.append(el("div", { class: "panel down" }, `Could not load data: ${err.message}`));
}

// ---------------------------------------------------------------- formatting

// Rounds to `d` decimals first so that tiny negatives print as 0, not −0.
const tidy = (x, d) => (Math.abs(x) < 0.5 * 10 ** -d ? 0 : x);
export const fmt = {
  n: (x, d = 2) => (x == null || !isFinite(x) ? "–" : tidy(x, d).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })),
  ccy: (c, x) => (x == null || !isFinite(x) ? "–" : `${x < -0.5 ? "−" : ""}${c}${Math.round(Math.abs(x)).toLocaleString("en-US")}`),
  s: (x, d = 1) => (x == null || !isFinite(x) ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(d)}`),
  pct: (x, d = 1) => (x == null || !isFinite(x) ? "–" : `${(100 * x).toFixed(d)}%`),
  int: (x) => (x == null || !isFinite(x) ? "–" : Math.round(x).toLocaleString("en-US")),
};
export const signClass = (x, eps = 0.05) => (x > eps ? "pos" : x < -eps ? "neg" : "");

// Background shading proportional to |x| / scale, green for gains and red for losses.
export function heat(x, scale) {
  if (x == null || !isFinite(x) || !scale) return null;
  const a = Math.min(Math.abs(x) / scale, 1) * 0.35;
  return x >= 0 ? `rgba(61,220,132,${a})` : `rgba(255,92,92,${a})`;
}

// ---------------------------------------------------------------- table

// columns: {key, label, unit, fmt(row), value(row) (for sorting), cls(row), bg(row), left, title,
//           edit: {get(row), set(row, value), step}}
export function dataTable(columns, { sortKey = null, sortAsc = true, rowClass, onRowClick, groups } = {}) {
  const wrap = el("div", { class: "table-wrap tall" });
  let rows = [];
  let key = sortKey;
  let asc = sortAsc;
  const render = () => {
    const col = columns.find((c) => c.key === key);
    const sorted = col ? [...rows].sort((a, b) => {
      const va = (col.value ?? col.fmt)(a), vb = (col.value ?? col.fmt)(b);
      const cmp = typeof va === "string" ? va.localeCompare(vb) : (va ?? -Infinity) - (vb ?? -Infinity);
      return asc ? cmp : -cmp;
    }) : rows;
    const head = [];
    if (groups) {
      head.push(el("tr", {}, groups.map((g) => el("th", { colspan: g.span, class: g.label ? "th-group" : "" }, g.label ?? ""))));
    }
    head.push(el("tr", {}, columns.map((c) => el("th", {
      class: [c.left ? "l" : "", c.value || c.fmt ? "sortable" : "", c.key === key ? `sorted${asc ? " asc" : ""}` : ""].join(" "),
      title: c.title,
      onclick: () => { if (key === c.key) asc = !asc; else { key = c.key; asc = !!c.left; } render(); },
    }, c.label, c.unit ? el("span", { class: "unit" }, ` ${c.unit}`) : null))));
    const body = sorted.map((r) => el("tr", { class: rowClass?.(r), onclick: onRowClick ? () => onRowClick(r) : null },
      columns.map((c) => {
        if (c.edit) {
          const input = el("input", { type: c.edit.type ?? "number", step: c.edit.step ?? "any", value: c.edit.get(r) ?? "",
            class: c.edit.changed?.(r) ? "changed" : null, "aria-label": `${c.label} ${r.name ?? ""}` });
          input.addEventListener("change", () => c.edit.set(r, input.value));
          input.addEventListener("click", (e) => e.stopPropagation());
          return el("td", { class: "edit" }, input);
        }
        const td = el("td", { class: [c.left ? "l" : "", c.cls?.(r) ?? ""].join(" "), title: c.tip?.(r) }, c.fmt(r));
        const bg = c.bg?.(r);
        if (bg) td.style.background = bg;
        return td;
      })));
    wrap.replaceChildren(el("table", {}, el("thead", {}, head), el("tbody", {}, body)));
  };
  return { node: wrap, update(next) { rows = next; render(); } };
}

// ---------------------------------------------------------------- charts

export const COLORS = ["#ff9e1b", "#5fa8ff", "#3ddc84", "#ff5c5c", "#c58cff", "#ffd24d", "#22d3ee", "#f472b6", "#a3e635", "#94a3b8"];

export function layout(extra = {}) {
  const axis = { gridcolor: "#1f1f1f", zerolinecolor: "#3a3a3a", linecolor: "#3a3a3a", tickcolor: "#3a3a3a", automargin: true,
    tickfont: { color: "#bdbdbd" }, title: { font: { color: "#ff9e1b", size: 12 } } };
  const merge = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b ?? {})) {
      out[k] = v && typeof v === "object" && !Array.isArray(v) && a?.[k] && typeof a[k] === "object" ? merge(a[k], v) : v;
    }
    return out;
  };
  const base = {
    paper_bgcolor: "#0a0a0a", plot_bgcolor: "#0a0a0a",
    font: { family: "IBM Plex Mono, Menlo, monospace", size: 12, color: "#e9e9e9" },
    margin: { l: 56, r: 16, t: 12, b: 44 },
    hoverlabel: { bgcolor: "#141414", bordercolor: "#ff9e1b", font: { color: "#e9e9e9", family: "IBM Plex Mono, monospace" } },
    legend: { orientation: "h", y: -0.18, font: { color: "#bdbdbd" } },
    xaxis: axis, yaxis: axis, yaxis2: axis,
  };
  return merge(base, extra);
}

export function plot(node, data, extra = {}, height = 360) {
  window.Plotly.react(node, data, layout({ height, ...extra }),
    { displaylogo: false, responsive: true, scrollZoom: true, modeBarButtonsToRemove: ["lasso2d", "select2d"] });
}
