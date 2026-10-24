import assert from "node:assert/strict";
import test from "node:test";

import {
  AppServerClientError,
  createCordisAppServerClient,
  createCordisAppServerRegistry,
  JsonRpcAppServerClient,
  type DuplexTransport,
  type ServerRequestResponseContext,
} from "@opencraft/appserver-client";
import { MemoryTransport, type InMemoryAppServer } from "@opencraft/appserver-transport-memory";
import {
  RecordingTransport,
  ReplayMismatchError,
  ReplayTransport,
} from "@opencraft/appserver-transport-replay";
import {
  encodeJsonRpcMessage,
  isJsonRpcRequest,
  isJsonRpcSuccess,
  parseJsonRpcMessage,
  type AppServerInitializeResponse,
} from "@opencraft/appserver-protocol";

const initializeResponse: AppServerInitializeResponse = {
  codexHome: "/tmp/appserver-client-fixture",
  platformFamily: "unix",
  platformOs: "linux",
  userAgent: "opencraft-memory-appserver/1",
};

const initializeParams = {
  clientInfo: { name: "opencraft-tests", version: "1" },
  capabilities: { experimentalApi: true },
} as const;

test("encoding failures and synchronous send throws settle and release the exact receipt", async () => {
  const transport = new MemoryTransport({ server: createTestServer() });
  const client = new JsonRpcAppServerClient({ hostId: "encode-receipt", transport, requestTimeoutMs: 0 });
  try {
    await client.connect(initializeParams);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    for (const invalid of [1n, circular, { toJSON() { throw Error("encode failed"); } }]) {
      await assert.rejects(client.requestRaw("echo", invalid));
      assert.equal(client.getPendingRequestCount(), 0);
    }
    const send = transport.send.bind(transport);
    transport.send = () => { throw Error("sync send failed"); };
    await assert.rejects(client.requestRaw("echo", {}));
    assert.equal(client.getPendingRequestCount(), 0);
    transport.send = send;
    assert.deepEqual(await client.requestRaw("echo", { recovered: true }), { recovered: true });
  } finally { await client.close(); }
});

test("initialize cannot publish readiness when its reply is followed by connection loss", async () => {
  const transport = new MemoryTransport({
    schedule: callback => callback(),
    server: {
      receive(frame, peer) {
        const message = parseJsonRpcMessage(frame);
        if (!isJsonRpcRequest(message)) return;
        peer.send(encodeJsonRpcMessage({ id: message.id, result: initializeResponse }));
        peer.close("lost immediately after reply");
      },
    },
  });
  const client = new JsonRpcAppServerClient({ hostId: "initialize-race", transport });
  try {
    await assert.rejects(client.connect(initializeParams), /lost connection/);
    assert.equal(client.initializeResult, null);
    assert.equal(client.connectionGeneration, 0);
  } finally { await client.close(); }
});

function createTestServer(): InMemoryAppServer {
  let triggeringRequestId: string | number | null = null;
  return {
    receive(frame, peer) {
      const message = parseJsonRpcMessage(frame);
      if (isJsonRpcSuccess(message) && message.id === "server-approval") {
        peer.send(encodeJsonRpcMessage({
          id: triggeringRequestId ?? "missing-trigger",
          result: { approved: message.result },
        }));
        return;
      }
      if (!isJsonRpcRequest(message)) return;
      switch (message.method) {
        case "initialize":
          peer.send(encodeJsonRpcMessage({ id: message.id, result: initializeResponse }));
          return;
        case "echo":
          peer.send(encodeJsonRpcMessage({ method: "server/progress", params: { phase: "echo" } }));
          peer.send(encodeJsonRpcMessage({ id: message.id, result: message.params }));
          return;
        case "needs-approval":
          triggeringRequestId = message.id;
          peer.send(encodeJsonRpcMessage({
            id: "server-approval",
            method: "item/commandExecution/requestApproval",
            params: { command: "pwd" },
          }));
          return;
        case "never":
          return;
        case "drop":
          peer.close("simulated link loss");
          return;
        default:
          peer.send(encodeJsonRpcMessage({
            id: message.id,
            error: { code: -32601, message: `Unknown method ${message.method}` },
          }));
      }
    },
  };
}

test("Cordis owns one typed AppServer client and disposes its transport", async () => {
  const transport = new MemoryTransport(createTestServer());
  const runtime = await createCordisAppServerClient({ hostId: "memory", transport });
  const notifications: string[] = [];
  runtime.client.subscribeNotification((notification) => notifications.push(notification.method));

  const initialized = await runtime.client.connect(initializeParams);
  assert.deepEqual(initialized, initializeResponse);
  assert.equal(runtime.client.initializeResult?.platformOs, "linux");

  const echoed = await runtime.client.requestRaw<{ value: number }>("echo", { value: 42 });
  assert.deepEqual(echoed, { value: 42 });
  assert.deepEqual(notifications, ["server/progress"]);

  await runtime.dispose();
  assert.equal(transport.status.state, "closed");
});

