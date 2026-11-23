import type { SqlDatabase, SqlStatement } from "@opencraft/sql";
import { transaction } from "./migrations.js";

/** The part of a node:sqlite connection the SQL port adapter uses. */
export interface NodeSqliteConnection {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  readonly isTransaction: boolean;
}

const adapters = new WeakMap<NodeSqliteConnection, SqlDatabase>();

/**
 * The SQL port over a node:sqlite connection. One connection always maps to
 * the same port object, because owners group change notifications and
 * projections by connection identity. The opener keeps lifecycle authority
 * (PRAGMA policy, migrations, backup, close); the port exposes none of it.
 */
export function nodeSqlDatabase(connection: NodeSqliteConnection): SqlDatabase {
  let adapter = adapters.get(connection);
  if (!adapter) {
    adapter = {
      prepare: (sql) => connection.prepare(sql),
      exec: (sql) => connection.exec(sql),
      transaction: (action) => transaction(connection, action),
      get inTransaction() {
        return connection.isTransaction;
      },
    };
    adapters.set(connection, adapter);
  }
  return adapter;
}
