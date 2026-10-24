import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openConnection(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
  }
  const database = new DatabaseSync(path);
  try {
    if (path !== ":memory:") chmodSync(path, 0o600);
    database.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
