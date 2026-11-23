import type { ThreadParticipationContribution } from "@opencraft/extension-react";
import type { ThreadParticipantsClient } from "./controller";
import {
  THREAD_PARTICIPANTS_BATCH_LIMIT,
  parseThreadParticipantsResponse,
  supportedParticipantsMethod,
} from "./contract";

/** Batch adapter for global analysis; uses the same accepted-message evidence as the badges. */
export function createThreadParticipation(
  id: string,
  getClient: (hostId: string) => ThreadParticipantsClient | undefined,
  accountKey: () => string | null,
): ThreadParticipationContribution {
  return {
    id,
    async read(hostId, threadIds, signal) {
      signal.throwIfAborted();
      const client = getClient(hostId),
        account = accountKey(),
        generation = client?.connectionGeneration;
      const method = supportedParticipantsMethod(
        client?.initializeResult?.capabilities?.extensions as Record<string, unknown> | undefined,
      );
      if (!client || !account || !method) return [];
      const rows = [];
      for (let offset = 0; offset < threadIds.length; offset += THREAD_PARTICIPANTS_BATCH_LIMIT) {
        const batch = threadIds.slice(offset, offset + THREAD_PARTICIPANTS_BATCH_LIMIT);
        const response = await client.requestRaw(
          method,
          { threadIds: batch },
          { signal, timeoutMs: 15000, priority: "background" },
        );
        signal.throwIfAborted();
        if (client !== getClient(hostId) || generation !== client.connectionGeneration || account !== accountKey()) {
          throw new Error("Participation scope changed");
        }
        rows.push(...parseThreadParticipantsResponse(response, batch).rows.values());
      }
      return rows.map((row) => ({
        threadId: row.threadId,
        participants: row.participants,
        creator: row.creator ?? null,
        pending: row.pending === true,
      }));
    },
  };
}
