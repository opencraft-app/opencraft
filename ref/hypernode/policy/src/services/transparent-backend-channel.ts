import { Service, type Inject } from "@deepseek-ai/cordis";
import type { AppServerConnection, JsonRpcResponse } from "../types/appserver.ts";
import type { TransparentBackendState } from "../types/transparent-backend.ts";
import type {
  TransparentBackendChannelHost,
  TransparentBackendChannelPort,
} from "../types/transparent-backend-channel.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";

const INTERNAL_PREFIX = "hypernode:transparent:";

type Dependencies =
  | "appServer"
  | "threadExecution"
  | "transparentBackendIngress"
  | "transparentSubscription";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function notificationThreadId(message: JsonRpcResponse): string | null {
  const params = record(message.params);
  const thread = record(params?.["thread"]);
  const value = thread?.["id"] ?? params?.["threadId"];
  return typeof value === "string" ? value : null;
}

/**
 * Owns the live backend channel after native messages enter the policy VM.
 *
 * Runtime authority fencing, pre-binding replay and frontend fanout are one
 * ordered boundary. Durable execution facts and AppServer read models remain
 * owned by their respective services.
 */
export class TransparentBackendChannelService extends Service
  implements TransparentBackendChannelPort {
  static inject = [
    "appServer",
    "threadExecution",
    "transparentBackendIngress",
    "transparentSubscription",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private sequence = 0;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentBackendChannel");
  }

  nextServerRequestId(): string {
    this.sequence += 1;
    return `${INTERNAL_PREFIX}server:${this.sequence}`;
  }

  isStaleAuthorityMessage(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    host: TransparentBackendChannelHost,
  ): boolean {
    const table = this.ctx.threadExecution.table;
    return this.ctx.transparentBackendIngress.isStaleAuthorityMessage(state, message, {
      outerThreadId: host.outerThreadId,
      activeExecution: (outerThreadId) => table.get(outerThreadId) ?? null,
      runtimeAuthority: (outerThreadId) => table.runtimeAuthority(outerThreadId),
      latestEpoch: (outerThreadId) => table.latestEpoch(outerThreadId),
    });
  }

  deferUntilThreadBinding(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    host: TransparentBackendChannelHost,
  ): boolean {
    return this.ctx.transparentBackendIngress.deferUntilThreadBinding(
      state,
      message,
      host.hasBinding,
    );
  }

  flushThreadMessages(
    state: TransparentBackendState,
    innerThreadId: string,
    host: TransparentBackendChannelHost,
  ): void {
    const pending = this.ctx.transparentBackendIngress.takeDeferredThreadMessages(
      state,
      innerThreadId,
    );
    for (const message of pending) host.replay(state, message);
  }

  discardUnmatchedThreadMessages(state: TransparentBackendState): boolean {
    return this.ctx.transparentBackendIngress.discardUnmatchedThreadMessages(state);
  }

  send(
    connection: AppServerConnection,
    message: JsonRpcResponse,
    sensitive = false,
  ): void {
    this.ctx.appServer.send(connection, message, sensitive);
  }

  broadcast(state: TransparentBackendState, message: JsonRpcResponse): void {
    const targets = this.ctx.transparentSubscription.targets(
      state,
      notificationThreadId(message),
    );
    for (const connection of targets) this.send(connection, message);
  }

  subscribe(connection: AppServerConnection, outerThreadId: string): void {
    this.ctx.transparentSubscription.subscribe(connection, outerThreadId);
  }

  unsubscribe(connection: AppServerConnection, outerThreadId: string): boolean {
    return this.ctx.transparentSubscription.unsubscribe(connection, outerThreadId);
  }

  removeConnection(connection: AppServerConnection): string[] {
    return this.ctx.transparentSubscription.removeConnection(connection);
  }

  broadcastCatalog(
    method: string,
    threadId: string,
    message: JsonRpcResponse | null = null,
    now = Date.now(),
  ): boolean {
    if (!this.ctx.transparentSubscription.admitCatalogBroadcast(method, threadId, now)) {
      return false;
    }
    this.ctx.appServer.broadcastNotification(
      method,
      message?.params ?? { threadId },
    );
    return true;
  }
}
