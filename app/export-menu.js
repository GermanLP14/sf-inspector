// Botón "Exportar" con formatos. Solo se usa para records (Data API).
import { exportQuery } from "../lib/export.js";
import { L, locale } from "../lib/i18n.js";
import { icon, esc, toast, friendlyError } from "./ui.js";

const FORMATS = [
  ["xlsx", "sheet", L("Excel (.xlsx)", "Excel (.xlsx)"), L("Hoja de cálculo con encabezados y filtros", "Spreadsheet with headers and filters")],
  ["csv", "file-text", "CSV", L("Texto separado por comas (UTF-8)", "Comma-separated text (UTF-8)")],
  ["json", "braces", "JSON", L("Records completos, con relaciones", "Full records, including relationships")],
  ["tsv", "copy", L("Copiar como tabla", "Copy as table"), L("Para pegar en Excel o Google Sheets", "To paste into Excel or Google Sheets")],
];

export class ExportMenu {
  /** getQuery() → { soql, baseName } | null */
  constructor(host, { api, getQuery }) {
    this.api = api;
    this.getQuery = getQuery;
    this.busy = false;
    host.classList.add("export-menu");
    host.innerHTML = `
      <button type="button" class="ghost-btn exp-btn">${icon("download")}<span>${esc(L("Exportar", "Export"))}</span>${icon("chevron-down", "exp-caret")}</button>
      <div class="exp-pop" role="menu">
        ${FORMATS.map(
          ([k, ic, label, sub]) => `<button type="button" class="exp-item" data-format="${k}" role="menuitem">
            <span class="exp-ico">${icon(ic)}</span><span class="exp-text"><b>${esc(label)}</b><span>${esc(sub)}</span></span>
          </button>`
        ).join("")}
        <div class="exp-note">${icon("info")}<span>${esc(
          L("Se exportan todos los registros de la query (hasta 100.000), no solo los visibles.", "All records of the query are exported (up to 100,000), not only the visible ones.")
        )}</span></div>
      </div>`;
    this.host = host;
    this.btn = host.querySelector(".exp-btn");
    this.label = this.btn.querySelector("span");
    this.btn.addEventListener("click", () => !this.busy && host.classList.toggle("open"));
    document.addEventListener("mousedown", (e) => !host.contains(e.target) && host.classList.remove("open"));
    host.querySelector(".exp-pop").addEventListener("click", (e) => {
      const item = e.target.closest("[data-format]");
      if (item) this.run(item.dataset.format);
    });
  }

  async run(format) {
    const q = this.getQuery();
    this.host.classList.remove("open");
    if (!q?.soql) return toast(L("No hay una query para exportar", "There is no query to export"), "error");
    this.busy = true;
    this.host.classList.add("busy");
    const original = this.label.textContent;
    try {
      const res = await exportQuery(this.api, q.soql, format, {
        baseName: q.baseName,
        onProgress: (n, total) => (this.label.textContent = `${n.toLocaleString(locale)} / ${(total || n).toLocaleString(locale)}`),
      });
      const n = res.count.toLocaleString(locale);
      toast(
        format === "tsv"
          ? L(`${n} registros copiados: pégalos en tu hoja de cálculo`, `${n} records copied: paste them into your spreadsheet`)
          : L(`${n} registros exportados`, `${n} records exported`) + (res.truncated ? L(" (límite de 100.000 alcanzado)", " (100,000 limit reached)") : ""),
        "success",
        3500
      );
    } catch (e) {
      toast(friendlyError(e), "error");
    } finally {
      this.busy = false;
      this.host.classList.remove("busy");
      this.label.textContent = original;
    }
  }
}
