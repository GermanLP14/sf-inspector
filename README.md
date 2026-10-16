# OrgGadget – Toolkit for Salesforce

> Not affiliated with Salesforce, Inc. / No afiliado a Salesforce, Inc.

Extensión de navegador (Chrome / Edge, Manifest V3) para explorar rápidamente la **metadata** y la **data** de cualquier org de Salesforce (producción, sandbox, developer, scratch o trial), desde una pestaña propia.

## Instalación (modo desarrollador)

1. Abre `chrome://extensions` (o `edge://extensions`).
2. Activa **Modo de desarrollador**.
3. Haz click en **Cargar descomprimida** y elige la carpeta del proyecto (la que contiene `manifest.json`).
4. Fija el ícono de la extensión en la barra.

## Uso

1. Inicia sesión en tu org de Salesforce en una pestaña.
2. Haz click en el ícono de OrgGadget → **Explorar esta org** (o usa `Alt+Shift+O`).
3. Se abre una pestaña nueva con el explorador:
   - **Metadata**: escribe o elige un tipo (Flows, Apex Classes, Triggers, Validation Rules, Custom Fields, Layouts, Permission Sets, Reports…). Verás la lista con buscador y filtros por **objeto**, **tipo**, **estado** (activo/inactivo) y **fecha de modificación**. Click en un objeto de la tabla para filtrar por él.
   - **Data**: escribe o elige un objeto y verás sus records, con filtros por **nombre o Id**, **picklist** (Status/Stage detectado automáticamente, o cualquier otra), **solo mis registros**, y **rango de fechas** (creación, modificación o cualquier campo fecha) con atajos (Hoy, 7/30/90 días, este mes, este año). Click en las columnas para ordenar. Botón **SOQL** para ver o copiar la consulta.
4. Click en cualquier nombre → te lleva al record o a la metadata en Salesforce. El ícono de la barra superior alterna entre abrir en **pestaña nueva** o en **la misma pestaña**.

Atajos: `/` enfoca el buscador · `↑ ↓ Enter` navegar y abrir · `Esc` limpiar · `Alt+1` / `Alt+2` cambiar entre Metadata y Data.

## Últimos cambios

- **Nuevo nombre e ícono:** ahora se llama **OrgGadget – Toolkit for Salesforce** (nombre corto *OrgGadget*). El ícono es una lupa con el grafo de la org y una chispa; su fuente está en `tools/icon/`.
- **Solo orgs con sesión viva:** el popup y el selector de orgs verifican cada sesión con Salesforce y ocultan las expiradas o cerradas.
- **Búsqueda por Subject:** el buscador global y la lista de Cases encuentran casos por *Subject* (también con parte de una palabra y aunque el caso se haya creado hace un momento).
- **Registros relacionados:** la ficha de un registro tiene un botón *Related* que lista sus registros hijos con cantidades; queda deshabilitado si no tiene ninguno.
- **Piezas para la Chrome Web Store** en `store/` (capturas 1280×800, promos 440×280 y 1400×560, ícono 128×128), generadas con `tools/store/`.

## Novedades de la 0.5 — IDE integrado

- Botón `</>` en las listas de **Apex Classes, Apex Triggers, Visualforce Pages/Components, LWC y Aura** → abre el IDE.
- Editor **CodeMirror 6** con los colores de OrgGadget: números de línea, deshacer/rehacer, buscar y reemplazar (`Ctrl+F`), plegado, autocierre de llaves, sugerencias (`Ctrl+Space`), resaltado de Apex (incluido SOQL), JavaScript, HTML, CSS y XML.
- **Guardar en la org** (`Ctrl+S`):
  - Apex y Visualforce se compilan en Salesforce (igual que la Developer Console). Si hay errores, se subrayan en la línea exacta y aparecen en el panel de problemas. **Validar** compila sin guardar.
  - LWC y Aura: todos los archivos del bundle en un explorador lateral; se guardan los modificados.
- Protecciones: aviso si alguien modificó el componente después de abrirlo, confirmación en producción, guardado de Apex bloqueado en producción (Salesforce exige desplegar con tests), código de paquetes administrados en solo lectura y aviso al cerrar con cambios sin guardar.
- El editor (~200 KB comprimido) se carga **solo la primera vez que abres el IDE**, así que no afecta la velocidad del resto de la extensión.

### Regenerar el editor

El archivo `lib/vendor/codemirror.js` se genera desde `tools/codemirror`:

```
cd tools/codemirror
npm install
npm run build
```

CodeMirror es software libre (licencia MIT); los avisos de licencia están en `lib/vendor/THIRD_PARTY_LICENSES.txt`.

## Novedades de la 0.4 — Consola SOQL y exportación

