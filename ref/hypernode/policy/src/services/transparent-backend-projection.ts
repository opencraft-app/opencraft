import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AppServerBackendProjectionHost,
} from "../types/canonical-appserver-projection.ts";
import type { CanonicalTurnSeed } from "../types/canonical-timeline.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { JsonRpcResponse } from "../types/appserver.ts";
import type { TransparentBackendState } from "../types/transparent-backend.ts";
import type {
  TransparentBackendProjectionPort,
} from "../types/transparent-backend-projection.ts";

type Dependencies =
  | "appServerProjection"
  | "runtimeWorkspace"
  | "threadExecution"
  | "threadManager"
  | "transparentRuntimeAccess"
  | "transparentRuntimeLocator"
  | "transparentRuntimeRetirement";

/**
 * Coordinates AppServer projection with live Runtime authority.
 *
 * AppServerProjectionService remains a pure compatibility projection. This
 * service owns the transparent-Runtime side effects that follow committed
 * outer-namespace lifecycle facts: execution epochs, Runtime retirement and
 * Workspace archival.
 */
export class TransparentBackendProjectionService extends Service
  implements TransparentBackendProjectionPort {
  static inject = [
    "appServerProjection",
    "runtimeWorkspace",
    "threadExecution",
    "threadManager",
    "transparentRuntimeAccess",
    "transparentRuntimeLocator",
    "transparentRuntimeRetirement",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentBackendProjection");
  }

  projectThread(
    outerThreadId: string,
    source: unknown,
    explicitState: TransparentBackendState | null | undefined,
  ): void {
    const state = explicitState ?? this.ctx.transparentRuntimeLocator.stateForOuter(
      outerThreadId,
      this.ctx.transparentRuntimeAccess.localFilesystem,
    );
    if (!state) return;
    this.ctx.appServerProjection.projectThread(
      outerThreadId,
      source,
      this.projectionHost(state),
    );
  }

  projectBackend(
    message: JsonRpcResponse,
    state: TransparentBackendState | null | undefined,
  ): void {
    if (!state) return;
    this.ctx.appServerProjection.projectBackend(
      message,
      this.projectionHost(state),
    );
  }

  private projectionHost(
    state: TransparentBackendState,
  ): AppServerBackendProjectionHost {
    return {
      virtualPath: (path) => this.ctx.transparentRuntimeAccess.toVirtual(path, state),
      turnStarted: (outerThreadId, turn) => this.turnStarted(state, outerThreadId, turn),
      turnCompleted: (outerThreadId, turn) => {
        const ownerConnection = this.ctx.transparentRuntimeLocator.ownerConnection(
          state,
          outerThreadId,
        );
        this.ctx.threadExecution.complete(outerThreadId, {
          connection: ownerConnection,
          turnId: turn?.id,
          epoch: this.ctx.transparentRuntimeLocator.ownerEpoch(state, outerThreadId),
          reason: turn?.status ?? "completed",
        });
        this.ctx.transparentRuntimeRetirement.retireThreadRuntimeIfIdle(outerThreadId);
      },
      threadArchived: (outerThreadId) => {
        this.ctx.runtimeWorkspace.archive(this.ctx.threadManager.get(outerThreadId));
        const ownerConnection = this.ctx.transparentRuntimeLocator.ownerConnection(
          state,
          outerThreadId,
        );
        ownerConnection?.threadWriteLease?.release(outerThreadId, ownerConnection);
        this.ctx.threadExecution.releaseThread(outerThreadId, "threadArchived");
      },
    };
  }

  private turnStarted(
    state: TransparentBackendState,
    outerThreadId: string,
    turn: CanonicalTurnSeed,
  ): void {
    const ownerConnection = this.ctx.transparentRuntimeLocator.ownerConnection(
      state,
      outerThreadId,
    );
    const epoch = this.ctx.transparentRuntimeLocator.ownerEpoch(state, outerThreadId);
    if (turn.id && epoch !== undefined) state.turnEpochs.set(turn.id, epoch);
    // Admission is not execution. Only the native turn/started fact promotes
    // the matching Runtime epoch from dispatching to running.
    if (ownerConnection) {
      this.ctx.threadExecution.markNativeStarted(
        outerThreadId,
        ownerConnection,
        turn.id,
        epoch,
      );
    }
  }
}
