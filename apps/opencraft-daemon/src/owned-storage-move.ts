import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireOwnedStorageLease } from "./owned-storage-lease.js";
import { OWNED_STORAGE_MOVE_JOURNAL } from "./owned-database-path.js";

const stores = [
  { current: "opencraft-host-state.sqlite", legacy: "codex-host-queue.sqlite" },
  { current: "opencraft-message-attachments.sqlite", legacy: "codex-message-attachments.sqlite" },
] as const;
const sidecars = ["-wal", "-shm", "-journal"] as const;
export type StorageMoveDirection = "current" | "legacy";
type Entry = { index: number; state: "pending" | "prepared" | "moved"; sha256?: string };
type Journal = { version: 1; id: string; direction: StorageMoveDirection; entries: Entry[] };

function stat(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function regular(path: string) {
  const info = stat(path);
  if (info && !info.isFile()) throw new Error(`Storage path must be a regular file: ${path}`);
  return info;
}
function paths(directory: string, direction: StorageMoveDirection, index: number) {
  const store = stores[index]!;
  return { from: join(directory, direction === "current" ? store.legacy : store.current),
    to: join(directory, direction === "current" ? store.current : store.legacy) };
}
function backupPath(directory: string, journal: Journal, entry: Entry) {
  return join(directory, `.opencraft-storage-${journal.id}-${entry.index}.sqlite`);
}
function hash(path: string): string {
  regular(path);
  const fd = openSync(path, "r"), digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  try { let size: number; while ((size = readSync(fd, buffer, 0, buffer.length, null)) !== 0) digest.update(buffer.subarray(0, size)); }
  finally { closeSync(fd); }
  return digest.digest("hex");
}
function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function copyPrivately(from: string, to: string): void {
  const source = openSync(from, "r");
  try {
    const target = openSync(to, "wx", 0o600), buffer = Buffer.alloc(64 * 1024);
    try {
      let size: number;
      while ((size = readSync(source, buffer, 0, buffer.length, null)) !== 0) {
        let offset = 0;
        while (offset < size) offset += writeSync(target, buffer, offset, size - offset);
      }
      fsyncSync(target);
    } finally { closeSync(target); }
  } finally { closeSync(source); }
}
function syncDirectory(directory: string): void {
  // Windows does not expose directory fsync through Node. File fsync still applies.
  if (process.platform === "win32") return;
  syncFile(directory);
}
function readJournal(directory: string): Journal | undefined {
  const path = join(directory, OWNED_STORAGE_MOVE_JOURNAL), info = regular(path);
  if (!info) return undefined;
  if (info.size > 16_384) throw new Error("Invalid storage move journal");
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Journal>;
  if (!value || typeof value !== "object" || value.version !== 1 || typeof value.id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.id)
    || !["current", "legacy"].includes(String(value.direction)) || !Array.isArray(value.entries)
    || value.entries.length > stores.length || value.entries.some(entry => !entry || !Number.isInteger(entry.index)
      || entry.index < 0 || entry.index >= stores.length || !["pending", "prepared", "moved"].includes(entry.state)
      || (entry.state !== "pending" && !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "")))
    || new Set(value.entries.map(entry => entry.index)).size !== value.entries.length) throw new Error("Invalid storage move journal");
  return value as Journal;
}
function saveJournal(directory: string, journal: Journal, initial = false): void {
  const path = join(directory, OWNED_STORAGE_MOVE_JOURNAL), temporary = `${path}.${journal.id}.tmp`;
  // A crash may leave only this private staging file. The active journal is never truncated.
  if (stat(temporary)) { regular(temporary); unlinkSync(temporary); }
  writeFileSync(temporary, JSON.stringify(journal, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  syncFile(temporary);
  if (initial) { linkSync(temporary, path); unlinkSync(temporary); }
  else renameSync(temporary, path);
  syncDirectory(directory);
}
function inventory(directory: string, direction: StorageMoveDirection): Entry[] {
  if (!stat(directory)?.isDirectory()) throw new Error("Select an existing Host data directory");
  return stores.flatMap((_, index) => {
    const { from, to } = paths(directory, direction, index), source = regular(from), target = regular(to);
    if (source && target) throw new Error(`Both storage names exist; refusing to choose or merge: ${from}`);
    for (const [path, info] of [[from, source], [to, target]] as const) {
      if (info && info.nlink !== 1) throw new Error(`Storage file has unexpected hard links: ${path}`);
      for (const suffix of sidecars) if (regular(path + suffix) && !info) throw new Error(`Orphan SQLite sidecar: ${path + suffix}`);
    }
    return source ? [{ index, state: "pending" as const }] : [];
  });
}
function noSidecars(path: string): void {
  if (sidecars.some(suffix => stat(path + suffix))) throw new Error(`SQLite sidecars remain; keep owners stopped and retry: ${path}`);
}
function prepare(directory: string, journal: Journal, entry: Entry): void {
  const { from, to } = paths(directory, journal.direction, entry.index);
  if (!regular(from) || stat(to)) throw new Error("Storage paths changed before preparation");
  const db = new DatabaseSync(from);
  try {
    db.exec("PRAGMA busy_timeout=0");
    const check = db.prepare("PRAGMA quick_check").all();
    if (check.length !== 1 || check[0]?.quick_check !== "ok") throw new Error(`SQLite integrity check failed: ${from}`);
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint?.busy !== 0) throw new Error(`SQLite checkpoint is busy: ${from}`);
    // Converting after a successful checkpoint removes WAL/SHM before any name moves.
    // Exclusive rollback locking also catches live transactions not using the new lease.
    db.exec("PRAGMA locking_mode=EXCLUSIVE");
    if (db.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !== "delete") throw new Error("Cannot drain SQLite journal");
    db.exec("BEGIN EXCLUSIVE; COMMIT");
  } finally { db.close(); }
  noSidecars(from); noSidecars(to);
  syncFile(from);
  const sha256 = hash(from), backup = backupPath(directory, journal, entry), temporary = `${backup}.partial`;
  if (regular(backup)) {
    if (hash(backup) !== sha256) throw new Error("Existing recovery copy differs; refusing to overwrite it");
  } else {
    if (stat(temporary)) { regular(temporary); unlinkSync(temporary); }
    copyPrivately(from, temporary);
    if (hash(temporary) !== sha256) throw new Error("Recovery copy verification failed");
    linkSync(temporary, backup); unlinkSync(temporary); syncDirectory(directory);
  }
  entry.sha256 = sha256; entry.state = "prepared"; saveJournal(directory, journal);
}
function movePrepared(directory: string, journal: Journal, entry: Entry): void {
  const { from, to } = paths(directory, journal.direction, entry.index);
  const source = regular(from), target = regular(to), backup = backupPath(directory, journal, entry);
  noSidecars(from); noSidecars(to);
  if (!regular(backup) || hash(backup) !== entry.sha256) throw new Error("Recovery copy is missing or changed");
  if (!source && !target) throw new Error("Both storage paths are missing");
  if (source && hash(from) !== entry.sha256) throw new Error("Source changed during offline maintenance");
  if (target && hash(to) !== entry.sha256) throw new Error("Destination changed during offline maintenance");
  if (source && target && (source.dev !== target.dev || source.ino !== target.ino)) throw new Error("Independent destination exists; refusing to overwrite it");
  if ((source && source.nlink !== (target ? 2 : 1)) || (target && target.nlink !== (source ? 2 : 1))) throw new Error("Storage has unknown hard links");
  // link is no-clobber. If interrupted between link/unlink, the journal proves that
  // the two names refer to the same prepared inode, and a retry finishes the unlink.
  if (!target) { linkSync(from, to); syncDirectory(directory); }
  if (source) { unlinkSync(from); syncDirectory(directory); }
  entry.state = "moved"; saveJournal(directory, journal);
}

/** Read-only path inspection; no SQLite connection, lock file or directory is created. */
export function planOwnedStorageMove(directory: string, direction: StorageMoveDirection = "current") {
  const journal = readJournal(directory);
  if (journal && journal.direction !== direction) throw new Error("Resume the unfinished move in its original direction first");
  const entries = journal?.entries ?? inventory(directory, direction);
  return { direction, resume: !!journal, entries: entries.map(entry => ({ ...paths(directory, direction, entry.index), state: entry.state })) };
}

/** Offline only: stop every owner, including old binaries that cannot honor the lease.
 * Moves physical names only; never upgrades/downgrades schema or restores old data.
 */
export function moveOwnedStorage(directory: string, direction: StorageMoveDirection = "current") {
  planOwnedStorageMove(directory, direction);
  const release = acquireOwnedStorageLease(directory, true);
  try {
    let journal = readJournal(directory);
    if (!journal) {
      journal = { version: 1, id: randomUUID(), direction, entries: inventory(directory, direction) };
      if (!journal.entries.length) return { direction, moved: [], receipt: undefined };
      saveJournal(directory, journal, true);
    }
    if (journal.direction !== direction) throw new Error("Resume the unfinished move in its original direction first");
    for (const entry of journal.entries) {
      if (entry.state === "pending") prepare(directory, journal, entry);
      movePrepared(directory, journal, entry);
    }
    const active = join(directory, OWNED_STORAGE_MOVE_JOURNAL), receipt = join(directory, `.opencraft-owned-storage-move-${journal.id}.completed.json`);
    if (!stat(receipt)) linkSync(active, receipt);
    else if (readFileSync(receipt, "utf8") !== readFileSync(active, "utf8")) throw new Error("Conflicting maintenance receipt");
    syncDirectory(directory); unlinkSync(active); syncDirectory(directory);
    return { direction, moved: journal.entries.map(entry => ({ ...paths(directory, direction, entry.index), sha256: entry.sha256, backup: backupPath(directory, journal, entry) })), receipt };
  } finally { release(); }
}
