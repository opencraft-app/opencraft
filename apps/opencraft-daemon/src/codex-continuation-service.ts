import {
  codexProviderFailure,
  InterruptedTurnRecovery,
  pooledRetryAt,
  ProviderTurnRetry,
  RecoveryNotSubmitted,
  type ProviderFailure,
} from "@opencraft/host-recovery";
import { TURN_RECOVERY_EXTENSION } from "@opencraft/appserver-protocol";
import type { CodexHostService, CodexHostServiceClients } from "./codex-host-services.js";

type Value = Record<string, unknown>;
const object = (value: unknown): Value =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Value) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Client inputs and stops that take a Thread out of the Host's hands, as the local Host treated them. */
const USER_MUTATIONS = new Set([
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "thread/archive",
  "thread/delete",
  "thread/goal/set",
  "thread/goal/clear",
  "thread/settings/update",
  "thread/queue/add",
  "thread/queue/steer",
  "thread/queue/start",
  "thread/queue/retry",
]);

export interface CodexContinuationOptions {
  /** The Codex data directory: the same durable records the local Host kept, so they carry over. */
  readonly directory: string;
  readonly clients: CodexHostServiceClients;
  /** False while maintenance pauses new Codex work. */
  readonly admissionOpen: () => boolean;
  /** Routing facts of the account pool, for when a rate-limited Thread may run again. */
  readonly accounts?: () => Promise<unknown>;
}

export interface CodexContinuationService extends CodexHostService {
  counts(): { capacityRetries: number; activeGoals: number };
}

/**
 * Host duties that continue a Thread by themselves, for every Thread on the
 * provider bridge: a turn interrupted by a restart is continued, a turn failed
 * by provider capacity is retried when capacity returns, and an active goal is
 * resumed after a clean turn. Each acts through Thread routing as the Host's
 * own client, so the bridge's admission, queue and ledger apply as to anyone.
 */
