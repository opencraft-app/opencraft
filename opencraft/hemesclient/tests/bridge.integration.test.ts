import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HermesAppServerAdapter } from "../src/adapter";
import { HermesGatewayClient } from "../src/hermes-client";
import { startServer } from "../src/server";

interface RpcResponse { id: string; result?: unknown; error?: { code: number; message: string } }

describe("bridge over the real Hermes JSON-RPC wire shape", () => {
  let gateway: ReturnType<typeof Bun.serve>;
  let bridge: ReturnType<typeof startServer>;
  let socket: WebSocket;
  const pending = new Map<string, (value: RpcResponse) => void>();
  const notifications: Array<{ method: string; params: unknown }> = [];
  const gatewayCalls: Array<{ method: string; params: Record<string, unknown> }> = [];

  beforeAll(async () => {
    gateway = Bun.serve<{ ok: boolean }>({
      port: 0,
      fetch(request, server) {
        if (new URL(request.url).pathname === "/api/ws" && server.upgrade(request, { data: { ok: true } })) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) { ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: {} } })); },
        message(ws, frame) {
          const req = JSON.parse(String(frame)) as { id: number; method: string; params?: Record<string, unknown> };
          gatewayCalls.push({ method: req.method, params: req.params ?? {} });
          let result: unknown;
          if (req.method === "session.list") result = { sessions: [{ id: "session-1", title: "Gateway session", preview: "hello", started_at: 1_000, message_count: 2, source: "desktop" }] };
          else if (req.method === "session.resume") result = { session_id: "live-1", stored_session_id: "session-1", message_count: 2, messages: [], info: { cwd: "/repo" } };
          else if (req.method === "session.history") result = { count: 2, messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "world" }] };
          else if (req.method === "image.attach_bytes") result = { attached: true, path: "/tmp/gateway-upload.png", count: 1 };
          else if (req.method === "prompt.submit") {
            result = { status: "streaming" };
            setTimeout(() => {
              for (const params of [
                { type: "message.start", session_id: "live-1" },
                { type: "message.delta", session_id: "live-1", payload: { text: "pong" } },
                { type: "message.complete", session_id: "live-1", payload: { text: "pong", status: "complete" } },
              ]) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params }));
            }, 5);
          }
          else result = { status: "streaming" };
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
        },
      },
    });
    const client = new HermesGatewayClient({ baseUrl: `http://127.0.0.1:${gateway.port}`, token: "test", timeoutMs: 2_000 });
    bridge = startServer({ hostname: "127.0.0.1", port: 0, adapter: new HermesAppServerAdapter(client, "/") });
    socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/rpc`);
    socket.addEventListener("message", (event) => {
      const response = JSON.parse(String(event.data)) as RpcResponse;
      if (typeof (response as unknown as { method?: unknown }).method === "string") {
        notifications.push(response as unknown as { method: string; params: unknown });
        return;
      }
      pending.get(response.id)?.(response); pending.delete(response.id);
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("bridge websocket failed")), { once: true });
    });
  });

  afterAll(() => { socket.close(); bridge.stop(true); gateway.stop(true); });
  function rpc(method: string, params: unknown = {}): Promise<RpcResponse> {
    const id = crypto.randomUUID();
    return new Promise((resolve) => { pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
  }

  test("lists translated sessions", async () => {
    const listed = await rpc("thread/list", { limit: 20 });
    expect((listed.result as { data: Array<{ id: string; name: string }> }).data[0]).toMatchObject({ id: "session-1", name: "Gateway session" });
  });
  test("resumes durable id then loads live history", async () => {
    const read = await rpc("thread/read", { threadId: "session-1", includeTurns: true });
    const turns = (read.result as { thread: { turns: Array<{ items: unknown[] }> } }).thread.turns;
    expect(turns).toHaveLength(1); expect(turns[0]?.items).toHaveLength(2);
  });
  test("echoes user input and projects the streaming lifecycle", async () => {
    notifications.length = 0;
    const started = await rpc("turn/start", { threadId: "session-1", input: [{ type: "text", text: "ping" }] });
    const turn = (started.result as { turn: { items: Array<{ type: string }> } }).turn;
    expect(turn.items[0]?.type).toBe("userMessage");
    await Bun.sleep(10);
    expect(notifications.map((item) => item.method)).toEqual([
      "turn/started", "item/started", "item/agentMessage/delta", "item/completed", "turn/completed",
    ]);
  });
  test("uploads browser image bytes before submitting the Hermes prompt", async () => {
    gatewayCalls.length = 0;
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const started = await rpc("turn/start", {
      threadId: "session-1",
      input: [{ type: "text", text: "inspect" }, { type: "image", url: dataUrl }],
    });
    expect(started.error).toBeUndefined();
    expect(gatewayCalls.map((call) => call.method)).toEqual(["image.attach_bytes", "prompt.submit"]);
    expect(gatewayCalls[0]?.params).toMatchObject({
      session_id: "live-1",
      content_base64: "iVBORw0KGgo=",
    });
    expect(gatewayCalls[1]?.params).toEqual({ session_id: "live-1", text: "inspect" });
    await Bun.sleep(10);
  });
  test("queues a follow-up during an active turn and drains it in FIFO order", async () => {
    notifications.length = 0;
    await rpc("turn/start", { threadId: "session-1", input: [{ type: "text", text: "first" }] });
    const added = await rpc("thread/queue/add", {
      threadId: "session-1",
      input: [{ type: "text", text: "second" }],
      clientUserMessageId: "client-second",
    });
    expect((added.result as { queuedSubmission: { clientUserMessageId: string } }).queuedSubmission.clientUserMessageId).toBe("client-second");
    expect(((await rpc("thread/queue/list", { threadId: "session-1" })).result as { data: unknown[] }).data).toHaveLength(1);
    await Bun.sleep(30);
    expect(((await rpc("thread/queue/list", { threadId: "session-1" })).result as { data: unknown[] }).data).toHaveLength(0);
    expect(notifications.filter((item) => item.method === "turn/completed")).toHaveLength(2);
  });
});
