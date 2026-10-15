import { getSessionForHost, listSessions, describeHost, isSalesforceHost, lightningHost } from "../lib/session.js";
import { listCreds, saveCred, deleteCred, dedupeCreds, DuplicateCredError } from "../lib/vault.js";
import { L, lang, setLang, translateStatic } from "../lib/i18n.js";
import { $, icon, esc, initials, hydrateIcons, storage, highlight } from "../app/ui.js";
import { DEFAULT_FAVS, FAV_SLOTS, GROUPS, SF_PAGES, catalog, favById, normalizeFavs } from "./favorites.js";

const state = { tab: null, current: null, onSalesforce: false, sessions: [], creds: [], form: null, favs: DEFAULT_FAVS, favEdit: null };

init();

async function init() {
  const settings = await storage.get("settings", {});
  const dark = settings.theme ? settings.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  translateStatic();
  hydrateIcons();
  chrome.action.setBadgeText({ text: "" }); // el aviso de login fallido se ve en la lista

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
  await reload();

  document.body.addEventListener("click", onClick);
  document.body.addEventListener("submit", onSubmit);
  document.body.addEventListener("input", (e) => {
    if (e.target.matches("[data-fav-q]")) {
      state.favEdit.q = e.target.value;
      renderFavList();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (state.form || state.favEdit || !state.current || /^(SELECT|INPUT)$/.test(e.target.tagName)) return;
    if (e.key === "Enter") openExplorer(state.current.host);
    const fav = state.favs[Number(e.key) - 1];
    if (fav) openFav(state.current.host, fav);
  });
}

async function reload() {
  await dedupeCreds(); // orgs guardadas dos veces por versiones anteriores
  [state.sessions, state.creds] = await Promise.all([listSessions(), listCreds()]);
  render();
}

// ───────────────────────────────────────── Render
function render() {
  const main = $("#pp-main");
  if (state.form) {
    main.innerHTML = formHtml(state.form);
    main.querySelector('[name="username"]')?.focus();
    return;
  }
  if (state.favEdit) {
    main.innerHTML = favEditHtml();
    renderFavList();
    main.querySelector("[data-fav-q]")?.focus();
    return;
  }
  const savedHosts = new Set(state.creds.map((c) => c.domain).filter(Boolean));
  state.rows = buildRows();
  main.innerHTML = `
    <section class="pp-current">${currentHtml(savedHosts)}</section>
    <div class="pp-label pp-label-row"><span>${esc(state.current ? L("Otras orgs", "Other orgs") : "Orgs")}</span>
      <button type="button" class="pp-link" data-act="new">${icon("plus")}${esc(L("Guardar org", "Save org"))}</button></div>
    <div class="pp-list">${
      state.rows.length
        ? state.rows.map((r, i) => rowHtml(r, i)).join("")
        : `<div class="pp-empty">${esc(
            L("Inicia sesión en una org o guarda sus credenciales para entrar con un click.", "Log in to an org or save its credentials to log in with one click.")
          )}</div>`
    }</div>`;
}

/**
 * Una sola lista: orgs con sesión activa y orgs guardadas, unidas por dominio.
 * Primero las que tienen sesión; después las guardadas sin sesión.
 */
function buildRows() {
  const used = new Set();
  const rows = [];
  for (const s of state.sessions) {
    if (state.current && s.orgId === state.current.orgId) continue;
    const cred = state.creds.find((c) => !used.has(c.id) && c.domain === s.host);
    if (cred) used.add(cred.id);
    rows.push({ host: s.host, name: cred?.name || s.name, kind: s.kind, kindKey: s.kindKey, active: true, cred });
  }
  for (const c of state.creds) {
    if (used.has(c.id) || (state.current && c.domain === state.current.host)) continue;
    const info = c.domain ? describeHost(c.domain) : null;
    rows.push({ host: c.domain, name: c.name, kind: info?.kind, kindKey: info?.kindKey, active: false, cred: c });
  }
  return rows;
}

function currentHtml(savedHosts) {
  const session = state.current;
  if (session) {
    const info = describeHost(session.host);
    return `<div class="pp-card">
      <div class="pp-card-top">
        <span class="pp-av lg">${esc(initials(info.name))}</span>
        <div class="pp-org-text"><b>${esc(info.name)}</b><span>${esc(session.host)}</span></div>
        <span class="kind kind-${info.kindKey}">${esc(info.kind)}</span>
        ${savedHosts.has(session.host) ? "" : `<button type="button" class="pp-ic" data-save-host="${esc(session.host)}" title="${esc(L("Guardar credenciales de esta org", "Save this org's credentials"))}">${icon("key")}</button>`}
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
    L("Abre una pestaña de Salesforce, elige una org de la lista o entra con una org guardada.", "Open a Salesforce tab, pick an org from the list or log in with a saved org.")
  )}</span></div>`;
}

function errorText(code) {
  if (code === "VAULT_UNREADABLE") return L("No se pudo leer la contraseña guardada: vuelve a escribirla.", "The saved password couldn't be read: enter it again.");
  if (code === "INVALID_LOGIN" || /check your username and password|revise su nombre de usuario|verifique su nombre de usuario/i.test(code))
    return L("Salesforce rechazó el usuario o la contraseña.", "Salesforce rejected the username or password.");
  return code;
}

/** Fila con el diseño de siempre (avatar, nombre, tipo de org en color) + acciones de la org guardada. */
function rowHtml(r, i) {
  const c = r.cred;
  const status = c?.lastError
    ? `<em class="pp-row-err" title="${esc(c.lastError)}">${icon("alert")}<span>${esc(errorText(c.lastError))}</span></em>`
    : c && !r.active
      ? `<em class="pp-row-saved">${icon("key")}${esc(L("Guardada · click para entrar", "Saved · click to log in"))}</em>`
      : "";
  const title = r.active ? L("Explorar en Org Lens", "Explore in Org Lens") : L("Iniciar sesión e ir al home de la org", "Log in and go to the org home");
  return `<div class="pp-org ${c?.lastError ? "err" : ""}" data-row="${i}" role="button" tabindex="0" title="${esc(title)}" style="--i:${i}">
    <span class="pp-av">${esc(initials(r.name))}</span>
    <span class="pp-org-text"><b>${esc(r.name)}</b><span>${esc(c ? c.username : r.host)}</span>${status}</span>
    ${r.kind ? `<span class="kind kind-${r.kindKey}">${esc(r.kind)}</span>` : ""}
    <span class="pp-row-acts">
      ${
        c
          ? `<button type="button" class="pp-ic hover" data-edit="${esc(c.id)}" title="${esc(L("Editar credenciales", "Edit credentials"))}">${icon("pencil")}</button>
             <button type="button" class="pp-ic hover del" data-del="${esc(c.id)}" title="${esc(L("Eliminar credenciales", "Delete credentials"))}">${icon("x")}</button>`
          : `<button type="button" class="pp-ic" data-save-host="${esc(r.host)}" title="${esc(L("Guardar credenciales de esta org", "Save this org's credentials"))}">${icon("key")}</button>`
      }
      <button type="button" class="pp-ic" data-home="${i}" title="${esc(L("Abrir el home de la org en Salesforce", "Open the org home in Salesforce"))}">${icon("external")}</button>
    </span>
    ${icon("chevron-right", "pp-go")}
  </div>`;
}

function formHtml(f) {
  const editing = !!f.id;
  return `<form class="pp-form" novalidate>
    <div class="pp-form-head"><button type="button" class="pp-ic" data-act="cancel" title="${esc(L("Volver", "Back"))}">${icon("arrow-left")}</button>
      <b>${esc(editing ? L("Editar org guardada", "Edit saved org") : L("Guardar org", "Save org"))}</b></div>
    <label class="pp-fld"><span>${esc(L("Usuario", "Username"))}</span><input name="username" value="${esc(f.username || "")}" autocomplete="username" spellcheck="false" placeholder="nombre@empresa.com"></label>
    <label class="pp-fld"><span>${esc(L("Contraseña", "Password"))}</span>
      <span class="pp-pass"><input name="password" type="password" autocomplete="new-password" placeholder="${esc(editing ? L("Sin cambios", "Unchanged") : "")}"><button type="button" class="pp-ic" data-act="eye" title="${esc(L("Mostrar", "Show"))}">${icon("eye")}</button></span></label>
    <label class="pp-fld"><span>${esc(L("Nombre", "Name"))} <em>${esc(L("(opcional)", "(optional)"))}</em></span><input name="name" value="${esc(f.name || "")}" placeholder="${esc(L("Se completa solo", "Filled in automatically"))}" autocomplete="off"></label>
    <details class="pp-adv" ${f.domain ? "open" : ""}><summary>${esc(L("Avanzado", "Advanced"))}</summary>
      <label class="pp-fld"><span>${esc(L("Dominio (My Domain)", "Domain (My Domain)"))} <em>${esc(L("opcional · se detecta solo", "optional · detected automatically"))}</em></span><input name="domain" value="${esc(
        f.domain || ""
      )}" placeholder="empresa.my.salesforce.com" spellcheck="false" autocomplete="off"></label>
    </details>
    <p class="pp-hint">${icon("lock")}<span>${esc(
      L(
        "Se guarda cifrada solo en este navegador: no se sincroniza ni se envía a ningún servidor; solo se usa para completar el login de Salesforce. No hace falta elegir producción o sandbox.",
        "Stored encrypted only in this browser: never synced or sent to any server; it's only used to fill in Salesforce's login. No need to pick production or sandbox."
      )
    )}</span></p>
    <div class="pp-err" data-err hidden></div>
    <div class="pp-form-foot">
      <button type="submit" class="pp-btn" name="mode" value="save">${esc(L("Guardar", "Save"))}</button>
      <button type="submit" class="pp-btn primary" name="mode" value="login">${icon("key")}${esc(L("Guardar y entrar", "Save and log in"))}</button>
    </div>
  </form>`;
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
  if (t('[data-act="new"]')) return openForm({});
  if (t('[data-act="cancel"]')) {
    state.form = null;
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
  if (t('[data-act="eye"]')) {
    const input = $('.pp-form [name="password"]');
    input.type = input.type === "password" ? "text" : "password";
    return;
  }
  const save = t("[data-save-host]");
  if (save) return openForm(await prefillFromSession(save.dataset.saveHost));
  const edit = t("[data-edit]");
  if (edit) return openForm({ ...state.creds.find((c) => c.id === edit.dataset.edit) });
  const del = t("[data-del]");
  if (del) {
    const c = state.creds.find((x) => x.id === del.dataset.del);
    if (c && confirm(L(`¿Eliminar las credenciales de «${c.name}»?`, `Delete the credentials for “${c.name}”?`))) {
      await deleteCred(c.id);
      await reload();
    }
    return;
  }
  const home = t("[data-home]");
  if (home) {
    const r = state.rows[Number(home.dataset.home)];
    // Guardada: el service worker entra si hace falta y termina en el home. Sin guardar: ya hay sesión.
    if (r.cred) return doLogin(r.cred.id);
    chrome.tabs.create({ url: `https://${lightningHost(r.host)}/lightning/page/home`, index: state.tab ? state.tab.index + 1 : undefined });
    return window.close();
  }
  const row = t("[data-row]");
  if (row) {
    const r = state.rows[Number(row.dataset.row)];
    return r.active ? openExplorer(r.host) : doLogin(r.cred.id);
  }
  const b = t("[data-host]");
  if (b) openExplorer(b.dataset.host, b.dataset.open);
}

