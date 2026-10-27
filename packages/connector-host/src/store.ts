import type { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, createMissingLegacyObjects, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { connectorDefinition, type ConnectorInstance } from "@opencraft/connector-core";

const BASELINE = `
CREATE TABLE connector_instances (id TEXT PRIMARY KEY, definition_id TEXT NOT NULL, title TEXT NOT NULL, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE connector_credentials (instance_id TEXT PRIMARY KEY REFERENCES connector_instances(id) ON DELETE CASCADE, secrets TEXT NOT NULL, oauth TEXT NOT NULL) STRICT;
CREATE TABLE connector_oauth_transactions (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL) STRICT
`.trim();

export interface StoredConnection {
  id: string; definitionId: string; title: string; revision: number; enabled: boolean;
  values: Record<string, string>; secrets: Record<string, string>; oauth: Record<string, unknown>; updatedAt: number;
}
export interface OAuthTransaction {
  id: string; instanceId: string; revision: number; state: string; expiresAt: number;
  status: "pending" | "complete" | "cancelled" | "failed" | "expired";
  data: Record<string, unknown>;
}
export class ConnectorHostError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "missing" | "unsupported" | "authorization-required" | "unavailable" | "cancelled") { super(`Connector ${code}`); }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorHostError("invalid");
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ConnectorHostError("invalid");
  return value.trim();
}
function strings(value: unknown): Record<string, string> {
  const object = record(value);
  if (Object.keys(object).length > 32 || Object.values(object).some(v => typeof v !== "string" || v.length > 32768)) throw new ConnectorHostError("invalid");
  return structuredClone(object) as Record<string, string>;
}

