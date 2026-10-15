// Catálogo de tipos de metadata soportados.
// Cada tipo define cómo consultarlo (Tooling / Data API / describe), cómo mapear
// cada registro a una fila común y a qué URL de Salesforce lleva cada elemento.
//
// Fila común: { id, name, label, object, category, active, badges[], namespace,
//               lastModified, lastModifiedBy, url, dataObject }

import { L, locale } from "./i18n.js";

const setup = (page, id) => `/lightning/setup/${page}/page?address=${encodeURIComponent("/" + id)}`;
const objMgr = (obj, section, id) =>
  `/lightning/setup/ObjectManager/${encodeURIComponent(obj)}/${section}${id ? `/${id}` : ""}/view`;

const T = (soql) => ({ soql, tooling: true });
const D = (soql) => ({ soql, tooling: false });

const AUDIT = "NamespacePrefix, LastModifiedDate, LastModifiedBy.Name";

const audit = (r) => ({
  id: r.Id,
  namespace: r.NamespacePrefix || null,
  lastModified: r.LastModifiedDate || null,
  lastModifiedBy:
    r.LastModifiedBy && typeof r.LastModifiedBy === "object" ? r.LastModifiedBy.Name : r.LastModifiedBy || null,
});

const withNs = (r, name) => (r.NamespacePrefix ? `${r.NamespacePrefix}__${name}` : name);
const version = (r) => (r.ApiVersion ? [`v${r.ApiVersion}`] : []);
/** "EinsteinServiceAgent" → "Einstein Service Agent" */
const humanize = (s) => (s ? String(s).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ") : null);

const OBJECT_LABEL = L("Objeto", "Object");

const FLOW_PROCESS = {
  Flow: "Screen Flow",
  AutoLaunchedFlow: "Autolaunched Flow",
  Workflow: "Process Builder",
  CustomEvent: "Process Builder",
  InvocableProcess: "Process Builder",
  Orchestrator: "Orchestration",
  ContactRequestFlow: "Contact Request Flow",
  FieldServiceMobile: "Field Service Mobile",
  FieldServiceWeb: "Field Service Web",
  Survey: "Survey",
  Appointments: "Appointments",
};
const FLOW_TRIGGER = {
  RecordAfterSave: "Record-Triggered",
  RecordBeforeSave: "Record-Triggered",
  RecordBeforeDelete: "Record-Triggered",
  Scheduled: "Schedule-Triggered",
  PlatformEvent: "Platform Event",
};
const FLOW_TIMING = { RecordAfterSave: "After save", RecordBeforeSave: "Before save", RecordBeforeDelete: "Before delete" };
const FLOW_RECORD_EVENT = {
  Create: L("Al crear", "On create"),
  Update: L("Al actualizar", "On update"),
  CreateAndUpdate: L("Crear o actualizar", "Create or update"),
  Delete: L("Al eliminar", "On delete"),
};
const PB_TYPES = new Set(["Workflow", "CustomEvent", "InvocableProcess"]);

const TRIGGER_EVENTS = [
  ["UsageBeforeInsert", "before insert"],
  ["UsageAfterInsert", "after insert"],
  ["UsageBeforeUpdate", "before update"],
  ["UsageAfterUpdate", "after update"],
  ["UsageBeforeDelete", "before delete"],
  ["UsageAfterDelete", "after delete"],
  ["UsageAfterUndelete", "after undelete"],
];

const NON_DATA_OBJECTS = /(Share|History|Feed|ChangeEvent|Tag|__hd)$/;

export const TYPE_GROUPS = [
  { id: "code", label: L("Código", "Code") },
  { id: "automation", label: L("Automatización", "Automation") },
  { id: "agentforce", label: "Agentforce" },
  { id: "objects", label: L("Objetos y campos", "Objects and fields") },
  { id: "ui", label: L("Interfaz", "User interface") },
  { id: "security", label: L("Seguridad y acceso", "Security and access") },
  { id: "analytics", label: L("Analítica y otros", "Analytics and more") },
];

const AGENTFORCE_HOME = "/lightning/setup/EinsteinCopilot/home";

/** Carga los registros de todos los Custom Metadata Types visibles. */
async function loadCustomMetadataRecords(api, signal) {
  const types = (await api.describeGlobal()).filter((s) => s.name.endsWith("__mdt") && s.queryable);
  const out = [];
  let withModstamp = true;
  let firstError = null;
  let ok = 0;
  const queue = [...types];
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      const base = `Id, DeveloperName, MasterLabel, NamespacePrefix`;
      try {
        let recs;
        if (withModstamp) {
          try {
            recs = await api.queryAll(`SELECT ${base}, SystemModstamp FROM ${t.name}`, { signal });
          } catch (e) {
            if (e.name === "AbortError") throw e;
            withModstamp = false;
          }
        }
        if (!recs) recs = await api.queryAll(`SELECT ${base} FROM ${t.name}`, { signal });
        recs.forEach((r) => out.push({ ...r, _type: t.name, _typeLabel: t.label }));
        ok++;
      } catch (e) {
        if (e.name === "AbortError" || e.status === 401) throw e;
        firstError ||= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, types.length) }, worker));
  if (types.length && !ok && firstError) throw firstError;
  return out;
}

