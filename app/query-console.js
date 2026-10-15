// Consola SOQL: queries manuales sobre data (REST) o metadata (Tooling API).
// Ejecuta en vivo mientras se escribe, colorea la sintaxis, autocompleta objetos y campos,
// guarda historial y permite exportar los records (solo en modo Data).
import { L, locale } from "../lib/i18n.js";
import { flattenRecord, columnsOf, cellText } from "../lib/export.js";
import { Combobox } from "./combobox.js";
import { ExportMenu } from "./export-menu.js";
import { $, icon, esc, toast, debounce, storage, friendlyError, copyText, animateCount } from "./ui.js";

const LIVE_DELAY = 650;
const HISTORY_KEY = "soqlHistory";
const ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const KEYWORDS =
  "SELECT FROM WHERE AND OR NOT IN LIKE INCLUDES EXCLUDES ORDER BY ASC DESC NULLS FIRST LAST LIMIT OFFSET GROUP HAVING WITH USING SCOPE TYPEOF WHEN THEN ELSE END NULL TRUE FALSE COUNT COUNT_DISTINCT SUM AVG MIN MAX FOR VIEW REFERENCE UPDATE ALL ROWS SECURITY_ENFORCED USER_MODE SYSTEM_MODE TODAY YESTERDAY TOMORROW LAST_N_DAYS NEXT_N_DAYS THIS_WEEK LAST_WEEK THIS_MONTH LAST_MONTH THIS_QUARTER THIS_YEAR LAST_YEAR CALENDAR_YEAR FISCAL_YEAR CONVERTCURRENCY TOLABEL FORMAT FIELDS STANDARD CUSTOM";
const KW_SET = new Set(KEYWORDS.split(" "));
const FIELD_CONTEXT = new Set(["select", "where", "and", "or", "by", "having", "not"]);

/** Colorea SOQL: palabras clave, strings, números y fechas. */
function highlightSoql(text) {
  const re = /('(?:\\.|[^'\\])*'?)|(\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?\b|\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w]*)|([(),=<>!*])/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    out += esc(text.slice(last, m.index));
    if (m[1]) out += `<span class="t-str">${esc(m[1])}</span>`;
    else if (m[2]) out += `<span class="t-num">${esc(m[2])}</span>`;
    else if (m[3]) out += KW_SET.has(m[3].toUpperCase()) ? `<span class="t-kw">${esc(m[3])}</span>` : esc(m[3]);
    else out += `<span class="t-op">${esc(m[4])}</span>`;
    last = re.lastIndex;
  }
  return out + esc(text.slice(last)) + "\n";
}

/** Una query "ejecutable": SELECT … FROM Objeto, comillas y paréntesis balanceados. */
function looksRunnable(q) {
  if (!/^\s*select\s[\s\S]*?\sfrom\s+[A-Za-z_]\w*/i.test(q)) return false;
  if ((q.replace(/\\'/g, "").match(/'/g) || []).length % 2) return false;
  return (q.match(/\(/g) || []).length === (q.match(/\)/g) || []).length;
}

const fromObject = (q) => /\bfrom\s+([A-Za-z_]\w*)/i.exec(q)?.[1] || null;

/** Formatea una query de una línea en varias, para leerla mejor. */
export function formatSoql(q) {
  return q
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(FROM|WHERE|GROUP BY|HAVING|ORDER BY|LIMIT|OFFSET)\s+/gi, "\n$1 ")
    .replace(/\s+(AND|OR)\s+/g, "\n  $1 ");
}

export class QueryConsole {
  constructor(ctx) {
    this.ctx = ctx;
    this.mode = "data"; // data | metadata
    this.tooling = true; // en modo metadata: Tooling API (o Data API para FlowDefinitionView, etc.)
    this.objects = { data: null, tooling: null };
    this.describes = new Map();
    this.records = [];
    this.token = 0;
    this.el = {
      root: $("#console"),
      panel: $("#console-panel"),
      sub: $("#q-sub"),
      modes: $("#q-modes"),
      slider: $("#q-modes .mode-slider"),
      toolingWrap: $("#q-tooling-wrap"),
      toolingBox: $("#q-tooling"),
      input: $("#q-input"),
      hl: $("#q-hl"),
      suggest: $("#q-suggest"),
      live: $("#q-live"),
      state: $("#q-state"),
      run: $("#q-run"),
      count: $("#q-count"),
      exportHost: $("#q-export"),
      historyBtn: $("#q-history-btn"),
      historyWrap: $("#q-history"),
      historyList: $("#q-history-list"),
      scroll: $("#q-scroll"),
      thead: $("#q-thead"),
      tbody: $("#q-tbody"),
      empty: $("#q-empty"),
      foot: $("#q-foot"),
    };
    this.picker = new Combobox($("#q-object"), {
      size: "sm",
      leadingIcon: "box",
      placeholder: L("Objeto del FROM…", "FROM object…"),
      onSelect: (it) => it && this.useObject(it.value),
    });
    this.exporter = new ExportMenu(this.el.exportHost, {
      api: ctx.api,
      getQuery: () => (this.lastSoql ? { soql: this.lastSoql, baseName: fromObject(this.lastSoql) || "records" } : null),
    });
    this.runLive = debounce(() => this.run({ live: true }), LIVE_DELAY);
    this.bind();
  }

