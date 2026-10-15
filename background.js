// Service worker: atajo de teclado para abrir el explorador y login con credenciales guardadas.
import { getSessionForHost, isSalesforceHost } from "./lib/session.js";
import { startLogin, onTabUpdated, onTabRemoved } from "./lib/login-flow.js";

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

// Login con credenciales guardadas: el panel lo pide y se cierra; el flujo sigue aquí.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "login") return;
  startLogin(msg.id).then(reply, (e) => reply({ error: e.message }));
  return true;
});

// Registrados en el nivel superior: despiertan al worker si Chrome lo suspendió durante el login.
chrome.tabs.onUpdated.addListener(onTabUpdated);
chrome.tabs.onRemoved.addListener(onTabRemoved);

// Si el panel tuvo que recargar la extensión (el worker anterior era una versión vieja),
// retoma el login que quedó pendiente.
(async () => {
  const { pendingLogin } = await chrome.storage.local.get("pendingLogin");
  if (!pendingLogin) return;
  await chrome.storage.local.remove("pendingLogin");
  if (Date.now() - pendingLogin.at < 60000) startLogin(pendingLogin.id).catch(() => {});
})();
