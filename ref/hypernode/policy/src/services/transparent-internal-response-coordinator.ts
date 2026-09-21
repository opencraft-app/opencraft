import { Service, type Inject } from "@deepseek-ai/cordis";
import type { JsonRpcResponse } from "../types/appserver.ts";
import type {
  TransparentBackendState,
  TransparentInternalRequest,
} from "../types/transparent-backend.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  TransparentInternalResponseCoordinatorHost,
  TransparentInternalResponseCoordinatorPort,
} from "../types/transparent-internal-response-coordinator.ts";

type Dependencies =
  | "threadArtifactStore"
  | "transparentBackendChannel"
  | "transparentBackendProjection"
  | "transparentEngineSwitch"
  | "transparentInternalResponse"
  | "transparentProtocolMapper"
  | "transparentThreadBinding";

/**
 * Owns the integration of internal Runtime responses with durable Thread
 * bindings and Codex rollout artifacts.
 *
 * Handoff/open classification remains in TransparentInternalResponseService;
 * this coordinator supplies its typed durable effects and leaves only live
 * transport/projection callbacks at the compatibility boundary.
 */
export class TransparentInternalResponseCoordinatorService extends Service
  implements TransparentInternalResponseCoordinatorPort {
  static inject = [
    "threadArtifactStore",
    "transparentBackendChannel",
    "transparentBackendProjection",
    "transparentEngineSwitch",
    "transparentInternalResponse",
    "transparentProtocolMapper",
    "transparentThreadBinding",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentInternalResponseCoordinator");
  }

  handle(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    request: TransparentInternalRequest,
    host: TransparentInternalResponseCoordinatorHost,
  ): boolean {
    return this.ctx.transparentInternalResponse.handle(state, message, request, {
      handoff: {
        discardArtifact: (artifact) => this.ctx.threadArtifactStore.discard(artifact),
        retireIsolatedBackend: (candidate, outerThreadId) =>
          host.retireIsolatedBackend(candidate, outerThreadId),
        retry: (handoff) => this.ctx.transparentEngineSwitch.continue(handoff),
        setBinding: (outerThreadId, innerThreadId, realm, viewId, runtime) =>
          this.ctx.transparentThreadBinding.setBinding(
            outerThreadId,
            innerThreadId,
            true,
            true,
            realm,
            viewId,
            runtime,
          ),
        commitArtifact: (artifact, accountIdentity, epoch, ownerUserId) => {
          this.ctx.threadArtifactStore.commit(artifact, accountIdentity, epoch, ownerUserId);
        },
        unsubscribe: (candidate, innerThreadId) => host.unsubscribe(candidate, innerThreadId),
        projectThread: (outerThreadId, thread) =>
          this.projectThread(state, outerThreadId, thread),
        flushThreadMessages: (innerThreadId) =>
          this.flushThreadMessages(state, innerThreadId, host),
        discardUnmatchedThreadMessages: () =>
          this.ctx.transparentBackendChannel.discardUnmatchedThreadMessages(state),
        forwardTurn: (candidate, connection, outerThreadId, turn) =>
          host.forwardTurn(candidate, connection, outerThreadId, turn),
      },
      open: {
        currentArtifactPath: (outerThreadId) =>
          this.ctx.threadArtifactStore.current(outerThreadId)?.path ?? null,
        failOuter: (outerThreadId, reason) => host.failOuter(outerThreadId, reason),
        discardUnmatchedThreadMessages: () =>
          this.ctx.transparentBackendChannel.discardUnmatchedThreadMessages(state),
        clearBinding: (outerThreadId) =>
          this.ctx.transparentThreadBinding.clearBinding(outerThreadId),
        openOuter: (outerThreadId, forceStart) => host.openOuter(outerThreadId, forceStart),
        setBinding: (outerThreadId, innerThreadId, durable, realm, viewId, runtime) =>
          this.ctx.transparentThreadBinding.setBinding(
            outerThreadId,
            innerThreadId,
            durable,
            true,
            realm,
            viewId,
            runtime,
          ),
        binding: (outerThreadId) =>
          this.ctx.transparentThreadBinding.bindings.get(outerThreadId) ?? null,
        setRuntimeHint: (outerThreadId, runtime) =>
          this.ctx.transparentThreadBinding.setRuntimeHint(outerThreadId, runtime, false),
        persistBindings: () => this.ctx.transparentThreadBinding.persist(),
        projectThread: (outerThreadId, thread) =>
          this.projectThread(state, outerThreadId, thread),
        flushThreadMessages: (innerThreadId) =>
          this.flushThreadMessages(state, innerThreadId, host),
        flushOpenQueue: (outerThreadId) => host.flushOpenQueue(outerThreadId),
      },
    });
  }

  private projectThread(
    state: TransparentBackendState,
    outerThreadId: string,
    thread: unknown,
  ): void {
    this.ctx.transparentBackendProjection.projectThread(
      outerThreadId,
      thread,
      state,
    );
  }

  private flushThreadMessages(
    state: TransparentBackendState,
    innerThreadId: string,
    host: TransparentInternalResponseCoordinatorHost,
  ): void {
    this.ctx.transparentBackendChannel.flushThreadMessages(state, innerThreadId, {
      hasBinding: (candidate) =>
        this.ctx.transparentThreadBinding.reverseBindings.has(candidate),
      outerThreadId: (candidate) =>
        this.ctx.transparentThreadBinding.reverseBindings.get(candidate) ?? null,
      replay: (candidateState, message) =>
        host.replayBackendMessage(candidateState, message),
    });
  }
}