export const TYPES = [
  // ───────────── Código
  {
    key: "ApexClass",
    label: "Apex Classes",
    group: "code",
    icon: "code",
    color: "#6366f1",
    description: L("Clases Apex y tests", "Apex classes and tests"),
    keywords: "apex clase class code codigo",
    queries: [
      T(`SELECT Id, Name, Status, ApiVersion, LengthWithoutComments, IsValid, ${AUDIT} FROM ApexClass`),
      T(`SELECT Id, Name, Status, ApiVersion, LengthWithoutComments, ${AUDIT} FROM ApexClass`),
      T(`SELECT Id, Name, Status, ApiVersion, NamespacePrefix, LastModifiedDate FROM ApexClass`),
    ],
    map: (r) => ({
      ...audit(r),
      name: r.Name,
      active: r.Status ? r.Status === "Active" : null,
      badges: [...version(r), ...(r.LengthWithoutComments ? [`${r.LengthWithoutComments.toLocaleString(locale)} chars`] : [])],
    }),
    url: (r) => setup("ApexClasses", r.id),
  },
  {
    key: "ApexTrigger",
    label: "Apex Triggers",
    group: "code",
    icon: "zap",
    color: "#f59e0b",
    description: L("Triggers por objeto y evento", "Triggers by object and event"),
    objectLabel: OBJECT_LABEL,
    keywords: "apex trigger disparador",
    queries: [
      T(
        `SELECT Id, Name, TableEnumOrId, Status, ApiVersion, IsValid, ${TRIGGER_EVENTS.map((e) => e[0]).join(", ")}, ${AUDIT} FROM ApexTrigger`
      ),
      T(
        `SELECT Id, Name, TableEnumOrId, Status, ApiVersion, ${TRIGGER_EVENTS.map((e) => e[0]).join(", ")}, ${AUDIT} FROM ApexTrigger`
      ),
      T(`SELECT Id, Name, TableEnumOrId, Status, ApiVersion, NamespacePrefix, LastModifiedDate FROM ApexTrigger`),
    ],
    map: (r) => ({
      ...audit(r),
      name: r.Name,
      object: r.TableEnumOrId,
      active: r.Status ? r.Status === "Active" : null,
      badges: [...TRIGGER_EVENTS.filter(([f]) => r[f]).map(([, l]) => l), ...version(r)],
    }),
    url: (r) => setup("ApexTriggers", r.id),
  },
  {
    key: "LightningComponentBundle",
    label: "Lightning Web Components",
    group: "code",
    icon: "component",
    color: "#0ea5e9",
    description: L("Componentes LWC", "LWC components"),
    keywords: "lwc lightning web component componente",
    queries: [
      T(`SELECT Id, DeveloperName, MasterLabel, ApiVersion, IsExposed, ${AUDIT} FROM LightningComponentBundle`),
      T(`SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, LastModifiedDate FROM LightningComponentBundle`),
    ],
    map: (r) => ({
      ...audit(r),
      name: withNs(r, r.DeveloperName),
      label: r.MasterLabel,
      badges: [...version(r), ...(r.IsExposed ? [L("Expuesto", "Exposed")] : [])],
    }),
    url: (r) => setup("LightningComponentBundles", r.id),
  },
  {
    key: "AuraDefinitionBundle",
    label: "Aura Components",
    group: "code",
    icon: "sparkle",
    color: "#8b5cf6",
    description: L("Componentes Aura", "Aura components"),
    keywords: "aura lightning component componente",
    queries: [
      T(`SELECT Id, DeveloperName, MasterLabel, ApiVersion, ${AUDIT} FROM AuraDefinitionBundle`),
      T(`SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, LastModifiedDate FROM AuraDefinitionBundle`),
    ],
    map: (r) => ({ ...audit(r), name: withNs(r, r.DeveloperName), label: r.MasterLabel, badges: version(r) }),
    url: (r) => setup("LightningComponentBundles", r.id),
  },
  {
    key: "ApexPage",
    label: "Visualforce Pages",
    group: "code",
    icon: "file-code",
    color: "#14b8a6",
    description: L("Páginas Visualforce", "Visualforce pages"),
    keywords: "visualforce vf page pagina",
    queries: [
      D(`SELECT Id, Name, MasterLabel, ApiVersion, ControllerType, ${AUDIT} FROM ApexPage`),
      D(`SELECT Id, Name, MasterLabel, NamespacePrefix, LastModifiedDate FROM ApexPage`),
    ],
    map: (r) => ({ ...audit(r), name: r.Name, label: r.MasterLabel, badges: version(r) }),
    url: (r) => setup("ApexPages", r.id),
  },
  {
    key: "ApexComponent",
    label: "Visualforce Components",
    group: "code",
    icon: "file-box",
    color: "#06b6d4",
    description: L("Componentes Visualforce", "Visualforce components"),
    keywords: "visualforce vf component componente",
    queries: [
      D(`SELECT Id, Name, MasterLabel, ApiVersion, ${AUDIT} FROM ApexComponent`),
      D(`SELECT Id, Name, MasterLabel, NamespacePrefix, LastModifiedDate FROM ApexComponent`),
    ],
    map: (r) => ({ ...audit(r), name: r.Name, label: r.MasterLabel, badges: version(r) }),
    url: (r) => setup("ApexComponents", r.id),
  },
  {
    key: "StaticResource",
    label: "Static Resources",
    group: "code",
    icon: "package",
    color: "#84cc16",
    description: L("Archivos, librerías JS/CSS, imágenes", "Files, JS/CSS libraries, images"),
    keywords: "static resource recurso estatico zip js css",
    queries: [D(`SELECT Id, Name, ContentType, BodyLength, ${AUDIT} FROM StaticResource`)],
    map: (r) => ({
      ...audit(r),
      name: r.Name,
      category: r.ContentType || null,
      badges: r.BodyLength ? [`${Math.max(1, Math.round(r.BodyLength / 1024)).toLocaleString(locale)} KB`] : [],
    }),
    url: (r) => setup("StaticResources", r.id),
  },

  // ───────────── Automatización
  {
    key: "Flow",
    label: "Flows",
    group: "automation",
    icon: "workflow",
    color: "#10b981",
    description: L("Flows, record-triggered y Process Builders", "Flows, record-triggered and Process Builders"),
    objectLabel: L("Objeto disparador", "Triggering object"),
    keywords: "flow flujo process builder automatizacion automation record triggered",
    queries: [
      D(
        "SELECT DurableId, ApiName, Label, ProcessType, TriggerType, RecordTriggerType, TriggerObjectOrEventLabel, TriggerObjectOrEventId, TriggerOrder, IsActive, ActiveVersionId, LatestVersionId, NamespacePrefix, LastModifiedDate, LastModifiedBy FROM FlowDefinitionView"
      ),
      D(
        "SELECT DurableId, ApiName, Label, ProcessType, TriggerType, RecordTriggerType, TriggerObjectOrEventLabel, TriggerOrder, IsActive, ActiveVersionId, LatestVersionId, NamespacePrefix, LastModifiedDate, LastModifiedBy FROM FlowDefinitionView"
      ),
      D(
        "SELECT DurableId, ApiName, Label, ProcessType, TriggerType, RecordTriggerType, TriggerObjectOrEventLabel, IsActive, ActiveVersionId, LatestVersionId, NamespacePrefix, LastModifiedDate, LastModifiedBy FROM FlowDefinitionView"
      ),
      D(
        "SELECT DurableId, ApiName, Label, ProcessType, TriggerType, IsActive, ActiveVersionId, LatestVersionId, NamespacePrefix, LastModifiedDate, LastModifiedBy FROM FlowDefinitionView"
      ),
      T("SELECT Id, DeveloperName, MasterLabel, ActiveVersionId, LatestVersionId, NamespacePrefix, LastModifiedDate FROM FlowDefinition"),
    ],
    map: (r) => {
      const isView = !!r.DurableId;
      const category = r.TriggerType ? FLOW_TRIGGER[r.TriggerType] || r.TriggerType : FLOW_PROCESS[r.ProcessType] || r.ProcessType || null;
      const badges = [];
      if (FLOW_TIMING[r.TriggerType]) badges.push(FLOW_TIMING[r.TriggerType]);
      if (FLOW_RECORD_EVENT[r.RecordTriggerType]) badges.push(FLOW_RECORD_EVENT[r.RecordTriggerType]);
      return {
        ...audit(r),
        id: isView ? r.DurableId : r.Id,
        name: isView ? withNs(r, r.ApiName) : withNs(r, r.DeveloperName),
        label: isView ? r.Label : r.MasterLabel,
        object: r.TriggerObjectOrEventLabel || null,
        objectApi: r.TriggerObjectOrEventId || null,
        category,
        active: isView ? !!r.IsActive : !!r.ActiveVersionId,
        badges,
        _versionId: r.ActiveVersionId || r.LatestVersionId,
        _isPB: PB_TYPES.has(r.ProcessType),
      };
    },
    url: (r) =>
      r._versionId && !r._isPB
        ? `/builder_platform_interaction/flowBuilder.app?flowId=${r._versionId}`
        : setup("Flows", r.id),
  },
  {
    key: "WorkflowRule",
    label: "Workflow Rules",
    group: "automation",
    icon: "repeat",
    color: "#f97316",
    description: L("Reglas de flujo de trabajo (legacy)", "Workflow rules (legacy)"),
    objectLabel: OBJECT_LABEL,
    keywords: "workflow rule regla flujo trabajo",
    queries: [
      T(`SELECT Id, Name, TableEnumOrId, ${AUDIT} FROM WorkflowRule`),
      T("SELECT Id, Name, TableEnumOrId, NamespacePrefix, LastModifiedDate FROM WorkflowRule"),
    ],
    map: (r) => ({ ...audit(r), name: r.Name, object: r.TableEnumOrId }),
    url: (r) => setup("WorkflowRules", r.id),
  },
  {
    key: "ApprovalProcess",
    label: "Approval Processes",
    group: "automation",
    icon: "check-circle",
    color: "#22c55e",
    description: L("Procesos de aprobación", "Approval processes"),
    objectLabel: OBJECT_LABEL,
    keywords: "approval process aprobacion",
    queries: [
      D(`SELECT Id, Name, DeveloperName, TableEnumOrId, State, ${AUDIT} FROM ProcessDefinition WHERE Type = 'Approval'`),
    ],
    map: (r) => ({
      ...audit(r),
      name: r.DeveloperName || r.Name,
      label: r.Name,
      object: r.TableEnumOrId,
      active: r.State ? r.State === "Active" : null,
      badges: r.State && r.State !== "Active" && r.State !== "Inactive" ? [r.State] : [],
    }),
    url: (r) => setup("ApprovalProcesses", r.id),
  },
  {
    key: "AssignmentRule",
    label: "Assignment Rules",
    group: "automation",
    icon: "git-merge",
    color: "#eab308",
    description: L("Reglas de asignación de Leads y Casos", "Lead and Case assignment rules"),
    objectLabel: OBJECT_LABEL,
    keywords: "assignment rule asignacion regla lead case",
    queries: [D("SELECT Id, Name, SobjectType, Active, LastModifiedDate, LastModifiedBy.Name FROM AssignmentRule")],
    map: (r) => ({ ...audit(r), name: r.Name, object: r.SobjectType, active: !!r.Active }),
    url: (r) => setup(r.object === "Case" ? "CaseRules" : "LeadRules", r.id),
  },

  // ───────────── Agentforce
  {
    key: "BotDefinition",
    label: L("Agentes de Agentforce", "Agentforce Agents"),
    group: "agentforce",
    icon: "bot",
    color: "#0176d3",
    description: L("Agentes de IA y bots de Einstein", "AI agents and Einstein bots"),
    keywords: "agentforce agent agente copilot bot einstein ia ai",
    queries: [
      D(`SELECT Id, DeveloperName, MasterLabel, AgentType, Description, ${AUDIT} FROM BotDefinition`),
      D(`SELECT Id, DeveloperName, MasterLabel, Description, ${AUDIT} FROM BotDefinition`),
      D("SELECT Id, DeveloperName, MasterLabel, LastModifiedDate FROM BotDefinition"),
      T("SELECT Id, DeveloperName, MasterLabel, LastModifiedDate FROM BotDefinition"),
    ],
    map: (r) => ({
      ...audit(r),
      name: withNs(r, r.DeveloperName),
      label: r.MasterLabel,
      category: humanize(r.AgentType) || null,
    }),
    url: () => AGENTFORCE_HOME,
  },
  {
    key: "GenAiPlugin",
    label: L("Topics de Agentforce", "Agentforce Topics"),
    group: "agentforce",
    icon: "messages",
    color: "#2563eb",
    description: L("Temas que agrupan instrucciones y acciones", "Topics that group instructions and actions"),
    keywords: "agentforce topic tema plugin genai",
    queries: [
      T(`SELECT Id, DeveloperName, MasterLabel, Description, ${AUDIT} FROM GenAiPluginDefinition`),
      D(`SELECT Id, DeveloperName, MasterLabel, Description, ${AUDIT} FROM GenAiPluginDefinition`),
      T("SELECT Id, DeveloperName, MasterLabel, LastModifiedDate FROM GenAiPluginDefinition"),
      D("SELECT Id, DeveloperName, MasterLabel, LastModifiedDate FROM GenAiPluginDefinition"),
    ],
    map: (r) => ({ ...audit(r), name: withNs(r, r.DeveloperName), label: r.MasterLabel }),
    url: () => AGENTFORCE_HOME,
  },
  {
    key: "GenAiFunction",
    label: L("Acciones de Agentforce", "Agentforce Actions"),
    group: "agentforce",
    icon: "wand",
    color: "#7c3aed",
    description: L("Acciones que ejecutan Apex, flows o prompts", "Actions that run Apex, flows or prompts"),
    keywords: "agentforce action accion function genai invocable",
    queries: [
      T(`SELECT Id, DeveloperName, MasterLabel, Description, InvocationTarget, InvocationTargetType, ${AUDIT} FROM GenAiFunctionDefinition`),
      D(`SELECT Id, DeveloperName, MasterLabel, Description, InvocationTarget, InvocationTargetType, ${AUDIT} FROM GenAiFunctionDefinition`),
      T("SELECT Id, DeveloperName, MasterLabel, LastModifiedDate FROM GenAiFunctionDefinition"),
      D("SELECT Id, DeveloperName, MasterLabel, LastModifiedDate FROM GenAiFunctionDefinition"),
    ],
    map: (r) => ({
      ...audit(r),
      name: withNs(r, r.DeveloperName),
      label: r.MasterLabel,
      category: humanize(r.InvocationTargetType) || null,
      badges: r.InvocationTarget ? [`→ ${r.InvocationTarget}`] : [],
    }),
    url: () => AGENTFORCE_HOME,
  },
  {
    key: "GenAiPromptTemplate",
    label: "Prompt Templates",
    group: "agentforce",
    icon: "file-text",
    color: "#c026d3",
    description: L("Plantillas de Prompt Builder", "Prompt Builder templates"),
    keywords: "agentforce prompt template plantilla builder genai",
    queries: [
      D(`SELECT Id, DeveloperName, MasterLabel, Type, Description, ${AUDIT} FROM GenAiPromptTemplate`),
      T(`SELECT Id, DeveloperName, MasterLabel, Type, Description, ${AUDIT} FROM GenAiPromptTemplate`),
      D("SELECT Id, DeveloperName, MasterLabel, LastModifiedDate FROM GenAiPromptTemplate"),
      T("SELECT Id, DeveloperName, MasterLabel, LastModifiedDate FROM GenAiPromptTemplate"),
    ],
    map: (r) => ({
      ...audit(r),
      name: withNs(r, r.DeveloperName),
      label: r.MasterLabel,
      category: humanize(r.Type) || null,
    }),
    url: () => "/lightning/setup/EinsteinPromptStudio/home",
  },

  // ───────────── Objetos y campos
  {
    key: "CustomObject",
    label: L("Objetos", "Objects"),
    group: "objects",
    icon: "box",
    color: "#3b82f6",
    description: L("Objetos estándar y custom, CMDT, eventos", "Standard and custom objects, CMDT, events"),
    keywords: "object objeto sobject custom estandar standard metadata type platform event setting",
    load: async (api) => {
      const all = await api.describeGlobal();
      return all.filter(
        (s) => !s.deprecatedAndHidden && (s.custom || s.layoutable) && !NON_DATA_OBJECTS.test(s.name)
      );
    },
    map: (s) => {
      const kind = s.customSetting
        ? "setting"
        : s.name.endsWith("__mdt")
          ? "mdt"
          : s.name.endsWith("__e")
            ? "event"
            : s.name.endsWith("__x")
              ? "external"
              : s.custom
                ? "custom"
                : "standard";
      const category = {
        setting: "Custom Setting",
        mdt: "Custom Metadata Type",
        event: "Platform Event",
        external: "External Object",
        custom: "Custom",
        standard: L("Estándar", "Standard"),
      }[kind];
      return {
        id: s.name,
        name: s.name,
        label: s.label,
        category,
        badges: s.keyPrefix ? [s.keyPrefix] : [],
        dataObject: s.queryable && s.retrieveable ? s.name : null,
        _kind: kind,
      };
    },
    url: (r) =>
      r._kind === "mdt"
        ? "/lightning/setup/CustomMetadata/home"
        : r._kind === "event"
          ? "/lightning/setup/EventObjects/home"
          : r._kind === "setting"
            ? "/lightning/setup/CustomSettings/home"
            : objMgr(r.name, "Details"),
  },
  {
    key: "CustomField",
    label: "Custom Fields",
    group: "objects",
    icon: "rows",
    color: "#0ea5e9",
    description: L("Campos custom de todos los objetos", "Custom fields of every object"),
    objectLabel: OBJECT_LABEL,
    keywords: "field campo custom columna",
    queries: [
      T(`SELECT Id, DeveloperName, TableEnumOrId, ${AUDIT} FROM CustomField`),
      T("SELECT Id, DeveloperName, TableEnumOrId, NamespacePrefix, LastModifiedDate FROM CustomField"),
    ],
    map: (r) => ({ ...audit(r), name: withNs(r, r.DeveloperName) + "__c", object: r.TableEnumOrId }),
    url: (r) => objMgr(r.object, "FieldsAndRelationships", r.id),
  },
  {
    key: "CustomMetadataType",
    label: "Custom Metadata Types",
    group: "objects",
    icon: "database",
    color: "#7c3aed",
    description: L("Tipos de metadata personalizada (__mdt)", "Custom metadata types (__mdt)"),
    keywords: "custom metadata type cmdt mdt metadata personalizada configuracion",
    load: async (api) => (await api.describeGlobal()).filter((s) => s.name.endsWith("__mdt")),
    map: (s) => ({
      id: s.name,
      name: s.name,
      label: s.label,
      namespace: s.name.split("__").length > 2 ? s.name.split("__")[0] : null,
      badges: s.keyPrefix ? [s.keyPrefix] : [],
      dataObject: s.queryable ? s.name : null,
    }),
    url: () => "/lightning/setup/CustomMetadata/home",
  },
  {
    key: "CustomMetadataRecord",
    label: L("Registros de Custom Metadata", "Custom Metadata Records"),
    group: "objects",
    icon: "list",
    color: "#8b5cf6",
    description: L("Todos los registros de todos los tipos __mdt", "Every record of every __mdt type"),
    objectLabel: L("Tipo", "Type"),
    keywords: "custom metadata record registro cmdt mdt valores configuracion",
    load: loadCustomMetadataRecords,
    map: (r) => ({
      id: r.Id,
      name: withNs(r, r.DeveloperName),
      label: r.MasterLabel,
      object: r._type,
      namespace: r.NamespacePrefix || null,
      lastModified: r.SystemModstamp || null,
      lastModifiedBy: null,
    }),
    url: (r) => setup("CustomMetadata", r.id),
  },
  {
    key: "ValidationRule",
    label: "Validation Rules",
    group: "objects",
    icon: "shield-check",
    color: "#ef4444",
    description: L("Reglas de validación por objeto", "Validation rules by object"),
    objectLabel: OBJECT_LABEL,
    keywords: "validation rule regla validacion",
    queries: [
      T(
        `SELECT Id, ValidationName, Active, Description, ErrorMessage, EntityDefinition.QualifiedApiName, ${AUDIT} FROM ValidationRule`
      ),
      T("SELECT Id, ValidationName, Active, EntityDefinitionId, NamespacePrefix, LastModifiedDate FROM ValidationRule"),
    ],
    map: (r) => ({
      ...audit(r),
      name: withNs(r, r.ValidationName),
      label: r.ErrorMessage || r.Description || null,
      object: r.EntityDefinition?.QualifiedApiName || r.EntityDefinitionId || null,
      active: !!r.Active,
    }),
    url: (r) => objMgr(r.object, "ValidationRules", r.id),
  },
  {
    key: "RecordType",
    label: "Record Types",
    group: "objects",
    icon: "bookmark",
    color: "#ec4899",
    description: L("Tipos de registro por objeto", "Record types by object"),
    objectLabel: OBJECT_LABEL,
    keywords: "record type tipo registro",
    queries: [D(`SELECT Id, Name, DeveloperName, SobjectType, IsActive, ${AUDIT} FROM RecordType`)],
    map: (r) => ({
      ...audit(r),
      name: withNs(r, r.DeveloperName),
      label: r.Name,
      object: r.SobjectType,
      active: !!r.IsActive,
    }),
    url: (r) => objMgr(r.object, "RecordTypes", r.id),
  },
  {
    key: "GlobalValueSet",
    label: "Global Value Sets",
    group: "objects",
    icon: "list",
    color: "#a855f7",
    description: L("Picklists globales", "Global picklists"),
    keywords: "global value set picklist lista valores",
    queries: [
      T(`SELECT Id, DeveloperName, MasterLabel, ${AUDIT} FROM GlobalValueSet`),
      T("SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, LastModifiedDate FROM GlobalValueSet"),
    ],
    map: (r) => ({ ...audit(r), name: withNs(r, r.DeveloperName), label: r.MasterLabel }),
    url: (r) => setup("Picklists", r.id),
  },
  {
    key: "DuplicateRule",
    label: "Duplicate Rules",
    group: "objects",
    icon: "copy",
    color: "#f43f5e",
    description: L("Reglas de duplicados", "Duplicate rules"),
    objectLabel: OBJECT_LABEL,
    keywords: "duplicate rule duplicado regla",
    queries: [D(`SELECT Id, DeveloperName, MasterLabel, SobjectType, IsActive, ${AUDIT} FROM DuplicateRule`)],
    map: (r) => ({
      ...audit(r),
      name: withNs(r, r.DeveloperName),
      label: r.MasterLabel,
      object: r.SobjectType,
      active: !!r.IsActive,
    }),
    url: (r) => setup("DuplicateRules", r.id),
  },

  // ───────────── Interfaz
  {
    key: "Layout",
    label: "Page Layouts",
    group: "ui",
    icon: "layout",
    color: "#64748b",
    description: L("Formatos de página por objeto", "Page layouts by object"),
    objectLabel: OBJECT_LABEL,
    keywords: "layout page formato pagina diseño",
    queries: [
      T(`SELECT Id, Name, TableEnumOrId, ${AUDIT} FROM Layout`),
      T("SELECT Id, Name, TableEnumOrId, NamespacePrefix, LastModifiedDate FROM Layout"),
    ],
    map: (r) => ({ ...audit(r), name: r.Name, object: r.TableEnumOrId }),
    url: (r) => objMgr(r.object, "PageLayouts", r.id),
  },
  {
    key: "FlexiPage",
    label: "Lightning Pages",
    group: "ui",
    icon: "app-window",
    color: "#0284c7",
    description: L("Record, App y Home pages (FlexiPages)", "Record, App and Home pages (FlexiPages)"),
    objectLabel: OBJECT_LABEL,
    keywords: "flexipage lightning page app builder record page home",
    queries: [
      T(`SELECT Id, DeveloperName, MasterLabel, Type, EntityDefinitionId, ${AUDIT} FROM FlexiPage`),
      T("SELECT Id, DeveloperName, MasterLabel, Type, NamespacePrefix, LastModifiedDate FROM FlexiPage"),
    ],
    map: (r) => ({
      ...audit(r),
      name: withNs(r, r.DeveloperName),
      label: r.MasterLabel,
      object: r.EntityDefinitionId || null,
      category: r.Type || null,
    }),
    url: (r) => `/visualEditor/appBuilder.app?id=${r.id}`,
  },
  {
    key: "CustomLabel",
    label: "Custom Labels",
    group: "ui",
    icon: "tag",
    color: "#d946ef",
    description: L("Etiquetas y traducciones", "Labels and translations"),
    keywords: "custom label etiqueta texto traduccion",
    queries: [
      T(`SELECT Id, Name, MasterLabel, Value, Category, Language, ${AUDIT} FROM ExternalString`),
      T("SELECT Id, Name, MasterLabel, Value, NamespacePrefix, LastModifiedDate FROM ExternalString"),
    ],
    map: (r) => ({
      ...audit(r),
      name: withNs(r, r.Name),
      label: r.Value || r.MasterLabel,
      category: r.Category || null,
      badges: r.Language ? [r.Language] : [],
    }),
    url: (r) => setup("ExternalStrings", r.id),
  },
  {
    key: "EmailTemplate",
    label: "Email Templates",
    group: "ui",
    icon: "mail",
    color: "#f472b6",
    description: L("Plantillas de email (Classic y Lightning)", "Email templates (Classic and Lightning)"),
    keywords: "email template plantilla correo",
    queries: [
      D("SELECT Id, Name, DeveloperName, TemplateType, IsActive, UiType, FolderName, LastModifiedDate, LastModifiedBy.Name FROM EmailTemplate"),
      D("SELECT Id, Name, DeveloperName, TemplateType, IsActive, UiType, LastModifiedDate FROM EmailTemplate"),
    ],
    map: (r) => ({
      ...audit(r),
      name: r.DeveloperName || r.Name,
      label: r.Name,
      active: !!r.IsActive,
      category: r.UiType === "SFX" ? "Lightning" : "Classic",
      badges: [r.TemplateType, r.FolderName].filter(Boolean),
      _lightning: r.UiType === "SFX",
    }),
    url: (r) => (r._lightning ? `/lightning/r/EmailTemplate/${r.id}/view` : setup("CommunicationTemplatesEmail", r.id)),
  },

  // ───────────── Seguridad y acceso
  {
    key: "Profile",
    label: "Profiles",
    group: "security",
    icon: "users",
    color: "#7c3aed",
    description: L("Perfiles de usuario", "User profiles"),
    keywords: "profile perfil seguridad",
    queries: [D("SELECT Id, Name, UserType, LastModifiedDate, LastModifiedBy.Name FROM Profile")],
    map: (r) => ({ ...audit(r), name: r.Name, category: r.UserType || null }),
    url: (r) => setup("EnhancedProfiles", r.id),
  },
  {
    key: "PermissionSet",
    label: "Permission Sets",
    group: "security",
    icon: "key",
    color: "#4f46e5",
    description: L("Conjuntos de permisos", "Permission sets"),
    keywords: "permission set permisos conjunto",
    queries: [D(`SELECT Id, Name, Label, IsCustom, ${AUDIT} FROM PermissionSet WHERE IsOwnedByProfile = false`)],
    map: (r) => ({
      ...audit(r),
      name: withNs(r, r.Name),
      label: r.Label,
      category: r.IsCustom ? "Custom" : L("Estándar", "Standard"),
    }),
    url: (r) => setup("PermSets", r.id),
  },
  {
    key: "PermissionSetGroup",
    label: "Permission Set Groups",
    group: "security",
    icon: "layers",
    color: "#6d28d9",
    description: L("Grupos de permission sets", "Permission set groups"),
    keywords: "permission set group grupo permisos",
    queries: [D(`SELECT Id, DeveloperName, MasterLabel, Status, ${AUDIT} FROM PermissionSetGroup`)],
    map: (r) => ({
      ...audit(r),
      name: withNs(r, r.DeveloperName),
      label: r.MasterLabel,
      badges: r.Status && r.Status !== "Updated" ? [r.Status] : [],
    }),
    url: (r) => setup("PermSetGroups", r.id),
  },
  {
    key: "CustomPermission",
    label: "Custom Permissions",
    group: "security",
    icon: "lock",
    color: "#9333ea",
    description: L("Permisos personalizados", "Custom permissions"),
    keywords: "custom permission permiso personalizado",
    queries: [D(`SELECT Id, DeveloperName, MasterLabel, ${AUDIT} FROM CustomPermission`)],
    map: (r) => ({ ...audit(r), name: withNs(r, r.DeveloperName), label: r.MasterLabel }),
    url: (r) => setup("CustomPermissions", r.id),
  },
  {
    key: "NamedCredential",
    label: "Named Credentials",
    group: "security",
    icon: "link",
    color: "#0891b2",
    description: L("Credenciales con nombre / endpoints", "Named credentials / endpoints"),
    keywords: "named credential credencial endpoint integracion callout",
    queries: [
      D(`SELECT Id, DeveloperName, MasterLabel, Endpoint, ${AUDIT} FROM NamedCredential`),
      D(`SELECT Id, DeveloperName, MasterLabel, ${AUDIT} FROM NamedCredential`),
    ],
    map: (r) => ({ ...audit(r), name: withNs(r, r.DeveloperName), label: r.Endpoint || r.MasterLabel }),
    url: () => "/lightning/setup/NamedCredential/home",
  },

  // ───────────── Analítica y otros
  {
    key: "Report",
    label: "Reports",
    group: "analytics",
    icon: "bar-chart",
    color: "#059669",
    description: L("Reportes accesibles para tu usuario", "Reports your user can access"),
    keywords: "report reporte informe",
    queries: [
      D("SELECT Id, Name, DeveloperName, FolderName, Format, LastModifiedDate, LastModifiedBy.Name FROM Report"),
      D("SELECT Id, Name, DeveloperName, FolderName, LastModifiedDate FROM Report"),
    ],
    map: (r) => ({
      ...audit(r),
      name: r.Name,
      label: r.DeveloperName,
      category: r.FolderName || null,
      badges: r.Format ? [r.Format] : [],
    }),
    url: (r) => `/lightning/r/Report/${r.id}/view`,
  },
  {
    key: "Dashboard",
    label: "Dashboards",
    group: "analytics",
    icon: "gauge",
    color: "#0d9488",
    description: L("Paneles accesibles para tu usuario", "Dashboards your user can access"),
    keywords: "dashboard panel tablero",
    queries: [
      D("SELECT Id, Title, DeveloperName, FolderName, LastModifiedDate, LastModifiedBy.Name FROM Dashboard"),
      D("SELECT Id, Title, DeveloperName, LastModifiedDate FROM Dashboard"),
    ],
    map: (r) => ({ ...audit(r), name: r.Title, label: r.DeveloperName, category: r.FolderName || null }),
    url: (r) => `/lightning/r/Dashboard/${r.id}/view`,
  },
];

