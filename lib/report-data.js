// Lectura del resultado de un reporte (Analytics API): factMap, agrupaciones y agregados.
//
// Claves del factMap: "<abajo>!<arriba>". "T" es el total. Ejemplos:
//   "T!T" total general · "0!T" primer grupo de filas · "0_1!T" subgrupo · "0!2" celda de matriz · "T!2" total de columna.
import { L } from "./i18n.js";

export const NUMERIC = new Set(["currency", "double", "int", "percent"]);
export const DATE_TYPES = new Set(["date", "datetime"]);

/** Prefijos de los agregados de Salesforce: s! suma, a! promedio, m! mínimo, x! máximo. */
export const AGG_KINDS = [
  ["s", L("Suma", "Sum")],
  ["a", L("Promedio", "Average")],
  ["m", L("Mínimo", "Min")],
  ["x", L("Máximo", "Max")],
];

/** Granularidad de fechas en agrupaciones (valores de la API). */
export const DATE_GRANULARITY = [
  ["Day", L("Día", "Day")],
  ["Week", L("Semana", "Week")],
  ["Month", L("Mes", "Month")],
  ["Quarter", L("Trimestre", "Quarter")],
  ["Year", L("Año", "Year")],
  ["FiscalQuarter", L("Trimestre fiscal", "Fiscal quarter")],
  ["FiscalYear", L("Año fiscal", "Fiscal year")],
];

/** Tipos de gráfico: clave interna → chartType de Salesforce. */
export const CHART_TYPES = [
  ["column", "Column", L("Columnas", "Column")],
  ["bar", "Bar", L("Barras", "Bar")],
  ["line", "Line", L("Línea", "Line")],
  ["donut", "Donut", L("Dona", "Donut")],
  ["pie", "Pie", L("Torta", "Pie")],
  ["funnel", "Funnel", L("Embudo", "Funnel")],
];
export const chartKey = (sfType) => CHART_TYPES.find(([, sf]) => sf.toLowerCase() === String(sfType || "").toLowerCase().replace(/^stacked/, ""))?.[0] || "column";

export function aggregateLabel(result, name) {
  const info = result?.reportExtendedMetadata?.aggregateColumnInfo?.[name];
  if (info?.label) return info.label;
  if (name === "RowCount") return L("Cantidad de registros", "Record Count");
  return name;
}

/** Nodos de un árbol de agrupaciones con su profundidad, en orden de lectura. */
export function walk(groupings, depth = 0, out = []) {
  for (const g of groupings || []) {
    out.push({ ...g, depth });
    walk(g.groupings, depth + 1, out);
  }
  return out;
}

/** Hojas (último nivel) con la ruta completa de etiquetas. */
export function leaves(groupings, path = [], out = []) {
  for (const g of groupings || []) {
    const p = [...path, g.label];
    if (g.groupings?.length) leaves(g.groupings, p, out);
    else out.push({ key: g.key, label: g.label, path: p });
  }
  return out;
}

const MAX_SERIES = 8;

/** Junta las series sobrantes en «Otros» (nunca se generan colores nuevos). */
function capSeries(series) {
  if (series.length <= MAX_SERIES) return series;
  const total = (s) => s.values.reduce((a, v) => a + (Number(v) || 0), 0);
  const sorted = [...series].sort((a, b) => total(b) - total(a));
  const keep = sorted.slice(0, MAX_SERIES - 1);
  const rest = sorted.slice(MAX_SERIES - 1);
  const values = keep[0].values.map((_, i) => rest.reduce((a, s) => a + (Number(s.values[i]) || 0), 0));
  return [...keep, { name: L(`Otros (${rest.length})`, `Other (${rest.length})`), values }];
}

/**
 * Datos para graficar un resultado: categorías = primer nivel de filas; series = columnas de la
 * matriz o el segundo nivel de filas; si no hay agrupaciones, un único valor total.
 */
export function chartData(result, aggregate) {
  const md = result?.reportMetadata || {};
  const aggs = md.aggregates || [];
  const ai = Math.max(0, aggs.indexOf(aggregate ?? aggs[0]));
  const name = aggs[ai] || "RowCount";
  const fm = result?.factMap || {};
  const cell = (k) => fm[k]?.aggregates?.[ai];
  const down = result?.groupingsDown?.groupings || [];
  const across = result?.groupingsAcross?.groupings || [];
  const aggLabel = aggregateLabel(result, name);
  if (!down.length && !across.length) {
    const c = cell("T!T");
    return { categories: [aggLabel], series: [{ name: aggLabel, values: [c?.value ?? null], labels: [c?.label ?? null] }], aggregate: name, aggLabel };
  }
  if (!down.length) {
    return {
      categories: across.map((a) => a.label),
      series: [{ name: aggLabel, values: across.map((a) => cell(`T!${a.key}`)?.value ?? null), labels: across.map((a) => cell(`T!${a.key}`)?.label ?? null) }],
      aggregate: name,
      aggLabel,
    };
  }
  const categories = down.map((d) => d.label);
  let series;
  if (across.length) {
    series = across.map((a) => ({
      name: a.label,
      values: down.map((d) => cell(`${d.key}!${a.key}`)?.value ?? null),
      labels: down.map((d) => cell(`${d.key}!${a.key}`)?.label ?? null),
    }));
  } else if (down.some((d) => d.groupings?.length)) {
    const names = [...new Set(down.flatMap((d) => (d.groupings || []).map((g) => g.label)))];
    series = names.map((n) => {
      const pick = (d) => (d.groupings || []).find((g) => g.label === n);
      return {
        name: n,
        values: down.map((d) => (pick(d) ? cell(`${pick(d).key}!T`)?.value ?? null : null)),
        labels: down.map((d) => (pick(d) ? cell(`${pick(d).key}!T`)?.label ?? null : null)),
      };
    });
  } else {
    series = [{ name: aggLabel, values: down.map((d) => cell(`${d.key}!T`)?.value ?? null), labels: down.map((d) => cell(`${d.key}!T`)?.label ?? null) }];
  }
  return { categories, series: capSeries(series), aggregate: name, aggLabel };
}

/** Formato usando la etiqueta que ya devuelve Salesforce (moneda, %, etc.). */
export const labelFormat = (data) => (v, si, ci) => data.series[si]?.labels?.[ci] ?? (v == null ? "—" : String(v));

/** Formato de reporte según las agrupaciones (igual que Lightning). */
export const formatFor = (md) => (md.groupingsAcross?.length ? "MATRIX" : md.groupingsDown?.length ? "SUMMARY" : "TABULAR");
