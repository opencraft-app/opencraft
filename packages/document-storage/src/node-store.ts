// Node owner of the extension document database: the managed lifecycle
// (ledger, backups, recovery) around the runtime-neutral `SqlDocumentStore`.
import {
  nodeSqlDatabase,
  openManagedDatabase,
  type BorrowedDatabase,
  type DatabaseOutcome,
} from "@opencraft/sqlite-node";
import { DOCUMENT_STORAGE_MIGRATIONS, SqlDocumentStore } from "./sqlite.js";

export * from "./sqlite.js";

/** Owner supplies a fixed private path; RPC callers never supply database paths. */
export function openDocumentDatabase(path: string): BorrowedDatabase {
  return openManagedDatabase({ schemaId: "document-storage", path, migrations: DOCUMENT_STORAGE_MIGRATIONS });
}

export class SqliteDocumentStore extends SqlDocumentStore {
  readonly outcome: DatabaseOutcome;
  readonly #close: () => void;
  /** A path opens a standalone database; a borrowed connection belongs to its lender. */
  constructor(source: string | BorrowedDatabase) {
    const managed = typeof source === "string" ? openDocumentDatabase(source) : source;
    const owned = typeof source === "string";
    super(probed(managed, owned));
    this.outcome = managed.outcome;
    this.#close = owned ? () => managed.database.close() : () => {};
  }
  close() {
    this.#close();
  }
}

/** The SQL port over the connection; an owned connection is closed again if the record table is missing. */
function probed(managed: BorrowedDatabase, owned: boolean) {
  const database = nodeSqlDatabase(managed.database);
  try {
    new SqlDocumentStore(database);
  } catch (error) {
    if (owned) managed.database.close();
    throw error;
  }
  return database;
}