const BY_KEY = new Map(TYPES.map((t) => [t.key, t]));
export const getType = (key) => BY_KEY.get(key) || null;
export const groupLabel = (id) => TYPE_GROUPS.find((g) => g.id === id)?.label || id;

const ENTITY_ID_RE = /^01I[0-9A-Za-z]{12}([0-9A-Za-z]{3})?$/;
const quote = (v) => `'${v}'`;

/** Convierte ids de objetos custom (01I...) en su API name (Mi_Objeto__c). */
export async function resolveEntityIds(api, rows, signal, field = "object") {
  const ids = [...new Set(rows.map((r) => r[field]).filter((o) => o && ENTITY_ID_RE.test(o)))];
  if (!ids.length) return;
  const names = new Map(); // id15 -> api name
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const variants = [...new Set(chunk.flatMap((id) => [id, id.slice(0, 15)]))];
    try {
      const recs = await api.queryAll(
        `SELECT DurableId, QualifiedApiName FROM EntityDefinition WHERE DurableId IN (${variants.map(quote).join(",")})`,
        { signal }
      );
      recs.forEach((r) => names.set(r.DurableId.slice(0, 15), r.QualifiedApiName));
    } catch (e) {
      if (e.name === "AbortError") throw e;
    }
    const missing = chunk.filter((id) => !names.has(id.slice(0, 15)));
    if (missing.length) {
      try {
        const recs = await api.queryAll(
          `SELECT Id, DeveloperName, NamespacePrefix FROM CustomObject WHERE Id IN (${missing.map(quote).join(",")})`,
          { tooling: true, signal }
        );
        recs.forEach((r) => names.set(r.Id.slice(0, 15), withNs(r, r.DeveloperName) + "__c"));
      } catch (e) {
        if (e.name === "AbortError") throw e;
      }
    }
  }
  rows.forEach((r) => {
    if (r[field] && ENTITY_ID_RE.test(r[field])) r[field] = names.get(r[field].slice(0, 15)) || r[field];
  });
}

