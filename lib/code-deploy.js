// Lectura y guardado de código en la org (Apex, Visualforce, LWC y Aura) vía Tooling API.
//
// - Apex / Visualforce: igual que la Developer Console → MetadataContainer + *Member +
//   ContainerAsyncRequest. Salesforce compila; si falla, devuelve los errores con línea y columna.
//   Con checkOnly=true solo compila (validar sin guardar).
// - LWC / Aura: se actualiza cada archivo (LightningComponentResource / AuraDefinition);
//   Salesforce valida y guarda en el mismo paso.
// - Crear: Apex / Visualforce con un POST al sobject; LWC / Aura creando el bundle y luego sus archivos.
import { soqlEscape, API_VERSION } from "./sfapi.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const CODE_TYPES = {
  ApexClass: { kind: "apex", member: "ApexClassMember", field: "Body", ext: "cls", lang: "apex" },
  ApexTrigger: { kind: "apex", member: "ApexTriggerMember", field: "Body", ext: "trigger", lang: "apex" },
  ApexPage: { kind: "apex", member: "ApexPageMember", field: "Markup", ext: "page", lang: "html" },
  ApexComponent: { kind: "apex", member: "ApexComponentMember", field: "Markup", ext: "component", lang: "html" },
  LightningComponentBundle: { kind: "lwc" },
  AuraDefinitionBundle: { kind: "aura" },
};

const AURA_SUFFIX = {
  COMPONENT: ".cmp",
  APPLICATION: ".app",
  EVENT: ".evt",
  INTERFACE: ".intf",
  CONTROLLER: "Controller.js",
  HELPER: "Helper.js",
  RENDERER: "Renderer.js",
  STYLE: ".css",
  DOCUMENTATION: ".auradoc",
  DESIGN: ".design",
  SVG: ".svg",
  TOKENS: ".tokens",
};
const AURA_ORDER = Object.keys(AURA_SUFFIX);
const LWC_ORDER = ["html", "js", "css", "xml"];
const langFor = (format) => ({ js: "javascript", html: "html", css: "css", xml: "xml" })[String(format).toLowerCase()] || "javascript";

/** Devuelve { files: [{ id, name, lang, source }], lastModified, lastModifiedBy } */
export async function loadCode(api, typeKey, id) {
  const t = CODE_TYPES[typeKey];
  const q = (soql) => api.query(soql, { tooling: true }).then((r) => r.records);
  if (t.kind === "apex") {
    const [r] = await q(
      `SELECT Id, Name, ${t.field}, ApiVersion, NamespacePrefix, LastModifiedDate, LastModifiedBy.Name FROM ${typeKey} WHERE Id = '${soqlEscape(id)}'`
    );
    if (!r) throw new Error("Not found");
    return {
      files: [{ id: r.Id, name: `${r.Name}.${t.ext}`, lang: t.lang, source: r[t.field] ?? "" }],
      apiVersion: r.ApiVersion,
      namespace: r.NamespacePrefix,
      hidden: r[t.field] === "(hidden)",
      lastModified: r.LastModifiedDate,
      lastModifiedBy: r.LastModifiedBy?.Name,
    };
  }
  if (t.kind === "lwc") {
    const [bundle] = await q(
      `SELECT Id, DeveloperName, NamespacePrefix, ApiVersion, LastModifiedDate, LastModifiedBy.Name FROM LightningComponentBundle WHERE Id = '${soqlEscape(id)}'`
    );
    const res = await q(`SELECT Id, FilePath, Format, Source FROM LightningComponentResource WHERE LightningComponentBundleId = '${soqlEscape(id)}'`);
    const files = res
      .map((r) => ({ id: r.Id, name: r.FilePath.split("/").pop(), lang: langFor(r.Format), source: r.Source ?? "", order: LWC_ORDER.indexOf(String(r.Format).toLowerCase()) }))
      .sort((a, b) => (a.order === -1 ? 9 : a.order) - (b.order === -1 ? 9 : b.order) || a.name.localeCompare(b.name));
    return {
      files,
      apiVersion: bundle?.ApiVersion,
      namespace: bundle?.NamespacePrefix,
      lastModified: bundle?.LastModifiedDate,
      lastModifiedBy: bundle?.LastModifiedBy?.Name,
    };
  }
  const [bundle] = await q(
    `SELECT Id, DeveloperName, NamespacePrefix, ApiVersion, LastModifiedDate, LastModifiedBy.Name FROM AuraDefinitionBundle WHERE Id = '${soqlEscape(id)}'`
  );
  const defs = await q(`SELECT Id, DefType, Format, Source FROM AuraDefinition WHERE AuraDefinitionBundleId = '${soqlEscape(id)}'`);
  const files = defs
    .map((d) => ({
      id: d.Id,
      name: `${bundle?.DeveloperName || "bundle"}${AURA_SUFFIX[d.DefType] || "." + String(d.Format).toLowerCase()}`,
      lang: d.Format === "XML" ? "html" : langFor(d.Format),
      source: d.Source ?? "",
      order: AURA_ORDER.indexOf(d.DefType),
    }))
    .sort((a, b) => a.order - b.order);
  return {
    files,
    apiVersion: bundle?.ApiVersion,
    namespace: bundle?.NamespacePrefix,
    lastModified: bundle?.LastModifiedDate,
    lastModifiedBy: bundle?.LastModifiedBy?.Name,
  };
}

