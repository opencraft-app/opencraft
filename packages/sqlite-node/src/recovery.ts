import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createBackup } from "./backup.js";
import { SqliteLifecycleError } from "./errors.js";
import { validateHistory, type HashedMigration } from "./migrations.js";

interface Recovery { readonly backupPath: string; readonly targetVersion: number }
const journalPath = (path: string) => `${path}.pending-migration.json`;

/** Persist intent before mutating a database. The owner must hold its writer fence. */
export function durableJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    const file = openSync(temporary, "r");
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function assertRecoveryState(path: string, empty = false): void {
  if (path === ":memory:" || existsSync(path) && !empty) return;
  if (!existsSync(dirname(path))) return;
  const name = basename(path);
  if (readdirSync(dirname(path)).some(entry => !empty && (entry === `${name}-wal` || entry === `${name}-shm`)
    || entry === basename(journalPath(path)) || entry.startsWith(`${name}.legacy-`) || entry.startsWith(`${name}.pre-v`))) {
    throw new SqliteLifecycleError("unsupported-legacy", "Database is missing or empty but recovery files exist; restore the owner before opening");
  }
}

export function readRecovery(path: string, migrations: readonly HashedMigration[], applied: number): Recovery | undefined {
  if (path === ":memory:" || !existsSync(journalPath(path))) return;
  const value: unknown = JSON.parse(readFileSync(journalPath(path), "utf8"));
  if (!value || typeof value !== "object" || !("backup" in value) || !("targetVersion" in value)
    || typeof value.backup !== "string" || basename(value.backup) !== value.backup
    || !value.backup.startsWith(`${basename(path)}.pre-v`) || !value.backup.endsWith(".sqlite")
    || !Number.isSafeInteger(value.targetVersion) || Number(value.targetVersion) < 1) {
    throw new SqliteLifecycleError("history-mismatch", "Invalid pending migration recovery record");
  }
  const backupPath = join(dirname(path), value.backup);
  if (!existsSync(backupPath)) throw new SqliteLifecycleError("io", "Pending migration recovery point is missing");
  const snapshot = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const originalVersion = validateHistory(snapshot, migrations);
    if (Number(value.targetVersion) > migrations.length && applied > originalVersion) {
      throw new SqliteLifecycleError("newer-schema", "A newer data upgrade is incomplete");
    }
    if (snapshot.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new SqliteLifecycleError("io", "Invalid recovery point");
  } finally { snapshot.close(); }
  return { backupPath, targetVersion: Number(value.targetVersion) };
}

export function beginRecovery(database: DatabaseSync, path: string, migrations: readonly HashedMigration[], existing?: Recovery): Recovery | undefined {
  if (path === ":memory:") return;
  if (existing) {
    const snapshot = new DatabaseSync(existing.backupPath, { readOnly: true });
    try {
      validateHistory(snapshot, migrations);
      if (snapshot.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new SqliteLifecycleError("io", "Invalid recovery point");
    } finally { snapshot.close(); }
  }
  const backupPath = existing?.backupPath ?? createBackup(database, path, migrations.length)!;
  durableJson(journalPath(path), { backup: basename(backupPath), targetVersion: migrations.length });
  return { backupPath, targetVersion: migrations.length };
}

export function finishRecovery(path: string): void { unlinkSync(journalPath(path)); }
