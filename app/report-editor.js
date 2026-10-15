// Editor de reportes: diseño (agrupaciones, columnas, totales, filtros, gráfico) con vista previa en vivo.
// La vista previa usa /analytics/reports/query, que ejecuta sin guardar; solo «Guardar» cambia la org.
import { describeReport, describeReportType, runReport, createReport, saveReport, writableReport } from "../lib/analytics.js";
import { NUMERIC, DATE_TYPES, AGG_KINDS, DATE_GRANULARITY, CHART_TYPES, chartKey, aggregateLabel, walk, leaves, chartData, labelFormat, formatFor } from "../lib/report-data.js";
import { renderChart } from "./charts.js";
import { L, locale } from "../lib/i18n.js";
import { icon, esc, toast, friendlyError, highlight, debounce } from "./ui.js";

// Límites de Salesforce para reportes.
const MAX_DOWN = 3;
const MAX_DOWN_MATRIX = 2;
const MAX_ACROSS = 2;
const MAX_COLUMNS = 100;
const MAX_FILTERS = 20;
const MAX_NAME = 40;
const SF_ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const FORMAT_LABEL = { TABULAR: L("Tabular", "Tabular"), SUMMARY: L("Resumen", "Summary"), MATRIX: L("Matriz", "Matrix"), MULTI_BLOCK: L("Combinado", "Joined") };
const fmtN = (n) => Number(n).toLocaleString(locale);

export class ReportEditor {
  constructor(studio) {
    this.studio = studio;
    this.ctx = studio.ctx;
    this.scheduleRun = debounce(() => this.run(), 450);
  }

  get dirty() {
    return !!this.md && (!this.id || JSON.stringify(this.md) !== this.savedJson);
  }

  get format() {
    return formatFor(this.md);
  }

  // ───────────────────────────────────────── Carga
  async open(id) {
    this.reset({ id });
    try {
      const d = await describeReport(this.ctx.api, id);
      if (d.reportMetadata?.reportFormat === "MULTI_BLOCK") return this.renderUnsupported(d.reportMetadata);
      this.load(d);
      this.savedJson = JSON.stringify(this.md);
      this.renderAll();
      this.run();
    } catch (e) {
      this.fail(e);
    }
  }

  async create(type) {
    this.reset({ id: null });
    try {
      const d = await describeReportType(this.ctx.api, type);
      this.load(d);
      const label = this.md.reportType?.label || type;
      this.md.name = `${label} ${L("— nuevo", "— new")}`.slice(0, MAX_NAME);
      delete this.md.id;
      delete this.md.developerName;
      this.md.folderId = undefined;
      this.renderAll();
      this.run();
    } catch (e) {
      this.fail(e);
    }
  }

  reset({ id }) {
    this.id = id;
    this.md = null;
    this.result = null;
    this.error = null;
    this.savedJson = null;
    this.tab = "design";
    this.pick = null; // { mode: "column" | "down" | "across" | "filter" }
    this.fieldQ = "";
    this.collapsed = new Set();
    this.abort?.abort();
    this.studio.setHead(`<button class="icon-btn" data-r="back">${icon("arrow-left")}</button><div class="dh-title"><h3>${esc(L("Cargando reporte…", "Loading report…"))}</h3></div>`);
    this.studio.el.body.innerHTML = `<div class="anl-loading"><span class="spinner"></span>${esc(L("Leyendo el reporte y su report type…", "Reading the report and its report type…"))}</div>`;
  }

  load(d) {
    const md = structuredClone(d.reportMetadata || {});
    md.detailColumns ||= [];
    md.groupingsDown ||= [];
    md.groupingsAcross ||= [];
    md.aggregates ||= ["RowCount"];
    md.reportFilters ||= [];
    md.sortBy ||= [];
    this.md = md;
    this.rt = d.reportTypeMetadata || {};
    this.cols = new Map();
    for (const cat of this.rt.categories || []) for (const [name, c] of Object.entries(cat.columns || {})) this.cols.set(name, { ...c, name, category: cat.label });
    this.ext = d.reportExtendedMetadata || {};
    this.chart = md.chart ? { type: chartKey(md.chart.chartType), agg: md.chart.summaries?.[0] || md.aggregates[0] } : null;
  }

  fail(e) {
    if (e.status === 401) return this.ctx.sessionExpired();
    this.studio.el.body.innerHTML = `<div class="empty error"><div class="e-ico">${icon("alert")}</div><h3>${esc(L("No se pudo abrir el reporte", "Could not open the report"))}</h3><p>${esc(
      friendlyError(e)
    )}</p></div>`;
  }

  renderUnsupported(md) {
    this.md = null;
    this.studio.setHead(`<button class="icon-btn" data-r="back">${icon("arrow-left")}</button><div class="dh-title"><h3>${esc(md.name)}</h3><p>${esc(FORMAT_LABEL.MULTI_BLOCK)}</p></div>
      <div class="ide-actions"><a class="ghost-btn" data-sf href="${esc(this.ctx.url(`/lightning/r/Report/${this.id}/view`))}">${icon("external")}<span>${esc(L("Abrir en Salesforce", "Open in Salesforce"))}</span></a></div>`);
    this.studio.el.body.innerHTML = `<div class="empty"><div class="e-ico">${icon("info")}</div><h3>${esc(L("Reporte combinado (joined)", "Joined report"))}</h3><p>${esc(
      L("La API de Salesforce no permite editar ni ejecutar reportes combinados desde fuera de la interfaz. Ábrelo en Salesforce.", "Salesforce's API can't edit or run joined reports outside its UI. Open it in Salesforce.")
    )}</p></div>`;
  }

  colLabel(name) {
    return this.cols.get(name)?.label || this.result?.reportExtendedMetadata?.detailColumnInfo?.[name]?.label || this.ext?.detailColumnInfo?.[name]?.label || name;
  }

  colType(name) {
    return this.cols.get(name)?.dataType || this.result?.reportExtendedMetadata?.detailColumnInfo?.[name]?.dataType || "string";
  }

