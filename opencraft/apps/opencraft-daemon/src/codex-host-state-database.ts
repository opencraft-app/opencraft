import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Queue and message provenance share the existing per-Host file and transaction owner. */
export class CodexHostStateDatabase {
  readonly database: DatabaseSync;
  constructor(directory: string) {
    const path = join(directory, "codex-host-queue.sqlite");
    this.database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.database.exec("PRAGMA journal_mode=WAL");
  }
  transaction<T>(write: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = write(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.database.close(); }
}
