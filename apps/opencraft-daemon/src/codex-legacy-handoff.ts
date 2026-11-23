import { access } from "node:fs/promises";
import { join } from "node:path";
import { OpenCraftHostQueue } from "./opencraft-host-queue.js";
import { OpenCraftHostStateDatabase } from "./opencraft-host-state-database.js";
import type { CodexHostService, CodexHostServiceClients } from "./codex-host-services.js";

/** What a handoff run did, for the operator log and tests. */
export interface CodexLegacyQueueHandoff {
  moved: number;
  /** Inputs whose delivery the local Host could not confirm; left where they are, never resent. */
  uncertain: number;
}

/**
 * Inputs still queued in the local Codex Host when the desktop moved to the
 * bridge go to the Host queue of their Thread, in order, once. The bridge
 * adopts the Thread on that first request. Both queues are idempotent by
 * client message ID, so an interrupted handoff simply runs again; a row is
 * removed here only after the Host accepted it. Inputs whose delivery the
 * local Host could not confirm are counted and left untouched: sending them
 * could run them twice.
 */
export async function handOffLegacyQueue(
  directory: string,
  clients: Pick<CodexHostServiceClients, "request">,
): Promise<CodexLegacyQueueHandoff> {
  const result = { moved: 0, uncertain: 0 };
  const present = await Promise.all(
    ["opencraft-host-state.sqlite", "codex-host-queue.sqlite"].map((name) =>
      access(join(directory, name)).then(
        () => true,
        () => false,
      ),
    ),
  );
  if (!present.includes(true)) return result;
  const state = new OpenCraftHostStateDatabase(directory);
  try {
    const queue = new OpenCraftHostQueue(directory, state.database, { recoverPending: false });
    for (const threadId of queue.pendingThreads()) {
      for (const row of queue.list(threadId)) {
        // Collaboration inputs are reconciled by their owner, not resent as plain input.
        if (row.state !== "queued" || row.clientUserMessageId.startsWith("actor-input:")) {
          if (row.state !== "delivered") result.uncertain++;
          continue;
        }
        await clients.request("thread/queue/add", {
          threadId,
          clientUserMessageId: row.clientUserMessageId,
          input: row.input,
        });
        queue.delete(threadId, row.id);
        result.moved++;
      }
    }
  } finally {
    state.close();
  }
  return result;
}

/** Runs the handoff once routing answers, retrying until it completes. */
export function codexLegacyHandoffService(
  directory: string,
  clients: CodexHostServiceClients,
  retryMs = 5_000,
): CodexHostService {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const attempt = () => {
    timer = undefined;
    void handOffLegacyQueue(directory, clients).then(
      (outcome) => {
        if (outcome.moved || outcome.uncertain)
          console.warn("[codex-host-services]", JSON.stringify({ event: "legacy-queue-handoff", ...outcome }));
      },
      (error) => {
        console.warn(
          "[codex-host-services]",
          JSON.stringify({
            event: "legacy-queue-handoff-retry",
            reason: error instanceof Error ? error.message : "unknown",
          }),
        );
        if (!closed) (timer = setTimeout(attempt, retryMs)).unref?.();
      },
    );
  };
  (timer = setTimeout(attempt, 1_000)).unref?.();
  return {
    handles: () => false,
    request: () => null,
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}
