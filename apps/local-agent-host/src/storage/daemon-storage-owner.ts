import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { acquireOwnerLock } from "@opencraft/sqlite-node/writer-lock";
import { observeNativeExecutionProcess } from "@opencraft/execution-environment/native-execution-origin";

/** One daemon owns Host storage for its whole lifetime through a kernel lock at
 * `.daemon-storage-owner.lock`. The lock never expires while the owner lives,
 * however long synchronous migrations or engine startup stall its event loop;
 * the owner's death releases it, whatever PID namespace it ran in.
 * Earlier releases serialized a PID record (`.daemon-storage-owner.json`) with a
 * short mtime mutex at the same lock path. The lock file refuses those daemons;
 * a record they still hold is honoured while its process lives. The record
 * carries the owner's process incarnation (birth and boot), so a PID reused by an
 * unrelated process (a restarted container's PID namespace repeats its PIDs) is
 * not mistaken for the previous owner.
 */
export async function acquireLocalAgentStorageOwner(dataDirectory: string) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(dataDirectory, ".daemon-storage-owner.json");
  const readOwner = async (): Promise<{ pid: number; claim: string; incarnation?: string } | null> => {
    try {
      const owner = JSON.parse(await readFile(path, "utf8"));
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.claim !== "string"
        || (owner.incarnation !== undefined && (typeof owner.incarnation !== "string" || !owner.incarnation))) throw new Error("Invalid daemon storage owner");
      return owner;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  const releaseLock = await acquireOwnerLock(join(dataDirectory, ".daemon-storage-owner.lock")).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "ELOCKED" ? new Error("Host storage already owned by a live daemon", { cause: error }) : error;
  });
  try {
    const previous = await readOwner();
    if (previous) {
      let alive = true;
      try { process.kill(previous.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
      // A live PID with a different observed birth is another process; an unobservable one stays live.
      if (alive && previous.incarnation !== undefined) {
        const current = await observeNativeExecutionProcess(previous.pid).then(value => value.incarnation, () => undefined);
        if (current !== undefined && current !== previous.incarnation) alive = false;
      }
      if (alive) throw new Error(`Host storage already owned by live daemon ${previous.pid}`);
      await rm(path, { force: true });
    }
  } catch (error) { releaseLock(); throw error; }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    releaseLock();
  };
}
