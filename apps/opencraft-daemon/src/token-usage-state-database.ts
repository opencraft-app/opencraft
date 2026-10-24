import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, createSchemaValidator, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { OPENCRAFT_HOST_TOKEN_USAGE } from "./token-usage-schema.js";
import { OPENCRAFT_HOST_TOKEN_USAGE_RUNTIME } from "./token-usage-runtime-schema.js";
import { OPENCRAFT_HOST_TOKEN_USAGE_COUNTERS } from "./token-usage-counter-schema.js";
import { OPENCRAFT_HOST_TOKEN_USAGE_QUERY } from "./token-usage-query-schema.js";
import { OPENCRAFT_HOST_TOKEN_USAGE_ATTEMPTS } from "./token-usage-attempt-schema.js";
import { OPENCRAFT_HOST_TOKEN_USAGE_ACTORS } from "./token-usage-actor-schema.js";
import { OPENCRAFT_HOST_TOKEN_USAGE_FROZEN } from "./token-usage-frozen-schema.js";

// The published Host migrations remain unchanged. This new physical owner has
// its own version axis and copies only metering data from the former owner.
const SCHEMA = OPENCRAFT_HOST_TOKEN_USAGE + OPENCRAFT_HOST_TOKEN_USAGE_RUNTIME + OPENCRAFT_HOST_TOKEN_USAGE_COUNTERS
  + OPENCRAFT_HOST_TOKEN_USAGE_QUERY + OPENCRAFT_HOST_TOKEN_USAGE_ATTEMPTS + OPENCRAFT_HOST_TOKEN_USAGE_ACTORS + OPENCRAFT_HOST_TOKEN_USAGE_FROZEN + `
CREATE TABLE token_usage_legacy_import (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), legacy_revision_json TEXT NOT NULL
) STRICT;
`;
const THREAD_QUERY_INDEX = `
CREATE INDEX token_usage_turns_thread_query ON token_usage_turns(server_id,thread_id,started_ms,turn_id);
`;
export const TOKEN_USAGE_STATE_MIGRATIONS = [
  { version: 1, name: "isolated-token-usage", sql: SCHEMA },
  { version: 2, name: "token-usage-thread-query-index", sql: THREAD_QUERY_INDEX },
] as const;

/** One physical metering store per Host, independent of queue/identity locks.
 * The Host starts this owner before its collector and closes the collector and
 * read worker before closing it. The old tables remain an inactive recovery
 * source; no running collector writes both stores.
 */
export class TokenUsageStateDatabase {
  readonly database: DatabaseSync;
  readonly outcome: DatabaseOutcome;
  constructor(directory: string, legacyPath?: string) {
    const managed = openManagedDatabase({ path: join(directory, "token-usage.sqlite"),
      legacyPolicy: "reject-unknown", migrations: TOKEN_USAGE_STATE_MIGRATIONS, validateSchema: createSchemaValidator(SCHEMA + THREAD_QUERY_INDEX) });
    this.database = managed.database;
    this.outcome = managed.outcome;
    try { if (legacyPath) this.importLegacy(legacyPath); }
    catch (error) { this.database.close(); throw error; }
  }
  private importLegacy(path: string): void {
    const db = this.database;
    const previousTimeout = Number(db.prepare("PRAGMA busy_timeout").get()!.timeout);
    db.exec("PRAGMA busy_timeout=0");
    db.prepare("ATTACH DATABASE ? AS legacy_usage").run(pathToFileURL(path).href + "?mode=ro");
    try {
      // A deferred transaction reads a stable legacy snapshot without taking a
      // writer lock on the read-only source. Only the new file is modified.
      db.exec("BEGIN");
      try {
        const revision = JSON.stringify(db.prepare("SELECT server_id,revision FROM legacy_usage.token_usage_scopes ORDER BY server_id").all());
        const imported = db.prepare("SELECT legacy_revision_json FROM token_usage_legacy_import WHERE singleton=1").get();
        if (imported) {
          // A legacy binary writing after cutover is a different history. Keep
          // both files intact and fail statistics closed rather than guess.
          if (imported.legacy_revision_json !== revision) throw new Error("Legacy token usage changed after cutover");
        } else {
          const tables = db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' AND name GLOB 'token_usage_*' AND name!='token_usage_legacy_import' ORDER BY name").all();
          for (const row of tables) {
            const name = String(row.name);
            if (!/^token_usage_[a-z_]+$/.test(name)) throw new Error("Invalid metering schema");
            if (db.prepare(`SELECT count(*) AS n FROM main."${name}"`).get()!.n !== 0) throw new Error("Unclaimed metering data cannot be merged");
            const columns = (schema: string) => db.prepare(`PRAGMA ${schema}.table_info("${name}")`).all().map(column => String(column.name));
            if (JSON.stringify(columns("main")) !== JSON.stringify(columns("legacy_usage"))) throw new Error("Legacy metering schema mismatch");
            db.exec(`INSERT INTO main."${name}" SELECT * FROM legacy_usage."${name}"`);
            if (db.prepare(`SELECT count(*) AS n FROM main."${name}"`).get()!.n !== db.prepare(`SELECT count(*) AS n FROM legacy_usage."${name}"`).get()!.n) throw new Error("Incomplete metering import");
          }
          db.prepare("INSERT INTO token_usage_legacy_import VALUES(1,?)").run(revision);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } finally {
      try { db.exec("DETACH DATABASE legacy_usage"); }
      finally { db.exec(`PRAGMA busy_timeout=${previousTimeout}`); }
    }
  }
  transaction<T>(write: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = write(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.database.close(); }
}