function openForm(f) {
  state.form = f;
  render();
}

/** Desde una org con sesión: completa dominio, nombre y el usuario con el que ya entraste. */
async function prefillFromSession(host) {
  const info = describeHost(host);
  const f = { name: info.name, domain: host, username: "" };
  try {
    const s = await getSessionForHost(host);
    const r = await fetch(`https://${s.host}/services/oauth2/userinfo`, { headers: { Authorization: `Bearer ${s.sid}` }, credentials: "omit" });
    if (r.ok) f.username = (await r.json()).preferred_username || "";
  } catch {
    /* sin usuario: se escribe a mano */
  }
  return f;
}

/** "https://x.lightning.force.com/lightning/…" → "x.my.salesforce.com" */
function normalizeDomain(v) {
  let h = String(v || "").trim().toLowerCase();
  if (!h) return null;
  h = h.replace(/^https?:\/\//, "").split(/[/?#]/)[0];
  h = h.replace(/\.lightning\.force\.com$/, ".my.salesforce.com").replace(/\.my\.salesforce-setup\.com$/, ".my.salesforce.com");
  return h;
}

function defaultName(username, domain) {
  if (domain) return describeHost(domain).name;
  return String(username).split("@").pop() || username;
}

async function onSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const mode = e.submitter?.value || "save";
  const err = form.querySelector("[data-err]");
  const username = String(fd.get("username") || "").trim();
  const password = String(fd.get("password") || "");
  const domain = normalizeDomain(fd.get("domain"));
  const show = (m) => {
    err.textContent = m;
    err.hidden = false;
  };
  if (!username || !username.includes("@")) return show(L("Escribe el usuario de Salesforce (tiene formato de email).", "Enter the Salesforce username (it looks like an email)."));
  if (!state.form.id && !password) return show(L("Escribe la contraseña.", "Enter the password."));
  if (domain && !isSalesforceHost(domain)) return show(L("El dominio debe ser de Salesforce (…my.salesforce.com).", "The domain must be a Salesforce one (…my.salesforce.com)."));
  try {
    const saved = await saveCred({
      id: state.form.id || null,
      name: String(fd.get("name") || "").trim() || defaultName(username, domain),
      username,
      password,
      domain,
    });
    state.form = null;
    if (mode === "login") return doLogin(saved.id);
    await reload();
  } catch (ex) {
    if (ex instanceof DuplicateCredError)
      return show(
        L(
          `Ese usuario ya está guardado como «${ex.existing.name}». Edítalo desde la lista si quieres cambiar la contraseña.`,
          `That username is already saved as “${ex.existing.name}”. Edit it from the list to change the password.`
        )
      );
    show(ex.message);
  }
}

