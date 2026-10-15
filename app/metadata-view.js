// Vista "Metadata": elegir tipo → lista filtrable → click lleva a Salesforce.
// La lista abierta se re-sincroniza sola: lo que se crea, edita o borra en la org aparece aquí.
import { TYPES, TYPE_GROUPS, getType, groupLabel, loadMetadata } from "../lib/metadata-types.js";
import { analyzeMetadata } from "../lib/conflicts.js";
import { L, locale } from "../lib/i18n.js";
import { Combobox, MultiSelect } from "./combobox.js";
import { ConflictDrawer } from "./conflict-drawer.js";
import { canEditCode } from "./code-ide.js";
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
  toast,
} from "./ui.js";

const PAGE = 150;
const NEW_HIGHLIGHT_MS = 10 * 60 * 1000; // los elementos nuevos quedan resaltados 10 min
const CROSS_MAX_AGE = 2 * 60 * 1000; // antigüedad máxima de otros tipos usados en el análisis
const fmt = (n) => n.toLocaleString(locale);
const NO_NAMESPACE = "__none"; // opción «sin paquete» del filtro de managed packages
// Búsqueda global: todos los tipos salvo los registros de CMDT (una consulta por cada tipo de CMDT).
const SEARCH_TYPES = TYPES.map((t) => t.key).filter((k) => k !== "CustomMetadataRecord");
const SEARCH_PER_TYPE = 6;
const SEARCH_MAX = 60;
const SEARCH_MAX_AGE = 5 * 60 * 1000;

export class MetadataView {
  constructor(ctx) {
    this.ctx = ctx;
    this.cache = new Map();
    this.pendingLoads = new Map();
    this.drawer = new ConflictDrawer(ctx);
    this.def = null;
    this.rows = [];
    this.filtered = [];
    this.rendered = 0;
    this.token = 0;
    this.state = this.freshState();
    this.recentKey = `recentTypes:${ctx.session.orgId}`;

    this.el = {
      home: $("#md-home"),
      grid: $("#md-type-grid"),
      recentWrap: $("#md-recent-wrap"),
      recent: $("#md-recent"),
      results: $("#md-results"),
      headIco: $("#md-head-ico"),
      title: $("#md-title"),
      subtitle: $("#md-subtitle"),
      count: $("#md-count"),
      back: $("#md-back"),
      refresh: $("#md-refresh"),
      live: $("#md-live"),
      search: $("#md-search"),
      objWrap: $("#md-object-wrap"),
      catWrap: $("#md-category-wrap"),
      category: $("#md-category"),
      statusWrap: $("#md-status-wrap"),
      status: $("#md-status"),
      modified: $("#md-modified"),
      health: $("#md-health"),
      healthSummary: $("#md-health-summary"),
      reset: $("#md-reset"),
      scroll: $("#md-scroll"),
      thead: $("#md-thead"),
      tbody: $("#md-tbody"),
      empty: $("#md-empty"),
      foot: $("#md-foot"),
      sentinel: $("#md-sentinel"),
    };

    this.picker = new Combobox($("#md-picker"), {
      size: "lg",
      placeholder: L(
        "Elige un tipo o busca cualquier elemento por nombre o API name: Flows, AccountService, Rating__c…",
        "Pick a type or search any item by name or API name: Flows, AccountService, Rating__c…"
      ),
      items: TYPES.map((t) => ({
        value: t.key,
        label: t.label,
        sublabel: t.description,
        icon: t.icon,
        color: t.color,
        group: groupLabel(t.group),
        keywords: t.keywords,
      })),
      onSelect: (it) => (it?.extra ? this.find(it.typeKey, it.findName) : it ? this.open(it.value) : this.showHome()),
      search: (q, update) => this.searchAll(q, update),
    });

    this.objectFilter = new Combobox($("#md-object"), {
      size: "sm",
      leadingIcon: "box",
      placeholder: L("Todos los objetos", "All objects"),
      emptyText: L("Ningún objeto coincide", "No object matches"),
      onSelect: (it) => {
        this.state.object = it ? it.value : null;
        this.apply();
      },
    });

    this.nsFilter = new MultiSelect($("#md-ns"), {
      placeholder: "Managed packages",
      searchPlaceholder: L("Filtrar paquetes…", "Filter packages…"),
      leadingIcon: "package",
      onChange: (values) => {
        this.state.ns = values;
        this.apply();
      },
    });

    this.renderHome();
    this.bind();
  }

