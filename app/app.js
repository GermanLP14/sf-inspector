// Punto de entrada del explorador: sesión, encabezado de org, modos, idioma y navegación.
import { getSessionForHost, listSessions, describeHost, lightningHost } from "../lib/session.js";
import { SalesforceApi } from "../lib/sfapi.js";
import { L, lang, setLang, translateStatic } from "../lib/i18n.js";
import { $, $$, icon, esc, toast, storage, hydrateIcons, initials, replayAnimation } from "./ui.js";
import { MetadataView } from "./metadata-view.js";
import { DataView } from "./data-view.js";
import { RecordPanel } from "./record-panel.js";
import { QueryConsole } from "./query-console.js";
import { CodeIde } from "./code-ide.js";
import { SchemaBuilder } from "./schema-view.js";
import { AnalyticsStudio } from "./analytics-view.js";

const SYNC_EVERY_MS = 60 * 1000; // re-sincronización periódica de la lista abierta
const SYNC_ON_RETURN_MS = 10 * 1000; // al volver a la pestaña, si pasaron más de 10 s

const params = new URLSearchParams(location.search);
const settings = { theme: null, linkTarget: "new", mode: "metadata" };
let ctx = null;
let mode = null;

boot();

async function boot() {
  Object.assign(settings, await storage.get("settings", {}));
  applyTheme();
  translateStatic();
  hydrateIcons();
  bindTopbar();

  const host = params.get("host") || (await storage.get("lastHost", null));
  const session = host ? await getSessionForHost(host) : null;
  if (!session) return showBlocker(host);

  storage.set("lastHost", session.host);
  if (params.get("host") !== session.host) {
    history.replaceState(null, "", `?host=${encodeURIComponent(session.host)}${location.hash}`);
  }

  const hostInfo = describeHost(session.host);
  document.title = `Org Lens · ${hostInfo.name}`;
  ctx = {
    api: new SalesforceApi(session),
    session,
    lightning: lightningHost(session.host),
    orgKindKey: describeHost(session.host).kindKey, // se confirma con la API en loadIdentity
    userId: null,
    url: (path) => `https://${ctx.lightning}${path}`,
    setHash,
    setCompact,
    goToData,
    sessionExpired,
  };

  renderOrg({ name: hostInfo.name, user: session.host, kind: hostInfo.kind, kindKey: hostInfo.kindKey });
  loadIdentity();

  ctx.metadata = new MetadataView(ctx);
  ctx.data = new DataView(ctx);
  ctx.record = new RecordPanel(ctx);
  ctx.console = new QueryConsole(ctx);
  ctx.ide = new CodeIde(ctx);
  ctx.schema = new SchemaBuilder(ctx);
  $("#open-schema").addEventListener("click", () => ctx.schema.openMain());
  ctx.analytics = new AnalyticsStudio(ctx);
  $("#open-analytics").addEventListener("click", () => ctx.analytics.openHub());
  $("#open-console").addEventListener("click", () => {
    if (mode === "data" && ctx.data.meta) ctx.console.open({ soql: ctx.data.buildSoql(), mode: "data" });
    else if (mode === "metadata" && ctx.metadata.def) ctx.metadata.openConsole();
    else ctx.console.open({ mode });
  });
  $("#open-ide").addEventListener("click", () => ctx.ide.openWorkspace());

  bindModes();
  bindGlobal();
  bindSync();
  route();
  window.addEventListener("hashchange", route);
  document.body.classList.add("ready");
  openToolFromUrl();
}

/** Atajos del panel de la extensión: ?open=soql|ide|schema|analytics abre esa herramienta al entrar. */
function openToolFromUrl() {
  const tool = params.get("open");
  if (!tool) return;
  try {
    history.replaceState(null, "", `${location.pathname}?host=${encodeURIComponent(ctx.session.host)}${location.hash}`); // al recargar no se vuelve a abrir
  } catch {
    /* sin limpiar la URL: no es crítico */
  }
  const open = {
    soql: () => $("#open-console").click(),
    ide: () => ctx.ide.openWorkspace(),
    schema: () => ctx.schema.openMain(),
    analytics: () => ctx.analytics.openHub(),
  }[tool];
  open?.();
}

