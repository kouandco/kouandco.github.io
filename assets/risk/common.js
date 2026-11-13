// Frame for the risk advisory pages under /risk. They are deliberately not in the main site's PAGES
// list, so nothing on the homepage links here; the risk tab bar only appears on these pages.

import { el, loadJSON } from "../common.js";

export const RISK_PAGES = [
  { code: "RISK", href: "./", title: "Risk Advisory" },
  { code: "HSWP", href: "HSWP.html", title: "Debt Hedging Strategy" },
  { code: "RFP", href: "RFP.html", title: "Execution & Bank Quotes" },
  { code: "FXHG", href: "FXHG.html", title: "Fund FX Hedging" },
];

export function riskFrame(code) {
  const page = RISK_PAGES.find((p) => p.code === code);
  document.title = `${page.code} · ${page.title}`;
  const clock = el("span", { class: "clock" });
  const tick = () => {
    const t = (tz) => new Date().toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
    clock.textContent = `LDN ${t("Europe/London")}  MAD ${t("Europe/Madrid")}  DXB ${t("Asia/Dubai")}  SGP ${t("Asia/Singapore")}`;
  };
  tick();
  setInterval(tick, 30000);
  const top = el("div", { class: "topbar" },
    el("span", { class: "brand" }, "SEANKOU · RISK"),
    el("span", { class: "fn" }, `${page.code} <GO>`),
    el("span", {}, page.title),
    clock);
  const tabs = el("nav", { class: "tabs", "aria-label": "Risk tools" },
    RISK_PAGES.map((p) => el("a", { href: p.href, class: p.code === code ? "active" : null },
      el("span", { class: "code" }, p.code === "RISK" ? "<MENU>" : p.code), p.code === "RISK" ? "" : p.title)));
  document.body.prepend(top, tabs);
  const status = el("footer", { class: "status" }, "Loading data status…");
  document.body.append(status);
  loadJSON("../data/meta.json").then((meta) => {
    const keep = ["Swap curves", "FX rates"];
    const failed = Object.entries(meta.steps).filter(([n, s]) => keep.includes(n) && !s.ok);
    status.replaceChildren(
      el("span", {}, `Data refreshed ${meta.refreshed} (weekdays at 10:00 London)`),
      el("span", {}, "Curves: Eurex Clearing settlement · FX: ECB reference rates"),
      ...failed.map(([name, s]) => el("span", { class: "bad", title: s.error }, `${name}: refresh failed, showing data from ${s.lastGood ?? "earlier"}`)));
  }).catch(() => status.replaceChildren("Data status unavailable"));
}

// A labelled input bound to state[key] (showing `fallback` while it is null, e.g. a derived default). kind: "num" | "text" | "date" | select options [{v, label}].
export function field(label, state, key, onChange, { kind = "num", step = "any", width, title, options, fallback } = {}) {
  let input;
  if (options) {
    input = el("select", {}, options.map((o) => el("option", { value: o.v, selected: String(o.v) === String(state[key]) ? true : null }, o.label)));
  } else {
    input = el("input", { type: kind === "num" ? "number" : kind, step, value: state[key] ?? fallback ?? "" });
    if (width) input.style.width = width;
  }
  input.addEventListener("change", () => {
    const v = input.value;
    state[key] = kind === "num" && !options ? (v === "" ? null : Number(v)) : (options && typeof options[0].v === "number" ? Number(v) : v);
    onChange(key);
  });
  return el("label", { class: "fld", title }, el("span", {}, label), input);
}

// Page state persisted in the URL hash as JSON, so a scenario can be bookmarked or sent.
export function hashState(defaults) {
  try {
    const raw = decodeURIComponent(location.hash.slice(1));
    if (raw.startsWith("{")) return { ...defaults, ...JSON.parse(raw) };
  } catch { /* bad hash: use defaults */ }
  return { ...defaults };
}
export function saveHash(state) {
  history.replaceState(null, "", `#${encodeURIComponent(JSON.stringify(state))}`);
}

// Currency amount in millions: −£41.6mm.
export const mm = (sym, x, d = 1) => (x == null || !isFinite(x) ? "–" : `${x < 0 ? "−" : ""}${sym}${(Math.abs(x) / 1e6).toFixed(d)}mm`);

export const tile = (k, v, n, cls) => el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: `v ${cls ?? ""}` }, v), n ? el("div", { class: "n" }, n) : null);

// Small per-browser store (hand-offs between pages, checklists). Never required for a page to work.
export const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; } },
  set(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
