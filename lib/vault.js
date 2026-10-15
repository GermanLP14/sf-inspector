// Credenciales de orgs guardadas en este navegador.
//
// - La contraseña se cifra con AES-GCM. La clave se genera una sola vez como NO exportable y vive en
//   IndexedDB de la extensión: ningún script puede leerla en claro ni copiarla a otro equipo por la API.
// - Solo se guarda en chrome.storage.local (nunca en sync) y solo se descifra para completar
//   el formulario de login de Salesforce en una pestaña que abrió la propia extensión.
// - Límite honesto: quien tenga acceso a tu perfil de Chrome con la sesión abierta puede usarla.
const DB = "orglens-vault";
const STORE = "keys";
const KEY_ID = "main";
const LIST = "vault";

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function idb(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let keyPromise = null;
function cryptoKey() {
  keyPromise ||= (async () => {
    const db = await openDb();
    let key = await idb(db, "readonly", (s) => s.get(KEY_ID));
    if (!key) {
      key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      try {
        await idb(db, "readwrite", (s) => s.add(key, KEY_ID));
      } catch {
        key = await idb(db, "readonly", (s) => s.get(KEY_ID)); // otra vista la creó al mismo tiempo
      }
    }
    return key;
  })().catch((e) => {
    keyPromise = null;
    throw e;
  });
  return keyPromise;
}

async function encrypt(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(), enc.encode(text));
  return { iv: b64(iv), ct: b64(ct) };
}

async function decrypt(iv, ct) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await cryptoKey(), unb64(ct));
  return dec.decode(plain);
}

/** Lista sin contraseñas: [{ id, name, username, domain, lastLogin, lastError }] */
export async function listCreds() {
  const list = (await chrome.storage.local.get(LIST))[LIST] || [];
  return list.map(({ iv, ct, ...rest }) => rest);
}

async function readAll() {
  return (await chrome.storage.local.get(LIST))[LIST] || [];
}

async function writeAll(list) {
  await chrome.storage.local.set({ [LIST]: list });
}

const sameUser = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** Error al guardar un usuario que ya está guardado (el usuario de Salesforce es único en todas las orgs). */
export class DuplicateCredError extends Error {
  constructor(existing) {
    super("duplicate");
    this.existing = existing;
  }
}

/** Crea o actualiza. Si `password` viene vacío al editar, se conserva la anterior. */
export async function saveCred({ id = null, name, username, password = "", domain }) {
  const list = await readAll();
  const cur = id ? list.find((c) => c.id === id) : null;
  const dup = list.find((c) => c.id !== id && sameUser(c.username, username));
  if (dup) {
    const { iv, ct, ...safe } = dup;
    throw new DuplicateCredError(safe);
  }
  if (!cur && !password) throw new Error("password required");
  const rec = cur || { id: crypto.randomUUID(), createdAt: Date.now() };
  rec.name = name;
  rec.username = username;
  if (domain !== undefined) rec.domain = domain || null;
  if (password) Object.assign(rec, await encrypt(password));
  if (!cur) list.push(rec);
  await writeAll(list);
  const { iv, ct, ...safe } = rec;
  return safe;
}

export async function updateCred(id, patch) {
  const list = await readAll();
  const c = list.find((x) => x.id === id);
  if (!c) return;
  Object.assign(c, patch);
  await writeAll(list);
}

/**
 * Limpia duplicados de versiones anteriores (mismo usuario guardado dos veces): se queda con el que
 * ya conoce el dominio y, a igualdad, con el último usado. Devuelve cuántos quitó.
 */
export async function dedupeCreds() {
  const list = await readAll();
  const best = new Map();
  const score = (c) => (c.domain ? 2e13 : 0) + (c.lastLogin || c.createdAt || 0);
  for (const c of list) {
    const k = String(c.username).trim().toLowerCase();
    if (!best.has(k) || score(c) > score(best.get(k))) best.set(k, c);
  }
  const keep = list.filter((c) => best.get(String(c.username).trim().toLowerCase()) === c);
  if (keep.length !== list.length) await writeAll(keep);
  return list.length - keep.length;
}

export async function deleteCred(id) {
  await writeAll((await readAll()).filter((c) => c.id !== id));
}

export async function getPassword(id) {
  const c = (await readAll()).find((x) => x.id === id);
  if (!c?.ct) throw new Error("not found");
  return decrypt(c.iv, c.ct);
}