- **Consola SOQL** (botón SOQL en Data y en Metadata, ícono `>_` de la barra superior o `Alt+Q`):
  - Modos **Data** (records, REST API) y **Metadata** (Tooling API; el interruptor *Tooling API* se apaga para objetos de metadata que se consultan por Data API, como `FlowDefinitionView`).
  - El **FROM se completa solo** con el objeto o tipo de metadata que estás viendo; el selector de objeto reescribe la query.
  - **Resultados en vivo** mientras escribes (se puede apagar), resaltado de sintaxis, **autocompletado** de objetos, campos y palabras clave (`Tab`), `Ctrl+Enter` para ejecutar e **historial** de las últimas 20 queries.
  - Click en un Id abre la ficha completa del registro; click en una celda la copia.
- **Exportar records** (solo Data: en la consola y en el encabezado de la vista Data): **Excel (.xlsx)** con encabezados, filtros y fechas reales, **CSV** (UTF-8), **JSON** y **copiar como tabla** para pegar en Excel o Google Sheets. Exporta todas las páginas de la query (hasta 100.000 registros; si la query tiene `LIMIT`, se respeta).
- El **idioma por defecto ahora es inglés** (se puede cambiar a español desde el selector).

## Novedades de la 0.3 — Ficha completa y edición de registros

- En **Data**, click en cualquier fila (o en el ícono 👁) abre la **ficha completa del registro** dentro de la extensión: todos los campos que tu usuario puede ver, agrupados en principales / custom / sistema, con buscador y filtros (con valor, editables, custom). Los lookups muestran el nombre y se abren en el mismo panel (con botón para volver).
- **Edición campo por campo**: el lápiz (o doble click) abre un editor según el tipo (texto, número, moneda, picklist, multi-picklist, checkbox, fecha, fecha/hora, hora, lookup por Id). Los cambios quedan marcados en ámbar y se guardan juntos con **Guardar** (o Ctrl+Enter); **Descartar** o ↺ los revierten.
- **Seguridad**: solo se muestran los campos que Salesforce devuelve para tu usuario (FLS). Un campo es editable solo si tu perfil puede editar el objeto, la FLS permite editar el campo y el sharing te da acceso de edición a ese registro (`UserRecordAccess`). Si no, aparece un candado con el motivo. Fórmulas, autonuméricos, campos de sistema y texto enriquecido son de solo lectura.
- Al guardar, Salesforce aplica validation rules, triggers y flows; si rechaza algo, el error se muestra junto al campo afectado y los cambios se conservan para corregirlos.

## Publicar en la Chrome Web Store

1. Ejecuta `package.ps1` → genera `OrgGadget-<versión>.zip` en el Escritorio (con rutas compatibles con la tienda).
2. Completa y publica `PRIVACY.md` en una URL pública (por ejemplo GitHub Pages).
3. Sube el ZIP en https://chrome.google.com/webstore/devconsole, completa la ficha (usa las capturas de `store/`), la pestaña de privacidad y envía a revisión.
4. Para cada actualización: sube la `version` en `manifest.json`, vuelve a empaquetar y sube el nuevo ZIP.

## Novedades de la 0.2

- **Agentforce**: nuevo grupo con *Agentes*, *Topics*, *Acciones* y *Prompt Templates*. Si la org no tiene Agentforce habilitado, la lista lo indica. Las acciones se validan contra Apex, flows y prompts existentes (acción que apunta a algo inexistente = conflicto; a un flow inactivo = advertencia). Los enlaces llevan al Setup de Agentforce / Prompt Builder (Salesforce no expone una URL estable por elemento).
- **Custom Metadata**: *Custom Metadata Types* (con acceso directo a sus registros en Data) y *Registros de Custom Metadata* (todos los registros de todos los tipos `__mdt`, filtrables por tipo).
- **Idioma**: selector Español / English en la barra superior (y en el popup). Traduce toda la interfaz, incluidas las explicaciones de conflictos. Cambiar el idioma recarga la vista manteniendo dónde estabas.
- **Listas en vivo**: la lista abierta se re-sincroniza sola cada 60 s y al volver a la pestaña (indicador *En vivo*; el botón ↻ sincroniza al instante). Lo creado en la org aparece arriba resaltado como *Nuevo*, lo editado parpadea y lo borrado desaparece, sin perder filtros ni scroll. En Data, si ya cargaste varias páginas, se ofrece un botón para actualizar en vez de mover la tabla. Los objetos nuevos se agregan al selector de objetos.

## Detección de conflictos en la metadata

Junto a cada nombre en las listas de metadata aparece un indicador:

- 🔴 **Conflicto**: un problema real o un choque con otra metadata (p. ej. dos triggers activos en el mismo objeto y evento).
- 🟠 **Advertencia**: un riesgo o una mala práctica (p. ej. flows sin orden de ejecución, Process Builder sin soporte).
- 🟢 **Sin conflictos**: pasó todas las verificaciones de su tipo.

Al hacer click se abre un panel con **por qué** ocurre, **con qué choca** (con enlaces a cada componente) y **cómo arreglarlo**. En el encabezado hay un resumen por severidad y en la barra un filtro de conflictos.

