// Exportación de records: Excel (.xlsx), CSV, JSON y TSV (para pegar en una hoja de cálculo).
// El .xlsx se arma a mano (Office Open XML dentro de un ZIP) para no depender de librerías externas.

const enc = new TextEncoder();

// ───────────────────────────────────────── Aplanado de records
/** { Owner: { Name } } → { "Owner.Name": … }; subconsultas → arreglo de records. */
export function flattenRecord(rec, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(rec || {})) {
    if (k === "attributes") continue;
    const key = prefix + k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const compound = "street" in v || "city" in v || "latitude" in v; // address / location
      if (Array.isArray(v.records)) out[key] = v.records.map((r) => stripAttributes(r));
      else if (!compound) flattenRecord(v, key + ".", out); // relación: Owner.Name, RecordType.Name…
      else out[key] = v;
    } else {
      out[key] = v;
    }
  }
  return out;
}

function stripAttributes(rec) {
  const o = {};
  for (const [k, v] of Object.entries(rec || {})) {
    if (k === "attributes") continue;
    o[k] = v && typeof v === "object" && v.attributes ? stripAttributes(v) : v;
  }
  return o;
}

/** Columnas en orden de aparición. Quita "Owner" si sólo es null y existe "Owner.Name". */
export function columnsOf(rows) {
  const cols = [];
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) seen.add(k), cols.push(k);
  return cols.filter((c) => !(cols.some((o) => o.startsWith(c + ".")) && rows.every((r) => r[c] === null || r[c] === undefined)));
}

/** Valor "plano" para celdas de texto. */
export function cellText(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === "object") {
    if ("street" in v || "city" in v) return [v.street, v.city, v.state, v.postalCode, v.country].filter(Boolean).join(", ");
    if ("latitude" in v) return `${v.latitude}, ${v.longitude}`;
    return JSON.stringify(v);
  }
  return String(v);
}

// ───────────────────────────────────────── CSV / TSV / JSON
export function toCsv(cols, rows) {
  const q = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [cols.map(q).join(",")];
  for (const r of rows) lines.push(cols.map((c) => q(cellText(r[c]))).join(","));
  // BOM para que Excel reconozca UTF-8 (acentos, ñ…)
  return new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
}

export function toTsv(cols, rows) {
  const clean = (s) => s.replace(/[\t\r\n]+/g, " ");
  return [cols.join("\t"), ...rows.map((r) => cols.map((c) => clean(cellText(r[c]))).join("\t"))].join("\n");
}

export function toJson(records) {
  return new Blob([JSON.stringify(records.map(stripAttributes), null, 2)], { type: "application/json" });
}

// ───────────────────────────────────────── XLSX
const xmlEsc = (s) =>
  String(s)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const colName = (i) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const excelSerial = (y, m, d, hh = 0, mm = 0, ss = 0) => (Date.UTC(y, m, d, hh, mm, ss) - EXCEL_EPOCH) / 86400000;

function xlsxCell(v, ref) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
  if (typeof v === "boolean") return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === "string" && DATE_RE.test(v)) {
    const [y, m, d] = v.split("-").map(Number);
    return `<c r="${ref}" s="2"><v>${excelSerial(y, m - 1, d)}</v></c>`;
  }
  if (typeof v === "string" && DATETIME_RE.test(v)) {
    const dt = new Date(v); // Salesforce devuelve UTC: lo pasamos a la hora local del usuario
    if (!isNaN(dt)) {
      const serial = excelSerial(dt.getFullYear(), dt.getMonth(), dt.getDate(), dt.getHours(), dt.getMinutes(), dt.getSeconds());
      return `<c r="${ref}" s="3"><v>${serial}</v></c>`;
    }
  }
  const text = cellText(v).slice(0, 32767); // límite de Excel por celda
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`;
}

export async function toXlsx(cols, rows, sheetName = "Records") {
  const name = (sheetName.replace(/[[\]:*?/\\]/g, " ").trim() || "Records").slice(0, 31);
  const widths = cols.map((c) => Math.min(60, Math.max(c.length, ...rows.slice(0, 200).map((r) => cellText(r[c]).length)) + 2));
  const lastRef = `${colName(Math.max(0, cols.length - 1))}${rows.length + 1}`;
  const header = `<row r="1">${cols.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t>${xmlEsc(c)}</t></is></c>`).join("")}</row>`;
  const body = rows
    .map((r, ri) => `<row r="${ri + 2}">${cols.map((c, ci) => xlsxCell(r[c], `${colName(ci)}${ri + 2}`)).join("")}</row>`)
    .join("");

  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const nsR = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${ns} ${nsR}><sheets><sheet name="${xmlEsc(name)}" sheetId="1" r:id="rId1"/></sheets>${
        rows.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xmlEsc(name.replace(/'/g, "''"))}'!$A$1:$${colName(cols.length - 1)}$${rows.length + 1}</definedName></definedNames>` : ""
      }</workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: "xl/styles.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${ns}><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4F46E5"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${ns} ${nsR}><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join("")}</cols><sheetData>${header}${body}</sheetData>${rows.length ? `<autoFilter ref="A1:${lastRef}"/>` : ""}</worksheet>`,
    },
  ];
  return zip(files, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

// ───────────────────────────────────────── ZIP (deflate con CompressionStream nativo)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zip(files, type) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const raw = enc.encode(f.data);
    const deflated = await deflateRaw(raw);
    const method = deflated ? 8 : 0;
    const data = deflated || raw;
    const crc = crc32(raw);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // nombres en UTF-8
    local.setUint16(8, method, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, method, true);
    cen.setUint16(12, dosTime, true);
    cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, raw.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type });
}

// ───────────────────────────────────────── Descarga y consulta completa
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Trae todas las páginas de una query (hasta max) informando el avance. */
export async function fetchAllRecords(api, soql, { tooling = false, max = 100000, onProgress, signal } = {}) {
  let res = await api.query(soql, { tooling, batchSize: 2000, signal });
  const records = [...res.records];
  onProgress?.(records.length, res.totalSize);
  while (!res.done && res.nextRecordsUrl && records.length < max) {
    res = await api.more(res.nextRecordsUrl, { signal });
    records.push(...res.records);
    onProgress?.(records.length, res.totalSize);
  }
  return { records: records.slice(0, max), total: res.totalSize, truncated: records.length >= max && !res.done };
}

/** Exporta los records de una query SOQL en el formato pedido. */
export async function exportQuery(api, soql, format, { baseName = "records", onProgress, max } = {}) {
  const { records, total, truncated } = await fetchAllRecords(api, soql, { onProgress, max });
  const rows = records.map((r) => flattenRecord(r));
  const cols = columnsOf(rows);
  const name = `${baseName}_${fileStamp()}`;
  if (format === "xlsx") download(await toXlsx(cols, rows, baseName), `${name}.xlsx`);
  else if (format === "csv") download(toCsv(cols, rows), `${name}.csv`);
  else if (format === "json") download(toJson(records), `${name}.json`);
  else if (format === "tsv") await navigator.clipboard.writeText(toTsv(cols, rows));
  return { count: records.length, total, truncated };
}
