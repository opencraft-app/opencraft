import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { TransparentBackendState } from "../types/transparent-backend.ts";
import type {
  TransparentRuntimeRetirementPort,
  TransparentRuntimeRetirementResult,
} from "../types/transparent-runtime-retirement.ts";

type Dependencies =
  | "executionEngine"
  | "runtimeWorkspace"
  | "threadExecution"
  | "transparentBackendLifecycle"
  | "transparentBackendRegistry"
  | "transparentRuntimeAccess"
  | "transparentRuntimeLocator"
  | "transparentSubscription";

/**
 * Applies Runtime retirement policy after subscriptions and active executions
 * have drained. This service never mutates durable Thread history.
 */
export class TransparentRuntimeRetirementService extends Service
  implements TransparentRuntimeRetirementPort {
  static inject = [
    "executionEngine",
    "runtimeWorkspace",
    "threadExecution",
    "transparentBackendLifecycle",
    "transparentBackendRegistry",
    "transparentRuntimeAccess",
    "transparentRuntimeLocator",
    "transparentSubscription",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentRuntimeRetirement");
  }

  closeArchivedWorkspaceBackend(
    outerThreadId: string,
    candidate: TransparentBackendState | null | undefined,
  ): void {
    const record = this.ctx.runtimeWorkspace.recordFor(outerThreadId);
    if (record?.kind !== "fork" || !record.deleted) return;
    const state = candidate ?? this.ctx.transparentRuntimeLocator.stateForOuter(
      outerThreadId,
      this.ctx.transparentRuntimeAccess.localFilesystem,
    );
    if (!state || state.realm !== "workspace" || state.viewId !== record.viewId) return;
    this.ctx.transparentBackendLifecycle.closeProcess(
      state,
      outerThreadId,
    );
  }

  retireIsolatedBackend(
    state: TransparentBackendState | null | undefined,
    outerThreadId: string,
    strict: boolean,
  ): boolean {
    return this.ctx.transparentBackendLifecycle.retireIsolated(
      state,
      outerThreadId,
      strict,
    );
  }

  retireThreadRuntimeIfIdle(
    outerThreadId: string,
  ): boolean {
    if (this.ctx.transparentSubscription.hasSubscribers(outerThreadId)) return false;
    if (this.ctx.threadExecution.table.get(outerThreadId)) return false;
    if (this.ctx.executionEngine.retireThread(outerThreadId)) return true;
    const state = this.ctx.transparentRuntimeLocator.stateForOuter(
      outerThreadId,
      this.ctx.transparentRuntimeAccess.localFilesystem,
    );
    return this.retireIsolatedBackend(state, outerThreadId, false);
  }

  retireIdleUserBackends(
    userId: string,
  ): TransparentRuntimeRetirementResult {
    let retired = 0;
    let deferred = 0;
    for (const state of [...this.ctx.transparentBackendRegistry.backends.values()]) {
      if (state.ownerUserId !== userId) continue;
      const active = [...this.ctx.threadExecution.table.values()]
        .some((execution) => execution.runtimeId === state.backendKey);
      if (active) {
        deferred += 1;
        continue;
      }
      if (state.isolatedOuterThreadId) {
        if (this.retireIsolatedBackend(
          state,
          state.isolatedOuterThreadId,
          false,
        )) retired += 1;
        continue;
      }
      if (this.ctx.transparentBackendLifecycle.closeProcess(
        state,
        null,
      )) retired += 1;
    }
    return { retired, deferred };
  }
}
