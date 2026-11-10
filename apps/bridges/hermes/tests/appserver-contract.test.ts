import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { HermesAppServerAdapter } from "../src/adapter";
import { HermesGatewayClient } from "../src/hermes-client";
import { startServer } from "../src/server";

/**
 * P9 compatibility recording for the pre-existing Hermes AppServer bridge.
 *
 * The scenario deliberately uses only the wire methods and payload shapes that
 * existed before the agent-bridge work. The file next to this test is the
 * baseline consumed by `tests/agent-bridge/hermes-compat.test.ts`, where the
 * current client executes the same read/send-receipt paths against it.
 *
 * Regenerate only for an intentional contract change:
 *   UPDATE_HERMES_CONTRACT=1 bun test tests/appserver-contract.test.ts
 */

interface RpcResponse {
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
interface RpcNotification { method: string; params: unknown }
interface ContractCase {
  id: string;
  method: string;
  request: unknown;
  response: { result?: unknown; error?: RpcResponse["error"] };
  notifications?: RpcNotification[];
}
interface ContractFile {
  schemaVersion: 1;
  bridge: string;
  scenario: string;
  cases: ContractCase[];
}

const CONTRACT_PATH = new URL("./fixtures/hermes-appserver-contract.json", import.meta.url);
const CONTRACT_FILE = fileURLToPath(CONTRACT_PATH);
const NOW_THRESHOLD = 1_700_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PREFIXED_UUID = /^(hermes-(?:turn|user|agent|tool|queue)-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
const TIME_KEYS = new Set(["createdAt", "updatedAt", "recencyAt", "startedAt", "completedAt", "startedAtMs", "completedAtMs"]);

/** Stable placeholders make the recording independent of wall-clock time and UUIDs. */
function createNormalizer() {
  const ids = new Map<string, string>();
  const counters = new Map<string, number>();
  const placeholder = (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `<${prefix}-${next}>`;
  };
  const mapId = (value: string): string => {
    const existing = ids.get(value);
    if (existing !== undefined) return existing;
    const prefixed = PREFIXED_UUID.exec(value);
    const mapped = placeholder(prefixed?.[1]?.replace(/^hermes-|-$/gu, "") ?? "uuid");
    ids.set(value, mapped);
    return mapped;
  };
  const replaceKnownIds = (value: string): string => {
    let result = value;
    for (const [actual, alias] of ids) result = result.split(actual).join(alias);
    return result;
  };
  const normalize = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (UUID.test(value) || PREFIXED_UUID.test(value)) return mapId(value);
      return replaceKnownIds(value);
    }
    if (Array.isArray(value)) return value.map((entry) => normalize(entry));
    if (typeof value === "object" && value !== null) {
      const row = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [field, entry] of Object.entries(row)) {
        if (TIME_KEYS.has(field) && typeof entry === "number" && entry > NOW_THRESHOLD) {
          result[field] = field.endsWith("Ms") ? "<time-ms>" : "<time-s>";
        } else if (field === "durationMs" && typeof entry === "number") {
          result[field] = "<duration-ms>";
        } else {
          result[field] = normalize(entry);
        }
      }
      return result;
    }
    return value;
  };
  return { normalize };
}

interface Capture {
  cases: ContractCase[];
  notifications: RpcNotification[];
}

async function waitForNotification(method: string, from: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (capture.notifications.slice(from).some((item) => item.method === method)) return;
    await Bun.sleep(1);
  }
  throw new Error(`Timed out waiting for ${method}`);
}

const capture: Capture = { cases: [], notifications: [] };
// One normalizer for the whole scenario keeps cross-case references stable.
const contractNormalizer = createNormalizer();
let gateway: ReturnType<typeof Bun.serve>;
let bridge: ReturnType<typeof startServer>;
let socket: WebSocket;
let gatewaySocket: { send(frame: string): void } | null = null;
const pending = new Map<string | number, (value: RpcResponse) => void>();

function emit(live: string, type: string, payload: Record<string, unknown> = {}): void {
  gatewaySocket?.send(JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: { type, session_id: live, payload },
  }));
}

function completeLive(live: string, status: "complete" | "interrupted"): void {
  emit(live, "message.complete", { text: status === "interrupted" ? "held" : "pong", status });
}

function fakeSessionList() {
  return {
    sessions: [
      { id: "session-alpha", title: "Alpha session", preview: "hello", started_at: 1_600_000_000, message_count: 3, source: "desktop" },
      { id: "session-new", title: "New chat", preview: "", started_at: 1_600_000_100, message_count: 0, source: "desktop" },
      { id: "session-steer", title: "Steer session", preview: "hold", started_at: 1_600_000_200, message_count: 0, source: "desktop" },
      { id: "session-queue", title: "Queue session", preview: "", started_at: 1_600_000_300, message_count: 0, source: "desktop" },
      { id: "session-error", title: "Error session", preview: "fail", started_at: 1_600_000_400, message_count: 0, source: "desktop" },
    ],
  };
}

