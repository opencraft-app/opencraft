import type { SqlDatabase } from "@opencraft/sql";
import { nodeSqlDatabase, type NodeSqliteConnection } from "@opencraft/sqlite-node";

/** Host stores borrow the SQL port. Owners that still lend their node:sqlite connection (the Hub thread-identity
 * database, tests) are adapted at the borrower boundary; one connection always maps to the same port object. */
export type SqlConnection = SqlDatabase | NodeSqliteConnection;
export function sqlPort(connection: SqlConnection): SqlDatabase {
  return "inTransaction" in connection ? connection : nodeSqlDatabase(connection);
}
