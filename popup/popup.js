import { getSessionForHost, listSessions, isSessionAlive, describeHost, isSalesforceHost, lightningHost } from "../lib/session.js";
import { L, lang, setLang, translateStatic } from "../lib/i18n.js";
import { $, icon, esc, initials, hydrateIcons, storage, highlight } from "../app/ui.js";
import { DEFAULT_FAVS, FAV_SLOTS, GROUPS, SF_PAGES, catalog, favById, normalizeFavs } from "./favorites.js";

const state = { tab: null, current: null, onSalesforce: false, sessions: null, favs: DEFAULT_FAVS, favEdit: null };

init();

async function init() {
  const settings = await storage.get("settings", {});
  const dark = settings.theme ? settings.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  translateStatic();
  hydrateIcons();

  const langSelect = $("#pp-lang");
  langSelect.value = lang;
  langSelect.addEventListener("change", () => {
    setLang(langSelect.value);
    location.reload();
  });

  [state.tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let hostname = null;
  try {
    hostname = state.tab?.url ? new URL(state.tab.url).hostname : null;
  } catch {
    hostname = null;
  }
  state.onSalesforce = isSalesforceHost(hostname);
  state.current = state.onSalesforce ? await getSessionForHost(hostname) : null;
  state.favs = normalizeFavs((await chrome.storage.local.get("favShortcuts")).favShortcuts);
  render(); // se muestra enseguida; las sesiones se verifican con Salesforce y se actualiza

  // Solo se listan orgs cuya sesión sigue viva (la cookie puede quedar aunque la sesión haya expirado).
  const [currentAlive, sessions] = await Promise.all([state.current ? isSessionAlive(state.current) : null, listSessions()]);
  if (currentAlive === false) state.current = null;
  state.sessions = sessions.filter((s) => !state.current || s.orgId !== state.current.orgId);
  if (!state.favEdit) render();

  document.body.addEventListener("click", onClick);
  document.body.addEventListener("input", (e) => {
    if (e.target.matches("[data-fav-q]")) {
      state.favEdit.q = e.target.value;
      renderFavList();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (state.favEdit || !state.current || /^(SELECT|INPUT)$/.test(e.target.tagName)) return;
    if (e.key === "Enter") openExplorer(state.current.host);
    const fav = state.favs[Number(e.key) - 1];
    if (fav) openFav(state.current.host, fav);
  });
}

// ───────────────────────────────────────── Render
function render() {
  const main = $("#pp-main");
  if (state.favEdit) {
    main.innerHTML = favEditHtml();
    renderFavList();
    main.querySelector("[data-fav-q]")?.focus();
    return;
  }
  main.innerHTML = `
    <section class="pp-current">${currentHtml()}</section>
    <div class="pp-label">${esc(state.current ? L("Otras orgs con sesión activa", "Other orgs with an active session") : L("Orgs con sesión activa", "Orgs with an active session"))}</div>
    <div class="pp-list">${
      !state.sessions
        ? `<div class="pp-empty pp-checking"><span class="pp-spin"></span>${esc(L("Verificando sesiones…", "Checking sessions…"))}</div>`
        : state.sessions.length
        ? state.sessions
            .map(
              (s, i) => `<button class="pp-org" data-host="${esc(s.host)}" style="--i:${i}">
                <span class="pp-av">${esc(initials(s.name))}</span>
                <span class="pp-org-text"><b>${esc(s.name)}</b><span>${esc(s.host)}</span></span>
                <span class="kind kind-${s.kindKey}">${esc(s.kind)}</span>
                ${icon("chevron-right", "pp-go")}
              </button>`
            )
            .join("")
        : `<div class="pp-empty">${esc(
            state.current
              ? L("No hay otras sesiones.", "No other sessions.")
              : L("Inicia sesión en una org de Salesforce y vuelve a abrir este panel.", "Log in to a Salesforce org and open this panel again.")
          )}</div>`
    }</div>`;
}

function currentHtml() {
  const session = state.current;
  if (session) {
    const info = describeHost(session.host);
    return `<div class="pp-card">
      <div class="pp-card-top">
        <span class="pp-av lg">${esc(initials(info.name))}</span>
        <div class="pp-org-text"><b>${esc(info.name)}</b><span>${esc(session.host)}</span></div>
        <span class="kind kind-${info.kindKey}">${esc(info.kind)}</span>
      </div>
      <button class="pp-primary" data-host="${esc(session.host)}">${icon("search")}${esc(L("Explorar esta org", "Explore this org"))}<span class="pp-enter">Enter ↵</span></button>
      <div class="pp-fav-head"><span>${esc(L("Favoritos", "Favorites"))}</span>
        <button type="button" class="pp-link" data-act="edit-favs" title="${esc(L("Elegir los 4 atajos", "Choose the 4 shortcuts"))}">${icon("pencil")}${esc(L("Editar", "Edit"))}</button></div>
      <div class="pp-tools">${state.favs
        .map((id, i) => {
          const f = favById(id);
          return `<button class="pp-tool" data-fav="${esc(id)}" title="${esc(`${f.title} (${i + 1})`)}">${icon(f.icon)}<span>${esc(f.label)}</span><kbd>${i + 1}</kbd></button>`;
        })
        .join("")}</div>
    </div>`;
  }
  if (state.onSalesforce)
    return `<div class="pp-note warn">${icon("alert")}<span>${esc(
      L("Estás en Salesforce pero no encontramos una sesión activa. Recarga la página o vuelve a iniciar sesión.", "You're on Salesforce but no active session was found. Reload the page or log in again.")
    )}</span></div>`;
  return `<div class="pp-note">${icon("info")}<span>${esc(
    L("Abre una pestaña de Salesforce para explorar esa org, o elige una de la lista.", "Open a Salesforce tab to explore that org, or pick one from the list.")
  )}</span></div>`;
}

// ───────────────────────────────────────── Editor de favoritos
function favEditHtml() {
  const fe = state.favEdit;
  return `<div class="pp-form">
    <div class="pp-form-head"><button type="button" class="pp-ic" data-act="cancel" title="${esc(L("Volver", "Back"))}">${icon("arrow-left")}</button>
      <b>${esc(L("Editar favoritos", "Edit favorites"))}</b></div>
    <div class="pp-tools pp-fav-slots">${fe.slots
      .map((id, i) => {
        const f = favById(id);
        return `<button type="button" class="pp-tool ${i === fe.active ? "on" : ""}" data-slot="${i}" title="${esc(f.title)}">${icon(f.icon)}<span>${esc(f.label)}</span><kbd>${i + 1}</kbd></button>`;
      })
      .join("")}</div>
    <p class="pp-hint">${icon("info")}<span>${esc(
      L(`Elige el atajo para el lugar ${fe.active + 1}. Toca otro lugar para cambiarlo.`, `Pick the shortcut for slot ${fe.active + 1}. Tap another slot to change it.`)
    )}</span></p>
    <label class="pp-fld"><span class="pp-pass"><input data-fav-q value="${esc(fe.q)}" placeholder="${esc(L("Buscar: flows, permission sets, setup…", "Search: flows, permission sets, setup…"))}" autocomplete="off" spellcheck="false"></span></label>
    <div class="pp-fav-list" data-fav-list></div>
    <div class="pp-form-foot">
      <button type="button" class="pp-btn" data-act="fav-reset" title="${esc(L("SOQL, IDE, Schema y Reportes", "SOQL, IDE, Schema and Reports"))}">${icon("undo")}${esc(L("Por defecto", "Defaults"))}</button>
      <span style="flex:1"></span>
      <button type="button" class="pp-btn" data-act="cancel">${esc(L("Cancelar", "Cancel"))}</button>
      <button type="button" class="pp-btn primary" data-act="fav-save">${icon("check")}${esc(L("Guardar", "Save"))}</button>
    </div>
  </div>`;
}

function renderFavList() {
  const box = $("[data-fav-list]");
  if (!box) return;
  const fe = state.favEdit;
  const q = fe.q.trim();
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const items = catalog().filter((f) => !tokens.length || tokens.every((t) => `${f.title} ${f.label} ${f.id}`.toLowerCase().includes(t)));
  box.innerHTML =
    GROUPS.map((g) => {
      const list = items.filter((f) => f.group === g.id);
      if (!list.length) return "";
      return `<div class="pp-fav-group">${esc(g.label)}</div>${list
        .map((f) => {
          const slot = fe.slots.indexOf(f.id);
          return `<button type="button" class="pp-fav-item ${slot === fe.active ? "on" : ""}" data-pick="${esc(f.id)}">${icon(f.icon)}<span>${highlight(f.title, q)}</span>${
            slot >= 0 ? `<kbd title="${esc(L(`En el lugar ${slot + 1}`, `In slot ${slot + 1}`))}">${slot + 1}</kbd>` : ""
          }</button>`;
        })
        .join("")}`;
    }).join("") || `<div class="pp-empty">${esc(L("Ningún atajo coincide", "No shortcut matches"))}</div>`;
}

/** Elige un atajo para el lugar activo; si ya estaba en otro lugar, los intercambia. */
function pickFav(id) {
  const fe = state.favEdit;
  const prev = fe.slots.indexOf(id);
  if (prev >= 0 && prev !== fe.active) fe.slots[prev] = fe.slots[fe.active];
  fe.slots[fe.active] = id;
  fe.active = (fe.active + 1) % FAV_SLOTS;
  const q = fe.q;
  render();
  const input = $("[data-fav-q]");
  if (input) input.value = q;
}

// ───────────────────────────────────────── Acciones
async function onClick(e) {
  const t = (sel) => e.target.closest(sel);
  if (t('[data-act="cancel"]')) {
    state.favEdit = null;
    return render();
  }
  if (t('[data-act="edit-favs"]')) {
    state.favEdit = { slots: [...state.favs], active: 0, q: "" };
    return render();
  }
  const slot = t("[data-slot]");
  if (slot) {
    state.favEdit.active = Number(slot.dataset.slot);
    return render();
  }
  const pick = t("[data-pick]");
  if (pick) return pickFav(pick.dataset.pick);
  if (t('[data-act="fav-reset"]')) {
    state.favEdit.slots = [...DEFAULT_FAVS];
    state.favEdit.active = 0;
    return render();
  }
  if (t('[data-act="fav-save"]')) {
    state.favs = normalizeFavs(state.favEdit.slots);
    await chrome.storage.local.set({ favShortcuts: state.favs });
    state.favEdit = null;
    return render();
  }
  const fav = t("[data-fav]");
  if (fav && state.current) return openFav(state.current.host, fav.dataset.fav);
  const b = t("[data-host]");
  if (b) openExplorer(b.dataset.host);
}

function openExplorer(host, open = null, hash = "") {
  chrome.tabs.create({
    url: chrome.runtime.getURL(`app/app.html?host=${encodeURIComponent(host)}${open ? `&open=${encodeURIComponent(open)}` : ""}${hash}`),
    index: state.tab ? state.tab.index + 1 : undefined,
  });
  window.close();
}

/** Abre un atajo favorito para la org de la pestaña actual. */
function openFav(host, id) {
  const [kind, key] = id.split(":");
  if (kind === "tool") return openExplorer(host, key);
  if (kind === "m") return openExplorer(host, null, `#m=${encodeURIComponent(key)}`);
  if (kind === "d") return openExplorer(host, null, `#d=${encodeURIComponent(key)}`);
  if (kind === "sf" && SF_PAGES[key]) {
    chrome.tabs.create({ url: `https://${lightningHost(host)}${SF_PAGES[key].path}`, index: state.tab ? state.tab.index + 1 : undefined });
    window.close();
  }
}
