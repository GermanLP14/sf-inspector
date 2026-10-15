// Dashboards: vista con datos reales, filtros, refresco y edición (mover, redimensionar, agregar,
// configurar y quitar componentes). Guarda con PATCH dashboardMetadata.
// Los dashboards de Salesforce Classic (layout por columnas) se muestran pero no se editan aquí.
import { getDashboard, describeDashboard, saveDashboard, refreshDashboard, describeReport, runReport, writableReport } from "../lib/analytics.js";
import { chartData, labelFormat, aggregateLabel, leaves, AGG_KINDS } from "../lib/report-data.js";
import { renderChart } from "./charts.js";
import { L } from "../lib/i18n.js";
import { icon, esc, toast, friendlyError, formatDateTime } from "./ui.js";

const VIZ = [
  ["Column", "column", L("Columnas", "Column")],
  ["Bar", "bar", L("Barras", "Bar")],
  ["Line", "line", L("Línea", "Line")],
  ["Donut", "donut", L("Dona", "Donut")],
  ["Pie", "pie", L("Torta", "Pie")],
  ["Funnel", "funnel", L("Embudo", "Funnel")],
  ["Metric", "metric", L("Métrica", "Metric")],
  ["Gauge", "gauge", L("Indicador", "Gauge")],
];
const vizKey = (t) => VIZ.find(([sf]) => sf === t)?.[1] || (t === "Table" || t === "FlexTable" ? "table" : t === "Scatter" ? "column" : "column");
const vizLabel = (t) => VIZ.find(([sf]) => sf === t)?.[2] || t;
const GAUGE_COLORS = ["c23934", "ffb75d", "00716b"];

function defaultVizProps(type, agg) {
  if (type === "Donut" || type === "Pie") return { legendPosition: "bottom", showPercentages: false, showTotal: type === "Donut", showValues: false, combineSmallGroups: false };
  if (type === "Gauge") return { breakPoints: [{ aggregateName: agg, breaks: [] }], showPercentages: false, showTotal: false };
  if (type === "Metric") return {};
  return { legendPosition: "bottom", showValues: false };
}

let uid = 0;

export class DashboardEditor {
  constructor(studio) {
    this.studio = studio;
    this.ctx = studio.ctx;
    this.reportCache = new Map();
  }

  get dirty() {
    return !!this.meta && this.editing && JSON.stringify(this.editable()) !== this.savedJson;
  }

  editable() {
    return { name: this.meta.name, description: this.meta.description, components: this.meta.components, layout: this.meta.layout };
  }

  get grid() {
    return !!this.meta?.layout?.gridLayout;
  }

  // ───────────────────────────────────────── Carga
  async open(id, { edit = false } = {}) {
    this.id = id;
    this.meta = null;
    this.data = new Map();
    this.preview = new Map();
    this.filterSel = [];
    this.editing = false;
    this.sel = null;
    this.studio.setHead(`<button class="icon-btn" data-r="back">${icon("arrow-left")}</button><div class="dh-title"><h3>${esc(L("Cargando dashboard…", "Loading dashboard…"))}</h3></div>`);
    this.studio.el.body.innerHTML = `<div class="anl-loading"><span class="spinner"></span>${esc(L("Leyendo el dashboard y sus componentes…", "Reading the dashboard and its components…"))}</div>`;
    try {
      const [meta, res] = await Promise.all([describeDashboard(this.ctx.api, id), getDashboard(this.ctx.api, id)]);
      this.meta = structuredClone(meta);
      this.meta.components ||= [];
      this.meta.components.forEach((c) => (c._k = c.id || `n${++uid}`));
      this.filterSel = (this.meta.filters || []).map(() => "");
      this.ingest(res);
      this.renderAll();
      if (edit) this.startEdit();
    } catch (e) {
      if (e.status === 401) return this.ctx.sessionExpired();
      this.studio.el.body.innerHTML = `<div class="empty error"><div class="e-ico">${icon("alert")}</div><h3>${esc(L("No se pudo abrir el dashboard", "Could not open the dashboard"))}</h3><p>${esc(
        friendlyError(e)
      )}</p></div>`;
    }
  }

  ingest(res) {
    this.data = new Map((res?.componentData || []).map((d) => [d.componentId, d]));
    this.lastRefresh = (res?.componentData || []).map((d) => d.status?.refreshDate).filter(Boolean).sort().pop() || null;
  }

