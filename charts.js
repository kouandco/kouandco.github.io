// Shared Plotly styling for the site's dark theme. Every chart supports zoom (drag), pan,
// box select, scroll zoom, double-click to reset and click-to-toggle legend entries.

export const COLORS = ["#a78bfa", "#38d39f", "#ff6b6b", "#60a5fa", "#fbbf24", "#f472b6", "#22d3ee", "#c4b5fd", "#fb923c", "#94a3b8"];

const AXIS = {gridcolor: "rgba(255,255,255,0.06)", zerolinecolor: "rgba(255,255,255,0.14)", linecolor: "rgba(255,255,255,0.12)",
  tickcolor: "rgba(255,255,255,0.12)", automargin: true};

function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function merge(a, b) {
  const out = {...a};
  for (const [k, v] of Object.entries(b ?? {})) out[k] = isObject(v) && isObject(a?.[k]) ? merge(a[k], v) : v;
  return out;
}

export function layout(extra = {}) {
  const base = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: {family: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif", size: 12, color: "#a0a7b4"},
    margin: {l: 60, r: 20, t: 30, b: 45},
    legend: {orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: {size: 11}, bgcolor: "rgba(0,0,0,0)"},
    hovermode: "closest",
    hoverlabel: {bgcolor: "rgba(10,17,24,0.98)", bordercolor: "rgba(255,255,255,0.14)", font: {color: "#e6e9ef", family: "ui-monospace, SFMono-Regular, Menlo, monospace"}},
    dragmode: "zoom",
    xaxis: AXIS,
    yaxis: AXIS,
  };
  const out = merge(base, extra);
  for (const k of Object.keys(extra)) if (/^[xy]axis\d+$/.test(k)) out[k] = merge(AXIS, extra[k]);
  return out;
}

// Render a Plotly chart into a full-width div that resizes with its container (including hidden tabs).
export function plot(Plotly, data, lay = {}, height = 320) {
  const el = document.createElement("div");
  el.style.width = "100%";
  el.style.height = `${height}px`;
  Plotly.newPlot(el, data, layout({height, ...lay}), {
    responsive: true,
    displaylogo: false,
    scrollZoom: true,
    modeBarButtonsToRemove: ["lasso2d", "autoScale2d", "toImage"],
  });
  new ResizeObserver(() => { if (el.offsetWidth) Plotly.Plots.resize(el); }).observe(el);
  return el;
}
