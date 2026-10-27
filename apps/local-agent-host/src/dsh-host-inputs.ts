import type { HostInputPort } from "@opencraft/appserver-protocol/host-inputs";
import type { DshAppServerAdapter } from "./dsh-appserver-adapter.js";
import type { DshExecutionAuthority, DshExecutionOwner } from "./dsh-execution-authority.js";
import type { ThreadLifecycle } from "./thread-lifecycle.js";

/** Uses the Host's existing serialization, execution journal and native input.
 * Null is safe waiting; once the journal has a claim it is never absent again. */
export function dshHostInputs(adapter: DshAppServerAdapter, authority: DshExecutionAuthority, lifecycle: ThreadLifecycle,
  prepare: (threadId: string) => Promise<void>, owner: DshExecutionOwner): HostInputPort {
  const port: HostInputPort = {
    async receipt(threadId, inputId) {
      const prior = authority.scheduleInput(threadId, inputId);
      return prior ? { state: prior.turnId ? "delivered" : "unknown", turnId: prior.turnId ?? null } : null;
    },
    submit: (threadId, inputId, text, canAdmit) => lifecycle.enqueue(threadId, async () => {
      const prior = await port.receipt(threadId, inputId); if (prior) return prior;
      lifecycle.assertOpen(threadId);
      const { thread } = await adapter.dispatch("thread/read", { threadId, includeTurns: false }) as any;
      if (!thread || thread.ephemeral || lifecycle.catalog.get(threadId)?.ephemeral || lifecycle.catalog.isArchived(threadId)) return { state: "discarded", turnId: null };
      if (thread.status?.type === "active" || authority.table.get(threadId) || authority.leases.get(threadId) || authority.queueStore.pending(threadId).length) return null;
      const { goal } = await adapter.dispatch("thread/goal/get", { threadId }) as any;
      if (goal?.status === "active" && goal?.execution?.activation === "armed") return null;
      if (!await canAdmit()) return null;
      await prepare(threadId);
      if (!await canAdmit() || authority.table.get(threadId) || authority.leases.get(threadId)) return null;
      try {
        const { turn } = await adapter.dispatchOwned("turn/start", { threadId, clientUserMessageId: inputId,
          input: [{ type: "text", text }] }, owner, inputId, canAdmit) as any;
        lifecycle.acceptedTurn(threadId, {});
        return { state: "delivered", turnId: turn.id };
      } catch { return await port.receipt(threadId, inputId) ?? { state: "unknown", turnId: null }; }
    }),
  };
  return port;
}
