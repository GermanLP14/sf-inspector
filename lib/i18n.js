// Idioma de la interfaz (es / en). Se guarda en localStorage para poder leerlo de
// forma síncrona al cargar los módulos; cambiar el idioma recarga la página.

const KEY = "orglens.lang";

function detect() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "es" || v === "en") return v;
  } catch {
    /* sin localStorage (service worker): idioma por defecto */
  }
  return "en"; // idioma por defecto: inglés
}

export const lang = detect();
export const locale = lang === "en" ? "en-US" : "es";

/** Devuelve el texto en el idioma actual. */
export const L = (es, en) => (lang === "en" ? en : es);

/** "3 flows" / "1 flow" según el idioma. */
export const plural = (n, [es1, esN], [en1, enN]) => `${n} ${n === 1 ? L(es1, en1) : L(esN, enN)}`;

export const joinList = (arr) => {
  if (arr.length <= 1) return arr.join("");
  return `${arr.slice(0, -1).join(", ")} ${L("y", "and")} ${arr[arr.length - 1]}`;
};

export function setLang(value) {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* ignorar */
  }
}

/**
 * Traduce el HTML estático: el texto en español va en el HTML y la versión en inglés
 * en data-en / data-en-placeholder / data-en-title.
 */
export function translateStatic(root = document) {
  document.documentElement.lang = lang;
  if (lang !== "en") return;
  root.querySelectorAll("[data-en]").forEach((el) => (el.textContent = el.dataset.en));
  root.querySelectorAll("[data-en-placeholder]").forEach((el) => (el.placeholder = el.dataset.enPlaceholder));
  root.querySelectorAll("[data-en-title]").forEach((el) => (el.title = el.dataset.enTitle));
}
