import { InterruptedTurnRecovery, RECOVERY_PROMPT } from "@opencraft/host-recovery";
import type { DshAppServerAdapter } from "./dsh-appserver-adapter.js";
import type { DshExecutionAuthority, DshExecutionOwner } from "./dsh-execution-authority.js";
import type { ThreadLifecycle } from "./thread-lifecycle.js";

export function dshInterruptedTurns(directory: string, adapter: DshAppServerAdapter, authority: DshExecutionAuthority,
  lifecycle: ThreadLifecycle, prepare: (id: string) => Promise<void>, owner: DshExecutionOwner) {
  const recovery = new InterruptedTurnRecovery(directory, {
    serialize: (id, operation) => lifecycle.enqueue(id, operation),
    inspect: async turn => {
      if (!adapter.runtimeReady) return "unknown";
      const thread = lifecycle.catalog.get(turn.threadId);
      if (!thread || thread.ephemeral || lifecycle.catalog.isArchived(turn.threadId) || authority.queueStore.pending(turn.threadId).length) return "handled";
      const { thread: native } = await adapter.dispatch("thread/read", { threadId: turn.threadId, includeTurns: false }) as any;
      if (native.status?.type === "active" || authority.table.get(turn.threadId)) return "live";
      const { goal } = await adapter.dispatch("thread/goal/get", { threadId: turn.threadId }) as any;
      if (goal?.status === "active") return "handled"; // Existing Goal owner keeps its semantics.
      const { data } = await adapter.dispatch("thread/turns/list", { threadId: turn.threadId, limit: 1, itemsView: "notLoaded" }) as any;
      const latest = data?.[0];
      if (!latest?.id) return "unknown";
      if (latest.id !== turn.turnId) return "handled";
      if (latest.status === "completed") return "finished";
      if (latest.status === "failed" && !String(latest.error?.message).includes("no terminal record")) return "finished";
      return "lost";
    },
    continue: async (turn, current, admit) => {
      await adapter.startStreams();
      await prepare(turn.threadId);
      if (!current()) return null;
      const { turn: started } = await adapter.dispatchOwned("turn/start", {
        threadId: turn.threadId, clientUserMessageId: turn.inputId,
        input: [{ type: "text", text: RECOVERY_PROMPT }],
      }, owner, turn.inputId!, admit) as any;
      lifecycle.acceptedTurn(turn.threadId, {});
      return started.id;
    },
    changed: (threadId, notice) => adapter.publishRecovery(threadId, notice),
  });
  adapter.recovery = recovery;
  adapter.recoveryOwner = owner;
  adapter.observeRecoveryExecution = (method, params: any) => {
    if (method === "turn/started" && !lifecycle.catalog.get(params.threadId)?.ephemeral) recovery.started(params.threadId, params.turn.id);
    if (method === "turn/completed") recovery.finished(params.threadId, params.turn.id);
  };
  return { recovery, close: async () => { adapter.observeRecoveryExecution = undefined; adapter.recovery = undefined; await recovery.close(); } };
}