  // ───────────────────────────────────────── Cambios (con las reglas de Salesforce)
  changed({ rerun = true } = {}) {
    this.md.reportFormat = this.format;
    if (this.format === "TABULAR") this.md.chart = null;
    else if (this.chart) {
      const agg = this.md.aggregates.includes(this.chart.agg) ? this.chart.agg : this.md.aggregates[0] || "RowCount";
      this.chart.agg = agg;
      this.md.chart = {
        chartType: CHART_TYPES.find(([k]) => k === this.chart.type)[1],
        groupings: [this.md.groupingsDown[0]?.name || this.md.groupingsAcross[0]?.name].filter(Boolean),
        summaries: [agg],
        summaryAxisLocations: ["Y"],
        hasLegend: true,
        showChartValues: false,
        title: null,
      };
    } else this.md.chart = null;
    this.renderHead();
    this.renderSide();
    if (rerun) this.scheduleRun();
  }

  isUsed(name) {
    const m = this.md;
    return m.detailColumns.includes(name) || m.groupingsDown.some((g) => g.name === name) || m.groupingsAcross.some((g) => g.name === name);
  }

  addColumn(name) {
    const m = this.md;
    if (m.detailColumns.includes(name)) return toast(L("Esa columna ya está en el reporte", "That column is already in the report"), "info", 1800);
    if (m.groupingsDown.some((g) => g.name === name) || m.groupingsAcross.some((g) => g.name === name))
      return toast(L("Ese campo ya se usa como agrupación", "That field is already used as a grouping"), "info", 2200);
    if (m.detailColumns.length >= MAX_COLUMNS) return toast(L(`Salesforce admite hasta ${MAX_COLUMNS} columnas`, `Salesforce allows up to ${MAX_COLUMNS} columns`), "error");
    m.detailColumns.push(name);
    this.changed();
  }

  addGroup(name, axis) {
    const m = this.md;
    const down = axis === "down";
    const list = down ? m.groupingsDown : m.groupingsAcross;
    if (m.groupingsDown.some((g) => g.name === name) || m.groupingsAcross.some((g) => g.name === name)) return toast(L("Ese campo ya agrupa el reporte", "That field already groups the report"), "info", 2000);
    if (NUMERIC.has(this.colType(name)) && !this.cols.get(name)?.isLookup) {
      // Salesforce no agrupa por números/moneda (salvo con buckets).
      return toast(L("Salesforce no permite agrupar por campos numéricos o de moneda", "Salesforce doesn't allow grouping by numeric or currency fields"), "error");
    }
    if (down) {
      const max = m.groupingsAcross.length ? MAX_DOWN_MATRIX : MAX_DOWN;
      if (list.length >= max)
        return toast(
          m.groupingsAcross.length
            ? L(`En formato matriz se admiten hasta ${MAX_DOWN_MATRIX} agrupaciones de filas`, `Matrix format allows up to ${MAX_DOWN_MATRIX} row groupings`)
            : L(`Se admiten hasta ${MAX_DOWN} agrupaciones de filas`, `Up to ${MAX_DOWN} row groupings are allowed`),
          "error"
        );
    } else {
      if (list.length >= MAX_ACROSS) return toast(L(`Se admiten hasta ${MAX_ACROSS} agrupaciones de columnas`, `Up to ${MAX_ACROSS} column groupings are allowed`), "error");
      if (m.groupingsDown.length > MAX_DOWN_MATRIX)
        return toast(L(`Para agrupar columnas (matriz) deja como máximo ${MAX_DOWN_MATRIX} agrupaciones de filas`, `To group columns (matrix), keep at most ${MAX_DOWN_MATRIX} row groupings`), "error");
    }
    list.push({ name, sortOrder: "Asc", dateGranularity: DATE_TYPES.has(this.colType(name)) ? "Month" : "None", sortAggregate: null });
    m.detailColumns = m.detailColumns.filter((c) => c !== name); // Salesforce no repite el campo agrupado como columna
    this.changed();
  }

  addFilter(name) {
    const m = this.md;
    if (m.reportFilters.length >= MAX_FILTERS) return toast(L(`Salesforce admite hasta ${MAX_FILTERS} filtros de campo`, `Salesforce allows up to ${MAX_FILTERS} field filters`), "error");
    if (this.cols.get(name)?.filterable === false) return toast(L("Ese campo no se puede filtrar", "That field can't be filtered"), "error");
    const ops = this.operators(name);
    m.reportFilters.push({ column: name, operator: ops[0]?.name || "equals", value: "" });
    this.tab = "design";
    this.changed({ rerun: false });
    requestAnimationFrame(() => this.root.querySelector(`[data-filter="${m.reportFilters.length - 1}"] [data-fv]`)?.focus());
  }

  operators(name) {
    const map = this.rt.dataTypeFilterOperatorMap || {};
    const t = this.colType(name);
    return map[t] || map[t === "picklist" ? "string" : "string"] || [{ name: "equals", label: "equals" }];
  }

