// Schema Builder: lienzo interactivo con los objetos de la org y sus relaciones (lookup / master-detail).
// - Los objetos se arrastran, el lienzo se mueve y hace zoom; la distribución se guarda por org y escena.
// - Escena «main» (botón de la barra superior) o «rel:Objeto» (relaciones de un objeto concreto).
// - Al seleccionar un objeto se abre un panel con sus campos y sus relaciones, y permite crear campos.
import { getType } from "../lib/metadata-types.js";
import { L, locale } from "../lib/i18n.js";
import { FIELD_TYPES, CAN_REQUIRE, apiNameFrom, validateApiName, createField, grantFieldAccess } from "../lib/schema-fields.js";
import { $, icon, esc, toast, friendlyError, highlight, storage, debounce, copyText } from "./ui.js";

const NODE_W = 240;
const NODE_FIELDS = 8; // campos de relación visibles en cada tarjeta
const MAX_CHILDREN = 24; // hijos que se agregan al abrir las relaciones de un objeto
const MAX_POLY = 5; // lookups polimórficos con más destinos que esto no se expanden solos
const AUDIT_FIELDS = new Set(["CreatedById", "LastModifiedById"]);
const SKIP_CHILD = /(Share|History|Feed|ChangeEvent|Tag|__hd|__b)$/;

const PRESETS = {
  sales: { label: L("Ventas", "Sales"), objects: ["Account", "Contact", "Opportunity", "OpportunityLineItem", "Product2", "Lead", "Campaign"] },
  service: { label: L("Servicio", "Service"), objects: ["Account", "Contact", "Case", "Asset", "Entitlement", "WorkOrder"] },
};

const TYPE_LABEL = {
  Text: L("Texto", "Text"),
  LongTextArea: L("Área de texto largo", "Long text area"),
  Number: L("Número", "Number"),
  Currency: L("Moneda", "Currency"),
  Percent: L("Porcentaje", "Percent"),
  Checkbox: L("Casilla (checkbox)", "Checkbox"),
  Date: L("Fecha", "Date"),
  DateTime: L("Fecha y hora", "Date/Time"),
  Email: "Email",
  Phone: L("Teléfono", "Phone"),
  Url: "URL",
  Picklist: L("Lista de selección (picklist)", "Picklist"),
  Lookup: L("Relación de búsqueda (lookup)", "Lookup relationship"),
};
const NAME_ERROR = {
  empty: L("Escribe el nombre de API.", "Enter the API name."),
  long: L("El nombre de API admite hasta 40 caracteres.", "The API name allows up to 40 characters."),
  chars: L(
    "Nombre de API: solo letras, números y «_», empezando con una letra, sin «__» ni «_» al final.",
    "API name: letters, numbers and “_” only, starting with a letter, with no “__” or trailing “_”."
  ),
};

const isRef = (f) => f.type === "reference" && f.referenceTo?.length > 0;
const isMD = (f) => f.relationshipOrder != null || (f.cascadeDelete && !f.nillable);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function baseType(f) {
  const num = (n) => `${n}(${f.precision - f.scale}, ${f.scale})`;
  switch (f.type) {
    case "id":
      return "Id";
    case "string":
      return `Text(${f.length})`;
    case "textarea":
      return f.extraTypeInfo === "richtextarea" ? `Rich Text(${f.length})` : f.length > 255 ? `Long Text(${f.length})` : `Text Area(${f.length})`;
    case "double":
      return num("Number");
    case "int":
      return "Number";
    case "currency":
      return num("Currency");
    case "percent":
      return num("Percent");
    case "boolean":
      return "Checkbox";
    case "datetime":
      return "Date/Time";
    case "multipicklist":
      return "Multi-Picklist";
    case "url":
      return "URL";
    case "location":
      return "Geolocation";
    case "encryptedstring":
      return "Encrypted";
    default:
      return f.type ? f.type[0].toUpperCase() + f.type.slice(1) : "";
  }
}

function fieldType(f) {
  if (f.type === "reference") return `${isMD(f) ? "Master-Detail" : "Lookup"}(${f.referenceTo.length > 3 ? `${f.referenceTo.length} ${L("objetos", "objects")}` : f.referenceTo.join(", ")})`;
  if (f.calculated && f.calculatedFormula) return `${L("Fórmula", "Formula")} (${baseType(f)})`;
  if (f.autoNumber) return "Auto Number";
  return baseType(f);
}

/** Puntos de anclaje de una arista entre dos tarjetas, según su posición relativa. */
function edgeGeometry(a, b, off) {
  const gap = 24;
  const sides =
    b.x >= a.x + a.w + gap ? ["r", "l"] : b.x + b.w <= a.x - gap ? ["l", "r"] : b.y + b.h / 2 >= a.y + a.h / 2 ? ["b", "t"] : ["t", "b"];
  const at = (n, side) => {
    if (side === "r") return { x: n.x + n.w, y: n.y + 26 + off * 12, nx: 1, ny: 0 };
    if (side === "l") return { x: n.x, y: n.y + 26 + off * 12, nx: -1, ny: 0 };
    if (side === "t") return { x: n.x + n.w / 2 + off * 22, y: n.y, nx: 0, ny: -1 };
    return { x: n.x + n.w / 2 + off * 22, y: n.y + n.h, nx: 0, ny: 1 };
  };
  const p = at(a, sides[0]);
  const q = at(b, sides[1]);
  const c = clamp(Math.hypot(q.x - p.x, q.y - p.y) * 0.4, 40, 170);
  const c1 = { x: p.x + p.nx * c, y: p.y + p.ny * c };
  const c2 = { x: q.x + q.nx * c, y: q.y + q.ny * c };
  return {
    d: `M${p.x},${p.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${q.x},${q.y}`,
    mid: { x: 0.125 * p.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * q.x, y: 0.125 * p.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * q.y },
  };
}

function selfLoop(n, i) {
  const x = n.x + n.w;
  const y = n.y + 16 + i * 12;
  return { d: `M${x},${y} C${x + 84},${y - 12} ${x + 84},${y + 50} ${x},${y + 38}`, mid: { x: x + 64, y: y + 19 } };
}

const overlaps = (a, b, m = 30) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