  async reloadData() {
    try {
      const res = await getDashboard(this.ctx.api, this.id, this.filterSel);
      this.ingest(res);
      this.renderGrid();
      this.renderHead();
    } catch (e) {
      if (e.status === 401) return this.ctx.sessionExpired();
      toast(friendlyError(e), "error");
    }
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = L("Refrescando…", "Refreshing…");
    this.renderHead();
    try {
      await refreshDashboard(this.ctx.api, this.id, {
        onProgress: (done, total) => {
          this.refreshing = L(`Refrescando ${done}/${total}…`, `Refreshing ${done}/${total}…`);
          this.renderHead();
        },
      });
      await this.reloadData();
      toast(L("Dashboard actualizado", "Dashboard refreshed"), "success", 2000);
    } catch (e) {
      if (e.status === 401) return this.ctx.sessionExpired();
      toast(friendlyError(e), "error", 7000);
    } finally {
      this.refreshing = null;
      this.renderHead();
    }
  }

  // ───────────────────────────────────────── Edición
  startEdit() {
    if (!this.grid) return toast(L("Es un dashboard de Salesforce Classic: edítalo en Salesforce.", "It's a Salesforce Classic dashboard: edit it in Salesforce."), "info", 4000);
    this.editing = true;
    this.savedJson = JSON.stringify(this.editable());
    this.backup = structuredClone(this.editable());
    this.renderAll();
  }

  cancelEdit() {
    if (this.dirty && !confirm(L("¿Descartar los cambios del dashboard?", "Discard the dashboard changes?"))) return;
    Object.assign(this.meta, structuredClone(this.backup));
    this.editing = false;
    this.sel = null;
    this.preview.clear();
    this.renderAll();
  }

  changed() {
    this.renderHead();
  }

  serialize(c) {
    const props = { ...(c.properties || {}) };
    const out = { header: c.header || null, footer: c.footer || null, title: c.title || null, reportId: c.reportId, type: c.type || "Report", properties: props };
    if (c.id) out.id = c.id;
    return out;
  }

  async save() {
    if (this.saving) return;
    const name = (this.meta.name || "").trim();
    if (!name) return toast(L("Ponle un nombre al dashboard", "Give the dashboard a name"), "error");
    if (this.ctx.orgKindKey === "prod" && !confirm(L("Estás en PRODUCCIÓN. ¿Guardar el dashboard?", "You're in PRODUCTION. Save the dashboard?"))) return;
    this.saving = true;
    this.renderHead();
    try {
      const comps = this.meta.components;
      const body = {
        name,
        description: this.meta.description || null,
        components: comps.map((c) => this.serialize(c)),
        layout: { ...this.meta.layout, components: comps.map((c) => ({ ...c._pos })) },
      };
      await saveDashboard(this.ctx.api, this.id, body);
      toast(L("Dashboard guardado en la org", "Dashboard saved to the org"), "success");
      this.studio.listsStale = true;
      this.editing = false;
      this.sel = null;
      const hadNew = comps.some((c) => !c.id) || this.preview.size;
      await this.open(this.id);
      if (hadNew) this.refresh(); // los componentes nuevos o cambiados no tienen datos hasta refrescar
    } catch (e) {
      if (e.status === 401) return this.ctx.sessionExpired();
      toast(friendlyError(e), "error", 9000);
    } finally {
      this.saving = false;
      this.renderHead();
    }
  }

  layoutPositions() {
    // El layout guarda las posiciones en el mismo orden que components.
    const pos = this.meta.layout?.components || [];
    this.meta.components.forEach((c, i) => (c._pos ||= { ...(pos[i] || { column: 0, row: 0, colspan: 4, rowspan: 8 }) }));
  }

  minSize() {
    const cols = this.meta.layout.numColumns || 12;
    const rh = this.meta.layout.rowHeight || 36;
    return { colspan: Math.max(1, Math.round(cols / 4)), rowspan: Math.max(2, Math.ceil(140 / rh)) };
  }