/** Carga y normaliza todos los elementos de un tipo de metadata. */
export async function loadMetadata(api, def, { signal } = {}) {
  let records;
  if (def.load) {
    records = await def.load(api, signal);
  } else {
    let lastError;
    for (const q of def.queries) {
      try {
        records = await api.queryAll(q.soql, { tooling: q.tooling, signal });
        break;
      } catch (e) {
        if (e.name === "AbortError" || e.status === 401) throw e;
        lastError = e;
      }
    }
    if (!records) throw lastError;
  }

  const rows = [];
  for (const rec of records) {
    const row = def.map(rec);
    if (!row) continue;
    row.raw = rec; // registro original, lo usan las reglas de conflictos
    row._i = rows.length;
    rows.push(row);
  }
  await resolveEntityIds(api, rows, signal);
  await resolveEntityIds(api, rows, signal, "objectApi");
  for (const r of rows) {
    r.label = r.label && r.label !== r.name ? r.label : null;
    r.active = typeof r.active === "boolean" ? r.active : null;
    r.badges = r.badges || [];
    // Tipos sin NamespacePrefix (p. ej. objetos del describe): se deduce de "ns__Nombre__c".
    if (r.namespace === undefined) {
      const parts = String(r.name || "").split("__");
      r.namespace = parts.length >= 3 && /^[A-Za-z][A-Za-z0-9]{0,14}$/.test(parts[0]) ? parts[0] : null;
    }
    r.url = def.url(r);
    r._search = [r.name, r.label, r.object, r.category, r.namespace, ...r.badges].filter(Boolean).join(" ").toLowerCase();
  }
  rows.loadedAt = Date.now();
  return rows;
}