function fakeResume(stored: string) {
  const map: Record<string, { live: string; cwd: string }> = {
    "session-alpha": { live: "live-alpha", cwd: "/workspace/project" },
    "session-new": { live: "live-new", cwd: "/workspace/project" },
    "session-steer": { live: "live-steer", cwd: "/workspace/project" },
    "session-queue": { live: "live-queue", cwd: "/workspace/project" },
    "session-error": { live: "live-error", cwd: "/workspace/project" },
  };
  const entry = map[stored] ?? { live: `live-${stored}`, cwd: "/workspace" };
  return {
    session_id: entry.live,
    stored_session_id: stored,
    message_count: stored === "session-alpha" ? 3 : 0,
    messages: [],
    info: { cwd: entry.cwd },
  };
}

function rpc(method: string, params: unknown = {}): Promise<RpcResponse> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function recorded(
  id: string,
  method: string,
  params: unknown,
  terminalNotification?: string,
): Promise<RpcResponse> {
  const from = capture.notifications.length;
  const raw = await rpc(method, params);
  if (terminalNotification !== undefined) await waitForNotification(terminalNotification, from);
  // Synchronous bridge side effects (queue changed, error frames) are ordered
  // before the response but delivered on the socket after this task yields.
  await Bun.sleep(5);
  const normalizedNotifications = contractNormalizer.normalize(capture.notifications.slice(from)) as RpcNotification[];
  const request = contractNormalizer.normalize(params);
  capture.cases.push({
    id,
    method,
    request,
    response: raw.error === undefined ? { result: contractNormalizer.normalize(raw.result) } : { error: contractNormalizer.normalize(raw.error) as RpcResponse["error"] },
    ...(normalizedNotifications.length === 0 ? {} : { notifications: normalizedNotifications }),
  });
  return raw;
}

