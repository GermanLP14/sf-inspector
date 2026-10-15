// Reports & Dashboards REST API (Salesforce Analytics API).
//
// Reportes:
//  - Ejecutar sin guardar: POST /analytics/reports/query  { reportMetadata }  (vista previa en vivo)
//  - Crear:   POST  /analytics/reports            { reportMetadata: { name, reportType, folderId, … } }
//  - Guardar: PATCH /analytics/reports/{id}       { reportMetadata: { …solo lo que cambia } }
//  - Report types: GET /analytics/reportTypes  y  GET /analytics/reportTypes/{type}
// Dashboards:
//  - Datos:      GET   /analytics/dashboards/{id}[?filter1=…]
//  - Metadata:   GET   /analytics/dashboards/{id}/describe
//  - Refrescar:  PUT   /analytics/dashboards/{id}  →  GET …/status hasta que termine
//  - Guardar:    PATCH /analytics/dashboards/{id}  { dashboardMetadata: { … } }
//  - La API no crea dashboards desde cero: solo los clona (POST /analytics/dashboards?cloneId=…).
import { API_VERSION, soqlEscape } from "./sfapi.js";

const BASE = `/services/data/v${API_VERSION}/analytics`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Propiedades de reportMetadata que se envían al guardar o crear (el resto es de solo lectura). */
const REPORT_WRITABLE = [
  "name",
  "description",
  "reportFormat",
  "detailColumns",
  "groupingsDown",
  "groupingsAcross",
  "aggregates",
  "reportFilters",
  "reportBooleanFilter",
  "standardDateFilter",
  "standardFilters",
  "scope",
  "hasDetailRows",
  "hasRecordCount",
  "showGrandTotal",
  "showSubtotals",
  "sortBy",
  "chart",
  "folderId",
];

export function writableReport(md, { includeType = false } = {}) {
  const out = {};
  for (const k of REPORT_WRITABLE) if (md[k] !== undefined) out[k] = md[k];
  if (includeType) out.reportType = { type: md.reportType.type };
  return out;
}

export const listReports = (api) =>
  api.queryAll("SELECT Id, Name, DeveloperName, FolderName, Format, Description, LastRunDate, LastModifiedDate, LastModifiedBy.Name FROM Report ORDER BY LastModifiedDate DESC");

export const listDashboards = (api) =>
  api.queryAll("SELECT Id, Title, DeveloperName, FolderName, Description, LastModifiedDate, LastModifiedBy.Name FROM Dashboard ORDER BY LastModifiedDate DESC");

/** Carpetas donde el usuario puede tener reportes o dashboards (Type = 'Report' | 'Dashboard'). */
export const listFolders = (api, type) =>
  api.queryAll(`SELECT Id, Name, DeveloperName, AccessType FROM Folder WHERE Type = '${soqlEscape(type)}' ORDER BY Name`);

export const reportTypes = (api) => api.request(`${BASE}/reportTypes`);
export const describeReportType = (api, type) => api.request(`${BASE}/reportTypes/${encodeURIComponent(type)}`);
export const describeReport = (api, id) => api.request(`${BASE}/reports/${encodeURIComponent(id)}/describe`);

export const runReport = (api, reportMetadata, { signal } = {}) =>
  api.request(`${BASE}/reports/query`, { method: "POST", body: { reportMetadata }, signal });

export const createReport = (api, md) => api.request(`${BASE}/reports`, { method: "POST", body: { reportMetadata: writableReport(md, { includeType: true }) } });

export const saveReport = (api, id, md) => api.request(`${BASE}/reports/${encodeURIComponent(id)}`, { method: "PATCH", body: { reportMetadata: writableReport(md) } });

export const deleteReport = (api, id) => api.request(`${BASE}/reports/${encodeURIComponent(id)}`, { method: "DELETE" });

// ───────────────────────────────────────── Dashboards
export function getDashboard(api, id, filters = []) {
  const qs = filters
    .map((v, i) => (v ? `filter${i + 1}=${encodeURIComponent(v)}` : ""))
    .filter(Boolean)
    .join("&");
  return api.request(`${BASE}/dashboards/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`);
}

export const describeDashboard = (api, id) => api.request(`${BASE}/dashboards/${encodeURIComponent(id)}/describe`);

export const saveDashboard = (api, id, dashboardMetadata) =>
  api.request(`${BASE}/dashboards/${encodeURIComponent(id)}`, { method: "PATCH", body: { dashboardMetadata } });

export const deleteDashboard = (api, id) => api.request(`${BASE}/dashboards/${encodeURIComponent(id)}`, { method: "DELETE" });

/** Refresca y espera a que todos los componentes terminen (máx. ~2 min). */
export async function refreshDashboard(api, id, { onProgress } = {}) {
  await api.request(`${BASE}/dashboards/${encodeURIComponent(id)}`, { method: "PUT" });
  const started = Date.now();
  while (Date.now() - started < 120000) {
    await sleep(Date.now() - started < 4000 ? 800 : 2000);
    const st = await api.request(`${BASE}/dashboards/${encodeURIComponent(id)}/status`);
    const comps = st?.componentStatus || [];
    const pending = comps.filter((c) => c.refreshStatus && c.refreshStatus !== "IDLE").length;
    onProgress?.(comps.length - pending, comps.length);
    if (!pending) return;
  }
}

/** Copia un dashboard en una carpeta. Devuelve el Id del nuevo. */
export async function cloneDashboard(api, sourceId, folderId) {
  const r = await api.request(`${BASE}/dashboards?cloneId=${encodeURIComponent(sourceId)}`, { method: "POST", body: folderId ? { folderId } : {} });
  return r?.attributes?.dashboardId || r?.dashboardMetadata?.id || r?.id;
}
