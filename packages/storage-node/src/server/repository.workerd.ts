import { borrowServerRepository, type ServerDatabaseSource, type ServerRepository } from "./repository-handle.js";
import type { ServerStoreId } from "./legacy.js";
export {
  borrowServerRepository,
  type ServerDatabaseHandle,
  type ServerDatabaseSource,
  type ServerRepository,
} from "./repository-handle.js";

/**
 * The `workerd` export of `@opencraft/storage-node/server-repository`. A
 * Durable Object owner (InstallationCore) lends its migrated SQL port; there
 * are no per-store files, legacy imports or node:sqlite in that runtime.
 */
export function openServerRepository(source: ServerDatabaseSource, _store: ServerStoreId): ServerRepository {
  if (typeof source === "string") throw new Error("File-backed Server repositories require the Node storage owner");
  return borrowServerRepository(source);
}