/** Host-private database only. Never return a StoredConnection from an RPC. */
export class ConnectorDatabase {
  private readonly db: DatabaseSync;
  readonly outcome: DatabaseOutcome;
  constructor(path: string) {
    const managed = openManagedDatabase({
      path,
      migrations: [{ version: 1, name: "managed-connectors", sql: BASELINE }],
      legacyMigration: createMissingLegacyObjects(BASELINE),
    });
    this.db = managed.database;
    this.outcome = managed.outcome;
    this.db.exec("PRAGMA foreign_keys=ON; UPDATE connector_oauth_transactions SET status='cancelled', data='{}' WHERE status='pending'");
    this.prune();
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  get(id: string): StoredConnection {
    const row = this.db.prepare("SELECT i.*, c.secrets, c.oauth FROM connector_instances i JOIN connector_credentials c ON c.instance_id=i.id WHERE i.id=?").get(id);
    if (!row) throw new ConnectorHostError("missing");
    return { id: String(row.id), definitionId: String(row.definition_id), title: String(row.title), revision: Number(row.revision), enabled: !!row.enabled,
      values: strings(JSON.parse(String(row.value))), secrets: strings(JSON.parse(String(row.secrets))), oauth: record(JSON.parse(String(row.oauth))), updatedAt: Number(row.updated_at) };
  }
  project(row: StoredConnection): ConnectorInstance {
    return { id: row.id, definitionId: row.definitionId, title: row.title, revision: row.revision, enabled: row.enabled, values: row.values,
      configuredFields: Object.keys(row.secrets).filter(key => !!row.secrets[key]), authorization: connectorDefinition(row.definitionId).auth === "oauth" && !row.oauth.tokens ? "required" : "configured", updatedAt: row.updatedAt };
  }
  list(): ConnectorInstance[] { return this.db.prepare("SELECT id FROM connector_instances ORDER BY updated_at DESC").all().map(row => this.project(this.get(String(row.id)))); }
  save(raw: unknown): ConnectorInstance {
    const input = record(raw), id = text(input.id), definitionId = text(input.definitionId), title = text(input.title, 120);
    const expected = input.expectedRevision;
    if (!Number.isSafeInteger(expected) || Number(expected) < 0 || Object.keys(input).some(k => !["id", "definitionId", "title", "expectedRevision", "values", "secrets"].includes(k))) throw new ConnectorHostError("invalid");
    const definition = connectorDefinition(definitionId), values = strings(input.values), incoming = strings(input.secrets);
    for (const [bucket, isSecret] of [[values, false], [incoming, true]] as const) for (const key of Object.keys(bucket)) {
      if (!definition.fields.some(field => field.key === key && field.secret === isSecret)) throw new ConnectorHostError("invalid");
    }
    if (values.base_url) {
      const url = new URL(values.base_url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ConnectorHostError("invalid");
    }
    return this.transaction(() => {
      let previous: StoredConnection | undefined;
      try { previous = this.get(id); } catch (error) { if (!(error instanceof ConnectorHostError && error.code === "missing")) throw error; }
      if ((previous?.revision ?? 0) !== expected || (previous && previous.definitionId !== definitionId)) throw new ConnectorHostError("conflict");
      const identityChanged = previous && JSON.stringify(previous.values) !== JSON.stringify(values);
      const secrets = { ...(identityChanged ? {} : previous?.secrets), ...incoming };
      for (const field of definition.fields) if (field.required && !(field.secret ? secrets : values)[field.key]?.trim()) throw new ConnectorHostError("invalid");
      const oauth = identityChanged ? {} : previous?.oauth ?? {};
      const revision = Number(expected) + 1, updatedAt = Date.now();
      this.db.prepare("INSERT INTO connector_instances VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, revision=excluded.revision, value=excluded.value, updated_at=excluded.updated_at").run(id, definitionId, title, revision, 1, JSON.stringify(values), updatedAt);
      this.db.prepare("INSERT INTO connector_credentials VALUES(?,?,?) ON CONFLICT(instance_id) DO UPDATE SET secrets=excluded.secrets,oauth=excluded.oauth").run(id, JSON.stringify(secrets), JSON.stringify(oauth));
      this.db.prepare("UPDATE connector_oauth_transactions SET status='cancelled',data='{}' WHERE instance_id=? AND status='pending'").run(id);
      return this.project(this.get(id));
    });
  }
  setEnabled(id: string, revision: number, enabled: boolean): ConnectorInstance {
    return this.transaction(() => {
      const row = this.get(id); if (row.revision !== revision) throw new ConnectorHostError("conflict");
      this.db.prepare("UPDATE connector_instances SET enabled=?,revision=revision+1,updated_at=? WHERE id=?").run(Number(enabled), Date.now(), id);
      return this.project(this.get(id));
    });
  }
  remove(id: string, revision: number): void {
    this.transaction(() => { if (this.get(id).revision !== revision) throw new ConnectorHostError("conflict");
      this.db.prepare("DELETE FROM connector_oauth_transactions WHERE instance_id=?").run(id);
      this.db.prepare("DELETE FROM connector_instances WHERE id=?").run(id); });
  }
  saveOAuth(id: string, revision: number, oauth: Record<string, unknown>, newIdentity: boolean): void {
    this.transaction(() => { if (this.get(id).revision !== revision) throw new ConnectorHostError("conflict");
      this.db.prepare("UPDATE connector_credentials SET oauth=? WHERE instance_id=?").run(JSON.stringify(oauth), id);
      if (newIdentity) this.db.prepare("UPDATE connector_instances SET revision=revision+1,updated_at=? WHERE id=?").run(Date.now(), id); });
  }
  putTransaction(tx: OAuthTransaction): void {
    this.db.prepare("INSERT INTO connector_oauth_transactions VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data").run(tx.id, tx.instanceId, tx.revision, tx.state, tx.expiresAt, tx.status, JSON.stringify(tx.data));
  }
  getTransaction(id: string): OAuthTransaction {
    this.prune(); const row = this.db.prepare("SELECT * FROM connector_oauth_transactions WHERE id=?").get(id);
    if (!row) throw new ConnectorHostError("missing");
    return { id: String(row.id), instanceId: String(row.instance_id), revision: Number(row.revision), state: String(row.state), expiresAt: Number(row.expires_at), status: row.status as OAuthTransaction["status"], data: record(JSON.parse(String(row.data))) };
  }
  prune(): void {
    this.db.prepare("UPDATE connector_oauth_transactions SET status='expired',data='{}' WHERE status='pending' AND expires_at<?").run(Date.now());
    this.db.prepare("DELETE FROM connector_oauth_transactions WHERE expires_at<?").run(Date.now() - 86400000);
  }
  close() { this.db.close(); }
}
