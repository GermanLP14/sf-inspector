// Vista "Data": elegir objeto → records con filtros (nombre/Id, picklist, dueño, fechas).
// Las consultas usan la sesión del usuario: Salesforce aplica sharing, CRUD y FLS.
import { soqlEscape, likeEscape } from "../lib/sfapi.js";
import { L, locale } from "../lib/i18n.js";
import { Combobox, MultiSelect } from "./combobox.js";
import { ExportMenu } from "./export-menu.js";
import {
  $,
  icon,
  esc,
  highlight,
  whenCell,
  debounce,
  animateCount,
  copyText,
  storage,
  skeletonRows,
  emptyState,
  friendlyError,
  replayAnimation,
  toneFor,
  colorFor,
  initials,
  toast,
} from "./ui.js";

// Búsqueda global de registros: campos que se muestran por objeto (los custom usan Name).
const SEARCH_FIELDS = {
  Account: ["Name", "Type"],
  Contact: ["Name", "Email"],
  Lead: ["Name", "Company"],
  Opportunity: ["Name", "StageName"],
  Case: ["CaseNumber", "Subject"],
  Campaign: ["Name"],
  Product2: ["Name", "ProductCode"],
  Asset: ["Name"],
  Contract: ["ContractNumber"],
  Order: ["OrderNumber"],
  Quote: ["Name"],
  User: ["Name", "Username"],
  Task: ["Subject"],
  Event: ["Subject"],
  WorkOrder: ["WorkOrderNumber", "Subject"],
  Entitlement: ["Name"],
  ServiceContract: ["Name"],
  Pricebook2: ["Name"],
};
const MAX_SEARCH_OBJECTS = 80;
const SEARCH_PER_OBJECT = 5;
const SEARCH_LIMIT = 50;

const POPULAR = ["Account", "Contact", "Opportunity", "Lead", "Case", "Task", "Event", "Campaign", "User", "Product2", "Contract", "Order", "Quote", "Asset"];
const OBJECT_STYLE = {
  Account: ["building", "#6366f1"],
  Contact: ["user", "#0ea5e9"],
  Opportunity: ["trending", "#f59e0b"],
  Lead: ["target", "#10b981"],
  Case: ["briefcase", "#ef4444"],
  Task: ["check-circle", "#14b8a6"],
  Event: ["calendar", "#ec4899"],
  Campaign: ["megaphone", "#f97316"],
  User: ["users", "#64748b"],
  Product2: ["package", "#84cc16"],
  Contract: ["file-text", "#8b5cf6"],
  Order: ["cart", "#06b6d4"],
  Quote: ["tag", "#d946ef"],
  Asset: ["box", "#0284c7"],
};
const STATUS_NAMES = ["Status", "StageName", "Status__c", "Stage__c", "Estado__c", "State__c"];
const NON_DATA = /(Share|History|Feed|ChangeEvent|Tag|__hd)$/;
const ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const SEARCHABLE_TYPES = new Set(["string", "email", "phone", "url", "picklist", "id", "combobox", "textarea"]);
const PRESETS = [
  ["today", L("Hoy", "Today")],
  ["7", L("7 días", "7 days")],
  ["30", L("30 días", "30 days")],
  ["90", L("90 días", "90 days")],
  ["month", L("Este mes", "This month")],
  ["year", L("Este año", "This year")],
];
const NEW_HIGHLIGHT_MS = 10 * 60 * 1000;
const fmt = (n) => (n || 0).toLocaleString(locale);

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const getPath = (rec, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), rec);

export function objectStyle(o) {
  return OBJECT_STYLE[o.name] || (o.custom ? ["box", "#a855f7"] : ["database", "#0ea5e9"]);
}

