import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import { errorMessage } from "../types/domain.ts";
import type {
  StartupRuntimeRecord,
  TransparentRuntimeRecoveryHost,
  TransparentRuntimeRecoveryPort,
  TransparentRuntimeRecoveryState,
} from "../types/transparent-runtime.ts";

const RUNTIME_FENCE_TIMEOUT_MS = 5_000;

type OrphanRecoveryContext = Pick<
  HypernodeContext<"appServerProjection" | "canonicalTimeline" | "threadExecution">,
  "appServerProjection" | "canonicalTimeline" | "threadExecution"
>;

/**
 * A process restart may fence an execution after its native Runtime already
 * produced partial output. The execution journal becoming terminal is not
 * enough: Desktop rebuilds submission state from the canonical timeline, so
 * every durable turn.started must also receive one durable turn.completed.
 */
export function reconcileOrphanedCanonicalTurns(
  ctx: OrphanRecoveryContext,
  now: () => number = Date.now,
): number {
  let repaired = 0;
  for (const attempt of ctx.threadExecution.orphanedAttempts) {
    const turn = ctx.canonicalTimeline.turns(attempt.threadId).find(
      (candidate) => candidate.id === attempt.turnId,
    );
    if (!turn || turn.status !== "inProgress") continue;
    const completedAt = Math.floor(now() / 1_000);
    const startedAt = Number.isFinite(turn.startedAt) ? Number(turn.startedAt) : null;
    ctx.appServerProjection.broadcast("turn/completed", {
      threadId: attempt.threadId,
      turn: {
        ...turn,
        status: "interrupted",
        error: null,
        completedAt,
        durationMs: Number.isFinite(turn.durationMs)
          ? turn.durationMs
          : startedAt == null ? null : Math.max(0, (completedAt - startedAt) * 1_000),
        itemsView: "summary",
      },
    }, { engine: "recovery", kind: "policy-process-restart" });
    repaired += 1;
  }
  return repaired;
}

/**
 * Reconciles only runtime evidence that crossed the durable spawn boundary.
 * Historical Thread bindings are projection state and never trigger container
 * work by themselves.
 */
export function reconcileTransparentStartupRuntimes(
  state: TransparentRuntimeRecoveryState,
  host: TransparentRuntimeRecoveryHost,
): Map<string, unknown> {
  state.failures.clear();
  const reconciledThreadIds = new Set<string>();
  const blockedThreadIds = new Set<string>();

  for (const outerThreadId of host.bindingState.bindings.keys()) {
    const artifact = host.artifacts.current(outerThreadId);
    const runtimeHint = host.bindingState.runtimeHints.get(outerThreadId);
    host.executionEpochs.seedEpoch(
      outerThreadId,
      Math.max(Number(artifact?.epoch) || 0, Number(runtimeHint?.epoch) || 0),
    );
  }

  const workspaceViews = new Map<string, StartupRuntimeRecord[]>();
  for (const runtime of host.runtimeRegistry.snapshot()) {
    if (runtime.realm !== "workspace") {
      // A host-local subprocess cannot survive the host process. The durable
      // record is a crash marker, not evidence requiring container fencing.
      host.runtimeRegistry.unregister(runtime.runtimeId);
      continue;
    }
    const records = workspaceViews.get(runtime.viewId) ?? [];
    records.push(runtime);
    workspaceViews.set(runtime.viewId, records);
  }

  for (const [viewId, runtimes] of workspaceViews) {
    if (!host.workspaceRuntime.supportsPersistentRuntimeFencing) {
      // Records created by the retired persistent-workspace runtime are only
      // crash markers once that runtime is disabled. There is no live process
      // left for the current host to fence, and calling the disabled adapter
      // would incorrectly block every projected Thread during startup.
      host.runtimeRegistry.clearView(viewId);
      console.info(
        `[transparent-runtime] cleared stale non-fenceable runtime records ` +
        `view=${viewId} runtimes=${runtimes.length}`,
      );
      continue;
    }
    const representative = runtimes[0];
    if (representative === undefined) continue;
    try {
      host.workspaceRuntime.terminateThreadRuntime(
        representative.processId,
        viewId,
        representative.runtimeId,
        RUNTIME_FENCE_TIMEOUT_MS,
      );
    } catch (error) {
      for (const runtime of runtimes) {
        const outerThreadId = runtime.outerThreadId ?? runtime.runtimeId;
        blockedThreadIds.add(outerThreadId);
        state.failures.set(outerThreadId, error);
      }
      console.error(
        `[transparent-runtime] failed to fence stale runtimes view=${viewId} ` +
        `runtimes=${runtimes.length}: ${errorMessage(error)}`,
      );
      continue;
    }
    host.runtimeRegistry.clearView(viewId);
    console.info(
      `[transparent-runtime] fenced stale runtime view=${viewId} runtimes=${runtimes.length}`,
    );
  }

  // Catalog recovery is pure projection convergence. It is intentionally
  // separate from the runtime registry loop above.
  const projectedThreadIds = new Set(host.bindingState.bindings.keys());
  for (const thread of [
    ...host.threads.list({ archived: false }),
    ...host.threads.list({ archived: true }),
  ]) projectedThreadIds.add(thread.id);
  for (const threadId of projectedThreadIds) {
    if (reconciledThreadIds.has(threadId) || blockedThreadIds.has(threadId) ||
        !host.threads.isTransparentCodex(threadId)) continue;
    host.threads.reconcileInterruptedRuntime(threadId);
    reconciledThreadIds.add(threadId);
  }
  return state.failures;
}

export class TransparentRuntimeRecoveryService extends Service
  implements TransparentRuntimeRecoveryPort {
  static inject = [
    "appServerProjection",
    "canonicalTimeline",
    "runtimeRegistry",
    "runtimeWorkspace",
    "threadArtifactStore",
    "threadExecution",
    "threadManager",
    "transparentThreadBinding",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  readonly failures = new Map<string, unknown>();

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentRuntimeRecovery");
    reconcileTransparentStartupRuntimes(this, {
      bindingState: ctx.transparentThreadBinding,
      artifacts: ctx.threadArtifactStore,
      executionEpochs: ctx.threadExecution.table,
      runtimeRegistry: ctx.runtimeRegistry,
      workspaceRuntime: ctx.runtimeWorkspace,
      threads: ctx.threadManager,
    });
    const repaired = reconcileOrphanedCanonicalTurns(ctx);
    if (repaired > 0) {
      console.info(`[transparent-runtime] completed orphaned canonical turns count=${repaired}`);
    }
  }

  clearFailure(threadId: string): void {
    this.failures.delete(threadId);
  }
}

type Dependencies =
  | "appServerProjection"
  | "canonicalTimeline"
  | "runtimeRegistry"
  | "runtimeWorkspace"
  | "threadArtifactStore"
  | "threadExecution"
  | "threadManager"
  | "transparentThreadBinding";
