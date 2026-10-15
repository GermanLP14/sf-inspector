// Catálogo de atajos favoritos del panel (4 lugares, teclas 1–4).
// Cada atajo tiene un id «grupo:clave»:
//   tool:*  herramientas de Org Lens (abren el explorador con la herramienta abierta)
//   m:*     un tipo de metadata (abre su lista)          → app.html#m=<tipo>
//   d:*     un objeto de data (abre sus registros)        → app.html#d=<objeto>
//   sf:*    una página de Salesforce (abre la org)
import { TYPES } from "../lib/metadata-types.js";
import { L } from "../lib/i18n.js";

export const DEFAULT_FAVS = ["tool:soql", "tool:ide", "tool:schema", "tool:analytics"];
export const FAV_SLOTS = 4;

export const GROUPS = [
  { id: "tool", label: L("Herramientas de Org Lens", "Org Lens tools") },
  { id: "m", label: L("Metadata (abre la lista del tipo)", "Metadata (opens the type's list)") },
  { id: "d", label: L("Data (abre los registros)", "Data (opens the records)") },
  { id: "sf", label: L("Páginas de Salesforce", "Salesforce pages") },
];

const TOOLS = [
  { key: "soql", icon: "terminal", label: "SOQL", title: L("Consola SOQL", "SOQL console") },
  { key: "ide", icon: "code", label: "IDE", title: L("IDE: Apex, triggers, LWC…", "IDE: Apex, triggers, LWC…") },
  { key: "schema", icon: "network", label: "Schema", title: "Schema Builder" },
  { key: "analytics", icon: "bar-chart", label: L("Reportes", "Reports"), title: L("Reportes y dashboards", "Reports & dashboards") },
];

// Etiquetas cortas para que entren en el botón (el nombre completo va en el tooltip).
const SHORT = {
  ApexClass: "Apex",
  ApexTrigger: "Triggers",
  LightningComponentBundle: "LWC",
  AuraDefinitionBundle: "Aura",
  ApexPage: "VF Pages",
  ApexComponent: "VF Comp.",
  StaticResource: L("Recursos", "Resources"),
  CustomObject: L("Objetos", "Objects"),
  CustomField: L("Campos", "Fields"),
  CustomMetadataType: "CMDT",
  CustomMetadataRecord: L("CMDT reg.", "CMDT recs"),
  ValidationRule: L("Validaciones", "Validations"),
  RecordType: "Rec. Types",
  GlobalValueSet: L("Picklists", "Picklists"),
  DuplicateRule: L("Duplicados", "Duplicates"),
  FlexiPage: "Lightning Pg",
  CustomLabel: "Labels",
  EmailTemplate: "Emails",
  PermissionSet: "Perm Sets",
  PermissionSetGroup: "PS Groups",
  CustomPermission: "Custom Perm",
  NamedCredential: "Named Cred.",
  WorkflowRule: "Workflows",
  ApprovalProcess: L("Aprobaciones", "Approvals"),
  AssignmentRule: L("Asignación", "Assignment"),
  BotDefinition: L("Agentes", "Agents"),
  GenAiPlugin: "Topics",
  GenAiFunction: L("Acciones IA", "AI Actions"),
  GenAiPromptTemplate: "Prompts",
};

const DATA = [
  ["Account", "building", L("Cuentas", "Accounts")],
  ["Contact", "user", L("Contactos", "Contacts")],
  ["Opportunity", "trending", L("Oportunidades", "Opportunities"), L("Oportun.", "Opps")],
  ["Lead", "target", "Leads"],
  ["Case", "briefcase", L("Casos", "Cases")],
  ["Task", "check-circle", L("Tareas", "Tasks")],
  ["Campaign", "megaphone", L("Campañas", "Campaigns")],
  ["Product2", "box", L("Productos", "Products")],
  ["User", "users", L("Usuarios", "Users")],
];

export const SF_PAGES = {
  home: { icon: "app-window", label: "Home", title: L("Home de la org", "Org home"), path: "/lightning/page/home" },
  setup: { icon: "layers", label: "Setup", title: "Setup", path: "/lightning/setup/SetupOneHome/home" },
  objmgr: { icon: "box", label: "Obj. Manager", title: "Object Manager", path: "/lightning/setup/ObjectManager/home" },
  users: { icon: "users", label: L("Usuarios", "Users"), title: L("Usuarios (Setup)", "Users (Setup)"), path: "/lightning/setup/ManageUsers/home" },
  flows: { icon: "workflow", label: "Flows", title: L("Flows (Setup)", "Flows (Setup)"), path: "/lightning/setup/Flows/home" },
  devconsole: { icon: "terminal", label: "Dev Console", title: "Developer Console", path: "/_ui/common/apex/debug/ApexCSIPage" },
  deploys: { icon: "upload", label: "Deploys", title: L("Estado de deploys", "Deployment status"), path: "/lightning/setup/DeployStatus/home" },
  logs: { icon: "file-text", label: "Debug Logs", title: "Debug Logs", path: "/lightning/setup/ApexDebugLogs/home" },
};

let cache = null;

/** Todos los atajos disponibles: { id, group, icon, label (corta), title (completa) }. */
export function catalog() {
  cache ||= [
    ...TOOLS.map((t) => ({ id: `tool:${t.key}`, group: "tool", icon: t.icon, label: t.label, title: t.title })),
    ...TYPES.map((t) => ({ id: `m:${t.key}`, group: "m", icon: t.icon, label: SHORT[t.key] || t.label, title: t.label })),
    ...DATA.map(([name, ic, label, short]) => ({ id: `d:${name}`, group: "d", icon: ic, label: short || label, title: label })),
    ...Object.entries(SF_PAGES).map(([key, p]) => ({ id: `sf:${key}`, group: "sf", icon: p.icon, label: p.label, title: p.title })),
  ];
  return cache;
}

export const favById = (id) => catalog().find((f) => f.id === id) || null;

/** Normaliza lo guardado: 4 atajos válidos y sin repetir (completa con los de por defecto). */
export function normalizeFavs(list) {
  const out = [];
  for (const id of Array.isArray(list) ? list : []) if (favById(id) && !out.includes(id)) out.push(id);
  for (const id of DEFAULT_FAVS) if (out.length < FAV_SLOTS && !out.includes(id)) out.push(id);
  return out.slice(0, FAV_SLOTS);
}
