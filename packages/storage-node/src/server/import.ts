import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openManagedDatabase, sqliteTransaction, SqliteLifecycleError, durableJson, assertRecoveryState } from "@opencraft/sqlite-node";
import { SERVER_LEGACY_MIGRATIONS, serverLegacyOptions, type ServerStoreId } from "./legacy.js";

const stores = Object.keys(SERVER_LEGACY_MIGRATIONS) as ServerStoreId[];
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const encode = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? { bigint: String(item) }
  : item instanceof Uint8Array ? { bytes: Buffer.from(item).toString("base64") } : item);
function tables(database: DatabaseSync): string[] {
  return database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations' ORDER BY name")
    .all().map(row => String(row.name));
}

/** Logical digest includes committed WAL rows, schema and the exact published ledger. */
function digest(database: DatabaseSync): string {
  const hash = createHash("sha256");
  hash.update(encode(database.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()));
  const names = [...tables(database), ...database.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").all().map(() => "schema_migrations")];
  for (const table of names) {
    hash.update(table);
    const columns = database.prepare(`PRAGMA table_info(${identifier(table)})`).all();
    const order = columns.filter(c => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(c => identifier(String(c.name)));
    const query = database.prepare(`SELECT * FROM ${identifier(table)} ORDER BY ${order.length ? order.join(",") : "rowid"}`);
    query.setReadBigInts(true);
    for (const row of query.iterate()) hash.update(encode(row) + "\n");
  }
  return hash.digest("hex");
}

function sourceDigest(path: string): string {
  assertRecoveryState(path);
  if (!existsSync(path)) {
    if (["-wal", "-shm", "-journal"].some(suffix => existsSync(path + suffix))) throw new SqliteLifecycleError("io", "Legacy Server database has orphaned sidecars");
    return "absent";
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    return digest(db);
  } finally { db.close(); }
}

function verifySources(database: DatabaseSync, directory: string): void {
  const receipts = database.prepare("SELECT source,source_digest FROM opencraft_server_imports").all();
  if (receipts.length !== stores.length) throw new SqliteLifecycleError("history-mismatch", "Incomplete Server import receipts");
  for (const store of stores) {
    const expected = receipts.find(row => row.source === store)?.source_digest;
    const path = join(directory, `${store}.sqlite`);
    if (!existsSync(path) && expected && expected !== "absent") {
      if (["-wal", "-shm", "-journal"].some(suffix => existsSync(path + suffix))) {
        throw new SqliteLifecycleError("history-mismatch", `Retired Server source has orphaned sidecars (${store})`);
      }
      // The consolidated database is authoritative and can be restored without retired files.
      continue;
    }
    if (expected !== sourceDigest(path)) {
      throw new SqliteLifecycleError("history-mismatch", `Retired Server source changed (${store}); stop old writers and resolve the data conflict`);
    }
  }
}

interface PreparedSource { store: ServerStoreId; signature: string; snapshot?: string; working?: string; history: string }

/** All six source receipts and all business rows commit in one destination transaction. */
export function importServerData(database: DatabaseSync, directory: string, contract: { productVersion: string; hash: string }): "fresh" | "migrated" | "up-to-date" {
  const installation = database.prepare("SELECT * FROM opencraft_server_installation WHERE singleton=1").get();
  if (installation) {
    verifySources(database, directory);
    database.prepare("UPDATE opencraft_server_installation SET product_version=?,contract_hash=?,completed_at=? WHERE singleton=1")
      .run(contract.productVersion, contract.hash, Date.now());
    return "up-to-date";
  }
  const root = join(directory, ".server-import");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const journal = join(root, "pending.json");
  let operationId = randomUUID() as string;
  if (existsSync(journal)) {
    const saved: unknown = JSON.parse(readFileSync(journal, "utf8"));
    if (!saved || typeof saved !== "object" || !("operationId" in saved) || typeof saved.operationId !== "string"
      || !/^[a-f0-9-]{36}$/.test(saved.operationId)) throw new SqliteLifecycleError("history-mismatch", "Invalid Server import journal");
    operationId = saved.operationId;
  } else durableJson(journal, { operationId });
  const backupDirectory = join(root, operationId);
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const prepared: PreparedSource[] = [];
  for (const store of stores) {
    const path = join(directory, `${store}.sqlite`);
    const signature = sourceDigest(path);
    if (signature === "absent") { prepared.push({ store, signature, history: "[]" }); continue; }
    const snapshot = join(backupDirectory, `${store}.original.sqlite`);
    if (!existsSync(snapshot)) {
      const temporary = snapshot + ".partial";
      if (existsSync(temporary)) unlinkSync(temporary);
      writeFileSync(temporary, "", { flag: "wx", mode: 0o600 });
      const source = new DatabaseSync(path, { readOnly: true });
      try { source.prepare("VACUUM INTO ?").run(temporary); }
      finally { source.close(); }
      renameSync(temporary, snapshot);
    }
    const original = new DatabaseSync(snapshot, { readOnly: true });
    let history: string;
    try {
      if (digest(original) !== signature) throw new SqliteLifecycleError("history-mismatch", `Server source changed during import (${store})`);
      const ledger = original.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get();
      history = encode(ledger ? original.prepare("SELECT * FROM schema_migrations ORDER BY version").all() : []);
    } finally { original.close(); }
    const working = join(backupDirectory, `${store}.working.sqlite`);
    for (const suffix of ["", "-wal", "-shm", ".pending-migration.json"]) if (existsSync(working + suffix)) unlinkSync(working + suffix);
    copyFileSync(snapshot, working);
    const migrated = openManagedDatabase({ path: working, ...serverLegacyOptions(store) });
    migrated.database.close();
    prepared.push({ store, signature, snapshot, working, history });
  }
  durableJson(join(backupDirectory, "sources.json"), { operationId, sources: prepared });
  const attached: string[] = [];
  try {
    for (const [index, source] of prepared.entries()) if (source.working) {
      const alias = `legacy_${index}`;
      database.prepare(`ATTACH DATABASE ? AS ${alias}`).run(source.working);
      attached.push(alias);
    }
    sqliteTransaction(database, () => {
      database.exec("PRAGMA defer_foreign_keys=ON");
      for (const [index, source] of prepared.entries()) {
        const counts: Record<string, number> = {};
        if (source.working) {
          const alias = `legacy_${index}`;
          const tableNames = database.prepare(`SELECT name FROM ${alias}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations' ORDER BY name`).all();
          for (const row of tableNames) {
            const table = identifier(String(row.name));
            const columns = database.prepare(`PRAGMA ${alias}.table_info(${table})`).all().map(column => identifier(String(column.name))).join(",");
            database.exec(`INSERT INTO main.${table}(${columns}) SELECT ${columns} FROM ${alias}.${table}`);
            const expected = Number(database.prepare(`SELECT count(*) AS n FROM ${alias}.${table}`).get()!.n);
            const actual = Number(database.prepare(`SELECT count(*) AS n FROM main.${table}`).get()!.n);
            if (expected !== actual || database.prepare(`SELECT ${columns} FROM ${alias}.${table} EXCEPT SELECT ${columns} FROM main.${table} LIMIT 1`).get()) {
              throw new SqliteLifecycleError("history-mismatch", `Server import verification failed (${source.store})`);
            }
            counts[String(row.name)] = actual;
          }
        }
        if (sourceDigest(join(directory, `${source.store}.sqlite`)) !== source.signature) throw new SqliteLifecycleError("busy", "A legacy Server writer is still active");
        database.prepare("INSERT INTO opencraft_server_imports VALUES(?,?,?,?,?,?)").run(source.store, source.signature, source.history,
          JSON.stringify(counts), source.snapshot ?? "", Date.now());
      }
      if (database.prepare("PRAGMA main.foreign_key_check").get()) throw new SqliteLifecycleError("history-mismatch", "Server import contains broken references");
      if (database.prepare("SELECT 1 FROM actors LIMIT 1").get() && !database.prepare("SELECT id FROM actor_authority WHERE singleton=1").get()) {
        throw new SqliteLifecycleError("history-mismatch", "Server import is missing its Actor authority; refusing to generate a replacement identity");
      }
      for (const table of ["human_logins", "actor_members"]) if (database.prepare(`SELECT 1 FROM ${table} r LEFT JOIN actors a ON a.id=r.actor_id WHERE a.id IS NULL LIMIT 1`).get()) {
        throw new SqliteLifecycleError("history-mismatch", "Server import refers to a missing Actor authority");
      }
      database.prepare("INSERT INTO opencraft_server_installation VALUES(1,?,?,?)").run(contract.productVersion, contract.hash, Date.now());
    });
  } finally { for (const alias of attached.reverse()) database.exec(`DETACH DATABASE ${alias}`); }
  // A committed import remains successful if maintenance of its journal fails.
  try { unlinkSync(journal); } catch { /* The installation receipt is authoritative on restart. */ }
  return prepared.some(source => source.snapshot) ? "migrated" : "fresh";
}
