// Service worker: atajo de teclado para abrir el explorador sobre la org de la pestaña actual.
import { getSessionForHost, isSalesforceHost } from "./lib/session.js";

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "open-explorer") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = null;
  try {
    const { hostname } = new URL(tab?.url || "");
    if (isSalesforceHost(hostname)) host = (await getSessionForHost(hostname))?.host || null;
  } catch {
    host = null;
  }
  chrome.tabs.create({
    url: chrome.runtime.getURL(`app/app.html${host ? `?host=${encodeURIComponent(host)}` : ""}`),
    index: tab ? tab.index + 1 : undefined,
  });
});

// Limpieza: borra lo que guardaba el login con credenciales (función retirada), incluidas las
// contraseñas cifradas y su clave, para que no quede nada de eso en el navegador.
chrome.storage.local.remove(["vault", "pendingLogin", "swReloadAt"]).catch(() => {});
try {
  indexedDB.deleteDatabase("orglens-vault");
} catch {
  /* sin IndexedDB: no hay nada que borrar */
}
chrome.action.setBadgeText({ text: "" }).catch(() => {});
