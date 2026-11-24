import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lockFileExclusive } from "@opencraft/sqlite-node/locks";
import { stateChangeOutcome, StateDocumentCorruptError, validateStateKey, type StateDocumentStore } from "./state.js";

/** Directory handles cannot be fsynced on Windows; rename/link durability there is the file system's. */
async function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** In-process FIFO per absolute file, shared by every store instance over the same directory. */
const fileTails = new Map<string, Promise<unknown>>();
function serialize<T>(file: string, run: () => Promise<T>): Promise<T> {
  const next = (fileTails.get(file) ?? Promise.resolve()).then(run);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  fileTails.set(file, tail);
  void tail.then(() => {
    if (fileTails.get(file) === tail) fileTails.delete(file);
  });
  return next;
}

/**
 * Node adapter: one pretty-printed JSON file per key in `directory`.
 * Updates from different processes serialize on a kernel lock at
 * `<file>.lock`: a SQLite exclusive transaction on a permanent private file,
 * held by the `@opencraft/sqlite-node/locks` Worker so the caller's event loop
 * does no synchronous IO; the former lease's retries and `ELOCKED` stay. It never
 * expires while its holder lives, however long that holder's event loop
 * stalls; it has no refresh timer; the holder's death releases it at once.
 * Earlier releases leased the same path as a proper-lockfile directory: the
 * lock file refuses those older updaters (they cannot create or remove it),
 * and a leftover lease directory is converted only once it is far older than
 * any refresh. Updates in one process queue first, so they never compete for
 * the lock. Writes go through a temporary file, fsync, rename and a directory
 * fsync.
 *
 * `lockfilePath` relocates the lock (default `<file>.lock`) for owners whose
 * `<file>.lock` already holds another fence.
 */
export interface FileStateDocumentOptions {
  lockfilePath?(file: string): string;
  /**
   * Documents hold secrets: reads open the file without following a symlink
   * and verify the same handle is a regular file of at most `maxBytes`, owned
   * by this user with no group or other permission bits (owner and mode are
   * not checked on Windows). Writes are always 0600.
   */
  private?: { readonly maxBytes: number };
}

export class StateDocumentNotPrivateError extends Error {
  constructor() {
    super("State document is not a private file");
    this.name = "StateDocumentNotPrivateError";
  }
}

async function readPrivate(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    const foreign =
      process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || (process.getuid !== undefined && info.uid !== process.getuid()));
    if (!info.isFile() || info.size > maxBytes || foreign) throw new StateDocumentNotPrivateError();
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export function fileStateDocumentStore(directory: string, options: FileStateDocumentOptions = {}): StateDocumentStore {
  const path = (key: string) => (validateStateKey(key), join(directory, key));
  const load = async (key: string): Promise<unknown | null> => {
    let text: string;
    try {
      text = options.private
        ? await readPrivate(path(key), options.private.maxBytes)
        : await readFile(path(key), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const value: unknown = JSON.parse(text);
      if (value === null) throw new Error();
      return value;
    } catch {
      throw new StateDocumentCorruptError(key);
    }
  };
  const commit = async (key: string, json: string) => {
    const target = path(key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(JSON.parse(json), null, 2)}\n`, { flag: "wx", mode: 0o600 });
      const file = await open(temporary, "r");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await syncDirectory(directory);
  };
  return {
    read: (key) => load(key),
    update(key, change) {
      const target = path(key);
      return serialize(resolve(target), async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const release = await lockFileExclusive(resolve(options.lockfilePath?.(target) ?? `${target}.lock`));
        try {
          const outcome = stateChangeOutcome(change(await load(key)));
          if (outcome.json !== undefined) await commit(key, outcome.json);
          return outcome.result;
        } finally {
          await release();
        }
      });
    },
  };
}
