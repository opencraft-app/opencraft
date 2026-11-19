import { parentPort, workerData } from "node:worker_threads";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { InterruptedTurnRecovery, ProviderTurnRetry } from "@opencraft/host-recovery";
import { OpenCraftHostStateDatabase } from "./opencraft-host-state-database.js";
import { ExecutionLeaseStore } from "./execution-lease-store.js";
import { OpenCraftHostQueue } from "./opencraft-host-queue.js";
import type { ExecutionFaultWrite } from "./execution-fault-writer.js";

const directory: string = workerData.directory;
const state = new OpenCraftHostStateDatabase(directory);
const queue = new OpenCraftHostQueue(directory, state.database, {recoverPending: false});
const leases = new ExecutionLeaseStore(state.database);
const dormant = {serialize: async <T>(_id: string, work: () => Promise<T>) => work(),
  inspect: async () => "unknown" as const, continue: async () => null, changed: () => {}};
const recovery = new InterruptedTurnRecovery(directory, dormant, 500, () => false);
const retry = new ProviderTurnRetry(directory, dormant, Date.now, Math.random, () => false);
const file = join(directory, "execution-fault-receipts.json");
let receipts = new Map<string, boolean>();
try {
  const rows: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || typeof row[1] !== "boolean")) throw new Error("Invalid execution fault receipts");
  receipts = new Map(rows);
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

async function commit(work: ExecutionFaultWrite): Promise<readonly string[]> {
  const updated = new Map(receipts);
  const changedThreadIds: string[] = [];
  for (const threadId of work.threadIds) {
    const key = JSON.stringify([work.recoveryId, threadId]);
    const prior = receipts.get(key);
    if (prior === true || prior === work.recovered) continue;
    // If Host missed the initial notification, seal the old execution before
    // publishing recovered. Re-observing a completed receipt never touches new work.
    if (prior === undefined) {
      state.transaction(() => { leases.suspend(threadId); queue.interruptExecution(threadId, false); });
      recovery.handled(threadId, "execution_fault"); retry.handled(threadId);
    }
    if (work.recovered) state.transaction(() => queue.interruptExecution(threadId, true));
    updated.set(key, work.recovered); changedThreadIds.push(threadId);
  }
  if (!changedThreadIds.length) return changedThreadIds;
  const temporary = `${file}.${randomUUID()}`;
  try { await writeFile(temporary, JSON.stringify([...updated]), {mode: 0o600, flag: "wx"}); await rename(temporary, file); }
  finally { await unlink(temporary).catch(() => {}); }
  receipts = updated;
  return changedThreadIds;
}
let tail = Promise.resolve();
parentPort!.on("message", message => {
  tail = tail.then(async () => {
    if (message.close) {
      await recovery.close(); await retry.close(); state.close(); parentPort!.close(); return;
    }
    const deadline = Date.now() + 2_000;
    for (;;) {
      try { const changedThreadIds = await commit(message.operation); parentPort!.postMessage({id: message.id, changedThreadIds}); break; }
      catch (error) {
        const code = (error as {errcode?: number}).errcode;
        if ((code === 5 || code === 6) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); continue; }
        parentPort!.postMessage({id: message.id, error: true}); break;
      }
    }
  });
});
