import { Service, type Inject } from "@deepseek-ai/cordis";
import { executionProfilesCompatible } from "./execution-profile.ts";
import { backendInitializeParams } from "./transparent-thread-routing.ts";
import type {
  TransparentBackendEnsureInput,
  TransparentBackendLifecyclePort,
  TransparentBackendReadyWork,
  TransparentForwardedRequest,
  TransparentBackendState,
} from "../types/transparent-backend.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";

const INTERNAL_PREFIX = "hypernode:transparent:";

type Dependencies =
  | "credential"
  | "modelGateway"
  | "runtimeRegistry"
  | "runtimeWorkspace"
  | "threadExecution"
  | "threadManager"
  | "transparentBackendChannel"
  | "transparentBackendRegistry"
  | "transparentRuntimeAccess"
  | "transparentRuntimeRecovery"
  | "userDirectory";

/**
 * Owns the Codex backend process bootstrap and initialize handshake.
 *
 * This is runtime state only. It never reads or writes Thread projections,
 * canonical history, or AppServer pagination state.
 */
export class TransparentBackendLifecycleService extends Service
  implements TransparentBackendLifecyclePort {
  static inject = [
    "credential",
    "modelGateway",
    "runtimeRegistry",
    "runtimeWorkspace",
    "threadExecution",
    "threadManager",
    "transparentBackendChannel",
    "transparentBackendRegistry",
    "transparentRuntimeAccess",
    "transparentRuntimeRecovery",
    "userDirectory",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  private sequence = 0;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentBackendLifecycle");
  }

  ensure(
    input: TransparentBackendEnsureInput,
  ): TransparentBackendState {
    const options = input.options ?? {};
    const engineKind = options.executionProfile?.engineKind ?? "codex";
    if (engineKind !== "codex") {
      throw Object.assign(
        new Error(`execution engine ${JSON.stringify(engineKind)} must be started through its engine adapter`),
        {
          code: -32074,
          data: { kind: "executionEngineAdapterRequired", engineKind },
        },
      );
    }

    const backendKey = options.backendKey ?? input.defaultBackendKey;
    const current = this.ctx.transparentBackendRegistry.backends.get(backendKey);
    if (current && current.phase !== "failed") {
      if (options.executionProfile && !executionProfilesCompatible(
        current.executionProfile,
        options.executionProfile,
      )) {
        throw new Error("runtime compatibility fingerprint mismatch");
      }
      this.ctx.transparentBackendRegistry.attach(current, input.connection);
      return current;
    }
    if (current) this.ctx.transparentBackendRegistry.remove(current);

    if (options.providerId) {
      this.ctx.modelGateway.ensureRuntimeProvider(input.ownerUserId, options.providerId);
    }
    const credential = this.ctx.credential.resolveUser(input.ownerUserId);
    const suffix = `${Date.now().toString(36)}-${++this.sequence}`;
    const processId = `transparent-${input.ownerUserId}-${suffix}`;
    const state = this.ctx.transparentBackendRegistry.create({
      ownerUserId: input.ownerUserId,
      accountIdentity: Object.prototype.hasOwnProperty.call(options, "accountIdentity")
        ? (options.accountIdentity ?? null)
        : (credential?.accountIdentity ?? null),
      providerId: Object.prototype.hasOwnProperty.call(options, "providerId")
        ? (options.providerId ?? null)
        : (credential?.providerId ?? null),
      executionProfile: options.executionProfile ?? null,
      runtimeFingerprint: options.executionProfile?.fingerprint ?? null,
      backendKey,
      isolatedOuterThreadId: options.isolatedOuterThreadId ?? null,
      realm: input.workspaceRealm ? "workspace" : "localhost",
      viewId: input.viewId,
      filesystem: input.filesystem,
      user: this.ctx.userDirectory.find(input.ownerUserId),
      connection: input.connection,
      processId,
      initId: `${INTERNAL_PREFIX}initialize:${suffix}`,
    });
    console.info(
      `[transparent-codex] backend identity owner=${state.ownerUserId} ` +
      `account=${state.accountIdentity ?? "unbound"} provider=${state.providerId ?? "codex"} ` +
      `key=${backendKey}`,
    );

    const runtimeCwd = input.workspaceRealm
      ? (input.initialCwd ?? this.ctx.runtimeWorkspace.projectsRoot(input.viewId))
      : "/localhost";
    try {
      if (state.isolatedOuterThreadId) {
        input.filesystem.spawnThreadRuntime(
          processId,
          runtimeCwd,
          state.user,
          input.viewId,
          state.isolatedOuterThreadId,
          state.providerId,
        );
        this.ctx.runtimeRegistry.register({
          runtimeId: state.isolatedOuterThreadId,
          outerThreadId: state.isolatedOuterThreadId,
          processId,
          realm: state.realm,
          viewId: input.viewId,
          engineKind: "codex",
          ownerUserId: input.ownerUserId,
        });
        this.ctx.transparentRuntimeRecovery.clearFailure(state.isolatedOuterThreadId);
      } else {
        input.filesystem.spawnAppServer(
          processId,
          runtimeCwd,
          state.user,
          input.viewId,
          state.providerId,
        );
      }
      input.filesystem.send(processId, {
        id: state.initId,
        method: "initialize",
        params: backendInitializeParams(input.connection),
      });
      return state;
    } catch (error) {
      state.phase = "failed";
      this.ctx.transparentBackendRegistry.remove(state);
      if (state.isolatedOuterThreadId) {
        try {
          input.filesystem.kill(processId);
        } catch {
          // The spawn failure may mean no process exists.
        }
        this.ctx.runtimeRegistry.unregister(state.isolatedOuterThreadId);
      }
      throw error;
    }
  }

  completeInitialization(state: TransparentBackendState): TransparentBackendReadyWork | null {
    if (state.phase !== "initializing") return null;
    state.phase = "ready";
    state.filesystem.send(state.processId, { method: "initialized", params: {} });
    return {
      backendMessages: state.pendingBackendMessages.splice(0),
      controls: state.pendingControl.splice(0),
      internalControls: state.pendingInternalControl.splice(0),
      outerThreadIds: [...state.pendingByOuter.keys()],
    };
  }

  fail(
    state: TransparentBackendState,
    reason: string,
  ): boolean {
    if (state.phase === "failed") return false;
    state.phase = "failed";
    if (state.isolatedOuterThreadId) this.terminateFailedRuntime(state);

    const detail = state.stderr.length > 0
      ? `${reason}: ${state.stderr.slice(-3).join(" | ")}`
      : reason;
    console.error(`[transparent-codex] backend failed backend=${state.backendKey}: ${detail}`);

    for (const execution of this.ctx.threadExecution.abortRuntime(
      state.backendKey,
      "runtimeFailed",
    )) {
      this.projectRuntimeFailure(state, execution, detail);
    }
    for (const pending of state.pendingControl.splice(0)) {
      pending.connection.socket.send({
        id: pending.message.id,
        error: { code: -32050, message: detail },
      });
    }
    const error = { code: -32050, message: detail };
    for (const pending of state.pendingInternalControl.splice(0)) {
      pending.callback(error);
    }
    for (const [, pending] of state.internalControlRequests) pending.callback(error);
    state.internalControlRequests.clear();
    state.pendingBackendMessages.length = 0;
    state.pendingThreadMessages.clear();
    state.commandProcesses.clear();
    state.commandProcessesByConnection.clear();
    state.hostProcesses.clear();
    state.hostProcessesByConnection.clear();
    state.abandonedRequestIds.clear();
    for (const outerThreadId of [...state.pendingByOuter.keys()]) {
      this.failOuter(state, outerThreadId, detail);
    }
    for (const [, forwarded] of state.forwardedRequests) {
      if (forwarded.method === "turn/start") this.abortForwardedTurn(forwarded);
      forwarded.connection.socket.send({
        id: forwarded.clientId,
        error: { code: -32050, message: detail },
      });
    }
    state.forwardedRequests.clear();
    return true;
  }

  closeProcess(
    state: TransparentBackendState,
    runtimeId: string | null,
  ): boolean {
    if (state.phase === "closed") return false;
    state.phase = "closed";
    let terminated = false;
    try {
      state.filesystem.kill(state.processId);
      terminated = true;
    } catch {
      // Closing is best effort. A failed kill must not keep a dead backend
      // discoverable through the live in-memory registry.
    }
    if (terminated && runtimeId !== null) this.ctx.runtimeRegistry.unregister(runtimeId);
    this.ctx.transparentBackendRegistry.remove(state);
    return true;
  }

  retireIsolated(
    state: TransparentBackendState | null | undefined,
    outerThreadId: string,
    strict = false,
  ): boolean {
    if (state == null || state.isolatedOuterThreadId !== outerThreadId) return false;
    if (state.phase === "closed") return false;
    state.phase = "closed";
    let terminationError: unknown = null;
    if (state.filesystem.supportsPersistentRuntimeFencing === true) {
      try {
        state.filesystem.terminateThreadRuntime(
          state.processId,
          state.viewId,
          outerThreadId,
          5_000,
        );
      } catch (error) {
        terminationError = error;
        try {
          state.filesystem.kill(state.processId);
        } catch {
          // Preserve the authoritative termination error below.
        }
      }
    } else {
      try {
        state.filesystem.kill(state.processId);
      } catch (error) {
        terminationError = error;
      }
    }
    if (terminationError === null) this.ctx.runtimeRegistry.unregister(outerThreadId);
    this.ctx.transparentBackendRegistry.remove(state);
    console.info(`[transparent-codex] retired isolated backend outer=${outerThreadId}`);
    if (terminationError !== null && strict) throw terminationError;
    return true;
  }

  private terminateFailedRuntime(state: TransparentBackendState): boolean {
    let terminated = false;
    try {
      this.ctx.transparentRuntimeAccess.filesystem(state).kill(state.processId);
      terminated = true;
    } catch {
      // A failed Runtime may already have exited.
    }
    if (terminated && state.isolatedOuterThreadId) {
      this.ctx.runtimeRegistry.unregister(state.isolatedOuterThreadId);
    }
    return terminated;
  }

  private projectRuntimeFailure(
    state: TransparentBackendState,
    execution: { threadId: string; turnId?: string | null | undefined },
    detail: string,
  ): void {
    if (!execution.turnId) return;
    const thread = this.ctx.threadManager.find(execution.threadId);
    const projected = thread?.turns?.find((turn) => turn.id === execution.turnId);
    const failedTurn = {
      ...(projected ?? {}),
      id: execution.turnId,
      items: projected?.items ?? [],
      status: "failed",
      error: { message: detail },
      completedAt: Math.floor(Date.now() / 1_000),
    };
    this.ctx.threadManager.projectTurn(execution.threadId, failedTurn, "completed");
    this.ctx.transparentBackendChannel.broadcast(state, {
      method: "turn/completed",
      params: { threadId: execution.threadId, turn: failedTurn },
    });
    this.ctx.transparentBackendChannel.broadcast(state, {
      method: "thread/status/changed",
      params: { threadId: execution.threadId, status: { type: "idle" } },
    });
  }

  private failOuter(
    state: TransparentBackendState,
    outerThreadId: string,
    reason: string,
  ): void {
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
        ...(action.message.id === undefined ? {} : { id: action.message.id }),
        error: { code: -32050, message: reason },
      });
    }
  }

  private abortForwardedTurn(request: TransparentForwardedRequest): void {
    if (!request.outerThreadId) return;
    this.ctx.threadExecution.abortRequest(
      request.outerThreadId,
      request.connection,
      request.clientId,
    );
  }
}
