# Privacy Policy — OrgGadget – Toolkit for Salesforce

_Last updated: October 16, 2026_

OrgGadget ("the extension") is a browser extension to explore and edit the metadata and records of Salesforce orgs that the user already has access to. This policy explains what data the extension uses, where it goes and what it never does.

## Summary

- The extension talks **only to your own Salesforce org**. It has no servers of its own and sends nothing to the developer or to any third party.
- It uses the Salesforce session you already have open in the browser, so it can only see and change what **your own Salesforce user** is allowed to.
- It stores only a few preferences locally in your browser.

## Data the extension uses

**Salesforce session cookie (`sid`).** When you open the extension, it reads the session cookie that Salesforce already set in your browser and uses it to call the Salesforce API on your behalf. The session is kept in memory only: it is never written to disk and is only ever sent to your own Salesforce org. The extension also uses it to check, with a minimal API call to your org, whether a session is still active before listing that org.

**Salesforce metadata and records.** Metadata (Apex, flows, objects, fields, reports, etc.) and records are fetched from your org, shown on screen and kept in memory while the extension's tab is open. Every request goes through Salesforce, which applies your profile, permission sets, sharing and field-level security.

**Changes you make.** When you explicitly save something (a record, code in the IDE, a report or dashboard, or a new field in the Schema Builder), the change is sent directly to your Salesforce org. Nothing is saved automatically.

**Exports.** When you export records, the file (Excel, CSV or JSON) is created in your browser and saved to your computer, or copied to your clipboard if you choose "Copy as table". It is not uploaded anywhere.

**Local preferences.** The following are stored in your browser's local extension storage (`chrome.storage.local` / `localStorage`) and never leave your device:

- language, theme and display settings;
- the last org you used and your recently opened metadata types and objects;
- your favorite shortcuts in the toolbar popup;
- the history of your last SOQL console queries (the query text, which may include values you typed in filters);
- the layout of your Schema Builder diagrams;
- IDE preferences.

You can delete all of it at any time by removing the extension or clearing its data from Chrome's settings.

## What the extension does not do

- It does not send data to the developer's servers or to any third-party server. All network requests go exclusively to Salesforce domains.
- It does not sell, share or transfer user data.
- It does not use data for advertising, analytics, tracking, user profiling or creditworthiness.
- It does not store your password or any other credentials.
- It does not load or run remote code: all of its code is included in the extension package.

## Permissions

- **`cookies` and host permissions on Salesforce domains** — to reuse your active Salesforce session and call your org's API.
- **`storage`** — to keep the local preferences listed above.
- **`activeTab`** — to detect which Salesforce org the current tab belongs to when you open the extension.

## Changes to this policy

If this policy changes, the new version will be published at this same address with an updated date.

## Contact

For privacy questions or support, open an issue at https://github.com/GermanLP14/sf-inspector/issues

OrgGadget is not affiliated with, sponsored or endorsed by Salesforce, Inc. Salesforce is a trademark of Salesforce, Inc.

---

# Política de privacidad (español)

_Última actualización: 16 de octubre de 2026_

OrgGadget ("la extensión") es una extensión de navegador para explorar y editar la metadata y los registros de las orgs de Salesforce a las que el usuario ya tiene acceso.

## Resumen

- La extensión se comunica **solo con tu propia org de Salesforce**. No tiene servidores propios y no envía nada al desarrollador ni a terceros.
- Usa la sesión de Salesforce que ya tienes abierta en el navegador, así que solo puede ver y modificar lo que **tu propio usuario de Salesforce** tiene permitido.
- Guarda únicamente algunas preferencias en tu navegador.

## Datos que usa la extensión

**Cookie de sesión de Salesforce (`sid`).** Al abrir la extensión, se lee la cookie de sesión que Salesforce ya creó en tu navegador y se usa para llamar a la API de Salesforce en tu nombre. La sesión se mantiene solo en memoria: nunca se guarda en disco y solo se envía a tu propia org. También se usa para comprobar, con una consulta mínima a tu org, si una sesión sigue activa antes de mostrar esa org.

**Metadata y registros de Salesforce.** Se obtienen de tu org, se muestran en pantalla y se mantienen en memoria mientras la pestaña de la extensión está abierta. Cada consulta pasa por Salesforce, que aplica tu perfil, permission sets, sharing y seguridad a nivel de campo.

**Cambios que haces.** Cuando guardas algo de forma explícita (un registro, código en el IDE, un reporte o dashboard, o un campo nuevo en el Schema Builder), el cambio se envía directamente a tu org. Nada se guarda automáticamente.

**Exportaciones.** Al exportar registros, el archivo (Excel, CSV o JSON) se genera en tu navegador y se guarda en tu computadora, o se copia al portapapeles si eliges "Copiar como tabla". No se sube a ningún lado.

**Preferencias locales.** Se guardan en el almacenamiento local de la extensión (`chrome.storage.local` / `localStorage`) y nunca salen de tu dispositivo: idioma, tema y opciones de visualización; la última org usada y los tipos de metadata y objetos abiertos recientemente; tus atajos favoritos del popup; el historial de tus últimas consultas de la consola SOQL (el texto de la consulta, que puede incluir valores que escribiste en filtros); la disposición de tus diagramas del Schema Builder; y preferencias del IDE. Puedes borrar todo en cualquier momento quitando la extensión o borrando sus datos desde la configuración de Chrome.

## Qué NO hace la extensión

- No envía datos a servidores del desarrollador ni de terceros. Todas las solicitudes de red van exclusivamente a dominios de Salesforce.
- No vende, comparte ni transfiere datos de usuarios.
- No usa los datos para publicidad, analítica, seguimiento, perfiles de usuario ni para evaluar solvencia crediticia.
- No guarda tu contraseña ni ninguna otra credencial.
- No carga ni ejecuta código remoto: todo su código está incluido en el paquete de la extensión.

## Permisos

- **`cookies` y permisos de host sobre dominios de Salesforce**: para reutilizar tu sesión activa de Salesforce y llamar a la API de tu org.
- **`storage`**: para guardar las preferencias locales indicadas arriba.
- **`activeTab`**: para detectar a qué org de Salesforce pertenece la pestaña actual cuando abres la extensión.

## Cambios en esta política

Si esta política cambia, la nueva versión se publicará en esta misma dirección con la fecha actualizada.

## Contacto

Para consultas sobre privacidad o soporte, abre un issue en https://github.com/GermanLP14/sf-inspector/issues

OrgGadget no está afiliado, patrocinado ni respaldado por Salesforce, Inc. Salesforce es una marca registrada de Salesforce, Inc.
