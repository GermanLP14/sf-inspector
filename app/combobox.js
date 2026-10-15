// Combobox con búsqueda (escribir para filtrar o elegir de la lista) y MultiSelect.
import { icon, esc, highlight } from "./ui.js";
import { L } from "../lib/i18n.js";

let uid = 0;

export class Combobox {
  /**
   * items: [{ value, label, sublabel?, icon?, color?, group?, meta?, keywords? }]
   * onSelect(item | null)
   */
  constructor(host, opts = {}) {
    this.opts = {
      placeholder: "",
      items: [],
      size: "md",
      leadingIcon: "search",
      emptyText: L("Sin resultados", "No results"),
      maxResults: 250,
      onSelect: () => {},
      // Búsqueda extra asíncrona: search(query, update) → update(items, { loading, text }) se puede llamar varias veces.
      search: null,
      searchMin: 2,
      ...opts,
    };
    this.extra = [];
    this.extraStatus = null;
    this.searchSeq = 0;
    this.items = this.opts.items;
    this.selected = null;
    this.visible = [];
    this.active = -1;
    this.isOpen = false;
    this.query = "";

    const id = `combo-${++uid}`;
    host.classList.add("combo", `combo-${this.opts.size}`);
    host.innerHTML = `
      <span class="combo-lead">${icon(this.opts.leadingIcon)}</span>
      <input class="combo-input" type="text" role="combobox" aria-expanded="false" aria-controls="${id}"
        aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="${esc(this.opts.placeholder)}">
      <button type="button" class="combo-clear hidden" tabindex="-1" title="${L("Limpiar", "Clear")}">${icon("x")}</button>
      <button type="button" class="combo-caret" tabindex="-1" title="${L("Ver lista", "Show list")}">${icon("chevron-down")}</button>
      <div class="combo-pop" id="${id}" role="listbox"></div>`;
    this.host = host;
    this.input = host.querySelector(".combo-input");
    this.pop = host.querySelector(".combo-pop");
    this.lead = host.querySelector(".combo-lead");
    this.clearBtn = host.querySelector(".combo-clear");
    this.caret = host.querySelector(".combo-caret");
    this.bind();
  }

  bind() {
    this.input.addEventListener("focus", () => {
      this.open("");
      requestAnimationFrame(() => this.input.select());
    });
    this.input.addEventListener("input", () => this.open(this.input.value));
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.input.addEventListener("blur", () => setTimeout(() => this.close(), 140));
    this.pop.addEventListener("mousedown", (e) => e.preventDefault());
    this.pop.addEventListener("click", (e) => {
      const opt = e.target.closest(".combo-opt");
      if (opt) this.choose(this.visible[Number(opt.dataset.i)]);
    });
    this.pop.addEventListener("mousemove", (e) => {
      const opt = e.target.closest(".combo-opt");
      if (opt && Number(opt.dataset.i) !== this.active) this.setActive(Number(opt.dataset.i), false);
    });
    this.clearBtn.addEventListener("mousedown", (e) => e.preventDefault());
    this.clearBtn.addEventListener("click", () => {
      this.clear(false);
      this.input.focus();
    });
    this.caret.addEventListener("mousedown", (e) => e.preventDefault());
    this.caret.addEventListener("click", () => {
      if (this.isOpen) this.close();
      else this.input.focus() || this.open("");
    });
  }

