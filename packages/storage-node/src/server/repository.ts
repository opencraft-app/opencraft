import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { openManagedDatabase, SqliteLifecycleError, type DatabaseOutcome } from "@opencraft/sqlite-node";
import { serverLegacyOptions, type ServerStoreId } from "./legacy.js";

/** A trusted owner lends its connection; repositories never close borrowed handles. */
export type ServerDatabaseSource = string | { readonly database: DatabaseSync; readonly outcome: DatabaseOutcome };
export function openServerRepository(source: ServerDatabaseSource, store: ServerStoreId) {
  if (typeof source !== "string") {
    let closed = false;
    const scoped = <T extends object>(target: T): T => new Proxy(target, { get(object, key) {
      if (key === "close") return () => { closed = true; };
      const value = Reflect.get(object, key, object);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (closed) throw new Error("Server repository is closed");
        const result = Reflect.apply(value, object, args);
        return key === "prepare" ? scoped(result) : result;
      };
    } });
    return { database: scoped(source.database), outcome: source.outcome, close() { closed = true; } };
  }
  if (source !== ":memory:" && (existsSync(join(dirname(source), "opencraft-server.sqlite")) || existsSync(join(dirname(source), ".server-import")))) {
    throw new SqliteLifecycleError("unsupported-legacy", "Server data is consolidated; use the Server storage owner");
  }
  const managed = openManagedDatabase({ path: source, ...serverLegacyOptions(store) });
  return { ...managed, close() { managed.database.close(); } };
}
