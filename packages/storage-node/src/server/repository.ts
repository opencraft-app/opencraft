import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { nodeSqlDatabase, openManagedDatabase, SqliteLifecycleError } from "@opencraft/sqlite-node";
import { serverLegacyOptions, type ServerStoreId } from "./legacy.js";
import { borrowServerRepository, type ServerDatabaseSource, type ServerRepository } from "./repository-handle.js";

export { borrowServerRepository, type ServerDatabaseHandle, type ServerDatabaseSource, type ServerRepository } from "./repository-handle.js";

export function openServerRepository(source: ServerDatabaseSource, store: ServerStoreId): ServerRepository {
  if (typeof source !== "string") return borrowServerRepository(source);
  if (source !== ":memory:" && (existsSync(join(dirname(source), "opencraft-server.sqlite")) || existsSync(join(dirname(source), ".server-import")))) {
    throw new SqliteLifecycleError("unsupported-legacy", "Server data is consolidated; use the Server storage owner");
  }
  const managed = openManagedDatabase({ path: source, ...serverLegacyOptions(store) });
  const location = managed.database.location() ?? undefined;
  return { database: nodeSqlDatabase(managed.database), outcome: managed.outcome, ...(location ? { location } : {}), close() { managed.database.close(); } };
}