/**
 * Pide el login al service worker y espera su confirmación antes de cerrar el panel: si Chrome lo
 * había suspendido tarda en despertar, y cerrar antes puede perder el mensaje.
 */
async function doLogin(id) {
  document.body.classList.add("pp-busy");
  try {
    const res = await Promise.race([chrome.runtime.sendMessage({ type: "login", id }), new Promise((r) => setTimeout(() => r({ timeout: true }), 8000))]);
    if (res?.error) return notice(L(`No se pudo iniciar el login: ${res.error}`, `Couldn't start the login: ${res.error}`));
  } catch (e) {
    // El service worker no tiene el listener: corre una versión vieja (la extensión no se recargó
    // tras actualizarse) o no pudo arrancar. Se recarga la extensión una vez y el login sigue solo.
    if (/Receiving end does not exist|Could not establish connection/i.test(e.message)) return recoverWorker(id);
    return notice(L(`No se pudo iniciar el login: ${e.message}`, `Couldn't start the login: ${e.message}`));
  }
  window.close(); // el login sigue en el service worker
}

async function recoverWorker(id) {
  const { swReloadAt } = await chrome.storage.local.get("swReloadAt");
  if (swReloadAt && Date.now() - swReloadAt < 60000) {
    return notice(
      L(
        "El service worker de Org Lens no arranca. Abre chrome://extensions, busca Org Lens y revisa «Errores» (o pulsa «service worker» para ver la consola).",
        "Org Lens's service worker won't start. Open chrome://extensions, find Org Lens and check “Errors” (or click “service worker” to see the console)."
      )
    );
  }
  await chrome.storage.local.set({ swReloadAt: Date.now(), pendingLogin: { id, at: Date.now() } });
  chrome.runtime.reload(); // cierra el panel; el worker nuevo retoma el login pendiente
}

/** Aviso dentro del panel (en lugar de un alert). */
function notice(text) {
  document.body.classList.remove("pp-busy");
  document.querySelector(".pp-notice")?.remove();
  $("#pp-main").insertAdjacentHTML("afterbegin", `<div class="pp-note warn pp-notice">${icon("alert")}<span>${esc(text)}</span></div>`);
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