// ───────────────────────────────────────── Sincronización automática
function bindSync() {
  const syncActive = (minAge) => {
    if (!ctx || document.visibilityState !== "visible") return;
    (mode === "data" ? ctx.data : ctx.metadata).sync({ minAge });
  };
  setInterval(() => syncActive(SYNC_EVERY_MS - 1000), SYNC_EVERY_MS);
  document.addEventListener("visibilitychange", () => syncActive(SYNC_ON_RETURN_MS));
  window.addEventListener("focus", () => syncActive(SYNC_ON_RETURN_MS));
}

// ───────────────────────────────────────── Navegación
function parseHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  return { m: h.get("m"), d: h.get("d") };
}

function route() {
  const { m, d } = parseHash();
  if (d) {
    setMode("data", { skipActivate: true });
    ctx.data.activate();
    if (ctx.data.meta?.name !== d) ctx.data.open(d);
  } else if (m) {
    setMode("metadata", { skipActivate: true });
    if (ctx.metadata.def?.key !== m) ctx.metadata.open(m);
  } else {
    setMode(mode || settings.mode || "metadata");
  }
}

function setHash(h) {
  const next = h ? `#${h}` : "";
  if (location.hash !== next) history.replaceState(null, "", `${location.pathname}${location.search}${next}`);
}

function setCompact(on) {
  document.body.classList.toggle("compact", on);
}

function goToData(objectName) {
  setMode("data", { skipActivate: true });
  ctx.data.activate();
  ctx.data.open(objectName);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bindModes() {
  $$(".mode-switch [data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  window.addEventListener("resize", positionSlider);
}

function setMode(next, { skipActivate = false } = {}) {
  const changed = next !== mode;
  mode = next;
  settings.mode = next;
  saveSettings();
  $$(".mode-switch [data-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === next);
    b.setAttribute("aria-selected", b.dataset.mode === next);
  });
  positionSlider();
  $("#md-picker").classList.toggle("hidden", next !== "metadata");
  $("#dt-picker").classList.toggle("hidden", next !== "data");
  $("#view-metadata").classList.toggle("hidden", next !== "metadata");
  $("#view-data").classList.toggle("hidden", next !== "data");
  $("#hero-sub").textContent =
    next === "metadata"
      ? L(
          "Código, flows, Agentforce, objetos, campos, reglas y más. Elige un tipo y filtra al instante.",
          "Code, flows, Agentforce, objects, fields, rules and more. Pick a type and filter instantly."
        )
      : L(
          "Records de cualquier objeto, con filtros por nombre, estado, dueño y fechas.",
          "Records of any object, filtered by name, status, owner and dates."
        );
  if (changed) {
    replayAnimation($(next === "metadata" ? "#view-metadata" : "#view-data"));
    replayAnimation($(next === "metadata" ? "#md-picker" : "#dt-picker"), "pop-in");
  }
  if (!skipActivate) (next === "metadata" ? ctx.metadata : ctx.data).activate();
}

function positionSlider() {
  const active = $(".mode-switch [data-mode].active");
  const slider = $(".mode-slider");
  if (!active || !slider) return;
  slider.style.width = `${active.offsetWidth}px`;
  slider.style.transform = `translateX(${active.offsetLeft - 5}px)`;
}

// ───────────────────────────────────────── Enlaces y atajos
function bindGlobal() {
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-sf]");
    if (!a || e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return; // dejar comportamiento nativo
    e.preventDefault();
    openLink(a.href);
  });
  document.addEventListener("auxclick", (e) => {
    const a = e.target.closest("a[data-sf]");
    if (a && e.button === 1) {
      e.preventDefault();
      chrome.tabs.create({ url: a.href, active: false });
    }
  });
  document.addEventListener("keydown", (e) => {
    if (!ctx) return;
    if (ctx.ide.isOpen || ctx.schema.isOpen || ctx.analytics.isOpen) return; // tienen sus propios atajos (Ctrl+S, Esc, Supr…)
    if (e.altKey && e.key.toLowerCase() === "i") {
      e.preventDefault();
      return ctx.ide.openWorkspace();
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (e.key === "/" && !typing) {
      e.preventDefault();
      (mode === "data" ? ctx.data.picker : ctx.metadata.picker).focus();
    }
    if (!typing && e.altKey && (e.key === "1" || e.key === "2")) setMode(e.key === "1" ? "metadata" : "data");
    if (e.altKey && e.key.toLowerCase() === "q") {
      e.preventDefault();
      $("#open-console").click();
    }
  });
}

