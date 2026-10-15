// Detección de sesiones de Salesforce a partir de las cookies del navegador.
// La extensión reutiliza la sesión del usuario logueado, por lo que todas las
// llamadas a la API respetan sus permisos (perfil, permission sets, sharing y FLS).

import { L } from "./i18n.js";

// Dominios donde vive la cookie "sid" válida para la API, en orden de preferencia.
const API_DOMAINS = [
  "salesforce.com",
  "cloudforce.com",
  "salesforce.mil",
  "cloudforce.mil",
  "sfcrmproducts.cn",
  "salesforce-setup.com",
];

const SF_HOST_RE =
  /(^|\.)(salesforce\.com|force\.com|cloudforce\.com|salesforce-setup\.com|visualforce\.com|salesforce\.mil|force\.mil|cloudforce\.mil|sfcrmproducts\.cn|crmforce\.mil)$/i;

// Hosts públicos de salesforce.com que nunca representan una org.
const EXCLUDED_HOSTS = new Set([
  "salesforce.com",
  "www.salesforce.com",
  "help.salesforce.com",
  "login.salesforce.com",
  "test.salesforce.com",
  "trailhead.salesforce.com",
  "developer.salesforce.com",
  "appexchange.salesforce.com",
  "status.salesforce.com",
]);

const SID_RE = /^00D[a-zA-Z0-9]{12,15}!/;

export function isSalesforceHost(hostname) {
  return SF_HOST_RE.test(hostname || "");
}

const cleanDomain = (d) => d.replace(/^\./, "").toLowerCase();

function isUsable(cookie) {
  return SID_RE.test(cookie.value) && !EXCLUDED_HOSTS.has(cleanDomain(cookie.domain));
}

// Preferimos los dominios "My Domain" (*.my.salesforce.com) para hablar con la API.
function score(cookie) {
  const d = cleanDomain(cookie.domain);
  if (d.endsWith(".my.salesforce.com")) return 3;
  if (d.endsWith("salesforce-setup.com")) return 1;
  return 2;
}

function toSession(cookie) {
  return { host: cleanDomain(cookie.domain), sid: cookie.value, orgId: cookie.value.split("!")[0] };
}

function isDirectApiDomain(domain) {
  const d = cleanDomain(domain);
  return API_DOMAINS.slice(0, 5).some((api) => d === api || d.endsWith("." + api));
}

async function findSessionForOrg(orgId) {
  for (const domain of API_DOMAINS) {
    const cookies = await chrome.cookies.getAll({ name: "sid", domain, secure: true });
    const matches = cookies.filter((c) => isUsable(c) && c.value.startsWith(orgId + "!"));
    if (matches.length) {
      matches.sort((a, b) => score(b) - score(a));
      return toSession(matches[0]);
    }
  }
  return null;
}

/**
 * Devuelve { host, sid, orgId } listo para la API a partir de cualquier host de
 * Salesforce (Lightning, Setup, Visualforce, My Domain...). null si no hay sesión.
 */
export async function getSessionForHost(hostname) {
  if (!hostname) return null;
  let cookie = null;
  try {
    cookie = await chrome.cookies.get({ url: `https://${hostname}`, name: "sid" });
  } catch {
    cookie = null;
  }
  if (!cookie || !isUsable(cookie)) return null;
  if (isDirectApiDomain(cookie.domain) && score(cookie) >= 2) return toSession(cookie);
  // Lightning / Visualforce / Setup: buscamos la cookie de la misma org en el dominio de la API.
  return (await findSessionForOrg(cookie.value.split("!")[0])) || null;
}

/** Lista todas las orgs con una sesión activa en el navegador (sin exponer el sid). */
export async function listSessions() {
  const byOrg = new Map();
  for (const domain of API_DOMAINS) {
    let cookies = [];
    try {
      cookies = await chrome.cookies.getAll({ name: "sid", domain, secure: true });
    } catch {
      continue;
    }
    for (const c of cookies) {
      if (!isUsable(c)) continue;
      const s = toSession(c);
      const prev = byOrg.get(s.orgId);
      if (!prev || score(c) > prev.score) byOrg.set(s.orgId, { host: s.host, orgId: s.orgId, score: score(c) });
    }
  }
  return [...byOrg.values()].map(({ host, orgId }) => ({ host, orgId, ...describeHost(host) }));
}

/** Pistas rápidas a partir del hostname (la app luego confirma con la API). */
export function describeHost(host) {
  const h = (host || "").toLowerCase();
  const sub = h.split(".")[0] || h;
  let kind = "Org";
  let kindKey = "org";
  if (h.includes(".sandbox.")) [kind, kindKey] = ["Sandbox", "sandbox"];
  else if (h.includes(".scratch.")) [kind, kindKey] = ["Scratch", "scratch"];
  else if (h.includes(".develop.") || sub.endsWith("-dev-ed")) [kind, kindKey] = ["Developer", "dev"];
  else if (h.includes(".trailblaze.")) [kind, kindKey] = ["Trailhead", "dev"];
  else if (h.includes(".demo.")) [kind, kindKey] = ["Demo", "trial"];
  else if (h.endsWith(".my.salesforce.com")) [kind, kindKey] = [L("Producción", "Production"), "prod"];
  const name = sub.replace(/-dev-ed$/, "").replace(/--/g, " · ");
  return { name, kind, kindKey };
}

/** Host de Lightning para abrir records/setup sin redirecciones intermedias. */
export function lightningHost(apiHost) {
  return apiHost.endsWith(".my.salesforce.com")
    ? apiHost.replace(/\.my\.salesforce\.com$/, ".lightning.force.com")
    : apiHost;
}
