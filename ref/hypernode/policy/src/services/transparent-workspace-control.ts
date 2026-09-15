import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  TransparentWorkspaceControlPort,
  TransparentWorkspaceControlRequest,
  TransparentWorkspaceDecision,
} from "../types/transparent-workspace-control.ts";

/**
 * Owns outer Thread subscription and Workspace lifecycle decisions.
 *
 * Engine runtimes are consumers of a Workspace attachment. They must never
 * become the authority for archive, fork, destroyed-view, or unsubscribe
 * semantics merely because an AppServer request happens to pass through them.
 */
export class TransparentWorkspaceControlService extends Service
  implements TransparentWorkspaceControlPort {
  static inject = [
    "executionEngine",
    "runtimeWorkspace",
    "threadExecution",
    "threadManager",
    "threadTombstone",
    "threadWriteLease",
    "transparentBackendChannel",
    "transparentRuntimeRetirement",
    "transparentThreadBinding",
    "transparentThreadFork",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentWorkspaceControl");
  }

  handle(request: TransparentWorkspaceControlRequest): TransparentWorkspaceDecision {
    const { connection, message, threadId, operation } = request;
    const workspace = this.ctx.runtimeWorkspace.recordFor(threadId);

    if (operation === "turnStart") {
      if (workspace?.state === "destroyed" || workspace?.deleted === true) {
        try {
        this.ctx.runtimeWorkspace.assertRuntimeAvailable(threadId);
      } catch (error) {
          this.ctx.transparentBackendChannel.send(connection, withRequestId(message.id, {
            error: rpcError(error, -32071),
          }));
          this.ctx.threadExecution.abortRequest(threadId, connection, message.id);
          return "handled";
        }
      }
      this.ctx.transparentBackendChannel.subscribe(connection, threadId);
    }

    if (operation === "unsubscribe") {
      const removed = this.ctx.transparentBackendChannel.unsubscribe(connection, threadId);
      if (connection.activeThreadId === threadId) connection.activeThreadId = null;
      this.ctx.transparentBackendChannel.send(connection, withRequestId(message.id, {
        result: { status: removed ? "unsubscribed" : "notSubscribed" },
      }));
      this.ctx.transparentRuntimeRetirement.retireThreadRuntimeIfIdle(threadId);
      return "handled";
    }

    if (operation === "archive" && this.ctx.threadManager.isArchived(threadId)) {
      this.ctx.threadTombstone.record(threadId);
      this.ctx.transparentBackendChannel.send(connection, withRequestId(message.id, { result: {} }));
      this.ctx.transparentBackendChannel.broadcastCatalog("thread/archived", threadId);
      this.ctx.transparentRuntimeRetirement.closeArchivedWorkspaceBackend(threadId, null);
      return "handled";
    }

    if (operation === "fork" && this.ctx.runtimeWorkspace.enabled && workspace != null) {
      try {
        this.ctx.transparentThreadFork.start({ connection, message });
      } catch (error) {
        this.ctx.transparentBackendChannel.send(connection, withRequestId(message.id, {
          error: rpcError(error, -32050),
        }));
      }
      return "handled";
    }

    if (operation === "archive" && this.ctx.runtimeWorkspace.enabled && workspace != null) {
      const archived = this.ctx.threadManager.archive(threadId);
      this.ctx.runtimeWorkspace.archive(archived);
      this.ctx.threadWriteLease.releaseThread(threadId);
      this.ctx.threadExecution.releaseThread(threadId, "threadArchived");
      this.ctx.transparentBackendChannel.send(connection, withRequestId(message.id, { result: {} }));
      this.ctx.transparentBackendChannel.broadcastCatalog("thread/archived", threadId);
      this.ctx.transparentRuntimeRetirement.closeArchivedWorkspaceBackend(threadId, null);
      return "handled";
    }

    if ((operation === "archive" || operation === "unarchive") &&
        (this.ctx.threadManager.isSystem(threadId) ||
          !this.ctx.transparentThreadBinding.bindings.has(threadId))) {
      if (operation === "archive") this.ctx.executionEngine.retireThread(threadId);
      return "pass";
    }

    return "continue";
  }
}

type Dependencies =
  | "executionEngine"
  | "runtimeWorkspace"
  | "threadExecution"
  | "threadManager"
  | "threadTombstone"
  | "threadWriteLease"
  | "transparentBackendChannel"
  | "transparentRuntimeRetirement"
  | "transparentThreadBinding"
  | "transparentThreadFork";

function rpcError(error: unknown, fallbackCode: number) {
  if (typeof error !== "object" || error == null) {
    return { code: fallbackCode, message: String(error) };
  }
  const code: unknown = Reflect.get(error, "code");
  const message: unknown = Reflect.get(error, "message");
  const data: unknown = Reflect.get(error, "data");
  return {
    code: typeof code === "number" && Number.isInteger(code) ? code : fallbackCode,
    message: typeof message === "string" ? message : String(error),
    ...(data === undefined ? {} : { data }),
  };
}

function withRequestId(
  id: TransparentWorkspaceControlRequest["message"]["id"],
  payload: { result?: unknown; error?: { code: number; message: string; data?: unknown } },
) {
  return id === undefined ? payload : { id, ...payload };
}
