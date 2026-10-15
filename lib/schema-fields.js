// Creación de campos custom desde el Schema Builder (Tooling API → CustomField).
//
// Un campo creado por API nace sin field-level security: nadie lo ve (ni siquiera quien lo creó)
// hasta que se le da acceso. Por eso, opcionalmente, se agrega un FieldPermissions al permission
// set del perfil del usuario actual. Los campos obligatorios no admiten FLS (siempre son visibles).
import { soqlEscape } from "./sfapi.js";

export const FIELD_TYPES = ["Text", "LongTextArea", "Number", "Currency", "Percent", "Checkbox", "Date", "DateTime", "Email", "Phone", "Url", "Picklist", "Lookup"];

/** Tipos que admiten «obligatorio». */
export const CAN_REQUIRE = new Set(["Text", "Number", "Currency", "Percent", "Date", "DateTime", "Email", "Phone", "Url", "Picklist", "Lookup"]);

/** "Fecha de alta (UTC)" → "Fecha_de_alta_UTC" */
export function apiNameFrom(label) {
  let s = String(label || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (/^[0-9]/.test(s)) s = `X${s}`;
  return s.slice(0, 40).replace(/_+$/, "");
}

/** null si es válido; si no, el código del problema. */
export function validateApiName(name) {
  if (!name) return "empty";
  if (name.length > 40) return "long";
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || /__/.test(name) || /_$/.test(name)) return "chars";
  return null;
}

export function buildFieldMetadata(s) {
  const m = { label: s.label, type: s.type };
  if (s.description) m.description = s.description;
  if (s.help) m.inlineHelpText = s.help;
  if (CAN_REQUIRE.has(s.type)) m.required = !!s.required;
  switch (s.type) {
    case "Text":
      m.length = s.length;
      m.unique = !!s.unique;
      m.externalId = !!s.externalId;
      break;
    case "LongTextArea":
      m.length = s.length;
      m.visibleLines = s.visibleLines || 5;
      break;
    case "Number":
    case "Currency":
    case "Percent":
      m.precision = s.digits + s.decimals;
      m.scale = s.decimals;
      break;
    case "Checkbox":
      m.defaultValue = s.defaultChecked ? "true" : "false";
      break;
    case "Picklist":
      m.valueSet = {
        restricted: true,
        valueSetDefinition: { sorted: false, value: s.values.map((v) => ({ fullName: v, label: v, default: false })) },
      };
      break;
    case "Lookup":
      m.referenceTo = s.referenceTo;
      m.relationshipName = s.relationshipName;
      m.relationshipLabel = s.relationshipLabel;
      m.deleteConstraint = s.required ? "Restrict" : "SetNull";
      break;
  }
  return m;
}

/** Crea el campo y devuelve su nombre completo ("Account.Mi_Campo__c"). */
export async function createField(api, objectName, spec) {
  const fullName = `${objectName}.${spec.name}__c`;
  await api.toolingCreate("CustomField", { FullName: fullName, Metadata: buildFieldMetadata(spec) });
  return fullName;
}

/** Da lectura y edición del campo al perfil del usuario (vía su permission set de perfil). */
export async function grantFieldAccess(api, userId, objectName, fullName) {
  const [ps] = (
    await api.query(
      `SELECT Id FROM PermissionSet WHERE IsOwnedByProfile = true AND ProfileId IN (SELECT ProfileId FROM User WHERE Id = '${soqlEscape(userId)}')`
    )
  ).records;
  if (!ps) throw new Error("Profile permission set not found");
  await api.createRecord("FieldPermissions", { ParentId: ps.Id, SobjectType: objectName, Field: fullName, PermissionsRead: true, PermissionsEdit: true });
}