/** Separa tarjetas solapadas; solo mueve las de `movable` (o todas si no se indica). */
function resolveOverlaps(items, movable = null) {
  for (let it = 0; it < 120; it++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        if (!overlaps(a, b)) continue;
        const ma = !movable || movable.has(a.name);
        const mb = !movable || movable.has(b.name);
        if (!ma && !mb) continue;
        const dx = a.x + a.w / 2 - (b.x + b.w / 2);
        const dy = a.y + a.h / 2 - (b.y + b.h / 2);
        const ox = (a.w + b.w) / 2 + 30 - Math.abs(dx);
        const oy = (a.h + b.h) / 2 + 30 - Math.abs(dy);
        const share = ma && mb ? 0.5 : 1;
        if (ox < oy) {
          const s = (dx >= 0 ? 1 : -1) * ox * share;
          if (ma) a.x += s;
          if (mb) b.x -= s;
        } else {
          const s = (dy >= 0 ? 1 : -1) * oy * share;
          if (ma) a.y += s;
          if (mb) b.y -= s;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

export class SchemaBuilder {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = $("#schema");
    this.nodes = new Map(); // name -> { name, x, y, w, h, el }
    this.describes = new Map(); // name -> describe | { error }
    this.edges = [];
    this.view = { x: 0, y: 0, k: 1 };
    this.token = 0;
    this.prefs = { audit: false, labels: true, side: true };
    this.sideFilter = "all";
    this.panelTab = "fields";
    this.panelQ = "";
    this.save = debounce(() => this.saveScene(), 400);
    this.build();
    this.bind();
    storage.get("schemaPrefs", null).then((p) => {
      if (p) Object.assign(this.prefs, p);
      this.el.main.classList.toggle("side-closed", !this.prefs.side);
    });
  }

  get isOpen() {
    return this.root.classList.contains("open");
  }

  get availWidth() {
    return this.el.canvas.clientWidth - (this.panelObj ? this.el.panel.offsetWidth : 0);
  }

  build() {
    this.root.querySelector(".ide-window").innerHTML = `
      <header class="drawer-head ide-head sch-head" data-head></header>
      <div class="sch-main" data-main>
        <aside class="sch-side">
          <div class="sch-side-head"><span class="ide-files-title">${esc(L("Objetos", "Objects"))}</span><span class="sch-side-count" data-side-count></span></div>
          <label class="sch-search">${icon("search")}<input type="text" data-side-search placeholder="${esc(L("Buscar objeto…", "Search object…"))}" spellcheck="false" autocomplete="off"></label>
          <div class="sch-side-filter">${[
            ["all", L("Todos", "All")],
            ["custom", "Custom"],
            ["standard", L("Estándar", "Standard")],
            ["canvas", L("En el lienzo", "On canvas")],
          ]
            .map(([k, l]) => `<button type="button" class="sch-chipf ${k === "all" ? "on" : ""}" data-sfilter="${k}">${esc(l)}</button>`)
            .join("")}</div>
          <div class="sch-side-list" data-side-list></div>
        </aside>
        <div class="sch-canvas" data-canvas>
          <div class="sch-world" data-world>
            <svg class="sch-edges" data-edges xmlns="http://www.w3.org/2000/svg"></svg>
            <div class="sch-nodes" data-nodes></div>
          </div>
          <div class="sch-empty hidden" data-empty></div>
          <div class="sch-busy hidden" data-busy></div>
          <div class="sch-zoom">
            <button type="button" data-z="out" title="${esc(L("Alejar", "Zoom out"))}">${icon("minus")}</button>
            <button type="button" data-z="reset" class="sch-zoom-pct" data-zpct title="${esc(L("Zoom al 100%", "Zoom to 100%"))}">100%</button>
            <button type="button" data-z="in" title="${esc(L("Acercar", "Zoom in"))}">${icon("plus")}</button>
            <button type="button" data-z="fit" title="${esc(L("Ajustar a la pantalla", "Fit to screen"))}">${icon("maximize")}</button>
          </div>
          <div class="sch-legend">
            <span><i class="lk"></i>Lookup</span>
            <span><i class="md"></i>Master-Detail</span>
            <span class="sch-legend-hint">${esc(L("Arrastra para mover · rueda para zoom", "Drag to move · wheel to zoom"))}</span>
          </div>
        </div>
        <aside class="sch-panel" data-panel></aside>
      </div>`;
    const q = (s) => this.root.querySelector(s);
    this.el = {
      head: q("[data-head]"),
      main: q("[data-main]"),
      sideCount: q("[data-side-count]"),
      sideSearch: q("[data-side-search]"),
      sideList: q("[data-side-list]"),
      canvas: q("[data-canvas]"),
      world: q("[data-world]"),
      edges: q("[data-edges]"),
      nodes: q("[data-nodes]"),
      empty: q("[data-empty]"),
      busy: q("[data-busy]"),
      zpct: q("[data-zpct]"),
      panel: q("[data-panel]"),
    };
  }

  bind() {
    this.el.head.addEventListener("click", (e) => {
      const b = e.target.closest("[data-h]");
      if (!b || b.disabled) return;
      const act = b.dataset.h;
      if (act === "close") this.close();
      if (act === "side") {
        this.prefs.side = !this.prefs.side;
        this.el.main.classList.toggle("side-closed", !this.prefs.side);
        this.savePrefs();
        this.renderHead();
      }
      if (act === "audit" || act === "labels") {
        this.prefs[act] = !this.prefs[act];
        this.savePrefs();
        this.refreshBodies();
        this.renderEdges();
        this.renderHead();
        if (this.panelObj && !this.form) this.renderPanelList();
      }
      if (act === "layout") this.autoLayout();
      if (act === "reset") this.loadScene(this.scene, this.focus, { fresh: true });
      if (act === "clear" && confirm(L("¿Quitar todos los objetos del lienzo?", "Remove every object from the canvas?"))) {
        this.clearNodes();
        this.closePanel();
        this.afterNodesChanged();
      }
    });

    // Lista de objetos
    this.el.sideSearch.addEventListener("input", () => this.renderSide());
    this.root.querySelector(".sch-side-filter").addEventListener("click", (e) => {
      const b = e.target.closest("[data-sfilter]");
      if (!b) return;
      this.sideFilter = b.dataset.sfilter;
      this.root.querySelectorAll("[data-sfilter]").forEach((x) => x.classList.toggle("on", x === b));
      this.renderSide();
    });
    this.el.sideList.addEventListener("click", (e) => {
      const item = e.target.closest("[data-obj]");
      if (!item) return;
      const name = item.dataset.obj;
      if (e.target.closest("[data-toggle]") && this.nodes.has(name)) return this.removeNode(name);
      if (this.nodes.has(name)) {
        this.select(name);
        this.centerOn(name);
      } else this.addObject(name);
    });

    // Tarjetas
    this.el.nodes.addEventListener("click", (e) => {
      const b = e.target.closest("[data-nact]");
      if (!b) return;
      const name = b.closest("[data-node]").dataset.node;
      if (b.dataset.nact === "remove") this.removeNode(name);
      if (b.dataset.nact === "expand") this.expand(name);
    });

    // Lienzo: arrastrar tarjetas, mover y hacer zoom
    const canvas = this.el.canvas;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      if (e.target.closest("button, a, input, .sch-zoom, .sch-legend, .sch-empty-card")) return;
      const nodeEl = e.target.closest(".sch-node");
      const edgeEl = e.target.closest("[data-edge]");
      this.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, edge: edgeEl ? Number(edgeEl.dataset.edge) : null };
      if (nodeEl && e.button === 0) {
        const n = this.nodes.get(nodeEl.dataset.node);
        Object.assign(this.drag, { node: n, ox: n.x, oy: n.y });
      } else Object.assign(this.drag, { pan: true, ox: this.view.x, oy: this.view.y });
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* puntero ya liberado: el arrastre sigue funcionando sin captura */
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      if (!d.moved) {
        d.moved = true;
        if (d.node) d.node.el.classList.add("dragging");
        else canvas.classList.add("panning");
      }
      if (d.node) {
        d.node.x = d.ox + dx / this.view.k;
        d.node.y = d.oy + dy / this.view.k;
        this.placeNode(d.node);
        this.scheduleEdges();
      } else {
        this.view.x = d.ox + dx;
        this.view.y = d.oy + dy;
        this.applyView();
      }
    });
    const end = (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      this.drag = null;
      canvas.classList.remove("panning");
      d.node?.el.classList.remove("dragging");
      if (d.moved) return this.save();
      if (e.type === "pointercancel") return;
      if (d.node) this.select(d.node.name);
      else if (d.edge != null && this.edges[d.edge]) this.select(this.edges[d.edge].from, { field: this.edges[d.edge].field });
      else this.select(null);
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (e.target.closest(".sch-empty-card")) return;
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      },
      { passive: false }
    );
    this.root.querySelector(".sch-zoom").addEventListener("click", (e) => {
      const z = e.target.closest("[data-z]")?.dataset.z;
      const cx = this.availWidth / 2;
      const cy = canvas.clientHeight / 2;
      if (z === "in") this.zoomAt(cx, cy, 1.25, true);
      if (z === "out") this.zoomAt(cx, cy, 0.8, true);
      if (z === "reset") this.zoomAt(cx, cy, 1 / this.view.k, true);
      if (z === "fit") this.fit(true);
    });
    this.el.empty.addEventListener("click", (e) => {
      const p = e.target.closest("[data-preset]");
      if (!p) return;
      const k = p.dataset.preset;
      if (k === "reset") return this.loadScene(this.scene, this.focus, { fresh: true });
      this.addMany(k === "custom" ? [...this.objects.values()].filter((o) => o.custom && o.queryable).map((o) => o.name).slice(0, 16) : PRESETS[k].objects);
    });

    // Panel de campos
    this.el.panel.addEventListener("click", (e) => this.onPanelClick(e));
    this.el.panel.addEventListener("input", (e) => {
      if (e.target.matches("[data-p-search]")) {
        this.panelQ = e.target.value;
        this.renderPanelList();
      }
      if (e.target.name === "label" && this.form && !this.form.nameTouched) {
        const name = this.el.panel.querySelector('[name="name"]');
        if (name) name.value = apiNameFrom(e.target.value);
      }
      if (e.target.name === "name" && this.form) this.form.nameTouched = true;
    });
    this.el.panel.addEventListener("change", (e) => {
      if (e.target.name === "type" || e.target.name === "required") {
        this.captureForm();
        this.renderPanel();
      }
    });
    this.el.panel.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submitField(e.target);
    });

    document.addEventListener("keydown", (e) => {
      if (!this.isOpen) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === "Escape") {
        e.preventDefault();
        if (this.form) {
          this.form = null;
          this.renderPanel();
        } else if (this.panelObj) this.select(null);
        else this.close();
      } else if (!typing && e.key === "Delete" && this.selected) this.removeNode(this.selected);
    });
  }

  // ───────────────────────────────────────── Abrir / cerrar / escenas
  show() {
    if (this.isOpen) return;
    this.root.classList.remove("hidden");
    requestAnimationFrame(() => this.root.classList.add("open"));
  }

  close() {
    if (this.form?.busy) return;
    this.saveScene();
    this.root.classList.remove("open");
    setTimeout(() => {
      if (!this.isOpen) this.root.classList.add("hidden");
    }, 380);
  }

  /** Schema Builder general (botón de la barra superior). */
  openMain() {
    this.show();
    if (this.scene !== "main") this.loadScene("main");
  }

  /** Relaciones de un objeto (botón de la fila en Objetos). */
  openRelations(name) {
    this.show();
    if (this.scene === `rel:${name}`) return this.select(name);
    this.loadScene(`rel:${name}`, name);
  }

  sceneKey(scene = this.scene) {
    return `schema:${this.ctx.session.host}:${scene}`;
  }

  saveScene() {
    if (!this.scene || this.loadingScene) return;
    storage.set(this.sceneKey(), {
      nodes: [...this.nodes.values()].map((n) => ({ n: n.name, x: Math.round(n.x), y: Math.round(n.y) })),
      view: this.view,
    });
  }

  savePrefs() {
    storage.set("schemaPrefs", { ...this.prefs });
  }

  async loadScene(scene, focus = null, { fresh = false } = {}) {
    const token = ++this.token;
    this.scene = scene;
    this.focus = focus;
    this.overflow = 0;
    this.loadingScene = true;
    this.clearNodes();
    this.closePanel();
    this.view = { x: this.availWidth / 2, y: 80, k: 1 };
    this.applyView();
    this.renderHead();
    this.renderEmpty();
    this.busy(L("Cargando objetos…", "Loading objects…"));
    try {
      await this.ensureObjects();
      if (token !== this.token) return;
      const saved = fresh ? null : await storage.get(this.sceneKey(), null);
      if (token !== this.token) return;
      const savedNodes = (saved?.nodes || []).filter((n) => this.objects.has(n.n) || n.n === focus);
      if (savedNodes.length) {
        savedNodes.forEach((n) => this.addNodeEl(n.n, n.x, n.y));
        await this.loadDescribes(savedNodes.map((n) => n.n), token);
        if (token !== this.token) return;
        if (saved.view?.k) {
          this.view = saved.view;
          this.applyView();
        } else this.fit();
      } else if (focus) {
        await this.buildRelations(focus, token);
      }
    } catch (e) {
      if (token !== this.token) return;
      if (e.status === 401) return this.ctx.sessionExpired();
      toast(friendlyError(e), "error");
    } finally {
      if (token === this.token) {
        this.loadingScene = false;
        this.busy(null);
        this.refreshBodies();
        this.renderEdges();
        this.renderSide();
        this.renderEmpty();
        this.renderHead();
        if (fresh) this.saveScene();
        if (focus && this.nodes.has(focus)) this.select(focus);
      }
    }
  }

  async ensureObjects() {
    if (this.objects) return;
    const def = getType("CustomObject");
    const list = await def.load(this.ctx.api);
    this.objects = new Map(
      list.map((s) => {
        const row = def.map(s);
        return [s.name, { name: s.name, label: s.label, plural: s.labelPlural, custom: !!s.custom, prefix: s.keyPrefix, queryable: !!row.dataObject, url: def.url(row) }];
      })
    );
    this.renderSide();
  }

  meta(name) {
    return this.objects?.get(name) || { name, label: name, custom: /__c$/.test(name), url: null };
  }

  async buildRelations(focus, token) {
    this.addNodeEl(focus, 0, 0);
    await this.loadDescribes([focus], token);
    if (token !== this.token) return;
    const { parents, children, extra } = this.relatedOf(focus, MAX_CHILDREN);
    this.overflow = extra;
    [...parents, ...children].forEach((o) => this.addNodeEl(o, 0, 0));
    this.busy(L("Leyendo objetos relacionados…", "Reading related objects…"));
    await this.loadDescribes([...parents, ...children], token);
    if (token !== this.token) return;
    this.refreshBodies();
    this.layoutRelations(focus, parents, children);
    this.fit();
    this.loadingScene = false;
    this.saveScene();
  }

  /** Padres (a los que apuntan sus lookups) e hijos (que apuntan a él) conocidos de un objeto. */
  relatedOf(name, cap) {
    const d = this.describes.get(name);
    if (!d?.fields) return { parents: [], children: [], extra: 0 };
    const known = (o) => o !== name && this.objects.has(o);
    const parents = [...new Set(d.fields.filter((f) => isRef(f) && !AUDIT_FIELDS.has(f.name) && f.referenceTo.length <= MAX_POLY).flatMap((f) => f.referenceTo))].filter(known);
    const kids = [
      ...new Set(
        (d.childRelationships || [])
          .filter((c) => !c.deprecatedAndHidden && !AUDIT_FIELDS.has(c.field) && !SKIP_CHILD.test(c.childSObject))
          .map((c) => c.childSObject)
      ),
    ].filter((o) => known(o) && !parents.includes(o));
    kids.sort((a, b) => this.meta(b).custom - this.meta(a).custom || a.localeCompare(b));
    return { parents, children: kids.slice(0, cap), extra: Math.max(0, kids.length - cap) };
  }

  /** Padres arriba, el objeto en el medio, hijos abajo; en filas de hasta 6. */
  layoutRelations(focus, parents, children) {
    const chunk = (arr) => Array.from({ length: Math.ceil(arr.length / 6) }, (_, i) => arr.slice(i * 6, i * 6 + 6));
    const rows = [...chunk(parents), [focus], ...chunk(children)];
    let y = 0;
    for (const row of rows) {
      const nodes = row.map((n) => this.nodes.get(n)).filter(Boolean);
      const width = nodes.length * NODE_W + (nodes.length - 1) * 50;
      nodes.forEach((n, i) => {
        n.x = -width / 2 + i * (NODE_W + 50);
        n.y = y;
        this.placeNode(n);
      });
      y += Math.max(...nodes.map((n) => n.h)) + 110;
    }
  }

  // ───────────────────────────────────────── Tarjetas
  addNodeEl(name, x, y) {
    if (this.nodes.has(name)) return this.nodes.get(name);
    const meta = this.meta(name);
    const el = document.createElement("div");
    el.className = `sch-node ${meta.custom ? "custom" : ""} ${name === this.focus ? "focus" : ""}`;
    el.dataset.node = name;
    el.innerHTML = `<div class="sch-node-head">
        <span class="sch-node-ico">${icon("box")}</span>
        <span class="sch-node-title"><b>${esc(meta.label)}</b><span>${esc(name)}</span></span>
        <span class="sch-node-acts">
          <button type="button" data-nact="expand" title="${esc(L("Agregar sus objetos relacionados", "Add its related objects"))}">${icon("share")}</button>
          ${meta.url ? `<a data-sf href="${esc(this.ctx.url(meta.url))}" title="${esc(L("Abrir en Salesforce (Object Manager)", "Open in Salesforce (Object Manager)"))}">${icon("external")}</a>` : ""}
          <button type="button" data-nact="remove" title="${esc(L("Quitar del lienzo", "Remove from canvas"))}">${icon("x")}</button>
        </span>
      </div>
      <div class="sch-node-body"><div class="sch-node-loading"><span class="spinner"></span></div></div>`;
    this.el.nodes.appendChild(el);
    const n = { name, x, y, w: NODE_W, h: 110, el };
    this.nodes.set(name, n);
    this.placeNode(n);
    if (this.describes.has(name)) this.renderNodeBody(name);
    return n;
  }

  placeNode(n) {
    n.el.style.transform = `translate(${n.x}px, ${n.y}px)`;
  }

  linked(f) {
    return f.referenceTo.some((t) => this.nodes.has(t)) ? 1 : 0;
  }

  renderNodeBody(name) {
    const n = this.nodes.get(name);
    if (!n) return;
    const d = this.describes.get(name);
    const body = n.el.querySelector(".sch-node-body");
    if (!d) body.innerHTML = '<div class="sch-node-loading"><span class="spinner"></span></div>';
    else if (d.error) body.innerHTML = `<div class="sch-node-msg">${icon("lock")}<span>${esc(friendlyError(d.error))}</span></div>`;
    else {
      const refs = d.fields.filter((f) => isRef(f) && (this.prefs.audit || !AUDIT_FIELDS.has(f.name)));
      refs.sort((a, b) => this.linked(b) - this.linked(a) || a.name.localeCompare(b.name));
      body.innerHTML = `${refs
        .slice(0, NODE_FIELDS)
        .map(
          (f) => `<div class="sch-nf ${this.linked(f) ? "linked" : ""} ${isMD(f) ? "md" : ""}" title="${esc(`${f.label}\n${f.name} → ${f.referenceTo.join(", ")}`)}">
            <span class="sch-nf-name">${esc(f.name)}</span>
            <span class="sch-nf-to">${esc(f.referenceTo.length > 2 ? `${f.referenceTo.length} ${L("objetos", "objects")}` : f.referenceTo.join(", "))}</span>
          </div>`
        )
        .join("")}${refs.length > NODE_FIELDS ? `<div class="sch-nf more">+${refs.length - NODE_FIELDS} ${esc(L("relaciones más", "more relationships"))}</div>` : ""}${
        refs.length ? "" : `<div class="sch-nf more">${esc(L("Sin campos de relación", "No relationship fields"))}</div>`
      }<div class="sch-node-foot">${d.fields.length.toLocaleString(locale)} ${esc(L("campos", "fields"))}</div>`;
    }
    n.h = n.el.offsetHeight || n.h;
  }

  refreshBodies() {
    for (const name of this.nodes.keys()) this.renderNodeBody(name);
  }

  async loadDescribes(names, token = this.token) {
    const queue = [...new Set(names)].filter((n) => !this.describes.has(n));
    const total = queue.length;
    let done = 0;
    const work = async () => {
      while (queue.length) {
        const name = queue.shift();
        try {
          this.describes.set(name, await this.ctx.api.describe(name));
        } catch (e) {
          if (e.status === 401) {
            this.ctx.sessionExpired();
            throw e;
          }
          this.describes.set(name, { error: e });
        }
        done++;
        if (token !== this.token) continue;
        this.renderNodeBody(name);
        if (total > 3) this.busy(L(`Leyendo objetos… ${done}/${total}`, `Reading objects… ${done}/${total}`));
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, total) }, work));
  }

  viewCenter() {
    return { x: (this.availWidth / 2 - this.view.x) / this.view.k, y: (this.el.canvas.clientHeight / 2 - this.view.y) / this.view.k };
  }

  /** Primer hueco libre cerca de un punto (en espiral). */
  freeSpot(cx, cy, h = 160) {
    const others = [...this.nodes.values()];
    for (let r = 0; r < 4000; r += 70) {
      const steps = r ? Math.ceil((2 * Math.PI * r) / 140) : 1;
      for (let s = 0; s < steps; s++) {
        const a = (s / steps) * 2 * Math.PI;
        const rect = { x: cx + r * Math.cos(a) - NODE_W / 2, y: cy + r * Math.sin(a) - h / 2, w: NODE_W, h };
        if (!others.some((o) => overlaps(rect, o))) return rect;
      }
    }
    return { x: cx - NODE_W / 2, y: cy - h / 2 };
  }

  async addObject(name, { near = null } = {}) {
    if (this.nodes.has(name)) return this.centerOn(name);
    const base = near && this.nodes.get(near);
    const spot = base ? this.freeSpot(base.x + base.w / 2, base.y + base.h / 2) : this.freeSpot(this.viewCenter().x, this.viewCenter().y);
    const n = this.addNodeEl(name, spot.x, spot.y);
    n.el.classList.add("new");
    this.afterNodesChanged();
    await this.loadDescribes([name]);
    this.refreshBodies();
    this.renderEdges();
    if (base) this.centerOn(name);
  }

  async addMany(names) {
    const add = [...new Set(names)].filter((n) => this.objects.has(n) && !this.nodes.has(n));
    if (!add.length) return;
    const c = this.viewCenter();
    add.forEach((n, i) => this.addNodeEl(n, c.x + (i % 4) * 280 - 560, c.y + Math.floor(i / 4) * 240));
    this.renderEmpty();
    this.renderSide();
    this.busy(L("Leyendo objetos…", "Reading objects…"));
    await this.loadDescribes(add);
    this.busy(null);
    this.refreshBodies();
    this.autoLayout({ animate: false });
    this.afterNodesChanged();
    this.fit(true);
  }

  async expand(name) {
    await this.loadDescribes([name]);
    const { parents, children, extra } = this.relatedOf(name, 12);
    const add = [...parents, ...children].filter((o) => !this.nodes.has(o));
    if (!add.length) return toast(L("Sus objetos relacionados ya están en el lienzo", "Its related objects are already on the canvas"), "info", 2200);
    const c = this.nodes.get(name);
    const place = (list, y) =>
      list.forEach((o, i) => {
        const n = this.addNodeEl(o, c.x + c.w / 2 - (Math.min(list.length, 5) * 290) / 2 + (i % 5) * 290, y + Math.floor(i / 5) * 230 * Math.sign(y - c.y || 1));
        n.el.classList.add("new");
      });
    place(parents.filter((o) => !this.nodes.has(o)), c.y - 300);
    place(children.filter((o) => !this.nodes.has(o)), c.y + c.h + 120);
    await this.loadDescribes(add);
    this.refreshBodies();
    resolveOverlaps([...this.nodes.values()], new Set(add));
    this.nodes.forEach((n) => this.placeNode(n));
    this.afterNodesChanged();
    this.fit(true);
    toast(
      extra
        ? L(`Se agregaron ${add.length} objetos. Hay ${extra} hijos más en la pestaña Relaciones.`, `Added ${add.length} objects. There are ${extra} more children in the Relationships tab.`)
        : L(`Se agregaron ${add.length} objetos`, `Added ${add.length} objects`),
      "success",
      2600
    );
  }

  removeNode(name) {
    const n = this.nodes.get(name);
    if (!n) return;
    n.el.remove();
    this.nodes.delete(name);
    if (this.selected === name) this.select(null);
    this.afterNodesChanged();
  }

  clearNodes() {
    this.nodes.forEach((n) => n.el.remove());
    this.nodes.clear();
    this.selected = null;
  }

  afterNodesChanged() {
    this.refreshBodies();
    this.renderEdges();
    this.renderSide();
    this.renderEmpty();
    this.renderHead();
    this.save();
  }

  // ───────────────────────────────────────── Aristas
  computeEdges() {
    const edges = [];
    for (const n of this.nodes.values()) {
      const d = this.describes.get(n.name);
      if (!d?.fields) continue;
      for (const f of d.fields) {
        if (!isRef(f) || (!this.prefs.audit && AUDIT_FIELDS.has(f.name))) continue;
        for (const t of f.referenceTo) if (this.nodes.has(t)) edges.push({ from: n.name, to: t, field: f.name, md: isMD(f) });
      }
    }
    return edges;
  }

  scheduleEdges() {
    if (this.edgeFrame) return;
    this.edgeFrame = requestAnimationFrame(() => {
      this.edgeFrame = null;
      this.renderEdges();
    });
  }

  renderEdges() {
    const edges = (this.edges = this.computeEdges());
    const pairKey = (e) => [e.from, e.to].sort().join("|");
    const total = new Map();
    edges.forEach((e) => total.set(pairKey(e), (total.get(pairKey(e)) || 0) + 1));
    const seen = new Map();
    const sel = this.selected;
    const related = new Set(sel ? [sel] : []);
    let paths = "";
    edges.forEach((e, idx) => {
      const k = pairKey(e);
      const i = seen.get(k) || 0;
      seen.set(k, i + 1);
      const a = this.nodes.get(e.from);
      const g = e.from === e.to ? selfLoop(a, i) : edgeGeometry(a, this.nodes.get(e.to), i - (total.get(k) - 1) / 2);
      const kind = e.md ? "md" : "lk";
      const on = sel && (e.from === sel || e.to === sel);
      if (on) related.add(e.from).add(e.to);
      paths += `<g class="sch-edge ${kind} ${sel ? (on ? "hl" : "dim") : ""}" data-edge="${idx}">
        <title>${esc(`${e.from}.${e.field} → ${e.to} (${e.md ? "Master-Detail" : "Lookup"})`)}</title>
        <path class="sch-edge-hit" d="${g.d}"/>
        <path class="sch-edge-line" d="${g.d}" marker-start="url(#sch-many-${kind})" marker-end="url(#sch-one-${kind})"/>
        ${this.prefs.labels ? `<text class="sch-edge-label" x="${g.mid.x}" y="${g.mid.y - 5}">${esc(e.field)}</text>` : ""}
      </g>`;
    });
    // El SVG cubre la caja de todas las tarjetas (con margen) para que el hover funcione en todo el dibujo.
    let minX = 0, minY = 0, maxX = 1, maxY = 1; // prettier-ignore
    if (this.nodes.size) {
      const list = [...this.nodes.values()];
      minX = Math.min(...list.map((n) => n.x)) - 200;
      minY = Math.min(...list.map((n) => n.y)) - 200;
      maxX = Math.max(...list.map((n) => n.x + n.w)) + 200;
      maxY = Math.max(...list.map((n) => n.y + n.h)) + 200;
    }
    const svg = this.el.edges;
    svg.setAttribute("viewBox", `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
    Object.assign(svg.style, { left: `${minX}px`, top: `${minY}px`, width: `${maxX - minX}px`, height: `${maxY - minY}px` });
    const marker = (id, cls, d) =>
      `<marker id="${id}" markerUnits="userSpaceOnUse" markerWidth="20" markerHeight="20" refX="0" refY="0" orient="auto" overflow="visible"><path class="sch-mk ${cls}" d="${d}"/></marker>`;
    svg.innerHTML = `<defs>
      ${marker("sch-many-lk", "lk", "M13,0 L0,-6 M13,0 L0,0 M13,0 L0,6")}
      ${marker("sch-many-md", "md", "M13,0 L0,-6 M13,0 L0,0 M13,0 L0,6")}
      ${marker("sch-one-lk", "lk", "M-9,-6 L-9,6")}
      ${marker("sch-one-md", "md", "M-9,-6 L-9,6 M-14,-6 L-14,6")}
    </defs>${paths}`;
    this.nodes.forEach((n, name) => {
      n.el.classList.toggle("selected", name === sel);
      n.el.classList.toggle("faded", !!sel && !related.has(name));
    });
    this.renderCounts();
  }

  // ───────────────────────────────────────── Vista: zoom, encuadre y auto-organización
  applyView() {
    const { x, y, k } = this.view;
    this.el.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    this.el.canvas.style.backgroundSize = `${24 * k}px ${24 * k}px`;
    this.el.canvas.style.backgroundPosition = `${x}px ${y}px`;
    this.el.zpct.textContent = `${Math.round(k * 100)}%`;
  }

  glide() {
    this.el.world.classList.add("glide");
    clearTimeout(this.glideTimer);
    this.glideTimer = setTimeout(() => this.el.world.classList.remove("glide"), 420);
  }

  zoomAt(px, py, factor, animate = false) {
    const k = clamp(this.view.k * factor, 0.15, 2.5);
    const wx = (px - this.view.x) / this.view.k;
    const wy = (py - this.view.y) / this.view.k;
    this.view = { x: px - wx * k, y: py - wy * k, k };
    if (animate) this.glide();
    this.applyView();
    this.save();
  }

  fit(animate = false) {
    const list = [...this.nodes.values()];
    const cw = this.availWidth;
    const ch = this.el.canvas.clientHeight;
    if (!list.length || !cw) return;
    const minX = Math.min(...list.map((n) => n.x));
    const minY = Math.min(...list.map((n) => n.y));
    const bw = Math.max(...list.map((n) => n.x + n.w)) - minX;
    const bh = Math.max(...list.map((n) => n.y + n.h)) - minY;
    const k = clamp(Math.min((cw - 100) / bw, (ch - 120) / bh), 0.15, 1);
    this.view = { x: (cw - bw * k) / 2 - minX * k, y: (ch - bh * k) / 2 - minY * k, k };
    if (animate) this.glide();
    this.applyView();
    this.save();
  }

  centerOn(name) {
    const n = this.nodes.get(name);
    if (!n) return;
    const k = Math.max(this.view.k, 0.7);
    this.view = { x: this.availWidth / 2 - (n.x + n.w / 2) * k, y: this.el.canvas.clientHeight / 2 - (n.y + n.h / 2) * k, k };
    this.glide();
    this.applyView();
    n.el.classList.remove("pulse");
    void n.el.offsetWidth;
    n.el.classList.add("pulse");
    this.save();
  }

  /**
   * Distribución por niveles, como un diagrama de entidades: cada objeto queda una fila por debajo
   * de sus padres (los objetos a los que apuntan sus lookups). Dentro de cada fila se ordena por el
   * promedio de posición de sus vecinos para reducir cruces. Los objetos sin relaciones van al final.
   */
  autoLayout({ animate = true } = {}) {
    const list = [...this.nodes.values()];
    if (list.length < 2) return;
    const parents = new Map(list.map((n) => [n.name, new Set()]));
    const children = new Map(list.map((n) => [n.name, new Set()]));
    for (const e of this.edges) {
      if (e.from === e.to) continue;
      parents.get(e.from).add(e.to);
      children.get(e.to).add(e.from);
    }
    const rank = new Map();
    const visiting = new Set();
    const rankOf = (name) => {
      if (rank.has(name)) return rank.get(name);
      if (visiting.has(name)) return 0; // ciclo (A → B → A): se corta aquí
      visiting.add(name);
      let r = 0;
      for (const p of parents.get(name)) r = Math.max(r, rankOf(p) + 1);
      visiting.delete(name);
      rank.set(name, r);
      return r;
    };
    const isolated = list.filter((n) => !parents.get(n.name).size && !children.get(n.name).size).map((n) => n.name);
    const levels = [];
    list.forEach((n) => !isolated.includes(n.name) && (levels[rankOf(n.name)] ||= []).push(n.name));
    const rows = levels.filter(Boolean);
    // Orden inicial: los más conectados al centro; luego barycenter en varias pasadas.
    const degree = (n) => parents.get(n).size + children.get(n).size;
    rows.forEach((row) => row.sort((a, b) => degree(b) - degree(a) || a.localeCompare(b)));
    const posX = new Map();
    const index = () => rows.forEach((row) => row.forEach((n, i) => posX.set(n, i - (row.length - 1) / 2)));
    index();
    for (let pass = 0; pass < 6; pass++) {
      const order = pass % 2 ? [...rows].reverse() : rows;
      for (const row of order) {
        const bary = (n) => {
          const nb = [...parents.get(n), ...children.get(n)].filter((m) => posX.has(m));
          return nb.length ? nb.reduce((s, m) => s + posX.get(m), 0) / nb.length : posX.get(n);
        };
        const score = new Map(row.map((n) => [n, bary(n)]));
        row.sort((a, b) => score.get(a) - score.get(b));
        index();
      }
    }
    const MAX_PER_ROW = 7;
    const wrap = (row) => Array.from({ length: Math.ceil(row.length / MAX_PER_ROW) }, (_, i) => row.slice(i * MAX_PER_ROW, (i + 1) * MAX_PER_ROW));
    const placed = [...rows.flatMap(wrap), ...wrap(isolated)];
    const to = new Map();
    let y = 0;
    for (const row of placed) {
      const width = row.length * NODE_W + (row.length - 1) * 60;
      row.forEach((name, i) => to.set(name, { x: -width / 2 + i * (NODE_W + 60), y }));
      y += Math.max(...row.map((name) => this.nodes.get(name).h)) + 120;
    }
    if (!animate) {
      list.forEach((n) => {
        n.x = to.get(n.name).x;
        n.y = to.get(n.name).y;
        this.placeNode(n);
      });
      return this.renderEdges();
    }
    const from = new Map(list.map((n) => [n.name, { x: n.x, y: n.y }]));
    const start = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - start) / 520);
      const e = 1 - Math.pow(1 - p, 3);
      list.forEach((n) => {
        const a = from.get(n.name);
        const b = to.get(n.name);
        n.x = a.x + (b.x - a.x) * e;
        n.y = a.y + (b.y - a.y) * e;
        this.placeNode(n);
      });
      this.renderEdges();
      if (p < 1) requestAnimationFrame(step);
      else {
        this.fit(true);
        this.save();
      }
    };
    requestAnimationFrame(step);
  }

  // ───────────────────────────────────────── Encabezado, lista lateral y estados
  renderHead() {
    const n = this.nodes.size;
    const rel = this.focus;
    this.el.head.innerHTML = `
      <button class="icon-btn sch-side-toggle ${this.prefs.side ? "on" : ""}" data-h="side" title="${esc(L("Mostrar u ocultar la lista de objetos", "Show or hide the object list"))}">${icon("list")}</button>
      <div class="rh-ico" style="--c:#0ea5e9">${icon(rel ? "share" : "network")}</div>
      <div class="dh-title">
        <h3>${esc(rel ? L(`Relaciones de ${rel}`, `${rel} relationships`) : "Schema Builder")}</h3>
        <p data-sub></p>
      </div>
      <div class="ide-actions sch-actions">
        <button class="ghost-btn ${this.prefs.audit ? "on" : ""}" data-h="audit" title="${esc(L("Mostrar CreatedBy / LastModifiedBy", "Show CreatedBy / LastModifiedBy"))}">${icon("history")}<span>${esc(
          L("Auditoría", "Audit")
        )}</span></button>
        <button class="ghost-btn ${this.prefs.labels ? "on" : ""}" data-h="labels" title="${esc(L("Nombre del campo sobre cada relación", "Field name on each relationship"))}">${icon("tag")}<span>${esc(
          L("Etiquetas", "Labels")
        )}</span></button>
        <button class="ghost-btn" data-h="layout" ${n < 2 ? "disabled" : ""}>${icon("wand")}<span>${esc(L("Auto-organizar", "Auto-arrange"))}</span></button>
        ${
          rel
            ? `<button class="ghost-btn" data-h="reset" title="${esc(L("Volver a la distribución inicial", "Back to the initial layout"))}">${icon("undo")}<span>${esc(L("Restablecer", "Reset"))}</span></button>`
            : ""
        }
        <button class="ghost-btn" data-h="clear" ${n ? "" : "disabled"} title="${esc(L("Quitar todos los objetos del lienzo", "Remove every object from the canvas"))}">${icon("eraser")}<span>${esc(
          L("Limpiar", "Clear")
        )}</span></button>
        <button class="icon-btn" data-h="close" title="${esc(L("Cerrar (Esc)", "Close (Esc)"))}">${icon("x")}</button>
      </div>`;
    this.renderCounts();
  }

  renderCounts() {
    const sub = this.el.head.querySelector("[data-sub]");
    if (!sub) return;
    const n = this.nodes.size;
    const e = this.edges.length;
    sub.textContent = [
      `${n} ${n === 1 ? L("objeto", "object") : L("objetos", "objects")}`,
      `${e} ${e === 1 ? L("relación", "relationship") : L("relaciones", "relationships")}`,
      this.overflow ? L(`${this.overflow} hijos más en la pestaña Relaciones`, `${this.overflow} more children in the Relationships tab`) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  renderSide() {
    const list = this.el.sideList;
    if (!this.objects) {
      list.innerHTML = `<div class="ide-tree-msg"><span class="spinner"></span>${esc(L("Cargando objetos…", "Loading objects…"))}</div>`;
      return;
    }
    const q = this.el.sideSearch.value.trim();
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const items = [...this.objects.values()]
      .filter((o) =>
        this.sideFilter === "custom" ? o.custom : this.sideFilter === "standard" ? !o.custom : this.sideFilter === "canvas" ? this.nodes.has(o.name) : true
      )
      .filter((o) => !tokens.length || tokens.every((t) => `${o.label} ${o.name}`.toLowerCase().includes(t)))
      .sort((a, b) => a.label.localeCompare(b.label));
    this.el.sideCount.textContent = items.length.toLocaleString(locale);
    list.innerHTML = items.length
      ? items
          .map((o) => {
            const on = this.nodes.has(o.name);
            return `<button type="button" class="sch-obj ${on ? "on" : ""}" data-obj="${esc(o.name)}" title="${esc(
              on ? L(`${o.name}: en el lienzo (click para ubicarlo)`, `${o.name}: on the canvas (click to locate it)`) : L(`Agregar ${o.name} al lienzo`, `Add ${o.name} to the canvas`)
            )}">
              <span class="sch-obj-check" data-toggle title="${esc(on ? L("Quitar del lienzo", "Remove from canvas") : L("Agregar", "Add"))}">${icon(on ? "check" : "plus")}</span>
              <span class="sch-obj-text"><b>${highlight(o.label, q)}</b><span>${highlight(o.name, q)}</span></span>
              ${o.custom ? '<span class="sch-obj-tag">C</span>' : ""}
            </button>`;
          })
          .join("")
      : `<div class="ide-tree-msg">${esc(L("Ningún objeto coincide", "No object matches"))}</div>`;
  }

  renderEmpty() {
    const show = !this.nodes.size && !this.loadingScene;
    this.el.empty.classList.toggle("hidden", !show);
    if (!show) return;
    this.el.empty.innerHTML = this.describes.get(this.focus)?.error
      ? `<div class="sch-empty-card"><div class="sch-empty-ico">${icon("alert")}</div><h3>${esc(
          L(`No se pudo leer ${this.focus}`, `Could not read ${this.focus}`)
        )}</h3><p>${esc(L("Tu usuario no tiene acceso a este objeto o no admite describe.", "Your user has no access to this object or it doesn't support describe."))}</p></div>`
      : `<div class="sch-empty-card">
          <div class="sch-empty-ico">${icon("network")}</div>
          <h3>${esc(L("Arma tu diagrama", "Build your diagram"))}</h3>
          <p>${esc(L("Agrega objetos desde la lista de la izquierda, o empieza con un conjunto:", "Add objects from the list on the left, or start with a set:"))}</p>
          <div class="sch-presets">
            ${
              this.focus
                ? `<button type="button" class="ghost-btn" data-preset="reset">${icon("undo")}<span>${esc(L(`Relaciones de ${this.focus}`, `${this.focus} relationships`))}</span></button>`
                : ""
            }
            ${Object.entries(PRESETS)
              .map(([k, p]) => `<button type="button" class="ghost-btn" data-preset="${k}">${icon("layers")}<span>${esc(p.label)}</span></button>`)
              .join("")}
            <button type="button" class="ghost-btn" data-preset="custom">${icon("box")}<span>${esc(L("Mis objetos custom", "My custom objects"))}</span></button>
          </div>
        </div>`;
  }

  busy(text) {
    this.el.busy.classList.toggle("hidden", !text);
    if (text) this.el.busy.innerHTML = `<span class="spinner"></span>${esc(text)}`;
  }

  // ───────────────────────────────────────── Selección y panel de campos
  select(name, { field = null } = {}) {
    const next = name && this.nodes.has(name) ? name : null;
    const changed = next !== this.selected;
    this.selected = next;
    this.renderEdges();
    if (!next) return this.closePanel();
    if (changed || this.panelObj !== next) {
      this.panelQ = "";
      this.form = null;
    }
    if (field) this.panelTab = "fields";
    this.openPanel(next, { field });
  }

  openPanel(name, { field } = {}) {
    const wasOpen = !!this.panelObj;
    this.panelObj = name;
    this.el.panel.classList.add("open");
    this.el.main.classList.add("panel-open");
    this.renderPanel({ field });
    if (!this.describes.has(name)) this.loadDescribes([name]).then(() => this.panelObj === name && this.renderPanel({ field }));
    // Si la tarjeta queda tapada por el panel, se desplaza la vista.
    const n = this.nodes.get(name);
    if (!wasOpen && n && (n.x + n.w) * this.view.k + this.view.x > this.availWidth - 20) {
      this.view.x = this.availWidth - 60 - (n.x + n.w) * this.view.k;
      this.glide();
      this.applyView();
    }
  }

  closePanel() {
    if (this.form?.busy) return;
    this.panelObj = null;
    this.form = null;
    this.el.panel.classList.remove("open");
    this.el.main.classList.remove("panel-open");
  }

  renderPanel({ field = null } = {}) {
    const name = this.panelObj;
    if (!name) return;
    const meta = this.meta(name);
    const d = this.describes.get(name);
    const head = `
      <div class="sch-p-head">
        <span class="sch-node-ico ${meta.custom ? "custom" : ""}">${icon("box")}</span>
        <div class="dh-title"><h3>${esc(meta.label)}</h3><p>${esc(name)}${meta.prefix ? ` · ${esc(meta.prefix)}` : ""}${meta.custom ? " · Custom" : ""}</p></div>
        <button class="icon-btn" data-p="close" title="${esc(L("Cerrar panel (Esc)", "Close panel (Esc)"))}">${icon("x")}</button>
      </div>
      <div class="sch-p-actions">
        ${meta.url ? `<a class="ghost-btn" data-sf href="${esc(this.ctx.url(meta.url))}">${icon("external")}<span>${esc(L("Abrir en Setup", "Open in Setup"))}</span></a>` : ""}
        ${meta.queryable ? `<button class="ghost-btn" data-p="data">${icon("database")}<span>${esc(L("Ver registros", "View records"))}</span></button>` : ""}
        <button class="ghost-btn" data-p="expand">${icon("share")}<span>${esc(L("Agregar relacionados", "Add related"))}</span></button>
      </div>`;
    if (!d) return (this.el.panel.innerHTML = `${head}<div class="ide-tree-msg sch-p-msg"><span class="spinner"></span>${esc(L("Leyendo campos…", "Reading fields…"))}</div>`);
    if (d.error) return (this.el.panel.innerHTML = `${head}<div class="sch-p-list"><div class="empty error"><div class="e-ico">${icon("alert")}</div><p>${esc(friendlyError(d.error))}</p></div></div>`);
    if (this.form) return (this.el.panel.innerHTML = head + this.formHtml(meta, d));
    const rels = this.relationsOf(d);
    this.el.panel.innerHTML = `${head}
      <div class="sch-tabs">
        <button type="button" class="sch-tab ${this.panelTab === "fields" ? "on" : ""}" data-tab="fields">${esc(L("Campos", "Fields"))}<b>${d.fields.length}</b></button>
        <button type="button" class="sch-tab ${this.panelTab === "rels" ? "on" : ""}" data-tab="rels">${esc(L("Relaciones", "Relationships"))}<b>${rels.parents.length + rels.children.length}</b></button>
      </div>
      <div class="sch-p-tools">
        <label class="sch-search">${icon("search")}<input type="text" data-p-search value="${esc(this.panelQ)}" placeholder="${esc(
          this.panelTab === "fields" ? L("Buscar campo o tipo…", "Search field or type…") : L("Buscar objeto o campo…", "Search object or field…")
        )}" spellcheck="false" autocomplete="off"></label>
        ${
          this.panelTab === "fields" && d.createable !== undefined
            ? `<button class="primary-btn sm" data-p="new-field" ${meta.custom || d.custom || d.layoutable ? "" : "disabled"}>${icon("plus")}<span>${esc(L("Nuevo campo", "New field"))}</span></button>`
            : ""
        }
      </div>
      <div class="sch-p-list" data-p-list></div>`;
    this.renderPanelList();
    if (field) {
      const row = this.el.panel.querySelector(`[data-f="${CSS.escape(field)}"]`);
      if (row) {
        row.scrollIntoView({ block: "center" });
        row.classList.add("flash");
      }
    }
  }

  relationsOf(d) {
    const parents = d.fields.filter((f) => isRef(f) && (this.prefs.audit || !AUDIT_FIELDS.has(f.name)));
    const children = (d.childRelationships || []).filter(
      (c) => !c.deprecatedAndHidden && (this.prefs.audit || !AUDIT_FIELDS.has(c.field)) && this.objects?.has(c.childSObject) && !SKIP_CHILD.test(c.childSObject)
    );
    return { parents, children };
  }

  chip(o) {
    const on = this.nodes.has(o);
    const known = on || this.objects?.has(o);
    return `<button type="button" class="sch-chip ${on ? "on" : ""}" data-add="${esc(o)}" ${known ? "" : "disabled"} title="${esc(
      on ? L("Ubicar en el lienzo", "Locate on canvas") : L("Agregar al lienzo", "Add to canvas")
    )}">${icon(on ? "target" : "plus")}${esc(o)}</button>`;
  }

  renderPanelList() {
    const box = this.el.panel.querySelector("[data-p-list]");
    const d = this.describes.get(this.panelObj);
    if (!box || !d?.fields) return;
    const q = this.panelQ.trim();
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (...vals) => !tokens.length || tokens.every((t) => vals.some((v) => String(v || "").toLowerCase().includes(t)));
    const none = `<div class="sch-none">${esc(L("Nada coincide", "Nothing matches"))}</div>`;
    if (this.panelTab === "fields") {
      const rank = (f) => (f.type === "id" ? 0 : f.nameField ? 1 : 2);
      const fields = [...d.fields].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)).filter((f) => match(f.label, f.name, fieldType(f)));
      box.innerHTML = fields.length
        ? fields
            .map((f) => {
              const required = !f.nillable && f.createable && f.type !== "boolean" && !f.defaultedOnCreate;
              const flags = [
                required ? `<span class="sch-flag req" title="${esc(L("Obligatorio", "Required"))}">${esc(L("Oblig.", "Req."))}</span>` : "",
                f.unique ? '<span class="sch-flag">Unique</span>' : "",
                f.externalId ? '<span class="sch-flag">Ext ID</span>' : "",
                f.custom ? '<span class="sch-flag custom">Custom</span>' : "",
              ].join("");
              const targets = isRef(f)
                ? `<div class="sch-f-refs">${f.referenceTo.slice(0, 6).map((t) => this.chip(t)).join("")}${f.referenceTo.length > 6 ? `<span class="sch-more">+${f.referenceTo.length - 6}</span>` : ""}</div>`
                : "";
              return `<div class="sch-f ${f.custom ? "custom" : ""}" data-f="${esc(f.name)}">
                <div class="sch-f-main">
                  <b>${highlight(f.label, q)}</b>
                  <span class="sch-f-api">${highlight(f.name, q)}<button type="button" class="sch-copy" data-copy="${esc(f.name)}" title="${esc(L("Copiar nombre de API", "Copy API name"))}">${icon("copy")}</button></span>
                  ${targets}
                </div>
                <div class="sch-f-side"><span class="sch-type ${isRef(f) ? "ref" : ""}" title="${esc(fieldType(f))}">${highlight(fieldType(f), q)}</span>${flags ? `<span class="sch-flags">${flags}</span>` : ""}</div>
              </div>`;
            })
            .join("")
        : none;
      return;
    }
    const { parents, children } = this.relationsOf(d);
    const ps = parents.filter((f) => match(f.name, f.label, ...f.referenceTo));
    const cs = children.filter((c) => match(c.childSObject, c.field, c.relationshipName));
    box.innerHTML = `
      <div class="sch-sec">${esc(L("Padres · lookups de este objeto", "Parents · this object's lookups"))} <b>${ps.length}</b></div>
      ${
        ps.length
          ? ps
              .map(
                (f) => `<div class="sch-rel ${isMD(f) ? "md" : ""}"><span class="sch-rel-field">${highlight(f.name, q)}</span><span class="sch-rel-arrow">${icon(
                  "chevron-right"
                )}</span>${f.referenceTo.slice(0, 6).map((t) => this.chip(t)).join("")}${f.referenceTo.length > 6 ? `<span class="sch-more">+${f.referenceTo.length - 6}</span>` : ""}<span class="sch-rel-kind">${
                  isMD(f) ? "Master-Detail" : "Lookup"
                }</span></div>`
              )
              .join("")
          : none
      }
      <div class="sch-sec">${esc(L(`Hijos · objetos que apuntan a ${this.panelObj}`, `Children · objects pointing to ${this.panelObj}`))} <b>${cs.length}</b></div>
      ${
        cs.length
          ? cs
              .map(
                (c) => `<div class="sch-rel ${c.cascadeDelete ? "md" : ""}">${this.chip(c.childSObject)}<span class="sch-rel-field">.${highlight(c.field, q)}</span>${
                  c.relationshipName ? `<span class="sch-rel-kind">${highlight(c.relationshipName, q)}</span>` : ""
                }</div>`
              )
              .join("")
          : none
      }`;
  }

  onPanelClick(e) {
    const tab = e.target.closest("[data-tab]");
    if (tab) {
      this.panelTab = tab.dataset.tab;
      this.panelQ = "";
      return this.renderPanel();
    }
    const add = e.target.closest("[data-add]");
    if (add) {
      const o = add.dataset.add;
      if (this.nodes.has(o)) return this.centerOn(o);
      return this.addObject(o, { near: this.panelObj }).then(() => this.panelObj && !this.form && this.renderPanelList());
    }
    const copy = e.target.closest("[data-copy]");
    if (copy) return copyText(copy.dataset.copy);
    const b = e.target.closest("[data-p]");
    if (!b || b.disabled) return;
    const act = b.dataset.p;
    if (act === "close") this.select(null);
    if (act === "expand") this.expand(this.panelObj);
    if (act === "data") {
      const name = this.panelObj;
      this.close();
      this.ctx.goToData(name);
    }
    if (act === "new-field") {
      this.form = { type: "Text", label: "", name: "", nameTouched: false, length: 255, visibleLines: 5, digits: 16, decimals: 2, required: false, fls: true, values: "" };
      this.renderPanel();
      this.el.panel.querySelector('[name="label"]')?.focus();
    }
    if (act === "cancel-form" && !this.form?.busy) {
      this.form = null;
      this.renderPanel();
    }
  }

  // ───────────────────────────────────────── Crear campo
  formHtml(meta, d) {
    const s = this.form;
    const t = s.type;
    const num = (name, label, value, min, max) =>
      `<label class="ide-fld"><span>${esc(label)}</span><input type="number" name="${name}" value="${esc(value)}" min="${min}" max="${max}"></label>`;
    const check = (name, label, on, extra = "") => `<label class="ide-check plain"><input type="checkbox" name="${name}" ${on ? "checked" : ""} ${extra}><span>${esc(label)}</span></label>`;
    const specific = {
      Text: `<div class="sch-row2">${num("length", L("Longitud", "Length"), s.length, 1, 255)}</div>
        <div class="sch-checks">${check("unique", L("Único", "Unique"), s.unique)}${check("externalId", "External ID", s.externalId)}</div>`,
      LongTextArea: `<div class="sch-row2">${num("length", L("Longitud", "Length"), s.length > 255 ? s.length : 32768, 256, 131072)}${num(
        "visibleLines",
        L("Líneas visibles", "Visible lines"),
        s.visibleLines,
        2,
        50
      )}</div>`,
      Number: `<div class="sch-row2">${num("digits", L("Dígitos enteros", "Integer digits"), s.digits, 1, 18)}${num("decimals", L("Decimales", "Decimal places"), s.decimals, 0, 17)}</div>`,
      Checkbox: `<div class="sch-checks">${check("defaultChecked", L("Marcado por defecto", "Checked by default"), s.defaultChecked)}</div>`,
      Picklist: `<label class="ide-fld"><span>${esc(L("Valores", "Values"))} <em>${esc(L("(uno por línea)", "(one per line)"))}</em></span><textarea name="values" rows="5" placeholder="${esc(
        L("Nuevo\nEn curso\nCerrado", "New\nIn progress\nClosed")
      )}">${esc(s.values || "")}</textarea></label>`,
      Lookup: `<label class="ide-fld"><span>${esc(L("Objeto relacionado", "Related object"))}</span><input name="referenceTo" list="sch-objects" value="${esc(
        s.referenceTo || ""
      )}" placeholder="Account" spellcheck="false" autocomplete="off"><datalist id="sch-objects">${[...this.objects.keys()]
        .sort()
        .map((o) => `<option value="${esc(o)}"></option>`)
        .join("")}</datalist></label>
        <div class="sch-row2">
          <label class="ide-fld"><span>${esc(L("Nombre de la relación hija", "Child relationship name"))}</span><input name="relationshipName" value="${esc(s.relationshipName || "")}" placeholder="${esc(
            L("automático", "automatic")
          )}" spellcheck="false" autocomplete="off"></label>
          <label class="ide-fld"><span>${esc(L("Etiqueta de la lista relacionada", "Related list label"))}</span><input name="relationshipLabel" value="${esc(s.relationshipLabel || "")}" placeholder="${esc(
            meta.plural || meta.label
          )}" autocomplete="off"></label>
        </div>`,
    };
    specific.Currency = specific.Number;
    specific.Percent = specific.Number;
    const canReq = CAN_REQUIRE.has(t);
    const prod = this.ctx.orgKindKey === "prod";
    return `<form class="sch-form" novalidate>
      <div class="sch-form-head">
        <button type="button" class="icon-btn" data-p="cancel-form" title="${esc(L("Volver a los campos", "Back to fields"))}">${icon("arrow-left")}</button>
        <div><h4>${esc(L("Nuevo campo", "New field"))}</h4><p>${esc(L(`en ${meta.label} (${this.panelObj})`, `on ${meta.label} (${this.panelObj})`))}</p></div>
      </div>
      <label class="ide-fld"><span>${esc(L("Tipo de dato", "Data type"))}</span><select name="type">${FIELD_TYPES.map(
        (k) => `<option value="${k}" ${k === t ? "selected" : ""}>${esc(TYPE_LABEL[k])}</option>`
      ).join("")}</select></label>
      <label class="ide-fld"><span>${esc(L("Etiqueta", "Label"))}</span><input name="label" value="${esc(s.label)}" maxlength="40" autocomplete="off" placeholder="${esc(
        L("Fecha de renovación", "Renewal date")
      )}"></label>
      <label class="ide-fld"><span>${esc(L("Nombre de API", "API name"))}</span><div class="sch-suffix"><input name="name" value="${esc(s.name)}" maxlength="40" spellcheck="false" autocomplete="off"><span>__c</span></div></label>
      ${specific[t] || ""}
      ${canReq ? `<div class="sch-checks">${check("required", L("Obligatorio", "Required"), s.required)}</div>` : ""}
      <label class="ide-fld"><span>${esc(L("Texto de ayuda", "Help text"))} <em>${esc(L("(opcional)", "(optional)"))}</em></span><input name="help" value="${esc(s.help || "")}" maxlength="255" autocomplete="off"></label>
      <label class="ide-fld"><span>${esc(L("Descripción", "Description"))} <em>${esc(L("(opcional)", "(optional)"))}</em></span><textarea name="description" rows="2">${esc(s.description || "")}</textarea></label>
      <div class="sch-fls">
        ${check("fls", L("Dar acceso de lectura y edición a mi perfil", "Give read and edit access to my profile"), s.fls && !s.required, s.required ? "disabled" : "")}
        <p>${esc(
          s.required
            ? L("Los campos obligatorios son visibles para todos: no necesitan acceso por perfil.", "Required fields are visible to everyone: they don't need profile access.")
            : L(
                "Salesforce crea los campos sin acceso (FLS). Sin esto no podrás verlo ni aquí ni en tus registros; otros perfiles se configuran en Setup.",
                "Salesforce creates fields without access (FLS). Without this you won't see it here or on your records; other profiles are set up in Setup."
              )
        )}</p>
      </div>
      ${prod ? `<div class="ide-modal-note">${icon("alert-triangle")}<span>${esc(L("Estás en producción: el campo se crea inmediatamente.", "You're in production: the field is created immediately."))}</span></div>` : ""}
      <div class="sch-form-foot">
        <div class="ide-modal-err hidden" data-err></div>
        <div class="sch-form-btns">
          <button type="button" class="ghost-btn" data-p="cancel-form">${esc(L("Cancelar", "Cancel"))}</button>
          <button type="submit" class="primary-btn sm">${icon("plus")}<span>${esc(L("Crear campo", "Create field"))}</span></button>
        </div>
      </div>
    </form>`;
  }

  captureForm() {
    const form = this.el.panel.querySelector("form");
    if (!form || !this.form) return;
    const fd = new FormData(form);
    const s = this.form;
    const str = (k) => (fd.has(k) ? String(fd.get(k)).trim() : undefined);
    const int = (k) => (fd.has(k) ? Number.parseInt(fd.get(k), 10) : undefined);
    const bool = (k) => (form.querySelector(`[name="${k}"]`) ? fd.get(k) === "on" : undefined);
    const set = (k, v) => v !== undefined && (s[k] = v);
    set("type", str("type"));
    set("label", str("label"));
    set("name", str("name"));
    set("length", int("length"));
    set("visibleLines", int("visibleLines"));
    set("digits", int("digits"));
    set("decimals", int("decimals"));
    set("unique", bool("unique"));
    set("externalId", bool("externalId"));
    set("defaultChecked", bool("defaultChecked"));
    set("required", bool("required"));
    const fls = form.querySelector('[name="fls"]');
    if (fls && !fls.disabled) s.fls = fls.checked;
    set("values", fd.has("values") ? String(fd.get("values")) : undefined);
    set("referenceTo", str("referenceTo"));
    set("relationshipName", str("relationshipName"));
    set("relationshipLabel", str("relationshipLabel"));
    set("help", str("help"));
    set("description", str("description"));
    if (s.type === "LongTextArea" && !(s.length > 255)) s.length = 32768;
    if (s.type === "Text" && s.length > 255) s.length = 255;
    if (!CAN_REQUIRE.has(s.type)) s.required = false;
  }

  validateForm(s, d) {
    if (!s.label) return [L("Escribe una etiqueta.", "Enter a label."), "label"];
    const ne = validateApiName(s.name);
    if (ne) return [NAME_ERROR[ne], "name"];
    if (d.fields.some((f) => f.name.toLowerCase() === `${s.name}__c`.toLowerCase()))
      return [L(`${this.panelObj} ya tiene un campo ${s.name}__c.`, `${this.panelObj} already has a ${s.name}__c field.`), "name"];
    const bad = (v, a, b) => !Number.isInteger(v) || v < a || v > b;
    switch (s.type) {
      case "Text":
        if (bad(s.length, 1, 255)) return [L("La longitud debe estar entre 1 y 255.", "The length must be between 1 and 255."), "length"];
        break;
      case "LongTextArea":
        if (bad(s.length, 256, 131072)) return [L("La longitud debe estar entre 256 y 131.072.", "The length must be between 256 and 131,072."), "length"];
        if (bad(s.visibleLines, 2, 50)) return [L("Las líneas visibles deben estar entre 2 y 50.", "Visible lines must be between 2 and 50."), "visibleLines"];
        break;
      case "Number":
      case "Currency":
      case "Percent":
        if (bad(s.digits, 1, 18) || bad(s.decimals, 0, 17) || s.digits + s.decimals > 18)
          return [L("Dígitos enteros + decimales no pueden superar 18.", "Integer digits + decimal places can't exceed 18."), "digits"];
        break;
      case "Picklist": {
        if (!s.values.length) return [L("Agrega al menos un valor.", "Add at least one value."), "values"];
        const seen = new Set();
        for (const v of s.values) {
          if (v.length > 255) return [L(`El valor «${v.slice(0, 30)}…» supera 255 caracteres.`, `The value “${v.slice(0, 30)}…” exceeds 255 characters.`), "values"];
          if (seen.has(v.toLowerCase())) return [L(`El valor «${v}» está repetido.`, `The value “${v}” is repeated.`), "values"];
          seen.add(v.toLowerCase());
        }
        break;
      }
      case "Lookup":
        if (!s.referenceTo) return [L("Elige el objeto relacionado.", "Pick the related object."), "referenceTo"];
        if (!this.objects.has(s.referenceTo)) return [L(`No se encontró el objeto ${s.referenceTo}.`, `Object ${s.referenceTo} wasn't found.`), "referenceTo"];
        if (validateApiName(s.relationshipName))
          return [L("Nombre de la relación hija: solo letras, números y «_», empezando con una letra.", "Child relationship name: letters, numbers and “_”, starting with a letter."), "relationshipName"];
        break;
    }
    return null;
  }

  showFormError(message, field) {
    const box = this.el.panel.querySelector("[data-err]");
    if (!box) return;
    box.innerHTML = `${icon("alert")}<span>${esc(message)}</span>`;
    box.classList.remove("hidden");
    this.el.panel.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
    const input = field && this.el.panel.querySelector(`[name="${field}"]`);
    if (input) {
      input.classList.add("invalid");
      input.focus();
    } else box.scrollIntoView({ block: "nearest" });
  }

  async submitField(form) {
    if (!this.form || this.form.busy) return;
    this.captureForm();
    const obj = this.panelObj;
    const meta = this.meta(obj);
    const d = this.describes.get(obj);
    const s = {
      ...this.form,
      values: String(this.form.values || "")
        .split("\n")
        .map((v) => v.trim())
        .filter(Boolean),
    };
    if (s.type === "Lookup") {
      s.relationshipName ||= apiNameFrom(`${s.name}_${meta.plural || obj}`);
      s.relationshipLabel ||= meta.plural || meta.label;
    }
    const invalid = this.validateForm(s, d);
    if (invalid) return this.showFormError(...invalid);
    if (this.ctx.orgKindKey === "prod" && !confirm(L(`Estás en PRODUCCIÓN. ¿Crear ${obj}.${s.name}__c ahora?`, `You're in PRODUCTION. Create ${obj}.${s.name}__c now?`))) return;

    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span><span>${esc(L("Creando…", "Creating…"))}</span>`;
    this.form.busy = true;
    try {
      const fullName = await createField(this.ctx.api, obj, s);
      let flsError = null;
      if (s.fls && !s.required) {
        try {
          if (!this.ctx.userId) throw new Error(L("usuario desconocido", "unknown user"));
          await grantFieldAccess(this.ctx.api, this.ctx.userId, obj, fullName);
        } catch (e) {
          if (e.status === 401) throw e;
          flsError = friendlyError(e);
        }
      }
      this.form = null;
      this.ctx.api.invalidateDescribe(obj);
      this.describes.delete(obj);
      await this.loadDescribes([obj]);
      const created = this.describes.get(obj)?.fields?.find((f) => f.name.toLowerCase() === `${s.name}__c`.toLowerCase());
      this.panelTab = "fields";
      this.panelQ = "";
      this.refreshBodies();
      this.renderEdges();
      if (this.panelObj === obj) this.renderPanel({ field: created?.name });
      if (created) toast(L(`Campo ${fullName} creado`, `Field ${fullName} created`), "success");
      else
        toast(
          L(
            `Se creó ${fullName}, pero tu usuario no tiene acceso a él (FLS), por eso no aparece. Dale acceso desde Setup.`,
            `${fullName} was created, but your user has no access to it (FLS), so it isn't listed. Grant access in Setup.`
          ),
          "info",
          8000
        );
      if (flsError) toast(L(`No se pudo dar acceso a tu perfil: ${flsError}`, `Could not grant access to your profile: ${flsError}`), "error", 8000);
      if (this.ctx.metadata.def?.key === "CustomField") this.ctx.metadata.sync({ manual: false });
    } catch (e) {
      if (e.status === 401) return this.ctx.sessionExpired();
      if (this.form) this.form.busy = false;
      btn.disabled = false;
      btn.innerHTML = `${icon("plus")}<span>${esc(L("Crear campo", "Create field"))}</span>`;
      this.showFormError(friendlyError(e));
    }
  }
}
