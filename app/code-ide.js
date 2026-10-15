// IDE integrado: explora, crea y edita Apex, triggers, Visualforce, LWC y Aura y guarda en la org.
// El editor (CodeMirror, ~200 KB comprimido) se carga solo la primera vez que se abre un archivo.
import {
  CODE_TYPES,
  CREATABLE,
  TRIGGER_EVENT_NAMES,
  LWC_TARGETS,
  APEX_TEMPLATES,
  loadCode,
  saveCode,
  currentStamp,
  listCode,
  createCode,
  validateName,
} from "../lib/code-deploy.js";
import { getType, resolveEntityIds } from "../lib/metadata-types.js";
import { L, locale } from "../lib/i18n.js";
import { $, icon, esc, toast, friendlyError, formatDateTime, highlight, storage } from "./ui.js";

const LANG_LABEL = { apex: "Apex", javascript: "JavaScript", html: "HTML", css: "CSS", xml: "XML" };
const LANG_COLOR = { apex: "#c084fc", javascript: "#fbbf24", html: "#f472b6", css: "#67e8f9", xml: "#86efac" };

const GROUP_LABEL = {
  ApexClass: L("Clases Apex", "Apex classes"),
  ApexTrigger: "Triggers",
  LightningComponentBundle: "Lightning Web Components",
  AuraDefinitionBundle: "Aura",
  ApexPage: L("Páginas Visualforce", "Visualforce pages"),
  ApexComponent: L("Componentes Visualforce", "Visualforce components"),
};
const TYPE_LABEL = {
  ApexClass: L("Clase Apex", "Apex class"),
  ApexTrigger: "Trigger",
  LightningComponentBundle: "LWC",
  AuraDefinitionBundle: L("Componente Aura", "Aura component"),
  ApexPage: L("Página VF", "VF page"),
  ApexComponent: L("Componente VF", "VF component"),
};
const NAME_PLACEHOLDER = {
  ApexClass: "AccountService",
  ApexTrigger: "AccountTrigger",
  LightningComponentBundle: "accountCard",
  AuraDefinitionBundle: "AccountCard",
  ApexPage: "AccountPage",
  ApexComponent: "AccountHeader",
};
const TEMPLATE_LABEL = {
  empty: L("Vacía", "Empty"),
  controller: L("Controlador para LWC / Aura (@AuraEnabled)", "LWC / Aura controller (@AuraEnabled)"),
  test: L("Clase de test (@IsTest)", "Test class (@IsTest)"),
  batch: "Batch (Database.Batchable)",
  schedulable: "Schedulable",
  queueable: "Queueable",
  invocable: L("Invocable desde Flow (@InvocableMethod)", "Invocable from Flow (@InvocableMethod)"),
};
const TARGET_LABEL = {
  lightning__AppPage: "App Page",
  lightning__RecordPage: "Record Page",
  lightning__HomePage: "Home Page",
  lightning__FlowScreen: "Flow Screen",
  lightning__Tab: "Tab",
};
const NAME_ERROR = {
  empty: L("Escribe un nombre.", "Enter a name."),
  long: L("El nombre admite hasta 40 caracteres.", "The name allows up to 40 characters."),
  chars: L(
    "Solo letras, números y «_»: debe empezar con una letra, sin «__» ni «_» al final.",
    "Letters, numbers and “_” only: it must start with a letter, with no “__” or trailing “_”."
  ),
  "lwc-case": L("Los LWC deben empezar con minúscula (camelCase), por ejemplo accountCard.", "LWC names must start with a lowercase letter (camelCase), e.g. accountCard."),
};
const LIST_MAX_AGE_MS = 60 * 1000; // al reabrir el IDE, refresca el explorador si pasó más de esto

let cmModule = null;
const loadEditor = () => (cmModule ||= import("../lib/vendor/codemirror.js"));

export const canEditCode = (typeKey) => !!CODE_TYPES[typeKey];

