// Inicio de sesión con credenciales guardadas (corre en el service worker).
//
// Abre la página de login de Salesforce en una pestaña, completa usuario y contraseña y envía el
// formulario, como un gestor de contraseñas. Si Salesforce pide verificación (código, MFA), la
// completa el usuario en esa pestaña. Al entrar, aprende el dominio y deja al usuario en el home de la org.
//
// Sin preguntar el tipo de org: prueba producción (login.salesforce.com) y sandbox
// (test.salesforce.com) en el orden más probable según el usuario; si uno rechaza las credenciales,
// pasa al otro. Cuando ya conoce el dominio (My Domain), entra directo por ahí.
//
// El estado de cada login vive en chrome.storage.session, así sobrevive a que Chrome suspenda el worker.
import { getSessionForHost, lightningHost } from "./session.js";
import { listCreds, getPassword, updateCred } from "./vault.js";

const TIMEOUT = 5 * 60 * 1000; // margen para completar códigos de verificación
const flowKey = (tabId) => `login:${tabId}`;
const TLDS = new Set(["com", "net", "org", "io", "edu", "gov", "info", "biz", "co", "app", "ai", "tech"]);

/** Los usuarios de sandbox suelen terminar en «.nombresandbox» (ej. juan@empresa.com.uat). */
export function looksLikeSandbox(username) {
  const last = String(username).split("@").pop().split(".").pop().toLowerCase();
  return !(last.length === 2 || TLDS.has(last));
}

const urlFor = (stage, cred) =>
  stage === "domain" ? `https://${cred.domain}/` : stage === "sandbox" ? "https://test.salesforce.com/" : "https://login.salesforce.com/";

const LOGIN_HOSTS = new Set(["login.salesforce.com", "test.salesforce.com"]);
const isSalesforce = (h) => /(^|\.)(salesforce\.com|force\.com|salesforce-setup\.com|visualforce\.com)$/i.test(h);

/** ¿Ya está dentro de la org (y no en el login ni en una verificación)? */
function isAppPage(url) {
  const h = url.hostname;
  if (LOGIN_HOSTS.has(h)) return false;
  if (h.endsWith(".lightning.force.com")) return true;
  return /\.(my\.salesforce|salesforce-setup)\.com$/i.test(h) && url.pathname !== "/" && !/^\/(secur|_ui\/identity|_nc_external|login|_ui\/system\/security)/i.test(url.pathname);
}

async function getFlow(tabId) {
  return (await chrome.storage.session.get(flowKey(tabId)))[flowKey(tabId)] || null;
}
const setFlow = (tabId, flow) => chrome.storage.session.set({ [flowKey(tabId)]: flow });
const clearFlow = (tabId) => chrome.storage.session.remove(flowKey(tabId));

async function inject(tabId, func, args = []) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return res?.result;
  } catch {
    return null;
  }
}

/**
 * Se ejecuta DENTRO de la página de login (solo en pestañas abiertas por este flujo); por eso no usa
 * nada de afuera. mode "probe": qué campos hay y si Salesforce muestra un error. mode "fill": completa.
 *
 * Soporta las dos pantallas de Salesforce:
 *  - clásica: usuario y contraseña juntos;
 *  - en dos pasos: primero el usuario («Log In to Sandbox») y después la contraseña, que aparece en
 *    otra página o en la misma (en ese caso espera a que aparezca y la completa).
 * Busca también dentro de shadow DOM (las pantallas nuevas usan componentes).
 */
export async function loginStep(mode, username, password) {
  const all = (sel, root = document, out = []) => {
    root.querySelectorAll(sel).forEach((e) => out.push(e));
    root.querySelectorAll("*").forEach((e) => e.shadowRoot && all(sel, e.shadowRoot, out));
    return out;
  };
  const visible = (e) => !!e && e.type !== "hidden" && !e.disabled && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const first = (sels) => {
    for (const s of sels) {
      const e = all(s).find(visible);
      if (e) return e;
    }
    return null;
  };
  const findUser = () => first(["#username", 'input[name="username"]', 'input[autocomplete="username"]', 'input[type="email"]']);
  const findPass = () => first(["#password", 'input[name="pw"]', 'input[type="password"]']);
  const findBtn = () => first(["#Login", 'button[type="submit"]', 'input[type="submit"]', 'button[name="Login"]']);
  const errorText = () => {
    for (const s of ["#error", ".loginError", "#errorMsg", '[role="alert"]']) {
      const e = all(s).find((x) => visible(x) && x.textContent.trim());
      if (e) return e.textContent.trim().replace(/\s+/g, " ");
    }
    return "";
  };
  const user = findUser();
  const pass = findPass();
  if (mode === "probe") return { user: !!user, pass: !!pass, error: errorText() };

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const put = (el, v) => {
    el.focus();
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  };
  const submit = (from) => {
    const b = findBtn();
    if (b) b.click();
    else if (from?.form?.requestSubmit) from.form.requestSubmit();
    else from?.form?.submit();
  };
  if (pass) {
    // Si Salesforce recuerda a otro usuario, el campo de usuario puede estar oculto: se corrige igual.
    const userField = user || all("#username")[0] || all('input[name="username"]')[0];
    if (userField) put(userField, username);
    put(pass, password);
    submit(pass);
    return { did: "password" };
  }
  if (!user) return { did: "none" };
  put(user, username); // pisa cualquier usuario autocompletado o recordado
  submit(user);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const p = findPass();
    if (p) {
      put(p, password);
      submit(p);
      return { did: "password" };
    }
    const err = errorText();
    if (err) return { did: "username", error: err };
  }
  return { did: "username" };
}

