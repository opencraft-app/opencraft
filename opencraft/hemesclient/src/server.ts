import type { ServerWebSocket } from "bun";
import { HermesAppServerAdapter } from "./adapter";
import { HermesGatewayError } from "./hermes-client";
import type { AppServerTurn, JsonRpcId, JsonRpcRequest } from "./types";

interface SocketData {
  initialized: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(frame: string): JsonRpcRequest | null {
  const value = JSON.parse(frame) as unknown;
  if (!isObject(value) || typeof value.method !== "string") throw new Error("invalid JSON-RPC request");
  if (!(typeof value.id === "string" || typeof value.id === "number")) return null;
  return {
    ...(value.jsonrpc === "2.0" ? { jsonrpc: "2.0" as const } : {}),
    id: value.id,
    method: value.method,
    ...(Object.hasOwn(value, "params") ? { params: value.params } : {}),
  };
}

function params(request: JsonRpcRequest): Record<string, unknown> {
  if (request.params === undefined) return {};
  if (!isObject(request.params)) throw new Error(`${request.method} params must be an object`);
  return request.params;
}

function sendResult(socket: ServerWebSocket<SocketData>, id: JsonRpcId, result: unknown): void {
  socket.send(JSON.stringify({ id, result }));
}

function sendError(socket: ServerWebSocket<SocketData>, id: JsonRpcId | null, code: number, message: string, data?: unknown): void {
  socket.send(JSON.stringify({ id, error: { code, message, ...(data === undefined ? {} : { data }) } }));
}

function slicePage<T>(items: T[], cursor: unknown, limit: unknown): { data: T[]; nextCursor: string | null } {
  const offset = typeof cursor === "string" && /^local:\d+$/u.test(cursor) ? Number(cursor.slice(6)) : 0;
  const size = typeof limit === "number" ? Math.min(Math.max(Math.floor(limit), 1), 200) : 50;
  return { data: items.slice(offset, offset + size), nextCursor: offset + size < items.length ? `local:${offset + size}` : null };
}

async function dispatch(adapter: HermesAppServerAdapter, request: JsonRpcRequest): Promise<unknown> {
  const value = params(request);
  switch (request.method) {
    case "initialize":
      return {
        codexHome: "/hermes",
        platformFamily: "unix",
        platformOs: "linux",
        userAgent: "hemesclient/0.1.0",
      };
    case "thread/list":
      return adapter.listThreads(value);
    case "thread/read": {
      const threadId = String(value.threadId ?? "");
      return { thread: await adapter.loadThread(threadId, value.includeTurns === true) };
    }
    case "thread/resume": {
      const threadId = String(value.threadId ?? "");
      const thread = await adapter.loadThread(threadId, value.excludeTurns !== true);
      return {
        thread,
        cwd: thread.cwd,
        model: "hermes",
        modelProvider: "hermes",
        serviceTier: null,
        reasoningEffort: null,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite", writableRoots: [thread.cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        instructionSources: [],
        runtimeWorkspaceRoots: [thread.cwd],
        turnsBackwardsCursor: null,
        itemsBackwardsCursor: null,
        ...(isObject(value.initialTurnsPage)
          ? { initialTurnsPage: { data: thread.turns.toReversed(), nextCursor: null, backwardsCursor: null } }
          : {}),
      };
    }
    case "thread/turns/list": {
      const thread = await adapter.loadThread(String(value.threadId ?? ""), true);
      const page = slicePage(value.sortDirection === "desc" ? thread.turns.toReversed() : thread.turns, value.cursor, value.limit);
      return { ...page, backwardsCursor: null, itemsPaginationByTurnId: {} };
    }
    case "thread/items/list": {
      const thread = await adapter.loadThread(String(value.threadId ?? ""), true);
      const turn = thread.turns.find((item) => item.id === value.turnId);
      if (turn === undefined) throw new Error(`Hermes turn not found: ${String(value.turnId)}`);
      const page = slicePage(value.sortDirection === "desc" ? turn.items.toReversed() : turn.items, value.cursor, value.limit);
      return page;
    }
    case "thread/start": {
      const thread = await adapter.startThread(typeof value.cwd === "string" ? value.cwd : null);
      return {
        thread,
        model: "hermes",
        modelProvider: "hermes",
        serviceTier: null,
        cwd: thread.cwd,
        runtimeWorkspaceRoots: [thread.cwd],
        instructionSources: [],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite", writableRoots: [thread.cwd], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        activePermissionProfile: null,
        reasoningEffort: null,
        multiAgentMode: "explicitRequestOnly",
      };
    }
    case "turn/start": {
      const turn = await adapter.startTurn(String(value.threadId ?? ""), value.input);
      return { turn };
    }
    case "turn/steer":
      return adapter.steerTurn(
        String(value.threadId ?? ""),
        typeof value.expectedTurnId === "string" ? value.expectedTurnId : null,
        value.input,
      );
    case "thread/queue/add": {
      const queuedSubmission = adapter.addQueuedSubmission(
        String(value.threadId ?? ""),
        value.input,
        String(value.clientUserMessageId ?? ""),
      );
      return { queuedSubmission };
    }
    case "thread/queue/list":
      return adapter.listQueuedSubmissions(
        String(value.threadId ?? ""),
        typeof value.cursor === "string" ? value.cursor : null,
        typeof value.limit === "number" ? value.limit : null,
      );
    case "thread/queue/update": {
      const queuedSubmission = adapter.updateQueuedSubmission(
        String(value.threadId ?? ""),
        String(value.queuedSubmissionId ?? ""),
        value.input,
      );
      return { queuedSubmission };
    }
    case "thread/queue/delete":
      return {
        deleted: adapter.deleteQueuedSubmission(
          String(value.threadId ?? ""),
          String(value.queuedSubmissionId ?? ""),
        ),
      };
    case "thread/queue/reorder":
      adapter.reorderQueuedSubmissions(
        String(value.threadId ?? ""),
        Array.isArray(value.queuedSubmissionIds) ? value.queuedSubmissionIds.map(String) : [],
      );
      return {};
    case "thread/queue/start": {
      const turn = await adapter.startQueuedSubmission(
        String(value.threadId ?? ""),
        typeof value.queuedSubmissionId === "string" ? value.queuedSubmissionId : null,
      );
      return { turn };
    }
    case "turn/interrupt":
      await adapter.cancelTurn(String(value.threadId ?? ""));
      return {};
    case "model/list":
      return { data: [], nextCursor: null };
    case "permissionProfile/list":
      return { data: [], nextCursor: null };
    case "skills/list":
      return { data: [] };
    case "project/list":
      return { data: [], nextCursor: null };
    default:
      throw Object.assign(new Error(`Method not supported by Hermes bridge: ${request.method}`), { rpcCode: -32601 });
  }
}

export interface StartServerOptions {
  hostname: string;
  port: number;
  adapter: HermesAppServerAdapter;
}

export function startServer(options: StartServerOptions) {
  const server = Bun.serve<SocketData>({
    hostname: options.hostname,
    port: options.port,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return Response.json({ ok: true, service: "hemesclient" });
      if (url.pathname !== "/rpc") return new Response("Not found", { status: 404 });
      if (!server.upgrade(request, { data: { initialized: false } })) {
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      return undefined;
    },
    websocket: {
      open(socket) { socket.subscribe("hermes-notifications"); },
      async message(socket, message) {
        try {
          const request = parseRequest(typeof message === "string" ? message : new TextDecoder().decode(message));
          if (request === null) return;
          const result = await dispatch(options.adapter, request);
          if (request.method === "initialize") socket.data.initialized = true;
          sendResult(socket, request.id, result);
        } catch (error) {
          const requestId = (() => {
            try {
              const parsed = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as { id?: unknown };
              return typeof parsed.id === "string" || typeof parsed.id === "number" ? parsed.id : null;
            } catch { return null; }
          })();
          const code = isObject(error) && typeof error.rpcCode === "number" ? error.rpcCode : error instanceof SyntaxError ? -32700 : -32000;
          const data = error instanceof HermesGatewayError ? { hermesCode: error.code, details: error.details } : undefined;
          sendError(socket, requestId, code, error instanceof Error ? error.message : String(error), data);
        }
      },
    },
  });
  options.adapter.subscribeNotification((method, params) => {
    server.publish("hermes-notifications", JSON.stringify({ jsonrpc: "2.0", method, params }));
  });
  return server;
}
