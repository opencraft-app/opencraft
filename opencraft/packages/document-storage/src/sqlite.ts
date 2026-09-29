import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  serializeDocumentValue, validateDataRevision, validateDataScope, validateDataVersion, parseDocumentRecord, validateDocumentTransition,
  type DocumentRecord, type DocumentCommit, type DocumentValue,
} from "./contract.js";

const BASELINE = "CREATE TABLE extension_records (scope TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, data_version INTEGER NOT NULL, value_json TEXT NOT NULL) STRICT";
const BASELINE_HASH = createHash("sha256").update(BASELINE).digest("hex");

/** Owner supplies a fixed private path; RPC callers never supply database paths. */
export class SqliteDocumentStore {
  private readonly database: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    try {
      if (path !== ":memory:") chmodSync(path, 0o600);
      this.database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      try {
        this.database.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT");
        const history = this.database.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all();
        if (history.some(row => row.version !== 1 || row.checksum !== BASELINE_HASH)) throw new Error("Unsupported extension database migration history");
        if (history.length === 0) {
          // Refuse unrecognized existing tables: never mark an arbitrary database current.
          if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migrations','sqlite_sequence')").get()) throw new Error("Unknown extension database baseline");
          this.database.exec(BASELINE);
          this.database.prepare("INSERT INTO schema_migrations VALUES(1,'extension-records',?,?)").run(BASELINE_HASH, Date.now());
        }
        this.database.prepare("SELECT scope,revision,data_version,value_json FROM extension_records LIMIT 0").all();
        this.database.exec("COMMIT");
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    } catch (error) { this.database.close(); throw error; }
  }
  read(scope: unknown): DocumentRecord | null {
    validateDataScope(scope);
    const row = this.database.prepare("SELECT revision,data_version,value_json FROM extension_records WHERE scope=?").get(scope);
    return parseDocumentRecord(row ? { revision: Number(row.revision), version: Number(row.data_version), value: JSON.parse(String(row.value_json)) as DocumentValue } : null);
  }
  compareAndSet(scope: unknown, revision: unknown, version: unknown, value: unknown): DocumentCommit {
    validateDataScope(scope); validateDataRevision(revision); validateDataVersion(version);
    const json = serializeDocumentValue(value);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.read(scope);
      if ((current?.revision ?? 0) !== revision) { this.database.exec("ROLLBACK"); return { updated: false, record: current }; }
      validateDocumentTransition(current, version);
      this.database.prepare("INSERT INTO extension_records(scope,revision,data_version,value_json) VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,data_version=excluded.data_version,value_json=excluded.value_json")
        .run(scope, revision + 1, version, json);
      this.database.exec("COMMIT");
      return { updated: true, record: { revision: revision + 1, version, value: JSON.parse(json) as DocumentValue } };
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }
  close() { this.database.close(); }
}
