// Shared Plotly styling for the site's dark theme. Every chart supports zoom (drag), pan,
// box select, scroll zoom, double-click to reset and click-to-toggle legend entries.

export const COLORS = ["#58a6ff", "#f78166", "#3fb950", "#d29922", "#bc8cff", "#39c5cf", "#ff7b72", "#a5d6ff", "#ffa657", "#7ee787"];

const AXIS = {gridcolor: "#21262d", zerolinecolor: "#30363d", linecolor: "#30363d", tickcolor: "#30363d", automargin: true};

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
    font: {family: "Inter, system-ui, sans-serif", size: 12, color: "#c9d1d9"},
    margin: {l: 60, r: 20, t: 30, b: 45},
    legend: {orientation: "h", x: 0, y: 1.02, yanchor: "bottom", font: {size: 11}, bgcolor: "rgba(0,0,0,0)"},
    hovermode: "closest",
    hoverlabel: {bgcolor: "#161b22", bordercolor: "#30363d", font: {color: "#f0f6fc", family: "Inter, sans-serif"}},
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