/** LastModifiedDate actual del componente (para detectar cambios hechos por otra persona). */
export async function currentStamp(api, typeKey, id) {
  const r = (await api.query(`SELECT LastModifiedDate, LastModifiedBy.Name FROM ${typeKey} WHERE Id = '${soqlEscape(id)}'`, { tooling: true })).records[0];
  return { lastModified: r?.LastModifiedDate, lastModifiedBy: r?.LastModifiedBy?.Name };
}

/**
 * Guarda (o valida) código. changed: [{ id, name, source }]
 * Devuelve { ok, errors: [{ file, line, column, message }], message }
 */
export async function saveCode(api, typeKey, changed, { checkOnly = false, onProgress } = {}) {
  const t = CODE_TYPES[typeKey];
  if (t.kind === "apex") return deployApex(api, t, changed, { checkOnly, onProgress });

  const sobject = t.kind === "lwc" ? "LightningComponentResource" : "AuraDefinition";
  const errors = [];
  for (const f of changed) {
    onProgress?.(f.name);
    try {
      await api.toolingUpdate(sobject, f.id, { Source: f.source });
    } catch (e) {
      if (e.status === 401) throw e;
      errors.push(...parseLightningError(e.message, f.name));
    }
  }
  return { ok: !errors.length, errors };
}

async function deployApex(api, t, changed, { checkOnly, onProgress }) {
  onProgress?.("container");
  const container = await api.toolingCreate("MetadataContainer", { Name: `OrgGadget_${Date.now().toString(36)}`.slice(0, 32) });
  try {
    for (const f of changed) {
      await api.toolingCreate(t.member, { MetadataContainerId: container.id, ContentEntityId: f.id, Body: f.source });
    }
    const req = await api.toolingCreate("ContainerAsyncRequest", { MetadataContainerId: container.id, IsCheckOnly: !!checkOnly });
    const started = Date.now();
    let r;
    do {
      await sleep(Date.now() - started < 3000 ? 500 : 1200);
      r = await api.toolingGet("ContainerAsyncRequest", req.id);
      onProgress?.(r.State);
    } while (r.State === "Queued" && Date.now() - started < 180000);

    if (r.State === "Completed") return { ok: true, errors: [] };
    const fileName = changed[0]?.name;
    const failures = r.DeployDetails?.componentFailures || [];
    let errors = failures.map((f) => ({
      file: changed.find((c) => c.name.startsWith(`${f.fullName}.`))?.name || fileName,
      line: f.lineNumber || null,
      column: f.columnNumber || null,
      message: f.problem,
    }));
    if (!errors.length && r.CompilerErrors) {
      try {
        errors = JSON.parse(r.CompilerErrors).map((c) => ({ file: fileName, line: Array.isArray(c.line) ? c.line[0] : c.line, column: null, message: c.problem }));
      } catch {
        /* formato desconocido */
      }
    }
    return { ok: false, errors, message: r.ErrorMsg || (r.State === "Queued" ? "Timeout" : r.State) };
  } finally {
    api.toolingDelete("MetadataContainer", container.id).catch(() => {});
  }
}

