import { Service, type Inject } from "@deepseek-ai/cordis";
import type { JsonRpcResponse } from "../types/appserver.ts";
import type { TransparentBackendState } from "../types/transparent-backend.ts";
import type { CanonicalParams } from "../types/canonical-timeline.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  TransparentBackendOutboundPort,
} from "../types/transparent-backend-outbound.ts";

type Dependencies =
  | "appServerProjection"
  | "transparentBackendChannel"
  | "transparentBackendIngress"
  | "transparentBackendProjection"
  | "transparentBackendRpc"
  | "transparentProtocolMapper"
  | "transparentRuntimeAccess"
  | "transparentRuntimeLocator"
  | "transparentThreadBinding";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requestThreadId(message: JsonRpcResponse): string | null {
  const params = record(message.params);
  const thread = record(params?.["thread"]);
  const value = thread?.["id"] ?? params?.["threadId"];
  return typeof value === "string" ? value : null;
}

/**
 * Projects native Runtime server requests and notifications across the stable
 * outer namespace.  This is the sole live AppServer egress boundary for
 * an already-correlated backend message.
 */
export class TransparentBackendOutboundService extends Service
  implements TransparentBackendOutboundPort {
  static inject = [
    "appServerProjection",
    "transparentBackendChannel",
    "transparentBackendIngress",
    "transparentBackendProjection",
    "transparentBackendRpc",
    "transparentProtocolMapper",
    "transparentRuntimeAccess",
    "transparentRuntimeLocator",
    "transparentThreadBinding",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentBackendOutbound");
  }

  handleServerRequest(
    state: TransparentBackendState,
    message: JsonRpcResponse,
  ): void {
    if (this.isStaleAuthority(state, message) || message.id === undefined) return;
    const innerThreadId = requestThreadId(message);
    const outerThreadId = innerThreadId
      ? this.ctx.transparentProtocolMapper.outerThreadId(innerThreadId, state)
      : null;
    const target = outerThreadId
      ? this.ctx.transparentRuntimeLocator.ownerConnection(state, outerThreadId)
      : null;
    const connection = target ?? state.connections.values().next().value ?? null;
    if (!connection) return;

    const publicId = this.ctx.transparentBackendChannel.nextServerRequestId();
    this.ctx.transparentBackendRpc.trackServerRequest(
      state,
      publicId,
      { innerId: message.id, connection },
    );
    this.ctx.transparentBackendChannel.send(
      connection,
      this.toOuter(state, { ...message, id: publicId }),
    );
  }

  handleNotification(
    state: TransparentBackendState,
    message: JsonRpcResponse,
  ): void {
    if (typeof message.method !== "string") return;
    const innerThreadId = this.ctx.transparentBackendIngress.backendThreadId(message);
    if (innerThreadId && this.ctx.transparentThreadBinding.reverseBindings.has(innerThreadId) &&
        !this.ctx.transparentProtocolMapper.outerThreadId(innerThreadId, state)) {
      console.info(
        `[transparent-codex] fenced stale notification backend=${state.backendKey} ` +
        `thread=${innerThreadId}`,
      );
      return;
    }
    if (this.isStaleAuthority(state, message)) return;

    const outward = this.toOuter(state, message);
    const method = outward.method ?? message.method;
    const projected = this.ctx.appServerProjection.prepare(
      method,
      canonicalParams(outward.params),
      { engine: "codex", kind: "execution" },
    );
    // The canonical fact is committed by prepareNotification before the
    // rebuildable AppServer read model observes the notification.
    this.ctx.transparentBackendProjection.projectBackend(
      projected,
      state,
    );
    if (method === "thread/archived" || method === "thread/unarchived") {
      const threadId = record(projected.params)?.["threadId"];
      if (typeof threadId === "string") {
        this.ctx.transparentBackendChannel.broadcastCatalog(method, threadId, projected);
      }
      return;
    }
    this.ctx.transparentBackendChannel.broadcast(state, projected);
  }

  private isStaleAuthority(
    state: TransparentBackendState,
    message: JsonRpcResponse,
  ): boolean {
    return this.ctx.transparentBackendChannel.isStaleAuthorityMessage(state, message, {
      hasBinding: (innerThreadId) =>
        this.ctx.transparentThreadBinding.reverseBindings.has(innerThreadId),
      outerThreadId: (innerThreadId) =>
        this.ctx.transparentProtocolMapper.outerThreadId(innerThreadId, state),
      replay: () => {},
    });
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

function canonicalParams(value: unknown): CanonicalParams {
  return record(value) ?? {};
}