El análisis es **100 % por reglas (sin IA)**: es rápido, gratuito, reproducible y no saca datos de la org. Las reglas están en `lib/conflicts.js`:

| Tipo | Verificaciones |
|---|---|
| Apex Triggers | Varios triggers activos en el mismo objeto/evento · convivencia con flows y Workflow Rules del objeto · IsValid · versión de API |
| Apex Classes | Nombre que tapa una clase del sistema (`Database`, `Test`…) u objeto estándar · IsValid · versión de API |
| Flows | Orden de ejecución (Trigger Order) sin definir o repetido · convivencia con triggers · Process Builder sin soporte · versión activa ≠ última · labels duplicados |
| Workflow Rules | Sin soporte desde 31/12/2025 · re-ejecución de triggers/flows por field updates |
| Objetos / Fields | Cerca del límite de campos custom · campos homónimos entre namespaces · labels duplicados |
| Validation Rules | Reglas activas con el mismo mensaje en el mismo objeto |
| Otros (LWC, Aura, VF, Static Resources, Permission Set Groups, Approval Processes, Labels, Named Credentials, Reports…) | Versión de API, tamaño, estado de recálculo, procesos superpuestos, valores/endpoints/nombres duplicados |

Para agregar una regla: crea un objeto `{ label, run(rows, ctx) }` que llame a `add(row, { severity, title, why, related, fix })` y súmalo al tipo en `ANALYZERS`.

**¿Y la IA?** No hace falta para lo anterior. Solo aportaría en un análisis más profundo del *contenido* del código (p. ej. detectar SOQL dentro de loops, o explicar en lenguaje natural la lógica de un flow). Si se quisiera, se haría así: leer el cuerpo de la clase o la definición del flow vía Tooling API, enviarlo a un modelo (Claude) con la API key que el usuario configure en las opciones de la extensión, y mostrar la respuesta en el mismo panel. Esto implica enviar código de la org a un servicio externo, por lo que debería ser opcional y explícito.

## Permisos y seguridad

- La extensión **no guarda credenciales**. Reutiliza la cookie de sesión (`sid`) que ya existe en el navegador cuando estás logueado, y llama a la REST / Tooling API con ella.
- Por eso **todo respeta los permisos del usuario**: Salesforce aplica perfil, permission sets, sharing, CRUD y FLS en cada consulta. Si tu usuario no tiene acceso a un tipo de metadata (p. ej. sin "View Setup and Configuration"), verás un mensaje indicándolo.
- Las consultas son de solo lectura.
- El token de sesión nunca viaja en la URL; cada página lo vuelve a leer de las cookies.

## Estructura

```
manifest.json            Manifest V3
background.js            Atajo de teclado
popup/                   Panel del ícono: detecta la org actual y otras sesiones
app/                     Explorador (pestaña completa)
  record-panel.js        Ficha completa y edición de registros
  query-console.js       Consola SOQL
  code-ide.js            IDE (Apex, Visualforce, LWC, Aura)
  export-menu.js         Menú de exportación
  conflict-drawer.js     Panel de conflictos
  app.js                 Arranque, org, modos, navegación (#m=Tipo / #d=Objeto)
  metadata-view.js       Vista de metadata
  data-view.js           Vista de records
  combobox.js            Combobox con búsqueda + MultiSelect
  ui.js                  Íconos, formato, toasts, storage
lib/
  session.js             Detección de sesiones por cookies
  sfapi.js               Cliente REST/Tooling API
  metadata-types.js      Catálogo de tipos de metadata (queries, URLs)
  export.js              Exportación: XLSX (sin librerías), CSV, JSON, TSV
  code-deploy.js         Leer y guardar código vía Tooling API
  vendor/codemirror.js   Editor (generado desde tools/codemirror)
  i18n.js                Idioma (inglés por defecto / español)
styles/tokens.css        Colores y tema claro/oscuro
icons/                   Íconos de la extensión
store/                   Capturas 1280×800 para la ficha de la tienda
package.ps1              Genera el ZIP para publicar
tools/codemirror/        Fuente del bundle del editor (no se incluye en el ZIP)
PRIVACY.md               Borrador de política de privacidad
```

### Agregar un tipo de metadata

Agrega un objeto a `TYPES` en `lib/metadata-types.js` con `key`, `label`, `group`, `icon`, `color`, `queries` (Tooling `T()` o Data `D()`, con fallbacks), `map` (registro → fila) y `url` (fila → ruta de Salesforce). Si la fila tiene `object`, aparece el filtro por objeto automáticamente.

## Ideas para próximas versiones

- Búsqueda global (SOSL) en todos los objetos y todos los tipos de metadata a la vez.
- Selector de columnas y filtros por cualquier campo en Data.
- Ver el código de Apex/LWC/Flow inline y buscar texto dentro del código.
- "¿Dónde se usa?" (dependencias vía `MetadataComponentDependency`).
- Exportar resultados a CSV.
- Favoritos y búsquedas guardadas por org.
- Soporte para Firefox.