/** Los errores de LWC/Aura vienen como texto: intentamos extraer línea y columna. */
function parseLightningError(message, file) {
  const parts = String(message || "").split(/\n|·/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = /(?:\[|\(|:|line\s*)(\d+)[,:](\d+)\]?\)?/i.exec(p) || /line\s+(\d+)(?:,?\s*column\s+(\d+))?/i.exec(p);
    out.push({ file, line: m ? Number(m[1]) : null, column: m && m[2] ? Number(m[2]) : null, message: p });
  }
  return out.length ? out : [{ file, line: null, column: null, message: String(message) }];
}

// ───────────────────────────────────────── Explorador: listar todo el código de la org
const LIST_QUERIES = {
  ApexClass: "SELECT Id, Name, NamespacePrefix, LastModifiedDate FROM ApexClass ORDER BY Name",
  ApexTrigger: "SELECT Id, Name, TableEnumOrId, NamespacePrefix, LastModifiedDate FROM ApexTrigger ORDER BY Name",
  LightningComponentBundle: "SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, LastModifiedDate FROM LightningComponentBundle ORDER BY DeveloperName",
  AuraDefinitionBundle: "SELECT Id, DeveloperName, MasterLabel, NamespacePrefix, LastModifiedDate FROM AuraDefinitionBundle ORDER BY DeveloperName",
  ApexPage: "SELECT Id, Name, MasterLabel, NamespacePrefix, LastModifiedDate FROM ApexPage ORDER BY Name",
  ApexComponent: "SELECT Id, Name, MasterLabel, NamespacePrefix, LastModifiedDate FROM ApexComponent ORDER BY Name",
};

/** { [typeKey]: { items: [{ id, name, label, object, ns, lastModified }] } | { error } } */
export async function listCode(api) {
  const keys = Object.keys(LIST_QUERIES);
  const res = await Promise.allSettled(keys.map((k) => api.queryAll(LIST_QUERIES[k], { tooling: true })));
  const expired = res.find((r) => r.status === "rejected" && r.reason?.status === 401);
  if (expired) throw expired.reason;
  const out = {};
  keys.forEach((k, i) => {
    out[k] =
      res[i].status === "rejected"
        ? { error: res[i].reason }
        : {
            items: res[i].value.map((r) => ({
              id: r.Id,
              name: r.Name || r.DeveloperName,
              label: r.MasterLabel && r.MasterLabel !== (r.Name || r.DeveloperName) ? r.MasterLabel : null,
              object: r.TableEnumOrId || null,
              ns: r.NamespacePrefix || null,
              lastModified: r.LastModifiedDate,
            })),
          };
  });
  return out;
}

// ───────────────────────────────────────── Crear
export const CREATABLE = ["ApexClass", "ApexTrigger", "LightningComponentBundle", "AuraDefinitionBundle", "ApexPage", "ApexComponent"];
export const TRIGGER_EVENT_NAMES = ["before insert", "before update", "before delete", "after insert", "after update", "after delete", "after undelete"];
export const LWC_TARGETS = ["lightning__AppPage", "lightning__RecordPage", "lightning__HomePage", "lightning__FlowScreen", "lightning__Tab"];
export const APEX_TEMPLATES = ["empty", "controller", "test", "batch", "schedulable", "queueable", "invocable"];

/** Nombres válidos para Salesforce: letra inicial, sin "__", sin "_" final. LWC empieza en minúscula. */
export function validateName(typeKey, name) {
  if (!name) return "empty";
  if (name.length > 40) return "long";
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || /__/.test(name) || /_$/.test(name)) return "chars";
  if (typeKey === "LightningComponentBundle" && !/^[a-z]/.test(name)) return "lwc-case";
  return null;
}

const xmlText = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function apexClassSource(name, template) {
  switch (template) {
    case "controller":
      return `public with sharing class ${name} {\n\n    @AuraEnabled(cacheable=true)\n    public static String hello() {\n        return 'Hello';\n    }\n}\n`;
    case "test":
      return `@IsTest\nprivate class ${name} {\n\n    @IsTest\n    static void itWorks() {\n        Test.startTest();\n\n        Test.stopTest();\n        Assert.isTrue(true);\n    }\n}\n`;
    case "batch":
      return `public with sharing class ${name} implements Database.Batchable<SObject> {\n\n    public Database.QueryLocator start(Database.BatchableContext bc) {\n        return Database.getQueryLocator('SELECT Id FROM Account');\n    }\n\n    public void execute(Database.BatchableContext bc, List<SObject> scope) {\n\n    }\n\n    public void finish(Database.BatchableContext bc) {\n\n    }\n}\n`;
    case "schedulable":
      return `public with sharing class ${name} implements Schedulable {\n\n    public void execute(SchedulableContext sc) {\n\n    }\n}\n`;
    case "queueable":
      return `public with sharing class ${name} implements Queueable {\n\n    public void execute(QueueableContext context) {\n\n    }\n}\n`;
    case "invocable":
      return `public with sharing class ${name} {\n\n    @InvocableMethod(label='${name}')\n    public static List<String> run(List<String> inputs) {\n        return inputs;\n    }\n}\n`;
    default:
      return `public with sharing class ${name} {\n\n}\n`;
  }
}