/** ¿La sesión guardada en el navegador sigue viva? (la cookie puede existir aunque haya vencido) */
async function sessionAlive(s) {
  try {
    const r = await fetch(`https://${s.host}/services/oauth2/userinfo`, { headers: { Authorization: `Bearer ${s.sid}` }, credentials: "omit", cache: "no-store" });
    return r.ok;
  } catch {
    return false;
  }
}

const orgHome = (host) => `https://${lightningHost(host)}/lightning/page/home`;

/** Entra a la org de una credencial guardada. Si ya hay sesión viva, abre el home de la org directo. */
export async function startLogin(credId) {
  const cred = (await listCreds()).find((c) => c.id === credId);
  if (!cred) throw new Error("Credential not found");
  if (cred.domain) {
    const s = await getSessionForHost(cred.domain);
    if (s && (await sessionAlive(s))) {
      chrome.tabs.create({ url: orgHome(s.host), active: true });
      return { opened: s.host };
    }
  }
  const stages = cred.domain ? ["domain"] : looksLikeSandbox(cred.username) ? ["sandbox", "prod"] : ["prod", "sandbox"];
  await updateCred(credId, { lastError: null });
  chrome.action.setBadgeText({ text: "" });
  const tab = await chrome.tabs.create({ url: urlFor(stages[0], cred), active: true });
  await setFlow(tab.id, { credId, stages, step: 0, userDone: false, passDone: false, started: Date.now() });
  return { tabId: tab.id };
}

async function fail(tabId, flow, message) {
  await clearFlow(tabId);
  await updateCred(flow.credId, { lastError: message || "INVALID_LOGIN", lastErrorAt: Date.now() });
  chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  chrome.action.setBadgeText({ text: "!" });
}

/** Avanza el flujo cada vez que la pestaña de login termina de cargar una página. */
export async function onTabUpdated(tabId, info, tab) {
  if (info.status !== "complete" || !tab?.url) return;
  const flow = await getFlow(tabId);
  if (!flow) return;
  if (Date.now() - flow.started > TIMEOUT) return clearFlow(tabId);
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return;
  }
  if (!isSalesforce(url.hostname)) return; // fuera de Salesforce (p. ej. un proveedor SSO): se espera
  const cred = (await listCreds()).find((c) => c.id === flow.credId);
  if (!cred) return clearFlow(tabId);

  // Este entorno rechazó las credenciales: se prueba el siguiente (producción ↔ sandbox) o se avisa.
  const rejected = async (message) => {
    if (flow.step + 1 < flow.stages.length) {
      Object.assign(flow, { step: flow.step + 1, userDone: false, passDone: false });
      await setFlow(tabId, flow);
      await chrome.tabs.update(tabId, { url: urlFor(flow.stages[flow.step], cred) });
    } else await fail(tabId, flow, message);
  };
  const fill = async () => {
    let password;
    try {
      password = await getPassword(cred.id);
    } catch {
      await fail(tabId, flow, "VAULT_UNREADABLE");
      return null;
    }
    return inject(tabId, loginStep, ["fill", cred.username, password]);
  };

  const probe = await inject(tabId, loginStep, ["probe", "", ""]);
  if (probe && (probe.user || probe.pass)) {
    if (probe.error && (flow.userDone || flow.passDone)) return rejected(probe.error);
    if (probe.pass && !flow.passDone) {
      // Pantalla clásica, o el segundo paso (contraseña) del login en dos pasos.
      Object.assign(flow, { userDone: true, passDone: true });
      await setFlow(tabId, flow);
      await fill();
    } else if (probe.user && !probe.pass && !flow.userDone) {
      // Primer paso del login en dos pasos: solo el usuario.
      flow.userDone = true;
      await setFlow(tabId, flow);
      const r = await fill();
      if (r?.did === "password") {
        flow.passDone = true;
        await setFlow(tabId, flow);
      } else if (r?.error) return rejected(r.error);
    }
    return;
  }

  if (isAppPage(url)) {
    const s = await getSessionForHost(url.hostname);
    if (!s) return;
    await clearFlow(tabId);
    await updateCred(flow.credId, { domain: s.host, lastLogin: Date.now(), lastError: null });
    // Salesforce aterriza en la última página visitada o en la app por defecto: se lleva siempre al home.
    if (!(url.hostname.endsWith(".lightning.force.com") && url.pathname.startsWith("/lightning/page/home"))) chrome.tabs.update(tabId, { url: orgHome(s.host) });
  }
}

export const onTabRemoved = (tabId) => clearFlow(tabId);