export class DataView {
  constructor(ctx) {
    this.ctx = ctx;
    this.objects = null;
    this.byName = new Map();
    this.meta = null;
    this.records = [];
    this.recentKey = `recentObjects:${ctx.session.orgId}`;
    this.openToken = 0;
    this.queryToken = 0;
    this.newIds = new Map(); // Id → momento en que apareció (para resaltarlo)
    this.flashIds = new Set();

    this.el = {
      home: $("#dt-home"),
      popular: $("#dt-popular"),
      recentWrap: $("#dt-recent-wrap"),
      recent: $("#dt-recent"),
      results: $("#dt-results"),
      headIco: $("#dt-head-ico"),
      title: $("#dt-title"),
      subtitle: $("#dt-subtitle"),
      count: $("#dt-count"),
      back: $("#dt-back"),
      refresh: $("#dt-refresh"),
      live: $("#dt-live"),
      scroll: $("#dt-scroll"),
      openSf: $("#dt-open-sf"),
      search: $("#dt-search"),
      pickWrap: $("#dt-pick-wrap"),
      pickField: $("#dt-pick-field"),
      pickValuesHost: $("#dt-pick-values"),
      mineWrap: $("#dt-mine-wrap"),
      mine: $("#dt-mine"),
      dateField: $("#dt-date-field"),
      presets: $("#dt-presets"),
      from: $("#dt-from"),
      to: $("#dt-to"),
      reset: $("#dt-reset"),
      soqlToggle: $("#dt-soql-toggle"),
      thead: $("#dt-thead"),
      tbody: $("#dt-tbody"),
      empty: $("#dt-empty"),
      foot: $("#dt-foot"),
      sentinel: $("#dt-sentinel"),
    };

    this.picker = new Combobox($("#dt-picker"), {
      size: "lg",
      leadingIcon: "database",
      placeholder: L("Cargando objetos…", "Loading objects…"),
      emptyText: L("Ningún objeto coincide (o no tienes acceso)", "No object matches (or you have no access)"),
      onSelect: (it) => (it?.extra ? this.openFound(it) : it ? this.open(it.value) : this.showHome()),
      search: (q, update) => this.searchRecords(q, update),
    });

    this.pickValues = new MultiSelect(this.el.pickValuesHost, {
      placeholder: L("Todos los valores", "All values"),
      onChange: (values) => {
        this.state.pickValues = values;
        this.runQuery();
      },
    });

    this.el.presets.innerHTML = PRESETS.map(([k, l]) => `<button type="button" class="chip-btn" data-preset="${k}">${l}</button>`).join("");
    this.bind();
  }

