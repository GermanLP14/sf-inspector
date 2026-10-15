// Gráficos SVG livianos para reportes y dashboards (sin dependencias).
// Colores: paleta categórica validada (slots --viz-1…8, con variante oscura), texto con tokens de texto,
// barras ≤ 24px con extremo redondeado, líneas de 2px, 2px de separación entre segmentos y tooltip en cada marca.
import { esc } from "./ui.js";
import { L, locale } from "../lib/i18n.js";

const numFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
const compactFmt = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
export const compact = (v) => (v == null || Number.isNaN(v) ? "—" : Math.abs(v) < 1000 ? numFmt.format(v) : compactFmt.format(v));

const color = (i) => `var(--viz-${(i % 8) + 1})`;
const FUNNEL = ["#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef"];
const MAX_SLICES = 8;

function niceStep(range, count) {
  const raw = range / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

function ticks(min, max, count = 5) {
  if (min === max) max = min + 1;
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** Recorta un texto para que entre en `px` (aprox. a 11px de fuente). */
function fit(text, px, charPx = 6.4) {
  const s = String(text ?? "");
  const max = Math.max(1, Math.floor(px / charPx));
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

/** Barra vertical: redondeada solo en el extremo de datos (y1), recta en la base (y0). */
function vbar(x, y0, y1, w, round) {
  const top = Math.min(y0, y1);
  const h = Math.abs(y1 - y0);
  const r = round ? Math.min(4, w / 2, h) : 0;
  if (!r) return `M${x},${top}h${w}v${h}h${-w}Z`;
  if (y1 <= y0) return `M${x},${top + h}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${top + h}Z`;
  return `M${x},${top}H${x + w}V${top + h - r}Q${x + w},${top + h} ${x + w - r},${top + h}H${x + r}Q${x},${top + h} ${x},${top + h - r}Z`;
}

/** Barra horizontal: redondeada en el extremo de datos (x1). */
function hbar(x0, x1, y, h, round) {
  const left = Math.min(x0, x1);
  const w = Math.abs(x1 - x0);
  const r = round ? Math.min(4, h / 2, w) : 0;
  if (!r) return `M${left},${y}h${w}v${h}h${-w}Z`;
  if (x1 >= x0) return `M${left},${y}H${left + w - r}Q${left + w},${y} ${left + w},${y + r}V${y + h - r}Q${left + w},${y + h} ${left + w - r},${y + h}H${left}Z`;
  return `M${left + w},${y}H${left + r}Q${left},${y} ${left},${y + r}V${y + h - r}Q${left},${y + h} ${left + r},${y + h}H${left + w}Z`;
}

const arc = (cx, cy, r, a0, a1) => {
  const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return { x0, y0, x1, y1, large: a1 - a0 > Math.PI ? 1 : 0 };
};

function slicePath(cx, cy, r0, r1, a0, a1) {
  if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4;
  const o = arc(cx, cy, r1, a0, a1);
  if (!r0) return `M${cx},${cy}L${o.x0},${o.y0}A${r1},${r1} 0 ${o.large} 1 ${o.x1},${o.y1}Z`;
  const i = arc(cx, cy, r0, a0, a1);
  return `M${o.x0},${o.y0}A${r1},${r1} 0 ${o.large} 1 ${o.x1},${o.y1}L${i.x1},${i.y1}A${r0},${r0} 0 ${o.large} 0 ${i.x0},${i.y0}Z`;
}

/**
 * Dibuja un gráfico dentro de `host` (que debe tener tamaño). Se redibuja solo al cambiar de tamaño.
 * spec: { type: column|bar|line|donut|pie|funnel|metric|gauge,
 *         categories: [string], series: [{ name, values: [number|null], labels?: [string] }],
 *         format?(value, seriesIndex, categoryIndex) → string, valueTitle?, metricLabel?, breakPoints?, min?, max? }
 */
export function renderChart(host, spec) {
  host._chartSpec = spec;
  if (!host._chartObserver) {
    let last = 0;
    host._chartObserver = new ResizeObserver(() => {
      const w = host.clientWidth;
      if (Math.abs(w - last) < 2 && host.firstChild) return;
      last = w;
      draw(host, host._chartSpec);
    });
    host._chartObserver.observe(host);
  }
  draw(host, spec);
}

function draw(host, spec) {
  const W = Math.max(120, host.clientWidth);
  const H = Math.max(120, host.clientHeight || 260);
  const fmt = spec.format || ((v) => compact(v));
  const series = (spec.series || []).filter((s) => s.values?.length);
  const cats = spec.categories || [];
  const type = spec.type || "column";
  if (type === "metric") return drawMetric(host, spec, fmt);
  if (type === "gauge") return drawGauge(host, spec, fmt, W, H);
  if (!cats.length || !series.length) {
    host.innerHTML = `<div class="chart-empty">${esc(L("Sin datos para graficar", "No data to chart"))}</div>`;
    return;
  }
  if (type === "donut" || type === "pie") return drawDonut(host, spec, fmt, W, H, type === "donut");
  if (type === "funnel") return drawFunnel(host, spec, fmt, W, H);
  if (type === "bar") return drawBars(host, spec, fmt, W, H);
  if (type === "line") return drawLine(host, spec, fmt, W, H);
  return drawColumns(host, spec, fmt, W, H);
}

function legendHtml(names) {
  if (names.length < 2) return "";
  return `<div class="chart-legend">${names
    .map((n, i) => `<span><i style="background:${color(i)}"></i>${esc(n)}</span>`)
    .join("")}</div>`;
}

function mount(host, legend, svg, W, H) {
  host.innerHTML = `<div class="chart">${legend}<svg class="chart-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${svg}</svg><div class="chart-tip" hidden></div></div>`;
  return { root: host.firstChild, svg: host.querySelector("svg"), tip: host.querySelector(".chart-tip") };
}

function bindTips(parts, html) {
  const { root, svg, tip } = parts;
  const show = (e, content) => {
    tip.innerHTML = content;
    tip.hidden = false;
    const r = root.getBoundingClientRect();
    let x = e.clientX - r.left + 14;
    let y = e.clientY - r.top + 14;
    if (x + tip.offsetWidth > r.width - 4) x = e.clientX - r.left - tip.offsetWidth - 14;
    if (y + tip.offsetHeight > r.height - 4) y = e.clientY - r.top - tip.offsetHeight - 14;
    tip.style.transform = `translate(${Math.max(0, x)}px, ${Math.max(0, y)}px)`;
  };
  svg.addEventListener("mousemove", (e) => {
    const t = e.target.closest("[data-t]");
    if (!t) return (tip.hidden = true);
    const content = html(t);
    if (content) show(e, content);
  });
  svg.addEventListener("mouseleave", () => (tip.hidden = true));
}

const tipRow = (i, name, value, showSwatch = true) =>
  `<div class="tip-row">${showSwatch ? `<i style="background:${color(i)}"></i>` : ""}<span>${esc(name)}</span><b>${esc(value)}</b></div>`;

/** Ejes y dominio común de columnas/barras/líneas. */
function domain(spec, stacked) {
  const n = spec.categories.length;
  let min = 0;
  let max = 0;
  for (let c = 0; c < n; c++) {
    let pos = 0;
    let neg = 0;
    for (const s of spec.series) {
      const v = Number(s.values[c]) || 0;
      if (stacked) v >= 0 ? (pos += v) : (neg += v);
      else (max = Math.max(max, v)), (min = Math.min(min, v));
    }
    if (stacked) (max = Math.max(max, pos)), (min = Math.min(min, neg));
  }
  return ticks(min, max, 5);
}

function drawColumns(host, spec, fmt, W, H) {
  const series = spec.series;
  const stacked = series.length > 1;
  const legend = legendHtml(series.map((s) => s.name));
  const hLegend = legend ? 26 : 0;
  const t = domain(spec, stacked);
  const yMin = t[0];
  const yMax = t[t.length - 1];
  const left = Math.max(...t.map((v) => compact(v).length)) * 6.6 + 14;
  const m = { l: left, r: 10, t: 12, b: 34 };
  const ph = H - hLegend - m.t - m.b;
  const pw = W - m.l - m.r;
  const y = (v) => m.t + ph - ((v - yMin) / (yMax - yMin)) * ph;
  const band = pw / spec.categories.length;
  const bw = Math.max(3, Math.min(24, band * 0.62));
  const every = Math.max(1, Math.ceil(spec.categories.length / Math.max(1, Math.floor(pw / 64))));
  let svg = t
    .map((v) => `<line class="ch-grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ch-tick" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(compact(v))}</text>`)
    .join("");
  spec.categories.forEach((cat, c) => {
    const x = m.l + band * c + (band - bw) / 2;
    let pos = 0;
    let neg = 0;
    const segs = series.map((s, si) => ({ si, v: Number(s.values[c]) || 0 })).filter((d) => d.v !== 0);
    const lastPos = segs.filter((d) => d.v > 0).pop();
    const lastNeg = segs.filter((d) => d.v < 0).pop();
    segs.forEach((d) => {
      const base = d.v >= 0 ? pos : neg;
      const end = base + d.v;
      let y0 = y(base);
      const y1 = y(end);
      if (stacked && base !== 0) y0 += d.v >= 0 ? -2 : 2; // 2px de separación entre segmentos
      if (d.v >= 0) pos = end;
      else neg = end;
      svg += `<path class="ch-mark" data-t data-c="${c}" data-s="${d.si}" fill="${color(d.si)}" d="${vbar(x, y0, y1, bw, d === lastPos || d === lastNeg)}"/>`;
    });
    svg += `<rect class="ch-hit" data-t data-c="${c}" x="${m.l + band * c}" y="${m.t}" width="${band}" height="${ph}"/>`;
    if (c % every === 0) svg += `<text class="ch-cat" x="${x + bw / 2}" y="${H - hLegend - m.b + 18}" text-anchor="middle">${esc(fit(cat, band * every - 6))}</text>`;
  });
  svg += `<line class="ch-axis" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
  if (!stacked && spec.categories.length <= 12) {
    spec.categories.forEach((_, c) => {
      const v = Number(series[0].values[c]);
      if (!v) return;
      const x = m.l + band * c + band / 2;
      svg += `<text class="ch-val" x="${x}" y="${v >= 0 ? y(v) - 6 : y(v) + 14}" text-anchor="middle">${esc(compact(v))}</text>`;
    });
  }
  const parts = mount(host, legend, svg, W, H - hLegend);
  bindTips(parts, (el) => {
    const c = Number(el.dataset.c);
    return `<div class="tip-title">${esc(spec.categories[c])}</div>${series.map((s, si) => tipRow(si, s.name, fmt(s.values[c], si, c), series.length > 1)).join("")}`;
  });
}

function drawBars(host, spec, fmt, W, H) {
  const series = spec.series;
  const stacked = series.length > 1;
  const legend = legendHtml(series.map((s) => s.name));
  const hLegend = legend ? 26 : 0;
  const t = domain(spec, stacked);
  const xMin = t[0];
  const xMax = t[t.length - 1];
  const labelW = Math.min(150, Math.max(...spec.categories.map((c) => String(c).length)) * 6.4 + 12);
  const m = { l: labelW, r: 46, t: 6, b: 24 };
  const ph = H - hLegend - m.t - m.b;
  const pw = W - m.l - m.r;
  const x = (v) => m.l + ((v - xMin) / (xMax - xMin)) * pw;
  const band = ph / spec.categories.length;
  const bh = Math.max(3, Math.min(24, band * 0.62));
  let svg = t
    .map((v) => `<line class="ch-grid" y1="${m.t}" y2="${m.t + ph}" x1="${x(v)}" x2="${x(v)}"/><text class="ch-tick" y="${H - hLegend - 6}" x="${x(v)}" text-anchor="middle">${esc(compact(v))}</text>`)
    .join("");
  spec.categories.forEach((cat, c) => {
    const yy = m.t + band * c + (band - bh) / 2;
    let pos = 0;
    let neg = 0;
    const segs = series.map((s, si) => ({ si, v: Number(s.values[c]) || 0 })).filter((d) => d.v !== 0);
    const lastPos = segs.filter((d) => d.v > 0).pop();
    const lastNeg = segs.filter((d) => d.v < 0).pop();
    segs.forEach((d) => {
      const base = d.v >= 0 ? pos : neg;
      const end = base + d.v;
      let x0 = x(base);
      if (stacked && base !== 0) x0 += d.v >= 0 ? 2 : -2;
      if (d.v >= 0) pos = end;
      else neg = end;
      svg += `<path class="ch-mark" data-t data-c="${c}" fill="${color(d.si)}" d="${hbar(x0, x(end), yy, bh, d === lastPos || d === lastNeg)}"/>`;
    });
    svg += `<rect class="ch-hit" data-t data-c="${c}" x="0" y="${m.t + band * c}" width="${W}" height="${band}"/>`;
    if (band >= 11) svg += `<text class="ch-cat" x="${m.l - 8}" y="${yy + bh / 2 + 4}" text-anchor="end">${esc(fit(cat, labelW - 12))}</text>`;
    if (!stacked && band >= 14) {
      const v = Number(series[0].values[c]);
      if (v) svg += `<text class="ch-val" x="${x(v) + (v >= 0 ? 6 : -6)}" y="${yy + bh / 2 + 4}" text-anchor="${v >= 0 ? "start" : "end"}">${esc(compact(v))}</text>`;
    }
  });
  svg += `<line class="ch-axis" y1="${m.t}" y2="${m.t + ph}" x1="${x(0)}" x2="${x(0)}"/>`;
  const parts = mount(host, legend, svg, W, H - hLegend);
  bindTips(parts, (el) => {
    const c = Number(el.dataset.c);
    return `<div class="tip-title">${esc(spec.categories[c])}</div>${series.map((s, si) => tipRow(si, s.name, fmt(s.values[c], si, c), series.length > 1)).join("")}`;
  });
}

function drawLine(host, spec, fmt, W, H) {
  const series = spec.series;
  const legend = legendHtml(series.map((s) => s.name));
  const hLegend = legend ? 26 : 0;
  const t = domain(spec, false);
  const yMin = t[0];
  const yMax = t[t.length - 1];
  const m = { l: Math.max(...t.map((v) => compact(v).length)) * 6.6 + 14, r: 16, t: 12, b: 34 };
  const ph = H - hLegend - m.t - m.b;
  const pw = W - m.l - m.r;
  const n = spec.categories.length;
  const x = (c) => m.l + (n === 1 ? pw / 2 : (pw * c) / (n - 1));
  const y = (v) => m.t + ph - ((v - yMin) / (yMax - yMin)) * ph;
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 72))));
  let svg = t
    .map((v) => `<line class="ch-grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ch-tick" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(compact(v))}</text>`)
    .join("");
  spec.categories.forEach((cat, c) => {
    if (c % every === 0) svg += `<text class="ch-cat" x="${x(c)}" y="${H - hLegend - m.b + 18}" text-anchor="middle">${esc(fit(cat, (pw / Math.max(1, n - 1)) * every - 6))}</text>`;
  });
  series.forEach((s, si) => {
    const pts = s.values.map((v, c) => (v == null ? null : [x(c), y(Number(v))]));
    const d = pts.reduce((acc, p, i) => (p ? `${acc}${acc && pts[i - 1] ? "L" : "M"}${p[0]},${p[1]}` : acc), "");
    svg += `<path class="ch-line" stroke="${color(si)}" d="${d}"/>`;
    if (n <= 40) pts.forEach((p) => p && (svg += `<circle class="ch-dot" cx="${p[0]}" cy="${p[1]}" r="4" fill="${color(si)}"/>`));
  });
  svg += `<line class="ch-cross" x1="0" x2="0" y1="${m.t}" y2="${m.t + ph}" opacity="0"/>`;
  spec.categories.forEach((_, c) => {
    const half = n === 1 ? pw / 2 : pw / (n - 1) / 2;
    svg += `<rect class="ch-hit" data-t data-c="${c}" x="${x(c) - half}" y="${m.t}" width="${half * 2}" height="${ph}"/>`;
  });
  const parts = mount(host, legend, svg, W, H - hLegend);
  const cross = parts.svg.querySelector(".ch-cross");
  parts.svg.addEventListener("mouseleave", () => cross.setAttribute("opacity", "0"));
  bindTips(parts, (el) => {
    const c = Number(el.dataset.c);
    cross.setAttribute("opacity", "1");
    cross.setAttribute("x1", x(c));
    cross.setAttribute("x2", x(c));
    return `<div class="tip-title">${esc(spec.categories[c])}</div>${series.map((s, si) => tipRow(si, s.name, fmt(s.values[c], si, c), series.length > 1)).join("")}`;
  });
}

/** Agrupa las porciones chicas en «Otros» (nunca se generan colores nuevos). */
function slices(spec) {
  const vals = spec.categories.map((c, i) => ({ c, i, v: Math.abs(Number(spec.series[0].values[i]) || 0) })).filter((d) => d.v > 0);
  if (vals.length <= MAX_SLICES) return vals;
  const sorted = [...vals].sort((a, b) => b.v - a.v);
  const keep = sorted.slice(0, MAX_SLICES - 1);
  const rest = sorted.slice(MAX_SLICES - 1);
  return [...keep, { c: L("Otros", "Other"), i: -1, v: rest.reduce((s, d) => s + d.v, 0), others: rest.length }];
}

function drawDonut(host, spec, fmt, W, H, donut) {
  const data = slices(spec);
  const total = data.reduce((s, d) => s + d.v, 0);
  if (!total) return (host.innerHTML = `<div class="chart-empty">${esc(L("Sin datos para graficar", "No data to chart"))}</div>`);
  const side = W > H * 1.5;
  const size = side ? Math.min(H - 8, W * 0.5) : Math.min(W, H * 0.62);
  const r1 = size / 2 - 4;
  const r0 = donut ? r1 * 0.62 : 0;
  const cx = size / 2;
  const cy = size / 2;
  let a = -Math.PI / 2;
  let svg = "";
  data.forEach((d, k) => {
    const a1 = a + (d.v / total) * Math.PI * 2;
    svg += `<path class="ch-slice" data-t data-k="${k}" fill="${color(k)}" d="${slicePath(cx, cy, r0, r1, a, a1)}"/>`;
    a = a1;
  });
  if (donut) svg += `<text class="ch-center" x="${cx}" y="${cy + 2}" text-anchor="middle">${esc(compact(total))}</text><text class="ch-center-sub" x="${cx}" y="${cy + 20}" text-anchor="middle">${esc(L("Total", "Total"))}</text>`;
  host.innerHTML = `<div class="chart chart-donut ${side ? "side" : ""}"><svg class="chart-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">${svg}</svg>
    <div class="chart-keys">${data
      .map((d, k) => `<div class="key" data-k="${k}"><i style="background:${color(k)}"></i><span>${esc(d.c)}</span><b>${Math.round((d.v / total) * 100)}%</b></div>`)
      .join("")}</div><div class="chart-tip" hidden></div></div>`;
  const parts = { root: host.firstChild, svg: host.querySelector("svg"), tip: host.querySelector(".chart-tip") };
  bindTips(parts, (el) => {
    const d = data[Number(el.dataset.k)];
    const value = d.i >= 0 ? fmt(spec.series[0].values[d.i], 0, d.i) : compact(d.v);
    return `<div class="tip-title">${esc(d.c)}${d.others ? ` (${d.others})` : ""}</div>${tipRow(0, spec.series[0].name, value, false)}${tipRow(0, "%", `${((d.v / total) * 100).toFixed(1)}%`, false)}`;
  });
}

function drawFunnel(host, spec, fmt, W, H) {
  const vals = spec.categories.map((c, i) => ({ c, i, v: Math.max(0, Number(spec.series[0].values[i]) || 0) }));
  const max = Math.max(...vals.map((d) => d.v)) || 1;
  const labelW = Math.min(150, W * 0.3);
  const pw = W - labelW - 60;
  const band = Math.min(40, (H - 8) / vals.length);
  const bh = band - 2; // 2px de separación entre etapas
  let svg = "";
  vals.forEach((d, k) => {
    const w = Math.max(2, (d.v / max) * pw);
    const x = labelW + (pw - w) / 2;
    const y = 4 + band * k;
    svg += `<rect class="ch-mark" data-t data-k="${k}" x="${x}" y="${y}" width="${w}" height="${bh}" rx="4" fill="${FUNNEL[Math.min(FUNNEL.length - 1, Math.round((k / Math.max(1, vals.length - 1)) * (FUNNEL.length - 1)))]}"/>`;
    svg += `<text class="ch-cat" x="${labelW - 8}" y="${y + bh / 2 + 4}" text-anchor="end">${esc(fit(d.c, labelW - 10))}</text>`;
    svg += `<text class="ch-val" x="${labelW + pw + 8}" y="${y + bh / 2 + 4}">${esc(compact(d.v))}</text>`;
  });
  const parts = mount(host, "", svg, W, Math.max(H, band * vals.length + 8));
  bindTips(parts, (el) => {
    const d = vals[Number(el.dataset.k)];
    return `<div class="tip-title">${esc(d.c)}</div>${tipRow(0, spec.series[0].name, fmt(spec.series[0].values[d.i], 0, d.i), false)}`;
  });
}

function drawMetric(host, spec, fmt) {
  const v = spec.series?.[0]?.values?.[0];
  const label = spec.series?.[0]?.labels?.[0] ?? fmt(v, 0, 0);
  // La cifra se ajusta al ancho del componente: nunca se corta ni se parte en dos líneas.
  const size = Math.max(16, Math.min(48, (host.clientWidth - 16) / (Math.max(4, String(label ?? "—").length) * 0.6)));
  host.innerHTML = `<div class="chart chart-metric"><div class="metric-value" style="font-size:${size.toFixed(1)}px" title="${esc(label)}">${esc(label ?? "—")}</div>${
    spec.metricLabel ? `<div class="metric-label">${esc(spec.metricLabel)}</div>` : ""
  }</div>`;
}

const STATUS = ["var(--danger)", "#f59e0b", "var(--success, #10b981)"];

function drawGauge(host, spec, fmt, W, H) {
  const v = Number(spec.series?.[0]?.values?.[0]) || 0;
  const breaks = spec.breakPoints?.length ? spec.breakPoints : null;
  const min = spec.min ?? (breaks ? breaks[0].lowerBound : 0);
  const max = spec.max ?? (breaks ? breaks[breaks.length - 1].upperBound : Math.max(v * 1.25, 1));
  const r1 = Math.min(W / 2 - 10, H - 40);
  const r0 = r1 * 0.72;
  const cx = W / 2;
  const cy = r1 + 8;
  const ang = (val) => Math.PI + (Math.min(max, Math.max(min, val)) - min) / (max - min || 1) * Math.PI;
  let svg = "";
  if (breaks) {
    breaks.forEach((b, i) => {
      const c = b.color ? `#${String(b.color).replace(/^#/, "")}` : STATUS[i % 3];
      svg += `<path class="ch-band" fill="${c}" d="${slicePath(cx, cy, r0, r1, ang(b.lowerBound), ang(b.upperBound) - 0.012)}"/>`;
    });
  } else {
    svg += `<path class="ch-track" d="${slicePath(cx, cy, r0, r1, Math.PI, Math.PI * 2)}"/>`;
    svg += `<path fill="${color(0)}" d="${slicePath(cx, cy, r0, r1, Math.PI, ang(v))}"/>`;
  }
  const a = ang(v);
  svg += `<line class="ch-needle" x1="${cx}" y1="${cy}" x2="${cx + (r1 + 4) * Math.cos(a)}" y2="${cy + (r1 + 4) * Math.sin(a)}"/><circle class="ch-hub" cx="${cx}" cy="${cy}" r="5"/>`;
  svg += `<text class="ch-tick" x="${cx - r1 + (r1 - r0) / 2}" y="${cy + 16}" text-anchor="middle">${esc(compact(min))}</text><text class="ch-tick" x="${cx + r1 - (r1 - r0) / 2}" y="${cy + 16}" text-anchor="middle">${esc(compact(max))}</text>`;
  const label = spec.series?.[0]?.labels?.[0] ?? fmt(v, 0, 0);
  host.innerHTML = `<div class="chart chart-gauge"><svg class="chart-svg" viewBox="0 0 ${W} ${cy + 24}" width="${W}" height="${cy + 24}" role="img">${svg}</svg><div class="gauge-value">${esc(label)}</div></div>`;
}
