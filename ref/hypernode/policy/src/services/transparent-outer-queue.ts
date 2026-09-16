import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  TransparentOuterQueuePort,
  TransparentOuterQueueRequest,
} from "../types/transparent-outer-queue.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import { executionProfileFromRuntimeHint } from "./execution-profile.ts";
import { providerIdFromAccountIdentity } from "./transparent-thread-routing.ts";

const ACTIVE_THREAD_METHODS = new Set(["thread/read", "thread/resume", "turn/start"]);

type Dependencies =
  | "principal"
  | "runtimeWorkspace"
  | "threadExecution"
  | "threadManager"
  | "transparentBackendChannel"
  | "transparentBackendLifecycle"
  | "transparentBackendRegistry"
  | "transparentOuterDispatch"
  | "transparentRuntimeAccess"
  | "transparentThreadBinding";

/**
 * Chooses the replaceable Codex Runtime for an outer Thread and serializes its
 * open handshake.  A steer remains pinned to the Runtime executing the active
 * Turn; all other requests use the Thread's next immutable execution profile.
 */
export class TransparentOuterQueueService extends Service implements TransparentOuterQueuePort {
  static inject = [
    "principal",
    "runtimeWorkspace",
    "threadExecution",
    "threadManager",
    "transparentBackendChannel",
    "transparentBackendLifecycle",
    "transparentBackendRegistry",
    "transparentOuterDispatch",
    "transparentRuntimeAccess",
    "transparentThreadBinding",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentOuterQueue");
  }

  enqueue(request: TransparentOuterQueueRequest): void {
    const { connection, outerThreadId, action } = request;
    const binding = this.ctx.transparentThreadBinding.bindings.get(outerThreadId) ?? null;
    const runtimeHint = this.ctx.transparentThreadBinding.runtimeHintFor(outerThreadId);
    const cwd = this.ctx.threadManager.find(outerThreadId)?.cwd ?? null;
    const ownerUserId = runtimeHint?.ownerUserId ??
      this.ctx.threadManager.metadataFor(outerThreadId)?.ownerPrincipalId ??
      connection.identity?.id ?? this.ctx.principal.current().id;
    const filesystem = binding?.realm
      ? this.ctx.transparentRuntimeAccess.filesystemForRealm(binding.realm)
      : this.ctx.transparentRuntimeAccess.filesystemForCwd(cwd) ??
        this.ctx.transparentRuntimeAccess.defaultFilesystem();
    const viewId = binding?.viewId ?? this.ctx.runtimeWorkspace.viewIdForThread(outerThreadId);
    const activeExecution = this.ctx.threadExecution.table.get(outerThreadId) ?? null;
    // A newly admitted Thread has no active Turn yet, but admission has
    // already committed the immutable account/provider identity as its
    // Runtime hint.  Reconstructing the profile keeps the queue on the same
    // prewarmed Runtime instead of creating an unbound duplicate.
    const executionProfile = activeExecution?.executionProfile ??
      executionProfileFromRuntimeHint(runtimeHint);
    const activeRuntimeId = action.message.method === "turn/steer"
      ? activeExecution?.runtimeId ?? null
      : null;
    const backendKey = activeRuntimeId ?? this.ctx.transparentRuntimeAccess.threadBackendKey(
      ownerUserId,
      filesystem,
      viewId,
      outerThreadId,
      executionProfile,
    );

    let state = this.ctx.transparentBackendRegistry.backends.get(backendKey) ?? null;
    if (state !== null && state.phase !== "failed") {
      this.ctx.transparentBackendRegistry.attach(state, connection);
    } else {
      state = this.ctx.transparentBackendLifecycle.ensure({
        connection,
        ownerUserId,
        filesystem,
        viewId,
        initialCwd: cwd,
        defaultBackendKey: this.ctx.transparentRuntimeAccess.backendKey(
          ownerUserId,
          filesystem,
          viewId,
        ),
        workspaceRealm: this.ctx.transparentRuntimeAccess.isWorkspaceFilesystem(filesystem),
        options: {
          backendKey,
          isolatedOuterThreadId: outerThreadId,
          accountIdentity: executionProfile?.credentialIdentity ?? runtimeHint?.accountIdentity ?? null,
          providerId: executionProfile
            ? (executionProfile.providerId === "openai" ? null : executionProfile.providerId)
            : runtimeHint?.providerId ?? providerIdFromAccountIdentity(
              runtimeHint?.accountIdentity,
              ownerUserId,
            ),
          executionProfile,
        },
      });
    }

    console.info(
      `[transparent-codex] route method=${action.message.method ?? ""} ` +
      `outer=${outerThreadId} realm=${state.realm} view=${state.viewId} phase=${state.phase} ` +
      `opened=${state.opened?.has(outerThreadId) === true} ` +
      `opening=${state.opening?.has(outerThreadId) === true}`,
    );
    if (action.message.method === "turn/steer") {
      console.info(`[turn-steer] ${JSON.stringify({
        stage: "received",
        outerThreadId,
        connectionId: connection.connectionId ?? null,
        sessionId: connection.sessionId ?? null,
        frontendRequestId: action.message.id ?? null,
        clientUserMessageId: typeof action.message.params?.["clientUserMessageId"] === "string"
          ? action.message.params["clientUserMessageId"]
          : null,
        expectedTurnId: typeof action.message.params?.["expectedTurnId"] === "string"
          ? action.message.params["expectedTurnId"]
          : null,
        backendKey: state.backendKey,
        backendPhase: state.phase,
      })}`);
    }
    if (action.message.method && ACTIVE_THREAD_METHODS.has(action.message.method)) {
      connection.activeThreadId = outerThreadId;
    }
    action.connection = connection;

    if (state.opened.has(outerThreadId)) {
      if (action.message.method === "thread/resume" && binding?.durable === true) {
        this.ctx.transparentOuterDispatch.forward(state, connection, outerThreadId, action.message);
      } else if (action.respondFromOpen === true) {
        this.ctx.transparentBackendChannel.send(
          connection,
          this.ctx.transparentRuntimeAccess.toOuter({
            ...(action.message.id === undefined ? {} : { id: action.message.id }),
            result: state.openResults.get(outerThreadId),
          }, state),
        );
      } else {
        this.ctx.transparentOuterDispatch.forward(state, connection, outerThreadId, action.message);
      }
      return;
    }

    const pending = state.pendingByOuter.get(outerThreadId) ?? [];
    pending.push(action);
    state.pendingByOuter.set(outerThreadId, pending);
    console.info(
      `[transparent-codex] queued method=${action.message.method ?? ""} ` +
      `outer=${outerThreadId} phase=${state.phase} pending=${pending.length}`,
    );
    if (state.phase === "ready") this.ctx.transparentOuterDispatch.open(state, outerThreadId);
  }
}