  bind() {
    const el = this.el;
    el.back.addEventListener("click", () => this.showHome());
    el.refresh.addEventListener("click", () => this.meta && this.sync({ manual: true }));
    el.foot.addEventListener("click", (e) => e.target.closest("[data-reload]") && this.runQuery());

    const searchNow = () => {
      this.state.q = el.search.value.trim();
      this.runQuery();
    };
    const searchLater = debounce(searchNow, 380);
    el.search.addEventListener("input", searchLater);
    el.search.addEventListener("keydown", (e) => e.key === "Enter" && searchNow());

    el.pickField.addEventListener("change", () => {
      this.state.pickField = el.pickField.value;
      this.state.pickValues = [];
      this.syncPickValues();
      this.runQuery();
    });
    el.mine.addEventListener("change", () => {
      this.state.mine = el.mine.checked;
      this.runQuery();
    });
    el.dateField.addEventListener("change", () => {
      this.state.dateField = el.dateField.value;
      this.runQuery();
    });
    el.presets.addEventListener("click", (e) => {
      const b = e.target.closest("[data-preset]");
      if (!b) return;
      this.applyPreset(this.state.preset === b.dataset.preset ? "" : b.dataset.preset);
      this.runQuery();
    });
    const onDate = () => {
      this.state.from = el.from.value;
      this.state.to = el.to.value;
      this.state.preset = "";
      this.syncPresets();
      this.runQuery();
    };
    el.from.addEventListener("change", onDate);
    el.to.addEventListener("change", onDate);
    el.reset.addEventListener("click", () => {
      this.state = this.defaultState();
      this.renderFilters();
      this.runQuery();
    });
    // SOQL → consola con la query actual (el FROM ya apunta al objeto abierto).
    el.soqlToggle.addEventListener("click", () => this.ctx.console.open({ soql: this.meta ? this.buildSoql() : "", mode: "data" }));
    this.exporter = new ExportMenu($("#dt-export"), {
      api: this.ctx.api,
      getQuery: () => (this.meta ? { soql: this.buildSoql().replace(/\n\s*/g, " "), baseName: this.meta.name } : null),
    });

    el.thead.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (!th) return;
      const field = th.dataset.sort;
      const s = this.state.sort;
      const isDate = /Date$/.test(field) || ["date", "datetime"].includes(this.meta.byName[field]?.type);
      this.state.sort = { field, dir: s.field === field ? (s.dir === "ASC" ? "DESC" : "ASC") : isDate ? "DESC" : "ASC" };
      this.runQuery();
    });

    el.tbody.addEventListener("click", (e) => {
      const copy = e.target.closest("[data-copy]");
      if (copy) return copyText(copy.dataset.copy);
      // Click en la fila (fuera de enlaces y botones) o en el ojo → ficha completa dentro de la extensión.
      const view = e.target.closest("[data-view-record]");
      const row = e.target.closest("tr[data-id]");
      if (view || (row && !e.target.closest("a, button") && !getSelection().toString())) {
        this.ctx.record.open(this.meta.name, (view || row).dataset.viewRecord || row.dataset.id);
      }
    });

    const onCard = (e) => {
      const card = e.target.closest("[data-object]");
      if (card) this.open(card.dataset.object);
    };
    el.popular.addEventListener("click", onCard);
    el.recent.addEventListener("click", onCard);
    el.popular.addEventListener("mousemove", (e) => {
      const card = e.target.closest(".type-card");
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    });

    new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) this.loadMore();
      },
      { rootMargin: "300px" }
    ).observe(el.sentinel);
  }

  // ───────────────────────────────────────── Objetos
  activate() {
    if (this.meta) {
      this.ctx.setHash(`d=${this.meta.name}`);
      this.ctx.setCompact(true);
    } else {
      this.ctx.setHash("");
      this.ctx.setCompact(false);
    }
    if (!this.objects && !this.loadingObjects) this.loadObjects();
  }

  async loadObjects() {
    this.loadingObjects = true;
    this.el.popular.innerHTML = Array.from({ length: 8 }, () => `<div class="type-card skel-card"><div class="skel"></div></div>`).join("");
    try {
      const all = await this.ctx.api.describeGlobal();
      this.setObjects(all);
      this.renderPopular();
      this.renderRecent();
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        this.open(p);
      }
    } catch (e) {
      this.el.popular.innerHTML = emptyState({ error: true, title: L("No se pudieron cargar los objetos", "Could not load objects"), text: friendlyError(e) });
      if (e.status === 401) this.ctx.sessionExpired();
    } finally {
      this.loadingObjects = false;
    }
  }

  setObjects(all) {
    this.objects = all
      .filter((s) => s.queryable && s.retrieveable && !s.deprecatedAndHidden && !NON_DATA.test(s.name))
      .sort((a, b) => a.label.localeCompare(b.label));
    this.objectsAt = Date.now();
    this.byName = new Map(this.objects.map((o) => [o.name, o]));
    this.picker.setItems(
      this.objects.map((o) => {
        const [ic, color] = objectStyle(o);
        return { value: o.name, label: o.label, sublabel: o.name, icon: ic, color, meta: o.keyPrefix || "", keywords: o.labelPlural };
      })
    );
    this.picker.input.placeholder = L(
      `Elige un objeto (${this.objects.length}) o busca registros por nombre, email o Id…`,
      `Pick an object (${this.objects.length}) or search records by name, email or Id…`
    );
  }

  /** Objetos donde busca el buscador global: los estándar más comunes y todos los custom buscables. */
  searchTargets() {
    if (this.targetsFor === this.objects) return this.targets;
    const known = this.objects.filter((o) => o.searchable && SEARCH_FIELDS[o.name]).map((o) => ({ o, fields: SEARCH_FIELDS[o.name] }));
    const custom = this.objects.filter((o) => o.searchable && o.custom && o.name.endsWith("__c")).map((o) => ({ o, fields: ["Name"] }));
    this.targetsFor = this.objects;
    this.targets = [...known, ...custom].slice(0, MAX_SEARCH_OBJECTS);
    return this.targets;
  }

  /**
   * Búsqueda global de registros (SOSL) desde el buscador principal. Si se pega un Id,
   * se reconoce el objeto por su prefijo y se ofrece abrirlo directamente.
   */
  async searchRecords(q, update) {
    if (!this.objects) return update([], { text: L("Cargando objetos…", "Loading objects…") });
    const items = [];
    if (ID_RE.test(q)) {
      const o = this.objects.find((x) => x.keyPrefix && q.startsWith(x.keyPrefix));
      if (o) {
        const [ic, color] = objectStyle(o);
        items.push({ value: `r:${q}`, label: q, sublabel: L(`Abrir este registro de ${o.label}`, `Open this ${o.label} record`), icon: ic, color, group: L("Registro por Id", "Record by Id"), objectName: o.name, recordId: q });
      }
    }
    const targets = this.searchTargets();
    const term = q.replace(/[?&|!{}[\]()^~*:\\"'+-]/g, "\\$&");
    if (!targets.length || q.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return update(items, items.length ? null : { text: L("Escribe al menos 2 letras o números", "Type at least 2 letters or numbers") });
    update(items, { loading: true, text: L(`Buscando registros en ${targets.length} objetos…`, `Searching records in ${targets.length} objects…`) });
    const sosl = `FIND {${term}*} IN ALL FIELDS RETURNING ${targets.map((t) => `${t.o.name}(Id, ${t.fields.join(", ")} LIMIT ${SEARCH_PER_OBJECT})`).join(", ")} LIMIT ${SEARCH_LIMIT}`;
    try {
      const res = await this.ctx.api.search(sosl);
      const recs = res?.searchRecords || [];
      const byName = new Map(targets.map((t) => [t.o.name, t]));
      for (const r of recs) {
        const t = byName.get(r.attributes?.type);
        if (!t) continue;
        const [ic, color] = objectStyle(t.o);
        const vals = t.fields.map((f) => r[f]).filter((v) => v != null && v !== "");
        items.push({
          value: `r:${r.Id}`,
          label: String(vals[0] ?? r.Id),
          sublabel: vals.slice(1).join(" · ") || t.o.label,
          icon: ic,
          color,
          group: t.o.labelPlural || t.o.label,
          meta: r.Id,
          objectName: t.o.name,
          recordId: r.Id,
        });
      }
      update(
        items,
        recs.length
          ? { text: L(`${recs.length} registros encontrados${recs.length >= SEARCH_LIMIT ? " (primeros resultados)" : ""}`, `${recs.length} records found${recs.length >= SEARCH_LIMIT ? " (top results)" : ""}`) }
          : items.length
            ? null
            : { text: L("Ningún registro coincide (la búsqueda respeta tus permisos)", "No record matches (search respects your permissions)") }
      );
    } catch (e) {
      if (e.status === 401) return this.ctx.sessionExpired();
      update(items, { text: friendlyError(e) });
    }
  }

  /** Resultado del buscador global: abre la lista del objeto y la ficha del registro. */
  openFound(it) {
    this.open(it.objectName);
    this.ctx.record.open(it.objectName, it.recordId);
  }

  /** Vuelve a leer la lista de objetos para incluir los recién creados. */
  async refreshObjects() {
    if (!this.objects || this.refreshingObjects) return;
    this.refreshingObjects = true;
    try {
      const before = new Set(this.objects.map((o) => o.name));
      this.ctx.api.invalidateGlobal();
      this.setObjects(await this.ctx.api.describeGlobal());
      const added = this.objects.filter((o) => !before.has(o.name));
      if (added.length) {
        toast(L(`Objetos nuevos disponibles: ${added.map((o) => o.label).join(", ")}`, `New objects available: ${added.map((o) => o.label).join(", ")}`), "success", 4000);
        this.renderRecent();
      }
    } catch {
      /* se reintenta en la próxima sincronización */
    } finally {
      this.refreshingObjects = false;
    }
  }

  renderPopular() {
    const list = POPULAR.map((n) => this.byName.get(n)).filter(Boolean);
    this.el.popular.innerHTML = list
      .map((o, i) => {
        const [ic, color] = objectStyle(o);
        return `<button class="type-card" data-object="${esc(o.name)}" style="--c:${color};--i:${i}">
          <span class="tc-ico">${icon(ic)}</span>
          <span class="tc-text"><strong>${esc(o.labelPlural || o.label)}</strong><span>${esc(o.name)}</span></span>
          <span class="tc-arrow">${icon("chevron-right")}</span>
        </button>`;
      })
      .join("");
  }

  async renderRecent() {
    const names = (await storage.get(this.recentKey, [])).filter((n) => this.byName.has(n));
    this.el.recentWrap.classList.toggle("hidden", !names.length);
    this.el.recent.innerHTML = names
      .map((n) => {
        const o = this.byName.get(n);
        const [ic, color] = objectStyle(o);
        return `<button class="recent-chip" data-object="${esc(n)}" style="--c:${color}">${icon(ic)}${esc(o.label)}</button>`;
      })
      .join("");
  }

  async pushRecent(name) {
    const list = (await storage.get(this.recentKey, [])).filter((n) => n !== name);
    list.unshift(name);
    await storage.set(this.recentKey, list.slice(0, 8));
  }

  showHome() {
    this.meta = null;
    this.openToken++;
    this.queryToken++;
    this.abort?.abort();
    this.picker.clear();
    this.el.results.classList.add("hidden");
    this.el.home.classList.remove("hidden");
    replayAnimation(this.el.home);
    this.renderRecent();
    this.ctx.setHash("");
    this.ctx.setCompact(false);
  }

  // ───────────────────────────────────────── Abrir objeto
  async open(name) {
    if (!this.objects) {
      this.pending = name;
      if (!this.loadingObjects) this.loadObjects();
      return;
    }
    const sobj = this.byName.get(name);
    if (!sobj) {
      toast(L(`El objeto "${name}" no existe o tu usuario no tiene acceso`, `Object "${name}" doesn't exist or your user has no access`), "error");
      return this.showHome();
    }
    this.picker.setValue(name);
    this.ctx.setHash(`d=${name}`);
    this.ctx.setCompact(true);
    this.pushRecent(name);

    const el = this.el;
    const [ic, color] = objectStyle(sobj);
    el.home.classList.add("hidden");
    el.results.classList.remove("hidden");
    replayAnimation(el.results);
    el.headIco.style.setProperty("--c", color);
    el.headIco.innerHTML = icon(ic);
    el.title.textContent = sobj.labelPlural || sobj.label;
    el.subtitle.innerHTML = `<span class="mono">${esc(sobj.name)}</span>${sobj.keyPrefix ? ` · ${L("prefijo", "prefix")} <span class="mono">${esc(sobj.keyPrefix)}</span>` : ""}`;
    el.openSf.href = this.ctx.url(name.endsWith("__mdt") ? "/lightning/setup/CustomMetadata/home" : `/lightning/o/${name}/list`);
    el.count.textContent = "…";
    el.thead.innerHTML = "";
    el.tbody.innerHTML = skeletonRows(5, 9);
    el.empty.innerHTML = "";
    el.foot.innerHTML = `<span class="loading"><span class="spinner"></span> ${esc(L(`Leyendo estructura de ${sobj.label}…`, `Reading ${sobj.label} structure…`))}</span>`;
    this.meta = null;
    this.newIds.clear();

    const token = ++this.openToken;
    try {
      const describe = await this.ctx.api.describe(name);
      if (token !== this.openToken) return;
      this.meta = this.analyze(describe);
      this.state = this.defaultState();
      this.renderFilters();
      await this.runQuery();
    } catch (e) {
      if (token !== this.openToken) return;
      el.tbody.innerHTML = "";
      el.foot.innerHTML = "";
      el.empty.innerHTML = emptyState({ error: true, title: L(`No se pudo abrir ${sobj.label}`, `Could not open ${sobj.label}`), text: friendlyError(e) });
      if (e.status === 401) this.ctx.sessionExpired();
    }
  }

  analyze(d) {
    const fields = d.fields;
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    const nameField = fields.find((f) => f.nameField)?.name || null;
    const nf = nameField ? byName[nameField] : null;
    const picklists = fields
      .filter((f) => f.type === "picklist" && f.filterable && f.picklistValues?.length)
      .sort((a, b) => a.label.localeCompare(b.label));
    const statusField =
      picklists.find((f) => STATUS_NAMES.includes(f.name)) || picklists.find((f) => /status|stage|estado/i.test(f.name)) || null;
    const dateFields = fields
      .filter((f) => (f.type === "datetime" || f.type === "date") && f.filterable)
      .sort((a, b) => {
        const rank = (f) => (f.name === "CreatedDate" ? 0 : f.name === "LastModifiedDate" ? 1 : 2);
        return rank(a) - rank(b) || a.label.localeCompare(b.label);
      });
    return {
      name: d.name,
      label: d.label,
      keyPrefix: d.keyPrefix,
      byName,
      nameField,
      searchField: nf && nf.filterable && SEARCHABLE_TYPES.has(nf.type) ? nameField : null,
      picklists,
      statusField: statusField?.name || "",
      dateFields,
      hasOwner: byName.OwnerId?.relationshipName === "Owner",
      hasRecordType: byName.RecordTypeId?.relationshipName === "RecordType",
    };
  }

  defaultState() {
    const m = this.meta;
    const sortField = ["LastModifiedDate", "CreatedDate"].find((f) => m.byName[f]?.sortable) || (m.nameField && m.byName[m.nameField].sortable ? m.nameField : "Id");
    return {
      q: "",
      pickField: m.statusField,
      pickValues: [],
      mine: false,
      dateField: m.dateFields[0]?.name || "",
      preset: "",
      from: "",
      to: "",
      sort: { field: sortField, dir: sortField === m.nameField || sortField === "Id" ? "ASC" : "DESC" },
    };
  }

  // ───────────────────────────────────────── Filtros
  renderFilters() {
    const m = this.meta;
    const s = this.state;
    const el = this.el;
    const nameLabel = m.searchField ? m.byName[m.searchField].label : null;
    el.search.value = s.q;
    el.search.placeholder = nameLabel
      ? L(`Buscar por ${nameLabel} o pegar un Id…`, `Search by ${nameLabel} or paste an Id…`)
      : L("Pegar un Id de registro…", "Paste a record Id…");

    el.pickWrap.classList.toggle("hidden", !m.picklists.length);
    el.pickValuesHost.classList.toggle("hidden", !m.picklists.length);
    el.pickField.innerHTML =
      `<option value="">${esc(L("Filtrar por picklist…", "Filter by picklist…"))}</option>` +
      m.picklists.map((f) => `<option value="${esc(f.name)}">${esc(f.label)}</option>`).join("");
    el.pickField.value = s.pickField;
    this.syncPickValues();

    el.mineWrap.classList.toggle("hidden", !(m.hasOwner && this.ctx.userId));
    el.mine.checked = s.mine;

    const dateRow = m.dateFields.length > 0;
    el.dateField.parentElement.classList.toggle("hidden", !dateRow);
    el.presets.classList.toggle("hidden", !dateRow);
    el.from.parentElement.classList.toggle("hidden", !dateRow);
    el.to.parentElement.classList.toggle("hidden", !dateRow);
    el.dateField.innerHTML = m.dateFields.map((f) => `<option value="${esc(f.name)}">${esc(f.label)}</option>`).join("");
    el.dateField.value = s.dateField;
    el.from.value = s.from;
    el.to.value = s.to;
    this.syncPresets();
  }

  syncPickValues() {
    const f = this.meta.byName[this.state.pickField];
    this.el.pickValuesHost.classList.toggle("disabled", !f);
    this.pickValues.setOptions(
      f ? f.picklistValues.filter((v) => v.active).map((v) => ({ value: v.value, label: v.label || v.value })) : [],
      this.state.pickValues
    );
  }

  syncPresets() {
    this.el.presets.querySelectorAll("[data-preset]").forEach((b) => b.classList.toggle("on", b.dataset.preset === this.state.preset));
  }

  applyPreset(key) {
    const s = this.state;
    s.preset = key;
    const now = new Date();
    if (!key) {
      s.from = s.to = "";
    } else {
      s.to = ymd(now);
      if (key === "today") s.from = ymd(now);
      else if (key === "month") s.from = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
      else if (key === "year") s.from = ymd(new Date(now.getFullYear(), 0, 1));
      else s.from = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(key) + 1));
    }
    this.el.from.value = s.from;
    this.el.to.value = s.to;
    this.syncPresets();
  }

  isFiltering() {
    const s = this.state;
    return !!(s.q || s.pickValues.length || s.mine || s.from || s.to);
  }

  // ───────────────────────────────────────── Query
  columns() {
    const m = this.meta;
    const s = this.state;
    const f = (name) => m.byName[name];
    const cols = [];
    if (m.nameField) cols.push({ key: m.nameField, label: f(m.nameField).label, kind: "name", sortable: f(m.nameField).sortable });
    else cols.push({ key: "Id", label: "Id", kind: "name", sortable: true });
    if (s.pickField && f(s.pickField)) cols.push({ key: s.pickField, label: f(s.pickField).label, kind: "pill", sortable: f(s.pickField).sortable });
    if (m.hasRecordType) cols.push({ key: "RecordType.Name", label: "Record Type", kind: "text" });
    if (m.hasOwner) cols.push({ key: "Owner.Name", label: L("Propietario", "Owner"), kind: "owner" });
    const dates = [s.dateField, "CreatedDate", "LastModifiedDate"].filter((n, i, a) => n && f(n) && a.indexOf(n) === i);
    dates.forEach((n) => cols.push({ key: n, label: f(n).label, kind: f(n).type === "date" ? "date" : "datetime", sortable: f(n).sortable }));
    cols.push({ key: "_actions", label: "", kind: "actions" });
    return cols;
  }

  dateLiteral(fieldName, value, endOfDay) {
    if (this.meta.byName[fieldName].type === "date") return value;
    return new Date(`${value}T${endOfDay ? "23:59:59" : "00:00:00"}`).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  buildSoql() {
    const m = this.meta;
    const s = this.state;
    const fields = new Set(["Id"]);
    this.cols.forEach((c) => c.kind !== "actions" && fields.add(c.key));
    const where = [];

    if (s.q) {
      if (ID_RE.test(s.q) && (!m.keyPrefix || s.q.startsWith(m.keyPrefix))) where.push(`Id = '${s.q}'`);
      else if (m.searchField) where.push(`${m.searchField} LIKE '%${likeEscape(s.q)}%'`);
    }
    if (s.pickField && s.pickValues.length) {
      where.push(`${s.pickField} IN (${s.pickValues.map((v) => `'${soqlEscape(v)}'`).join(", ")})`);
    }
    if (s.mine && m.hasOwner && this.ctx.userId) where.push(`OwnerId = '${soqlEscape(this.ctx.userId)}'`);
    if (s.dateField && m.byName[s.dateField]) {
      if (s.from) where.push(`${s.dateField} >= ${this.dateLiteral(s.dateField, s.from, false)}`);
      if (s.to) where.push(`${s.dateField} <= ${this.dateLiteral(s.dateField, s.to, true)}`);
    }

    let soql = `SELECT ${[...fields].join(", ")}\nFROM ${m.name}`;
    if (where.length) soql += `\nWHERE ${where.join("\n  AND ")}`;
    if (s.sort.field) soql += `\nORDER BY ${s.sort.field} ${s.sort.dir}${s.sort.dir === "DESC" ? " NULLS LAST" : ""}`;
    return soql;
  }

  async runQuery() {
    if (!this.meta) return;
    const el = this.el;
    this.cols = this.columns();
    const soql = this.buildSoql();
    el.reset.classList.toggle("hidden", !this.isFiltering());

    this.abort?.abort();
    this.abort = new AbortController();
    const token = ++this.queryToken;
    this.next = null;
    this.renderHead();
    el.tbody.innerHTML = skeletonRows(this.cols.length, 8);
    el.empty.innerHTML = "";
    el.foot.innerHTML = `<span class="loading"><span class="spinner"></span> ${esc(L("Consultando registros…", "Querying records…"))}</span>`;
    el.results.classList.add("busy");
    el.tbody.classList.remove("no-anim");

    try {
      const res = await this.ctx.api.query(soql.replace(/\n\s*/g, " "), { batchSize: 200, signal: this.abort.signal });
      if (token !== this.queryToken) return;
      this.records = res.records;
      this.total = res.totalSize;
      this.next = res.done ? null : res.nextRecordsUrl;
      this.syncedAt = Date.now();
      el.tbody.innerHTML = "";
      this.appendRows(this.records, 0);
      animateCount(el.count, this.total);
      this.renderFoot();
      this.renderEmpty();
    } catch (e) {
      if (e.name === "AbortError" || token !== this.queryToken) return;
      el.tbody.innerHTML = "";
      el.foot.innerHTML = "";
      el.count.textContent = "0";
      el.empty.innerHTML = emptyState({ error: true, title: L("La consulta falló", "The query failed"), text: friendlyError(e) });
      if (e.status === 401) this.ctx.sessionExpired();
    } finally {
      if (token === this.queryToken) el.results.classList.remove("busy");
    }
  }

  async loadMore() {
    if (!this.next || this.loadingMore || !this.meta) return;
    this.loadingMore = true;
    const token = this.queryToken;
    this.el.foot.innerHTML = `<span class="loading"><span class="spinner"></span> ${esc(L("Cargando más registros…", "Loading more records…"))}</span>`;
    try {
      const res = await this.ctx.api.more(this.next, { signal: this.abort?.signal });
      if (token !== this.queryToken) return;
      const start = this.records.length;
      this.records.push(...res.records);
      this.next = res.done ? null : res.nextRecordsUrl;
      this.appendRows(res.records, start);
    } catch (e) {
      if (e.name !== "AbortError") toast(friendlyError(e), "error");
    } finally {
      this.loadingMore = false;
      if (token === this.queryToken) this.renderFoot();
    }
  }

  /**
   * Re-ejecuta la consulta actual en segundo plano y muestra lo nuevo sin perder filtros.
   * Si el usuario ya cargó varias páginas, en lugar de reemplazar la tabla se ofrece un botón.
   */
  async sync({ manual = false, minAge = 0 } = {}) {
    if (this.objects && Date.now() - (this.objectsAt || 0) > 60 * 1000) this.refreshObjects();
    if (!this.meta || this.syncing || this.loadingMore || this.el.results.classList.contains("busy")) return;
    if (!manual && Date.now() - (this.syncedAt || 0) < minAge) return;
    this.syncing = true;
    this.el.live.classList.add("syncing");
    const token = this.queryToken;
    try {
      const res = await this.ctx.api.query(this.buildSoql().replace(/\n\s*/g, " "), { batchSize: 200 });
      if (token !== this.queryToken) return;
      this.syncedAt = Date.now();
      const known = new Map(this.records.map((r) => [r.Id, r]));
      const added = res.records.filter((r) => !known.has(r.Id));
      const updated = res.records.filter((r) => known.has(r.Id) && JSON.stringify(known.get(r.Id)) !== JSON.stringify(r));
      const removed = res.totalSize < this.total && !added.length;
      if (!added.length && !updated.length && res.totalSize === this.total) {
        if (manual) toast(L("Sin cambios en los registros", "No changes in the records"), "info", 1800);
        return;
      }
      if (this.records.length > res.records.length) {
        // El usuario cargó más páginas: no le movemos la tabla, le ofrecemos actualizar.
        const n = Math.max(added.length, res.totalSize - this.total);
        this.renderFoot(n > 0 ? n : updated.length || 1);
        return;
      }
      const now = Date.now();
      added.forEach((r) => this.newIds.set(r.Id, now));
      updated.forEach((r) => this.flashIds.add(r.Id));
      const scrollTop = this.el.scroll.scrollTop;
      this.records = res.records;
      this.total = res.totalSize;
      this.next = res.done ? null : res.nextRecordsUrl;
      this.el.tbody.classList.add("no-anim");
      this.el.tbody.innerHTML = "";
      this.appendRows(this.records, 0);
      this.flashIds.clear();
      this.el.scroll.scrollTop = scrollTop;
      animateCount(this.el.count, this.total);
      this.renderFoot();
      this.renderEmpty();
      const parts = [
        added.length && L(`${added.length} ${added.length === 1 ? "nuevo" : "nuevos"}`, `${added.length} new`),
        updated.length && L(`${updated.length} ${updated.length === 1 ? "actualizado" : "actualizados"}`, `${updated.length} updated`),
        removed && L("registros eliminados", "records removed"),
      ].filter(Boolean);
      toast(`${this.meta.label}: ${parts.join(" · ")}`, added.length ? "success" : "info", 3500);
    } catch (e) {
      if (e.status === 401) this.ctx.sessionExpired();
      else if (manual) toast(friendlyError(e), "error");
    } finally {
      this.syncing = false;
      this.el.live.classList.remove("syncing");
      this.el.live.title = L(
        `Se actualiza solo cada minuto y al volver a esta pestaña. Última sincronización: ${new Date().toLocaleTimeString(locale)}`,
        `Updates automatically every minute and when you return to this tab. Last sync: ${new Date().toLocaleTimeString(locale)}`
      );
    }
  }

  renderEmpty() {
    const filtering = this.isFiltering();
    this.el.empty.innerHTML = this.records.length
      ? ""
      : emptyState({
          title: filtering ? L("Ningún registro coincide", "No record matches") : L("No hay registros visibles", "No visible records"),
          text: filtering
            ? L("Ajusta o limpia los filtros para ver más resultados.", "Adjust or clear the filters to see more results.")
            : L("No existen registros o tu usuario no tiene acceso a ellos.", "There are no records or your user can't access them."),
          iconName: filtering ? "search" : "inbox",
        });
  }

  // ───────────────────────────────────────── Render
  renderHead() {
    const { field, dir } = this.state.sort;
    this.el.thead.innerHTML = `<tr>${this.cols
      .map((c) =>
        c.sortable
          ? `<th data-sort="${esc(c.key)}" class="sortable ${field === c.key ? "sorted" : ""} ${field === c.key && dir === "DESC" ? "desc" : ""}">${esc(
              c.label
            )}<span class="sort-ind">${icon("arrow-up")}</span></th>`
          : `<th class="${c.kind === "actions" ? "c-actions" : ""}">${esc(c.label)}</th>`
      )
      .join("")}</tr>`;
  }

  renderFoot(pending = 0) {
    const shown = this.records.length;
    const pill = pending
      ? `<button class="new-pill" data-reload>${icon("arrow-up")}${esc(L("Hay cambios nuevos — actualizar", "There are new changes — refresh"))}</button>`
      : "";
    this.el.foot.innerHTML = shown
      ? `<span>${L("Mostrando", "Showing")} <b>${fmt(shown)}</b> ${L("de", "of")} <b>${fmt(this.total)}</b></span>${pill}${
          this.next
            ? `<span class="hint">${esc(L("Desplázate para cargar más", "Scroll to load more"))}</span>`
            : `<span class="hint">${esc(L("Click en una fila para ver y editar todos sus campos", "Click a row to view and edit all its fields"))}</span>`
        }`
      : pill;
  }

  recordUrl(id) {
    const name = this.meta.name;
    return this.ctx.url(
      name.endsWith("__mdt") ? `/lightning/setup/CustomMetadata/page?address=${encodeURIComponent("/" + id)}` : `/lightning/r/${name}/${id}/view`
    );
  }

  appendRows(records, offset) {
    const q = this.state.q;
    const now = Date.now();
    const isNew = (rec) => this.newIds.has(rec.Id) && now - this.newIds.get(rec.Id) < NEW_HIGHLIGHT_MS;
    const html = records
      .map((rec, i) => {
        const href = this.recordUrl(rec.Id);
        const cells = this.cols.map((c) => {
          const v = getPath(rec, c.key);
          switch (c.kind) {
            case "name":
              return `<td class="c-name"><div class="cell-name">
                <div class="name-line"><a class="name-link" data-sf href="${esc(href)}">${highlight(v ?? rec.Id, q)}</a>${
                  isNew(rec) ? `<span class="chip new">${esc(L("Nuevo", "New"))}</span>` : ""
                }</div>
                <span class="sub mono">${esc(rec.Id)}</span>
              </div></td>`;
            case "pill": {
              if (v == null || v === "") return '<td><span class="dash">—</span></td>';
              const label = this.meta.byName[c.key].picklistValues.find((p) => p.value === v)?.label || v;
              return `<td><span class="pill" style="--k:${toneFor(v)}">${esc(label)}</span></td>`;
            }
            case "owner":
              return `<td>${
                v
                  ? `<span class="owner"><span class="mini-av" style="--k:${colorFor(v)}">${esc(initials(v))}</span>${esc(v)}</span>`
                  : '<span class="dash">—</span>'
              }</td>`;
            case "date":
              return `<td>${whenCell(v, true)}</td>`;
            case "datetime":
              return `<td>${whenCell(v)}</td>`;
            case "actions":
              return `<td class="c-actions">
                <button class="row-btn view" data-view-record="${esc(rec.Id)}" title="${esc(L("Ver todos los campos / editar", "View all fields / edit"))}">${icon("eye")}</button>
                <button class="row-btn" data-copy="${esc(rec.Id)}" title="${esc(L("Copiar Id", "Copy Id"))}">${icon("copy")}</button>
                <a class="row-btn" data-sf href="${esc(href)}" title="${esc(L("Abrir en Salesforce", "Open in Salesforce"))}">${icon("external")}</a>
              </td>`;
            default:
              return `<td>${v == null || v === "" ? '<span class="dash">—</span>' : esc(v)}</td>`;
          }
        });
        const cls = [isNew(rec) && "is-new", this.flashIds.has(rec.Id) && "is-updated"].filter(Boolean).join(" ");
        return `<tr style="--i:${i}" data-row="${offset + i}" data-id="${esc(rec.Id)}" class="${cls} clickable">${cells.join("")}</tr>`;
      })
      .join("");
    this.el.tbody.insertAdjacentHTML("beforeend", html);
  }
}
