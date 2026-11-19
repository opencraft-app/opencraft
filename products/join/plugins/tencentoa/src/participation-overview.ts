import type { ThreadParticipationContribution } from "@opencraft/extension-react";
import type { ParticipantsClient } from "./participants-controller";
import { TENCENTOA_PARTICIPANTS_METHOD } from "./contract";
import { parseParticipantsResponse } from "./participants-response";

/** Batch adapter for global analysis; uses the same accepted-message evidence as row badges. */
export function createParticipationOverview(
  getClient: (hostId: string) => ParticipantsClient | undefined,
  accountKey: () => string | null,
): ThreadParticipationContribution {
  return { id: "tencentoa.participation-overview", async read(hostId, threadIds, signal) {
    signal.throwIfAborted();
    const client = getClient(hostId), account = accountKey(), generation = client?.connectionGeneration;
    if (!client || !account || (client.initializeResult?.capabilities?.extensions?.[TENCENTOA_PARTICIPANTS_METHOD] as { version?: number } | undefined)?.version !== 1) return [];
    const response = await client.requestRaw(TENCENTOA_PARTICIPANTS_METHOD, { threadIds }, { signal, timeoutMs: 15000, priority: "background" });
    signal.throwIfAborted();
    if (client !== getClient(hostId) || generation !== client.connectionGeneration || account !== accountKey()) throw new Error("Participation scope changed");
    const { rows } = parseParticipantsResponse(response, threadIds);
    return [...rows.values()].map(row => ({ threadId: row.threadId, participants: row.participants, creator: row.creator ?? null, pending: row.pending === true }));
  } };
}