  // ───────────────────────────────────────── Ejecutar (vista previa)
  async run() {
    if (!this.md) return;
    this.abort?.abort();
    const ctrl = (this.abort = new AbortController());
    this.running = true;
    this.renderStatus();
    try {
      const body = writableReport(this.md, { includeType: true });
      if (this.id) body.id = this.id;
      const r = await runReport(this.ctx.api, body, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      this.result = r;
      this.error = null;
    } catch (e) {
      if (e.name === "AbortError") return;
      if (e.status === 401) return this.ctx.sessionExpired();
      this.error = friendlyError(e);
    } finally {
      if (this.abort === ctrl) {
        this.running = false;
        this.renderResults();
      }
    }
  }

  // ───────────────────────────────────────── Guardar
  async save({ as = false } = {}) {
    if (!this.md || this.saving) return;
    const name = (this.md.name || "").trim();
    if (!name) return toast(L("Ponle un nombre al reporte", "Give the report a name"), "error");
    if (!this.id || as) return this.saveDialog({ as });
    if (this.ctx.orgKindKey === "prod" && !confirm(L("Estás en PRODUCCIÓN. ¿Guardar los cambios del reporte?", "You're in PRODUCTION. Save the report changes?"))) return;
    this.saving = true;
    this.renderHead();
    try {
      const r = await saveReport(this.ctx.api, this.id, this.md);
      if (r?.reportMetadata?.folderId) this.md.folderId = r.reportMetadata.folderId;
      this.savedJson = JSON.stringify(this.md);
      this.studio.listsStale = true;
      toast(L("Reporte guardado en la org", "Report saved to the org"), "success");
    } catch (e) {
      if (e.status === 401) return this.ctx.sessionExpired();
      toast(friendlyError(e), "error", 8000);
    } finally {
      this.saving = false;
      this.renderHead();
    }
  }

  async saveDialog({ as }) {
    const folders = await this.studio.folders("Report");
    const own = [
      { id: this.ctx.userId, name: L("Mis reportes privados", "My private reports") },
      { id: this.ctx.session.orgId, name: L("Reportes públicos", "Public reports") },
    ].filter((f) => f.id);
    const current = as ? null : this.md.folderId;
    this.studio.dialog({
      title: as ? L("Guardar como reporte nuevo", "Save as a new report") : L("Guardar reporte", "Save report"),
      body: `<label class="ide-fld"><span>${esc(L("Nombre", "Name"))} <em>${esc(L(`(máx. ${MAX_NAME})`, `(max ${MAX_NAME})`))}</em></span>
          <input name="name" maxlength="${MAX_NAME}" value="${esc(as ? `${this.md.name} (2)`.slice(0, MAX_NAME) : this.md.name)}" autocomplete="off"></label>
        <label class="ide-fld"><span>${esc(L("Descripción", "Description"))} <em>${esc(L("(opcional)", "(optional)"))}</em></span><input name="description" maxlength="255" value="${esc(this.md.description || "")}" autocomplete="off"></label>
        <label class="ide-fld"><span>${esc(L("Carpeta", "Folder"))}</span><select name="folderId">${[...own, ...folders]
          .map((f) => `<option value="${esc(f.id)}" ${f.id === current ? "selected" : ""}>${esc(f.name)}</option>`)
          .join("")}</select></label>`,
      ok: L("Guardar en la org", "Save to org"),
      onSubmit: async (fd) => {
        const name = String(fd.get("name") || "").trim();
        if (!name) throw new Error(L("Escribe un nombre.", "Enter a name."));
        if (this.ctx.orgKindKey === "prod" && !confirm(L("Estás en PRODUCCIÓN. ¿Crear el reporte?", "You're in PRODUCTION. Create the report?"))) return false;
        const md = { ...this.md, name, description: String(fd.get("description") || "").trim() || null, folderId: String(fd.get("folderId")) };
        const r = await createReport(this.ctx.api, md);
        const id = r?.reportMetadata?.id;
        if (!id) throw new Error(L("Salesforce no devolvió el Id del reporte.", "Salesforce didn't return the report Id."));
        this.id = id;
        this.md = { ...md, id, developerName: r.reportMetadata.developerName };
        this.savedJson = JSON.stringify(this.md);
        this.studio.listsStale = true;
        toast(L(`Reporte «${name}» creado`, `Report “${name}” created`), "success");
        this.renderHead();
      },
    });
  }

  // ───────────────────────────────────────── Render
  renderAll() {
    this.root = this.studio.mountView(`<div class="rpt">
      <aside class="rpt-side">
        <div class="rpt-tabs"><button type="button" data-tab="design">${icon("layers")}<span>${esc(L("Diseño", "Design"))}</span></button><button type="button" data-tab="fields">${icon(
          "list"
        )}<span>${esc(L("Campos", "Fields"))}</span><b>${this.cols.size}</b></button></div>
        <div class="rpt-side-body" data-side></div>
      </aside>
      <section class="rpt-main">
        <div class="rpt-status" data-status></div>
        <div class="rpt-scroll" data-results></div>
      </section>
    </div>`);
    this.bindBody();
    this.renderHead();
    this.renderSide();
    this.renderResults();
  }

  renderHead() {
    if (!this.md) return;
    const dirty = this.dirty;
    const folder = this.result?.reportMetadata?.folderId === this.ctx.userId ? L("Privado", "Private") : null;
    const state = this.saving
      ? `<span class="ide-pill busy"><span class="spinner"></span>${esc(L("Guardando…", "Saving…"))}</span>`
      : !this.id
        ? `<span class="ide-pill dirty">${icon("sparkle")}${esc(L("Sin guardar (nuevo)", "Unsaved (new)"))}</span>`
        : dirty
          ? `<span class="ide-pill dirty">${icon("pencil")}${esc(L("Cambios sin guardar", "Unsaved changes"))}</span>`
          : `<span class="ide-pill ok">${icon("check-circle")}${esc(L("Guardado", "Saved"))}</span>`;
    this.studio.setHead(`
      <button class="icon-btn" data-r="back" title="${esc(L("Volver a la lista", "Back to the list"))}">${icon("arrow-left")}</button>
      <div class="rh-ico" style="--c:#059669">${icon("bar-chart")}</div>
      <div class="dh-title anl-title">
        <input class="anl-name" data-r-name value="${esc(this.md.name || "")}" maxlength="${MAX_NAME}" spellcheck="false" title="${esc(L("Nombre del reporte (click para editar)", "Report name (click to edit)"))}">
        <p>${esc([this.md.reportType?.label, FORMAT_LABEL[this.format], folder].filter(Boolean).join(" · "))}</p>
      </div>
      ${state}
      <div class="ide-actions">
        <button class="icon-btn" data-r="run" title="${esc(L("Volver a ejecutar", "Run again"))}">${icon("refresh")}</button>
        ${this.id ? `<a class="icon-btn" data-sf href="${esc(this.ctx.url(`/lightning/r/Report/${this.id}/view`))}" title="${esc(L("Abrir en Salesforce", "Open in Salesforce"))}">${icon("external")}</a>` : ""}
        ${this.id ? `<button class="ghost-btn" data-r="save-as">${icon("copy")}<span>${esc(L("Guardar como", "Save as"))}</span></button>` : ""}
        <button class="primary-btn sm" data-r="save" ${(this.id && !dirty) || this.saving ? "disabled" : ""}>${icon("upload")}<span>${esc(L("Guardar", "Save"))}</span></button>
        <button class="icon-btn" data-r="close" title="${esc(L("Cerrar", "Close"))}">${icon("x")}</button>
      </div>`);
  }

  bindBody() {
    const body = this.root;
    body.addEventListener("click", (e) => this.onClick(e));
    body.addEventListener("change", (e) => this.onChange(e));
    body.addEventListener("input", (e) => {
      if (e.target.matches("[data-field-q]")) {
        this.fieldQ = e.target.value;
        this.renderFieldList();
      }
      if (e.target.matches("[data-fv]")) this.onChange(e, { typing: true });
    });
  }

  onHeadClick(b) {
    const a = b.dataset.r;
    if (a === "run") this.run();
    if (a === "save") this.save();
    if (a === "save-as") this.save({ as: true });
  }

  onHeadInput(e) {
    if (e.target.matches("[data-r-name]") && this.md) {
      this.md.name = e.target.value.slice(0, MAX_NAME);
      const btn = this.studio.el.head.querySelector('[data-r="save"]');
      if (btn) btn.disabled = !!this.id && !this.dirty;
    }
  }

  onClick(e) {
    const m = this.md;
    if (!m) return;
    const t = e.target.closest("[data-tab]");
    if (t) {
      this.tab = t.dataset.tab;
      if (this.tab === "design") this.pick = null;
      return this.renderSide();
    }
    const a = e.target.closest("[data-a]");
    if (!a) return;
    const { a: act, i, name, axis } = a.dataset;
    const idx = Number(i);
    switch (act) {
      case "pick":
        this.pick = { mode: a.dataset.mode };
        this.tab = "fields";
        return this.renderSide();
      case "cancel-pick":
        this.pick = null;
        this.tab = "design";
        return this.renderSide();
      case "field": {
        const mode = a.dataset.mode || this.pick?.mode || "column";
        this.pick = null;
        if (mode === "column") this.addColumn(name);
        else if (mode === "down" || mode === "across") this.addGroup(name, mode);
        else if (mode === "filter") this.addFilter(name);
        if (mode !== "column") this.tab = "design";
        return this.renderSide();
      }
      case "col-up":
      case "col-down": {
        const j = idx + (act === "col-up" ? -1 : 1);
        if (j < 0 || j >= m.detailColumns.length) return;
        [m.detailColumns[idx], m.detailColumns[j]] = [m.detailColumns[j], m.detailColumns[idx]];
        return this.changed();
      }
      case "col-del": {
        const col = m.detailColumns[idx];
        m.detailColumns.splice(idx, 1);
        m.aggregates = m.aggregates.filter((g) => !g.endsWith(`!${col}`));
        m.sortBy = m.sortBy.filter((s) => s.sortColumn !== col);
        return this.changed();
      }
      case "agg": {
        const key = `${a.dataset.kind}!${name}`;
        m.aggregates = m.aggregates.includes(key) ? m.aggregates.filter((g) => g !== key) : [...m.aggregates.filter((g) => g !== "RowCount"), key, "RowCount"];
        return this.changed();
      }
      case "grp-del":
        (axis === "down" ? m.groupingsDown : m.groupingsAcross).splice(idx, 1);
        return this.changed();
      case "grp-sort": {
        const g = (axis === "down" ? m.groupingsDown : m.groupingsAcross)[idx];
        g.sortOrder = String(g.sortOrder).toLowerCase() === "asc" ? "Desc" : "Asc";
        return this.changed();
      }
      case "flt-del":
        m.reportFilters.splice(idx, 1);
        if (m.reportFilters.length < 2) m.reportBooleanFilter = null;
        return this.changed();
      case "chart-on":
        this.chart = this.chart ? null : { type: "column", agg: m.aggregates[0] || "RowCount" };
        return this.changed({ rerun: false }) || this.renderResults();
      case "chart-type":
        this.chart.type = a.dataset.type;
        this.changed({ rerun: false });
        return this.renderResults();
      case "sort": {
        const cur = m.sortBy[0];
        m.sortBy = [{ sortColumn: name, sortOrder: cur?.sortColumn === name && cur.sortOrder === "Asc" ? "Desc" : "Asc" }];
        return this.changed();
      }
      case "toggle-cat":
        this.collapsed.has(name) ? this.collapsed.delete(name) : this.collapsed.add(name);
        return this.renderFieldList();
    }
  }

  onChange(e, { typing = false } = {}) {
    const m = this.md;
    if (!m) return;
    const el = e.target;
    const f = el.closest("[data-filter]");
    if (f) {
      const flt = m.reportFilters[Number(f.dataset.filter)];
      if (el.matches("[data-fo]")) flt.operator = el.value;
      if (el.matches("[data-fv]")) flt.value = el.value;
      if (typing) return this.scheduleRunIfValid();
      return this.changed();
    }
    const g = el.closest("[data-grp]");
    if (g && el.matches("[data-gran]")) {
      const [axis, i] = g.dataset.grp.split(":");
      (axis === "down" ? m.groupingsDown : m.groupingsAcross)[Number(i)].dateGranularity = el.value;
      return this.changed();
    }
    const k = el.dataset.k;
    if (!k) return;
    if (k === "scope") m.scope = el.value;
    if (k === "logic") {
      m.reportBooleanFilter = el.value.trim() || null;
      if (typing) return;
    }
    if (k === "date-col" || k === "date-dur" || k === "date-start" || k === "date-end") {
      m.standardDateFilter ||= { column: null, durationValue: "CUSTOM", startDate: null, endDate: null };
      const sd = m.standardDateFilter;
      if (k === "date-col") sd.column = el.value;
      if (k === "date-dur") {
        sd.durationValue = el.value;
        const d = this.durations().find((x) => x.value === el.value);
        if (d && el.value !== "CUSTOM") Object.assign(sd, { startDate: d.startDate || null, endDate: d.endDate || null });
      }
      if (k === "date-start") sd.startDate = el.value || null;
      if (k === "date-end") sd.endDate = el.value || null;
    }
    if (k === "details") m.hasDetailRows = el.checked;
    if (k === "subtotals") m.showSubtotals = el.checked;
    if (k === "grandtotal") m.showGrandTotal = el.checked;
    if (k === "chart-agg" && this.chart) {
      this.chart.agg = el.value;
      this.changed({ rerun: false });
      return this.renderResults();
    }
    this.changed();
  }

  scheduleRunIfValid() {
    this.renderHead();
    this.scheduleRun();
  }

  durations() {
    return (this.rt.standardDateFilterDurationGroups || []).flatMap((g) => (g.standardDateFilterDurations || []).map((d) => ({ ...d, group: g.label })));
  }

  renderSide() {
    const box = this.root.querySelector("[data-side]");
    if (!box || !this.md) return;
    this.root.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === this.tab));
    if (this.tab === "fields") {
      const modeText = {
        column: L("Elige un campo para agregarlo como columna", "Pick a field to add it as a column"),
        down: L("Elige un campo para agrupar filas", "Pick a field to group rows"),
        across: L("Elige un campo para agrupar columnas (matriz)", "Pick a field to group columns (matrix)"),
        filter: L("Elige un campo para filtrar", "Pick a field to filter by"),
      };
      box.innerHTML = `${
        this.pick
          ? `<div class="rpt-pick">${icon("target")}<span>${esc(modeText[this.pick.mode])}</span><button type="button" class="ide-x-link" data-a="cancel-pick">${esc(L("Cancelar", "Cancel"))}</button></div>`
          : ""
      }<label class="sch-search rpt-search">${icon("search")}<input type="text" data-field-q value="${esc(this.fieldQ)}" placeholder="${esc(L("Buscar campo…", "Search field…"))}" spellcheck="false" autocomplete="off"></label>
        <div class="rpt-fields" data-fields></div>`;
      this.renderFieldList();
      box.querySelector("[data-field-q]").focus();
      return;
    }
    box.innerHTML = this.designHtml();
  }

  renderFieldList() {
    const box = this.root.querySelector("[data-fields]");
    if (!box) return;
    const q = this.fieldQ.trim();
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const groups = new Map();
    for (const c of this.cols.values()) {
      if (tokens.length && !tokens.every((t) => `${c.label} ${c.name} ${c.category}`.toLowerCase().includes(t))) continue;
      if (this.pick?.mode === "filter" && c.filterable === false) continue;
      if (!groups.has(c.category)) groups.set(c.category, []);
      groups.get(c.category).push(c);
    }
    const mode = this.pick?.mode;
    box.innerHTML = groups.size
      ? [...groups.entries()]
          .map(([cat, list]) => {
            const open = tokens.length || !this.collapsed.has(cat);
            return `<div class="rpt-cat ${open ? "open" : ""}">
              <button type="button" class="rpt-cat-head" data-a="toggle-cat" data-name="${esc(cat)}">${icon("chevron-right", "ide-chev")}<span>${esc(cat)}</span><b>${list.length}</b></button>
              ${
                open
                  ? list
                      .map((c) => {
                        const used = this.isUsed(c.name);
                        return `<div class="rpt-field ${used ? "used" : ""}">
                          <button type="button" class="rpt-field-main" data-a="field" data-name="${esc(c.name)}" ${mode ? `data-mode="${mode}"` : ""} title="${esc(`${c.label}\n${c.name}`)}">
                            <span class="rpt-type t-${esc(c.dataType)}">${esc(typeShort(c.dataType))}</span>
                            <span class="rpt-field-label">${highlight(c.label, q)}</span>
                            ${used ? `<span class="rpt-used">${icon("check")}</span>` : ""}
                          </button>
                          ${
                            mode
                              ? ""
                              : `<span class="rpt-field-acts">
                              <button type="button" data-a="field" data-mode="down" data-name="${esc(c.name)}" title="${esc(L("Agrupar filas", "Group rows"))}">${icon("rows")}</button>
                              <button type="button" data-a="field" data-mode="filter" data-name="${esc(c.name)}" title="${esc(L("Filtrar", "Filter"))}" ${c.filterable === false ? "disabled" : ""}>${icon("filter")}</button>
                            </span>`
                          }
                        </div>`;
                      })
                      .join("")
                  : ""
              }
            </div>`;
          })
          .join("")
      : `<div class="sch-none">${esc(L("Ningún campo coincide", "No field matches"))}</div>`;
  }

  designHtml() {
    const m = this.md;
    const fmt = this.format;
    const grp = (axis) => {
      const list = axis === "down" ? m.groupingsDown : m.groupingsAcross;
      const max = axis === "down" ? (m.groupingsAcross.length ? MAX_DOWN_MATRIX : MAX_DOWN) : MAX_ACROSS;
      return `${list
        .map(
          (g, i) => `<div class="rpt-item" data-grp="${axis}:${i}">
            <span class="rpt-item-label">${esc(this.colLabel(g.name))}</span>
            ${
              DATE_TYPES.has(this.colType(g.name))
                ? `<select data-gran class="rpt-mini">${DATE_GRANULARITY.map(([v, l]) => `<option value="${v}" ${g.dateGranularity === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`
                : ""
            }
            <button type="button" class="rpt-ic" data-a="grp-sort" data-axis="${axis}" data-i="${i}" title="${esc(L("Orden", "Sort order"))}">${icon(String(g.sortOrder).toLowerCase() === "desc" ? "arrow-up" : "chevron-down")}</button>
            <button type="button" class="rpt-ic del" data-a="grp-del" data-axis="${axis}" data-i="${i}" title="${esc(L("Quitar", "Remove"))}">${icon("x")}</button>
          </div>`
        )
        .join("")}${
        list.length < max ? `<button type="button" class="rpt-add" data-a="pick" data-mode="${axis}">${icon("plus")}<span>${esc(axis === "down" ? L("Agrupar filas", "Group rows") : L("Agrupar columnas", "Group columns"))}</span></button>` : `<div class="rpt-limit">${esc(L(`Máximo ${max}`, `Max ${max}`))}</div>`
      }`;
    };
    const cols = m.detailColumns
      .map((c, i) => {
        const numeric = NUMERIC.has(this.colType(c));
        const aggs = AGG_KINDS.filter(([k]) => m.aggregates.includes(`${k}!${c}`));
        return `<div class="rpt-item col">
          <span class="rpt-type t-${esc(this.colType(c))}">${esc(typeShort(this.colType(c)))}</span>
          <span class="rpt-item-label">${esc(this.colLabel(c))}</span>
          <span class="rpt-item-acts">
            <button type="button" class="rpt-ic" data-a="col-up" data-i="${i}" ${i === 0 ? "disabled" : ""} title="${esc(L("Subir", "Move up"))}">${icon("arrow-up")}</button>
            <button type="button" class="rpt-ic" data-a="col-down" data-i="${i}" ${i === m.detailColumns.length - 1 ? "disabled" : ""} title="${esc(L("Bajar", "Move down"))}">${icon("chevron-down")}</button>
            <button type="button" class="rpt-ic del" data-a="col-del" data-i="${i}" title="${esc(L("Quitar", "Remove"))}">${icon("x")}</button>
          </span>
          ${
            numeric
              ? `<div class="rpt-aggs">${AGG_KINDS.map(
                  ([k, l]) => `<button type="button" class="rpt-agg ${aggs.some(([x]) => x === k) ? "on" : ""}" data-a="agg" data-kind="${k}" data-name="${esc(c)}">${esc(l)}</button>`
                ).join("")}</div>`
              : ""
          }
        </div>`;
      })
      .join("");
    const scope = this.rt.scopeInfo?.values?.length
      ? `<label class="rpt-row"><span>${esc(L("Mostrar", "Show me"))}</span><select data-k="scope">${this.rt.scopeInfo.values
          .map((v) => `<option value="${esc(v.value)}" ${v.value === (m.scope || this.rt.scopeInfo.defaultValue) ? "selected" : ""}>${esc(v.label)}</option>`)
          .join("")}</select></label>`
      : "";
    const dateCols = [...this.cols.values()].filter((c) => DATE_TYPES.has(c.dataType));
    const sd = m.standardDateFilter;
    const durations = this.durations();
    const dateFilter =
      dateCols.length && durations.length
        ? `<div class="rpt-date">
          <label class="rpt-row"><span>${esc(L("Fecha", "Date"))}</span><select data-k="date-col">${dateCols
            .map((c) => `<option value="${esc(c.name)}" ${sd?.column === c.name ? "selected" : ""}>${esc(c.label)}</option>`)
            .join("")}</select></label>
          <label class="rpt-row"><span>${esc(L("Rango", "Range"))}</span><select data-k="date-dur">${(this.rt.standardDateFilterDurationGroups || [])
            .map(
              (g) =>
                `<optgroup label="${esc(g.label || L("Personalizado", "Custom"))}">${(g.standardDateFilterDurations || [])
                  .map((d) => `<option value="${esc(d.value)}" ${sd?.durationValue === d.value ? "selected" : ""}>${esc(d.label)}</option>`)
                  .join("")}</optgroup>`
            )
            .join("")}</select></label>
          ${
            !sd || sd.durationValue === "CUSTOM"
              ? `<div class="rpt-row two"><input type="date" data-k="date-start" value="${esc(sd?.startDate || "")}" title="${esc(L("Desde", "From"))}"><input type="date" data-k="date-end" value="${esc(
                  sd?.endDate || ""
                )}" title="${esc(L("Hasta", "To"))}"></div>`
              : `<div class="rpt-hint">${esc([sd.startDate, sd.endDate].filter(Boolean).join(" → "))}</div>`
          }
        </div>`
        : "";
    const filters = m.reportFilters
      .map((f, i) => {
        const col = this.cols.get(f.column);
        const values = col?.filterValues || [];
        return `<div class="rpt-filter" data-filter="${i}">
          <div class="rpt-filter-head"><b>${i + 1}</b><span>${esc(this.colLabel(f.column))}</span><button type="button" class="rpt-ic del" data-a="flt-del" data-i="${i}">${icon("x")}</button></div>
          <div class="rpt-row two">
            <select data-fo>${this.operators(f.column).map((o) => `<option value="${esc(o.name)}" ${o.name === f.operator ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>
            ${
              values.length
                ? `<select data-fv><option value="">—</option>${values.map((v) => `<option value="${esc(v.name)}" ${v.name === f.value ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select>`
                : `<input data-fv value="${esc(f.value ?? "")}" placeholder="${esc(DATE_TYPES.has(this.colType(f.column)) ? "AAAA-MM-DD / THIS_MONTH" : L("Valor (varios: separados por coma)", "Value (several: comma-separated)"))}" autocomplete="off">`
            }
          </div>
        </div>`;
      })
      .join("");
    const chartBlock =
      fmt === "TABULAR"
        ? `<div class="rpt-hint">${esc(L("Agrupa filas para poder agregar un gráfico.", "Group rows to add a chart."))}</div>`
        : `<label class="rpt-switch"><input type="checkbox" data-a="chart-on" ${this.chart ? "checked" : ""}><span class="track"></span><span>${esc(L("Mostrar gráfico", "Show chart"))}</span></label>${
            this.chart
              ? `<div class="rpt-chips">${CHART_TYPES.map(([k, , l]) => `<button type="button" class="rpt-chip ${this.chart.type === k ? "on" : ""}" data-a="chart-type" data-type="${k}">${esc(l)}</button>`).join("")}</div>
                <label class="rpt-row"><span>${esc(L("Valor", "Value"))}</span><select data-k="chart-agg">${m.aggregates
                  .map((g) => `<option value="${esc(g)}" ${g === this.chart.agg ? "selected" : ""}>${esc(this.aggLabel(g))}</option>`)
                  .join("")}</select></label>`
              : ""
          }`;
    return `
      <div class="rpt-sec"><div class="rpt-sec-title">${esc(L("Formato", "Format"))}<span class="rpt-format f-${fmt.toLowerCase()}">${esc(FORMAT_LABEL[fmt])}</span></div>
        <div class="rpt-hint">${esc(L("Lo define Salesforce según las agrupaciones: sin agrupar = tabular, filas = resumen, columnas = matriz.", "Set by the groupings: none = tabular, rows = summary, columns = matrix."))}</div></div>
      <div class="rpt-sec"><div class="rpt-sec-title">${esc(L("Agrupar filas", "Group rows"))}<b>${m.groupingsDown.length}</b></div>${grp("down")}</div>
      <div class="rpt-sec"><div class="rpt-sec-title">${esc(L("Agrupar columnas", "Group columns"))}<b>${m.groupingsAcross.length}</b></div>${grp("across")}</div>
      <div class="rpt-sec"><div class="rpt-sec-title">${esc(L("Columnas", "Columns"))}<b>${m.detailColumns.length}</b></div>${cols || `<div class="rpt-hint">${esc(L("Sin columnas de detalle.", "No detail columns."))}</div>`}
        <button type="button" class="rpt-add" data-a="pick" data-mode="column">${icon("plus")}<span>${esc(L("Agregar columna", "Add column"))}</span></button></div>
      <div class="rpt-sec"><div class="rpt-sec-title">${esc(L("Filtros", "Filters"))}<b>${m.reportFilters.length}</b></div>
        ${scope}${dateFilter}${filters}
        ${m.reportFilters.length < MAX_FILTERS ? `<button type="button" class="rpt-add" data-a="pick" data-mode="filter">${icon("plus")}<span>${esc(L("Agregar filtro", "Add filter"))}</span></button>` : ""}
        ${
          m.reportFilters.length > 1
            ? `<label class="rpt-row"><span>${esc(L("Lógica", "Logic"))}</span><input data-k="logic" value="${esc(m.reportBooleanFilter || "")}" placeholder="1 AND (2 OR 3)" spellcheck="false"></label>`
            : ""
        }
      </div>
      <div class="rpt-sec"><div class="rpt-sec-title">${esc(L("Opciones", "Options"))}</div>
        <label class="rpt-switch"><input type="checkbox" data-k="details" ${m.hasDetailRows !== false ? "checked" : ""}><span class="track"></span><span>${esc(L("Filas de detalle", "Detail rows"))}</span></label>
        ${fmt !== "TABULAR" ? `<label class="rpt-switch"><input type="checkbox" data-k="subtotals" ${m.showSubtotals !== false ? "checked" : ""}><span class="track"></span><span>${esc(L("Subtotales", "Subtotals"))}</span></label>` : ""}
        <label class="rpt-switch"><input type="checkbox" data-k="grandtotal" ${m.showGrandTotal !== false ? "checked" : ""}><span class="track"></span><span>${esc(L("Total general", "Grand total"))}</span></label>
      </div>
      <div class="rpt-sec"><div class="rpt-sec-title">${esc(L("Gráfico", "Chart"))}</div>${chartBlock}</div>`;
  }

  aggLabel(name) {
    if (name === "RowCount") return L("Cantidad de registros", "Record Count");
    const fromResult = this.result && aggregateLabel(this.result, name);
    if (fromResult && fromResult !== name) return fromResult;
    const [k, col] = name.split("!");
    const kind = AGG_KINDS.find(([x]) => x === k)?.[1] || k;
    return `${kind}: ${this.colLabel(col)}`;
  }

  renderStatus() {
    const box = this.root.querySelector("[data-status]");
    if (!box || !this.md) return;
    const r = this.result;
    const rows = r?.factMap?.["T!T"]?.aggregates?.[r.reportMetadata?.aggregates?.indexOf("RowCount")]?.value;
    box.innerHTML = `
      <span class="rpt-format f-${this.format.toLowerCase()}">${esc(FORMAT_LABEL[this.format])}</span>
      ${rows != null ? `<span class="rpt-count"><b>${fmtN(rows)}</b> ${esc(L("registros", "records"))}</span>` : ""}
      ${r && r.allData === false ? `<span class="rpt-warn" title="${esc(L("La API devuelve hasta 2.000 filas de detalle", "The API returns up to 2,000 detail rows"))}">${icon("info")}${esc(L("Primeras 2.000 filas", "First 2,000 rows"))}</span>` : ""}
      <span class="spacer"></span>
      ${this.running ? `<span class="rpt-running"><span class="spinner"></span>${esc(L("Ejecutando en Salesforce…", "Running in Salesforce…"))}</span>` : ""}
      ${this.format !== "TABULAR" ? `<button type="button" class="ghost-btn sm ${this.chart ? "on" : ""}" data-a="chart-on">${icon("bar-chart")}<span>${esc(L("Gráfico", "Chart"))}</span></button>` : ""}`;
    box.classList.toggle("busy", !!this.running);
  }

  renderResults() {
    this.renderStatus();
    const box = this.root.querySelector("[data-results]");
    if (!box) return;
    const r = this.result;
    if (this.error) {
      box.innerHTML = `<div class="rpt-error">${icon("alert")}<div><b>${esc(L("Salesforce no pudo ejecutar el reporte", "Salesforce couldn't run the report"))}</b><p>${esc(this.error)}</p></div></div>${
        r ? `<div class="rpt-stale">${this.tableHtml(r)}</div>` : ""
      }`;
      return;
    }
    if (!r) {
      box.innerHTML = `<div class="anl-loading"><span class="spinner"></span>${esc(L("Ejecutando…", "Running…"))}</div>`;
      return;
    }
    const showChart = this.chart && this.format !== "TABULAR";
    box.innerHTML = `${showChart ? `<div class="rpt-chart-card"><div class="rpt-chart" data-chart></div></div>` : ""}<div class="rpt-table-card">${this.tableHtml(r)}</div>`;
    if (showChart) {
      const data = chartData(r, this.chart.agg);
      renderChart(box.querySelector("[data-chart]"), { type: this.chart.type, ...data, format: labelFormat(data) });
    }
  }

  // ───────────────────────────────────────── Tablas
  cellHtml(c) {
    if (!c) return "";
    const label = c.label ?? "";
    if (typeof c.value === "string" && SF_ID.test(c.value) && label && label !== c.value)
      return `<a data-sf href="${esc(this.ctx.url(`/${c.value}`))}">${esc(label)}</a>`;
    return esc(label === "-" ? "" : label);
  }

  tableHtml(r) {
    const fmt = (r.reportMetadata?.reportFormat || this.format).toUpperCase();
    if (fmt === "MATRIX") return this.matrixHtml(r);
    if (fmt === "SUMMARY") return this.summaryHtml(r);
    return this.tabularHtml(r);
  }

  detailHead(r) {
    const cols = r.reportMetadata?.detailColumns || [];
    const sort = this.md.sortBy?.[0];
    return cols
      .map((c) => {
        const s = sort?.sortColumn === c ? (sort.sortOrder === "Desc" ? "desc" : "asc") : "";
        return `<th class="sortable ${s ? "sorted" : ""} ${s === "desc" ? "desc" : ""} ${NUMERIC.has(this.colType(c)) ? "num" : ""}" data-a="sort" data-name="${esc(c)}">${esc(
          r.reportExtendedMetadata?.detailColumnInfo?.[c]?.label || this.colLabel(c)
        )}${icon("arrow-up", "sort-ico")}</th>`;
      })
      .join("");
  }

  rowsHtml(r, rows, cols) {
    return (rows || [])
      .map((row) => `<tr>${row.dataCells.map((c, i) => `<td class="${NUMERIC.has(this.colType(cols[i])) ? "num" : ""}">${this.cellHtml(c)}</td>`).join("")}</tr>`)
      .join("");
  }

  aggsLine(r, fact) {
    const names = r.reportMetadata?.aggregates || [];
    return (fact?.aggregates || []).map((a, i) => `<span class="rpt-aggv"><em>${esc(aggregateLabel(r, names[i]))}</em> ${esc(a.label)}</span>`).join("");
  }

  tabularHtml(r) {
    const cols = r.reportMetadata?.detailColumns || [];
    const fact = r.factMap?.["T!T"];
    if (!cols.length) return `<div class="rpt-empty">${esc(L("Agrega columnas desde la pestaña Campos.", "Add columns from the Fields tab."))}</div>`;
    const rows = fact?.rows || [];
    return `<table class="grid rpt-grid"><thead><tr>${this.detailHead(r)}</tr></thead><tbody>${
      rows.length ? this.rowsHtml(r, rows, cols) : `<tr><td colspan="${cols.length}" class="rpt-none">${esc(L("Sin resultados", "No results"))}</td></tr>`
    }</tbody>${this.md.showGrandTotal !== false ? `<tfoot><tr><td colspan="${cols.length}"><div class="rpt-total">${esc(L("Total", "Total"))} ${this.aggsLine(r, fact)}</div></td></tr></tfoot>` : ""}</table>`;
  }

  summaryHtml(r) {
    const cols = r.reportMetadata?.detailColumns || [];
    const span = Math.max(1, cols.length);
    const details = r.reportMetadata?.hasDetailRows !== false && cols.length;
    const nodes = walk(r.groupingsDown?.groupings);
    const names = r.reportMetadata?.groupingsDown || [];
    let body = "";
    for (const n of nodes) {
      const fact = r.factMap?.[`${n.key}!T`];
      const gname = names[n.depth]?.name;
      body += `<tr class="rpt-grp d${n.depth}"><td colspan="${span}"><div class="rpt-grp-line" style="--d:${n.depth}"><span class="rpt-grp-field">${esc(this.colLabel(gname))}</span><b>${esc(
        n.label
      )}</b>${this.md.showSubtotals !== false ? this.aggsLine(r, fact) : ""}</div></td></tr>`;
      if (details && !n.groupings?.length) body += this.rowsHtml(r, fact?.rows, cols);
    }
    if (!nodes.length) body = `<tr><td colspan="${span}" class="rpt-none">${esc(L("Sin resultados", "No results"))}</td></tr>`;
    return `<table class="grid rpt-grid">${details ? `<thead><tr>${this.detailHead(r)}</tr></thead>` : ""}<tbody>${body}</tbody>${
      this.md.showGrandTotal !== false ? `<tfoot><tr><td colspan="${span}"><div class="rpt-total">${esc(L("Total general", "Grand total"))} ${this.aggsLine(r, r.factMap?.["T!T"])}</div></td></tr></tfoot>` : ""
    }</table>`;
  }

  matrixHtml(r) {
    const down = leaves(r.groupingsDown?.groupings);
    const across = leaves(r.groupingsAcross?.groupings);
    const names = r.reportMetadata?.aggregates || [];
    const cell = (k) => {
      const f = r.factMap?.[k];
      return (f?.aggregates || []).map((a, i) => `<div class="${names.length > 1 ? "rpt-mx-multi" : ""}" title="${esc(aggregateLabel(r, names[i]))}">${esc(a.label)}</div>`).join("");
    };
    const rowsCut = down.slice(0, 300);
    const colsCut = across.slice(0, 60);
    const downNames = (r.reportMetadata?.groupingsDown || []).map((g) => this.colLabel(g.name)).join(" › ");
    return `<div class="rpt-mx-wrap"><table class="grid rpt-grid rpt-matrix"><thead><tr><th class="rpt-mx-corner">${esc(downNames || "")}</th>${colsCut
      .map((a) => `<th class="num">${esc(a.path.join(" › "))}</th>`)
      .join("")}<th class="num rpt-mx-total">${esc(L("Total", "Total"))}</th></tr></thead><tbody>${(down.length ? rowsCut : [{ key: "T", path: [L("Total", "Total")] }])
      .map(
        (d) => `<tr><th class="rpt-mx-row">${esc(d.path.join(" › "))}</th>${colsCut.map((a) => `<td class="num">${cell(`${d.key}!${a.key}`)}</td>`).join("")}<td class="num rpt-mx-total">${cell(`${d.key}!T`)}</td></tr>`
      )
      .join("")}</tbody>${
      down.length
        ? `<tfoot><tr><th class="rpt-mx-row">${esc(L("Total", "Total"))}</th>${colsCut.map((a) => `<td class="num">${cell(`T!${a.key}`)}</td>`).join("")}<td class="num rpt-mx-total">${cell("T!T")}</td></tr></tfoot>`
        : ""
    }</table>${down.length > rowsCut.length || across.length > colsCut.length ? `<div class="rpt-hint">${esc(L("Matriz recortada para mostrarla aquí.", "Matrix trimmed for display."))}</div>` : ""}</div>`;
  }
}

function typeShort(t) {
  return (
    {
      string: "Abc",
      textarea: "Abc",
      picklist: "▾",
      multipicklist: "▾▾",
      currency: "$",
      double: "#",
      int: "#",
      percent: "%",
      date: L("Fch", "Dt"),
      datetime: L("F/H", "D/T"),
      boolean: "✓",
      id: "Id",
      reference: "↗",
      email: "@",
      phone: "☎",
      url: "🔗",
    }[t] || "·"
  );
}
