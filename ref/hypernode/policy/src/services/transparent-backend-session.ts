import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AppServerConnection,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../types/appserver.ts";
import type {
  TransparentInternalResponseCoordinatorHost,
} from "../types/transparent-internal-response-coordinator.ts";
import type {
  TransparentBackendState,
  TransparentInternalRequest,
} from "../types/transparent-backend.ts";
import type {
  TransparentBackendMessageCoordinatorHost,
} from "../types/transparent-backend-message-coordinator.ts";
import type { TransparentBackendSessionPort } from "../types/transparent-backend-session.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";

type Dependencies =
  | "threadExecution"
  | "transparentBackendLifecycle"
  | "transparentBackendMessageCoordinator"
  | "transparentBackendPump"
  | "transparentBackendRegistry"
  | "transparentControlRouting"
  | "transparentInternalResponseCoordinator"
  | "transparentOuterDispatch"
  | "transparentRuntimeRetirement"
  | "transparentThreadFork";

/**
 * Cordis-owned lifecycle for native Codex backend ingress.
 *
 * This is the single recursive entry point for live messages and deferred
 * replay.  The compatibility facade no longer assembles callback graphs for
 * bootstrap, handoff, fork completion or runtime failure.
 */
export class TransparentBackendSessionService extends Service
  implements TransparentBackendSessionPort {
  static inject = [
    "threadExecution",
    "transparentBackendLifecycle",
    "transparentBackendMessageCoordinator",
    "transparentBackendPump",
    "transparentBackendRegistry",
    "transparentControlRouting",
    "transparentInternalResponseCoordinator",
    "transparentOuterDispatch",
    "transparentRuntimeRetirement",
    "transparentThreadFork",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentBackendSession");
  }

  poll(connection: AppServerConnection): void {
    for (const state of this.ctx.transparentBackendRegistry.connections.get(connection) ?? []) {
      this.pollBackend(state);
    }
  }

  pollBackend(state: TransparentBackendState): void {
    this.ctx.transparentBackendPump.poll(state, {
      message: (message) => this.handleMessage(state, message),
      failed: (reason) => this.fail(state, reason),
    });
  }

  handleMessage(state: TransparentBackendState, message: JsonRpcResponse): void {
    this.ctx.transparentBackendMessageCoordinator.handle(
      state,
      message,
      this.messageCoordinatorHost(state),
    );
  }

  flushDeferred(state: TransparentBackendState, innerThreadId: string): void {
    this.ctx.transparentBackendMessageCoordinator.flushDeferred(
      state,
      innerThreadId,
      this.messageCoordinatorHost(state),
    );
  }

  failOuter(state: TransparentBackendState, outerThreadId: string, reason: string): void {
    const actions = state.pendingByOuter.get(outerThreadId) ?? [];
    state.pendingByOuter.delete(outerThreadId);
    for (const action of actions) {
      if (action.message.method === "turn/start") {
        this.ctx.threadExecution.abortRequest(
          outerThreadId,
          action.connection,
          action.message.id,
        );
      }
      action.connection.socket.send({
        id: action.message.id,
        error: { code: -32050, message: reason },
      });
    }
  }

  fail(state: TransparentBackendState, reason: string): void {
    this.ctx.transparentBackendLifecycle.fail(state, reason);
  }

  private messageCoordinatorHost(
    state: TransparentBackendState,
  ): TransparentBackendMessageCoordinatorHost {
    return {
      bootstrap: {
        fail: (reason) => this.fail(state, reason),
        forwardControl: (connection, message) =>
          this.ctx.transparentControlRouting.forwardControlNow(state, connection, message),
        forwardInternalControl: (request) =>
          this.ctx.transparentControlRouting.forwardInternalControlNow(state, request),
        openOuter: (outerThreadId) =>
          this.ctx.transparentOuterDispatch.open(state, outerThreadId),
        failOuter: (outerThreadId, reason) =>
          this.failOuter(state, outerThreadId, reason),
      },
      handleInternal: (message, request) =>
        this.ctx.transparentInternalResponseCoordinator.handle(
          state,
          message,
          request,
          this.internalResponseHost(state, request),
        ),
      forwardedResponseHost: () => ({
        completeWorkspaceFork: (request, candidate, message) =>
          this.ctx.transparentThreadFork.complete(request, candidate, message, {
            flushThreadMessages: (forkState, innerThreadId) =>
              this.flushDeferred(forkState, innerThreadId),
          }),
        closeArchivedWorkspaceBackend: (threadId, candidate) =>
          this.ctx.transparentRuntimeRetirement.closeArchivedWorkspaceBackend(
            threadId,
            candidate,
          ),
      }),
    };
  }

  private internalResponseHost(
    state: TransparentBackendState,
    request: TransparentInternalRequest,
  ): TransparentInternalResponseCoordinatorHost {
    return {
      retireIsolatedBackend: (candidate: TransparentBackendState, outerThreadId: string) =>
        this.ctx.transparentRuntimeRetirement.retireIsolatedBackend(
          candidate,
          outerThreadId,
          false,
        ),
      unsubscribe: (candidate: TransparentBackendState, innerThreadId: string) =>
        this.ctx.transparentControlRouting.forwardInternalControlNow(candidate, {
          method: "thread/unsubscribe",
          params: { threadId: innerThreadId },
          callback: (error) => {
            if (error) {
              console.info(
                `[transparent-codex] superseded runtime unsubscribe failed ` +
                `outer=${request.outerThreadId}: ${error.message ?? error}`,
              );
            }
          },
        }),
      replayBackendMessage: (candidate: TransparentBackendState, message: JsonRpcResponse) =>
        this.handleMessage(candidate, message),
      forwardTurn: (
        candidate: TransparentBackendState,
        connection: AppServerConnection,
        outerThreadId: string,
        message: JsonRpcRequest,
      ) => this.ctx.transparentOuterDispatch.forward(
        candidate,
        connection,
        outerThreadId,
        message,
      ),
      failOuter: (outerThreadId: string, reason: string) =>
        this.failOuter(state, outerThreadId, reason),
      openOuter: (outerThreadId: string, forceStart: boolean) =>
        this.ctx.transparentOuterDispatch.open(state, outerThreadId, forceStart),
      flushOpenQueue: (outerThreadId: string) =>
        this.ctx.transparentOuterDispatch.flush(state, outerThreadId),
    };
  }
}
