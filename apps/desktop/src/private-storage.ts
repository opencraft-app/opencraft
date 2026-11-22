import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** Main-process persistence port. No Electron, OS keychain, or renderer access. */
export interface PrivateStorage {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

/** A private storage directory owned by this Main process. */
export interface FilePrivateStorage extends PrivateStorage {
  /** Resolves when every earlier write and remove is on disk; rejects if one failed. */
  flush(): Promise<void>;
}

const KEY = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_BYTES = 64 * 1024;
const owned = (uid: number) => !process.getuid || uid === process.getuid();

function keyPath(directory: string, key: string): string {
  if (!KEY.test(key)) throw new Error("Invalid private storage key");
  return join(directory, `${key}.json`);
}

async function checkDirectory(directory: string, create: boolean): Promise<boolean> {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat.uid)) throw new Error("Invalid private storage directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return false;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await chmod(directory, 0o700);
  return true;
}

async function readEntry(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES || (process.getuid && (!owned(stat.uid) || (stat.mode & 0o077) !== 0)))
      throw new Error("Invalid private storage file");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

const opened = new Map<string, Promise<FilePrivateStorage>>();

/**
 * Plaintext protected by filesystem permissions, NOT an encrypted vault.
 *
 * Main reads and writes through memory; disk IO never blocks its event loop.
 * The directory is loaded once, and each write or remove is persisted in order
 * (temporary file, fsync, rename). Main owns the directory alone, so memory is
 * the current state; `flush()` before quitting makes every change durable.
 */
export function openFilePrivateStorage(directory: string): Promise<FilePrivateStorage> {
  let storage = opened.get(directory);
  if (!storage) {
    storage = load(directory);
    opened.set(directory, storage);
    storage.catch(() => opened.delete(directory));
  }
  return storage;
}

async function load(directory: string): Promise<FilePrivateStorage> {
  const values = new Map<string, string>();
  // An unreadable entry fails reads of that key, as before; it does not stop Main from starting.
  const unreadable = new Map<string, unknown>();
  if (await checkDirectory(directory, false)) {
    for (const name of await readdir(directory)) {
      const key = name.endsWith(".json") ? name.slice(0, -5) : null;
      if (!key || !KEY.test(key)) continue;
      try { values.set(key, await readEntry(join(directory, name))); }
      catch (error) { unreadable.set(key, error); }
    }
  }
  let queue: Promise<void> = Promise.resolve();
  let failure: unknown;
  const persist = (operation: () => Promise<void>) => {
    queue = queue.then(operation).catch(error => {
      failure ??= error;
      console.error("[opencraft private storage] A write could not be saved; further changes are refused.");
    });
  };
  const assertWritable = () => {
    if (failure !== undefined) throw new Error("Private storage is unavailable", { cause: failure });
  };
  return {
    read(key) {
      keyPath(directory, key);
      if (unreadable.has(key)) throw unreadable.get(key);
      return values.get(key) ?? null;
    },
    write(key, value) {
      const path = keyPath(directory, key);
      if (typeof value !== "string" || Buffer.byteLength(value) > MAX_BYTES) throw new Error("Invalid private storage value");
      assertWritable();
      values.set(key, value); unreadable.delete(key);
      persist(async () => {
        await checkDirectory(directory, true);
        const temporary = join(directory, `.${key}.${randomUUID()}.tmp`);
        try {
          const handle = await open(temporary, "wx", 0o600);
          try { await handle.writeFile(value, "utf8"); await handle.sync(); } finally { await handle.close(); }
          await rename(temporary, path);
        } finally { await rm(temporary, { force: true }); }
      });
    },
    remove(key) {
      const path = keyPath(directory, key);
      assertWritable();
      values.delete(key); unreadable.delete(key);
      persist(async () => { if (await checkDirectory(directory, false)) await rm(path, { force: true }); });
    },
    async flush() {
      await queue;
      if (failure !== undefined) throw failure;
    },
  };
}
