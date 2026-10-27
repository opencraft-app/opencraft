import type { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, type DatabaseOutcome } from "@opencraft/sqlite-node";
import {
  serializeDocumentValue, validateDataRevision, validateDataScope, validateDataVersion, parseDocumentRecord, validateDocumentTransition,
  type DocumentRecord, type DocumentCommit, type DocumentValue,
} from "./contract.js";

const BASELINE = "CREATE TABLE extension_records (scope TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, data_version INTEGER NOT NULL, value_json TEXT NOT NULL) STRICT";

/** Owner supplies a fixed private path; RPC callers never supply database paths. */
export class SqliteDocumentStore {
  private readonly database: DatabaseSync;
  readonly outcome: DatabaseOutcome;
  constructor(path: string) {
    const managed = openManagedDatabase({ path, migrations: [{ version: 1, name: "extension-records", sql: BASELINE }] });
    this.database = managed.database;
    this.outcome = managed.outcome;
    try {
      this.database.prepare("SELECT scope,revision,data_version,value_json FROM extension_records LIMIT 0").all();
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