export class CodeIde {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = $("#ide");
    this.el = {
      head: $("#ide-head"),
      banner: $("#ide-banner"),
      files: $("#ide-files"),
      editorHost: $("#ide-editor"),
      problems: $("#ide-problems"),
      status: $("#ide-status"),
    };
    this.files = [];
    this.current = null;
    this.errors = [];
    this.row = null;
    this.list = null;
    this.collapsed = new Set(CREATABLE.filter((k) => k !== "ApexClass"));
    this.showManaged = false;
    storage.get("ideShowManaged", false).then((v) => {
      this.showManaged = !!v;
      this.el.managed.checked = this.showManaged;
      if (this.list) this.renderTree();
    });
    this.buildExplorer();
    this.buildModal();
    this.bind();
  }

  get isOpen() {
    return this.root.classList.contains("open");
  }

  get dirtyFiles() {
    return this.files.filter((f) => f.state && f.state.doc.toString() !== f.original);
  }

  buildExplorer() {
    this.el.files.innerHTML = `
      <div class="ide-x-head">
        <span class="ide-files-title">${esc(L("Explorador", "Explorer"))}</span>
        <button type="button" class="ide-x-btn" data-x="refresh" title="${esc(L("Actualizar la lista", "Refresh the list"))}">${icon("refresh")}</button>
        <button type="button" class="ide-x-btn accent" data-x="new" title="${esc(L("Nuevo componente", "New component"))}">${icon("plus")}</button>
      </div>
      <div class="ide-open hidden" data-open></div>
      <label class="ide-x-search">${icon("search")}<input type="text" data-x-search placeholder="${esc(
        L("Buscar clase, trigger, LWC…", "Search class, trigger, LWC…")
      )}" spellcheck="false" autocomplete="off"></label>
      <div class="ide-tree" data-tree></div>
      <label class="ide-x-foot"><input type="checkbox" data-x-managed><span>${esc(L("Mostrar paquetes administrados", "Show managed packages"))}</span></label>`;
    this.el.open = this.el.files.querySelector("[data-open]");
    this.el.tree = this.el.files.querySelector("[data-tree]");
    this.el.search = this.el.files.querySelector("[data-x-search]");
    this.el.managed = this.el.files.querySelector("[data-x-managed]");
    this.el.refresh = this.el.files.querySelector('[data-x="refresh"]');
  }

  buildModal() {
    this.modal = document.createElement("div");
    this.modal.className = "ide-modal hidden";
    this.root.querySelector(".ide-window").appendChild(this.modal);
  }

  bind() {
    this.el.head.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b || b.disabled) return;
      if (b.dataset.act === "close") this.close();
      if (b.dataset.act === "save") this.save();
      if (b.dataset.act === "validate") this.save({ checkOnly: true });
      if (b.dataset.act === "reload") this.reload();
      if (b.dataset.act === "new") this.openCreate();
      if (b.dataset.act === "home") this.goHome();
    });
    this.el.files.addEventListener("click", (e) => {
      const f = e.target.closest("[data-file]");
      if (f) return this.select(Number(f.dataset.file));
      const n = e.target.closest("[data-new]");
      if (n) return this.openCreate(n.dataset.new);
      const g = e.target.closest("[data-group]");
      if (g) return this.toggleGroup(g.dataset.group);
      const node = e.target.closest("[data-node]");
      if (node) return this.openNode(node.dataset.node, node.dataset.id);
      const x = e.target.closest("[data-x]");
      if (x?.dataset.x === "refresh") return this.ensureList(true);
      if (x?.dataset.x === "new") return this.openCreate();
      if (e.target.closest("[data-retry]")) this.ensureList(true);
    });
    this.el.files.addEventListener("keydown", (e) => {
      const g = e.target.closest("[data-group]");
      if (g && e.target === g && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        this.toggleGroup(g.dataset.group);
      }
    });
    this.el.search.addEventListener("input", () => this.renderTree());
    this.el.search.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.el.search.value) {
        e.stopPropagation();
        this.el.search.value = "";
        this.renderTree();
      }
      if (e.key === "Enter") this.el.tree.querySelector("[data-node]")?.click();
    });
    this.el.managed.addEventListener("change", () => {
      this.showManaged = this.el.managed.checked;
      storage.set("ideShowManaged", this.showManaged);
      this.renderTree();
    });
    this.el.editorHost.addEventListener("click", (e) => {
      const n = e.target.closest("[data-new]");
      if (n) this.openCreate(n.dataset.new);
    });
    this.el.problems.addEventListener("click", (e) => {
      const p = e.target.closest("[data-problem]");
      if (!p) return;
      const err = this.errors[Number(p.dataset.problem)];
      const idx = this.files.findIndex((f) => f.name === err.file);
      if (idx >= 0) this.select(idx);
      if (err.line) this.editor.goto(err.line, err.column || 1);
    });

    this.modal.addEventListener("click", (e) => {
      const c = e.target.closest("[data-ctype]");
      if (c) {
        this.captureCreateForm();
        this.createSpec.typeKey = c.dataset.ctype;
        this.renderCreate();
        this.modal.querySelector('[name="name"]')?.focus();
        return;
      }
      if (e.target.closest('[data-act="cancel"]')) this.closeCreate();
    });
    this.modal.addEventListener("change", (e) => {
      if (e.target.name === "exposed") this.modal.querySelector("[data-targets]")?.classList.toggle("hidden", !e.target.checked);
    });
    this.modal.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submitCreate(e.target);
    });
    this.modal.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.closeCreate();
      }
    });

    window.addEventListener("beforeunload", (e) => {
      if (this.isOpen && this.dirtyFiles.length) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  // ───────────────────────────────────────── Abrir / cerrar
  show() {
    if (!this.isOpen) {
      this.root.classList.remove("hidden");
      requestAnimationFrame(() => this.root.classList.add("open"));
    }
    this.ensureList(!this.listAt || Date.now() - this.listAt > LIST_MAX_AGE_MS);
  }

  /** Abre el IDE sin un componente: explorador + pantalla de bienvenida. */
  openWorkspace() {
    this.show();
    if (!this.row) this.renderWelcome();
    setTimeout(() => this.el.search.focus(), 60);
  }

  /** Abre un componente concreto (desde la vista de metadata o el explorador). */
  open(typeKey, row) {
    this.show();
    return this.loadComponent(typeKey, row);
  }

  async loadComponent(typeKey, row, { force = false } = {}) {
    if (!force && this.row && this.typeKey === typeKey && this.row.id === row.id && this.files.length) return;
    if (!force && !this.confirmDiscard()) return;
    const token = (this.loadToken = (this.loadToken || 0) + 1);
    this.typeKey = typeKey;
    this.row = row;
    this.def = getType(typeKey);
    this.files = [];
    this.errors = [];
    this.current = null;
    this.code = null;
    this.stamp = null;
    this.readOnly = null;
    this.loading = true;
    this.collapsed.delete(typeKey);
    this.editor?.destroy();
    this.editor = null;
    this.renderHead();
    this.renderFiles();
    this.renderTree();
    this.renderProblems();
    this.el.banner.className = "ide-banner hidden";
    this.el.editorHost.innerHTML = `<div class="ide-loading"><span class="spinner"></span>${esc(L("Cargando código…", "Loading code…"))}</div>`;
    this.el.status.innerHTML = "";

    try {
      const [cm, code] = await Promise.all([loadEditor(), loadCode(this.ctx.api, typeKey, row.id)]);
      if (token !== this.loadToken) return;
      this.loading = false;
      this.code = code;
      this.stamp = { lastModified: code.lastModified, lastModifiedBy: code.lastModifiedBy };
      this.readOnly = this.computeReadOnly(code);
      this.el.editorHost.innerHTML = "";
      this.editor = cm.createIde(this.el.editorHost, {
        onChange: () => this.onChange(),
        onSave: () => this.save(),
        onCursor: (line, col) => this.renderStatus(line, col),
      });
      this.files = code.files.map((f) => ({ ...f, original: f.source, state: this.editor.makeState(f.source, f.lang, !!this.readOnly) }));
      this.renderBanner();
      if (this.files.length) this.select(0);
      else {
        this.renderFiles();
        this.renderHead();
      }
    } catch (e) {
      if (token !== this.loadToken) return;
      if (e.status === 401) return this.ctx.sessionExpired();
      this.loading = false;
      this.renderFiles();
      this.el.editorHost.innerHTML = `<div class="empty error"><div class="e-ico">${icon("alert")}</div><h3>${esc(
        L("No se pudo abrir el código", "Could not open the code")
      )}</h3><p>${esc(friendlyError(e))}</p></div>`;
    }
  }

  confirmDiscard() {
    return !this.dirtyFiles.length || confirm(L("Hay cambios sin guardar en el código. ¿Descartarlos?", "There are unsaved code changes. Discard them?"));
  }

  close() {
    if (!this.confirmDiscard()) return;
    this.closeCreate();
    this.root.classList.remove("open");
    setTimeout(() => {
      if (this.isOpen) return;
      this.root.classList.add("hidden");
      this.editor?.destroy();
      this.editor = null;
      this.files = [];
      this.row = null;
      this.typeKey = null;
      this.loadToken = (this.loadToken || 0) + 1; // invalida cargas en curso
    }, 380);
  }

  /** Cierra el componente abierto y vuelve a la pantalla de inicio del IDE. */
  goHome() {
    if (this.saving || !this.confirmDiscard()) return;
    this.loadToken = (this.loadToken || 0) + 1; // invalida cargas en curso
    this.row = null;
    this.typeKey = null;
    this.def = null;
    this.code = null;
    this.files = [];
    this.errors = [];
    this.current = null;
    this.loading = false;
    this.renderWelcome();
    this.renderTree();
  }

  reload() {
    if (!this.confirmDiscard()) return;
    this.loadComponent(this.typeKey, this.row, { force: true });
  }

  /** null = editable; si no, el motivo. */
  computeReadOnly(code) {
    if (code.hidden) return L("Código oculto: pertenece a un paquete administrado.", "Hidden code: it belongs to a managed package.");
    if (code.namespace && code.namespace !== this.ctx.orgNamespace)
      return L(`Pertenece al paquete «${code.namespace}»: no se puede modificar.`, `Belongs to the “${code.namespace}” package: it can't be modified.`);
    return null;
  }

  get isApex() {
    return CODE_TYPES[this.typeKey]?.kind === "apex";
  }

  /** Salesforce no permite guardar Apex/Visualforce directamente en producción. */
  get blockedInProd() {
    return this.isApex && this.ctx.orgKindKey === "prod";
  }

  // ───────────────────────────────────────── Explorador
  async ensureList(force = false) {
    if (this.listLoading) {
      if (force) this.reloadList = true;
      return this.listLoading;
    }
    if (this.list && !force) return;
    this.listError = null;
    this.listLoading = (async () => {
      try {
        const list = await listCode(this.ctx.api);
        if (list.ApexTrigger.items) await resolveEntityIds(this.ctx.api, list.ApexTrigger.items).catch(() => {});
        this.list = list;
        this.listAt = Date.now();
      } catch (e) {
        if (e.status === 401) return this.ctx.sessionExpired();
        this.listError = e;
      }
    })();
    this.renderTree();
    await this.listLoading;
    this.listLoading = null;
    this.renderTree();
    if (this.reloadList) {
      this.reloadList = false;
      return this.ensureList(true);
    }
  }

  toggleGroup(key) {
    if (this.el.search.value.trim()) return; // con búsqueda, los grupos se muestran abiertos
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    this.renderTree();
  }

  openNode(key, id) {
    const it = this.list?.[key]?.items?.find((r) => r.id === id);
    if (!it) return;
    this.loadComponent(key, { id, name: it.ns ? `${it.ns}__${it.name}` : it.name, url: getType(key).url({ id }) });
  }

  visible(it) {
    return this.showManaged || !it.ns || it.ns === this.ctx.orgNamespace;
  }

  renderTree() {
    this.el.refresh.classList.toggle("spinning", !!this.listLoading);
    if (!this.list) {
      this.el.tree.innerHTML = this.listError
        ? `<div class="ide-tree-msg error">${icon("alert")}<span>${esc(friendlyError(this.listError))}</span><button type="button" class="ide-x-link" data-retry>${esc(
            L("Reintentar", "Retry")
          )}</button></div>`
        : `<div class="ide-tree-msg"><span class="spinner"></span>${esc(L("Cargando el código de la org…", "Loading the org's code…"))}</div>`;
      return;
    }
    const q = this.el.search.value.trim();
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const html = CREATABLE.map((key) => {
      const def = getType(key);
      const entry = this.list[key];
      let items = (entry.items || []).filter((it) => this.visible(it));
      if (tokens.length) {
        items = items.filter((it) => {
          const hay = `${it.ns ? `${it.ns}__` : ""}${it.name} ${it.label || ""} ${it.object || ""}`.toLowerCase();
          return tokens.every((t) => hay.includes(t));
        });
        if (!items.length) return "";
      }
      const open = tokens.length > 0 || !this.collapsed.has(key);
      return `<div class="ide-group ${open ? "open" : ""}">
        <div class="ide-group-head" data-group="${key}" role="button" tabindex="0" aria-expanded="${open}">
          ${icon("chevron-right", "ide-chev")}
          <span class="ide-group-ico" style="--c:${def.color}">${icon(def.icon)}</span>
          <span class="ide-group-name">${esc(GROUP_LABEL[key])}</span>
          ${
            entry.error
              ? `<span class="ide-group-err" title="${esc(friendlyError(entry.error))}">${icon("alert")}</span>`
              : `<span class="ide-group-count">${items.length.toLocaleString(locale)}</span>`
          }
          <button type="button" class="ide-group-new" data-new="${key}" title="${esc(L(`Nuevo: ${TYPE_LABEL[key]}`, `New ${TYPE_LABEL[key]}`))}">${icon("plus")}</button>
        </div>
        ${
          open
            ? `<div class="ide-group-items">${
                items.length
                  ? items.map((it) => this.nodeHtml(key, it, q)).join("")
                  : `<div class="ide-tree-empty">${esc(entry.error ? friendlyError(entry.error) : L("Todavía no hay ninguno", "None yet"))}</div>`
              }</div>`
            : ""
        }
      </div>`;
    }).join("");
    this.el.tree.innerHTML = html || `<div class="ide-tree-msg">${esc(L("Nada coincide con la búsqueda", "Nothing matches the search"))}</div>`;
  }

  nodeHtml(key, it, q) {
    const active = this.typeKey === key && this.row?.id === it.id;
    const managed = it.ns && it.ns !== this.ctx.orgNamespace;
    const meta = it.object || it.label || "";
    const title = [it.ns ? `${it.ns}__${it.name}` : it.name, it.label, it.object && `on ${it.object}`, it.lastModified && `${L("Modificado", "Modified")} ${formatDateTime(it.lastModified)}`]
      .filter(Boolean)
      .join("\n");
    return `<button type="button" class="ide-node ${active ? "active" : ""} ${managed ? "managed" : ""}" data-node="${key}" data-id="${esc(it.id)}" title="${esc(title)}">
      ${it.ns ? `<span class="ide-node-ns">${esc(it.ns)}</span>` : ""}
      <span class="ide-node-name">${highlight(it.name, q)}</span>
      ${meta ? `<span class="ide-node-meta">${highlight(meta, q)}</span>` : ""}
    </button>`;
  }

  // ───────────────────────────────────────── Render
  renderHead() {
    if (!this.row) {
      this.el.head.innerHTML = `
        <div class="rh-ico" style="--c:#6366f1">${icon("code")}</div>
        <div class="dh-title">
          <h3>IDE</h3>
          <p>${esc(L("Apex, triggers, LWC, Aura y Visualforce de la org", "Apex, triggers, LWC, Aura and Visualforce in the org"))}</p>
        </div>
        <div class="ide-actions">
          <button class="ghost-btn" data-act="new">${icon("plus")}<span>${esc(L("Nuevo", "New"))}</span></button>
          <button class="icon-btn" data-act="close" title="${esc(L("Cerrar", "Close"))}">${icon("x")}</button>
        </div>`;
      return;
    }
    const def = this.def;
    const dirty = this.dirtyFiles.length;
    const saving = this.saving;
    const canSave = !this.readOnly && !this.blockedInProd && dirty && !saving;
    const state = saving
      ? `<span class="ide-pill busy"><span class="spinner"></span>${esc(saving)}</span>`
      : dirty
        ? `<span class="ide-pill dirty">${icon("pencil")}${esc(L(`${dirty} sin guardar`, `${dirty} unsaved`))}</span>`
        : this.files.length
          ? `<span class="ide-pill ok">${icon("check-circle")}${esc(L("Guardado en la org", "Saved in the org"))}</span>`
          : "";
    const href = this.row?.url ? this.ctx.url(this.row.url) : null;
    this.el.head.innerHTML = `
      <button class="icon-btn ide-back" data-act="home" ${saving ? "disabled" : ""} title="${esc(L("Volver al inicio del IDE", "Back to the IDE home"))}">${icon("arrow-left")}</button>
      <div class="rh-ico" style="--c:${def.color}">${icon(def.icon)}</div>
      <div class="dh-title">
        <h3>${esc(this.row?.name || "")}</h3>
        <p>${esc(def.label)}${this.code?.apiVersion ? ` · API ${esc(this.code.apiVersion)}` : ""}${
          this.stamp?.lastModified ? ` · ${esc(L("modificado", "modified"))} ${esc(formatDateTime(this.stamp.lastModified))}${this.stamp.lastModifiedBy ? ` ${esc(L("por", "by"))} ${esc(this.stamp.lastModifiedBy)}` : ""}` : ""
        }</p>
      </div>
      ${state}
      <div class="ide-actions">
        <button class="icon-btn" data-act="reload" title="${esc(L("Recargar desde la org", "Reload from the org"))}">${icon("refresh")}</button>
        ${href ? `<a class="icon-btn" data-sf href="${esc(href)}" title="${esc(L("Abrir en Salesforce", "Open in Salesforce"))}">${icon("external")}</a>` : ""}
        ${
          this.isApex
            ? `<button class="ghost-btn" data-act="validate" ${this.readOnly || saving || !this.files.length ? "disabled" : ""} title="${esc(
                L("Compila en la org sin guardar", "Compiles in the org without saving")
              )}">${icon("shield-check")}<span>${esc(L("Validar", "Validate"))}</span></button>`
            : ""
        }
        <button class="primary-btn sm" data-act="save" ${canSave ? "" : "disabled"} title="Ctrl+S">${icon("upload")}<span>${esc(
          L("Guardar en la org", "Save to org")
        )}</span></button>
        <button class="icon-btn" data-act="close" title="${esc(L("Cerrar", "Close"))}">${icon("x")}</button>
      </div>`;
  }

  renderWelcome() {
    this.editor?.destroy();
    this.editor = null;
    this.renderHead();
    this.renderFiles();
    this.renderProblems();
    this.el.banner.className = "ide-banner hidden";
    this.el.status.innerHTML = "";
    this.el.editorHost.innerHTML = `<div class="ide-welcome">
      <div class="ide-welcome-ico">${icon("code")}</div>
      <h3>${esc(L("Elige un archivo del explorador", "Pick a file from the explorer"))}</h3>
      <p>${esc(L("O crea uno nuevo directamente en la org:", "Or create a new one directly in the org:"))}</p>
      <div class="ide-welcome-grid">${CREATABLE.map((k) => {
        const def = getType(k);
        return `<button type="button" class="ide-welcome-card" data-new="${k}" style="--c:${def.color}">${icon(def.icon)}<span>${esc(TYPE_LABEL[k])}</span></button>`;
      }).join("")}</div>
    </div>`;
  }

  renderBanner() {
    const msg = this.readOnly
      ? [icon("lock"), this.readOnly]
      : this.blockedInProd
        ? [
            icon("alert-triangle"),
            L(
              "Estás en producción: Salesforce no permite guardar Apex ni Visualforce directamente (exige desplegar con tests). Puedes editar y usar «Validar»; para guardar, hazlo en un sandbox y despliega.",
              "You're in production: Salesforce doesn't allow saving Apex or Visualforce directly (it requires a deployment with tests). You can edit and use “Validate”; to save, do it in a sandbox and deploy."
            ),
          ]
        : this.ctx.orgKindKey === "prod"
          ? [icon("alert-triangle"), L("Estás en producción: los cambios se aplican inmediatamente a los usuarios.", "You're in production: changes apply to users immediately.")]
          : null;
    this.el.banner.className = `ide-banner ${msg ? "" : "hidden"} ${this.readOnly ? "ro" : "warn"}`;
    if (msg) this.el.banner.innerHTML = `${msg[0]}<span>${esc(msg[1])}</span>`;
  }

  /** Sección «abierto» del explorador: los archivos del componente actual. */
  renderFiles() {
    const box = this.el.open;
    box.classList.toggle("hidden", !this.row);
    if (!this.row) return void (box.innerHTML = "");
    const errorsByFile = new Map();
    this.errors.forEach((e) => errorsByFile.set(e.file, (errorsByFile.get(e.file) || 0) + 1));
    box.innerHTML = `<div class="ide-open-title">
        <span class="ide-group-ico" style="--c:${this.def.color}">${icon(this.def.icon)}</span>
        <span class="ide-open-name" title="${esc(this.row.name)}">${esc(this.row.name)}</span>
      </div>${
        this.files.length
          ? this.files
              .map((f, i) => {
                const dirty = f.state.doc.toString() !== f.original;
                const errs = errorsByFile.get(f.name);
                return `<button class="ide-file ${i === this.current ? "active" : ""} ${dirty ? "dirty" : ""}" data-file="${i}" title="${esc(f.name)}">
                  <span class="ide-file-dot" style="--c:${LANG_COLOR[f.lang] || "#a5b4fc"}"></span>
                  <span class="ide-file-name">${esc(f.name)}</span>
                  ${errs ? `<span class="ide-file-err">${errs}</span>` : dirty ? '<span class="ide-file-mod" title="•"></span>' : ""}
                </button>`;
              })
              .join("")
          : this.loading
            ? `<div class="ide-tree-msg sm"><span class="spinner"></span></div>`
            : ""
      }`;
  }

  renderProblems() {
    const n = this.errors.length;
    this.el.problems.classList.toggle("show", n > 0);
    this.el.problems.innerHTML = n
      ? `<div class="ide-problems-title">${icon("alert-triangle")}${esc(L(`${n} ${n === 1 ? "problema" : "problemas"} de compilación`, `${n} compile ${n === 1 ? "problem" : "problems"}`))}</div>${this.errors
          .map(
            (e, i) => `<button class="ide-problem" data-problem="${i}">
              <span class="ide-problem-loc">${esc(e.file || "")}${e.line ? `:${e.line}${e.column ? `:${e.column}` : ""}` : ""}</span>
              <span class="ide-problem-msg">${esc(e.message)}</span>
            </button>`
          )
          .join("")}`
      : "";
  }

  renderStatus(line, col) {
    const f = this.files[this.current];
    if (!f) return;
    if (line) this.cursor = { line, col };
    ({ line = 1, col = 1 } = this.cursor || {});
    const dirty = this.dirtyFiles.length;
    this.el.status.innerHTML = `
      <span>${esc(L("Lín", "Ln"))} ${line}, ${esc(L("Col", "Col"))} ${col}</span>
      <span><i class="lang-dot" style="--c:${LANG_COLOR[f.lang]}"></i>${esc(LANG_LABEL[f.lang] || f.lang)}</span>
      <span>${f.state.doc.lines.toLocaleString(locale)} ${esc(L("líneas", "lines"))}</span>
      ${this.readOnly ? `<span class="ro">${icon("lock")}${esc(L("Solo lectura", "Read only"))}</span>` : ""}
      ${dirty ? `<span class="dirty">${esc(L(`${dirty} archivo(s) modificado(s)`, `${dirty} modified file(s)`))}</span>` : ""}
      <span class="spacer"></span>
      <span class="keys"><kbd>Ctrl</kbd>+<kbd>S</kbd> ${esc(L("guardar", "save"))} · <kbd>Ctrl</kbd>+<kbd>F</kbd> ${esc(L("buscar", "find"))} · <kbd>Ctrl</kbd>+<kbd>Space</kbd> ${esc(
        L("sugerencias", "suggestions")
      )}</span>`;
  }

  select(i) {
    if (!this.files[i] || !this.editor) return;
    if (this.current !== null && this.files[this.current]) this.files[this.current].state = this.editor.getState();
    this.current = i;
    this.cursor = null;
    this.editor.setState(this.files[i].state);
    this.applyErrors();
    this.renderFiles();
    this.renderHead();
    this.renderStatus();
    this.editor.focus();
  }

  applyErrors() {
    const f = this.files[this.current];
    if (f) this.editor.setErrors(this.errors.filter((e) => e.file === f.name));
  }

  onChange() {
    const f = this.files[this.current];
    if (!f) return;
    f.state = this.editor.getState();
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.renderFiles();
      this.renderHead();
    }, 60);
  }

  // ───────────────────────────────────────── Crear
  openCreate(typeKey) {
    this.createSpec = {
      typeKey: typeKey || this.createSpec?.typeKey || "ApexClass",
      name: "",
      label: "",
      template: "empty",
      sobject: "",
      events: ["before insert"],
      exposed: true,
      targets: ["lightning__AppPage", "lightning__RecordPage", "lightning__HomePage"],
    };
    this.renderCreate();
    this.modal.classList.remove("hidden");
    requestAnimationFrame(() => {
      this.modal.classList.add("open");
      this.modal.querySelector('[name="name"]')?.focus();
    });
  }

  closeCreate() {
    if (this.modal.classList.contains("hidden") || this.creating) return;
    this.modal.classList.remove("open");
    setTimeout(() => {
      if (!this.modal.classList.contains("open")) this.modal.classList.add("hidden");
    }, 260);
  }

  /** Guarda lo escrito antes de re-renderizar el formulario (al cambiar de tipo). */
  captureCreateForm() {
    const form = this.modal.querySelector("form");
    if (!form) return;
    const fd = new FormData(form);
    const s = this.createSpec;
    s.name = String(fd.get("name") ?? s.name).trim();
    if (fd.has("label")) s.label = String(fd.get("label")).trim();
    if (fd.has("template")) s.template = fd.get("template");
    if (fd.has("sobject")) s.sobject = String(fd.get("sobject")).trim();
    if (form.querySelector('[name="events"]')) s.events = fd.getAll("events");
    if (form.querySelector('[name="exposed"]')) {
      s.exposed = fd.get("exposed") === "on";
      s.targets = fd.getAll("targets");
    }
  }

  renderCreate(error = null) {
    const s = this.createSpec;
    const t = s.typeKey;
    const blocked = CODE_TYPES[t].kind === "apex" && this.ctx.orgKindKey === "prod";
    const labelField = `<label class="ide-fld"><span>${esc(L("Etiqueta", "Label"))} <em>${esc(L("(opcional, por defecto el nombre)", "(optional, defaults to the name)"))}</em></span>
      <input name="label" value="${esc(s.label)}" autocomplete="off" maxlength="80"></label>`;
    const specific = {
      ApexClass: `<label class="ide-fld"><span>${esc(L("Plantilla", "Template"))}</span><select name="template">${APEX_TEMPLATES.map(
        (k) => `<option value="${k}" ${k === s.template ? "selected" : ""}>${esc(TEMPLATE_LABEL[k])}</option>`
      ).join("")}</select></label>`,
      ApexTrigger: `<label class="ide-fld"><span>${esc(L("Objeto", "Object"))}</span>
          <input name="sobject" list="ide-sobjects" value="${esc(s.sobject)}" placeholder="Account" spellcheck="false" autocomplete="off"><datalist id="ide-sobjects"></datalist></label>
        <fieldset class="ide-checks"><legend>${esc(L("Eventos", "Events"))}</legend>${TRIGGER_EVENT_NAMES.map(
          (ev) => `<label class="ide-check"><input type="checkbox" name="events" value="${ev}" ${s.events.includes(ev) ? "checked" : ""}><span>${ev}</span></label>`
        ).join("")}</fieldset>`,
      LightningComponentBundle: `${labelField}
        <label class="ide-check plain"><input type="checkbox" name="exposed" ${s.exposed ? "checked" : ""}><span>${esc(
          L("Exponer en Lightning App Builder (isExposed)", "Expose in Lightning App Builder (isExposed)")
        )}</span></label>
        <fieldset class="ide-checks ${s.exposed ? "" : "hidden"}" data-targets><legend>Targets</legend>${LWC_TARGETS.map(
          (tg) => `<label class="ide-check"><input type="checkbox" name="targets" value="${tg}" ${s.targets.includes(tg) ? "checked" : ""}><span>${esc(TARGET_LABEL[tg])}</span></label>`
        ).join("")}</fieldset>`,
      AuraDefinitionBundle: labelField,
      ApexPage: labelField,
      ApexComponent: labelField,
    }[t];
    const files = {
      ApexClass: `${s.name || NAME_PLACEHOLDER[t]}.cls`,
      ApexTrigger: `${s.name || NAME_PLACEHOLDER[t]}.trigger`,
      LightningComponentBundle: ".html · .js · .js-meta.xml",
      AuraDefinitionBundle: ".cmp · Controller.js · Helper.js",
      ApexPage: ".page",
      ApexComponent: ".component",
    }[t];
    this.modal.innerHTML = `
      <div class="ide-modal-backdrop" data-act="cancel"></div>
      <form class="ide-modal-card" novalidate>
        <div class="ide-modal-head">
          <h3>${esc(L("Nuevo componente", "New component"))}</h3>
          <button type="button" class="icon-btn" data-act="cancel" title="${esc(L("Cancelar (Esc)", "Cancel (Esc)"))}">${icon("x")}</button>
        </div>
        <div class="ide-ctypes" role="radiogroup">${CREATABLE.map((k) => {
          const def = getType(k);
          return `<button type="button" role="radio" aria-checked="${k === t}" class="ide-ctype ${k === t ? "active" : ""}" data-ctype="${k}" style="--c:${def.color}">${icon(
            def.icon
          )}<span>${esc(TYPE_LABEL[k])}</span></button>`;
        }).join("")}</div>
        <label class="ide-fld"><span>${esc(L("Nombre", "Name"))} <em>${esc(files)}</em></span>
          <input name="name" value="${esc(s.name)}" placeholder="${NAME_PLACEHOLDER[t]}" spellcheck="false" autocomplete="off" maxlength="40"></label>
        ${specific}
        ${
          blocked
            ? `<div class="ide-modal-note">${icon("alert-triangle")}<span>${esc(
                L(
                  "Estás en producción: Salesforce no permite crear Apex ni Visualforce directamente. Créalo en un sandbox y despliégalo.",
                  "You're in production: Salesforce doesn't allow creating Apex or Visualforce directly. Create it in a sandbox and deploy it."
                )
              )}</span></div>`
            : ""
        }
        <div class="ide-modal-err ${error ? "" : "hidden"}" data-err>${error ? `${icon("alert")}<span>${esc(error)}</span>` : ""}</div>
        <div class="ide-modal-foot">
          <button type="button" class="ghost-btn" data-act="cancel">${esc(L("Cancelar", "Cancel"))}</button>
          <button type="submit" class="primary-btn sm" ${blocked ? "disabled" : ""}>${icon("plus")}<span>${esc(L("Crear en la org", "Create in org"))}</span></button>
        </div>
      </form>`;
    if (t === "ApexTrigger") this.fillSObjects();
  }

  async fillSObjects() {
    try {
      this.triggerable ||= (await this.ctx.api.describeGlobal()).filter((o) => o.triggerable).map((o) => o.name).sort();
      const dl = this.modal.querySelector("#ide-sobjects");
      if (dl) dl.innerHTML = this.triggerable.map((n) => `<option value="${esc(n)}"></option>`).join("");
    } catch {
      /* sin autocompletado: se puede escribir igual */
    }
  }

  showCreateError(message, field) {
    const box = this.modal.querySelector("[data-err]");
    box.innerHTML = `${icon("alert")}<span>${esc(message)}</span>`;
    box.classList.remove("hidden");
    this.modal.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
    const input = field && this.modal.querySelector(`[name="${field}"]`);
    if (input) {
      input.classList.add("invalid");
      input.focus();
    }
  }

  validateCreate(s) {
    const nameErr = validateName(s.typeKey, s.name);
    if (nameErr) return [NAME_ERROR[nameErr], "name"];
    const exists = this.list?.[s.typeKey]?.items?.some((it) => !it.ns && it.name.toLowerCase() === s.name.toLowerCase());
    if (exists) return [L(`Ya existe un componente llamado «${s.name}».`, `A component named “${s.name}” already exists.`), "name"];
    if (s.typeKey === "ApexTrigger") {
      if (!s.sobject) return [L("Indica el objeto del trigger.", "Enter the trigger's object."), "sobject"];
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(s.sobject)) return [L("El objeto debe ser un API name, por ejemplo Account o Mi_Objeto__c.", "The object must be an API name, e.g. Account or My_Object__c."), "sobject"];
      if (!s.events.length) return [L("Elige al menos un evento.", "Pick at least one event."), null];
    }
    return null;
  }

  async submitCreate(form) {
    if (this.creating) return;
    this.captureCreateForm();
    const spec = { ...this.createSpec };
    const invalid = this.validateCreate(spec);
    if (invalid) return this.showCreateError(...invalid);
    if (!this.confirmDiscard()) return;
    if (this.ctx.orgKindKey === "prod" && !confirm(L("Estás en PRODUCCIÓN. ¿Crear el componente ahora?", "You're in PRODUCTION. Create the component now?"))) return;

    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span><span>${esc(L("Creando…", "Creating…"))}</span>`;
    this.creating = true;
    try {
      const id = await createCode(this.ctx.api, spec);
      this.creating = false;
      toast(L(`«${spec.name}» se creó en la org`, `“${spec.name}” was created in the org`), "success");
      this.closeCreate();
      this.el.search.value = "";
      this.ensureList(true);
      if (this.ctx.metadata.def?.key === spec.typeKey) this.ctx.metadata.sync({ manual: false });
      this.loadComponent(spec.typeKey, { id, name: spec.name, url: getType(spec.typeKey).url({ id }) }, { force: true });
    } catch (e) {
      this.creating = false;
      if (e.status === 401) return this.ctx.sessionExpired();
      this.renderCreate(friendlyError(e));
    }
  }

  // ───────────────────────────────────────── Guardar / validar
  async save({ checkOnly = false } = {}) {
    if (this.saving || this.readOnly || !this.editor || !this.files.length) return;
    if (!checkOnly && this.blockedInProd) return toast(L("En producción no se puede guardar Apex directamente.", "Apex can't be saved directly in production."), "error");
    this.files[this.current].state = this.editor.getState();
    const changed = (checkOnly && this.isApex ? this.files : this.dirtyFiles).map((f) => ({ id: f.id, name: f.name, source: f.state.doc.toString() }));
    if (!changed.length) return toast(L("No hay cambios para guardar", "There are no changes to save"), "info", 1800);

    if (!checkOnly) {
      if (this.ctx.orgKindKey === "prod" && !confirm(L("Estás en PRODUCCIÓN. ¿Guardar los cambios ahora?", "You're in PRODUCTION. Save the changes now?"))) return;
      // ¿Alguien lo modificó después de que lo abrimos?
      try {
        const now = await currentStamp(this.ctx.api, this.typeKey, this.row.id);
        if (now.lastModified && this.stamp.lastModified && now.lastModified !== this.stamp.lastModified) {
          const who = now.lastModifiedBy ? ` ${L("por", "by")} ${now.lastModifiedBy}` : "";
          const ok = confirm(
            L(
              `Este componente se modificó en la org${who} (${formatDateTime(now.lastModified)}) después de que lo abriste. Si guardas, sobrescribirás esos cambios. ¿Continuar?`,
              `This component was modified in the org${who} (${formatDateTime(now.lastModified)}) after you opened it. Saving will overwrite those changes. Continue?`
            )
          );
          if (!ok) return;
        }
      } catch {
        /* si no se puede comprobar, seguimos: Salesforce valida igual */
      }
    }

    const started = performance.now();
    this.saving = checkOnly ? L("Compilando…", "Compiling…") : L("Guardando…", "Saving…");
    this.renderHead();
    try {
      const res = await saveCode(this.ctx.api, this.typeKey, changed, {
        checkOnly,
        onProgress: (step) => {
          this.saving = `${checkOnly ? L("Compilando", "Compiling") : L("Guardando", "Saving")}… ${step === "Queued" ? L("(en cola)", "(queued)") : ""}`;
          this.renderHead();
        },
      });
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      this.errors = res.errors;
      if (res.ok) {
        if (!checkOnly) {
          for (const f of this.files) f.original = f.state.doc.toString();
          try {
            this.stamp = await currentStamp(this.ctx.api, this.typeKey, this.row.id);
          } catch {
            /* sin sello actualizado */
          }
          if (this.ctx.metadata.def?.key === this.typeKey) this.ctx.metadata.sync({ manual: false });
        }
        toast(
          checkOnly
            ? L(`Compila sin errores (${secs} s)`, `Compiles without errors (${secs} s)`)
            : L(`Guardado en la org (${secs} s)`, `Saved to the org (${secs} s)`),
          "success"
        );
      } else {
        if (!this.errors.length) this.errors = [{ file: this.files[this.current].name, line: null, column: null, message: res.message || L("Error desconocido", "Unknown error") }];
        toast(L("Salesforce encontró errores: revisa el panel de problemas", "Salesforce found errors: check the problems panel"), "error");
        const first = this.errors.find((e) => e.line);
        if (first) {
          const idx = this.files.findIndex((f) => f.name === first.file);
          if (idx >= 0 && idx !== this.current) this.select(idx);
          this.editor.goto(first.line, first.column || 1);
        }
      }
    } catch (e) {
      if (e.status === 401) return this.ctx.sessionExpired();
      this.errors = [{ file: this.files[this.current].name, line: null, column: null, message: friendlyError(e) }];
      toast(friendlyError(e), "error");
    } finally {
      this.saving = null;
      this.applyErrors();
      this.renderProblems();
      this.renderFiles();
      this.renderHead();
      this.renderStatus();
    }
  }
}
