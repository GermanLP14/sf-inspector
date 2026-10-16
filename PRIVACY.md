# Política de privacidad — OrgGadget – Toolkit for Salesforce

_Última actualización: 16 de octubre de 2026_

OrgGadget ("la extensión") es una herramienta para explorar la metadata y los registros de organizaciones de Salesforce a las que el usuario ya tiene acceso.

## Qué datos usa la extensión

- **Cookie de sesión de Salesforce (`sid`)**: la extensión la lee del navegador para llamar a la API de Salesforce **en nombre del usuario y con sus mismos permisos**. Se usa únicamente en memoria, no se guarda en disco ni se envía a ningún otro destino que no sea la propia org de Salesforce del usuario.
- **Metadata y registros de Salesforce**: se muestran en pantalla y se mantienen solo en memoria mientras la pestaña está abierta. Las modificaciones que el usuario hace se envían directamente a su org de Salesforce.
- **Preferencias locales** (idioma, tema, modo, últimos tipos/objetos abiertos): se guardan en el almacenamiento local del navegador (`chrome.storage.local` / `localStorage`) y nunca salen del dispositivo.

## Qué NO hace la extensión

- No envía datos a servidores del desarrollador ni de terceros. Todas las solicitudes de red van exclusivamente a dominios de Salesforce.
- No vende, comparte ni transfiere datos de usuarios.
- No usa los datos para publicidad, analítica, perfiles de usuario ni para evaluar solvencia crediticia.
- No ejecuta código remoto.

## Permisos

- `cookies` y permisos de host sobre dominios de Salesforce: para reutilizar la sesión activa del usuario y comunicarse con la API de su org.
- `storage`: para guardar las preferencias locales.
- `activeTab`: para detectar en qué org está la pestaña actual cuando el usuario abre la extensión.

OrgGadget no está afiliado ni respaldado por Salesforce, Inc. Salesforce es una marca registrada de Salesforce, Inc.

## Contacto

Para consultas sobre privacidad o soporte, abre un issue en https://github.com/GermanLP14/sf-inspector/issues

---

# Privacy Policy — OrgGadget – Toolkit for Salesforce

_Last updated: October 16, 2026_

OrgGadget ("the extension") is a tool to explore the metadata and records of Salesforce orgs the user already has access to.

**Data used.** The Salesforce session cookie (`sid`) is read from the browser to call the Salesforce API on the user's behalf and with the user's own permissions; it is used only in memory and is only ever sent to the user's own Salesforce org. Salesforce metadata and records are displayed and kept in memory only; edits are sent directly to the user's org. Local preferences (language, theme, recently opened items) are stored in the browser's local storage and never leave the device.

**What the extension does not do.** It does not send data to the developer's or any third-party servers (all network requests go exclusively to Salesforce domains); it does not sell, share or transfer user data; it does not use data for advertising, analytics, profiling or creditworthiness; it does not run remote code.

**Permissions.** `cookies` and host permissions on Salesforce domains (reuse the user's active session and talk to their org's API), `storage` (local preferences), `activeTab` (detect which org the current tab belongs to).

**Not affiliated with Salesforce, Inc.** Salesforce is a trademark of Salesforce, Inc.

**Contact.** For privacy questions or support, open an issue at https://github.com/GermanLP14/sf-inspector/issues
