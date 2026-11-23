import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SqliteLifecycleError, type Migration } from "@opencraft/sqlite-node";
import type { ServerMigrationComposition } from "./migration-composition.js";
import type { AdoptableLineage } from "./extension-families.js";

export interface ServerOpenPlan {
  /** The chain the core ledger continues on. */
  readonly chain: readonly Migration[];
  /** Set when the ledger is a prefix of a declared adoptable lineage. */
  readonly adopt?: AdoptableLineage;
}

/** Select a declared exact history under the installation writer fence. No ledger
 * row is edited here. The managed opener still validates every applied row and
 * performs normal backup/recovery before appending the missing SQL; a lineage
 * declared for adoption is completed and adopted by the caller. */
export function planServerOpen(path: string, composition: ServerMigrationComposition): ServerOpenPlan {
  if (!existsSync(path)) return { chain: composition.canonical };
  const db = new DatabaseSync(path, {readOnly:true});
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) return { chain: composition.canonical };
    const rows=db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
    // Canonical first: a ledger that is also a canonical prefix stays on core.
    const histories = [{ id: "", migrations: composition.canonical }, ...composition.alternates];
    for (const history of histories) {
      const chain = history.migrations;
      if (rows.length <= chain.length && rows.every((row,index)=>{
        const expected=chain[index]!;
        return row.version === index+1 && row.name === expected.name && row.checksum === createHash("sha256").update(expected.sql).digest("hex");
      })) return "adopts" in history && history.adopts ? { chain, adopt: history as AdoptableLineage } : { chain };
    }
    if (rows.some(row=>Number(row.version)>Math.max(...histories.map(history=>history.migrations.length)))) throw new SqliteLifecycleError("newer-schema","Unsupported newer Server history");
    throw new SqliteLifecycleError("history-mismatch","Server ledger does not match a declared published lineage");
  } catch(error) {
    if (error instanceof SqliteLifecycleError) throw error;
    throw new SqliteLifecycleError("history-mismatch","Server ledger could not be verified",{cause:error});
  } finally { db.close(); }
}