test("client answers AppServer-initiated requests", async () => {
  const transport = new MemoryTransport(createTestServer());
  const client = new JsonRpcAppServerClient({ hostId: "approval", transport });
  client.handleServerRequest("item/commandExecution/requestApproval", (params) => ({
    decision: "accept",
    observed: params,
  }));

  await client.connect(initializeParams);
  const result = await client.requestRaw("needs-approval", {});
  assert.deepEqual(result, {
    approved: { decision: "accept", observed: { command: "pwd" } },
  });
  await client.close();
});

test("server request handlers receive a receipt for physical response delivery", async () => {
  const memory = new MemoryTransport(createTestServer());
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  const transport: DuplexTransport = {
    get status() { return memory.status; },
    connect: (signal) => memory.connect(signal),
    subscribeMessage: (listener) => memory.subscribeMessage(listener),
    subscribeStatus: (listener) => memory.subscribeStatus(listener),
    close: () => memory.close(),
    async send(frame, signal) {
      const message = parseJsonRpcMessage(frame);
      if (isJsonRpcSuccess(message) && message.id === "server-approval") {
        await responseGate;
      }
      await memory.send(frame, signal);
    },
  };
  const client = new JsonRpcAppServerClient({ hostId: "approval-receipt", transport });
  let responseContext: ServerRequestResponseContext | null = null;
  client.handleServerRequest("item/commandExecution/requestApproval", (_params, _request, context) => {
    responseContext = context;
    return { decision: "accept" };
  });

  await client.connect(initializeParams);
  const result = client.requestRaw("needs-approval", {});
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(typeof responseContext?.delivered?.then, "function");
    let delivered = false;
    void responseContext!.delivered.then(() => { delivered = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(delivered, false, "handler completion is not response delivery");

    releaseResponse();
    await responseContext!.delivered;
    assert.deepEqual(await result, { approved: { decision: "accept" } });
  } finally {
    releaseResponse();
    await result.catch(() => undefined);
    await client.close();
  }
});

test("notification interceptors can defer delivery until hydration commits", async () => {
  const transport = new MemoryTransport(createTestServer());
  const client = new JsonRpcAppServerClient({ hostId: "notification-buffer", transport });
  const notifications: string[] = [];
  const deferred: Array<() => void> = [];
  client.interceptNotification((notification, next) => {
    if (notification.method === "server/progress") deferred.push(next);
    else next();
  });
  client.subscribeNotification((notification) => notifications.push(notification.method));

  await client.connect(initializeParams);
  assert.deepEqual(await client.requestRaw("echo", { value: 1 }), { value: 1 });
  assert.deepEqual(notifications, []);
  assert.equal(deferred.length, 1);
  deferred.shift()?.();
  assert.deepEqual(notifications, ["server/progress"]);
  await client.close();
});

test("server request interceptors can defer the response and preserve handler chaining", async () => {
  const transport = new MemoryTransport(createTestServer());
  const client = new JsonRpcAppServerClient({ hostId: "request-buffer", transport });
  let release: (() => void) | null = null;
  client.interceptServerRequest((_request, next) => new Promise<unknown>((resolve, reject) => {
    release = () => void next().then(resolve, reject);
  }));
  client.handleServerRequest("item/commandExecution/requestApproval", () => ({ decision: "accept" }));

  await client.connect(initializeParams);
  const response = client.requestRaw("needs-approval", {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(typeof release, "function");
  assert.equal(client.getPendingRequestCount(), 1);
  (release as (() => void) | null)?.();
  assert.deepEqual(await response, { approved: { decision: "accept" } });
  await client.close();
});

test("recorded WebSocket-shaped frames replay through the same JSON-RPC client", async () => {
  let now = 100;
  const memory = new MemoryTransport(createTestServer());
  const recording = new RecordingTransport({
    transport: memory,
    clock: { now: () => now++ },
  });
  const liveClient = new JsonRpcAppServerClient({
    hostId: "recorded",
    transport: recording,
    createRequestId: (() => {
      let sequence = 0;
      return () => `recorded-${++sequence}`;
    })(),
  });

  await liveClient.connect(initializeParams);
  assert.deepEqual(await liveClient.requestRaw("echo", { text: "hello" }), { text: "hello" });
  await liveClient.close();
  assert.equal(recording.recording.length, 5, "initialize, echo, notification and two responses are recorded");

  const replay = new ReplayTransport({ recording: recording.recording, match: "json-rpc" });
  const replayClient = new JsonRpcAppServerClient({
    hostId: "replayed",
    transport: replay,
    createRequestId: (() => {
      let sequence = 0;
      return () => `different-live-id-${++sequence}`;
    })(),
  });
  const replayedNotifications: string[] = [];
  replayClient.subscribeNotification((notification) => replayedNotifications.push(notification.method));

  await replayClient.connect(initializeParams);
  assert.deepEqual(await replayClient.requestRaw("echo", { text: "hello" }), { text: "hello" });
  assert.deepEqual(replayedNotifications, ["server/progress"]);
  assert.equal(replay.remainingFrames, 0);
  await replayClient.close();
});

test("JSON-RPC replay ignores only the envelope id, never domain ids in params", async () => {
  const replay = new ReplayTransport({
    recording: [{
      sequence: 0,
      direction: "client-to-server",
      timestampMs: 1,
      payload: JSON.stringify({ id: "recorded-id", method: "thread/read", params: { id: "thread-a" } }),
    }],
    match: "json-rpc",
  });
  await replay.connect();
  await assert.rejects(
    replay.send(JSON.stringify({ id: "live-id", method: "thread/read", params: { id: "thread-b" } })),
    ReplayMismatchError,
  );
  assert.equal(replay.remainingFrames, 1);
  await replay.close();
});

test("request timeout is a stable typed client error", async () => {
  const transport = new MemoryTransport(createTestServer());
  const client = new JsonRpcAppServerClient({ hostId: "timeout", transport });
  await client.connect(initializeParams);

  await assert.rejects(
    client.requestRaw("never", {}, { timeoutMs: 5 }),
    (error: unknown) => error instanceof AppServerClientError && error.code === "TIMEOUT",
  );
  await client.close();
});

test("request load is bounded and exposes lifecycle events", async () => {
  const transport = new MemoryTransport(createTestServer());
  const client = new JsonRpcAppServerClient({
    hostId: "bounded",
    transport,
    maxPendingRequests: 1,
  });
  await client.connect(initializeParams);

  const events: string[] = [];
  client.subscribeRequestLifecycle((event) => events.push(event.type));
  const abortController = new AbortController();
  const pending = client.requestRaw("never", {}, {
    signal: abortController.signal,
    timeoutMs: 0,
    priority: "background",
  });

  await assert.rejects(
    client.requestRaw("echo", {}),
    (error: unknown) => error instanceof AppServerClientError && error.code === "QUEUE_FULL",
  );
  assert.equal(client.getPendingRequestCount(), 1);

  abortController.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof AppServerClientError && error.code === "ABORTED",
  );
  assert.equal(client.getPendingRequestCount(), 0);
  assert.deepEqual(events, ["queued", "started", "aborted"]);
  await client.close();
});

test("a transport reconnect creates a new initialized connection generation", async () => {
  const transport = new MemoryTransport(createTestServer());
  const client = new JsonRpcAppServerClient({ hostId: "reconnect", transport });
  await client.connect(initializeParams);
  assert.equal(client.connectionGeneration, 1);

  await assert.rejects(
    client.requestRaw("drop", {}),
    (error: unknown) => error instanceof AppServerClientError && error.code === "TRANSPORT_ERROR",
  );
  assert.equal(client.initializeResult, null);

  await client.connect(initializeParams);
  assert.equal(client.connectionGeneration, 2);
  await client.close();
});

test("Cordis registry owns independent clients per host", async () => {
  const runtime = await createCordisAppServerRegistry();
  const localTransport = new MemoryTransport(createTestServer());
  const sshTransport = new MemoryTransport(createTestServer());
  const snapshots: string[] = [];
  runtime.clients.subscribe(() => snapshots.push(runtime.clients.getSnapshot().hostIds.join(",")));

  const local = runtime.clients.create({ hostId: "local", transport: localTransport });
  const ssh = runtime.clients.create({ hostId: "remote-ssh:devbox", transport: sshTransport });
  await Promise.all([local.connect(initializeParams), ssh.connect(initializeParams)]);
  assert.equal(runtime.clients.getOrThrow("local"), local);
  assert.deepEqual(runtime.clients.getSnapshot().hostIds, ["local", "remote-ssh:devbox"]);

  assert.throws(
    () => runtime.clients.create({ hostId: "local", transport: new MemoryTransport(createTestServer()) }),
    (error: unknown) => error instanceof AppServerClientError && error.code === "HOST_EXISTS",
  );
  await runtime.clients.remove("remote-ssh:devbox");
  assert.equal(sshTransport.status.state, "closed");
  assert.deepEqual(snapshots, ["local", "local,remote-ssh:devbox", "local"]);

  await runtime.dispose();
  assert.equal(localTransport.status.state, "closed");
});

test("same-host client incarnations allocate distinct default RPC IDs", async () => {
  const ids: unknown[] = [];
  const make = () => new JsonRpcAppServerClient({ hostId: "shared-host", transport: new MemoryTransport({ server: { receive(frame, peer) {
    const message = parseJsonRpcMessage(frame);
    if (!isJsonRpcRequest(message)) return;
    ids.push(message.id);
    peer.send(encodeJsonRpcMessage({ id: message.id, result: initializeResponse }));
  } } }) });
  const first = make(), second = make();
  try { await Promise.all([first.connect(initializeParams), second.connect(initializeParams)]); assert.equal(new Set(ids).size, 2); }
  finally { await first.close(); await second.close(); }
});
