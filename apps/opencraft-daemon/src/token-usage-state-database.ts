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
export const TOKEN_USAGE_RECENCY_INDEX = `
CREATE INDEX token_usage_sources_observed_query ON token_usage_sources(server_id,observed_ms);
`;
export const TOKEN_USAGE_STATE_MIGRATIONS = [
  { version: 1, name: "isolated-token-usage", sql: SCHEMA },
  { version: 2, name: "token-usage-thread-query-index", sql: THREAD_QUERY_INDEX },
  { version: 3, name: "token-usage-source-recency-index", sql: TOKEN_USAGE_RECENCY_INDEX },
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
      legacyPolicy: "reject-unknown", migrations: TOKEN_USAGE_STATE_MIGRATIONS, validateSchema: createSchemaValidator(SCHEMA + THREAD_QUERY_INDEX + TOKEN_USAGE_RECENCY_INDEX) });
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
          if (imported.legacy_revision_json !== revision && !this.coversLegacyFacts()) {
            throw new Error("Legacy token usage changed after cutover");
          }
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
  /** A revision is not itself a fact. A later dedicated-store replay can
   * already cover the former writer, including newer versions of its sources.
   * Prove that relationship in the attached snapshot; never merge, change the
   * original import receipt, or acknowledge missing/conflicting evidence.
   */
  private coversLegacyFacts(): boolean {
    const db = this.database;
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const covered = (table: string, derived: readonly string[] = [], progress = "1"): boolean => {
      const columns = db.prepare(`PRAGMA main.table_info(${quote(table)})`).all()
        .map(row => String(row.name)).filter(name => !derived.includes(name));
      const same = columns.map(name => `n.${quote(name)} IS l.${quote(name)}`).join(" AND ");
      return !db.prepare(`SELECT 1 FROM legacy_usage.${quote(table)} l WHERE NOT EXISTS
        (SELECT 1 FROM main.${quote(table)} n WHERE ${same} AND (${progress})) LIMIT 1`).get();
    };
    for (const table of ["token_usage_admissions",
      "token_usage_input_conflicts", "token_usage_native_terminals"]) {
      if (!covered(table)) return false;
    }
    // Recovery can complete an unknown identity, but cannot replace a known
    // participant or a settled receipt. Attempts keep immutable ingress identity
    // while restart/late ACK advances their delivery outcome.
    const sameActor = "(n.actor_id IS l.actor_id AND n.actor_kind IS l.actor_kind)";
    const completedActor = "(l.actor_id IS NULL AND l.actor_kind='unknown' AND n.actor_id IS NOT NULL AND n.actor_kind!='unknown')";
    if (!covered("token_usage_inputs", ["actor_id", "actor_kind", "admission"],
      `((${sameActor}) OR (l.admission='pending' AND ${completedActor})) AND
       (l.admission='pending' OR n.admission IS l.admission)`) ||
      !covered("token_usage_submissions", ["actor_id", "actor_kind", "source_kind"],
        `((${sameActor} AND n.source_kind IS l.source_kind) OR ${completedActor})`) ||
      !covered("token_usage_attempts", ["outcome", "turn_id"],
        `((l.outcome IN ('pending','unknown')) OR (n.outcome IS l.outcome AND n.turn_id IS l.turn_id)) AND
         ((n.outcome='accepted' AND n.turn_id IS NOT NULL) OR (n.outcome!='accepted' AND n.turn_id IS NULL))`) ||
      !this.coversLegacyCounters()) return false;
    if (!covered("token_usage_scopes", ["enabled", "revision"]) ||
      !covered("token_usage_coverage", ["ends_ms"]) ||
      !covered("token_usage_turns", ["execution_state", "participants_complete", "usage_complete",
        "responses_complete", "observed_tokens", "allocation_state", "unknown_model", "frozen", "revision", "source_kind"],
        "l.source_kind='unknown' OR n.source_kind IS l.source_kind") ||
      !covered("token_usage_gaps", ["ends_ms"]) ||
      !covered("token_usage_rollouts", ["path", "cursor", "last_success_ms", "error_kind"]) ||
      !covered("token_usage_checkpoints", ["cursor"]) ||
      !covered("token_usage_metadata_scans", ["cursor"])) return false;
    if (db.prepare(`SELECT 1 FROM legacy_usage.token_usage_turns l
      JOIN main.token_usage_turns n USING(server_id,thread_id,turn_id)
      WHERE (l.execution_state!='running' AND n.execution_state IS NOT l.execution_state)
        OR (l.frozen=1 AND n.frozen!=1) LIMIT 1`).get()) return false;
    // Identity and the source-version ordering are the ledger's existing
    // authority. Unknown legacy model identities may have been backfilled in
    // the dedicated store; known conflicting identities are not guessed away.
    return !db.prepare(`SELECT 1 FROM legacy_usage.token_usage_sources l
      LEFT JOIN main.token_usage_sources n
        ON n.server_id=l.server_id AND n.thread_id=l.thread_id AND n.turn_id=l.turn_id
        AND n.lineage=l.lineage AND n.source_kind=l.source_kind AND n.source_id=l.source_id
      WHERE n.source_id IS NULL OR n.source_version<l.source_version
        OR (n.source_version=l.source_version AND n.counts_json IS NOT l.counts_json)
        OR (l.provider IS NOT NULL AND l.provider IS NOT n.provider)
        OR (l.model IS NOT NULL AND l.model IS NOT n.model)
      LIMIT 1`).get();
  }
  /** Moving baselines retain their epoch and monotonic cumulative version.
   * Historical per-turn amounts are also checked through versioned sources. */
  private coversLegacyCounters(): boolean {
    const db = this.database;
    const counts = (value: unknown): Record<string, string> => JSON.parse(String(value));
    const atLeast = (next: Record<string, string>, old: Record<string, string>) =>
      Object.entries(old).every(([key, value]) => typeof next[key] === "string" &&
        /^\d+$/.test(value) && /^\d+$/.test(next[key]!) && BigInt(next[key]!) >= BigInt(value));
    for (const old of db.prepare("SELECT * FROM legacy_usage.token_usage_native_counters").iterate()) {
      const next = db.prepare("SELECT * FROM main.token_usage_native_counters WHERE server_id=? AND thread_id=?")
        .get(old.server_id!, old.thread_id!);
      if (!next || next.epoch !== old.epoch || Number(next.source_version) < Number(old.source_version) ||
        (old.broken === 1 && next.broken !== 1)) return false;
      try {
        const before = counts(old.cumulative_json), after = counts(next.cumulative_json);
        if (!atLeast(after, before) || (next.source_version === old.source_version && !atLeast(before, after))) return false;
        const baseline = counts(next.baseline_json);
        if (!atLeast(after, baseline) || !atLeast(baseline, counts(old.baseline_json))) return false;
        if (next.turn_id === old.turn_id) {
          if (next.baseline_json !== old.baseline_json) return false;
        } else {
          if (!next.turn_id || !atLeast(baseline, before)) return false;
          if (old.turn_id !== null) {
            const previous = db.prepare(`SELECT execution_state,usage_complete FROM main.token_usage_turns
              WHERE server_id=? AND thread_id=? AND turn_id=?`).get(old.server_id!, old.thread_id!, old.turn_id!);
            if (!previous || previous.execution_state === "running" || previous.usage_complete !== 1) return false;
          }
          if (!db.prepare("SELECT 1 FROM main.token_usage_turns WHERE server_id=? AND thread_id=? AND turn_id=?")
            .get(next.server_id!, next.thread_id!, next.turn_id!)) return false;
        }
      } catch { return false; }
    }
    return true;
  }
  transaction<T>(write: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = write(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.database.close(); }
}