export function codexContinuationService(options: CodexContinuationOptions): CodexContinuationService {
  const { clients } = options;
  const order = new Map<string, Promise<unknown>>();
  const serialize = <T>(threadId: string, work: () => Promise<T>): Promise<T> => {
    const next = (order.get(threadId) ?? Promise.resolve()).catch(() => undefined).then(work);
    order.set(threadId, next);
    void next.finally(() => order.get(threadId) === next && order.delete(threadId)).catch(() => undefined);
    return next;
  };
  const request = (method: string, params: Value) => clients.request(method, params);
  const thread = async (threadId: string) =>
    object(object(await request("thread/read", { threadId, includeTurns: false })).thread);
  const idle = (value: Value) => ["idle", "notLoaded", undefined].includes(object(value.status).type as string);
  const handledThread = (value: Value) =>
    value.ephemeral === true || value.archived === true || value.canAcceptDirectInput === false;
  /** Input someone queued runs instead of a continuation. */
  const queued = async (threadId: string) => {
    const list = object(await request("thread/queue/list", { threadId }));
    return (
      (Array.isArray(list.data) && list.data.length > 0) || (Array.isArray(list.steering) && list.steering.length > 0)
    );
  };
  const latestTurn = async (threadId: string) => {
    const page = object(
      await request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }),
    );
    return object(Array.isArray(page.data) ? page.data[0] : null);
  };
  /** A continuation is an empty start: native Codex continues where the Thread stopped. */
  const continueThread = async (threadId: string, inputId: string, admit: () => boolean) => {
    if (!admit()) return null;
    try {
      const result = object(await request("turn/start", { threadId, input: [], clientUserMessageId: inputId }));
      return text(object(result.turn).id) || null;
    } catch (error) {
      if (object(object(error).data).submissionOutcome === "rejected") throw new RecoveryNotSubmitted();
      throw error;
    }
  };
  const retryAt = async (failure: ProviderFailure) => {
    if (failure.kind !== "rate-limit") return failure;
    try {
      return { ...failure, retryAt: pooledRetryAt(await options.accounts?.(), Date.now()) };
    } catch {
      return failure;
    }
  };

  const activeGoals = new Set<string>();
  const goalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const notifyRecovery = (threadId: string) =>
    clients.broadcast("opencraft/turn-recovery/updated", {
      threadId,
      recovery: retry.notice(threadId) ?? recovery.notice(threadId) ?? null,
    });

  const recovery = new InterruptedTurnRecovery(
    options.directory,
    {
      serialize,
      inspect: async (turn) => {
        const current = await thread(turn.threadId);
        if (handledThread(current)) return "handled";
        if (!idle(current)) return "live";
        if (await queued(turn.threadId)) return "handled";
        const goal = object(object(await request("thread/goal/get", { threadId: turn.threadId })).goal);
        if (goal.status === "active") {
          activeGoals.add(turn.threadId);
          resumeGoal(turn.threadId);
          return "handled";
        }
        const latest = await latestTurn(turn.threadId);
        if (!latest.id) return "unknown";
        if (latest.id !== turn.turnId) return "handled";
        if (latest.status === "completed" || latest.status === "failed") return "finished";
        return latest.status === "interrupted" || latest.status === "inProgress" ? "lost" : "unknown";
      },
      continue: (turn, current, admit) =>
        current() ? continueThread(turn.threadId, turn.inputId!, admit) : Promise.resolve(null),
      changed: (threadId) => notifyRecovery(threadId),
    },
    500,
    options.admissionOpen,
  );
  const retry = new ProviderTurnRetry(
    options.directory,
    {
      serialize,
      inspect: async (turn) => {
        if (await queued(turn.threadId)) return "handled";
        const current = await thread(turn.threadId);
        if (handledThread(current)) return "handled";
        if (!idle(current)) return "live";
        const latest = await latestTurn(turn.threadId);
        if (!latest.id) return "unknown";
        if (latest.id !== turn.turnId) return "handled";
        if (latest.status === "completed") return "finished";
        if (latest.status !== "failed") return "unknown";
        // The receipt's classification belongs to this exact failed turn; a running successor has none.
        const failure = await retryAt(
          Object.hasOwn(latest, "error") && latest.error
            ? codexProviderFailure(latest.error)
            : turn.state === "running"
              ? { kind: "permanent" }
              : turn.failure,
        );
        if (failure.kind === "permanent" || (failure.kind === "rate-limit" && failure.retryAt === undefined))
          return "handled";
        return { failure };
      },
      continue: (turn, current, admit) =>
        current() ? continueThread(turn.threadId, turn.inputId!, admit) : Promise.resolve(null),
      changed: (threadId) => notifyRecovery(threadId),
    },
    Date.now,
    Math.random,
    options.admissionOpen,
  );

  /** Goal continuation belongs to the Host, not to a window: after a clean turn an active goal runs on. */
  function resumeGoal(threadId: string): void {
    if (!activeGoals.has(threadId) || goalTimers.has(threadId)) return;
    const timer = setTimeout(() => {
      goalTimers.delete(threadId);
      void serialize(threadId, async () => {
        if (!options.admissionOpen() || recovery.snapshot(threadId)?.handledReason === "execution_fault") return;
        if (!activeGoals.has(threadId) || (await queued(threadId)) || !idle(await thread(threadId))) return;
        const goal = object(object(await request("thread/goal/get", { threadId })).goal);
        if (goal.status !== "active") {
          activeGoals.delete(threadId);
          return;
        }
        await request("thread/goal/set", { threadId, status: "active" });
      }).catch((error) =>
        console.warn(
          "[codex-host-services]",
          JSON.stringify({
            event: "goal-continuation-failed",
            reason: error instanceof Error ? error.message : "unknown",
          }),
        ),
      );
    }, 150);
    timer.unref?.();
    goalTimers.set(threadId, timer);
  }
  const noteGoal = (threadId: string, goal: unknown) => {
    if (!threadId) return;
    if (object(goal).status === "active") activeGoals.add(threadId);
    else activeGoals.delete(threadId);
  };

  // Durable rows from before a restart (or left by the local Host) continue once routing answers.
  recovery.wake();
  retry.wake(1000);

  return {
    handles: (method) => method === "opencraft/turn-recovery/read",
    request: (_method, raw) => {
      const threadId = text(object(raw).threadId);
      return { recovery: retry.notice(threadId) ?? recovery.notice(threadId) ?? null };
    },
    capabilities: () => ({ [TURN_RECOVERY_EXTENSION]: { version: 1 }, "opencraft/capacity-retry": { version: 1 } }),
    storage: () => [
      { name: "interrupted-turn-recovery", outcome: recovery.outcome },
      { name: "provider-turn-retry", outcome: retry.outcome },
    ],
    beforeRoute: (method, params) => {
      const threadId = text(params.threadId);
      if (!threadId || !USER_MUTATIONS.has(method)) return;
      recovery.handled(threadId, method === "turn/interrupt" ? "user_stop" : "user_input");
      retry.handled(threadId);
    },
    observe: (method, params, result) => {
      if (method === "thread/goal/set" || method === "thread/goal/get")
        noteGoal(text(params.threadId), object(result).goal);
    },
    notification: (method, params) => {
      const threadId = text(params.threadId),
        turn = object(params.turn),
        turnId = text(turn.id);
      if (!threadId) return;
      if (method === "turn/started" && turnId) {
        recovery.started(threadId, turnId);
        retry.started(threadId, turnId);
      } else if (method === "turn/completed" && turnId) {
        if (turn.status === "interrupted") {
          // A stop someone asked for was marked handled first; otherwise the execution was lost.
          recovery.lost(threadId);
          recovery.wake();
          return;
        }
        recovery.finished(threadId, turnId);
        retry.finished(threadId, turnId);
        if (turn.status === "failed")
          void retryAt(codexProviderFailure(object(turn.error))).then((failure) =>
            retry.failed(threadId, turnId, failure),
          );
        else resumeGoal(threadId);
      } else if (method === "thread/goal/updated") noteGoal(threadId, params.goal);
      else if (method === "thread/goal/cleared") activeGoals.delete(threadId);
      else if (method === "thread/archived" || method === "thread/deleted") {
        activeGoals.delete(threadId);
        recovery.handled(threadId);
        retry.handled(threadId);
      }
    },
    counts: () => ({ capacityRetries: retry.pendingThreadIds().length, activeGoals: activeGoals.size }),
    close: async () => {
      for (const timer of goalTimers.values()) clearTimeout(timer);
      goalTimers.clear();
      await Promise.all([recovery.close(), retry.close()]);
    },
  };
}
