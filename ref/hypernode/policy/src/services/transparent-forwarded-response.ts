import { Service, type Inject } from "@deepseek-ai/cordis";
import type { JsonRpcResponse } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  TransparentBackendState,
  TransparentForwardedRequest,
} from "../types/transparent-backend.ts";
import type {
  TransparentForwardedResponseHost,
  TransparentForwardedResponsePort,
} from "../types/transparent-forwarded-response.ts";

type Dependencies =
  | "collaborationMode"
  | "runtimeWorkspace"
  | "threadExecution"
  | "threadManager"
  | "threadTitle"
  | "transparentBackendChannel"
  | "transparentBackendProjection"
  | "transparentProcessBridge"
  | "transparentProtocolMapper"
  | "transparentRuntimeAccess"
  | "transparentThreadBinding"
  | "userDirectory";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function resultTurnId(message: JsonRpcResponse): string | undefined {
  const id = record(record(message.result)?.["turn"])?.["id"];
  return typeof id === "string" ? id : undefined;
}

function withResponseId(
  message: JsonRpcResponse,
  id: TransparentForwardedRequest["clientId"],
): JsonRpcResponse {
  return id === undefined ? { ...message } : { ...message, id };
}

/** Applies one correlated native AppServer response to the public control plane. */
export class TransparentForwardedResponseService extends Service
  implements TransparentForwardedResponsePort {
  static inject = [
    "collaborationMode",
    "runtimeWorkspace",
    "threadExecution",
    "threadManager",
    "threadTitle",
    "transparentBackendChannel",
    "transparentBackendProjection",
    "transparentProcessBridge",
    "transparentProtocolMapper",
    "transparentRuntimeAccess",
    "transparentThreadBinding",
    "userDirectory",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentForwardedResponse");
  }

  handle(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    request: TransparentForwardedRequest,
    host: TransparentForwardedResponseHost,
  ): void {
    const threadId = request.outerThreadId;
    if (request.method === "turn/steer") {
      console.info(`[turn-steer] ${JSON.stringify({
        stage: "backend-response",
        outerThreadId: threadId,
        connectionId: request.connection.connectionId ?? null,
        sessionId: request.connection.sessionId ?? null,
        frontendRequestId: request.clientId ?? null,
        backendId: request.backendId ?? null,
        clientUserMessageId: request.clientUserMessageId ?? null,
        expectedTurnId: request.expectedTurnId ?? null,
        ok: message.error == null,
        errorCode: message.error?.code ?? null,
        latencyMs: request.forwardedAtMs === undefined
          ? null
          : Math.max(0, Date.now() - request.forwardedAtMs),
      })}`);
    }
    if (request.method === "turn/start" && typeof threadId === "string" &&
        request.authorityEpoch !== undefined &&
        this.ctx.threadExecution.table.get(threadId)?.epoch !== request.authorityEpoch) {
      console.info(
        `[transparent-codex] fenced stale turn response outer=${threadId} ` +
        `epoch=${request.authorityEpoch}`,
      );
      return;
    }
    if (request.workspaceFork && host.completeWorkspaceFork(request, state, message)) return;

    if (request.method === "command/exec") {
      this.ctx.transparentProcessBridge.releaseCommandProcess(state, request.commandProcess);
    }
    if (message.error && request.method === "process/spawn") {
      this.ctx.transparentProcessBridge.releaseHostProcess(state, request.hostProcess);
    }
    if (message.error && request.method === "turn/start" && typeof threadId === "string") {
      this.ctx.threadExecution.abortRequest(threadId, request.connection, request.clientId);
    }

    if (!message.error && request.method === "account/read") {
      const account = record(record(message.result)?.["account"]);
      this.ctx.userDirectory.setCodexAccount(
        state.ownerUserId,
        typeof account?.["type"] === "string"
          ? {
            type: account["type"],
            email: typeof account["email"] === "string" ? account["email"] : null,
            planType: typeof account["planType"] === "string" ? account["planType"] : null,
          }
          : null,
      );
    }
    if (!message.error && request.method === "account/logout") {
      this.ctx.userDirectory.setCodexAccount(state.ownerUserId, null);
    }

    if (!message.error && request.method === "turn/start" && typeof threadId === "string") {
      this.ctx.transparentThreadBinding.promoteBinding(threadId);
      const turnId = resultTurnId(message);
      if (turnId && request.authorityEpoch !== undefined) {
        state.turnEpochs.set(turnId, request.authorityEpoch);
      }
      this.ctx.threadExecution.bindTurn(
        threadId,
        request.connection,
        turnId,
        request.authorityEpoch,
      );
    }
    if (!message.error && request.method === "thread/archive" && typeof threadId === "string") {
      const archived = this.ctx.threadManager.archive(threadId);
      this.ctx.runtimeWorkspace.archive(archived);
      request.connection.threadWriteLease?.releaseThread?.(threadId);
      this.ctx.threadExecution.releaseThread(threadId, "threadArchived");
    }
    if (!message.error && request.method === "thread/unarchive" && typeof threadId === "string") {
      this.ctx.threadManager.unarchive(threadId);
    }
    if (!message.error && request.method === "thread/name/set" &&
        typeof threadId === "string" && typeof request.name === "string") {
      this.ctx.threadTitle.set(threadId, request.name, {
        actor: request.connection.identity,
        source: "user",
        attributeIfSame: true,
      });
    }

    const response = this.responseWithFallback(message, request);
    const responseWithId = withResponseId(response, request.clientId);
    const outward = request.method === "collaborationMode/list"
      ? responseWithId
      : this.toOuter(state, responseWithId);
    this.ctx.transparentBackendProjection.projectBackend(
      outward,
      state,
    );
    this.ctx.transparentBackendChannel.send(request.connection, outward);
    if (request.method === "turn/steer") {
      console.info(`[turn-steer] ${JSON.stringify({
        stage: "frontend-enqueued",
        outerThreadId: threadId,
        connectionId: request.connection.connectionId ?? null,
        sessionId: request.connection.sessionId ?? null,
        frontendRequestId: request.clientId ?? null,
        backendId: request.backendId ?? null,
        clientUserMessageId: request.clientUserMessageId ?? null,
        expectedTurnId: request.expectedTurnId ?? null,
        latencyMs: request.forwardedAtMs === undefined
          ? null
          : Math.max(0, Date.now() - request.forwardedAtMs),
      })}`);
    }

    if (!message.error && request.method === "thread/archive" && typeof threadId === "string") {
      this.ctx.transparentBackendChannel.broadcastCatalog("thread/archived", threadId);
      host.closeArchivedWorkspaceBackend(threadId, state);
    }
    if (!message.error && request.method === "thread/unarchive" && typeof threadId === "string") {
      this.ctx.transparentBackendChannel.broadcastCatalog("thread/unarchived", threadId);
    }
  }

  private responseWithFallback(
    message: JsonRpcResponse,
    request: TransparentForwardedRequest,
  ): JsonRpcResponse {
    if (request.method !== "collaborationMode/list" || !message.error) return message;
    const fallback = this.ctx.collaborationMode.fallbackFor(message.error);
    if (fallback === null) return message;
    const { error: _unsupportedError, ...responseWithoutError } = message;
    return { ...responseWithoutError, result: fallback };
  }

  private toOuter(
    state: TransparentBackendState,
    message: JsonRpcResponse,
  ): JsonRpcResponse {
    const filesystem = this.ctx.transparentRuntimeAccess.filesystem(state);
    return this.ctx.transparentProtocolMapper.toOuter(
      message,
      state,
      filesystem,
    ) as JsonRpcResponse;
  }
}
