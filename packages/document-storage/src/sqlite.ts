// Runtime-neutral extension document records over the SQL port: no node:*
// imports, so the same compare-and-set runs on a Node owner (`node-store.ts`)
// and on Durable Object SQL. Opening, migrating and closing belong to the owner.
import type { SqlDatabase } from "@opencraft/sql";
import {
  serializeDocumentValue, validateDataRevision, validateDataScope, validateDataVersion, parseDocumentRecord, validateDocumentTransition,
  type DocumentRecord, type DocumentCommit, type DocumentValue,
} from "./contract.js";

const BASELINE = "CREATE TABLE extension_records (scope TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, data_version INTEGER NOT NULL, value_json TEXT NOT NULL) STRICT";

/** The published chain of the extension document database. */
export const DOCUMENT_STORAGE_MIGRATIONS = [{ version: 1, name: "extension-records", sql: BASELINE }] as const;

export class SqlDocumentStore {
  protected readonly database: SqlDatabase;
  /** Rejects a database without the extension record table. */
  constructor(database: SqlDatabase) {
    this.database = database;
    this.database.prepare("SELECT scope,revision,data_version,value_json FROM extension_records LIMIT 0").all();
  }
  read(scope: unknown): DocumentRecord | null {
    validateDataScope(scope);
    const row = this.database.prepare("SELECT revision,data_version,value_json FROM extension_records WHERE scope=?").get(scope);
    return parseDocumentRecord(row ? { revision: Number(row.revision), version: Number(row.data_version), value: JSON.parse(String(row.value_json)) as DocumentValue } : null);
  }
  compareAndSet(scope: unknown, revision: unknown, version: unknown, value: unknown): DocumentCommit {
    validateDataScope(scope); validateDataRevision(revision); validateDataVersion(version);
    const json = serializeDocumentValue(value);
    return this.database.transaction(() => {
      const current = this.read(scope);
      if ((current?.revision ?? 0) !== revision) return { updated: false, record: current };
      validateDocumentTransition(current, version);
      this.database.prepare("INSERT INTO extension_records(scope,revision,data_version,value_json) VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,data_version=excluded.data_version,value_json=excluded.value_json")
        .run(scope, revision + 1, version, json);
      return { updated: true, record: { revision: revision + 1, version, value: JSON.parse(json) as DocumentValue } };
    });
  }
}
