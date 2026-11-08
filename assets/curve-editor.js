// SVG curve with draggable points (vertical drag; arrow keys when a point has focus).
// points: [{x, y, label}], background: [{x, y, name, color}] drawn as small dots.

import { monotone } from "./bond.js";

const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

// xPad: room to the right of the last point, as a share of its x (labels of a point at the edge need more).
export function curveEditor({ width = 720, height = 300, xTitle = "", yTitle = "", yDigits = 2, xTicks, step = 0.005,
  xPad = 0.04, onChange, onSelect, format = (p) => p.y.toFixed(yDigits) }) {
  const m = { l: 52, r: 14, t: 18, b: 36 };
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${yTitle} curve, drag points to edit` });
  const wrap = document.createElement("div");
  wrap.className = "curve-editor";
  wrap.append(root);
  const tip = document.createElement("div");
  tip.className = "note";
  tip.textContent = "Drag a point up or down (or focus it and use ↑ ↓) to change it.";
  wrap.append(tip);

  // overlay: {lines: [{x, label}], marks: [{x, y, label}], segments: [{x0, x1, y}]}, drawn but not draggable.
  let points = [], background = [], overlay = {}, range = null, selected = -1, dragging = -1;
  const sx = (x) => m.l + ((x - range.x0) / (range.x1 - range.x0)) * (width - m.l - m.r);
  const sy = (y) => m.t + ((range.y1 - y) / (range.y1 - range.y0)) * (height - m.t - m.b);
  const iy = (py) => range.y1 - ((py - m.t) / (height - m.t - m.b)) * (range.y1 - range.y0);

  function fitRange() {
    const all = [...points, ...background, ...(overlay.marks ?? []), ...(overlay.segments ?? []).map((s) => ({ x: s.x1, y: s.y }))];
    const xs = all.map((p) => p.x);
    const ys = all.map((p) => p.y);
    const pad = Math.max((Math.max(...ys) - Math.min(...ys)) * 0.25, 0.1);
    range = { x0: 0, x1: Math.max(...xs) * (1 + xPad), y0: Math.min(...ys) - pad, y1: Math.max(...ys) + pad };
  }

  function draw() {
    root.replaceChildren();
    const g = svg("g", { "font-size": 11, fill: "#bdbdbd", "font-family": "IBM Plex Mono, monospace" });
    root.append(g);
    // y grid
    const yStep = niceStep((range.y1 - range.y0) / 5);
    for (let y = Math.ceil(range.y0 / yStep) * yStep; y <= range.y1; y += yStep) {
      g.append(svg("line", { x1: m.l, x2: width - m.r, y1: sy(y), y2: sy(y), stroke: "#1f1f1f" }));
      const t = svg("text", { x: m.l - 6, y: sy(y) + 4, "text-anchor": "end" });
      t.textContent = y.toFixed(yStep < 0.1 ? 2 : 1);
      g.append(t);
    }
    for (const tick of xTicks ?? defaultTicks(range.x1)) {
      const { x, label } = typeof tick === "number" ? { x: tick, label: `${tick}` } : tick;
      const t = svg("text", { x: sx(x), y: height - m.b + 16, "text-anchor": "middle" });
      t.textContent = label;
      g.append(t);
      g.append(svg("line", { x1: sx(x), x2: sx(x), y1: height - m.b, y2: height - m.b + 4, stroke: "#3a3a3a" }));
    }
    (overlay.lines ?? []).forEach((l, i) => {
      g.append(svg("line", { x1: sx(l.x), x2: sx(l.x), y1: m.t, y2: height - m.b, stroke: "#5fa8ff", "stroke-dasharray": "4 3" }));
      const t = svg("text", { x: sx(l.x) + 4, y: m.t + 10 + 13 * i, fill: "#5fa8ff" });
      t.textContent = l.label;
      g.append(t);
    });
    for (const s of overlay.segments ?? []) {
      g.append(svg("line", { x1: sx(s.x0), x2: sx(s.x1), y1: sy(s.y), y2: sy(s.y), stroke: "#ff5c5c", "stroke-width": 3 }));
    }
    for (const p of overlay.marks ?? []) {
      g.append(svg("circle", { cx: sx(p.x), cy: sy(p.y), r: 4, fill: "#5fa8ff" }));
      const t = svg("text", { x: sx(p.x) + 6, y: sy(p.y) + 14, fill: "#5fa8ff" });
      t.textContent = p.label;
      g.append(t);
    }
    g.append(svg("line", { x1: m.l, x2: width - m.r, y1: height - m.b, y2: height - m.b, stroke: "#3a3a3a" }));
    const xt = svg("text", { x: (m.l + width - m.r) / 2, y: height - 4, "text-anchor": "middle", fill: "#ff9e1b" });
    xt.textContent = xTitle;
    const yt = svg("text", { x: 12, y: (m.t + height - m.b) / 2, "text-anchor": "middle", fill: "#ff9e1b",
      transform: `rotate(-90 12 ${(m.t + height - m.b) / 2})` });
    yt.textContent = yTitle;
    g.append(xt, yt);
    for (const b of background) {
      const c = svg("circle", { cx: sx(b.x), cy: sy(b.y), r: 3, fill: b.color ?? "#5fa8ff", "fill-opacity": 0.75 });
      const title = svg("title");
      title.textContent = b.name;
      c.append(title);
      root.append(c);
    }
    if (points.length > 1) {
      const f = monotone(points.map((p) => p.x), points.map((p) => p.y));
      const x0 = points[0].x, x1 = points[points.length - 1].x;
      let d = "";
      for (let k = 0; k <= 120; k++) {
        const x = x0 + ((x1 - x0) * k) / 120;
        d += `${k ? "L" : "M"}${sx(x).toFixed(1)},${sy(f(x)).toFixed(1)}`;
      }
      root.append(svg("path", { d, fill: "none", stroke: "#ff9e1b", "stroke-width": 2 }));
    }
    points.forEach((p, i) => {
      const gp = svg("g", { class: `dot${i === selected ? " sel" : ""}`, tabindex: 0, role: "slider",
        "aria-label": `${p.label} ${yTitle}`, "aria-valuenow": p.y.toFixed(yDigits) });
      gp.append(svg("circle", { cx: sx(p.x), cy: sy(p.y), r: 12, fill: "transparent" }));
      gp.append(svg("circle", { cx: sx(p.x), cy: sy(p.y), r: 6, fill: "#ffd24d", stroke: "#000", "stroke-width": 1 }));
      // A point may set its own label side (anchor "end" = left of the dot, "start" = right); otherwise end points
      // label inwards and labels of points crowding the previous one go below the dot.
      const anchor = p.anchor ?? (i === 0 ? "start" : i === points.length - 1 ? "end" : "middle");
      const crowded = !p.anchor && i > 0 && i % 2 === 1 && sx(p.x) - sx(points[i - 1].x) < 90;
      const dx = p.anchor === "end" ? -9 : p.anchor === "start" ? 9 : i === 0 ? -4 : i === points.length - 1 ? 4 : 0;
      const lab = svg("text", { x: sx(p.x) + dx, y: sy(p.y) + (crowded ? 20 : p.anchor ? 18 : -11),
        "text-anchor": anchor, fill: "#ffd24d", "font-size": 11,
        "font-family": "IBM Plex Mono, monospace" });
      lab.textContent = `${p.label} ${format(p)}`;
      gp.append(lab);
      gp.addEventListener("pointerdown", (e) => {
        dragging = i; select(i);
        root.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      gp.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        move(i, p.y + (e.key === "ArrowUp" ? step : -step) * (e.shiftKey ? 10 : 1));
        root.querySelectorAll(".dot")[i]?.focus();
      });
      gp.addEventListener("focus", () => { if (selected !== i) { select(i); root.querySelectorAll(".dot")[i]?.focus(); } });
      root.append(gp);
    });
  }

  function select(i) {
    selected = i;
    onSelect?.(i);
    draw();
  }

  function move(i, y) {
    points[i] = { ...points[i], y: Math.round(y / step) * step };
    draw();
    onChange?.(points.map((p) => ({ ...p })), i);
  }

  root.addEventListener("pointermove", (e) => {
    if (dragging < 0) return;
    const pt = root.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const loc = pt.matrixTransform(root.getScreenCTM().inverse());
    move(dragging, Math.min(Math.max(iy(loc.y), range.y0), range.y1));
  });
  const end = () => {
    if (dragging >= 0) { dragging = -1; fitRange(); draw(); }
  };
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", end);

  return {
    node: wrap,
    update(next, bg = background, { keepRange = false, extra = {} } = {}) {
      points = next.map((p) => ({ ...p }));
      background = bg;
      overlay = extra;
      if (!keepRange || !range) fitRange();
      draw();
    },
    select,
  };
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

function defaultTicks(max) {
  const step = niceStep(max / 6);
  const out = [];
  for (let x = 0; x <= max; x += step) out.push(+x.toFixed(6));
  return out;
}