  onKey(e) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!this.isOpen) this.open(this.query);
        this.setActive(Math.min(this.visible.length - 1, this.active + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        this.setActive(Math.max(0, this.active - 1));
        break;
      case "Enter":
        if (this.isOpen && this.visible[this.active]) {
          e.preventDefault();
          this.choose(this.visible[this.active]);
        }
        break;
      case "Escape":
        if (this.isOpen) {
          e.preventDefault();
          this.close();
        } else if (this.selected) {
          this.clear(false);
        } else {
          this.input.blur();
        }
        break;
      case "Tab":
        this.close();
        break;
    }
  }

  filter(q) {
    const query = q.trim().toLowerCase();
    if (!query) return this.items.slice(0, this.opts.maxResults);
    const tokens = query.split(/\s+/);
    return this.items
      .map((it) => {
        const label = String(it.label).toLowerCase();
        const value = String(it.value).toLowerCase();
        const hay = `${label} ${value} ${it.sublabel || ""} ${it.keywords || ""}`.toLowerCase();
        if (!tokens.every((t) => hay.includes(t))) return null;
        let score = 0;
        if (label === query || value === query) score = 100;
        else if (label.startsWith(query) || value.startsWith(query)) score = 60;
        else if (label.includes(query) || value.includes(query)) score = 30;
        return { it, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || String(a.it.label).localeCompare(String(b.it.label)))
      .slice(0, this.opts.maxResults)
      .map((x) => x.it);
  }

  open(q) {
    const changed = q !== this.query || !this.isOpen;
    this.query = q;
    this.visible = this.compose(q);
    this.isOpen = true;
    if (changed) this.runSearch(q);
    this.host.classList.add("open");
    this.input.setAttribute("aria-expanded", "true");
    const selIdx = this.selected ? this.visible.findIndex((v) => v.value === this.selected.value) : -1;
    this.active = q ? 0 : Math.max(0, selIdx);
    this.render();
    this.scrollActive();
  }

  /** Coincidencias propias + resultados de la búsqueda extra (agrupados al final). */
  compose(q) {
    const own = this.filter(q);
    if (!this.opts.search || q.trim().length < this.opts.searchMin) return own;
    return [...own.slice(0, this.extra.length ? 6 : this.opts.maxResults), ...this.extra];
  }

  runSearch(q) {
    if (!this.opts.search) return;
    const seq = ++this.searchSeq;
    clearTimeout(this.searchTimer);
    this.extra = [];
    this.extraStatus = null;
    if (q.trim().length < this.opts.searchMin) return;
    this.extraStatus = { loading: true, text: L("Buscando…", "Searching…") };
    this.searchTimer = setTimeout(() => {
      this.opts.search(q.trim(), (items, status = null) => {
        if (seq !== this.searchSeq || !this.isOpen) return;
        this.extra = items.map((it) => ({ ...it, extra: true }));
        this.extraStatus = status;
        const activeValue = this.visible[this.active]?.value;
        this.visible = this.compose(this.query);
        const keep = this.visible.findIndex((v) => v.value === activeValue);
        this.active = keep >= 0 ? keep : Math.min(this.active, Math.max(0, this.visible.length - 1));
        this.render();
      });
    }, 220);
  }

  close() {
    if (!this.isOpen) return;
    this.searchSeq++;
    clearTimeout(this.searchTimer);
    this.isOpen = false;
    this.host.classList.remove("open");
    this.input.setAttribute("aria-expanded", "false");
    this.input.value = this.selected ? this.selected.label : "";
  }

  render() {
    const q = this.query.trim();
    const status = this.extraStatus
      ? `<div class="combo-status ${this.extraStatus.loading ? "loading" : ""}">${this.extraStatus.loading ? '<span class="spinner"></span>' : icon("info")}<span>${esc(this.extraStatus.text || "")}</span></div>`
      : "";
    if (!this.visible.length) {
      this.pop.innerHTML = this.extraStatus?.loading ? status : `<div class="combo-empty">${esc(this.opts.emptyText)}</div>${status}`;
      return;
    }
    let lastGroup = null;
    let html = "";
    this.visible.forEach((it, i) => {
      if ((!q || it.extra) && it.group && it.group !== lastGroup) {
        html += `<div class="combo-group">${esc(it.group)}</div>`;
        lastGroup = it.group;
      }
      const sel = this.selected && this.selected.value === it.value;
      html += `<div class="combo-opt ${i === this.active ? "active" : ""} ${sel ? "selected" : ""}" role="option" data-i="${i}" aria-selected="${sel}">
        ${it.icon ? `<span class="opt-ico" style="--c:${it.color || "var(--accent)"}">${icon(it.icon)}</span>` : ""}
        <span class="opt-text"><span class="opt-label">${highlight(it.label, q)}</span>${
          it.sublabel ? `<span class="opt-sub">${highlight(it.sublabel, q)}</span>` : ""
        }</span>
        ${it.meta !== undefined && it.meta !== "" ? `<span class="opt-meta">${esc(it.meta)}</span>` : ""}
        ${sel ? `<span class="opt-check">${icon("check")}</span>` : ""}
      </div>`;
    });
    const total = q ? null : this.items.length;
    if (total && total > this.visible.length) {
      html += `<div class="combo-more">${L(
        `Mostrando ${this.visible.length} de ${total}. Escribe para filtrar…`,
        `Showing ${this.visible.length} of ${total}. Type to filter…`
      )}</div>`;
    }
    const top = this.pop.scrollTop;
    this.pop.innerHTML = html + status;
    this.pop.scrollTop = top;
  }

  setActive(i, scroll = true) {
    this.active = i;
    this.pop.querySelectorAll(".combo-opt").forEach((el) => el.classList.toggle("active", Number(el.dataset.i) === i));
    if (scroll) this.scrollActive();
  }

  scrollActive() {
    this.pop.querySelector(".combo-opt.active")?.scrollIntoView({ block: "nearest" });
  }

  choose(item) {
    if (!item) return;
    if (item.extra) {
      // Un resultado de búsqueda no es «el valor» del combo: se delega y el combo queda como estaba.
      this.close();
      this.input.blur();
      return this.opts.onSelect(item);
    }
    this.applySelected(item);
    this.close();
    this.input.blur();
    this.opts.onSelect(item);
  }

  applySelected(item) {
    this.selected = item;
    this.input.value = item ? item.label : "";
    this.clearBtn.classList.toggle("hidden", !item);
    this.host.classList.toggle("has-value", !!item);
    if (item && item.icon) {
      this.lead.className = "combo-lead sel";
      this.lead.style.setProperty("--c", item.color || "var(--accent)");
      this.lead.innerHTML = icon(item.icon);
    } else {
      this.lead.className = "combo-lead";
      this.lead.style.removeProperty("--c");
      this.lead.innerHTML = icon(this.opts.leadingIcon);
    }
  }

  setItems(items) {
    this.items = items;
    if (this.selected) {
      const still = items.find((i) => i.value === this.selected.value);
      this.applySelected(still || null);
    }
    if (this.isOpen) this.open(this.query);
  }

  /** Selecciona un valor programáticamente. silent = no dispara onSelect. */
  setValue(value, silent = true) {
    const item = this.items.find((i) => i.value === value) || null;
    this.applySelected(item);
    if (!silent) this.opts.onSelect(item);
  }

  clear(silent = true) {
    const had = !!this.selected;
    this.applySelected(null);
    if (!silent && had) this.opts.onSelect(null);
  }

  get value() {
    return this.selected ? this.selected.value : null;
  }

  focus() {
    this.input.focus();
  }
}

export class MultiSelect {
  constructor(host, { placeholder = L("Todos los valores", "All values"), searchPlaceholder = L("Filtrar valores…", "Filter values…"), leadingIcon = null, onChange = () => {} } = {}) {
    this.placeholder = placeholder;
    this.onChange = onChange;
    this.options = [];
    this.values = new Set();
    host.classList.add("ms");
    host.innerHTML = `
      <button type="button" class="ms-btn">${leadingIcon ? icon(leadingIcon, "ms-lead") : ""}<span class="ms-label"></span>${icon("chevron-down", "ms-caret")}</button>
      <div class="ms-pop">
        <div class="ms-search">${icon("search")}<input type="text" placeholder="${esc(searchPlaceholder)}" spellcheck="false"></div>
        <div class="ms-list"></div>
        <div class="ms-foot"><button type="button" class="ms-clear">${L("Limpiar selección", "Clear selection")}</button><span class="ms-n"></span></div>
      </div>`;
    this.host = host;
    this.btn = host.querySelector(".ms-btn");
    this.label = host.querySelector(".ms-label");
    this.list = host.querySelector(".ms-list");
    this.search = host.querySelector(".ms-search input");
    this.btn.addEventListener("click", () => this.toggle());
    this.search.addEventListener("input", () => this.renderList());
    this.list.addEventListener("change", (e) => {
      const cb = e.target.closest("input[type=checkbox]");
      if (!cb) return;
      if (cb.checked) this.values.add(cb.value);
      else this.values.delete(cb.value);
      this.update(true);
    });
    host.querySelector(".ms-clear").addEventListener("click", () => {
      this.values.clear();
      this.renderList();
      this.update(true);
    });
    document.addEventListener("mousedown", (e) => {
      if (!host.contains(e.target)) host.classList.remove("open");
    });
    host.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        host.classList.remove("open");
        this.btn.focus();
      }
    });
    this.update(false);
  }

  toggle() {
    const open = !this.host.classList.contains("open");
    this.host.classList.toggle("open", open);
    if (open) {
      this.search.value = "";
      this.renderList();
      setTimeout(() => this.search.focus(), 30);
    }
  }

  setOptions(options, selected = []) {
    this.options = options;
    this.values = new Set(selected);
    this.renderList();
    this.update(false);
  }

  renderList() {
    const q = this.search.value.trim().toLowerCase();
    const opts = this.options.filter((o) => !q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
    this.list.innerHTML = opts.length
      ? opts
          .map(
            (o) => `<label class="ms-opt"><input type="checkbox" value="${esc(o.value)}" ${
              this.values.has(o.value) ? "checked" : ""
            }><span class="ms-box">${icon("check")}</span><span>${highlight(o.label, q)}</span></label>`
          )
          .join("")
      : `<div class="combo-empty">${L("Sin valores", "No values")}</div>`;
  }

  update(emit) {
    const n = this.values.size;
    const first = n === 1 ? this.options.find((o) => this.values.has(o.value)) : null;
    this.label.textContent = n === 0 ? this.placeholder : first ? first.label : L(`${n} seleccionados`, `${n} selected`);
    this.host.classList.toggle("has-value", n > 0);
    this.host.querySelector(".ms-n").textContent = `${n} / ${this.options.length}`;
    if (emit) this.onChange([...this.values]);
  }
}