/**
 * Crea un componente nuevo y devuelve su Id.
 * spec: { typeKey, name, template, sobject, events[], label, exposed, targets[] }
 */
export async function createCode(api, spec) {
  const { typeKey, name } = spec;
  const label = spec.label || name;
  const apiVersion = Number(API_VERSION);
  switch (typeKey) {
    case "ApexClass":
      return (await api.toolingCreate("ApexClass", { Name: name, Body: apexClassSource(name, spec.template) })).id;
    case "ApexTrigger":
      return (
        await api.toolingCreate("ApexTrigger", {
          Name: name,
          TableEnumOrId: spec.sobject,
          Body: `trigger ${name} on ${spec.sobject} (${spec.events.join(", ")}) {\n\n}\n`,
        })
      ).id;
    case "ApexPage":
      return (
        await api.toolingCreate("ApexPage", { Name: name, MasterLabel: label, ApiVersion: apiVersion, Markup: `<apex:page>\n    <h1>${xmlText(label)}</h1>\n</apex:page>\n` })
      ).id;
    case "ApexComponent":
      return (await api.toolingCreate("ApexComponent", { Name: name, MasterLabel: label, ApiVersion: apiVersion, Markup: `<apex:component>\n\n</apex:component>\n` })).id;
    case "LightningComponentBundle":
      return createLwc(api, name, { label, apiVersion, exposed: spec.exposed, targets: spec.targets || [] });
    case "AuraDefinitionBundle":
      return createAura(api, name, { label, apiVersion });
    default:
      throw new Error(`Unsupported type: ${typeKey}`);
  }
}

async function createLwc(api, name, { label, apiVersion, exposed, targets }) {
  const meta = { apiVersion, isExposed: !!exposed, masterLabel: label };
  if (exposed && targets.length) meta.targets = { target: targets };
  const bundle = await api.toolingCreate("LightningComponentBundle", { FullName: name, Metadata: meta });
  const className = name[0].toUpperCase() + name.slice(1);
  const files = [
    ["js", `import { LightningElement } from 'lwc';\n\nexport default class ${className} extends LightningElement {}\n`],
    ["html", `<template>\n    <lightning-card title="${name}">\n        <div class="slds-p-around_medium">Hello from ${name}</div>\n    </lightning-card>\n</template>\n`],
  ];
  try {
    for (const [ext, source] of files) {
      await api.toolingCreate("LightningComponentResource", { LightningComponentBundleId: bundle.id, FilePath: `lwc/${name}/${name}.${ext}`, Format: ext, Source: source });
    }
  } catch (e) {
    await api.toolingDelete("LightningComponentBundle", bundle.id).catch(() => {});
    throw e;
  }
  return bundle.id;
}

async function createAura(api, name, { label, apiVersion }) {
  const bundle = await api.toolingCreate("AuraDefinitionBundle", { DeveloperName: name, MasterLabel: label, Description: label, ApiVersion: apiVersion });
  const defs = [
    ["COMPONENT", "XML", `<aura:component implements="flexipage:availableForAllPageTypes" access="global">\n\n</aura:component>\n`],
    ["CONTROLLER", "JS", `({\n    myAction : function(component, event, helper) {\n\n    }\n})\n`],
    ["HELPER", "JS", `({\n    helperMethod : function() {\n\n    }\n})\n`],
  ];
  try {
    for (const [DefType, Format, Source] of defs) {
      await api.toolingCreate("AuraDefinition", { AuraDefinitionBundleId: bundle.id, DefType, Format, Source });
    }
  } catch (e) {
    await api.toolingDelete("AuraDefinitionBundle", bundle.id).catch(() => {});
    throw e;
  }
  return bundle.id;
}
