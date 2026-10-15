// Reportes y dashboards dentro de Org Lens: lista (hub), editor de reportes y editor de dashboards.
import { listReports, listDashboards, listFolders, reportTypes, cloneDashboard, describeDashboard, saveDashboard } from "../lib/analytics.js";
import { L, locale } from "../lib/i18n.js";
import { $, icon, esc, toast, friendlyError, highlight, relativeTime } from "./ui.js";
import { ReportEditor } from "./report-editor.js";
import { DashboardEditor } from "./dashboard-editor.js";

const FORMAT_ICON = { Tabular: "rows", Summary: "list", Matrix: "grid", MultiBlock: "layers" };
const FORMAT_LABEL = { Tabular: L("Tabular", "Tabular"), Summary: L("Resumen", "Summary"), Matrix: L("Matriz", "Matrix"), MultiBlock: L("Combinado", "Joined") };
const MAX_ROWS = 300;

export class AnalyticsStudio {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = $("#analytics");
    this.root.querySelector(".ide-window").innerHTML = `<header class="drawer-head ide-head anl-head" data-head></header><div class="anl-body" data-body></div><div class="ide-modal hidden" data-modal></div>`;
    this.el = { head: this.root.querySelector("[data-head]"), body: this.root.querySelector("[data-body]"), modal: this.root.querySelector("[data-modal]") };
    this.report = new ReportEditor(this);
    this.dash = new DashboardEditor(this);
    this.tab = "reports";
    this.q = "";
    this.folder = "";
    this.folderCache = new Map();
    this.bind();
  }

  get isOpen() {
    return this.root.classList.contains("open");
  }

  bind() {
    this.el.head.addEventListener("click", (e) => {
      const b = e.target.closest("[data-r], [data-h], [data-d]");
      if (!b || b.disabled) return;
      if (b.dataset.r === "back") return this.openHub();
      if (b.dataset.r === "close") return this.close();
      if (b.dataset.h) return this.onHubHead(b.dataset.h);
      this.current?.onHeadClick(b);
    });
    this.el.head.addEventListener("input", (e) => this.current?.onHeadInput?.(e));
    document.addEventListener("keydown", (e) => {
      if (!this.isOpen || e.key !== "Escape") return;
      if (!this.el.modal.classList.contains("hidden")) {
        e.preventDefault();
        this.closeDialog();
      }
    });
    window.addEventListener("beforeunload", (e) => {
      if (this.isOpen && this.current?.dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  show() {
    if (this.isOpen) return;
    this.root.classList.remove("hidden");
    requestAnimationFrame(() => this.root.classList.add("open"));
  }

  confirmLeave() {
    return !this.current?.dirty || confirm(L("Hay cambios sin guardar. ¿Descartarlos?", "There are unsaved changes. Discard them?"));
  }

  close() {
    if (!this.confirmLeave()) return;
    this.closeDialog();
    this.report.abort?.abort();
    this.current = null;
    this.root.classList.remove("open");
    setTimeout(() => !this.isOpen && this.root.classList.add("hidden"), 380);
  }

  setHead(html) {
    this.el.head.innerHTML = html;
  }

  /** Cada vista se dibuja en su propio contenedor (así sus listeners no se acumulan). */
  mountView(html) {
    const root = document.createElement("div");
    root.className = "anl-view";
    root.innerHTML = html;
    this.el.body.replaceChildren(root);
    return root;
  }

  // ───────────────────────────────────────── Datos compartidos
  lists() {
    if (!this.listsPromise || this.listsStale) {
      this.listsStale = false;
      this.listsPromise = Promise.all([listReports(this.ctx.api), listDashboards(this.ctx.api)]).then(
        ([reports, dashboards]) => ({ reports, dashboards }),
        (e) => {
          this.listsPromise = null;
          throw e;
        }
      );
    }
    return this.listsPromise;
  }

  async folders(type) {
    if (!this.folderCache.has(type)) {
      const p = listFolders(this.ctx.api, type)
        .then((r) => r.filter((f) => f.Name).map((f) => ({ id: f.Id, name: f.Name })))
        .catch(() => []);
      this.folderCache.set(type, p);
    }
    return this.folderCache.get(type);
  }

  // ───────────────────────────────────────── Entradas
  async openHub(tab) {
    if (this.current && !this.confirmLeave()) return;
    this.show();
    this.report.abort?.abort();
    this.current = null;
    if (tab) this.tab = tab;
    this.renderHubHead();
    this.mountView(`<div class="anl-loading"><span class="spinner"></span>${esc(L("Cargando reportes y dashboards…", "Loading reports and dashboards…"))}</div>`);
    try {
      this.data = await this.lists();
      if (this.current) return;
      this.renderHub();
    } catch (e) {
      if (e.status === 401) return this.ctx.sessionExpired();
      this.mountView(`<div class="empty error"><div class="e-ico">${icon("alert")}</div><h3>${esc(L("No se pudieron leer los reportes", "Could not read the reports"))}</h3><p>${esc(friendlyError(e))}</p></div>`);
    }
  }

  openReport(id) {
    if (this.current && !this.confirmLeave()) return;
    this.show();
    this.current = this.report;
    this.report.open(id);
  }

  openNewReport(type) {
    this.show();
    this.current = this.report;
    this.report.create(type);
  }

  openDashboard(id, opts) {
    if (this.current && !this.confirmLeave()) return;
    this.show();
    this.current = this.dash;
    this.dash.open(id, opts);
  }

  onHubHead(a) {
    if (a === "refresh") {
      this.listsStale = true;
      return this.openHub();
    }
    if (a === "new-report") return this.newReport();
    if (a === "new-dash") return this.newDashboard();
  }

  // ───────────────────────────────────────── Hub
  renderHubHead() {
    const d = this.data;
    this.setHead(`
      <div class="rh-ico" style="--c:#059669">${icon("bar-chart")}</div>
      <div class="dh-title"><h3>${esc(L("Reportes y dashboards", "Reports & dashboards"))}</h3><p>${
        d ? esc(L(`${d.reports.length} reportes · ${d.dashboards.length} dashboards`, `${d.reports.length} reports · ${d.dashboards.length} dashboards`)) : "&nbsp;"
      }</p></div>
      <div class="ide-actions">
        <button class="icon-btn" data-h="refresh" title="${esc(L("Actualizar", "Refresh"))}">${icon("refresh")}</button>
        <button class="ghost-btn" data-h="new-dash">${icon("gauge")}<span>${esc(L("Nuevo dashboard", "New dashboard"))}</span></button>
        <button class="primary-btn sm" data-h="new-report">${icon("plus")}<span>${esc(L("Nuevo reporte", "New report"))}</span></button>
        <button class="icon-btn" data-r="close" title="${esc(L("Cerrar", "Close"))}">${icon("x")}</button>
      </div>`);
  }

  renderHub() {
    this.renderHubHead();
    const d = this.data;
    const root = this.mountView(`<div class="anl-hub">
      <div class="anl-toolbar">
        <div class="anl-tabs">
          <button type="button" data-tab="reports">${icon("bar-chart")}<span>${esc(L("Reportes", "Reports"))}</span><b>${d.reports.length}</b></button>
          <button type="button" data-tab="dashboards">${icon("gauge")}<span>Dashboards</span><b>${d.dashboards.length}</b></button>
        </div>
        <label class="field grow">${icon("search")}<input type="text" data-q value="${esc(this.q)}" placeholder="${esc(L("Buscar por nombre, carpeta o descripción…", "Search by name, folder or description…"))}" spellcheck="false" autocomplete="off"></label>
        <label class="field">${icon("layers")}<select data-folder></select></label>
      </div>
      <div class="anl-list" data-list></div>
    </div>`);
    root.addEventListener("click", (e) => {
      const t = e.target.closest("[data-tab]");
      if (t) {
        this.tab = t.dataset.tab;
        this.folder = "";
        return this.renderHubList(root);
      }
      const row = e.target.closest("[data-open]");
      if (!row || e.target.closest("a")) return;
      if (this.tab === "reports") this.openReport(row.dataset.open);
      else this.openDashboard(row.dataset.open);
    });
    root.querySelector("[data-q]").addEventListener("input", (e) => {
      this.q = e.target.value;
      this.renderHubList(root);
    });
    root.querySelector("[data-folder]").addEventListener("change", (e) => {
      this.folder = e.target.value;
      this.renderHubList(root);
    });
    this.renderHubList(root);
    root.querySelector("[data-q]").focus();
  }

  renderHubList(root) {
    const reports = this.tab === "reports";
    const items = reports ? this.data.reports : this.data.dashboards;
    root.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === this.tab));
    const folders = [...new Set(items.map((r) => r.FolderName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    root.querySelector("[data-folder]").innerHTML = `<option value="">${esc(L("Todas las carpetas", "All folders"))} (${folders.length})</option>${folders
      .map((f) => `<option ${f === this.folder ? "selected" : ""}>${esc(f)}</option>`)
      .join("")}`;
    const q = this.q.trim();
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = items.filter(
      (r) =>
        (!this.folder || r.FolderName === this.folder) &&
        (!tokens.length || tokens.every((t) => `${r.Name || r.Title} ${r.FolderName || ""} ${r.Description || ""} ${r.DeveloperName}`.toLowerCase().includes(t)))
    );
    const box = root.querySelector("[data-list]");
    if (!list.length) {
      box.innerHTML = `<div class="empty"><div class="e-ico">${icon(reports ? "bar-chart" : "gauge")}</div><h3>${esc(
        items.length ? L("Nada coincide", "Nothing matches") : reports ? L("Todavía no hay reportes", "There are no reports yet") : L("Todavía no hay dashboards", "There are no dashboards yet")
      )}</h3><p>${esc(items.length ? L("Prueba con otra búsqueda o carpeta.", "Try another search or folder.") : L("Crea el primero con el botón de arriba.", "Create the first one with the button above."))}</p></div>`;
      return;
    }
    box.innerHTML =
      list
        .slice(0, MAX_ROWS)
        .map((r) => {
          const name = r.Name || r.Title;
          const by = r.LastModifiedBy?.Name;
          return `<div class="anl-row" data-open="${esc(r.Id)}" role="button" tabindex="0">
            <span class="anl-row-ico ${reports ? "r" : "d"}">${icon(reports ? FORMAT_ICON[r.Format] || "bar-chart" : "gauge")}</span>
            <span class="anl-row-main"><b>${highlight(name, q)}</b>${r.Description ? `<span>${highlight(r.Description, q)}</span>` : ""}</span>
            <span class="anl-row-meta">
              ${r.FolderName ? `<span class="chip">${icon("layers")}${highlight(r.FolderName, q)}</span>` : ""}
              ${reports && r.Format ? `<span class="chip f">${esc(FORMAT_LABEL[r.Format] || r.Format)}</span>` : ""}
            </span>
            <span class="anl-row-when" title="${esc(L("Modificado", "Modified"))}"><b>${esc(relativeTime(r.LastModifiedDate))}</b>${by ? `<span>${esc(L(`por ${by}`, `by ${by}`))}</span>` : ""}</span>
            <a class="row-btn" data-sf href="${esc(this.ctx.url(`/lightning/r/${reports ? "Report" : "Dashboard"}/${r.Id}/view`))}" title="${esc(L("Abrir en Salesforce", "Open in Salesforce"))}">${icon("external")}</a>
          </div>`;
        })
        .join("") +
      (list.length > MAX_ROWS ? `<div class="anl-more">${esc(L(`Mostrando ${MAX_ROWS} de ${list.length.toLocaleString(locale)}: usa la búsqueda para encontrar el resto.`, `Showing ${MAX_ROWS} of ${list.length.toLocaleString(locale)}: use search to find the rest.`))}</div>` : "");
  }

  // ───────────────────────────────────────── Crear
  async newReport() {
    let groups;
    try {
      groups = await reportTypes(this.ctx.api);
    } catch (e) {
      if (e.status === 401) return this.ctx.sessionExpired();
      return toast(friendlyError(e), "error");
    }
    const cats = (Array.isArray(groups) ? groups : []).map((g) => ({ label: g.label, types: (g.reportTypes || []).filter((t) => !t.isHidden) })).filter((g) => g.types.length);
    this.dialog({
      title: L("Nuevo reporte: elige el report type", "New report: pick the report type"),
      wide: true,
      body: `<p class="anl-note">${esc(
        L("El report type define qué objetos y campos puede usar el reporte (igual que en Salesforce).", "The report type defines which objects and fields the report can use (same as in Salesforce).")
      )}</p>
        <label class="sch-search">${icon("search")}<input type="text" data-dlg-q placeholder="${esc(L("Buscar report type…", "Search report type…"))}" autocomplete="off"></label>
        <div class="anl-pick tall">${cats
          .map(
            (c) => `<div class="anl-pick-cat" data-cat><div class="anl-pick-cat-title">${esc(c.label)}</div>${c.types
              .map(
                (t) => `<label class="anl-pick-row" data-q="${esc(`${t.label} ${t.type} ${c.label}`.toLowerCase())}"><input type="radio" name="type" value="${esc(t.type)}"><span><b>${esc(t.label)}</b><em>${esc(
                  t.type
                )}</em></span></label>`
              )
              .join("")}</div>`
          )
          .join("")}</div>`,
      ok: L("Crear reporte", "Create report"),
      onOpen: (m) => {
        m.querySelector("[data-dlg-q]").addEventListener("input", (e) => {
          const q = e.target.value.trim().toLowerCase();
          m.querySelectorAll("[data-q]").forEach((r) => r.classList.toggle("hidden", !!q && !r.dataset.q.includes(q)));
          m.querySelectorAll("[data-cat]").forEach((c) => c.classList.toggle("hidden", !c.querySelector("[data-q]:not(.hidden)")));
        });
        m.querySelector(".anl-pick").addEventListener("dblclick", (e) => e.target.closest(".anl-pick-row") && m.querySelector("form").requestSubmit());
      },
      onSubmit: (fd) => {
        const type = fd.get("type");
        if (!type) throw new Error(L("Elige un report type.", "Pick a report type."));
        if (this.current && !this.confirmLeave()) return false;
        this.closeDialog();
        this.openNewReport(String(type));
      },
    });
  }

  /** La API no crea dashboards desde cero: se clona uno (en blanco = copia sin componentes). */
  async newDashboard({ from = null, name = "" } = {}) {
    const [{ dashboards }, folders] = await Promise.all([this.lists(), this.folders("Dashboard")]);
    if (!dashboards.length) {
      return this.dialog({
        title: L("Nuevo dashboard", "New dashboard"),
        body: `<div class="ide-modal-note">${icon("info")}<span>${esc(
          L(
            "La API de Salesforce solo permite crear dashboards copiando uno existente, y esta org todavía no tiene ninguno. Crea el primero en Salesforce; después podrás copiarlo y editarlo aquí.",
            "Salesforce's API can only create dashboards by copying an existing one, and this org has none yet. Create the first one in Salesforce; then you can copy and edit it here."
          )
        )}</span></div>
          <a class="ghost-btn" data-sf href="${esc(this.ctx.url("/lightning/o/Dashboard/home"))}">${icon("external")}<span>${esc(L("Ir a Dashboards en Salesforce", "Go to Dashboards in Salesforce"))}</span></a>`,
      });
    }
    const own = this.ctx.userId ? [{ id: this.ctx.userId, name: L("Mis dashboards privados", "My private dashboards") }] : [];
    this.dialog({
      title: from ? L("Copiar dashboard", "Copy dashboard") : L("Nuevo dashboard", "New dashboard"),
      body: `<label class="ide-fld"><span>${esc(L("Nombre", "Name"))}</span><input name="name" maxlength="80" value="${esc(name)}" autocomplete="off" placeholder="${esc(L("Ventas del trimestre", "Quarterly sales"))}"></label>
        <label class="ide-fld"><span>${esc(L("Carpeta", "Folder"))}</span><select name="folderId">${[...folders, ...own].map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("")}</select></label>
        <label class="ide-fld"><span>${esc(L("Contenido", "Content"))}</span><select name="source">
          <option value="">${esc(L("En blanco (sin componentes)", "Blank (no components)"))}</option>
          ${dashboards.map((d) => `<option value="${esc(d.Id)}" ${d.Id === from ? "selected" : ""}>${esc(L(`Copia de: ${d.Title}`, `Copy of: ${d.Title}`))}</option>`).join("")}
        </select></label>
        <p class="anl-note">${esc(
          L(
            "Salesforce no permite crear dashboards desde cero por API: se crea copiando uno existente y, si eliges «En blanco», se le quitan los componentes.",
            "Salesforce doesn't allow creating dashboards from scratch via API: it's created by copying an existing one and, if you pick “Blank”, its components are removed."
          )
        )}</p>`,
      ok: L("Crear dashboard", "Create dashboard"),
      onSubmit: async (fd) => {
        const title = String(fd.get("name") || "").trim();
        if (!title) throw new Error(L("Escribe un nombre.", "Enter a name."));
        const source = String(fd.get("source") || "");
        const blank = !source;
        if (this.ctx.orgKindKey === "prod" && !confirm(L("Estás en PRODUCCIÓN. ¿Crear el dashboard?", "You're in PRODUCTION. Create the dashboard?"))) return false;
        const id = await cloneDashboard(this.ctx.api, source || dashboards[0].Id, String(fd.get("folderId") || "") || null);
        if (!id) throw new Error(L("Salesforce no devolvió el Id del dashboard nuevo.", "Salesforce didn't return the new dashboard Id."));
        this.listsStale = true;
        try {
          const meta = await describeDashboard(this.ctx.api, id);
          const patch = { name: title };
          if (blank) {
            patch.components = [];
            patch.layout = meta.layout?.gridLayout ? { ...meta.layout, components: [] } : { ...meta.layout, columns: (meta.layout?.columns || []).map(() => ({ components: [] })) };
          }
          await saveDashboard(this.ctx.api, id, patch);
        } catch (e) {
          toast(L(`Se creó la copia, pero no se pudo terminar de prepararla: ${friendlyError(e)}`, `The copy was created, but it couldn't be finished: ${friendlyError(e)}`), "error", 9000);
        }
        toast(L(`Dashboard «${title}» creado`, `Dashboard “${title}” created`), "success");
        this.closeDialog();
        this.current = null;
        this.openDashboard(id, { edit: blank });
      },
    });
  }

  // ───────────────────────────────────────── Diálogo genérico
  dialog({ title, body, ok, onSubmit, onOpen, wide = false }) {
    const m = this.el.modal;
    m.innerHTML = `<div class="ide-modal-backdrop" data-dlg="cancel"></div>
      <form class="ide-modal-card ${wide ? "anl-wide" : ""}" novalidate>
        <div class="ide-modal-head"><h3>${esc(title)}</h3><button type="button" class="icon-btn" data-dlg="cancel">${icon("x")}</button></div>
        ${body}
        <div class="ide-modal-err hidden" data-dlg-err></div>
        <div class="ide-modal-foot"><button type="button" class="ghost-btn" data-dlg="cancel">${esc(ok ? L("Cancelar", "Cancel") : L("Cerrar", "Close"))}</button>${
          ok ? `<button type="submit" class="primary-btn sm">${icon("check")}<span>${esc(ok)}</span></button>` : ""
        }</div>
      </form>`;
    m.classList.remove("hidden");
    requestAnimationFrame(() => m.classList.add("open"));
    const form = m.querySelector("form");
    m.onclick = (e) => e.target.closest('[data-dlg="cancel"]') && this.closeDialog();
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!onSubmit || this.dialogBusy) return;
      const btn = form.querySelector('[type="submit"]');
      const err = m.querySelector("[data-dlg-err]");
      const html = btn.innerHTML;
      this.dialogBusy = true;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span><span>${esc(L("Procesando…", "Working…"))}</span>`;
      err.classList.add("hidden");
      let done = false;
      try {
        done = (await onSubmit(new FormData(form), m)) !== false;
      } catch (ex) {
        if (ex.status === 401) {
          this.dialogBusy = false;
          return this.ctx.sessionExpired();
        }
        err.innerHTML = `${icon("alert")}<span>${esc(friendlyError(ex))}</span>`;
        err.classList.remove("hidden");
      } finally {
        this.dialogBusy = false;
        if (m.contains(btn)) {
          btn.disabled = false;
          btn.innerHTML = html;
        }
      }
      if (done && m.contains(form)) this.closeDialog(); // fuera del «ocupado», si no closeDialog lo ignora
    };
    onOpen?.(m);
    setTimeout(() => m.querySelector("input:not([type=radio]), select")?.focus(), 60);
  }

  closeDialog() {
    if (this.dialogBusy) return;
    const m = this.el.modal;
    m.classList.remove("open");
    setTimeout(() => !m.classList.contains("open") && (m.classList.add("hidden"), (m.innerHTML = "")), 220);
  }
}
