import { OPENCRAFT_HOST_TOKEN_USAGE_FROZEN } from "./token-usage-frozen-schema.js";
import { OPENCRAFT_HOST_TOKEN_USAGE_ACTORS } from "./token-usage-actor-schema.js";
import { OPENCRAFT_HOST_TOKEN_USAGE_ATTEMPTS } from "./token-usage-attempt-schema.js";
import { OPENCRAFT_HOST_TOKEN_USAGE_QUERY } from "./token-usage-query-schema.js";
import { OPENCRAFT_HOST_TOKEN_USAGE_COUNTERS } from "./token-usage-counter-schema.js";
import { ownedDatabasePath } from "./owned-database-path.js";
import { acquireOwnedStorageLease } from "./owned-storage-lease.js";
import type { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, createSchemaValidator, createMissingLegacyObjects, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { OPENCRAFT_HOST_TOKEN_USAGE } from "./token-usage-schema.js";
import { OPENCRAFT_HOST_TOKEN_USAGE_RUNTIME } from "./token-usage-runtime-schema.js";

export const OPENCRAFT_HOST_STATE_BASELINE = `
CREATE TABLE codex_host_queue (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        input_json TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','dispatching','steering','unknown','delivered','discarded')),
        target_turn_id TEXT,
        paused_reason TEXT,
        UNIQUE(thread_id, client_id)
      ) STRICT;
      CREATE INDEX codex_host_queue_order ON codex_host_queue(thread_id, position, created_at_ms);
      CREATE INDEX codex_host_queue_state ON codex_host_queue(state, thread_id);
CREATE TABLE message_senders (
        thread_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
        sender_json TEXT NOT NULL, accepted_at_ms INTEGER NOT NULL,
        PRIMARY KEY(thread_id,client_message_id)
      ) STRICT;
CREATE TABLE ioa_message_presence (
      thread_id TEXT NOT NULL, client_message_id TEXT NOT NULL, login_name TEXT NOT NULL,
      PRIMARY KEY(thread_id,client_message_id)) STRICT;
      CREATE INDEX ioa_presence_names ON ioa_message_presence(thread_id,login_name);
      CREATE TABLE ioa_participant_state (
      thread_id TEXT PRIMARY KEY, revision INTEGER NOT NULL) STRICT;
`;

/** v2 is additive; the published v1 SQL above is intentionally unchanged. */
export const OPENCRAFT_HOST_BOT_STATE = `
CREATE TABLE codex_bot_rooms (
  thread_id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL,
  cwd TEXT, draft INTEGER NOT NULL DEFAULT 0, native_thread_id TEXT
);
CREATE TABLE codex_bot_commands (command_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT);
CREATE TABLE codex_bot_message_slots (
  room_id TEXT NOT NULL, turn_id TEXT NOT NULL, kind TEXT NOT NULL, ordinal INTEGER NOT NULL,
  native_id TEXT, PRIMARY KEY(room_id, turn_id, kind, ordinal), UNIQUE(room_id, turn_id, kind, native_id)
);
`;
export const OPENCRAFT_HOST_IOA_CREATORS = `
CREATE TABLE ioa_thread_creators (
  thread_id TEXT PRIMARY KEY, login_name TEXT
) STRICT;
`;
/** Provenance is independent of the preserved author of a copied message. */
export const OPENCRAFT_HOST_SENDER_ORIGINS = `
CREATE TABLE message_sender_origins (
  thread_id TEXT NOT NULL, client_message_id TEXT NOT NULL, source_thread_id TEXT NOT NULL,
  PRIMARY KEY(thread_id,client_message_id)
) STRICT;
`;
const LEGACY_SCHEMA = OPENCRAFT_HOST_STATE_BASELINE + OPENCRAFT_HOST_BOT_STATE;
export const OPENCRAFT_HOST_CATALOG = `
CREATE TABLE codex_thread_catalog (
  thread_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL,
  updated_at REAL NOT NULL, archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  observed_at_ms INTEGER NOT NULL, revision INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))
) STRICT;
CREATE INDEX codex_thread_catalog_recency ON codex_thread_catalog(archived,deleted,updated_at DESC,thread_id);
CREATE TABLE codex_catalog_sync (
  archived INTEGER PRIMARY KEY CHECK(archived IN (0,1)),
  last_success_ms INTEGER, watermark REAL, last_full_ms INTEGER,
  state TEXT NOT NULL CHECK(state IN ('syncing','ready','error'))
) STRICT;
CREATE TABLE ioa_presence_sync (
  thread_id TEXT PRIMARY KEY, reconciled_at_ms INTEGER NOT NULL
) STRICT;
`;
const PRE_TOKEN_USAGE_SCHEMA = LEGACY_SCHEMA + OPENCRAFT_HOST_IOA_CREATORS + OPENCRAFT_HOST_SENDER_ORIGINS + OPENCRAFT_HOST_CATALOG;
const LEGACY_FULL_SCHEMA = PRE_TOKEN_USAGE_SCHEMA + OPENCRAFT_HOST_TOKEN_USAGE + OPENCRAFT_HOST_TOKEN_USAGE_RUNTIME + OPENCRAFT_HOST_TOKEN_USAGE_COUNTERS + OPENCRAFT_HOST_TOKEN_USAGE_QUERY + OPENCRAFT_HOST_TOKEN_USAGE_ATTEMPTS + OPENCRAFT_HOST_TOKEN_USAGE_ACTORS + OPENCRAFT_HOST_TOKEN_USAGE_FROZEN;
/** v13 changes owned live names; published v1–v12 SQL remains byte-for-byte intact. */
export const OPENCRAFT_HOST_STATE_OWNED_NAMES = `
ALTER TABLE codex_host_queue RENAME TO opencraft_host_queue;
DROP INDEX codex_host_queue_order;
DROP INDEX codex_host_queue_state;
CREATE INDEX opencraft_host_queue_order ON opencraft_host_queue(thread_id, position, created_at_ms);
CREATE INDEX opencraft_host_queue_state ON opencraft_host_queue(state, thread_id);
ALTER TABLE codex_thread_catalog RENAME TO opencraft_thread_catalog;
DROP INDEX codex_thread_catalog_recency;
CREATE INDEX opencraft_thread_catalog_recency ON opencraft_thread_catalog(archived,deleted,updated_at DESC,thread_id);
ALTER TABLE codex_catalog_sync RENAME TO opencraft_catalog_sync;
`;
/** v14 preserves dormant Bot records under owned names; v1–v13 stay immutable. */
export const OPENCRAFT_HOST_BOT_OWNED_NAMES = `
ALTER TABLE codex_bot_rooms RENAME TO opencraft_bot_rooms;
ALTER TABLE codex_bot_commands RENAME TO opencraft_bot_commands;
ALTER TABLE codex_bot_message_slots RENAME TO opencraft_bot_message_slots;
`;
const PREVIOUS_OWNED_SCHEMA = LEGACY_FULL_SCHEMA + OPENCRAFT_HOST_STATE_OWNED_NAMES;
const FULL_SCHEMA = PREVIOUS_OWNED_SCHEMA + OPENCRAFT_HOST_BOT_OWNED_NAMES;
// Historical schema source and the deployed CREATE/ALTER sequence establish these
// room layouts. Only known objects/constraints are accepted; records are retained.
const LEGACY_ROOM_COLUMNS = [
  "thread_id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL",
  "thread_id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, native_thread_id TEXT",
  "thread_id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, native_thread_id TEXT, cwd TEXT, draft INTEGER NOT NULL DEFAULT 0",
  "thread_id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, cwd TEXT, draft INTEGER NOT NULL DEFAULT 0, native_thread_id TEXT",
];
const legacyCandidates = LEGACY_ROOM_COLUMNS.map(columns => createMissingLegacyObjects(
  LEGACY_SCHEMA.replace(/CREATE TABLE codex_bot_rooms \([\s\S]*?\);/, `CREATE TABLE codex_bot_rooms (${columns});`),
));
// The exact previously accepted unledgered v5 layout remains an accepted
// upgrade input. Do not broaden this to arbitrary subsets of later schemas.
const previousLegacy = createMissingLegacyObjects(PRE_TOKEN_USAGE_SCHEMA);
const previousObjectCount = (PRE_TOKEN_USAGE_SCHEMA.match(/CREATE (?:TABLE|INDEX) /g) ?? []).length;
const priorFullLegacy = createMissingLegacyObjects(LEGACY_FULL_SCHEMA);
const priorFullObjectCount = (LEGACY_FULL_SCHEMA.match(/CREATE (?:TABLE|INDEX) /g) ?? []).length;
// v13 only renames tables and replaces indices, so its complete object count is
// unchanged. Exact schema matching prevents accepting arbitrary partial layouts.
const previousOwnedLegacy = createMissingLegacyObjects(PREVIOUS_OWNED_SCHEMA);
const legacyMigration = {
  accepts: (fingerprint: string, objects: Parameters<(typeof legacyCandidates)[number]["accepts"]>[1]) =>
    legacyCandidates.some(candidate => candidate.accepts(fingerprint, objects)) ||
    (objects.length === previousObjectCount && previousLegacy.accepts(fingerprint, objects)) ||
    (objects.length === priorFullObjectCount && (priorFullLegacy.accepts(fingerprint, objects) || previousOwnedLegacy.accepts(fingerprint, objects))),
  migrate: (database: DatabaseSync) => {
    // A complete previous schema was formerly adopted without replaying its ALTERs.
    const objects = database.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name!='schema_migrations' ORDER BY type,name")
      .all() as Array<{ type: string; name: string; sql: string }>;
    if (objects.length === priorFullObjectCount && previousOwnedLegacy.accepts("", objects)) {
      database.exec(OPENCRAFT_HOST_BOT_OWNED_NAMES);
      return;
    }
    if (objects.length === priorFullObjectCount && priorFullLegacy.accepts("", objects)) {
      database.exec(OPENCRAFT_HOST_STATE_OWNED_NAMES + OPENCRAFT_HOST_BOT_OWNED_NAMES);
      return;
    }
    const columns = database.prepare("PRAGMA table_info(codex_bot_rooms)").all().map(row => String(row.name));
    if (columns.length && columns.join(",") !== "thread_id,created_ms,cwd,draft,native_thread_id") {
      database.exec("ALTER TABLE codex_bot_rooms RENAME TO codex_bot_rooms_legacy");
      database.exec(OPENCRAFT_HOST_BOT_STATE.slice(0, OPENCRAFT_HOST_BOT_STATE.indexOf("CREATE TABLE codex_bot_commands")));
      const existing = (name: string, fallback: string) => columns.includes(name) ? name : fallback;
      database.exec(`INSERT INTO codex_bot_rooms(thread_id,created_ms,cwd,draft,native_thread_id)
        SELECT thread_id,created_ms,${existing("cwd", "NULL")},${existing("draft", "0")},${existing("native_thread_id", "NULL")}
        FROM codex_bot_rooms_legacy; DROP TABLE codex_bot_rooms_legacy;`);
    }
    database.exec(LEGACY_FULL_SCHEMA.replace(/CREATE (TABLE|INDEX) /g, "CREATE $1 IF NOT EXISTS "));
    database.exec(OPENCRAFT_HOST_STATE_OWNED_NAMES + OPENCRAFT_HOST_BOT_OWNED_NAMES);
  },
};

/** Queue and message provenance share the existing per-Host file and transaction owner. */
export const OPENCRAFT_HOST_STATE_MIGRATIONS = [
  { version: 1, name: "codex-host-state", sql: OPENCRAFT_HOST_STATE_BASELINE },
  { version: 2, name: "codex-bot-state", sql: OPENCRAFT_HOST_BOT_STATE },
  { version: 3, name: "ioa-thread-creators", sql: OPENCRAFT_HOST_IOA_CREATORS },
  { version: 4, name: "message-sender-origins", sql: OPENCRAFT_HOST_SENDER_ORIGINS },
  { version: 5, name: "durable-thread-catalog", sql: OPENCRAFT_HOST_CATALOG },
  { version: 6, name: "token-usage-metering", sql: OPENCRAFT_HOST_TOKEN_USAGE },
  { version: 7, name: "token-usage-recovery", sql: OPENCRAFT_HOST_TOKEN_USAGE_RUNTIME },
  { version: 8, name: "token-usage-native-counters", sql: OPENCRAFT_HOST_TOKEN_USAGE_COUNTERS },
  { version: 9, name: "token-usage-query-indexes", sql: OPENCRAFT_HOST_TOKEN_USAGE_QUERY },
  { version: 10, name: "token-usage-delivery-attempts", sql: OPENCRAFT_HOST_TOKEN_USAGE_ATTEMPTS },
  { version: 11, name: "token-usage-actor-projections", sql: OPENCRAFT_HOST_TOKEN_USAGE_ACTORS },
  { version: 12, name: "token-usage-frozen-coverage", sql: OPENCRAFT_HOST_TOKEN_USAGE_FROZEN },
  { version: 13, name: "opencraft-host-state-owned-names", sql: OPENCRAFT_HOST_STATE_OWNED_NAMES },
  { version: 14, name: "opencraft-host-bot-owned-names", sql: OPENCRAFT_HOST_BOT_OWNED_NAMES },
] as const;

export class OpenCraftHostStateDatabase {
  readonly database: DatabaseSync;
  readonly outcome: DatabaseOutcome;
  readonly path: string;
  private readonly releaseLease: () => void;
  constructor(directory: string) {
    ownedDatabasePath(directory, "opencraft-host-state.sqlite", "codex-host-queue.sqlite");
    this.releaseLease = acquireOwnedStorageLease(directory);
    try {
      const path = this.path = ownedDatabasePath(directory, "opencraft-host-state.sqlite", "codex-host-queue.sqlite");
      const managed = openManagedDatabase({ path, legacyPolicy: "reject-unknown", validateSchema: createSchemaValidator(FULL_SCHEMA),
        migrations: OPENCRAFT_HOST_STATE_MIGRATIONS, legacyMigration });
      this.database = managed.database;
      this.outcome = managed.outcome;
    } catch (error) { this.releaseLease(); throw error; }
  }
  transaction<T>(write: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = write(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  close(): void { try { this.database.close(); } finally { this.releaseLease(); } }
}
