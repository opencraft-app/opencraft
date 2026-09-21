import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AppServerParams,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  TransparentThreadForkReplayHost,
  TransparentThreadForkPort,
  TransparentThreadForkRequest,
} from "../types/transparent-thread-fork.ts";
import type {
  TransparentBackendState,
  TransparentForwardedRequest,
} from "../types/transparent-backend.ts";
import { threadStartedProjection } from "./thread-protocol.ts";

const INTERNAL_PREFIX = "hypernode:transparent:workspace-fork:";

/**
 * Forks stable outer Threads independently from their replaceable engine.
 *
 * DSH owns no hidden inner Thread, so its fork commits immediately after the
 * Workspace and canonical timeline transaction. Codex additionally mirrors
 * the fork into its private rollout and rolls the outer fork back on failure.
 */
export class TransparentThreadForkService extends Service implements TransparentThreadForkPort {
  static inject = [
    "canonicalTimeline",
    "runtimeWorkspace",
    "threadManager",
    "transparentBackendChannel",
    "transparentBackendLifecycle",
    "transparentBackendProjection",
    "transparentBackendRpc",
    "transparentRuntimeAccess",
    "transparentThreadBinding",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private sequence = 0;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentThreadFork");
  }

  start(request: TransparentThreadForkRequest): void {
    const sourceThreadId = requiredString(request.message.params?.["threadId"], "threadId");
    const runtimeHint = this.ctx.transparentThreadBinding.runtimeHintFor(sourceThreadId);
    const binding = this.ctx.transparentThreadBinding.bindings.get(sourceThreadId) ?? null;
    if (runtimeHint?.engineKind !== "dsh" && binding === null) {
      throw new Error(`cannot fork unopened transparent thread: ${sourceThreadId}`);
    }

    const local = this.ctx.runtimeWorkspace.fork(
      request.message.params ?? {},
      request.connection,
      { notify: false },
    );
    const forkThreadId = local.thread.id;
    try {
      if (runtimeHint?.engineKind === "dsh" && binding === null) {
        this.ctx.transparentThreadBinding.setRuntimeHint(forkThreadId, {
          ownerUserId: this.ctx.threadManager.ownerOf(forkThreadId) ?? runtimeHint.ownerUserId,
          accountIdentity: runtimeHint.accountIdentity,
          engineKind: "dsh",
          providerId: runtimeHint.providerId,
          model: runtimeHint.model,
          threadSettings: runtimeHint.threadSettings,
          backendKey: null,
          epoch: null,
        }, true);
        this.ctx.transparentBackendChannel.subscribe(request.connection, forkThreadId);
        this.ctx.transparentBackendChannel.send(
          request.connection,
          withRequestId(request.message, { result: local }),
        );
        this.ctx.transparentBackendChannel.send(request.connection, {
          method: "thread/started",
          params: { thread: threadStartedProjection(local.thread) },
        });
        return;
      }

      if (binding === null) throw new Error(`missing Codex binding for fork: ${sourceThreadId}`);
      const ownerUserId = this.ctx.threadManager.ownerOf(sourceThreadId) ??
        request.connection.identity?.id;
      if (!ownerUserId) throw new Error(`cannot resolve owner for fork: ${sourceThreadId}`);
      const filesystem = this.ctx.transparentRuntimeAccess.filesystemForRealm(binding.realm);
      const viewId = this.ctx.runtimeWorkspace.viewIdForThread(forkThreadId);
      const backendKey = this.ctx.transparentRuntimeAccess.threadBackendKey(
        ownerUserId,
        filesystem,
        viewId,
        forkThreadId,
      );
      const state = this.ctx.transparentBackendLifecycle.ensure({
        connection: request.connection,
        ownerUserId,
        filesystem,
        viewId,
        initialCwd: local.thread.cwd,
        defaultBackendKey: this.ctx.transparentRuntimeAccess.backendKey(
          ownerUserId,
          filesystem,
          viewId,
        ),
        workspaceRealm: this.ctx.transparentRuntimeAccess.isWorkspaceFilesystem(filesystem),
        options: {
          backendKey,
          isolatedOuterThreadId: forkThreadId,
        },
      });
      const backendId = `${INTERNAL_PREFIX}${++this.sequence}`;
      this.ctx.transparentBackendRpc.trackForwarded(state, backendId, {
        connection: request.connection,
        clientId: request.message.id,
        outerThreadId: sourceThreadId,
        forkOuterThreadId: forkThreadId,
        method: "thread/fork",
        workspaceFork: true,
        localForkResponse: local,
      });
      if (this.ctx.canonicalTimeline.turns(sourceThreadId).length === 0) {
        this.sendWhenReady(state, {
          id: backendId,
          method: "thread/start",
          params: startParams(request.message.params ?? {}, local.thread.cwd),
        });
      } else {
        this.sendWhenReady(state, {
          id: backendId,
          method: "thread/fork",
          params: {
            ...(request.message.params ?? {}),
            threadId: binding.innerThreadId,
            cwd: local.thread.cwd,
          },
        });
      }
    } catch (error) {
      this.ctx.runtimeWorkspace.discardFork(forkThreadId);
      throw error;
    }
  }

