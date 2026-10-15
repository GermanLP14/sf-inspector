// Cliente mínimo de la REST / Tooling API de Salesforce.
// Usa el token de sesión del usuario: Salesforce aplica sus permisos en cada llamada.

import { L } from "./i18n.js";

export const API_VERSION = "62.0";

export class ApiError extends Error {
  constructor(message, status, code, errors = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code || null;
    this.errors = errors; // [{ message, errorCode, fields[] }] tal como los devuelve Salesforce
  }
}

export class SalesforceApi {
  constructor({ host, sid }) {
    this.host = host;
    this.sid = sid;
    this.base = `https://${host}`;
    this._global = null;
    this._describe = new Map();
  }

  async request(path, { method = "GET", body, headers = {}, signal } = {}) {
    const url = path.startsWith("http") ? path : this.base + path;
    let res;
    try {
      res = await fetch(url, {
        method,
        signal,
        credentials: "omit",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${this.sid}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new ApiError(L("No se pudo conectar con Salesforce. Revisa tu conexión.", "Could not reach Salesforce. Check your connection."), 0);
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const first = Array.isArray(data) ? data[0] : data;
      let message =
        (Array.isArray(data) && data.length > 1 ? data.map((d) => d.message).filter(Boolean).join(" · ") : null) ||
        first?.message ||
        first?.error_description ||
        res.statusText ||
        L("Error de Salesforce", "Salesforce error");
      if (res.status === 401) {
        message = L(
          "La sesión expiró o no es válida. Vuelve a iniciar sesión en Salesforce y recarga esta pestaña.",
          "The session expired or is invalid. Log in to Salesforce again and reload this tab."
        );
      }
      throw new ApiError(message, res.status, first?.errorCode || first?.error, Array.isArray(data) ? data : null);
    }
    return data;
  }

  query(soql, { tooling = false, batchSize, signal } = {}) {
    const path = `/services/data/v${API_VERSION}/${tooling ? "tooling/" : ""}query/?q=${encodeURIComponent(soql)}`;
    const headers = batchSize ? { "Sforce-Query-Options": `batchSize=${batchSize}` } : {};
    return this.request(path, { headers, signal });
  }

  /** Búsqueda SOSL (FIND … RETURNING …). Respeta sharing y FLS como el resto. */
  search(sosl, { signal } = {}) {
    return this.request(`/services/data/v${API_VERSION}/search/?q=${encodeURIComponent(sosl)}`, { signal });
  }

  more(nextRecordsUrl, { signal } = {}) {
    return this.request(nextRecordsUrl, { signal });
  }

  async queryAll(soql, { tooling = false, signal, max = 50000 } = {}) {
    let res = await this.query(soql, { tooling, signal });
    const records = [...res.records];
    while (!res.done && res.nextRecordsUrl && records.length < max) {
      res = await this.more(res.nextRecordsUrl, { signal });
      records.push(...res.records);
    }
    return records;
  }

  /** Olvida el describe global en caché (para ver objetos recién creados). */
  invalidateGlobal() {
    this._global = null;
  }

  describeGlobal() {
    if (!this._global) {
      this._global = this.request(`/services/data/v${API_VERSION}/sobjects/`)
        .then((r) => r.sobjects)
        .catch((e) => {
          this._global = null;
          throw e;
        });
    }
    return this._global;
  }

  describe(name) {
    if (!this._describe.has(name)) {
      const p = this.request(`/services/data/v${API_VERSION}/sobjects/${encodeURIComponent(name)}/describe/`).catch((e) => {
        this._describe.delete(name);
        throw e;
      });
      this._describe.set(name, p);
    }
    return this._describe.get(name);
  }

  /** Olvida el describe en caché de un objeto (p. ej. tras crearle un campo). */
  invalidateDescribe(name) {
    this._describe.delete(name);
  }

  describeGlobalTooling() {
    if (!this._globalTooling) {
      this._globalTooling = this.request(`/services/data/v${API_VERSION}/tooling/sobjects/`)
        .then((r) => r.sobjects)
        .catch((e) => {
          this._globalTooling = null;
          throw e;
        });
    }
    return this._globalTooling;
  }

  describeTooling(name) {
    this._describeTooling ||= new Map();
    if (!this._describeTooling.has(name)) {
      const p = this.request(`/services/data/v${API_VERSION}/tooling/sobjects/${encodeURIComponent(name)}/describe/`).catch((e) => {
        this._describeTooling.delete(name);
        throw e;
      });
      this._describeTooling.set(name, p);
    }
    return this._describeTooling.get(name);
  }

  // ───── Tooling API: crear / leer / actualizar / borrar (lo usa el IDE para guardar código)
  toolingCreate(sobject, fields) {
    return this.request(`/services/data/v${API_VERSION}/tooling/sobjects/${sobject}/`, { method: "POST", body: fields });
  }

  toolingGet(sobject, id) {
    return this.request(`/services/data/v${API_VERSION}/tooling/sobjects/${sobject}/${encodeURIComponent(id)}`);
  }

  toolingUpdate(sobject, id, fields) {
    return this.request(`/services/data/v${API_VERSION}/tooling/sobjects/${sobject}/${encodeURIComponent(id)}`, { method: "PATCH", body: fields });
  }

  toolingDelete(sobject, id) {
    return this.request(`/services/data/v${API_VERSION}/tooling/sobjects/${sobject}/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** Registro completo: Salesforce devuelve solo los campos que el usuario puede leer (FLS). */
  getRecord(sobject, id) {
    return this.request(`/services/data/v${API_VERSION}/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`);
  }

  createRecord(sobject, fields) {
    return this.request(`/services/data/v${API_VERSION}/sobjects/${encodeURIComponent(sobject)}/`, { method: "POST", body: fields });
  }

  /** Actualiza solo los campos indicados. Salesforce aplica permisos, sharing y validation rules. */
  updateRecord(sobject, id, fields) {
    return this.request(`/services/data/v${API_VERSION}/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: fields,
    });
  }

  /** Usuario actual: { userId, name, username } */
  async identity() {
    try {
      const u = await this.request("/services/oauth2/userinfo");
      return { userId: u.user_id, name: u.name, username: u.preferred_username || u.email };
    } catch (e) {
      if (e.status === 401) throw e;
      const u = await this.request(`/services/data/v${API_VERSION}/chatter/users/me`);
      return { userId: u.id, name: u.name || u.displayName, username: u.username };
    }
  }
}

export const soqlEscape = (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
export const likeEscape = (v) => soqlEscape(v).replace(/%/g, "\\%").replace(/_/g, "\\_");
