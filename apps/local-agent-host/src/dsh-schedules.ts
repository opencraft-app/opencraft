import type { ConversationScheduleRun } from "@opencraft/appserver-protocol";
import { ScheduleFault, type ScheduleExecutionPort } from "@opencraft/host-schedules";
import type { DshAppServerAdapter } from "./dsh-appserver-adapter.js";
import type { DshExecutionAuthority, DshExecutionOwner } from "./dsh-execution-authority.js";
import type { ThreadLifecycle } from "./thread-lifecycle.js";

/** Engine port only. One stable Host principal, never an impersonated employee. */
export function dshScheduleExecutionPort(adapter: DshAppServerAdapter, authority: DshExecutionAuthority,
  lifecycle: ThreadLifecycle, prepare: (threadId: string) => Promise<void>): ScheduleExecutionPort {
  const owner: DshExecutionOwner = { connectionId: "opencraft-scheduler", identity: { id: "opencraft-scheduler", username: "Scheduled task" } };
  const validate = async (threadId: string) => {
    lifecycle.assertOpen(threadId);
    const { thread } = await adapter.dispatch("thread/read", { threadId, includeTurns: false }) as any;
    if (!thread || thread.ephemeral || lifecycle.catalog.get(threadId)?.ephemeral || lifecycle.catalog.isArchived(threadId))
      throw new ScheduleFault(-32602, "Schedules require an existing, unarchived durable thread");
  };
  const inspect = async (run: ConversationScheduleRun) => {
    const prior = authority.scheduleInput(run.threadId, run.id);
    // No receipt, including a timeout before turn/start, is never permission to resend.
    if (!prior?.turnId) return { state: "unknown" as const };
    if (prior.state === "completed") return { state: "completed" as const };
    if (["failed", "interrupted"].includes(prior.state)) return { state: "failed" as const };
    if (prior.state === "running" && authority.table.get(run.threadId)?.turnId === prior.turnId) return { state: "running" as const };
    return { state: "unknown" as const };
  };
  return { validate, inspect,
    subscribe: listener => adapter.subscribe((method, params: any) => {
      if (method !== "turn/completed" || !params?.threadId || !params.turn?.id) return;
      const turn = params.turn;
      if (["completed", "failed", "interrupted"].includes(turn.status)) listener({ threadId: params.threadId,
        turnId: turn.id, state: turn.status === "completed" && !turn.error ? "completed" : "failed" });
    }),
    permissionProfiles: async () => (await adapter.dispatch("permissionProfile/list", { limit: 100 }) as { data: import("@opencraft/appserver-protocol").OpenCraftPermissionProfile[] }).data,
    submit: (run, prompt, canAdmit) => lifecycle.enqueue(run.threadId, async () => {
    if (authority.scheduleInput(run.threadId, run.id)) return { ...await inspect(run), turnId: authority.scheduleInput(run.threadId, run.id)?.turnId };
    try { await validate(run.threadId); } catch { return { state: "failed" }; }
    if (authority.table.get(run.threadId) || authority.leases.get(run.threadId) || authority.queueStore.pending(run.threadId).length) return { state: "waiting" };
    const { thread } = await adapter.dispatch("thread/read", { threadId: run.threadId, includeTurns: false }) as any;
    if (thread.status?.type === "active") return { state: "waiting" };
    const { goal } = await adapter.dispatch("thread/goal/get", { threadId: run.threadId }) as any;
    if (goal?.status === "active" && goal?.execution?.activation === "armed") return { state: "waiting" };
    await prepare(run.threadId);
    if (!canAdmit() || authority.table.get(run.threadId) || authority.leases.get(run.threadId)) return { state: "waiting" };
    try {
      const { turn } = await adapter.dispatchOwned("turn/start", { threadId: run.threadId,
        ...(run.permissions ? { permissions: run.permissions } : {}),
        clientUserMessageId: run.id, input: [{ type: "text", text: `[Scheduled task]\n${prompt}` }] }, owner, run.id) as any;
      lifecycle.acceptedTurn(run.threadId, {});
      return { state: "running", turnId: turn.id };
    } catch {
      return authority.scheduleInput(run.threadId, run.id) ? { state: "unknown" } : { state: "waiting" };
    }
  }) };
}
