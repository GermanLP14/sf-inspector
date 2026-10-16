// Ficha completa de un registro dentro de la extensión, con edición campo por campo.
//
// Permisos: Salesforce solo devuelve (describe + GET del registro) los campos que el usuario
// puede leer, y marca como "updateable" solo los que puede editar (FLS). Además se consulta
// UserRecordAccess para saber si el sharing permite editar ESTE registro. Al guardar, el PATCH
// vuelve a pasar por todas las validaciones de Salesforce (permisos, validation rules, triggers).
import { L, locale } from "../lib/i18n.js";
import { soqlEscape } from "../lib/sfapi.js";
import { objectStyle } from "./data-view.js";
import { $, icon, esc, toast, copyText, formatDate, formatDateTime, relativeTime, toneFor, friendlyError, debounce } from "./ui.js";

const ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const SYSTEM_FIELDS = new Set([
  "Id", "IsDeleted", "CreatedDate", "CreatedById", "LastModifiedDate", "LastModifiedById", "SystemModstamp",
  "LastActivityDate", "LastViewedDate", "LastReferencedDate", "MasterRecordId", "ConnectionReceivedId", "ConnectionSentId",
]);
// Tipos con editor propio. El resto (address, location, base64…) se edita en Salesforce.
const EDITABLE_TYPES = new Set([
  "string", "textarea", "email", "phone", "url", "picklist", "multipicklist", "combobox", "boolean",
  "int", "double", "currency", "percent", "date", "datetime", "time", "reference", "encryptedstring",
]);
const NUMBER_TYPES = new Set(["int", "double", "currency", "percent"]);
// Relaciones hijas que no son "registros relacionados" para el usuario (sharing, historial, feeds…).
const NON_RELATED = /(Share|ChangeEvent|Feed|History|__Tag)$/;
const REL_CHUNK = 10; // subconsultas por query al contar relacionados
const REL_COUNT_MAX = 200; // se cuenta hasta acá; más = "200+"
const REL_PAGE = 50; // registros que se muestran por lista

const pad = (n) => String(n).padStart(2, "0");
const toLocalInput = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const stripHtml = (html) => {
  const t = document.createElement("template");
  t.innerHTML = String(html);
  return t.content.textContent || "";
};

