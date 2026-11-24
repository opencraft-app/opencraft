// Node shell of the thread directory: the `@opencraft/app-host-server/thread-directory`
// export. It adapts the owner's node:sqlite connection to the SqlDatabase port
// and adds the two Node-only parts the domain (./index.ts) leaves injectable:
// - a file-backed connection gets the read-only snapshot reader Worker, so
//   snapshot pages are built off the network thread from the same file;
// - count tickets use `captureSqliteReadGuard` (data_version and
//   total_changes), which also sees commits from other connections to the file.
import type { DatabaseSync as NodeSqliteConnection } from "node:sqlite";
import { captureSqliteReadGuard, nodeSqlDatabase } from "@opencraft/sqlite-node";
import { SqlThreadDirectory, type ThreadDirectoryPort, type ThreadDirectoryStorage } from "./index.js";
import { DirectorySnapshotReader } from "./snapshot-reader.js";

export * from "./index.js";

function nodeStorage(connection: NodeSqliteConnection, port: ThreadDirectoryPort): ThreadDirectoryStorage {
  const path = connection.location();
  return {
    database: nodeSqlDatabase(connection),
    ...(path && !port.connectionLocalExecution ? { snapshotReader: new DirectorySnapshotReader(path) } : {}),
    readGuard: (_database, isCurrent) => captureSqliteReadGuard(connection, isCurrent),
  };
}

/** Owner-bound metadata projection on a borrowed node:sqlite connection. The owner keeps its lifecycle. */
export class ThreadDirectory extends SqlThreadDirectory {
  constructor(connection: NodeSqliteConnection, port: ThreadDirectoryPort, now = Date.now, intervalMs = 60_000) {
    super(nodeStorage(connection, port), port, now, intervalMs);
  }
}