  /** Empuja hacia abajo lo que se solape con `moved` (como el editor de Lightning). */
  resolve(moved) {
    const list = this.meta.components.map((c) => c._pos);
    const hit = (a, b) => a.column < b.column + b.colspan && b.column < a.column + a.colspan && a.row < b.row + b.rowspan && b.row < a.row + a.rowspan;
    for (let guard = 0; guard < 200; guard++) {
      let changed = false;
      for (const p of list) {
        if (p === moved) continue;
        for (const q of list) {
          if (q === p || !hit(p, q)) continue;
          const lower = q === moved ? p : p.row >= q.row ? p : q;
          const upper = lower === p ? q : p;
          lower.row = upper.row + upper.rowspan;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  async addComponent() {
    const reports = (await this.studio.lists()).reports;
    this.studio.dialog({
      title: L("Agregar componente", "Add component"),
      body: `<p class="anl-note">${esc(
        L("Salesforce arma los gráficos de dashboards con reportes de resumen o matriz (con agrupaciones).", "Salesforce builds dashboard charts from summary or matrix reports (with groupings).")
      )}</p>
        <label class="sch-search">${icon("search")}<input type="text" data-dlg-q placeholder="${esc(L("Buscar reporte…", "Search report…"))}" autocomplete="off"></label>
        <div class="anl-pick" data-dlg-list>${reports
          .map((r) => {
            const ok = r.Format === "Summary" || r.Format === "Matrix";
            return `<label class="anl-pick-row ${ok ? "" : "off"}" data-q="${esc(`${r.Name} ${r.FolderName || ""}`.toLowerCase())}"><input type="radio" name="reportId" value="${esc(r.Id)}" ${ok ? "" : "disabled"}><span><b>${esc(
              r.Name
            )}</b><em>${esc([r.FolderName, r.Format].filter(Boolean).join(" · "))}</em></span></label>`;
          })
          .join("")}</div>`,
      ok: L("Agregar", "Add"),
      onOpen: (box) => {
        box.querySelector("[data-dlg-q]").addEventListener("input", (e) => {
          const q = e.target.value.trim().toLowerCase();
          box.querySelectorAll("[data-q]").forEach((r) => r.classList.toggle("hidden", !!q && !r.dataset.q.includes(q)));
        });
      },
      onSubmit: async (fd) => {
        const reportId = fd.get("reportId");
        if (!reportId) throw new Error(L("Elige un reporte.", "Pick a report."));
        const d = await this.reportDescribe(String(reportId));
        const md = d.reportMetadata;
        const agg = md.aggregates?.find((a) => a !== "RowCount") || md.aggregates?.[0] || "RowCount";
        const grouping = md.groupingsDown?.[0]?.name || md.groupingsAcross?.[0]?.name;
        if (!grouping) throw new Error(L("Ese reporte no tiene agrupaciones: agrúpalo primero.", "That report has no groupings: group it first."));
        const cols = this.meta.layout.numColumns || 12;
        const bottom = Math.max(0, ...this.meta.components.map((c) => c._pos.row + c._pos.rowspan));
        const min = this.minSize();
        const comp = {
          _k: `n${++uid}`,
          header: md.name,
          footer: null,
          title: null,
          reportId: String(reportId),
          type: "Report",
          properties: {
            aggregates: [{ name: agg }],
            autoSelectColumns: false,
            filterColumns: [],
            groupings: [{ name: grouping, sortAggregate: null, sortOrder: null }],
            maxRows: null,
            sort: null,
            useReportChart: false,
            visualizationProperties: defaultVizProps("Column", agg),
            visualizationType: "Column",
          },
          _pos: { column: 0, row: bottom, colspan: Math.max(min.colspan, Math.round(cols / 2)), rowspan: Math.max(min.rowspan, Math.ceil(300 / (this.meta.layout.rowHeight || 36))) },
        };
        this.meta.components.push(comp);
        this.sel = comp._k;
        this.renderGrid();
        this.renderPanel();
        this.changed();
        this.loadPreview(comp);
        requestAnimationFrame(() => this.root.querySelector(`[data-comp="${comp._k}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
      },
    });
  }

  async reportDescribe(id) {
    if (!this.reportCache.has(id)) this.reportCache.set(id, describeReport(this.ctx.api, id).catch((e) => (this.reportCache.delete(id), Promise.reject(e))));
    return this.reportCache.get(id);
  }

  /** Vista previa real de un componente cambiado: ejecuta su reporte con la agrupación y el valor elegidos. */
  async loadPreview(c) {
    const key = c._k;
    this.preview.set(key, { loading: true });
    this.renderComponent(c);
    try {
      const d = await this.reportDescribe(c.reportId);
      const md = structuredClone(d.reportMetadata);
      const agg = c.properties.aggregates?.[0]?.name || "RowCount";
      const g = c.properties.groupings?.[0]?.name;
      const original = [...(md.groupingsDown || []), ...(md.groupingsAcross || [])].find((x) => x.name === g);
      md.groupingsDown = g ? [original || { name: g, sortOrder: "Asc", dateGranularity: "None" }] : [];
      md.groupingsAcross = [];
      md.aggregates = [...new Set([agg, "RowCount"])];
      md.hasDetailRows = false;
      md.chart = null;
      md.reportFormat = g ? "SUMMARY" : "TABULAR";
      const body = writableReport(md, { includeType: true });
      body.id = c.reportId;
      const result = await runReport(this.ctx.api, body);
      this.preview.set(key, { result });
    } catch (e) {
      if (e.status === 401) return this.ctx.sessionExpired();
      this.preview.set(key, { error: friendlyError(e) });
    }
    this.renderComponent(c);
  }

  // ───────────────────────────────────────── Render
  renderAll() {
    if (!this.meta) return;
    this.layoutPositions();
    const filters = this.meta.filters || [];
    this.root = this.studio.mountView(`<div class="dsh ${this.editing ? "editing" : ""}">
      <div class="dsh-main">
        ${
          filters.length
            ? `<div class="dsh-filters">${filters
                .map(
                  (f, i) => `<label class="field dsh-filter">${icon("filter")}<span>${esc(f.name)}</span><select data-dfilter="${i}"><option value="">${esc(L("Todos", "All"))}</option>${(f.options || [])
                    .map((o) => `<option value="${esc(o.id)}" ${this.filterSel[i] === o.id ? "selected" : ""}>${esc(o.alias || o.value || o.id)}</option>`)
                    .join("")}</select></label>`
                )
                .join("")}</div>`
            : ""
        }
        ${!this.grid ? `<div class="ide-banner warn">${icon("info")}<span>${esc(L("Dashboard de Salesforce Classic (por columnas): se puede ver y refrescar, pero se edita en Salesforce.", "Salesforce Classic dashboard (column layout): you can view and refresh it, but it's edited in Salesforce."))}</span></div>` : ""}
        <div class="dsh-grid-wrap"><div class="dsh-grid" data-grid></div></div>
      </div>
      <aside class="dsh-panel" data-panel></aside>
    </div>`);
    this.bindBody();
    this.renderHead();
    this.renderGrid();
    this.renderPanel();
  }

  renderHead() {
    if (!this.meta) return;
    const dirty = this.dirty;
    const by = this.meta.runningUser?.displayName;
    const state = this.saving
      ? `<span class="ide-pill busy"><span class="spinner"></span>${esc(L("Guardando…", "Saving…"))}</span>`
      : this.refreshing
        ? `<span class="ide-pill busy"><span class="spinner"></span>${esc(this.refreshing)}</span>`
        : this.editing
          ? `<span class="ide-pill ${dirty ? "dirty" : "ok"}">${icon(dirty ? "pencil" : "check-circle")}${esc(dirty ? L("Cambios sin guardar", "Unsaved changes") : L("Modo edición", "Edit mode"))}</span>`
          : "";
    this.studio.setHead(`
      <button class="icon-btn" data-r="back" title="${esc(L("Volver a la lista", "Back to the list"))}">${icon("arrow-left")}</button>
      <div class="rh-ico" style="--c:#0d9488">${icon("gauge")}</div>
      <div class="dh-title anl-title">
        ${
          this.editing
            ? `<input class="anl-name" data-d-name value="${esc(this.meta.name || "")}" maxlength="80" spellcheck="false">`
            : `<h3>${esc(this.meta.name || "")}</h3>`
        }
        <p>${esc(
          [
            `${this.meta.components.length} ${L("componentes", "components")}`,
            by && L(`ver como ${by}`, `view as ${by}`),
            this.lastRefresh && L(`actualizado ${formatDateTime(this.lastRefresh)}`, `refreshed ${formatDateTime(this.lastRefresh)}`),
          ]
            .filter(Boolean)
            .join(" · ")
        )}</p>
      </div>
      ${state}
      <div class="ide-actions">
        ${
          this.editing
            ? `<button class="ghost-btn" data-d="add">${icon("plus")}<span>${esc(L("Componente", "Component"))}</span></button>
               <button class="ghost-btn" data-d="cancel">${esc(L("Cancelar", "Cancel"))}</button>
               <button class="primary-btn sm" data-d="save" ${dirty && !this.saving ? "" : "disabled"}>${icon("upload")}<span>${esc(L("Guardar", "Save"))}</span></button>`
            : `<button class="icon-btn" data-d="refresh" ${this.refreshing ? "disabled" : ""} title="${esc(L("Refrescar datos en Salesforce", "Refresh data in Salesforce"))}">${icon("refresh")}</button>
               <a class="icon-btn" data-sf href="${esc(this.ctx.url(`/lightning/r/Dashboard/${this.id}/view`))}" title="${esc(L("Abrir en Salesforce", "Open in Salesforce"))}">${icon("external")}</a>
               <button class="ghost-btn" data-d="clone">${icon("copy")}<span>${esc(L("Copiar", "Copy"))}</span></button>
               <button class="primary-btn sm" data-d="edit" ${this.grid ? "" : "disabled"}>${icon("pencil")}<span>${esc(L("Editar", "Edit"))}</span></button>`
        }
        <button class="icon-btn" data-r="close" title="${esc(L("Cerrar", "Close"))}">${icon("x")}</button>
      </div>`);
  }

  onHeadClick(b) {
    const a = b.dataset.d;
    if (a === "refresh") this.refresh();
    if (a === "edit") this.startEdit();
    if (a === "cancel") this.cancelEdit();
    if (a === "save") this.save();
    if (a === "add") this.addComponent();
    if (a === "clone") this.studio.newDashboard({ from: this.id, name: `${this.meta.name} (2)` });
  }

  onHeadInput(e) {
    if (e.target.matches("[data-d-name]")) {
      this.meta.name = e.target.value;
      const btn = this.studio.el.head.querySelector('[data-d="save"]');
      if (btn) btn.disabled = !this.dirty;
    }
  }

  renderGrid() {
    const grid = this.root.querySelector("[data-grid]");
    if (!grid) return;
    const lay = this.meta.layout || {};
    if (this.grid) {
      grid.className = "dsh-grid";
      grid.style.setProperty("--cols", lay.numColumns || 12);
      grid.style.setProperty("--rowh", `${lay.rowHeight || 36}px`);
      grid.innerHTML = this.meta.components
        .map((c) => `<div class="dsh-comp ${this.sel === c._k ? "sel" : ""}" data-comp="${c._k}" style="grid-column:${c._pos.column + 1} / span ${c._pos.colspan};grid-row:${c._pos.row + 1} / span ${c._pos.rowspan}"></div>`)
        .join("");
      if (!this.meta.components.length)
        grid.innerHTML = `<div class="dsh-empty">${icon("gauge")}<b>${esc(L("Dashboard vacío", "Empty dashboard"))}</b><span>${esc(
          this.editing ? L("Agrega componentes con el botón «Componente».", "Add components with the “Component” button.") : L("Edítalo para agregar componentes.", "Edit it to add components.")
        )}</span></div>`;
    } else {
      grid.className = "dsh-columns";
      grid.innerHTML = (lay.columns || [])
        .map((col) => `<div class="dsh-col">${(col.components || []).map((i) => `<div class="dsh-comp classic" data-comp="${this.meta.components[i]?._k}"></div>`).join("")}</div>`)
        .join("");
    }
    this.meta.components.forEach((c) => this.renderComponent(c));
  }

  renderComponent(c) {
    const el = this.root.querySelector(`[data-comp="${c._k}"]`);
    if (!el) return;
    const viz = c.properties?.visualizationType;
    const pv = this.preview.get(c._k);
    const data = pv ? pv.result && { reportResult: pv.result } : this.data.get(c.id);
    el.innerHTML = `<div class="dsh-comp-head">
        <div class="dsh-comp-title"><b>${esc(c.header || c.title || L("Sin título", "Untitled"))}</b>${c.title && c.header ? `<span>${esc(c.title)}</span>` : ""}</div>
        ${
          this.editing
            ? `<span class="dsh-comp-acts"><button type="button" data-c="edit" title="${esc(L("Configurar", "Configure"))}">${icon("pencil")}</button><button type="button" data-c="del" title="${esc(L("Quitar", "Remove"))}">${icon("x")}</button></span>`
            : c.reportId
              ? `<a class="dsh-comp-link" data-sf href="${esc(this.ctx.url(`/lightning/r/Report/${c.reportId}/view`))}" title="${esc(L("Ver el reporte en Salesforce", "View the report in Salesforce"))}">${icon("external")}</a>`
              : ""
        }
      </div>
      <div class="dsh-comp-body" data-body></div>
      ${c.footer ? `<div class="dsh-comp-foot">${esc(c.footer)}</div>` : ""}
      ${this.editing ? `<span class="dsh-resize" data-c="resize" title="${esc(L("Redimensionar", "Resize"))}"></span>` : ""}`;
    const body = el.querySelector("[data-body]");
    if (pv?.loading) return (body.innerHTML = `<div class="anl-loading sm"><span class="spinner"></span></div>`);
    if (pv?.error) return (body.innerHTML = `<div class="dsh-msg err">${icon("alert")}<span>${esc(pv.error)}</span></div>`);
    if (!data?.reportResult) {
      const err = data?.status?.errorMessage;
      body.innerHTML = `<div class="dsh-msg">${icon(err ? "alert" : "clock")}<span>${esc(
        err || (c.id ? L("Sin datos todavía: refresca el dashboard.", "No data yet: refresh the dashboard.") : L("Guarda para ver los datos.", "Save to see the data."))
      )}</span></div>`;
      return;
    }
    const r = data.reportResult;
    const agg = c.properties?.aggregates?.[0]?.name;
    const kind = vizKey(viz);
    if (kind === "table") return (body.innerHTML = this.tableHtml(r));
    const cd = chartData(r, agg);
    if (kind === "metric" || kind === "gauge") {
      const md = r.reportMetadata || {};
      const ai = Math.max(0, (md.aggregates || []).indexOf(agg ?? md.aggregates?.[0]));
      const t = r.factMap?.["T!T"]?.aggregates?.[ai];
      const breaks = c.properties?.visualizationProperties?.breakPoints?.[0]?.breaks || [];
      return renderChart(body, {
        type: kind,
        categories: [cd.aggLabel],
        series: [{ name: cd.aggLabel, values: [t?.value ?? null], labels: [t?.label ?? null] }],
        metricLabel: aggregateLabel(r, md.aggregates?.[ai]),
        breakPoints: breaks.length ? breaks : null,
      });
    }
    renderChart(body, { type: kind, ...cd, format: labelFormat(cd) });
  }

  tableHtml(r) {
    const rows = leaves(r.groupingsDown?.groupings);
    const names = r.reportMetadata?.aggregates || [];
    if (!rows.length) {
      const detail = r.factMap?.["T!T"]?.rows || [];
      const cols = r.reportMetadata?.detailColumns || [];
      return `<div class="dsh-table"><table class="grid"><thead><tr>${cols.map((c) => `<th>${esc(r.reportExtendedMetadata?.detailColumnInfo?.[c]?.label || c)}</th>`).join("")}</tr></thead><tbody>${detail
        .slice(0, 50)
        .map((row) => `<tr>${row.dataCells.map((d) => `<td>${esc(d.label)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></div>`;
    }
    return `<div class="dsh-table"><table class="grid"><thead><tr><th></th>${names.map((n) => `<th class="num">${esc(aggregateLabel(r, n))}</th>`).join("")}</tr></thead><tbody>${rows
      .map((g) => `<tr><td>${esc(g.path.join(" › "))}</td>${(r.factMap?.[`${g.key}!T`]?.aggregates || []).map((a) => `<td class="num">${esc(a.label)}</td>`).join("")}</tr>`)
      .join("")}</tbody></table></div>`;
  }

  bindBody() {
    const body = this.root;
    body.addEventListener("change", (e) => {
      const f = e.target.closest("[data-dfilter]");
      if (f) {
        this.filterSel[Number(f.dataset.dfilter)] = f.value;
        return this.reloadData();
      }
      if (e.target.closest("[data-panel]")) this.onPanelChange(e);
    });
    body.addEventListener("input", (e) => {
      if (e.target.closest("[data-panel]") && e.target.matches("input[data-p]")) this.onPanelChange(e);
    });
    body.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-c]");
      const comp = e.target.closest("[data-comp]");
      if (btn && comp) {
        const c = this.comp(comp.dataset.comp);
        if (btn.dataset.c === "del") {
          this.meta.components = this.meta.components.filter((x) => x !== c);
          if (this.sel === c._k) this.sel = null;
          this.renderGrid();
          this.renderPanel();
          return this.changed();
        }
        if (btn.dataset.c === "edit") return this.select(c._k);
      }
      if (this.editing && comp && !e.target.closest("a, button")) return this.select(comp.dataset.comp);
      const p = e.target.closest("[data-pa]");
      if (p) this.onPanelClick(p);
    });
    body.addEventListener("pointerdown", (e) => this.onPointerDown(e));
  }

  comp(k) {
    return this.meta.components.find((c) => c._k === k);
  }

  select(k) {
    this.sel = k;
    this.root.querySelectorAll("[data-comp]").forEach((el) => el.classList.toggle("sel", el.dataset.comp === k));
    this.renderPanel();
  }

  // Arrastrar para mover (desde el encabezado) o redimensionar (desde la esquina).
  onPointerDown(e) {
    if (!this.editing || e.button !== 0) return;
    const comp = e.target.closest("[data-comp]");
    const resize = e.target.closest('[data-c="resize"]');
    if (!comp || (!resize && !e.target.closest(".dsh-comp-head")) || e.target.closest("button, a")) return;
    const c = this.comp(comp.dataset.comp);
    const grid = this.root.querySelector("[data-grid]");
    const lay = this.meta.layout;
    const cols = lay.numColumns || 12;
    const rect = grid.getBoundingClientRect();
    const gap = 12;
    const cellW = (rect.width + gap) / cols;
    const cellH = (lay.rowHeight || 36) + gap;
    const start = { x: e.clientX, y: e.clientY, ...c._pos };
    const min = this.minSize();
    comp.classList.add(resize ? "resizing" : "dragging");
    e.preventDefault();
    const move = (ev) => {
      const dc = Math.round((ev.clientX - start.x) / cellW);
      const dr = Math.round((ev.clientY - start.y) / cellH);
      if (resize) {
        c._pos.colspan = Math.min(cols - c._pos.column, Math.max(min.colspan, start.colspan + dc));
        c._pos.rowspan = Math.max(min.rowspan, start.rowspan + dr);
      } else {
        c._pos.column = Math.min(cols - c._pos.colspan, Math.max(0, start.column + dc));
        c._pos.row = Math.max(0, start.row + dr);
      }
      comp.style.gridColumn = `${c._pos.column + 1} / span ${c._pos.colspan}`;
      comp.style.gridRow = `${c._pos.row + 1} / span ${c._pos.rowspan}`;
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      comp.classList.remove("resizing", "dragging");
      this.resolve(c._pos);
      this.renderGrid();
      this.changed();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  // ───────────────────────────────────────── Panel de configuración del componente
  async renderPanel() {
    const box = this.root.querySelector("[data-panel]");
    if (!box) return;
    const c = this.editing && this.sel && this.comp(this.sel);
    box.classList.toggle("open", !!c);
    if (!c) return (box.innerHTML = "");
    const p = c.properties || {};
    const viz = p.visualizationType;
    const reports = (await this.studio.lists()).reports;
    box.innerHTML = `<div class="dsh-p-head"><b>${esc(L("Componente", "Component"))}</b><button type="button" class="icon-btn" data-pa="close">${icon("x")}</button></div>
      <div class="dsh-p-body">
        <label class="ide-fld"><span>${esc(L("Encabezado", "Header"))}</span><input data-p="header" value="${esc(c.header || "")}" maxlength="80"></label>
        <label class="ide-fld"><span>${esc(L("Título", "Title"))} <em>${esc(L("(opcional)", "(optional)"))}</em></span><input data-p="title" value="${esc(c.title || "")}" maxlength="80"></label>
        <label class="ide-fld"><span>${esc(L("Pie", "Footer"))} <em>${esc(L("(opcional)", "(optional)"))}</em></span><input data-p="footer" value="${esc(c.footer || "")}" maxlength="255"></label>
        <div class="ide-fld"><span>${esc(L("Visualización", "Visualization"))}</span><div class="rpt-chips">${VIZ.map(
          ([sf, , l]) => `<button type="button" class="rpt-chip ${viz === sf ? "on" : ""}" data-pa="viz" data-v="${sf}">${esc(l)}</button>`
        ).join("")}${viz === "Table" || viz === "FlexTable" || viz === "Scatter" ? `<span class="rpt-chip on">${esc(vizLabel(viz))}</span>` : ""}</div></div>
        <label class="ide-fld"><span>${esc(L("Reporte origen", "Source report"))}</span><select data-p="reportId">${reports
          .filter((r) => r.Id === c.reportId || r.Format === "Summary" || r.Format === "Matrix")
          .map((r) => `<option value="${esc(r.Id)}" ${r.Id === c.reportId ? "selected" : ""}>${esc(r.Name)}${r.FolderName ? ` — ${esc(r.FolderName)}` : ""}</option>`)
          .join("")}</select></label>
        <div data-p-report><div class="anl-loading sm"><span class="spinner"></span></div></div>
      </div>`;
    try {
      const d = await this.reportDescribe(c.reportId);
      if (this.sel !== c._k) return;
      const md = d.reportMetadata;
      const groups = [...(md.groupingsDown || []), ...(md.groupingsAcross || [])];
      const typeCols = Object.assign({}, ...(d.reportTypeMetadata?.categories || []).map((cat) => cat.columns || {}));
      const label = (n) => d.reportExtendedMetadata?.groupingColumnInfo?.[n]?.label || d.reportExtendedMetadata?.detailColumnInfo?.[n]?.label || typeCols[n]?.label || n;
      const aggs = [...new Set([...(md.aggregates || []), "RowCount"])];
      const aggLabel = (n) => {
        if (n === "RowCount") return L("Cantidad de registros", "Record Count");
        const [k, col] = n.split("!");
        return d.reportExtendedMetadata?.aggregateColumnInfo?.[n]?.label || `${AGG_KINDS.find(([x]) => x === k)?.[1] || k}: ${label(col)}`;
      };
      const g = p.groupings?.[0]?.name;
      const a = p.aggregates?.[0]?.name;
      const gauge = viz === "Gauge" ? p.visualizationProperties?.breakPoints?.[0]?.breaks || [] : null;
      box.querySelector("[data-p-report]").innerHTML = `
        <label class="ide-fld"><span>${esc(L("Valor", "Value"))}</span><select data-p="agg">${aggs.map((n) => `<option value="${esc(n)}" ${n === a ? "selected" : ""}>${esc(aggLabel(n))}</option>`).join("")}</select></label>
        ${
          viz !== "Metric" && viz !== "Gauge"
            ? `<label class="ide-fld"><span>${esc(L("Agrupado por", "Grouped by"))}</span><select data-p="grouping">${groups
                .map((x) => `<option value="${esc(x.name)}" ${x.name === g ? "selected" : ""}>${esc(label(x.name))}</option>`)
                .join("")}</select></label>`
            : ""
        }
        ${
          gauge
            ? `<div class="ide-fld"><span>${esc(L("Rangos del indicador", "Gauge ranges"))}</span><div class="dsh-gauge-in">
                ${[0, 1, 2, 3]
                  .map((i) => {
                    const v = i === 0 ? gauge[0]?.lowerBound : gauge[i - 1]?.upperBound;
                    return `<input type="number" data-p="gb" data-i="${i}" value="${v ?? ""}" placeholder="${esc([L("mín", "min"), L("rojo→", "red→"), L("amarillo→", "yellow→"), L("máx", "max")][i])}">`;
                  })
                  .join("")}</div></div>`
            : ""
        }
        <div class="rpt-hint">${esc(L("Los cambios se previsualizan con datos reales; se guardan en Salesforce al pulsar «Guardar».", "Changes preview with real data; they're saved to Salesforce when you press “Save”."))}</div>`;
    } catch (e) {
      box.querySelector("[data-p-report]").innerHTML = `<div class="dsh-msg err">${icon("alert")}<span>${esc(friendlyError(e))}</span></div>`;
    }
  }

  onPanelClick(el) {
    const c = this.sel && this.comp(this.sel);
    if (el.dataset.pa === "close") return this.select(null);
    if (!c) return;
    if (el.dataset.pa === "viz") {
      const t = el.dataset.v;
      const agg = c.properties.aggregates?.[0]?.name || "RowCount";
      c.properties.visualizationType = t;
      c.properties.visualizationProperties = defaultVizProps(t, agg);
      if (t === "Metric" || t === "Gauge") c.properties.groupings = [];
      else if (!c.properties.groupings?.length) {
        this.reportDescribe(c.reportId).then((d) => {
          const name = d.reportMetadata.groupingsDown?.[0]?.name || d.reportMetadata.groupingsAcross?.[0]?.name;
          if (name) c.properties.groupings = [{ name, sortAggregate: null, sortOrder: null }];
          this.loadPreview(c);
        });
      }
      this.renderComponent(c);
      this.renderPanel();
      this.changed();
      if (c.properties.groupings?.length || t === "Metric" || t === "Gauge") this.loadPreview(c);
    }
  }

  async onPanelChange(e) {
    const c = this.sel && this.comp(this.sel);
    const el = e.target;
    if (!c || !el.dataset.p) return;
    const k = el.dataset.p;
    if (k === "header" || k === "title" || k === "footer") {
      c[k] = el.value || null;
      const t = this.root.querySelector(`[data-comp="${c._k}"] .dsh-comp-title`);
      if (t) t.innerHTML = `<b>${esc(c.header || c.title || L("Sin título", "Untitled"))}</b>${c.title && c.header ? `<span>${esc(c.title)}</span>` : ""}`;
      if (k === "footer") this.renderComponent(c);
      return this.changed();
    }
    if (e.type === "input") return;
    if (k === "reportId") {
      c.reportId = el.value;
      const d = await this.reportDescribe(c.reportId).catch(() => null);
      const md = d?.reportMetadata || {};
      const agg = md.aggregates?.find((a) => a !== "RowCount") || "RowCount";
      const g = md.groupingsDown?.[0]?.name || md.groupingsAcross?.[0]?.name;
      c.properties.aggregates = [{ name: agg }];
      c.properties.groupings = g && c.properties.visualizationType !== "Metric" && c.properties.visualizationType !== "Gauge" ? [{ name: g, sortAggregate: null, sortOrder: null }] : [];
      c.properties.visualizationProperties = defaultVizProps(c.properties.visualizationType, agg);
      this.renderPanel();
    }
    if (k === "agg") {
      c.properties.aggregates = [{ name: el.value }];
      const bp = c.properties.visualizationProperties?.breakPoints?.[0];
      if (bp) bp.aggregateName = el.value;
    }
    if (k === "grouping") c.properties.groupings = [{ name: el.value, sortAggregate: null, sortOrder: null }];
    if (k === "gb") {
      const vals = [...this.root.querySelectorAll('[data-p="gb"]')].map((i) => (i.value === "" ? null : Number(i.value)));
      if (vals.every((v) => v != null)) {
        if (!(vals[0] < vals[1] && vals[1] < vals[2] && vals[2] < vals[3])) return toast(L("Los rangos deben ir de menor a mayor", "Ranges must go from low to high"), "error");
        c.properties.visualizationProperties.breakPoints = [
          { aggregateName: c.properties.aggregates?.[0]?.name, breaks: [0, 1, 2].map((i) => ({ color: GAUGE_COLORS[i], lowerBound: vals[i], upperBound: vals[i + 1] })) },
        ];
      }
    }
    this.changed();
    this.loadPreview(c);
  }
}