async function openLink(url) {
  if (settings.linkTarget === "same") {
    location.href = url;
    return;
  }
  try {
    const me = await chrome.tabs.getCurrent();
    await chrome.tabs.create({ url, active: true, index: me ? me.index + 1 : undefined, openerTabId: me?.id });
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

// ───────────────────────────────────────── Org / identidad
async function loadIdentity() {
  const { api, session } = ctx;
  const [who, org] = await Promise.allSettled([
    api.identity(),
    api.query("SELECT Id, Name, OrganizationType, IsSandbox, InstanceName, TrialExpirationDate, NamespacePrefix FROM Organization LIMIT 1"),
  ]);
  if (who.status === "rejected" && who.reason?.status === 401) return sessionExpired();

  const hostInfo = describeHost(session.host);
  const user = who.status === "fulfilled" ? who.value : null;
  if (user) ctx.userId = user.userId;
  const o = org.status === "fulfilled" ? org.value.records[0] : null;
  const [kind, kindKey] = orgKind(o, hostInfo);
  ctx.orgKindKey = kindKey; // el IDE lo usa para bloquear el guardado de Apex en producción
  ctx.orgNamespace = o?.NamespacePrefix || null;
  renderOrg({
    name: o?.Name || hostInfo.name,
    user: user ? user.username || user.name : session.host,
    userName: user?.name,
    kind,
    kindKey,
    instance: o?.InstanceName,
  });
  if (ctx.data.meta && user) ctx.data.renderFilters();
}

function orgKind(o, hostInfo) {
  if (hostInfo.kindKey === "scratch") return ["Scratch", "scratch"];
  if (!o) return [hostInfo.kind, hostInfo.kindKey];
  if (o.IsSandbox) return ["Sandbox", "sandbox"];
  if (o.OrganizationType === "Developer Edition") return o.TrialExpirationDate ? ["Scratch", "scratch"] : ["Developer", "dev"];
  if (o.TrialExpirationDate) return ["Trial", "trial"];
  return [L("Producción", "Production"), "prod"];
}

function renderOrg({ name, user, userName, kind, kindKey, instance }) {
  $("#org-avatar").textContent = initials(name);
  $("#org-name").textContent = name;
  $("#org-user").textContent = user;
  $("#org-btn").title = [userName, user, instance && `${L("Instancia", "Instance")} ${instance}`, ctx?.session.host].filter(Boolean).join("\n");
  const k = $("#org-kind");
  k.textContent = kind;
  k.className = `kind kind-${kindKey}`;
}

async function renderOrgMenu() {
  const menu = $("#org-menu-list");
  menu.innerHTML = `<div class="menu-loading"><span class="spinner"></span> ${esc(L("Buscando sesiones…", "Looking for sessions…"))}</div>`;
  const sessions = await listSessions();
  menu.innerHTML = sessions.length
    ? sessions
        .map((s) => {
          const current = ctx && s.orgId === ctx.session.orgId;
          return `<button class="menu-item ${current ? "current" : ""}" data-host="${esc(s.host)}">
            <span class="org-avatar sm">${esc(initials(s.name))}</span>
            <span class="mi-text"><b>${esc(s.name)}</b><span>${esc(s.host)}</span></span>
            <span class="kind kind-${s.kindKey}">${esc(s.kind)}</span>
            ${current ? icon("check", "mi-check") : ""}
          </button>`;
        })
        .join("")
    : `<div class="menu-loading">${esc(L("No hay otras sesiones activas.", "No other active sessions."))}</div>`;
}

function bindTopbar() {
  const wrap = $("#org-switcher");
  const btn = $("#org-btn");
  btn.addEventListener("click", () => {
    const open = !wrap.classList.contains("open");
    wrap.classList.toggle("open", open);
    if (open) renderOrgMenu();
  });
  document.addEventListener("mousedown", (e) => {
    if (!wrap.contains(e.target)) wrap.classList.remove("open");
  });
  $("#org-menu-list").addEventListener("click", (e) => {
    const item = e.target.closest("[data-host]");
    if (!item) return;
    const url = `app.html?host=${encodeURIComponent(item.dataset.host)}`;
    if (e.ctrlKey || e.metaKey) chrome.tabs.create({ url: chrome.runtime.getURL(`app/${url}`) });
    else location.href = url;
  });
  $("#org-open-sf").addEventListener("click", () => ctx && openLink(ctx.url("/lightning/page/home")));
  $("#org-open-setup").addEventListener("click", () => ctx && openLink(ctx.url("/lightning/setup/SetupOneHome/home")));

  const langSelect = $("#lang-select");
  langSelect.value = lang;
  langSelect.addEventListener("change", () => {
    setLang(langSelect.value);
    document.body.classList.add("lang-switching");
    setTimeout(() => location.reload(), 180);
  });

  $("#theme-toggle").addEventListener("click", () => {
    settings.theme = currentTheme() === "dark" ? "light" : "dark";
    saveSettings();
    document.documentElement.classList.add("theme-anim");
    applyTheme();
    setTimeout(() => document.documentElement.classList.remove("theme-anim"), 500);
  });

  $("#link-target").addEventListener("click", () => {
    settings.linkTarget = settings.linkTarget === "same" ? "new" : "same";
    saveSettings();
    renderLinkTarget();
    toast(
      settings.linkTarget === "same"
        ? L("Los enlaces se abrirán en esta misma pestaña", "Links will open in this same tab")
        : L("Los enlaces se abrirán en una pestaña nueva", "Links will open in a new tab"),
      "info",
      2200
    );
  });
  renderLinkTarget();
}

function renderLinkTarget() {
  const b = $("#link-target");
  const same = settings.linkTarget === "same";
  b.innerHTML = icon(same ? "same-tab" : "external");
  b.title = same
    ? L("Abrir enlaces en esta pestaña (click para cambiar)", "Open links in this tab (click to change)")
    : L("Abrir enlaces en una pestaña nueva (click para cambiar)", "Open links in a new tab (click to change)");
}

// ───────────────────────────────────────── Tema
function currentTheme() {
  return settings.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

function applyTheme() {
  const t = currentTheme();
  document.documentElement.dataset.theme = t;
  const b = $("#theme-toggle");
  if (b) {
    b.innerHTML = icon(t === "dark" ? "sun" : "moon");
    b.title = t === "dark" ? L("Cambiar a tema claro", "Switch to light theme") : L("Cambiar a tema oscuro", "Switch to dark theme");
  }
}

function saveSettings() {
  storage.set("settings", { ...settings });
}

// ───────────────────────────────────────── Sin sesión
async function showBlocker(host, expired = false) {
  const el = $("#blocker");
  el.classList.remove("hidden");
  const sessions = await listSessions();
  $("#blocker-title").textContent = expired
    ? L("Tu sesión de Salesforce expiró", "Your Salesforce session expired")
    : L("No encontramos una sesión de Salesforce", "We couldn't find a Salesforce session");
  $("#blocker-text").innerHTML = expired
    ? esc(L("Vuelve a iniciar sesión en la org desde otra pestaña y luego recarga esta página.", "Log in to the org again from another tab and then reload this page."))
    : host
      ? L(
          `No hay una sesión activa para <b>${esc(host)}</b>. Inicia sesión en Salesforce en una pestaña y vuelve a intentarlo.`,
          `There is no active session for <b>${esc(host)}</b>. Log in to Salesforce in a tab and try again.`
        )
      : esc(
          L(
            "Abre esta herramienta desde el ícono de la extensión estando en una pestaña de Salesforce, o elige una org con sesión activa:",
            "Open this tool from the extension icon while on a Salesforce tab, or pick an org with an active session:"
          )
        );
  $("#blocker-list").innerHTML = sessions
    .map(
      (s) => `<a class="menu-item" href="app.html?host=${encodeURIComponent(s.host)}">
        <span class="org-avatar sm">${esc(initials(s.name))}</span>
        <span class="mi-text"><b>${esc(s.name)}</b><span>${esc(s.host)}</span></span>
        <span class="kind kind-${s.kindKey}">${esc(s.kind)}</span>
      </a>`
    )
    .join("");
  $("#blocker-list").classList.toggle("hidden", !sessions.length);
  $("#blocker-retry").onclick = () => location.reload();
}

let expiredShown = false;
function sessionExpired() {
  if (expiredShown) return;
  expiredShown = true;
  showBlocker(ctx?.session.host, true);
}
