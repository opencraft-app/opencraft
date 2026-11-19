import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SqliteLifecycleError, type Migration } from "@opencraft/sqlite-node";
import { SERVER_MIGRATIONS, SERVER_ALTERNATE_MIGRATIONS } from "./migrations.generated.js";

/** Select a declared exact history under the installation writer fence. No ledger
 * row is edited or adopted. The managed opener still validates every applied row
 * and performs normal backup/recovery before appending the missing SQL. */
export function serverMigrationsFor(path: string): readonly Migration[] {
  if (!existsSync(path)) return SERVER_MIGRATIONS;
  const db = new DatabaseSync(path, {readOnly:true});
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) return SERVER_MIGRATIONS;
    const rows=db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
    const chains: readonly (readonly Migration[])[] = [SERVER_MIGRATIONS,...SERVER_ALTERNATE_MIGRATIONS.map(entry=>entry.migrations)];
    for (const chain of chains) if (rows.length <= chain.length && rows.every((row,index)=>{
      const expected=chain[index]!;
      return row.version === index+1 && row.name === expected.name && row.checksum === createHash("sha256").update(expected.sql).digest("hex");
    })) return chain;
    if (rows.some(row=>Number(row.version)>Math.max(...chains.map(chain=>chain.length)))) throw new SqliteLifecycleError("newer-schema","Unsupported newer Server history");
    throw new SqliteLifecycleError("history-mismatch","Server ledger does not match a declared published lineage");
  } catch(error) {
    if (error instanceof SqliteLifecycleError) throw error;
    throw new SqliteLifecycleError("history-mismatch","Server ledger could not be verified",{cause:error});
  } finally { db.close(); }
}