describe("pre-P9 Hermes AppServer contract recording", () => {
  beforeAll(async () => {
    gateway = Bun.serve<{ ok: boolean }>({
      port: 0,
      fetch(request, server) {
        if (new URL(request.url).pathname === "/api/ws" && server.upgrade(request, { data: { ok: true } })) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          gatewaySocket = ws;
          ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } }));
        },
        message(ws, frame) {
          const request = JSON.parse(String(frame)) as { id: number; method: string; params?: Record<string, unknown> };
          const params = request.params ?? {};
          let result: unknown = { status: "streaming" };
          if (request.method === "session.list") result = fakeSessionList();
          else if (request.method === "session.resume") result = fakeResume(String(params.session_id ?? ""));
          else if (request.method === "session.history") {
            const live = String(params.session_id ?? "");
            result = live === "live-alpha"
              ? {
                  count: 3,
                  messages: [
                    { role: "user", text: "hello", row_id: 1 },
                    { role: "assistant", text: "world", row_id: 2 },
                    { role: "tool", name: "terminal", args: { command: "pwd" }, context: "/workspace/project", row_id: 3 },
                  ],
                }
              : { count: 0, messages: [] };
          } else if (request.method === "session.create") {
            result = { session_id: "live-new", stored_session_id: "session-new", message_count: 0, messages: [], info: { cwd: "/workspace/project" } };
          } else if (request.method === "prompt.submit") {
            const live = String(params.session_id ?? "");
            if (live === "live-error") {
              ws.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: "disconnected", message: "Hermes WebSocket disconnected" } }));
              return;
            }
            setTimeout(() => {
              emit(live, "message.start");
              if (live === "live-new" || live === "live-alpha") {
                emit(live, "message.delta", { text: "pong" });
                emit(live, "tool.start", { tool_id: "tool-1", name: "terminal", args: { command: "pwd" } });
                emit(live, "tool.complete", { tool_id: "tool-1", name: "terminal", args: { command: "pwd" }, result: "/workspace/project", duration_s: 0.125 });
                emit(live, "message.complete", { text: "pong", status: "complete" });
              }
            }, 2);
          } else if (request.method === "session.steer") result = { status: "accepted" };
          else if (request.method === "session.interrupt") result = { status: "interrupted" };
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        },
      },
    });
    const client = new HermesGatewayClient({
      baseUrl: `http://127.0.0.1:${gateway.port}`,
      token: "p9-contract",
      timeoutMs: 2_000,
    });
    bridge = startServer({
      hostname: "127.0.0.1",
      port: 0,
      adapter: new HermesAppServerAdapter(client, "/workspace"),
    });
    socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/rpc`);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as RpcResponse & { method?: string; params?: unknown };
      if (typeof message.method === "string") {
        capture.notifications.push({ method: message.method, params: message.params });
        return;
      }
      const id = message.id;
      if (id === null || id === undefined) return;
      pending.get(id)?.(message);
      pending.delete(id);
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("hermes bridge websocket failed")), { once: true });
    });
  });

  afterAll(() => { socket.close(); bridge.stop(true); gateway.stop(true); });

  test("records and then matches the legacy AppServer read/send contract", async () => {
    await recorded("initialize", "initialize", {
      clientInfo: { name: "p9-hermes-contract", version: "1" },
      capabilities: { experimentalApi: true },
    });
    await recorded("thread-list", "thread/list", { limit: 20 });
    await recorded("thread-read-metadata", "thread/read", { threadId: "session-alpha", includeTurns: false });
    await recorded("thread-turns-list", "thread/turns/list", {
      threadId: "session-alpha", limit: 10, itemsView: "full", sortDirection: "desc",
    });
    await recorded("thread-read-full", "thread/read", { threadId: "session-alpha", includeTurns: true });
    await recorded("thread-resume", "thread/resume", { threadId: "session-alpha", excludeTurns: true });
    await recorded("thread-items-list", "thread/items/list", {
      threadId: "session-alpha", turnId: "hermes-turn-session-alpha-1", limit: 10,
    });
    await recorded("thread-start", "thread/start", { cwd: "/workspace/project" });
    await recorded("turn-start-existing", "turn/start", {
      threadId: "session-alpha", input: [{ type: "text", text: "ping" }],
    }, "turn/completed");
    await recorded("turn-start-new", "turn/start", {
      threadId: "session-new", input: [{ type: "text", text: "ping" }],
    }, "turn/completed");
    const steerTurn = await recorded("turn-start-steer", "turn/start", {
      threadId: "session-steer", input: [{ type: "text", text: "hold" }],
    }, "turn/started");
    const activeTurnId = (steerTurn.result as { turn: { id: string } }).turn.id;
    await recorded("turn-steer", "turn/steer", {
      threadId: "session-steer", expectedTurnId: activeTurnId, input: [{ type: "text", text: "steer text" }],
    });
    await recorded("turn-steer-stale", "turn/steer", {
      threadId: "session-steer", expectedTurnId: "hermes-turn-stale", input: [{ type: "text", text: "stale" }],
    });
    await recorded("turn-interrupt", "turn/interrupt", { threadId: "session-steer" });
    await recorded("turn-start-gateway-error", "turn/start", {
      threadId: "session-error", input: [{ type: "text", text: "fail" }],
    });
    {
      const from = capture.notifications.length;
      completeLive("live-steer", "interrupted");
      await waitForNotification("turn/completed", from);
      capture.cases.push({
        id: "turn-interrupted-completion",
        method: "event",
        request: null,
        response: {},
        notifications: contractNormalizer.normalize(capture.notifications.slice(from)) as RpcNotification[],
      });
    }
    const first = await recorded("thread-queue-add", "thread/queue/add", {
      threadId: "session-queue", input: [{ type: "text", text: "first" }], clientUserMessageId: "client-first",
    }, "thread/queue/changed");
    const second = await recorded("thread-queue-add-second", "thread/queue/add", {
      threadId: "session-queue", input: [{ type: "text", text: "second" }], clientUserMessageId: "client-second",
    }, "thread/queue/changed");
    const firstId = (first.result as { queuedSubmission: { id: string } }).queuedSubmission.id;
    const secondId = (second.result as { queuedSubmission: { id: string } }).queuedSubmission.id;
    await recorded("thread-queue-list", "thread/queue/list", { threadId: "session-queue" });
    await recorded("thread-queue-update", "thread/queue/update", {
      threadId: "session-queue", queuedSubmissionId: firstId, input: [{ type: "text", text: "updated" }],
    }, "thread/queue/changed");
    await recorded("thread-queue-reorder", "thread/queue/reorder", {
      threadId: "session-queue", queuedSubmissionIds: [secondId, firstId],
    }, "thread/queue/changed");
    await recorded("thread-queue-delete", "thread/queue/delete", {
      threadId: "session-queue", queuedSubmissionId: secondId,
    }, "thread/queue/changed");
    await recorded("unsupported-method", "thread/fork", { threadId: "session-alpha", lastTurnId: "turn-1" });

    const expected: ContractFile = {
      schemaVersion: 1,
      bridge: "hemesclient/0.2.0 AppServer wire",
      scenario: "Hermes AppServer read, send receipt, history, steer and interrupt paths",
      cases: capture.cases,
    };
    if (process.env.UPDATE_HERMES_CONTRACT === "1") {
      writeFileSync(CONTRACT_PATH, `${JSON.stringify(expected, null, 2)}\n`);
      return;
    }
    expect(JSON.parse(readFileSync(CONTRACT_FILE, "utf8"))).toEqual(expected);
  });
});
