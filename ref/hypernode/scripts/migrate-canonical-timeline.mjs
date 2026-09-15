#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CANONICAL_SCHEMA_VERSION,
  prepareCanonicalTimelineEventForStorage,
} from "../policy/src/services/canonical-timeline.ts";

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const databasePath = resolve(option("--db", process.env.HYPERNODE_DATABASE ?? ".runtime/hypernode.sqlite"));
const dryRun = process.argv.includes("--dry-run");
if (!existsSync(databasePath)) throw new Error(`HyperNode database does not exist: ${databasePath}`);

const database = new DatabaseSync(databasePath);
database.exec("PRAGMA busy_timeout = 10000");

function tableExists(name) {
  return Boolean(database.prepare(`
    SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function tableColumns(name) {
  if (!tableExists(name)) return new Set();
  return new Set(database.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name));
}

function timestampMs(value, fallback = Date.now()) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number < 1_000_000_000_000 ? number * 1_000 : number;
}
if (!dryRun) {
  if (tableExists("hypernode_canonical_timeline_meta") &&
      !tableColumns("hypernode_canonical_timeline_meta").has("singleton")) {
    database.exec(`DROP TABLE hypernode_canonical_timeline_meta`);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS hypernode_canonical_timeline_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      schema_version INTEGER NOT NULL,
      migrated_at_ms INTEGER NOT NULL
    )
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS hypernode_canonical_timeline_heads (
      thread_id TEXT PRIMARY KEY,
      epoch TEXT NOT NULL,
      next_seq INTEGER NOT NULL,
      min_seq INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS hypernode_canonical_timeline_entries (
      thread_id TEXT NOT NULL,
      epoch TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT ${CANONICAL_SCHEMA_VERSION},
      event_type TEXT,
      occurred_at_ms INTEGER,
      turn_id TEXT,
      item_id TEXT,
      source_engine TEXT,
      source_kind TEXT,
      payload_hash TEXT,
      item_type TEXT,
      search_role TEXT,
      search_text TEXT,
      event_json TEXT NOT NULL,
      PRIMARY KEY(thread_id, epoch, seq),
      UNIQUE(thread_id, epoch, event_id)
    )
  `);
  const entryColumns = new Set(database.prepare(
    "PRAGMA table_info(hypernode_canonical_timeline_entries)",
  ).all().map((column) => column.name));
  for (const [name, definition] of Object.entries({
    schema_version: "INTEGER NOT NULL DEFAULT 1",
    event_type: "TEXT",
    occurred_at_ms: "INTEGER",
    turn_id: "TEXT",
    item_id: "TEXT",
    source_engine: "TEXT",
    source_kind: "TEXT",
    payload_hash: "TEXT",
    item_type: "TEXT",
    search_role: "TEXT",
    search_text: "TEXT",
  })) {
    if (!entryColumns.has(name)) database.exec(
      `ALTER TABLE hypernode_canonical_timeline_entries ADD COLUMN ${name} ${definition}`,
    );
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS hypernode_canonical_timeline_blobs (
      blob_hash TEXT PRIMARY KEY,
      encoding TEXT NOT NULL,
      media_type TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS hypernode_canonical_timeline_blob_refs (
      thread_id TEXT NOT NULL,
      epoch TEXT NOT NULL,
      seq INTEGER NOT NULL,
      blob_hash TEXT NOT NULL,
      PRIMARY KEY(thread_id, epoch, seq, blob_hash)
    )
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS hypernode_canonical_timeline_failures (
      failure_id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      method TEXT NOT NULL,
      event_id TEXT,
      source_engine TEXT,
      error_message TEXT NOT NULL,
      failed_at_ms INTEGER NOT NULL,
      resolved_at_ms INTEGER
    )
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS hypernode_canonical_timeline_turn_seq
    ON hypernode_canonical_timeline_entries(thread_id, epoch, turn_id, seq)
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS hypernode_canonical_timeline_item_seq
    ON hypernode_canonical_timeline_entries(thread_id, epoch, item_id, seq)
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS hypernode_canonical_timeline_type_seq
    ON hypernode_canonical_timeline_entries(thread_id, epoch, event_type, seq)
  `);
}

const legacyTable = tableExists("do_thread_catalog_turns");

// Shared tasks may have appeared in more than one principal projection. Pick
// one row per task/turn, preferring the richer payload, while retaining the
// original position as the migration order.
const selected = new Map();
if (legacyTable) {
  for (const row of database.prepare(`
    SELECT principal_id, thread_id, turn_id, position, payload
    FROM do_thread_catalog_turns
    ORDER BY thread_id, position, turn_id
  `).all()) {
    const key = `${row.thread_id}\0${row.turn_id}`;
    const current = selected.get(key);
    if (!current || String(row.payload).length > String(current.payload).length) selected.set(key, row);
  }
}

const byThread = new Map();
for (const row of selected.values()) {
  const rows = byThread.get(row.thread_id) ?? [];
  rows.push(row);
  byThread.set(row.thread_id, rows);
}
for (const rows of byThread.values()) rows.sort((left, right) => (
  Number(left.position) - Number(right.position) || String(left.turn_id).localeCompare(String(right.turn_id))
));

const canonicalTable = tableExists("hypernode_canonical_timeline_heads");
const existingHead = canonicalTable
  ? database.prepare(`
      SELECT epoch, next_seq FROM hypernode_canonical_timeline_heads WHERE thread_id = ?
    `)
  : { get: () => null };
const insertHead = dryRun ? null : database.prepare(`
  INSERT INTO hypernode_canonical_timeline_heads(thread_id, epoch, next_seq, min_seq, updated_at_ms)
  VALUES(?, ?, ?, 0, ?)
`);
const insertEntry = dryRun ? null : database.prepare(`
  INSERT INTO hypernode_canonical_timeline_entries(
    thread_id, epoch, seq, event_id, schema_version, event_type, occurred_at_ms,
    turn_id, item_id, source_engine, source_kind, payload_hash,
    item_type, search_role, search_text, event_json
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const putBlob = dryRun ? null : database.prepare(`
  INSERT OR IGNORE INTO hypernode_canonical_timeline_blobs(
    blob_hash, encoding, media_type, byte_length, content, created_at_ms
  ) VALUES(?, 'utf8', ?, ?, ?, ?)
`);
const putBlobRef = dryRun ? null : database.prepare(`
  INSERT OR IGNORE INTO hypernode_canonical_timeline_blob_refs(
    thread_id, epoch, seq, blob_hash
  ) VALUES(?, ?, ?, ?)
`);
const updateEntry = dryRun ? null : database.prepare(`
  UPDATE hypernode_canonical_timeline_entries SET
    schema_version = ?, event_type = ?, occurred_at_ms = ?, turn_id = ?, item_id = ?,
    source_engine = ?, source_kind = ?, payload_hash = ?, item_type = ?, search_role = ?,
    search_text = ?, event_json = ?
  WHERE thread_id = ? AND epoch = ? AND seq = ?
`);

function prepareEvent(event) {
  return prepareCanonicalTimelineEventForStorage(event, (hash, content, bytes, mediaType) => {
    putBlob.run(hash, mediaType, bytes, content, Date.now());
  });
}

let migratedThreads = 0;
let migratedTurns = 0;
let migratedFacts = 0;
let skippedThreads = 0;
let upgradedFacts = 0;
database.exec(dryRun ? "BEGIN" : "BEGIN IMMEDIATE");
try {
  if (tableExists("hypernode_canonical_timeline_entries")) {
    const columns = tableColumns("hypernode_canonical_timeline_entries");
    const selectedColumns = ["thread_id", "epoch", "seq", "event_json"];
    for (const column of ["schema_version", "event_type", "source_kind", "payload_hash"]) {
      if (columns.has(column)) selectedColumns.push(column);
    }
    const existingEntries = database.prepare(`
      SELECT ${selectedColumns.join(", ")}
      FROM hypernode_canonical_timeline_entries ORDER BY thread_id, epoch, seq
    `).all();
    for (const row of existingEntries) {
      if (Number(row.schema_version) === CANONICAL_SCHEMA_VERSION && row.payload_hash &&
          row.event_type && row.source_kind) continue;
      const event = JSON.parse(row.event_json);
      if (dryRun) {
        prepareCanonicalTimelineEventForStorage(event);
        upgradedFacts += 1;
        continue;
      }
      const prepared = prepareEvent(event);
      const normalized = prepared.normalized;
      updateEntry.run(
        normalized.schemaVersion, normalized.eventType, normalized.occurredAtMs,
        normalized.turnId, normalized.itemId, normalized.sourceEngine, normalized.sourceKind,
        prepared.payloadHash, normalized.itemType, normalized.searchRole, normalized.searchText,
        JSON.stringify(prepared.storedEvent), row.thread_id, row.epoch, row.seq,
      );
      for (const hash of prepared.blobHashes) putBlobRef.run(row.thread_id, row.epoch, row.seq, hash);
      upgradedFacts += 1;
    }
  }
  for (const [threadId, rows] of byThread) {
    const existing = existingHead.get(threadId);
    if (existing && Number(existing.next_seq) > 0) {
      skippedThreads += 1;
      continue;
    }
    if (dryRun) {
      migratedThreads += 1;
      migratedTurns += rows.length;
      migratedFacts += rows.reduce((count, row) => {
        const turn = JSON.parse(row.payload);
        return count + 2 + (Array.isArray(turn.items) ? turn.items.length : 0);
      }, 0);
      continue;
    }
    const epoch = existing?.epoch ?? randomUUID();
    const facts = [];
    for (const row of rows) {
      const turn = JSON.parse(row.payload);
      const turnId = String(turn.id ?? row.turn_id);
      const baseTime = timestampMs(turn.completedAt ?? turn.startedAt);
      const migratedStatus = ["completed", "failed", "interrupted"].includes(turn.status)
        ? turn.status
        : "interrupted";
      const source = { engine: "migration", kind: "oneTimeImport" };
      facts.push({
        id: `turn/started:${turnId}`,
        type: "turn.started",
        time: timestampMs(turn.startedAt, baseTime),
        turnId,
        itemId: null,
        data: {
          method: "turn/started",
          params: {
            threadId,
            turn: { ...turn, id: turnId, status: "inProgress", items: [] },
          },
        },
        source,
      });
      for (const [itemIndex, rawItem] of (Array.isArray(turn.items) ? turn.items : []).entries()) {
        const item = { ...rawItem, id: String(rawItem?.id ?? `import-item-${itemIndex}`) };
        facts.push({
          id: `item/completed:${turnId}:${item.id}`,
          type: "item.completed",
          time: baseTime,
          turnId,
          itemId: item.id,
          data: {
            method: "item/completed",
            params: { threadId, turnId, item },
          },
          source,
        });
      }
      facts.push({
        id: `turn/completed:${turnId}`,
        type: "turn.completed",
        time: baseTime,
        turnId,
        itemId: null,
        data: {
          method: "turn/completed",
          params: {
            threadId,
            turn: { ...turn, id: turnId, status: migratedStatus, items: [] },
          },
        },
        source,
      });
    }
    if (!existing) insertHead.run(threadId, epoch, facts.length, Date.now());
    else database.prepare(`
      UPDATE hypernode_canonical_timeline_heads
      SET next_seq = ?, min_seq = 0, updated_at_ms = ? WHERE thread_id = ?
    `).run(facts.length, Date.now(), threadId);
    facts.forEach((fact, seq) => {
      const event = {
        id: fact.id,
        threadId,
        epoch,
        seq,
        type: fact.type,
        time: fact.time,
        turnId: fact.turnId,
        itemId: fact.itemId,
        data: fact.data,
        source: fact.source,
      };
      const prepared = prepareEvent(event);
      const normalized = prepared.normalized;
      insertEntry.run(
        threadId, epoch, seq, event.id, normalized.schemaVersion, normalized.eventType,
        normalized.occurredAtMs, normalized.turnId, normalized.itemId, normalized.sourceEngine,
        normalized.sourceKind, prepared.payloadHash, normalized.itemType, normalized.searchRole,
        normalized.searchText, JSON.stringify(prepared.storedEvent),
      );
      for (const hash of prepared.blobHashes) putBlobRef.run(threadId, epoch, seq, hash);
    });
    migratedThreads += 1;
    migratedTurns += rows.length;
    migratedFacts += facts.length;
  }
  if (!dryRun) {
    database.prepare(`
      INSERT INTO hypernode_canonical_timeline_meta(singleton, schema_version, migrated_at_ms)
      VALUES(1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        schema_version = excluded.schema_version,
        migrated_at_ms = excluded.migrated_at_ms
    `).run(CANONICAL_SCHEMA_VERSION, Date.now());
  }
  if (dryRun) database.exec("ROLLBACK");
  else database.exec("COMMIT");
} catch (error) {
  database.exec("ROLLBACK");
  throw error;
} finally {
  database.close();
}

console.log(JSON.stringify({
  databasePath,
  dryRun,
  sourceThreads: byThread.size,
  sourceTurns: selected.size,
  migratedThreads,
  migratedTurns,
  migratedFacts,
  upgradedFacts,
  skippedThreads,
}, null, 2));