export class RecordPanel {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = $("#record");
    this.panel = $("#record-panel");
    this.head = $("#record-head");
    this.toolbar = $("#record-toolbar");
    this.body = $("#record-body");
    this.savebar = $("#record-savebar");
    this.token = 0;
    this.stack = [];
    this.current = null;
    this.filter = { q: "", mode: "all" };
    this.resetState();
    this.bind();
  }

  resetState() {
    this.describe = null;
    this.record = null;
    this.access = null;
    this.fields = [];
    this.edits = new Map(); // campo → valor nuevo
    this.editing = new Set(); // campos con el editor abierto
    this.errors = new Map(); // campo → mensaje
    this.generalError = null;
    this.names = new Map(); // Id referenciado → { name, obj }
    this.flash = new Set();
    this.view = "fields"; // fields | related
    this.related = null; // null = buscando · [] = sin relacionados · [{ rel, label, count }]
    this.relOpen = new Map(); // relationshipName → { loading, records, error }
    this.relQ = "";
  }

  get isOpen() {
    return this.root.classList.contains("open");
  }

  bind() {
    $("#record-backdrop").addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.isOpen) return;
      if (e.target.closest?.(".f-editor")) return; // Esc dentro de un editor lo maneja el editor
      e.stopImmediatePropagation(); // que no cierre también el panel de abajo
      this.close();
    });

    this.head.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      if (b.dataset.act === "close") this.close();
      if (b.dataset.act === "back") this.back();
      if (b.dataset.act === "reload") this.reload();
      if (b.dataset.act === "copy") copyText(b.dataset.value);
    });

    const onSearch = debounce(() => {
      const q = this.toolbar.querySelector("input").value.trim().toLowerCase();
      if (this.view === "related") this.relQ = q;
      else this.filter.q = q;
      this.renderBody();
    }, 100);
    this.toolbar.addEventListener("input", (e) => e.target.matches("input") && onSearch());
    this.toolbar.addEventListener("click", (e) => {
      const rel = e.target.closest('[data-act="related"]');
      if (rel) {
        if (rel.disabled) return;
        this.view = this.view === "related" ? "fields" : "related";
        this.renderToolbar();
        this.renderBody(true);
        this.body.scrollTop = 0;
        return;
      }
      const chip = e.target.closest("[data-mode]");
      if (!chip) return;
      this.filter.mode = chip.dataset.mode;
      this.toolbar.querySelectorAll("[data-mode]").forEach((c) => c.classList.toggle("on", c === chip));
      this.renderBody();
    });

    this.body.addEventListener("click", (e) => {
      const t = e.target;
      const copy = t.closest("[data-copy]");
      if (copy) return copyText(copy.dataset.copy);
      const ref = t.closest("[data-open-ref]");
      if (ref) return this.open(ref.dataset.obj, ref.dataset.openRef, { push: true });
      const relToggle = t.closest("[data-rel-toggle]");
      if (relToggle) return this.toggleRelated(relToggle.dataset.relToggle);
      const row = t.closest(".frow");
      if (!row) return;
      const name = row.dataset.field;
      if (t.closest("[data-edit]")) return this.startEdit(name);
      if (t.closest("[data-undo]")) return this.undo(name);
      if (t.closest("[data-done]")) return this.stopEdit(name);
    });
    this.body.addEventListener("dblclick", (e) => {
      const row = e.target.closest(".frow.editable");
      if (row && !e.target.closest(".f-editor")) this.startEdit(row.dataset.field);
    });
    this.body.addEventListener("input", (e) => this.onEditorChange(e));
    this.body.addEventListener("change", (e) => this.onEditorChange(e));
    this.body.addEventListener("keydown", (e) => {
      const ed = e.target.closest(".f-editor");
      if (!ed) return;
      const name = ed.closest(".frow").dataset.field;
      if (e.key === "Escape") {
        e.preventDefault();
        this.undo(name);
      } else if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
        this.stopEdit(name);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.save();
      }
    });

    this.savebar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      if (b.dataset.act === "save") this.save();
      if (b.dataset.act === "discard") this.discard();
    });
  }

  // ───────────────────────────────────────── Navegación
  confirmLoseChanges() {
    return !this.edits.size || confirm(L("Hay cambios sin guardar. ¿Descartarlos?", "You have unsaved changes. Discard them?"));
  }

  async open(objectName, id, { push = false } = {}) {
    if (!this.confirmLoseChanges()) return;
    if (push && this.current) this.stack.push({ ...this.current, view: this.view });
    else if (!push) this.stack = [];
    this.current = { objectName, id };
    this.root.classList.remove("hidden");
    requestAnimationFrame(() => this.root.classList.add("open"));
    await this.load();
  }

  back() {
    if (!this.stack.length || !this.confirmLoseChanges()) return;
    const prev = this.stack.pop();
    this.current = { objectName: prev.objectName, id: prev.id };
    this.load({ view: prev.view });
  }

  reload() {
    if (!this.confirmLoseChanges()) return;
    this.ctx.api._describe.delete(this.current.objectName); // por si cambiaron campos o permisos
    this.load();
  }

  close() {
    if (!this.confirmLoseChanges()) return;
    this.resetState();
    this.root.classList.remove("open");
    setTimeout(() => !this.isOpen && this.root.classList.add("hidden"), 380);
  }

  async load({ keepFlash = false, view = "fields" } = {}) {
    const { objectName, id } = this.current;
    const flash = keepFlash ? this.flash : new Set();
    this.resetState();
    this.flash = flash;
    this.view = view;
    const token = ++this.token;
    this.renderLoading();
    try {
      const [describe, record, access] = await Promise.all([
        this.ctx.api.describe(objectName),
        this.fetchRecord(objectName, id),
        this.recordAccess(id),
      ]);
      if (token !== this.token) return;
      this.describe = describe;
      this.record = record;
      this.access = access;
      this.fields = this.buildFields();
      this.render();
      this.resolveNames(token);
      this.loadRelated(token);
      if (this.flash.size) setTimeout(() => this.flash.clear(), 1600);
    } catch (e) {
      if (token !== this.token) return;
      this.renderError(e);
      if (e.status === 401) this.ctx.sessionExpired();
    }
  }

  async fetchRecord(objectName, id) {
    try {
      return await this.ctx.api.getRecord(objectName, id);
    } catch (e) {
      if (e.status === 401 || e.status === 404) throw e;
      // Algunos objetos no admiten el GET por Id: probamos con SOQL de todos los campos legibles.
      const d = await this.ctx.api.describe(objectName);
      const names = d.fields.filter((f) => !["address", "location"].includes(f.type)).map((f) => f.name);
      const res = await this.ctx.api.query(`SELECT ${names.join(", ")} FROM ${objectName} WHERE Id = '${soqlEscape(id)}'`);
      if (!res.records.length) throw e;
      return res.records[0];
    }
  }

  async recordAccess(id) {
    if (!this.ctx.userId) return null;
    try {
      const res = await this.ctx.api.query(
        `SELECT RecordId, HasEditAccess FROM UserRecordAccess WHERE UserId = '${soqlEscape(this.ctx.userId)}' AND RecordId = '${soqlEscape(id)}'`
      );
      const r = res.records[0];
      return r ? { edit: !!r.HasEditAccess } : null;
    } catch {
      return null; // si no se puede consultar, Salesforce validará al guardar
    }
  }

  // ───────────────────────────────────────── Modelo de campos
  buildFields() {
    const d = this.describe;
    const objEditable = d.updateable;
    const recEditable = this.access ? this.access.edit : true;
    return d.fields
      .filter((f) => f.name in this.record) // solo lo que Salesforce devolvió (= legible por FLS)
      .map((f) => {
        let reason = null;
        if (!objEditable) reason = L("Tu perfil no permite editar registros de este objeto", "Your profile can't edit records of this object");
        else if (!recEditable) reason = L("No tienes acceso de edición a este registro (sharing)", "You don't have edit access to this record (sharing)");
        else if (f.calculated) reason = L("Campo calculado (fórmula o roll-up): no se edita", "Calculated field (formula or roll-up): not editable");
        else if (f.autoNumber) reason = L("Autonumérico: lo asigna Salesforce", "Auto-number: assigned by Salesforce");
        else if (!f.updateable)
          reason = f.createable
            ? L("Solo se puede definir al crear el registro", "Can only be set when the record is created")
            : L("Campo de sistema o sin permiso de edición (FLS)", "System field or no edit permission (FLS)");
        else if (f.type === "textarea" && f.htmlFormatted) reason = L("Texto enriquecido: edítalo en Salesforce", "Rich text: edit it in Salesforce");
        else if (!EDITABLE_TYPES.has(f.type)) reason = L("Este tipo de campo se edita en Salesforce", "This field type is edited in Salesforce");
        const section = SYSTEM_FIELDS.has(f.name) ? "system" : f.custom ? "custom" : "standard";
        return { f, editable: !reason, reason, section };
      })
      .sort((a, b) => (b.f.nameField - a.f.nameField) || a.f.label.localeCompare(b.f.label));
  }

  value(name) {
    return this.edits.has(name) ? this.edits.get(name) : this.record[name];
  }

  typeLabel(f) {
    const base = {
      string: `Text(${f.length})`,
      textarea: f.htmlFormatted ? "Rich Text" : f.length > 255 ? "Long Text" : "Text Area",
      picklist: "Picklist",
      multipicklist: "Multi-Picklist",
      combobox: "Combobox",
      boolean: "Checkbox",
      currency: "Currency",
      double: "Number",
      int: "Number",
      percent: "Percent",
      date: "Date",
      datetime: "Date/Time",
      time: "Time",
      email: "Email",
      phone: "Phone",
      url: "URL",
      id: "Id",
      reference: f.referenceTo?.length ? `Lookup(${f.referenceTo.join(", ")})` : "Lookup",
      address: "Address",
      location: "Geolocation",
      encryptedstring: "Encrypted",
      base64: "File",
    }[f.type] || f.type;
    return f.calculated ? `${L("Fórmula", "Formula")} · ${base}` : base;
  }

  // ───────────────────────────────────────── Render
  renderLoading() {
    this.renderHead(true);
    this.toolbar.innerHTML = "";
    this.savebar.classList.remove("show");
    this.body.innerHTML = Array.from(
      { length: 10 },
      (_, i) => `<div class="frow skel-frow"><div class="skel" style="width:${30 + ((i * 17) % 40)}%"></div><div class="skel" style="width:${40 + ((i * 23) % 45)}%"></div></div>`
    ).join("");
  }

  renderError(e) {
    this.renderHead(true);
    this.body.innerHTML = `<div class="empty error"><div class="e-ico">${icon("alert")}</div><h3>${esc(
      L("No se pudo abrir el registro", "Could not open the record")
    )}</h3><p>${esc(friendlyError(e))}</p></div>`;
  }

  renderHead(loading = false) {
    const { objectName, id } = this.current;
    const sobj = { name: objectName, custom: objectName.includes("__") };
    const [ic, color] = objectStyle(sobj);
    const d = this.describe;
    const nameField = d?.fields?.find((f) => f.nameField)?.name;
    const title = loading ? L("Cargando…", "Loading…") : (nameField && this.record?.[nameField]) || id;
    const href = this.ctx.url(objectName.endsWith("__mdt") ? `/lightning/setup/CustomMetadata/page?address=${encodeURIComponent("/" + id)}` : `/lightning/r/${objectName}/${id}/view`);
    this.head.innerHTML = `
      ${this.stack.length ? `<button class="icon-btn" data-act="back" title="${esc(L("Volver al registro anterior", "Back to previous record"))}">${icon("arrow-left")}</button>` : ""}
      <div class="rh-ico" style="--c:${color}">${icon(ic)}</div>
      <div class="dh-title">
        <h3 title="${esc(title)}">${esc(title)}</h3>
        <p>${esc(d?.label || objectName)} · <button class="id-chip" data-act="copy" data-value="${esc(id)}" title="${esc(L("Copiar Id", "Copy Id"))}">${esc(id)}${icon("copy")}</button></p>
      </div>
      <div class="dh-actions">
        <button class="row-btn" data-act="reload" title="${esc(L("Recargar", "Reload"))}">${icon("refresh")}</button>
        <a class="row-btn" data-sf href="${esc(href)}" title="${esc(L("Abrir en Salesforce", "Open in Salesforce"))}">${icon("external")}</a>
      </div>
      <button class="icon-btn" data-act="close" title="${esc(L("Cerrar (Esc)", "Close (Esc)"))}">${icon("x")}</button>`;
  }

  render() {
    this.renderHead();
    this.renderToolbar();
    this.renderBody(true);
    this.renderSavebar();
  }

  renderToolbar() {
    if (this.view === "related") {
      const n = this.related?.length || 0;
      this.toolbar.innerHTML = `
        <label class="field grow">${icon("search")}<input type="text" placeholder="${esc(
          L(`Buscar entre ${n} listas relacionadas…`, `Search ${n} related lists…`)
        )}" value="${esc(this.relQ)}" spellcheck="false"></label>
        ${this.relatedBtnHtml()}`;
      return;
    }
    const total = this.fields.length;
    const editable = this.fields.filter((x) => x.editable).length;
    const modes = [
      ["all", L("Todos", "All")],
      ["filled", L("Con valor", "With value")],
      ["editable", L("Editables", "Editable")],
      ["custom", "Custom"],
    ];
    let note = "";
    if (!this.describe.updateable) note = L("Solo lectura: tu perfil no permite editar este objeto.", "Read only: your profile can't edit this object.");
    else if (this.access && !this.access.edit) note = L("Solo lectura: no tienes acceso de edición a este registro.", "Read only: you don't have edit access to this record.");
    this.toolbar.innerHTML = `
      <label class="field grow">${icon("search")}<input type="text" placeholder="${esc(
        L(`Buscar entre ${total} campos…`, `Search ${total} fields…`)
      )}" value="${esc(this.filter.q)}" spellcheck="false"></label>
      <div class="presets">${modes
        .map(([k, l]) => `<button type="button" class="chip-btn ${this.filter.mode === k ? "on" : ""}" data-mode="${k}">${esc(l)}</button>`)
        .join("")}</div>
      ${this.relatedBtnHtml()}
      <div class="rec-stats">${icon("shield-check")}<span>${esc(
        L(`${total} campos visibles · ${editable} editables`, `${total} visible fields · ${editable} editable`)
      )}</span></div>
      ${note ? `<div class="rec-note">${icon("lock")}<span>${esc(note)}</span></div>` : ""}`;
  }

  /** animate = solo en la primera carga; los re-render (filtros, errores) no re-animan las filas. */
  renderBody(animate = false) {
    this.body.classList.toggle("no-anim", !animate);
    if (this.view === "related") return this.renderRelated();
    const q = this.filter.q;
    const mode = this.filter.mode;
    const visible = this.fields.filter(({ f, editable, section }) => {
      if (mode === "filled" && (this.value(f.name) === null || this.value(f.name) === undefined || this.value(f.name) === "")) return false;
      if (mode === "editable" && !editable) return false;
      if (mode === "custom" && section !== "custom") return false;
      if (q && !`${f.label} ${f.name}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const sections = [
      ["standard", L("Campos principales", "Main fields")],
      ["custom", L("Campos custom", "Custom fields")],
      ["system", L("Información del sistema", "System information")],
    ];
    const html = sections
      .map(([key, title]) => {
        const rows = visible.filter((x) => x.section === key);
        if (!rows.length) return "";
        return `<section class="rec-sec"><h4>${esc(title)} <span>${rows.length}</span></h4>${rows.map((x, i) => this.rowHtml(x, i)).join("")}</section>`;
      })
      .join("");
    this.body.innerHTML =
      html ||
      `<div class="empty"><div class="e-ico">${icon("search")}</div><h3>${esc(L("Ningún campo coincide", "No field matches"))}</h3></div>`;
  }

  rowHtml(x, i = 0) {
    const { f, editable, reason } = x;
    const name = f.name;
    const dirty = this.edits.has(name);
    const editing = this.editing.has(name);
    const error = this.errors.get(name);
    const cls = ["frow", editable && "editable", dirty && "dirty", editing && "editing", error && "has-error", this.flash.has(name) && "flash"]
      .filter(Boolean)
      .join(" ");
    const action = editing
      ? `<button class="row-btn ok" data-done title="${esc(L("Listo (Enter)", "Done (Enter)"))}">${icon("check")}</button>`
      : editable
        ? `<button class="row-btn" data-edit title="${esc(L("Editar", "Edit"))}">${icon("pencil")}</button>`
        : `<span class="f-lock" title="${esc(reason)}">${icon("lock")}</span>`;
    return `<div class="${cls}" data-field="${esc(name)}" style="--i:${Math.min(i, 20)}">
      <div class="f-meta">
        <span class="f-label">${esc(f.label)}${!f.nillable && f.updateable && f.type !== "boolean" ? '<b class="req">*</b>' : ""}</span>
        <span class="f-api" data-copy="${esc(name)}" title="${esc(L("Copiar API name", "Copy API name"))}">${esc(name)}</span>
        <span class="f-type">${esc(this.typeLabel(f))}</span>
      </div>
      <div class="f-val">${editing ? this.editorHtml(f) : this.displayHtml(f, this.value(name))}</div>
      <div class="f-act">${dirty && !editing ? `<button class="row-btn" data-undo title="${esc(L("Deshacer", "Undo"))}">${icon("undo")}</button>` : ""}${action}</div>
      ${error ? `<div class="f-error">${icon("alert-triangle")}<span>${esc(error)}</span></div>` : ""}
    </div>`;
  }

  replaceRow(name) {
    const el = this.body.querySelector(`.frow[data-field="${CSS.escape(name)}"]`);
    const x = this.fields.find((y) => y.f.name === name);
    if (!el || !x) return;
    el.outerHTML = this.rowHtml(x);
  }

  displayHtml(f, v) {
    const dash = '<span class="dash">—</span>';
    if (v === null || v === undefined || v === "") return f.type === "boolean" ? this.boolHtml(false) : dash;
    switch (f.type) {
      case "boolean":
        return this.boolHtml(v);
      case "date":
        return `<span title="${esc(v)}">${esc(formatDate(v))}</span>`;
      case "datetime":
        return `<span title="${esc(v)}">${esc(formatDateTime(v))} <em>${esc(relativeTime(v))}</em></span>`;
      case "currency":
        return esc(Number(v).toLocaleString(locale, { minimumFractionDigits: f.scale || 0, maximumFractionDigits: f.scale || 2 }));
      case "double":
      case "int":
        return esc(Number(v).toLocaleString(locale, { maximumFractionDigits: f.scale || 0 }));
      case "percent":
        return `${esc(Number(v).toLocaleString(locale, { maximumFractionDigits: f.scale || 2 }))} %`;
      case "picklist": {
        const label = f.picklistValues?.find((p) => p.value === v)?.label || v;
        return `<span class="pill" style="--k:${toneFor(v)}">${esc(label)}</span>`;
      }
      case "multipicklist":
        return String(v)
          .split(";")
          .map((x) => `<span class="chip">${esc(f.picklistValues?.find((p) => p.value === x)?.label || x)}</span>`)
          .join(" ");
      case "url":
        return `<a class="f-link" href="${esc(/^https?:/i.test(v) ? v : `https://${v}`)}" target="_blank" rel="noopener">${esc(v)}</a>`;
      case "email":
        return `<a class="f-link" href="mailto:${esc(v)}">${esc(v)}</a>`;
      case "reference":
      case "id": {
        if (f.type === "id") return `<span class="mono">${esc(v)}</span>`;
        const info = this.names.get(v);
        const obj = info?.obj || (f.referenceTo?.length === 1 ? f.referenceTo[0] : null);
        const label = info?.name || v;
        return obj
          ? `<button class="ref-link" data-open-ref="${esc(v)}" data-obj="${esc(obj)}" title="${esc(L("Abrir este registro aquí", "Open this record here"))}">${icon("link")}<span>${esc(label)}</span>${
              info?.name ? `<em class="mono">${esc(v)}</em>` : ""
            }</button>`
          : `<span class="mono">${esc(v)}</span>`;
      }
      case "address":
        return esc([v.street, v.city, v.state, v.postalCode, v.country].filter(Boolean).join(", ")) || dash;
      case "location":
        return esc(`${v.latitude ?? ""}, ${v.longitude ?? ""}`);
      case "textarea":
        return `<div class="f-long">${esc(f.htmlFormatted ? stripHtml(v) : v)}</div>`;
      default:
        return typeof v === "object" ? `<span class="mono">${esc(JSON.stringify(v))}</span>` : esc(v);
    }
  }

  boolHtml(v) {
    return `<span class="bool ${v ? "on" : ""}">${icon(v ? "check" : "x")}${esc(v ? L("Sí", "Yes") : L("No", "No"))}</span>`;
  }

  editorHtml(f) {
    const v = this.value(f.name);
    const val = v === null || v === undefined ? "" : v;
    const attrs = `class="f-editor" data-type="${f.type}"`;
    switch (f.type) {
      case "boolean":
        return `<label class="switch f-editor" data-type="boolean"><input type="checkbox" ${v ? "checked" : ""}><span class="track"></span><span>${esc(
          v ? L("Sí", "Yes") : L("No", "No")
        )}</span></label>`;
      case "picklist": {
        const opts = (f.picklistValues || []).filter((p) => p.active || p.value === v);
        return `<select ${attrs}><option value="">${esc(L("— Ninguno —", "— None —"))}</option>${opts
          .map((p) => `<option value="${esc(p.value)}" ${p.value === v ? "selected" : ""}>${esc(p.label || p.value)}</option>`)
          .join("")}</select>`;
      }
      case "multipicklist": {
        const sel = new Set(String(val).split(";").filter(Boolean));
        return `<div ${attrs}>${(f.picklistValues || [])
          .filter((p) => p.active || sel.has(p.value))
          .map(
            (p) =>
              `<label class="ms-opt"><input type="checkbox" value="${esc(p.value)}" ${sel.has(p.value) ? "checked" : ""}><span class="ms-box">${icon(
                "check"
              )}</span><span>${esc(p.label || p.value)}</span></label>`
          )
          .join("")}</div>`;
      }
      case "textarea":
        return `<textarea ${attrs} rows="4" maxlength="${f.length || ""}">${esc(val)}</textarea><small class="f-hint">${esc(
          L("Ctrl+Enter para guardar", "Ctrl+Enter to save")
        )}</small>`;
      case "int":
      case "double":
      case "currency":
      case "percent":
        return `<input ${attrs} type="number" step="${f.scale ? 1 / 10 ** f.scale : 1}" value="${esc(val)}">`;
      case "date":
        return `<input ${attrs} type="date" value="${esc(val)}">`;
      case "datetime":
        return `<input ${attrs} type="datetime-local" value="${esc(val ? toLocalInput(val) : "")}">`;
      case "time":
        return `<input ${attrs} type="time" step="1" value="${esc(String(val).slice(0, 8))}">`;
      case "reference":
        return `<input ${attrs} type="text" value="${esc(val)}" placeholder="${esc(
          L(`Id de ${(f.referenceTo || []).join(" / ")}`, `${(f.referenceTo || []).join(" / ")} Id`)
        )}" spellcheck="false"><small class="f-hint">${esc(L("Pega el Id (15 o 18 caracteres) del registro relacionado", "Paste the related record Id (15 or 18 characters)"))}</small>`;
      case "email":
        return `<input ${attrs} type="email" value="${esc(val)}" maxlength="${f.length || ""}">`;
      case "url":
        return `<input ${attrs} type="url" value="${esc(val)}" maxlength="${f.length || ""}">`;
      case "phone":
        return `<input ${attrs} type="tel" value="${esc(val)}" maxlength="${f.length || ""}">`;
      default:
        return `<input ${attrs} type="text" value="${esc(val)}" maxlength="${f.length || ""}" spellcheck="false">`;
    }
  }

  // ───────────────────────────────────────── Edición
  startEdit(name) {
    const x = this.fields.find((y) => y.f.name === name);
    if (!x?.editable) return;
    this.editing.add(name);
    this.replaceRow(name);
    const ed = this.body.querySelector(`.frow[data-field="${CSS.escape(name)}"] .f-editor`);
    const input = ed?.matches("input, select, textarea") ? ed : ed?.querySelector("input");
    input?.focus();
    if (input?.select && input.type === "text") input.select();
  }

  stopEdit(name) {
    this.editing.delete(name);
    this.replaceRow(name);
  }

  undo(name) {
    this.edits.delete(name);
    this.errors.delete(name);
    this.editing.delete(name);
    this.replaceRow(name);
    this.renderSavebar();
  }

  discard() {
    this.edits.clear();
    this.errors.clear();
    this.editing.clear();
    this.generalError = null;
    this.renderBody();
    this.renderSavebar();
  }

  readEditor(f, ed) {
    switch (f.type) {
      case "boolean":
        return ed.querySelector("input").checked;
      case "multipicklist": {
        const vals = [...ed.querySelectorAll("input:checked")].map((i) => i.value);
        return vals.length ? vals.join(";") : null;
      }
      case "int":
      case "double":
      case "currency":
      case "percent":
        return ed.value === "" ? null : Number(ed.value);
      case "datetime":
        return ed.value ? new Date(ed.value).toISOString() : null;
      case "time":
        return ed.value ? `${ed.value.length === 5 ? `${ed.value}:00` : ed.value}.000Z` : null;
      default:
        return ed.value.trim() === "" ? null : f.type === "reference" ? ed.value.trim() : ed.value;
    }
  }

  same(f, a, b) {
    const empty = (v) => v === null || v === undefined || v === "";
    if (empty(a) && empty(b)) return true;
    if (f.type === "boolean") return !!a === !!b;
    if (f.type === "datetime") return Date.parse(a) === Date.parse(b);
    if (f.type === "time") return String(a).slice(0, 8) === String(b).slice(0, 8);
    if (NUMBER_TYPES.has(f.type)) return Number(a) === Number(b);
    return String(a ?? "") === String(b ?? "");
  }

  onEditorChange(e) {
    const ed = e.target.closest(".f-editor");
    if (!ed) return;
    const row = ed.closest(".frow");
    const name = row.dataset.field;
    const x = this.fields.find((y) => y.f.name === name);
    const f = x.f;
    const v = this.readEditor(f, ed);
    if (f.type === "boolean") ed.querySelector("span:last-child").textContent = v ? L("Sí", "Yes") : L("No", "No");
    if (this.same(f, v, this.record[name])) this.edits.delete(name);
    else this.edits.set(name, v);
    this.errors.delete(name);
    row.classList.toggle("dirty", this.edits.has(name));
    row.classList.remove("has-error");
    row.querySelector(".f-error")?.remove();
    this.renderSavebar();
  }

  validate() {
    let ok = true;
    for (const [name, v] of this.edits) {
      const f = this.fields.find((y) => y.f.name === name).f;
      if ((v === null || v === "") && !f.nillable && f.type !== "boolean") {
        this.errors.set(name, L("Este campo es obligatorio", "This field is required"));
        ok = false;
      } else if (f.type === "reference" && v && !ID_RE.test(v)) {
        this.errors.set(name, L("No parece un Id válido de Salesforce", "This doesn't look like a valid Salesforce Id"));
        ok = false;
      }
    }
    return ok;
  }

  renderSavebar() {
    const n = this.edits.size;
    const show = n > 0 || !!this.generalError;
    this.savebar.classList.toggle("show", show);
    if (!show) return;
    this.savebar.innerHTML = `
      ${this.generalError ? `<div class="sb-error">${icon("alert-triangle")}<span>${esc(this.generalError)}</span></div>` : ""}
      <div class="sb-row">
        <span class="sb-count"><b>${n}</b> ${esc(n === 1 ? L("cambio sin guardar", "unsaved change") : L("cambios sin guardar", "unsaved changes"))}</span>
        <span class="spacer"></span>
        <button class="ghost-btn" data-act="discard" ${this.saving ? "disabled" : ""}>${icon("undo")}<span>${esc(L("Descartar", "Discard"))}</span></button>
        <button class="primary-btn sm" data-act="save" ${this.saving || !n ? "disabled" : ""}>${
          this.saving ? '<span class="spinner light"></span>' : icon("check")
        }<span>${esc(this.saving ? L("Guardando…", "Saving…") : L("Guardar", "Save"))}</span></button>
      </div>`;
  }

  async save() {
    if (!this.edits.size || this.saving) return;
    this.generalError = null;
    if (!this.validate()) {
      this.renderBody();
      this.renderSavebar();
      toast(L("Revisa los campos marcados", "Check the highlighted fields"), "error");
      return;
    }
    const { objectName, id } = this.current;
    const changes = Object.fromEntries(this.edits);
    this.saving = true;
    this.renderSavebar();
    try {
      await this.ctx.api.updateRecord(objectName, id, changes);
      const n = this.edits.size;
      this.flash = new Set(this.edits.keys());
      this.edits.clear();
      this.saving = false;
      toast(L(`Registro guardado (${n} ${n === 1 ? "campo" : "campos"})`, `Record saved (${n} ${n === 1 ? "field" : "fields"})`), "success");
      await this.load({ keepFlash: true });
      if (this.ctx.data.meta?.name === objectName) this.ctx.data.sync({ manual: false });
    } catch (e) {
      this.saving = false;
      if (e.status === 401) return this.ctx.sessionExpired();
      // Salesforce indica qué campos fallaron: mostramos el error junto a cada uno.
      let assigned = false;
      for (const err of e.errors || []) {
        for (const field of err.fields || []) {
          if (this.fields.some((y) => y.f.name === field)) {
            this.errors.set(field, err.message);
            assigned = true;
          }
        }
        if (!err.fields?.length) this.generalError = err.message;
      }
      if (!assigned && !this.generalError) this.generalError = friendlyError(e);
      this.renderBody();
      this.renderSavebar();
      toast(L("Salesforce no aceptó los cambios", "Salesforce rejected the changes"), "error");
    }
  }

  // ───────────────────────────────────────── Registros relacionados
  relatedBtnHtml() {
    if (this.view === "related") {
      return `<button type="button" class="rel-btn back" data-act="related">${icon("arrow-left")}<span>${esc(L("Volver a los campos", "Back to fields"))}</span></button>`;
    }
    if (this.related === null) {
      return `<button type="button" class="rel-btn loading" data-act="related" disabled><span class="spinner"></span><span>${esc(L("Buscando relacionados…", "Checking related…"))}</span></button>`;
    }
    const n = this.related.length;
    if (!n) {
      return `<button type="button" class="rel-btn" data-act="related" disabled title="${esc(
        L("Este registro no tiene registros relacionados visibles para tu usuario", "This record has no related records visible to your user")
      )}">${icon("link")}<span>${esc(L("Sin relacionados", "No related records"))}</span></button>`;
    }
    const total = this.related.reduce((a, r) => a + r.count, 0);
    const more = this.related.some((r) => r.count > REL_COUNT_MAX);
    return `<button type="button" class="rel-btn has" data-act="related" title="${esc(
      L(`${total}${more ? "+" : ""} registros en ${n} listas`, `${total}${more ? "+" : ""} records in ${n} lists`)
    )}">${icon("link")}<span>${esc(L("Relacionados", "Related"))}</span><b>${n}</b></button>`;
  }

  /** Cuenta los registros de cada relación hija con subconsultas agrupadas (en segundo plano). */
  async loadRelated(token) {
    const { objectName, id } = this.current;
    const api = this.ctx.api;
    let global = [];
    try {
      global = await api.describeGlobal();
    } catch {
      /* sin describe global: se intenta igual */
    }
    const byName = new Map(global.map((g) => [g.name, g]));
    const rels = (this.describe.childRelationships || []).filter(
      (r) => r.relationshipName && !r.deprecatedAndHidden && !NON_RELATED.test(r.childSObject) && (!global.length || byName.has(r.childSObject))
    );
    const counts = new Map();
    const countQuery = (list) =>
      `SELECT Id, ${list.map((r) => `(SELECT Id FROM ${r.relationshipName} LIMIT ${REL_COUNT_MAX + 1})`).join(", ")} FROM ${objectName} WHERE Id = '${soqlEscape(id)}'`;
    const read = (rec, list) => list.forEach((r) => counts.set(r.relationshipName, rec?.[r.relationshipName]?.records?.length || 0));

    for (let i = 0; i < rels.length; i += REL_CHUNK) {
      if (token !== this.token) return;
      const chunk = rels.slice(i, i + REL_CHUNK);
      try {
        read((await api.query(countQuery(chunk))).records[0], chunk);
      } catch {
        // Alguna relación no admite subconsultas: se prueban de a una y se ignoran las que fallan.
        await Promise.all(
          chunk.map((r) =>
            api
              .query(countQuery([r]))
              .then((res) => read(res.records[0], [r]))
              .catch(() => {})
          )
        );
      }
    }
    if (token !== this.token) return;

    const sameChild = new Map();
    rels.forEach((r) => sameChild.set(r.childSObject, (sameChild.get(r.childSObject) || 0) + 1));
    this.related = rels
      .filter((r) => counts.get(r.relationshipName) > 0)
      .map((r) => {
        const g = byName.get(r.childSObject);
        const base = g?.labelPlural || g?.label || r.relationshipName;
        return { rel: r, label: sameChild.get(r.childSObject) > 1 ? `${base} · ${r.field}` : base, count: counts.get(r.relationshipName) };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
    this.prefixMap = new Map(global.filter((g) => g.keyPrefix).map((g) => [g.keyPrefix, g.name]));
    if (this.view === "related" && !this.related.length) this.view = "fields";
    this.renderToolbar();
    if (this.view === "related") this.renderBody();
  }

  renderRelated() {
    if (this.related === null) {
      this.body.innerHTML = `<div class="empty"><div class="e-ico">${icon("link")}</div><h3>${esc(L("Buscando relacionados…", "Checking related…"))}</h3></div>`;
      return;
    }
    const q = this.relQ;
    const list = this.related.filter((r) => !q || `${r.label} ${r.rel.childSObject} ${r.rel.relationshipName}`.toLowerCase().includes(q));
    const fmtCount = (n) => (n > REL_COUNT_MAX ? `${REL_COUNT_MAX}+` : n.toLocaleString(locale));
    this.body.innerHTML = list.length
      ? `<section class="rec-sec"><h4>${esc(L("Registros relacionados", "Related records"))} <span>${list.length}</span></h4>${list
          .map((r, i) => {
            const [ic, color] = objectStyle({ name: r.rel.childSObject, custom: r.rel.childSObject.includes("__") });
            const st = this.relOpen.get(r.rel.relationshipName);
            const href = this.ctx.url(`/lightning/r/${this.current.objectName}/${this.current.id}/related/${r.rel.relationshipName}/view`);
            return `<div class="rel-group ${st ? "open" : ""}" style="--i:${Math.min(i, 20)}">
              <button type="button" class="rel-head" data-rel-toggle="${esc(r.rel.relationshipName)}">
                <span class="rel-ico" style="--c:${color}">${icon(ic)}</span>
                <span class="rel-text"><b>${esc(r.label)}</b><span>${esc(r.rel.childSObject)} · ${esc(r.rel.field)}</span></span>
                <span class="rel-count">${fmtCount(r.count)}</span>
                ${icon("chevron-down", "rel-caret")}
              </button>
              ${st ? this.relatedItemsHtml(r, st, href) : ""}
            </div>`;
          })
          .join("")}</section>`
      : `<div class="empty"><div class="e-ico">${icon("search")}</div><h3>${esc(L("Ninguna lista coincide", "No list matches"))}</h3></div>`;
  }

  relatedItemsHtml(r, st, href) {
    const all = r.count > REL_COUNT_MAX ? `${REL_COUNT_MAX}+` : String(r.count);
    const foot = `<a class="rel-more" data-sf href="${esc(href)}">${icon("external")}<span>${esc(
      r.count > REL_PAGE ? L(`Ver los ${all} en Salesforce`, `View all ${all} in Salesforce`) : L("Ver la lista en Salesforce", "View the list in Salesforce")
    )}</span></a>`;
    if (st.loading) return `<div class="rel-items"><div class="menu-loading"><span class="spinner"></span>${esc(L("Cargando…", "Loading…"))}</div></div>`;
    if (st.error) return `<div class="rel-items"><div class="f-error">${icon("alert-triangle")}<span>${esc(st.error)}</span></div>${foot}</div>`;
    return `<div class="rel-items">${st.records
      .map((rec) => {
        const obj = this.prefixMap?.get(String(rec.Id).slice(0, 3)) || r.rel.childSObject;
        const name = (st.nameField && rec[st.nameField]) || rec.Id;
        const when = rec.CreatedDate ? relativeTime(rec.CreatedDate) : "";
        return `<button type="button" class="ref-link rel-item" data-open-ref="${esc(rec.Id)}" data-obj="${esc(obj)}" title="${esc(L("Abrir aquí", "Open here"))}">
          ${icon("eye")}<span>${esc(name)}</span>${when ? `<em>${esc(when)}</em>` : ""}<em class="mono">${esc(rec.Id)}</em></button>`;
      })
      .join("")}${foot}</div>`;
  }

  /** Despliega una lista: trae sus primeros registros con una subconsulta sobre este registro. */
  async toggleRelated(relName) {
    if (this.relOpen.has(relName)) {
      this.relOpen.delete(relName);
      return this.renderBody();
    }
    const r = this.related.find((x) => x.rel.relationshipName === relName);
    const st = { loading: true };
    this.relOpen.set(relName, st);
    this.renderBody();
    const token = this.token;
    const { objectName, id } = this.current;
    try {
      let nameField = null;
      try {
        nameField = (await this.ctx.api.describe(r.rel.childSObject)).fields.find((f) => f.nameField)?.name || null;
      } catch {
        nameField = null;
      }
      const fields = ["Id", nameField, "CreatedDate"].filter((v, i, a) => v && a.indexOf(v) === i);
      const sub = (f, order) =>
        `SELECT (SELECT ${f.join(", ")} FROM ${relName}${order ? " ORDER BY CreatedDate DESC" : ""} LIMIT ${REL_PAGE}) FROM ${objectName} WHERE Id = '${soqlEscape(id)}'`;
      let res;
      try {
        res = await this.ctx.api.query(sub(fields, true));
      } catch {
        res = await this.ctx.api.query(sub(["Id"], false)); // objetos sin nombre o sin CreatedDate
        nameField = null;
      }
      Object.assign(st, { loading: false, records: res.records[0]?.[relName]?.records || [], nameField });
    } catch (e) {
      Object.assign(st, { loading: false, error: friendlyError(e) });
    }
    if (token === this.token && this.relOpen.get(relName) === st) this.renderBody();
  }

  // ───────────────────────────────────────── Nombres de los lookups
  async resolveNames(token) {
    const refs = this.fields.filter(({ f }) => f.type === "reference" && this.record[f.name]);
    if (!refs.length) return;
    let global = [];
    try {
      global = await this.ctx.api.describeGlobal();
    } catch {
      return;
    }
    const byPrefix = new Map(global.filter((s) => s.keyPrefix).map((s) => [s.keyPrefix, s.name]));
    const groups = new Map();
    for (const { f } of refs) {
      const id = this.record[f.name];
      const obj = byPrefix.get(id.slice(0, 3));
      if (!obj) continue;
      this.names.set(id, { name: null, obj });
      if (!groups.has(obj)) groups.set(obj, new Set());
      groups.get(obj).add(id);
    }
    await Promise.allSettled(
      [...groups].map(async ([obj, ids]) => {
        const list = [...ids].map((i) => `'${soqlEscape(i)}'`).join(",");
        let nameField = "Name";
        let res;
        try {
          res = await this.ctx.api.query(`SELECT Id, Name FROM ${obj} WHERE Id IN (${list})`);
        } catch {
          nameField = (await this.ctx.api.describe(obj)).fields.find((f) => f.nameField)?.name;
          if (!nameField) return;
          res = await this.ctx.api.query(`SELECT Id, ${nameField} FROM ${obj} WHERE Id IN (${list})`);
        }
        res.records.forEach((r) => this.names.set(r.Id, { name: r[nameField], obj }));
      })
    );
    if (token !== this.token) return;
    for (const { f } of refs) if (!this.editing.has(f.name)) this.replaceRow(f.name);
  }
}