  complete(
    forwarded: TransparentForwardedRequest,
    state: TransparentBackendState,
    response: JsonRpcResponse,
    host: TransparentThreadForkReplayHost,
  ): boolean {
    if (forwarded.workspaceFork !== true) return false;
    const forkThreadId = requiredString(forwarded.forkOuterThreadId, "forkOuterThreadId");
    if (response.error !== undefined) {
      this.ctx.runtimeWorkspace.discardFork(forkThreadId);
      this.ctx.transparentBackendChannel.send(
        forwarded.connection,
        clientResponse(response, forwarded.clientId),
      );
      return true;
    }
    const result = objectRecord(response.result);
    const innerThread = objectRecord(result?.["thread"]);
    const innerThreadId = optionalString(innerThread?.["id"]);
    if (result === null || innerThread === null || innerThreadId === null) {
      this.ctx.runtimeWorkspace.discardFork(forkThreadId);
      this.ctx.transparentBackendChannel.send(forwarded.connection, withOptionalId(
        forwarded.clientId,
        {
          error: { code: -32050, message: "local Codex fork did not return a thread id" },
        },
      ));
      return true;
    }
    this.ctx.transparentThreadBinding.setBinding(
      forkThreadId,
      innerThreadId,
      true,
      true,
      state.realm,
      state.viewId,
      {
        ownerUserId: state.ownerUserId,
        accountIdentity: state.accountIdentity,
        providerId: state.providerId,
        rolloutPath: optionalString(innerThread["path"]),
        backendKey: state.backendKey,
      },
    );
    this.ctx.transparentBackendChannel.subscribe(forwarded.connection, forkThreadId);
    this.ctx.transparentBackendProjection.projectThread(forkThreadId, innerThread, state);
    state.opened.add(forkThreadId);
    const localFork = objectRecord(forwarded.localForkResponse);
    const localThread = localFork?.["thread"];
    const projected = this.ctx.transparentRuntimeAccess.toOuter(
      clientResponse(response, forwarded.clientId, {
      result: { ...result, thread: localThread },
      }),
      state,
    );
    state.openResults.set(forkThreadId, projected.result);
    host.flushThreadMessages(state, innerThreadId);
    this.ctx.transparentBackendChannel.send(forwarded.connection, projected);
    return true;
  }

  private sendWhenReady(state: TransparentBackendState, message: JsonRpcRequest): void {
    if (state.phase === "ready") {
      this.ctx.transparentRuntimeAccess.filesystem(state).send(state.processId, message);
      return;
    }
    state.pendingBackendMessages.push(message);
  }
}

type Dependencies =
  | "canonicalTimeline"
  | "runtimeWorkspace"
  | "threadManager"
  | "transparentBackendChannel"
  | "transparentBackendLifecycle"
  | "transparentBackendProjection"
  | "transparentBackendRpc"
  | "transparentRuntimeAccess"
  | "transparentThreadBinding";

function startParams(params: AppServerParams, cwd: string): AppServerParams {
  const result: AppServerParams = { ...params, cwd };
  delete result["threadId"];
  delete result["lastTurnId"];
  // projectId belongs to HyperNode's outer project catalog.  The isolated
  // Codex backend used for an empty-source fork does not own that catalog.
  delete result["projectId"];
  return result;
}

function clientResponse(
  response: JsonRpcResponse,
  id: JsonRpcResponse["id"],
  overrides: Partial<JsonRpcResponse> = {},
): JsonRpcResponse {
  const { id: _sourceId, ...payload } = response;
  return withOptionalId(id, { ...payload, ...overrides });
}

function withOptionalId(
  id: JsonRpcResponse["id"],
  payload: Omit<JsonRpcResponse, "id">,
): JsonRpcResponse {
  return id === undefined ? payload : { id, ...payload };
}

function withRequestId(
  message: { id?: string | number | null },
  payload: { result?: unknown },
): JsonRpcResponse {
  return message.id === undefined ? payload : { id: message.id, ...payload };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
