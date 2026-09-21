import { Service, type Context } from "@deepseek-ai/cordis";
import type {
  AppServerConnection,
  JsonRpcRequest,
} from "../types/appserver.ts";
import type {
  TransparentRequestRoute,
  TransparentRequestRouterPort,
  TransparentThreadOperation,
} from "../types/transparent-request.ts";
import { USER_BACKEND_CONTROL_METHODS } from "./transparent-thread-routing.ts";

const OUTER_CATALOG_METHODS = new Set([
  "hypernode/threadWriteLease/acquire",
  "hypernode/threadWriteLease/heartbeat",
  "hypernode/threadWriteLease/read",
  "hypernode/threadWriteLease/release",
  "thread/metadata/update",
  "thread/section/move",
  "thread/goal/get",
  "thread/goal/set",
  "thread/goal/clear",
]);

const HISTORY_METHODS = new Set([
  "thread/read",
  "thread/resume",
  "thread/turns/list",
  "thread/items/list",
]);

// These methods may carry a threadId only as UI/tool-call context. They are
// implemented by the host policy and must never be interpreted as operations
// on the thread's Codex execution runtime. Desktop includes threadId and
// connectorId when it mounts an MCP App resource, unlike the minimal protocol
// probes that originally exercised these handlers.
const LOCAL_CAPABILITY_METHODS = new Set([
  "mcpServerStatus/list",
  "mcpServer/resource/read",
  "mcpServer/tool/call",
]);

const THREAD_OPERATIONS: Readonly<Record<string, TransparentThreadOperation>> = {
  "thread/settings/update": "settings",
  "thread/unsubscribe": "unsubscribe",
  "thread/archive": "archive",
  "thread/unarchive": "unarchive",
  "thread/fork": "fork",
  "turn/start": "turnStart",
  "turn/steer": "turnSteer",
  "turn/interrupt": "turnInterrupt",
  "thread/queue/add": "queue",
  "thread/queue/list": "queue",
  "thread/queue/update": "queue",
  "thread/queue/delete": "queue",
  "thread/queue/reorder": "queue",
  "thread/queue/start": "queue",
};

/**
 * Pure protocol classification for the transparent AppServer boundary.
 *
 * This service deliberately does not inspect Thread state, credentials, or a
 * Workspace. Those are execution-policy decisions owned by downstream ports.
 */
export class TransparentRequestRouterService extends Service
  implements TransparentRequestRouterPort {
  constructor(ctx: Context) {
    super(ctx, "transparentRequestRouter");
  }

  classify(
    message: JsonRpcRequest | null,
    connection: AppServerConnection,
  ): TransparentRequestRoute {
    if (message == null) return { kind: "poll" };
    if (message.id !== undefined && message.method != null &&
        OUTER_CATALOG_METHODS.has(message.method)) {
      return { kind: "pass", reason: "outerCatalog" };
    }
    if (message.method == null && message.id !== undefined) {
      return { kind: "backendServerResponse", message };
    }
    if (message.id === undefined || !message.method) {
      return { kind: "pass", reason: "notification" };
    }
    if (LOCAL_CAPABILITY_METHODS.has(message.method)) {
      return { kind: "pass", reason: "localCapability" };
    }
    if (message.method === "model/list") return { kind: "modelList", message };
    if (USER_BACKEND_CONTROL_METHODS.has(message.method) && connection.identity?.id) {
      return { kind: "userBackendControl", message };
    }
    if (message.method === "thread/start") {
      const cwd = message.params?.["cwd"];
      return {
        kind: "threadStartCandidate",
        message,
        cwd: typeof cwd === "string" ? cwd : null,
      };
    }
    const threadId = message.params?.["threadId"];
    if (typeof threadId !== "string") {
      return { kind: "pass", reason: "missingThreadId" };
    }
    const operation = HISTORY_METHODS.has(message.method)
      ? "history"
      : (THREAD_OPERATIONS[message.method] ?? "forward");
    return { kind: "thread", message, threadId, operation };
  }
}
