import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AppServerConnection,
  AppServerParams,
} from "../types/appserver.ts";
import type {
  AppServerHistoryThread,
  AppServerProjectionPort,
} from "../types/canonical-appserver-projection.ts";
import type {
  AppServerRegistrationPort,
  CanonicalParams,
  CanonicalTimelinePort,
} from "../types/canonical-timeline.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  ThreadLifecycleManagerPort,
  ThreadLifecycleThread,
  ThreadTombstoneLifecyclePort,
} from "../types/thread-lifecycle.ts";
import {
  threadMetadataUpdateResponse,
  threadStartedProjection,
  threadStartResponse,
} from "./thread-protocol.ts";

interface TombstoneReplayContext {
  threadTombstone: ThreadTombstoneLifecyclePort;
}

interface HistoryProjectionContext {
  appServer: AppServerRegistrationPort;
  appServerProjection: AppServerProjectionPort;
  canonicalTimeline: CanonicalTimelinePort;
  threadManager: ThreadLifecycleManagerPort;
}

function requiredString(params: CanonicalParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function appServerParams(params: CanonicalParams): AppServerParams {
  const result: AppServerParams = {};
  for (const [key, value] of Object.entries(params)) result[key] = value;
  return result;
}

function canonicalHistory(
  ctx: Pick<HistoryProjectionContext, "canonicalTimeline">,
  thread: ThreadLifecycleThread,
): AppServerHistoryThread {
  return {
    ...thread,
    turns: ctx.canonicalTimeline.turns(thread.id),
  };
}

export function replayArchivedTombstones(
  ctx: TombstoneReplayContext,
  connection: AppServerConnection,
): unknown {
  return ctx.threadTombstone.replay(connection);
}

export function registerThreadHistoryProjectionHandlers(
  ctx: HistoryProjectionContext,
): () => void {
  const register = (method: "thread/turns/list" | "thread/items/list") =>
    ctx.appServer.register(method, (params, connection) => {
      const threadId = requiredString(params, "threadId");
      connection.activeThreadId = threadId;
      const thread = ctx.threadManager.get(threadId);
      return ctx.appServerProjection.historyResult(
        method,
        canonicalHistory(ctx, thread),
        appServerParams(params),
      );
    });
  const disposeTurns = register("thread/turns/list");
  const disposeItems = register("thread/items/list");
  return () => {
    disposeItems();
    disposeTurns();
  };
}

type ThreadLifecycleContext = HypernodeContext<
  | "appServer"
  | "appServerProjection"
  | "canonicalTimeline"
  | "modelGateway"
  | "principal"
  | "projectCatalog"
  | "threadManager"
  | "threadProjectBinding"
  | "threadTombstone"
  | "threadWriteLease"
  | "workspaceView"
  >;

export class ThreadLifecycleService extends Service {
  static inject = [
    "appServer", "appServerProjection", "canonicalTimeline", "modelGateway",
    "principal", "projectCatalog", "threadManager", "threadProjectBinding",
    "threadTombstone", "threadWriteLease", "workspaceView",
  ] satisfies Inject<Pick<
    HypernodeServices,
    | "appServer"
    | "appServerProjection"
    | "canonicalTimeline"
    | "modelGateway"
    | "principal"
    | "projectCatalog"
    | "threadManager"
    | "threadProjectBinding"
    | "threadTombstone"
    | "threadWriteLease"
    | "workspaceView"
  >>;

  declare protected ctx: ThreadLifecycleContext;

  constructor(ctx: ThreadLifecycleContext) {
    super(ctx, "threadLifecycle");
    ctx.effect(() => ctx.appServer.register("thread/start", (rawParams, connection) => {
      const params = ctx.workspaceView.prepareStartParams(appServerParams(rawParams));
      const thread = ctx.threadManager.create(params, {}, {
        ownerPrincipalId: connection.identity?.id ?? ctx.principal.current().id,
        visibility: "private",
        kind: "conversation",
      });
      ctx.workspaceView.bindMain(thread);
      connection.activeThreadId = thread.id;
      ctx.threadProjectBinding.capture(thread, params, connection, { inferWhenNull: true });
      ctx.appServer.notifyAfter(connection, "thread/started", {
        thread: threadStartedProjection(thread),
      });
      return threadStartResponse(params, thread);
    }));
    ctx.effect(() => ctx.appServer.register("thread/resume", (rawParams, connection) => {
      const params = appServerParams(rawParams);
      const threadId = requiredString(rawParams, "threadId");
      const thread = ctx.threadManager.find(threadId);
      if (!thread) {
        ctx.appServer.broadcastNotification("thread/archived", { threadId });
        throw new Error(`thread not found: ${threadId}`);
      }
      thread.status = { type: "idle" };
      ctx.workspaceView.assertRestorable(thread.id);
      const cwd = params["cwd"];
      if (typeof cwd === "string" && cwd.length > 0) {
        thread.cwd = ctx.workspaceView.prepareResumeCwd(thread.id, cwd);
      }
      const modelProvider = params["modelProvider"];
      if (typeof modelProvider === "string" && modelProvider.length > 0) {
        thread["modelProvider"] = modelProvider;
      }
      ctx.threadProjectBinding.capture(thread, params, connection, { inferWhenNull: true });
      ctx.threadManager.changed(thread.id);
      connection.activeThreadId = thread.id;
      ctx.appServer.notifyAfter(connection, "thread/started", {
        thread: threadStartedProjection(thread),
      });
      return ctx.appServerProjection.historyResult(
        "thread/resume",
        canonicalHistory(ctx, thread),
        params,
        ctx.modelGateway.activeForConnection(connection),
      );
    }));
    ctx.effect(() => ctx.appServer.register("thread/read", (params, connection) => {
      const threadId = requiredString(params, "threadId");
      connection.activeThreadId = threadId;
      return ctx.appServerProjection.historyResult(
        "thread/read",
        canonicalHistory(ctx, ctx.threadManager.get(threadId)),
        appServerParams(params),
      );
    }));
    ctx.effect(() => registerThreadHistoryProjectionHandlers(ctx));
    ctx.effect(() => ctx.appServer.register("thread/metadata/update", (params, connection) => {
      const threadId = requiredString(params, "threadId");
      const thread = ctx.threadManager.get(threadId);
      if (Object.prototype.hasOwnProperty.call(params, "projectId")) {
        const value = params["projectId"];
        const projectId = typeof value === "string" && value.length > 0 ? value : null;
        if (projectId) ctx.projectCatalog.ensureExternal(projectId, thread.cwd, connection);
        ctx.threadProjectBinding.assign(thread.id, projectId, connection);
      }
      if (Object.prototype.hasOwnProperty.call(params, "gitInfo")) {
        thread["gitInfo"] = params["gitInfo"];
      }
      ctx.threadManager.changed(thread.id);
      return threadMetadataUpdateResponse(thread);
    }));
    ctx.effect(() => ctx.appServer.register("thread/archive", (params, connection) => {
      const threadId = requiredString(params, "threadId");
      if (ctx.threadManager.isSystem(threadId)) throw new Error("system threads cannot be archived");
      const existing = ctx.threadManager.find(threadId);
      if (!existing || ctx.threadManager.isArchived(threadId)) {
        ctx.threadTombstone.record(threadId);
        ctx.appServer.notifyAllAfter(connection, "thread/archived", { threadId });
        return {};
      }
      const thread = ctx.threadManager.archive(threadId);
      ctx.threadWriteLease.releaseThread(thread.id);
      ctx.workspaceView.archive(thread);
      ctx.appServer.notifyAllAfter(connection, "thread/archived", { threadId: thread.id });
      return {};
    }));
    ctx.effect(() => ctx.appServer.register("thread/unarchive", (params, connection) => {
      const threadId = requiredString(params, "threadId");
      ctx.workspaceView.assertRestorable(threadId);
      const thread = ctx.threadManager.unarchive(threadId);
      ctx.appServer.notifyAllAfter(connection, "thread/unarchived", { threadId: thread.id });
      return { thread };
    }));
  }
}
