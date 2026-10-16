// Panel lateral con el detalle de conflictos de un componente de metadata.
import { getType } from "../lib/metadata-types.js";
import { $, icon, esc, copyText } from "./ui.js";
import { L } from "../lib/i18n.js";

export class ConflictDrawer {
  constructor(ctx) {
    this.ctx = ctx;
    this.root = $("#drawer");
    this.panel = $("#drawer-panel");
    this.body = $("#drawer-body");
    this.row = null;

    $("#drawer-close").addEventListener("click", () => this.close());
    $("#drawer-backdrop").addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen) {
        e.stopImmediatePropagation(); // que no cierre también el panel de abajo
        this.close();
      }
    });
    this.body.addEventListener("click", (e) => {
      const find = e.target.closest("[data-find-type]");
      if (find) {
        this.close();
        this.ctx.metadata.find(find.dataset.findType, find.dataset.findName);
        return;
      }
      const copy = e.target.closest("[data-copy]");
      if (copy) copyText(copy.dataset.copy);
    });
  }

  get isOpen() {
    return this.root.classList.contains("open");
  }

  open(row, def, analysis) {
    this.row = row;
    this.def = def;
    this.analysis = analysis;
    this.render();
    this.root.classList.remove("hidden");
    requestAnimationFrame(() => this.root.classList.add("open"));
    this.panel.scrollTop = 0;
  }

  /** Re-renderiza si el panel muestra esta fila (p. ej. cuando termina el análisis). */
  refresh(row, analysis) {
    if (this.isOpen && this.row === row) {
      this.analysis = analysis;
      this.render();
    }
  }

  close() {
    this.root.classList.remove("open");
    setTimeout(() => !this.isOpen && this.root.classList.add("hidden"), 350);
  }

  render() {
    const r = this.row;
    const def = this.def;
    const health = r.health || "pending";
    const issues = r.issues || [];
    const errors = issues.filter((i) => i.severity === "error").length;
    const warnings = issues.length - errors;
    const href = r.url ? this.ctx.url(r.url) : null;

    $("#drawer-head").innerHTML = `
      <div class="rh-ico" style="--c:${def.color}">${icon(def.icon)}</div>
      <div class="dh-title">
        <h3 title="${esc(r.name)}">${esc(r.name)}</h3>
        <p>${esc(def.label)}${r.object ? ` · ${esc(r.object)}` : ""}${r.label ? ` · ${esc(r.label)}` : ""}</p>
      </div>
      <div class="dh-actions">
        <button class="row-btn" data-copy="${esc(r.name)}" title="${esc(L("Copiar nombre", "Copy name"))}">${icon("copy")}</button>
        ${href ? `<a class="row-btn" data-sf href="${esc(href)}" title="${esc(L("Abrir en Salesforce", "Open in Salesforce"))}">${icon("external")}</a>` : ""}
      </div>`;

    let banner;
    if (health === "pending") {
      banner = `<div class="banner b-pending"><span class="spinner"></span><div><b>${L("Analizando conflictos…", "Analyzing conflicts…")}</b><span>${L("Revisando reglas y cruces con otra metadata de la org.", "Checking rules and cross-references with other metadata in the org.")}</span></div></div>`;
    } else if (health === "ok") {
      banner = `<div class="banner b-ok">${icon("check-circle")}<div><b>${L("Sin conflictos detectados", "No conflicts found")}</b><span>${L(`Pasó ${this.analysis?.checks.length || 0} verificaciones.`, `Passed ${this.analysis?.checks.length || 0} checks.`)}</span></div></div>`;
    } else {
      const parts = [
        errors && `${errors} ${errors === 1 ? L("conflicto", "conflict") : L("conflictos", "conflicts")}`,
        warnings && `${warnings} ${warnings === 1 ? L("advertencia", "warning") : L("advertencias", "warnings")}`,
      ].filter(Boolean);
      banner = `<div class="banner b-${health}">${icon("alert-triangle")}<div><b>${parts.join(" · ")}</b><span>${L("Revisa el detalle y las sugerencias de cada uno.", "Review the details and suggestions for each one.")}</span></div></div>`;
    }

    const issuesHtml = issues.map((it, i) => this.issueHtml(it, i)).join("");

    const checks = this.analysis
      ? `<details class="checks" ${health === "ok" ? "open" : ""}>
          <summary>${icon("shield-check")}${L("Verificaciones realizadas", "Checks performed")} (${this.analysis.checks.length})</summary>
          <ul>
            ${this.analysis.checks.map((c) => `<li>${icon("check")}${esc(c)}</li>`).join("")}
            ${this.analysis.skipped.map((s) => `<li class="skipped">${icon("x")}${esc(s.label)}<span>${L("No verificado", "Not checked")}: ${esc(s.reason)}</span></li>`).join("")}
          </ul>
        </details>`
      : "";

    this.body.innerHTML = `${banner}${issuesHtml}${checks}
      <p class="disclaimer">${icon("info")}${L(
      "Análisis basado en reglas sobre la metadata visible para tu usuario. Ayuda a detectar riesgos, pero no reemplaza una revisión del código o de la configuración.",
      "Rule-based analysis of the metadata visible to your user. It helps spot risks, but doesn't replace a review of the code or configuration."
    )}</p>`;
  }

  issueHtml(it, i) {
    const sev = it.severity === "error" ? "error" : "warning";
    const related = it.related.length
      ? `<div class="issue-sec">
          <div class="sec-title">${icon("split")}${L("Choca con", "Clashes with")}</div>
          <div class="rel-list">${it.related.map((rel) => this.relatedHtml(rel)).join("")}</div>
        </div>`
      : "";
    const fix = it.fix.length
      ? `<div class="issue-sec fix">
          <div class="sec-title">${icon("lightbulb")}${L("Cómo arreglarlo", "How to fix it")}</div>
          <ol>${it.fix.map((f) => `<li>${esc(f)}</li>`).join("")}</ol>
        </div>`
      : "";
    const note = it.note ? `<div class="issue-note">${icon("list")}<span>${esc(it.note)}</span></div>` : "";
    return `<article class="issue sev-${sev}" style="--i:${i}">
      <header>
        <span class="sev-ico">${icon("alert-triangle")}</span>
        <div><span class="sev-tag">${sev === "error" ? L("Conflicto", "Conflict") : L("Advertencia", "Warning")}</span><h4>${esc(it.title)}</h4></div>
      </header>
      <div class="issue-sec">
        <div class="sec-title">${icon("info")}${L("Por qué", "Why")}</div>
        <p>${esc(it.why)}</p>
        ${note}
      </div>
      ${related}
      ${fix}
    </article>`;
  }

  relatedHtml(rel) {
    const t = getType(rel.typeKey);
    const href = rel.url ? this.ctx.url(rel.url) : null;
    const meta = [t?.label, rel.object, rel.note].filter(Boolean).join(" · ");
    return `<div class="rel">
      <span class="rel-ico" style="--c:${t?.color || "var(--accent)"}">${icon(t?.icon || "box")}</span>
      <div class="rel-text"><b>${esc(rel.name)}</b><span>${esc(meta)}</span></div>
      <button class="row-btn" data-find-type="${esc(rel.typeKey)}" data-find-name="${esc(rel.name)}" title="${esc(L("Ver en OrgGadget", "Show in OrgGadget"))}">${icon("search")}</button>
      ${href ? `<a class="row-btn" data-sf href="${esc(href)}" title="${esc(L("Abrir en Salesforce", "Open in Salesforce"))}">${icon("external")}</a>` : ""}
    </div>`;
  }
}