  get isOpen() {
    return this.el.root.classList.contains("open");
  }

  bind() {
    const el = this.el;
    $("#console-backdrop").addEventListener("click", () => this.close());
    $("#q-close").addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen && !this.ctx.record?.isOpen && !e.target.closest?.(".combo")) {
        e.stopPropagation();
        this.close();
      }
    });
    el.modes.addEventListener("click", (e) => {
      const b = e.target.closest("[data-qmode]");
      if (b && b.dataset.qmode !== this.mode) this.setMode(b.dataset.qmode, { tooling: b.dataset.qmode === "metadata" });
    });
    el.toolingBox.addEventListener("change", () => {
      this.tooling = el.toolingBox.checked;
      this.loadObjects();
      this.run({ live: true });
    });

    el.input.addEventListener("input", () => this.onInput());
    el.input.addEventListener("scroll", () => (el.hl.scrollTop = el.input.scrollTop));
    el.input.addEventListener("click", () => this.updateSuggestions());
    el.input.addEventListener("keyup", (e) => ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) && this.updateSuggestions());
    el.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.run({ save: true });
      } else if (e.key === "Tab" && this.suggestions?.length) {
        e.preventDefault();
        this.accept(this.suggestions[0].value);
      }
    });
    el.suggest.addEventListener("mousedown", (e) => e.preventDefault());
    el.suggest.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-sug]");
      if (chip) this.accept(chip.dataset.sug);
    });
    el.live.addEventListener("change", () => el.live.checked && this.run({ live: true }));
    el.run.addEventListener("click", () => this.run({ save: true }));

    el.historyBtn.addEventListener("click", () => {
      el.historyWrap.classList.toggle("open");
      if (el.historyWrap.classList.contains("open")) this.renderHistory();
    });
    document.addEventListener("mousedown", (e) => !el.historyWrap.contains(e.target) && el.historyWrap.classList.remove("open"));
    el.historyList.addEventListener("click", (e) => {
      const item = e.target.closest("[data-h]");
      if (!item) return;
      const h = this.history[Number(item.dataset.h)];
      el.historyWrap.classList.remove("open");
      this.setMode(h.mode, { tooling: h.tooling, silent: true });
      this.setQuery(h.soql);
      this.run();
    });

    el.tbody.addEventListener("click", (e) => {
      const id = e.target.closest("[data-open-id]");
      if (id) return this.ctx.record.open(id.dataset.obj, id.dataset.openId);
      const copy = e.target.closest("[data-copy]");
      if (copy) copyText(copy.dataset.copy);
    });
    el.foot.addEventListener("click", (e) => e.target.closest("[data-more]") && this.loadMore());
  }

  // ───────────────────────────────────────── Abrir / modos
  /** soql y modo opcionales: el FROM llega pre-cargado desde la vista actual. */
  open({ soql, mode = "data", tooling } = {}) {
    this.setMode(mode, { tooling: tooling ?? mode === "metadata", silent: true });
    if (soql) this.setQuery(formatSoql(soql));
    this.el.root.classList.remove("hidden");
    requestAnimationFrame(() => {
      this.el.root.classList.add("open");
      this.positionSlider();
    });
    setTimeout(() => this.el.input.focus(), 120);
    this.run();
  }

  close() {
    this.el.root.classList.remove("open");
    setTimeout(() => !this.isOpen && this.el.root.classList.add("hidden"), 380);
  }

  setMode(mode, { tooling, silent = false } = {}) {
    this.mode = mode;
    this.tooling = mode === "metadata" ? tooling ?? true : false;
    this.el.modes.querySelectorAll("[data-qmode]").forEach((b) => b.classList.toggle("active", b.dataset.qmode === mode));
    this.positionSlider();
    this.el.toolingWrap.classList.toggle("hidden", mode !== "metadata");
    this.el.toolingBox.checked = this.tooling;
    this.el.exportHost.classList.toggle("hidden", mode !== "data"); // exportar: solo records
    this.el.sub.textContent =
      mode === "data"
        ? L("Records vía REST API · respeta tus permisos", "Records via REST API · respects your permissions")
        : L("Metadata vía Tooling API · solo lectura", "Metadata via Tooling API · read only");
    this.loadObjects();
    if (!silent) {
      const obj = fromObject(this.el.input.value);
      if (!obj || !this.objectExists(obj)) this.setQuery("");
      this.run({ live: true });
    }
  }

  positionSlider() {
    const active = this.el.modes.querySelector(".active");
    if (!active || !active.offsetWidth) return;
    this.el.slider.style.width = `${active.offsetWidth}px`;
    this.el.slider.style.transform = `translateX(${active.offsetLeft - 5}px)`;
  }

  get apiKey() {
    return this.tooling ? "tooling" : "data";
  }

  async loadObjects() {
    const key = this.apiKey;
    try {
      if (!this.objects[key]) {
        const all = key === "tooling" ? await this.ctx.api.describeGlobalTooling() : await this.ctx.api.describeGlobal();
        this.objects[key] = all.filter((s) => s.queryable).sort((a, b) => a.name.localeCompare(b.name));
      }
      if (key !== this.apiKey) return;
      this.picker.setItems(this.objects[key].map((s) => ({ value: s.name, label: s.name, sublabel: s.label !== s.name ? s.label : "", meta: s.keyPrefix || "" })));
      this.syncPicker();
    } catch (e) {
      toast(friendlyError(e), "error");
    }
  }

  objectExists(name) {
    return !!this.objects[this.apiKey]?.some((s) => s.name.toLowerCase() === String(name).toLowerCase());
  }

  async describe(name) {
    const key = `${this.apiKey}:${name.toLowerCase()}`;
    if (!this.describes.has(key)) {
      const p = (this.tooling ? this.ctx.api.describeTooling(name) : this.ctx.api.describe(name)).catch((e) => {
        this.describes.delete(key);
        throw e;
      });
      this.describes.set(key, p);
    }
    return this.describes.get(key);
  }

  /** Elegir un objeto escribe una query por defecto con su FROM. */
  async useObject(name) {
    let fields = ["Id"];
    try {
      const d = await this.describe(name);
      const has = (f) => d.fields.some((x) => x.name === f);
      const nameField = d.fields.find((f) => f.nameField)?.name || ["DeveloperName", "Name", "MasterLabel", "ApiName"].find(has);
      fields = ["Id", nameField, has("LastModifiedDate") && "LastModifiedDate"].filter(Boolean);
      if (!has("Id")) fields = [d.fields[0].name];
      const order = has("LastModifiedDate") ? " ORDER BY LastModifiedDate DESC" : "";
      this.setQuery(`SELECT ${[...new Set(fields)].join(", ")}\nFROM ${name}${order}`);
    } catch {
      this.setQuery(`SELECT Id\nFROM ${name}`);
    }
    this.el.input.focus();
    this.run({ live: true });
  }

  setQuery(q) {
    this.el.input.value = q;
    this.renderHighlight();
    this.syncPicker();
    this.updateSuggestions();
  }

  syncPicker() {
    const obj = fromObject(this.el.input.value);
    const match = obj && this.objects[this.apiKey]?.find((s) => s.name.toLowerCase() === obj.toLowerCase());
    if (match && this.picker.value !== match.name) this.picker.setValue(match.name);
    if (!obj && this.picker.value) this.picker.clear();
  }

  onInput() {
    this.renderHighlight();
    this.syncPicker();
    this.updateSuggestions();
    if (this.el.live.checked) this.runLive();
  }

  renderHighlight() {
    this.el.hl.innerHTML = highlightSoql(this.el.input.value);
    this.el.hl.scrollTop = this.el.input.scrollTop;
  }

  // ───────────────────────────────────────── Autocompletado
  tokenAtCaret() {
    const input = this.el.input;
    const before = input.value.slice(0, input.selectionStart);
    const token = /[\w.]*$/.exec(before)[0];
    const prefix = before.slice(0, before.length - token.length);
    const prevWord = (/([A-Za-z_]+)\s*$/.exec(prefix)?.[1] || "").toLowerCase();
    const prevChar = prefix.trimEnd().slice(-1);
    return { token, prevWord, prevChar };
  }

  async updateSuggestions() {
    const { token, prevWord, prevChar } = this.tokenAtCaret();
    const t = token.toLowerCase();
    let items = [];
    if (prevWord === "from") {
      items = (this.objects[this.apiKey] || [])
        .filter((s) => !t || s.name.toLowerCase().includes(t))
        .sort((a, b) => a.name.toLowerCase().startsWith(t) ? -1 : b.name.toLowerCase().startsWith(t) ? 1 : 0)
        .slice(0, 14)
        .map((s) => ({ value: s.name, label: s.name, sub: s.label !== s.name ? s.label : "" }));
    } else {
      const obj = fromObject(this.el.input.value);
      const inFieldSpot = t || FIELD_CONTEXT.has(prevWord) || prevChar === ",";
      if (obj && inFieldSpot && this.objectExists(obj)) {
        try {
          const d = await this.describe(obj);
          const base = t.includes(".") ? t.slice(t.lastIndexOf(".") + 1) : t;
          items = d.fields
            .filter((f) => !base || f.name.toLowerCase().includes(base) || f.label.toLowerCase().includes(base))
            .sort((a, b) => (a.name.toLowerCase().startsWith(base) ? -1 : b.name.toLowerCase().startsWith(base) ? 1 : a.name.localeCompare(b.name)))
            .slice(0, 14)
            .map((f) => ({ value: t.includes(".") ? token.slice(0, token.lastIndexOf(".") + 1) + f.name : f.name, label: f.name, sub: f.label }));
        } catch {
          items = [];
        }
      }
      if (t.length >= 2) {
        const kws = [...KW_SET].filter((k) => k.toLowerCase().startsWith(t) && k.toLowerCase() !== t).slice(0, 4);
        items.push(...kws.map((k) => ({ value: k, label: k, sub: "", kw: true })));
      }
    }
    // no sugerir lo que ya está escrito completo
    this.suggestions = items.filter((s) => s.value.toLowerCase() !== t);
    this.el.suggest.innerHTML = this.suggestions.length
      ? `<span class="q-sug-hint">${esc(L("Tab para completar", "Tab to complete"))}</span>` +
        this.suggestions
          .map(
            (s, i) =>
              `<button type="button" class="q-sug ${i === 0 ? "first" : ""} ${s.kw ? "kw" : ""}" data-sug="${esc(s.value)}" title="${esc(s.sub || s.label)}">${esc(s.label)}${
                s.sub ? `<span>${esc(s.sub)}</span>` : ""
              }</button>`
          )
          .join("")
      : "";
  }

  accept(value) {
    const input = this.el.input;
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const token = /[\w.]*$/.exec(before)[0];
    const start = pos - token.length;
    input.setRangeText(value + " ", start, pos, "end");
    input.focus();
    this.onInput();
  }

  // ───────────────────────────────────────── Ejecución
  async run({ live = false, save = false } = {}) {
    const raw = this.el.input.value.trim().replace(/;\s*$/, "");
    if (!raw) {
      this.setState("idle", L("Escribe una query SOQL o elige un objeto", "Type a SOQL query or pick an object"));
      return;
    }
    if (live && !looksRunnable(raw)) {
      this.setState("idle", L("Sigue escribiendo… (SELECT campos FROM Objeto)", "Keep typing… (SELECT fields FROM Object)"));
      return;
    }
    this.abort?.abort();
    this.abort = new AbortController();
    const token = ++this.token;
    const soql = raw.replace(/\s+/g, " ");
    const tooling = this.tooling;
    const mode = this.mode;
    this.setState("running", L("Ejecutando…", "Running…"));
    const t0 = performance.now();
    try {
      const res = await this.ctx.api.query(soql, { tooling, batchSize: 200, signal: this.abort.signal });
      if (token !== this.token) return;
      const ms = Math.round(performance.now() - t0);
      this.lastSoql = soql;
      this.lastTooling = tooling;
      this.records = res.records;
      this.total = res.totalSize;
      this.next = res.done ? null : res.nextRecordsUrl;
      this.queryObject = fromObject(soql);
      this.renderResults();
      this.setState("ok", L(`${this.total.toLocaleString(locale)} filas · ${ms} ms`, `${this.total.toLocaleString(locale)} rows · ${ms} ms`));
      if (save) this.saveHistory(raw, mode, tooling);
    } catch (e) {
      if (e.name === "AbortError" || token !== this.token) return;
      if (e.status === 401) return this.ctx.sessionExpired();
      this.setState("error", friendlyError(e));
      this.el.scroll.classList.add("stale");
    }
  }

  setState(kind, text) {
    const ic = { running: '<span class="spinner"></span>', ok: icon("check-circle"), error: icon("alert-triangle"), idle: icon("info") }[kind];
    this.el.state.className = `q-state ${kind}`;
    this.el.state.innerHTML = `${ic}<span>${esc(text)}</span>`;
    this.el.run.disabled = kind === "running";
  }

  async loadMore() {
    if (!this.next || this.loadingMore) return;
    this.loadingMore = true;
    const token = this.token;
    try {
      const res = await this.ctx.api.more(this.next);
      if (token !== this.token) return;
      this.records.push(...res.records);
      this.next = res.done ? null : res.nextRecordsUrl;
      this.renderResults(true);
    } catch (e) {
      toast(friendlyError(e), "error");
    } finally {
      this.loadingMore = false;
    }
  }

  renderResults(append = false) {
    const el = this.el;
    el.scroll.classList.remove("stale");
    const rows = this.records.map((r) => flattenRecord(r));
    const cols = columnsOf(rows);
    animateCount(el.count, this.total);
    el.thead.innerHTML = cols.length ? `<tr><th class="q-num">#</th>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>` : "";
    const canOpen = this.mode === "data" && !this.lastTooling && this.queryObject;
    el.tbody.classList.toggle("no-anim", append);
    el.tbody.innerHTML = rows
      .map(
        (r, i) =>
          `<tr style="--i:${Math.min(i, 20)}"><td class="q-num">${i + 1}</td>${cols
            .map((c) => {
              const v = r[c];
              if (v === null || v === undefined) return '<td><span class="dash">—</span></td>';
              if (typeof v === "boolean") return `<td><span class="bool ${v ? "on" : ""}">${icon(v ? "check" : "x")}</span></td>`;
              const text = cellText(v);
              if (c === "Id" && canOpen && ID_RE.test(text)) {
                return `<td><button class="ref-link q-id" data-open-id="${esc(text)}" data-obj="${esc(this.queryObject)}" title="${esc(
                  L("Ver y editar todos los campos", "View and edit all fields")
                )}">${icon("eye")}<span>${esc(text)}</span></button></td>`;
              }
              if (Array.isArray(v)) return `<td><span class="chip" title="${esc(text)}">${v.length} ${esc(L("registros", "records"))}</span></td>`;
              const shown = text.length > 140 ? text.slice(0, 139) + "…" : text;
              return `<td title="${esc(text.length > 140 ? text : "")}" data-copy="${esc(text)}">${esc(shown)}</td>`;
            })
            .join("")}</tr>`
      )
      .join("");
    el.empty.innerHTML = rows.length
      ? ""
      : `<div class="empty"><div class="e-ico">${icon("inbox")}</div><h3>${esc(L("La query no devolvió filas", "The query returned no rows"))}</h3></div>`;
    el.foot.innerHTML = rows.length
      ? `<span>${L("Mostrando", "Showing")} <b>${rows.length.toLocaleString(locale)}</b> ${L("de", "of")} <b>${(this.total || 0).toLocaleString(locale)}</b></span>${
          this.next ? `<button class="ghost-btn sm" data-more>${icon("chevron-down")}<span>${esc(L("Cargar más", "Load more"))}</span></button>` : ""
        }<span class="hint">${esc(L("Click en una celda para copiarla", "Click a cell to copy it"))}</span>`
      : "";
  }

  // ───────────────────────────────────────── Historial
  async saveHistory(soql, mode, tooling) {
    const list = (await storage.get(HISTORY_KEY, [])).filter((h) => h.soql !== soql);
    list.unshift({ soql, mode, tooling, at: Date.now() });
    await storage.set(HISTORY_KEY, list.slice(0, 20));
  }

  async renderHistory() {
    this.history = await storage.get(HISTORY_KEY, []);
    this.el.historyList.innerHTML = this.history.length
      ? this.history
          .map(
            (h, i) => `<button type="button" class="q-h-item" data-h="${i}">
              <span class="q-h-mode ${h.mode}">${h.mode === "data" ? "Data" : "Meta"}</span>
              <code>${esc(h.soql.replace(/\s+/g, " ").slice(0, 160))}</code>
            </button>`
          )
          .join("")
      : `<div class="menu-loading">${esc(L("Todavía no hay queries guardadas. Se guardan al ejecutar con Ctrl+Enter o el botón.", "No saved queries yet. They are saved when you run with Ctrl+Enter or the button."))}</div>`;
  }
}