  freshState() {
    return { q: "", ns: [], object: null, category: "", status: "", modified: "", health: "", sort: { key: "name", dir: 1 } };
  }

  bind() {
    const el = this.el;
    el.back.addEventListener("click", () => this.showHome());
    el.refresh.addEventListener("click", () => this.def && this.sync({ manual: true }));
    $("#md-soql").addEventListener("click", () => this.openConsole());
    el.search.addEventListener(
      "input",
      debounce(() => {
        this.state.q = el.search.value.trim();
        this.apply();
      }, 120)
    );
    el.category.addEventListener("change", () => {
      this.state.category = el.category.value;
      this.apply();
    });
    el.status.addEventListener("change", () => {
      this.state.status = el.status.value;
      this.apply();
    });
    el.modified.addEventListener("change", () => {
      this.state.modified = el.modified.value;
      this.apply();
    });
    el.health.addEventListener("change", () => {
      this.state.health = el.health.value;
      this.apply();
    });
    el.healthSummary.addEventListener("click", (e) => {
      const b = e.target.closest("[data-health-filter]");
      if (!b) return;
      const v = this.state.health === b.dataset.healthFilter ? "" : b.dataset.healthFilter;
      this.state.health = el.health.value = v;
      this.apply();
    });
    el.reset.addEventListener("click", () => {
      this.resetFilters();
      this.apply();
    });

    el.thead.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (!th) return;
      const key = th.dataset.sort;
      const s = this.state.sort;
      this.state.sort = { key, dir: s.key === key ? -s.dir : key === "lastModified" ? -1 : 1 };
      this.apply();
    });

    el.tbody.addEventListener("click", (e) => {
      const healthBtn = e.target.closest("[data-health]");
      if (healthBtn) {
        this.drawer.open(this.rows[Number(healthBtn.dataset.health)], this.def, this.rows.analysis);
        return;
      }
      const objBtn = e.target.closest("[data-filter-object]");
      if (objBtn) {
        this.objectFilter.setValue(objBtn.dataset.filterObject);
        this.state.object = objBtn.dataset.filterObject;
        this.apply();
        return;
      }
      const rep = e.target.closest("[data-open-report]");
      if (rep) return this.ctx.analytics.openReport(rep.dataset.openReport);
      const dash = e.target.closest("[data-open-dash]");
      if (dash) return this.ctx.analytics.openDashboard(dash.dataset.openDash);
      const schema = e.target.closest("[data-schema]");
      if (schema) return this.ctx.schema.openRelations(schema.dataset.schema);
      const code = e.target.closest("[data-edit-code]");
      if (code) return this.ctx.ide.open(this.def.key, this.rows[Number(code.dataset.editCode)]);
      const copy = e.target.closest("[data-copy]");
      if (copy) return copyText(copy.dataset.copy);
      const data = e.target.closest("[data-goto-data]");
      if (data) this.ctx.goToData(data.dataset.gotoData);
    });

    const onCard = (e) => {
      const card = e.target.closest("[data-type]");
      if (card) this.open(card.dataset.type);
    };
    el.grid.addEventListener("click", onCard);
    el.recent.addEventListener("click", onCard);

    // Efecto "spotlight" que sigue al mouse sobre las tarjetas.
    el.grid.addEventListener("mousemove", (e) => {
      const card = e.target.closest(".type-card");
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    });

    new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting) && this.rendered < this.filtered.length) this.renderMore();
      },
      { rootMargin: "300px" }
    ).observe(el.sentinel);
  }

  // ───────────────────────────────────────── Home
  renderHome() {
    let i = 0;
    this.el.grid.innerHTML = TYPE_GROUPS.map((group) => {
      const types = TYPES.filter((t) => t.group === group.id);
      return `<div class="group-block">
        <div class="section-title ${group.id === "agentforce" ? "af" : ""}">${group.id === "agentforce" ? icon("bot") : ""}${esc(group.label)}</div>
        <div class="type-grid">${types
          .map(
            (t) => `<button class="type-card" data-type="${t.key}" style="--c:${t.color};--i:${i++}">
              <span class="tc-ico">${icon(t.icon)}</span>
              <span class="tc-text"><strong>${esc(t.label)}</strong><span>${esc(t.description)}</span></span>
              <span class="tc-arrow">${icon("chevron-right")}</span>
            </button>`
          )
          .join("")}</div>
      </div>`;
    }).join("");
    this.renderRecent();
  }

  async renderRecent() {
    const keys = (await storage.get(this.recentKey, [])).filter(getType);
    this.el.recentWrap.classList.toggle("hidden", !keys.length);
    this.el.recent.innerHTML = keys
      .map((k) => {
        const t = getType(k);
        return `<button class="recent-chip" data-type="${t.key}" style="--c:${t.color}">${icon(t.icon)}${esc(t.label)}</button>`;
      })
      .join("");
  }

  async pushRecent(key) {
    const list = (await storage.get(this.recentKey, [])).filter((k) => k !== key);
    list.unshift(key);
    await storage.set(this.recentKey, list.slice(0, 6));
  }

  showHome() {
    this.def = null;
    this.token++;
    this.picker.clear();
    this.el.results.classList.add("hidden");
    this.el.home.classList.remove("hidden");
    replayAnimation(this.el.home);
    this.renderRecent();
    this.ctx.setHash("");
    this.ctx.setCompact(false);
  }

  /** Llamado cuando el usuario vuelve a la pestaña Metadata. */
  activate() {
    if (this.def) {
      this.ctx.setHash(`m=${this.def.key}`);
      this.ctx.setCompact(true);
    } else {
      this.ctx.setHash("");
      this.ctx.setCompact(false);
    }
  }

  // ───────────────────────────────────────── Resultados
  async open(key) {
    const def = getType(key);
    if (!def) return this.showHome();
    this.def = def;
    this.picker.setValue(key);
    this.ctx.setHash(`m=${key}`);
    this.ctx.setCompact(true);
    this.pushRecent(key);

    const el = this.el;
    el.home.classList.add("hidden");
    el.results.classList.remove("hidden");
    replayAnimation(el.results);
    el.headIco.style.setProperty("--c", def.color);
    el.headIco.innerHTML = icon(def.icon);
    el.title.textContent = def.label;
    el.subtitle.textContent = def.description;
    el.count.textContent = "…";
    el.count.dataset.v = 0;
    el.healthSummary.innerHTML = "";
    el.health.disabled = true;

    this.resetFilters();
    [el.objWrap, el.catWrap, el.statusWrap].forEach((w) => w.classList.add("hidden"));
    el.thead.innerHTML = "";
    el.tbody.classList.remove("no-anim");
    el.tbody.innerHTML = skeletonRows(5, 9);
    el.empty.innerHTML = "";
    el.foot.innerHTML = `<span class="loading"><span class="spinner"></span> ${esc(L(`Consultando ${def.label}…`, `Loading ${def.label}…`))}</span>`;

    const token = ++this.token;
    try {
      const rows = await this.getRows(key);
      if (token !== this.token) return;
      this.rows = rows;
      this.setupFilters();
      this.apply();
      this.runAnalysis(def, rows, token);
      // Si la lista venía de caché y es vieja, la revalidamos en segundo plano.
      if (Date.now() - rows.loadedAt > 30 * 1000) this.sync();
    } catch (e) {
      if (token !== this.token) return;
      this.rows = [];
      this.filtered = [];
      el.thead.innerHTML = "";
      el.tbody.innerHTML = "";
      el.foot.innerHTML = "";
      el.count.textContent = "0";
      el.empty.innerHTML = emptyState({
        error: true,
        title: L(`No se pudo cargar ${def.label}`, `Could not load ${def.label}`),
        text: friendlyError(e),
      });
      if (e.status === 401) this.ctx.sessionExpired();
    }
  }

  /** Filas de cualquier tipo, con caché (las reglas de conflictos cruzan tipos). */
  async getRows(key, { maxAge = Infinity } = {}) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.loadedAt < maxAge) return cached;
    if (!this.pendingLoads.has(key)) {
      const p = loadMetadata(this.ctx.api, getType(key)).then(
        (rows) => {
          this.cache.set(key, rows);
          this.pendingLoads.delete(key);
          return rows;
        },
        (e) => {
          this.pendingLoads.delete(key);
          throw e;
        }
      );
      this.pendingLoads.set(key, p);
    }
    try {
      return await this.pendingLoads.get(key);
    } catch (e) {
      if (cached) return cached; // mejor datos algo viejos que nada
      throw e;
    }
  }

  /**
   * Vuelve a consultar el tipo abierto y aplica los cambios sin perder filtros ni scroll:
   * los elementos nuevos se resaltan, los editados se actualizan y los borrados desaparecen.
   */
  async sync({ manual = false, minAge = 0 } = {}) {
    const def = this.def;
    const old = this.rows;
    if (!def || this.syncing || !old.loadedAt) return;
    if (!manual && Date.now() - old.loadedAt < minAge) return;
    this.syncing = true;
    this.el.live.classList.add("syncing");
    const token = this.token;
    try {
      if (def.load) this.ctx.api.invalidateGlobal();
      const fresh = await loadMetadata(this.ctx.api, def);
      if (token !== this.token || this.rows !== old) return;

      const oldById = new Map(old.map((r) => [r.id, r]));
      const freshIds = new Set(fresh.map((r) => r.id));
      const added = fresh.filter((r) => !oldById.has(r.id));
      const removed = old.filter((r) => !freshIds.has(r.id));
      const updated = fresh.filter((r) => {
        const o = oldById.get(r.id);
        return o && (o.lastModified !== r.lastModified || o.name !== r.name || o.label !== r.label || o.active !== r.active);
      });
      this.cache.set(def.key, fresh);

      if (!added.length && !removed.length && !updated.length) {
        old.loadedAt = fresh.loadedAt;
        if (manual) toast(L(`${def.label}: sin cambios`, `${def.label}: no changes`), "info", 1800);
        return;
      }

      for (const r of fresh) {
        const o = oldById.get(r.id);
        if (o?._new) r._new = o._new;
      }
      const now = Date.now();
      added.forEach((r) => (r._new = now));
      updated.forEach((r) => (r._flash = true));

      this.rows = fresh;
      this.setupFilters();
      this.el.category.value = this.state.category;
      this.apply({ keep: true });
      updated.forEach((r) => (r._flash = false));
      this.runAnalysis(def, fresh, token);

      const parts = [
        added.length && L(`${added.length} ${added.length === 1 ? "nuevo" : "nuevos"}`, `${added.length} new`),
        updated.length && L(`${updated.length} ${updated.length === 1 ? "actualizado" : "actualizados"}`, `${updated.length} updated`),
        removed.length && L(`${removed.length} ${removed.length === 1 ? "eliminado" : "eliminados"}`, `${removed.length} removed`),
      ].filter(Boolean);
      toast(`${def.label}: ${parts.join(" · ")}`, added.length ? "success" : "info", 3500);
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

  /** Consola SOQL con la query del tipo abierto (FROM pre-cargado). */
  async openConsole() {
    const def = this.def;
    let soql = "";
    let tooling = true;
    if (def?.queries?.length) {
      soql = def.queries[0].soql;
      tooling = def.queries[0].tooling;
    } else if (def?.key === "CustomMetadataType" || def?.key === "CustomMetadataRecord") {
      const mdt = (await this.ctx.api.describeGlobal().catch(() => [])).find((s) => s.name.endsWith("__mdt"));
      soql = mdt ? `SELECT Id, DeveloperName, MasterLabel, NamespacePrefix FROM ${mdt.name}` : "";
      tooling = false;
    } else if (def) {
      soql = "SELECT QualifiedApiName, Label, KeyPrefix, IsCustomizable FROM EntityDefinition";
      tooling = false;
    }
    this.ctx.console.open({ soql, mode: "metadata", tooling });
  }

  /**
   * Búsqueda global desde el buscador principal: encuentra elementos de cualquier tipo por nombre,
   * API name, label, objeto o paquete. Lee todos los tipos una vez (4 a la vez, con caché) y va
   * mostrando resultados a medida que llegan.
   */
  async searchAll(q, update) {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const ql = q.toLowerCase();
    const types = SEARCH_TYPES.map(getType).filter(Boolean);
    let done = 0;
    let failed = 0;
    const emit = () => {
      const hits = [];
      for (const def of types) {
        const rows = this.cache.get(def.key);
        if (!rows) continue;
        const found = [];
        for (const r of rows) {
          if (!tokens.every((t) => r._search.includes(t))) continue;
          const name = String(r.name || "").toLowerCase();
          const label = String(r.label || "").toLowerCase();
          const score = name === ql || label === ql ? 100 : name.startsWith(ql) || label.startsWith(ql) ? 60 : 30;
          found.push({ r, score });
        }
        found.sort((a, b) => b.score - a.score || String(a.r.name).localeCompare(String(b.r.name)));
        for (const { r, score } of found.slice(0, SEARCH_PER_TYPE)) {
          hits.push({
            value: `m:${def.key}:${r.id}`,
            label: r.object ? `${r.object}.${r.name}` : r.name,
            sublabel: [r.label, r.namespace && `${L("paquete", "package")} ${r.namespace}`].filter(Boolean).join(" · ") || def.label,
            icon: def.icon,
            color: def.color,
            group: def.label,
            meta: found.length > SEARCH_PER_TYPE ? `${found.length}` : "",
            typeKey: def.key,
            findName: r.object ? `${r.object} ${r.name}` : r.name,
            score,
          });
        }
      }
      // Los tipos con coincidencias exactas primero; dentro de cada tipo, el orden ya calculado.
      const best = new Map();
      hits.forEach((h) => best.set(h.typeKey, Math.max(best.get(h.typeKey) || 0, h.score)));
      hits.sort((a, b) => best.get(b.typeKey) - best.get(a.typeKey) || types.findIndex((t) => t.key === a.typeKey) - types.findIndex((t) => t.key === b.typeKey));
      const loading = done < types.length;
      update(hits.slice(0, SEARCH_MAX), {
        loading,
        text: loading
          ? L(`Buscando en la metadata… ${done}/${types.length} tipos`, `Searching metadata… ${done}/${types.length} types`)
          : hits.length
            ? L(`${hits.length} coincidencias en ${best.size} tipos${failed ? ` · ${failed} tipos sin acceso` : ""}`, `${hits.length} matches in ${best.size} types${failed ? ` · ${failed} types without access` : ""}`)
            : L("Ningún elemento de metadata coincide", "No metadata item matches"),
      });
    };
    emit();
    const queue = [...types];
    const work = async () => {
      while (queue.length) {
        const def = queue.shift();
        try {
          await this.getRows(def.key, { maxAge: SEARCH_MAX_AGE });
        } catch (e) {
          if (e.status === 401) return this.ctx.sessionExpired();
          failed++;
        }
        done++;
        emit();
      }
    };
    await Promise.all(Array.from({ length: 4 }, work));
  }

  /** Abre un tipo y filtra la lista por un nombre (desde el panel de conflictos). */
  async find(key, name) {
    await this.open(key);
    if (this.def?.key !== key) return;
    this.el.search.value = name;
    this.state.q = name;
    this.apply();
  }

  async runAnalysis(def, rows, token) {
    this.renderHealthSummary();
    if (!rows.analysis) {
      try {
        rows.analyzing ||= analyzeMetadata(def, rows, {
          getRows: (k) => this.getRows(k, { maxAge: CROSS_MAX_AGE }),
          api: this.ctx.api,
        }).finally(() => {
          rows.analyzing = null;
        });
        rows.analysis = await rows.analyzing;
      } catch (e) {
        if (token === this.token) toast(L(`No se pudo completar el análisis de conflictos: ${friendlyError(e)}`, `Conflict analysis could not finish: ${friendlyError(e)}`), "error");
        return;
      }
    }
    if (token !== this.token || this.rows !== rows) return;
    this.el.tbody.querySelectorAll("[data-health]").forEach((b) => {
      b.outerHTML = this.healthBtn(rows[Number(b.dataset.health)]);
    });
    this.renderHealthSummary();
    if (this.state.health) this.apply({ keep: true });
    if (this.drawer.row && rows.includes(this.drawer.row)) this.drawer.refresh(this.drawer.row, rows.analysis);
  }

  renderHealthSummary() {
    const rows = this.rows;
    const ready = !!rows.analysis;
    this.el.health.disabled = !ready;
    if (!ready) {
      this.el.healthSummary.innerHTML = `<span class="hs-pending"><span class="spinner"></span>${esc(L("Analizando conflictos…", "Analyzing conflicts…"))}</span>`;
      return;
    }
    const n = { error: 0, warning: 0, ok: 0 };
    rows.forEach((r) => n[r.health]++);
    const chip = (key, label, ic) =>
      `<button class="hs-chip hs-${key} ${this.state.health === key ? "on" : ""}" data-health-filter="${key}" title="${esc(
        L("Filtrar", "Filter")
      )}: ${esc(label)}">${icon(ic)}<b>${fmt(n[key])}</b><span>${esc(label)}</span></button>`;
    this.el.healthSummary.innerHTML =
      chip("error", n.error === 1 ? L("conflicto", "conflict") : L("conflictos", "conflicts"), "alert-triangle") +
      chip("warning", n.warning === 1 ? L("advertencia", "warning") : L("advertencias", "warnings"), "alert-triangle") +
      chip("ok", L("sin conflictos", "no conflicts"), "check-circle");
  }

  healthBtn(r) {
    const h = r.health || "pending";
    const n = r.issues?.length || 0;
    const title =
      h === "pending"
        ? L("Analizando conflictos…", "Analyzing conflicts…")
        : h === "ok"
          ? L("Sin conflictos detectados — click para ver las verificaciones", "No conflicts found — click to see the checks")
          : L(
              `${n} ${n === 1 ? "problema detectado" : "problemas detectados"} — click para ver el detalle`,
              `${n} ${n === 1 ? "issue found" : "issues found"} — click for details`
            );
    const body = h === "pending" ? '<span class="h-dot"></span>' : icon(h === "ok" ? "check-circle" : "alert-triangle");
    return `<button type="button" class="health h-${h}" data-health="${r._i}" title="${esc(title)}">${body}${
      n > 1 ? `<span class="hn">${n}</span>` : ""
    }</button>`;
  }

  resetFilters() {
    this.state = this.freshState();
    this.el.health.value = "";
    this.el.search.value = "";
    this.el.category.value = "";
    this.el.status.value = "";
    this.el.modified.value = "";
    this.objectFilter.clear();
    this.nsFilter.setOptions(this.nsFilter.options, []);
  }

  setupFilters() {
    const objects = new Map();
    const categories = new Map();
    const namespaces = new Map();
    let local = 0;
    let hasStatus = false;
    for (const r of this.rows) {
      if (r.namespace) namespaces.set(r.namespace, (namespaces.get(r.namespace) || 0) + 1);
      else local++;
      if (r.object) objects.set(r.object, (objects.get(r.object) || 0) + 1);
      if (r.category) categories.set(r.category, (categories.get(r.category) || 0) + 1);
      if (r.active !== null) hasStatus = true;
    }
    this.hasObject = objects.size > 0;
    this.hasCategory = categories.size > 1;
    this.hasStatus = hasStatus;

    const objectWord = this.def.objectLabel || L("Objeto", "Object");
    this.el.objWrap.classList.toggle("hidden", !this.hasObject);
    this.objectFilter.setItems(
      [...objects.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([o, n]) => ({ value: o, label: o, meta: n }))
    );
    this.objectFilter.input.placeholder = `${L("Todos", "All")}: ${objectWord.toLowerCase()} (${objects.size})`;

    this.el.catWrap.classList.toggle("hidden", !this.hasCategory);
    this.el.category.innerHTML =
      `<option value="">${esc(L("Todos los tipos", "All types"))}</option>` +
      [...categories.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([c, n]) => `<option value="${esc(c)}">${esc(c)} (${n})</option>`)
        .join("");

    this.el.statusWrap.classList.toggle("hidden", !this.hasStatus);

    // Paquetes administrados: solo se puede usar si este tipo tiene elementos con namespace.
    const own = this.ctx.orgNamespace;
    const nsOptions = [...namespaces.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ns, n]) => ({ value: ns, label: `${ns}${ns === own ? L(" (esta org)", " (this org)") : ""} · ${fmt(n)}` }));
    if (nsOptions.length && local) nsOptions.unshift({ value: NO_NAMESPACE, label: `${L("Sin paquete (de la org)", "No package (org's own)")} · ${fmt(local)}` });
    this.nsFilter.setOptions(nsOptions, this.state.ns.filter((v) => nsOptions.some((o) => o.value === v)));
    this.state.ns = [...this.nsFilter.values];
    const nsHost = this.nsFilter.host;
    nsHost.classList.toggle("disabled", !namespaces.size);
    nsHost.title = namespaces.size
      ? L(`${namespaces.size} ${namespaces.size === 1 ? "paquete" : "paquetes"} con elementos de este tipo`, `${namespaces.size} ${namespaces.size === 1 ? "package" : "packages"} with items of this type`)
      : L("Ningún paquete administrado tiene elementos de este tipo", "No managed package has items of this type");
  }

  columns() {
    return [
      { key: "name", label: L("Nombre", "Name"), sort: true },
      this.hasObject && { key: "object", label: this.def.objectLabel || L("Objeto", "Object"), sort: true },
      this.hasCategory && { key: "category", label: L("Tipo", "Type"), sort: true },
      this.hasStatus && { key: "active", label: L("Estado", "Status"), sort: true },
      { key: "lastModified", label: L("Última modificación", "Last modified"), sort: true },
      { key: "_actions", label: "" },
    ].filter(Boolean);
  }

  /** keep = re-render tras una sincronización: conserva scroll y filas visibles, sin animar todo. */
  apply({ keep = false } = {}) {
    const { q, ns, object, category, status, modified, health, sort } = this.state;
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    let since = null;
    if (modified === "today") {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      since = d.getTime();
    } else if (modified) {
      since = Date.now() - Number(modified) * 86400000;
    }

    const out = this.rows.filter(
      (r) =>
        (!ns.length || ns.includes(r.namespace || NO_NAMESPACE)) &&
        (!object || r.object === object) &&
        (!category || r.category === category) &&
        (!status || (status === "active" ? r.active === true : r.active === false)) &&
        (!since || (r.lastModified && Date.parse(r.lastModified) >= since)) &&
        (!health || (health === "issues" ? r.health === "error" || r.health === "warning" : r.health === health)) &&
        (!tokens.length || tokens.every((t) => r._search.includes(t)))
    );

    const { key, dir } = sort;
    const now = Date.now();
    const isNew = (r) => !!r._new && now - r._new < NEW_HIGHLIGHT_MS;
    out.sort((a, b) => {
      if (isNew(a) !== isNew(b)) return isNew(a) ? -1 : 1; // lo recién creado, arriba
      let va = a[key];
      let vb = b[key];
      if (key === "lastModified") {
        va = va ? Date.parse(va) : 0;
        vb = vb ? Date.parse(vb) : 0;
        return (va - vb) * dir;
      }
      if (key === "active") return ((va === true) - (vb === true)) * dir;
      return String(va ?? "").localeCompare(String(vb ?? ""), undefined, { sensitivity: "base", numeric: true }) * dir;
    });

    const scrollTop = this.el.scroll.scrollTop;
    const wanted = keep ? Math.max(PAGE, this.rendered) : PAGE;
    this.filtered = out;
    this.cols = this.columns();
    this.renderHead();
    this.el.tbody.classList.toggle("no-anim", keep);
    this.el.tbody.innerHTML = "";
    this.rendered = 0;
    this.renderMore(wanted);
    if (keep) this.el.scroll.scrollTop = scrollTop;
    animateCount(this.el.count, out.length);

    const filtering = tokens.length || ns.length || object || category || status || modified || health;
    if (this.rows.analysis) this.renderHealthSummary();
    this.el.reset.classList.toggle("hidden", !filtering);
    this.el.empty.innerHTML = out.length
      ? ""
      : emptyState({
          title: this.rows.length
            ? L("Nada coincide con los filtros", "Nothing matches the filters")
            : L("No hay elementos de este tipo", "There are no items of this type"),
          text: this.rows.length
            ? L("Prueba con otra búsqueda o limpia los filtros.", "Try another search or clear the filters.")
            : L("La org no tiene elementos de este tipo visibles para tu usuario.", "The org has no items of this type visible to your user."),
          iconName: this.rows.length ? "search" : "inbox",
        });
  }

  renderHead() {
    const { key, dir } = this.state.sort;
    this.el.thead.innerHTML = `<tr>${this.cols
      .map((c) =>
        c.sort
          ? `<th data-sort="${c.key}" class="sortable ${key === c.key ? "sorted" : ""} ${key === c.key && dir < 0 ? "desc" : ""}">${esc(
              c.label
            )}<span class="sort-ind">${icon("arrow-up")}</span></th>`
          : `<th class="${c.key === "_actions" ? "c-actions" : ""}">${esc(c.label)}</th>`
      )
      .join("")}</tr>`;
  }

  renderMore(count = PAGE) {
    const start = this.rendered;
    const slice = this.filtered.slice(start, start + count);
    this.el.tbody.insertAdjacentHTML("beforeend", slice.map((r, i) => this.rowHtml(r, i)).join(""));
    this.rendered += slice.length;
    const total = this.filtered.length;
    this.el.foot.innerHTML = total
      ? `<span>${L("Mostrando", "Showing")} <b>${fmt(this.rendered)}</b> ${L("de", "of")} <b>${fmt(total)}</b>${
          total !== this.rows.length ? ` · ${fmt(this.rows.length)} ${L("en total", "in total")}` : ""
        }</span><span class="hint">${esc(L("Click en un nombre para abrirlo en Salesforce", "Click a name to open it in Salesforce"))}</span>`
      : "";
  }

  rowHtml(r, i) {
    const q = this.state.q;
    const href = r.url ? this.ctx.url(r.url) : null;
    const isNew = r._new && Date.now() - r._new < NEW_HIGHLIGHT_MS;
    const cells = this.cols.map((c) => {
      switch (c.key) {
        case "name":
          return `<td class="c-name"><div class="cell-name">
            <div class="name-line">${
              href
                ? `<a class="name-link" data-sf href="${esc(href)}">${highlight(r.name, q)}</a>`
                : `<span class="name-link">${highlight(r.name, q)}</span>`
            }${this.healthBtn(r)}${isNew ? `<span class="chip new">${esc(L("Nuevo", "New"))}</span>` : ""}</div>
            ${r.label ? `<span class="sub" title="${esc(r.label)}">${highlight(r.label, q)}</span>` : ""}
            ${
              r.namespace || r.badges.length
                ? `<div class="chips">${r.namespace ? `<span class="chip ns">${esc(r.namespace)}</span>` : ""}${r.badges
                    .map((b) => `<span class="chip">${highlight(b, q)}</span>`)
                    .join("")}</div>`
                : ""
            }
          </div></td>`;
        case "object":
          return `<td>${
            r.object
              ? `<button class="obj-pill" data-filter-object="${esc(r.object)}" title="${esc(L("Filtrar por", "Filter by"))} ${esc(
                  r.object
                )}">${icon("box")}${highlight(r.object, q)}</button>`
              : '<span class="dash">—</span>'
          }</td>`;
        case "category":
          return `<td>${r.category ? `<span class="chip cat">${highlight(r.category, q)}</span>` : '<span class="dash">—</span>'}</td>`;
        case "active":
          return `<td>${
            r.active === null
              ? '<span class="dash">—</span>'
              : `<span class="pill" style="--k:${r.active ? "#10b981" : "#94a3b8"}">${
                  r.active ? L("Activo", "Active") : L("Inactivo", "Inactive")
                }</span>`
          }</td>`;
        case "lastModified":
          return `<td>${whenCell(r.lastModified)}${
            r.lastModifiedBy ? `<span class="by">${L("por", "by")} ${esc(r.lastModifiedBy)}</span>` : ""
          }</td>`;
        default:
          return `<td class="c-actions">
            ${
              canEditCode(this.def.key)
                ? `<button class="row-btn code" data-edit-code="${r._i}" title="${esc(L("Abrir en el IDE (ver y editar código)", "Open in the IDE (view and edit code)"))}">${icon("code")}</button>`
                : ""
            }
            ${
              this.def.key === "Report"
                ? `<button class="row-btn analytics" data-open-report="${esc(r.id)}" title="${esc(L("Ver y editar en Org Lens", "View and edit in Org Lens"))}">${icon("bar-chart")}</button>`
                : this.def.key === "Dashboard"
                  ? `<button class="row-btn analytics" data-open-dash="${esc(r.id)}" title="${esc(L("Ver y editar en Org Lens", "View and edit in Org Lens"))}">${icon("gauge")}</button>`
                  : ""
            }
            ${
              this.def.key === "CustomObject"
                ? `<button class="row-btn schema" data-schema="${esc(r.name)}" title="${esc(L("Ver relaciones (schema)", "View relationships (schema)"))}">${icon("share")}</button>`
                : ""
            }
            ${
              r.dataObject
                ? `<button class="row-btn" data-goto-data="${esc(r.dataObject)}" title="${esc(
                    L(`Ver registros de ${r.name}`, `View ${r.name} records`)
                  )}">${icon("database")}</button>`
                : ""
            }
            <button class="row-btn" data-copy="${esc(r.name)}" title="${esc(L("Copiar nombre", "Copy name"))}">${icon("copy")}</button>
            ${href ? `<a class="row-btn" data-sf href="${esc(href)}" title="${esc(L("Abrir en Salesforce", "Open in Salesforce"))}">${icon("external")}</a>` : ""}
          </td>`;
      }
    });
    return `<tr style="--i:${i}" class="${isNew ? "is-new" : ""} ${r._flash ? "is-updated" : ""}">${cells.join("")}</tr>`;
  }
}
