import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { stateChangeOutcome, StateDocumentCorruptError, validateStateKey, type StateDocumentStore } from "./state.js";

/**
 * Node adapter: one pretty-printed JSON file per key in `directory`.
 * Updates take the same proper-lockfile lock the previous helpers used, so
 * processes on older and newer code still serialize on one file. Writes go
 * through a temporary file, fsync, rename and a directory fsync.
 */
export function fileStateDocumentStore(directory: string): StateDocumentStore {
  const path = (key: string) => (validateStateKey(key), join(directory, key));
  const load = async (key: string): Promise<unknown | null> => {
    let text: string;
    try {
      text = await readFile(path(key), "utf8");
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
      try { await file.sync(); } finally { await file.close(); }
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  };
  return {
    read: (key) => load(key),
    async update(key, change) {
      const target = path(key);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const release = await lockfile.lock(target, { realpath: false, retries: { retries: 20, minTimeout: 20, maxTimeout: 200 } });
      try {
        const outcome = stateChangeOutcome(change(await load(key)));
        if (outcome.json !== undefined) await commit(key, outcome.json);
        return outcome.result;
      } finally {
        await release();
      }
    },
  };
}
