import { mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import lockfile from "proper-lockfile";

/** Serialize owner claims, then use a live process identity for the whole storage lifetime.
 * The short mutex lease never spans synchronous SQLite migrations or engine startup.
 */
export async function acquireLocalAgentStorageOwner(dataDirectory: string) {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(dataDirectory, ".daemon-storage-owner.json");
  const mutex = () => lockfile.lock(dataDirectory, {
    realpath: false, lockfilePath: join(dataDirectory, ".daemon-storage-owner.lock"),
    retries: { retries: 100, minTimeout: 100, maxTimeout: 100 },
  });
  const readOwner = (): { pid: number; claim: string } | null => {
    try {
      const owner = JSON.parse(readFileSync(path, "utf8"));
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.claim !== "string") throw new Error("Invalid daemon storage owner");
      return owner;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const claim = randomUUID();
  const releaseMutex = await mutex();
  try {
    const previous = readOwner();
    if (previous) {
      let alive = true;
      try { process.kill(previous.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
      if (alive) throw new Error(`Host storage already owned by live daemon ${previous.pid}`);
    }
    const temporary = `${path}.${claim}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ pid: process.pid, claim }), { mode: 0o600 });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
  } finally { await releaseMutex(); }
  let released = false;
  return async () => {
    if (released) return;
    const unlock = await mutex();
    try {
      if (readOwner()?.claim === claim) unlinkSync(path);
      released = true;
    } finally { await unlock(); }
  };
}
