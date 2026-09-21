import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";
import { WebSocketServer } from "ws";

import { startLocalAgentHost } from "../apps/local-agent-host/src/main.js";
import { ThreadCatalog } from "../apps/local-agent-host/src/thread-catalog.js";

test("Host bind failure closes its thread catalog", async t => {
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");
  const close = t.mock.method(ThreadCatalog.prototype, "close");
  try {
    await assert.rejects(startLocalAgentHost({ dshUrl: "http://127.0.0.1:1", port: address.port }), { code: "EADDRINUSE" });
    assert.equal(close.mock.callCount(), 1);
  } finally {
    close.mock.restore();
    await new Promise<void>(resolve => occupied.close(() => resolve()));
  }
});

test("local product project RPC persists across Host restart without a reachable engine", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-project-rpc-test-"));
  let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined;
  let socket: WebSocket | undefined;
  try {
    const root = join(directory, "workspace"); await mkdir(root);
    const options = { dshUrl: "http://127.0.0.1:1", projectStorageDirectory: directory };
    host = await startLocalAgentHost(options); socket = await connect(host.websocketUrl);
    assert.deepEqual(await request(socket, 1, "project/list", {}), { data: [], nextCursor: null });
    const created = await request(socket, 2, "project/create", { name: "Workspace", roots: [{ path: root }], idempotencyKey: "test-project" });
    socket.close(); socket = undefined; await host.close();
    host = await startLocalAgentHost(options); socket = await connect(host.websocketUrl);
    assert.deepEqual((await request(socket, 3, "project/list", {})).data, [created.project]);
    assert.equal((await request(socket, 4, "project/create", { name: "Workspace", roots: [{ path: root }], idempotencyKey: "test-project" })).project.id, created.project.id);
  } finally { socket?.close(); await host?.close(); await rm(directory, { recursive: true, force: true }); }
});

async function fakeDsh() {
  const responses: Array<Record<string, any>> = [];
  const streams = new Map<WebSocket, string>();
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const activeSessions = new Set<string>();
  const queues = new Map<string, Array<Record<string, any>>>();
  let nextQueueId = 1;
  const publishMux = (payload: Record<string, unknown>) => {
    const frame = JSON.stringify({ payload });
    for (const [stream, path] of streams) if (path === "/api/events.mux") stream.send(frame);
  };
  const publishQueue = (sessionId: string) => publishMux({
    type: "session/queue",
    sessionId,
    items: queues.get(sessionId) ?? [],
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string; payload: Record<string, unknown>; rpcId: string };
    if (url.pathname === "/api/respond") {
      responses.push(envelope);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ accepted: true }));
      return;
    }
    calls.push({ method: envelope.method, payload: envelope.payload });
    let value: unknown = {};
    if (envelope.method === "host.describe") value = {
      home: "/home/tester",
      cwd: "/workspace/demo",
      version: "0.0.1-test",
      provider: "deepseek",
      model: "deepseek-v4-flash",
    };
    if (envelope.method === "settings.describe") value = {
      writable: true,
      hasDocument: true,
      namespaces: [
        {
          ns: "agent-default-model",
          schema: {},
          value: { provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "high" },
          user: {},
          applies: "live",
          secrets: [],
          revision: 2,
        },
        {
          ns: "llm-deepseek",
          schema: {},
          value: { apiKeyEnv: "DEEPSEEK_API_KEY" },
          user: {},
          applies: "live",
          secrets: [],
          revision: 3,
        },
      ],
    };
    if (envelope.method === "settings.mutate") value = {
      ns: envelope.payload.ns,
      schema: {},
      value: {},
      applies: "live",
      secrets: [],
      revision: 4,
    };
    if (envelope.method === "credentials.describe") value = {
      credentials: { DEEPSEEK_API_KEY: { configured: true, source: "file", writable: true } },
    };
    if (envelope.method === "credentials.set" || envelope.method === "credentials.unset") value = {};
    if (envelope.method === "llm.providers") value = {
      providers: [{ provider: "deepseek", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [], active: true }],
    };
    if (envelope.method === "session.list") value = { items: [{ sessionId: "s1", updatedAt: 1_788_000_000_000, running: false, blank: false, cwd: "/workspace/demo", projections: { asOfSeq: 8, values: { title: "Demo" } } }] };
    if (envelope.method === "session.history") value = {
      events: [
        { event: { type: "permission/preset", seq: 0, time: 1_788_000_000_000, data: { preset: "workspace-write" } } },
        { event: { type: "sandbox/mode", seq: 1, time: 1_788_000_000_000, data: { mode: "workspace-write" } } },
        { event: { type: "approval/policy", seq: 2, time: 1_788_000_000_000, data: { policy: "ask" } } },
        ...[
        { event: { type: "turn/start", seq: 0, time: 1_788_000_000_000, data: { turn: 1 } } },
        { event: { type: "step/start", seq: 1, time: 1_788_000_000_001, data: { turn: 1, step: 1 } } },
        { event: { type: "user/message", seq: 2, time: 1_788_000_000_002, data: { id: "m-user", role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "human", rpcId: "history-client-message" } } } },
        { event: { type: "user/message", seq: 3, time: 1_788_000_000_002, data: { id: "m-system", role: "user", content: [{ type: "text", text: "runtime context" }], source: { kind: "plugin", plugin: "system-prompt" } } } },
        { event: { type: "assistant/message", seq: 4, time: 1_788_000_000_003, data: { turn: 1, step: 1, message: { id: "m-agent", role: "assistant", content: [{ type: "reasoning", text: "think" }, { type: "text", text: "world" }] } } } },
        { event: { type: "turn/end", seq: 5, time: 1_788_000_000_004, data: { turn: 1, reason: { kind: "completed" } } } },
        ].map(entry => ({ event: { ...entry.event, seq: entry.event.seq + 3 } })),
      ],
      hasMore: false,
      projections: { asOfSeq: 5, values: { title: "Demo" } },
    };
    if (envelope.method === "session.models") value = {
      current: { provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "high" },
      routable: true,
      groups: [
        { id: "deepseek", name: "DeepSeek", models: [{ id: "deepseek-v4-flash", name: "V4 Flash", reasoning: { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" } }] },
        { id: "custom:test", name: "Custom", models: [{ id: "hy4-preview", name: "HY4 Preview" }] },
      ],
      failures: [],
    };
    if (envelope.method === "session.create") value = { sessionId: "s-new", agentPreset: "standard" };
    if (envelope.method === "session.prompt") {
      value = { accepted: true };
      const sessionId = String(envelope.payload.sessionId);
      if (envelope.payload.mode === "queue" && activeSessions.has(sessionId)) {
        const item = {
          id: `queued-${nextQueueId++}`,
          placement: "queued",
          message: {
            id: `queued-message-${nextQueueId}`,
            role: "user",
            content: envelope.payload.content,
            source: { kind: "user", rpcId: envelope.rpcId },
          },
        };
        queues.set(sessionId, [...(queues.get(sessionId) ?? []), item]);
        setTimeout(() => publishQueue(sessionId), 0);
      } else if (envelope.payload.mode === "queue") {
        activeSessions.add(sessionId);
        setTimeout(() => { publishMux({
          type: "session/event",
          sessionId,
          event: { type: "turn/start", seq: 10, time: 1_788_000_000_100, data: { turn: 1 } },
        }); publishMux({
          type: "session/event", sessionId,
          event: { type: "user/message", seq: 11, time: 1_788_000_000_101, data: {
            content: envelope.payload.content, source: { kind: "user", rpcId: envelope.rpcId },
          } },
        }); }, 0);
      }
    }
    if (envelope.method === "session.updateQueue") {
      value = { accepted: true };
      const sessionId = String(envelope.payload.sessionId);
      const itemId = String(envelope.payload.itemId);
      const action = envelope.payload.action as { kind: string; content?: unknown[] };
      const current = queues.get(sessionId) ?? [];
      if (action.kind === "edit") {
        queues.set(sessionId, current.map((item) => item.id === itemId
          ? { ...item, message: { ...item.message, content: action.content } }
          : item));
      } else {
        queues.set(sessionId, current.filter((item) => item.id !== itemId));
      }
      setTimeout(() => publishQueue(sessionId), 0);
    }
    if (envelope.method === "llm.models") value = {
      groups: [
        { id: "deepseek", name: "DeepSeek", models: [{ id: "deepseek-v4-flash", name: "V4 Flash", reasoning: { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" } }] },
        { id: "custom:test", name: "Custom", models: [{ id: "hy4-preview", name: "HY4 Preview" }] },
      ],
      failures: [],
    };
    if (envelope.method === "llm.discoverModels") value = {
      models: [{ id: "gpt-test", name: "GPT Test", contextWindow: 128000, maxTokens: 16384 }],
    };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ type: "server-response", rpcId: envelope.rpcId, result: { ok: true, value } }));
  });
  const downlinks = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== "/api/events.mux" && path !== "/api/events.host") {
      socket.destroy();
      return;
    }
    downlinks.handleUpgrade(request, socket, head, (client) => downlinks.emit("connection", client, request));
  });
  downlinks.on("connection", (socket, request) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    streams.set(socket, path);
    socket.once("close", () => streams.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake DSH did not listen");
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    responses,
    publish(envelope: Record<string, unknown>) {
      for (const [stream, path] of streams) if (path === "/api/events.mux") stream.send(JSON.stringify(envelope));
    },
    async close() {
      for (const stream of streams.keys()) stream.close();
      downlinks.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function request(socket: WebSocket, id: number, method: string, params: unknown = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const listener = (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: unknown };
      if (frame.id !== id) return;
      socket.off("message", listener);
      frame.error === undefined ? resolve(frame.result) : reject(frame.error);
    };
    socket.on("message", listener);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

test("DSH questions cross the real mux and AppServer WebSocket, survive reconnect, and return native responses", async () => {
  const dsh = await fakeDsh();
  const host = await startLocalAgentHost({ dshUrl: dsh.url });
  let socket = await connect(host.websocketUrl);
  const next = (method: string) => new Promise<any>((resolve, reject) => {
    const target = socket;
    const timer = setTimeout(() => { target.off("message", listener); reject(new Error(`Timed out waiting for ${method}`)); }, 3000);
    const listener = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString());
      if (frame.method !== method) return;
      clearTimeout(timer); target.off("message", listener); resolve(frame);
    };
    target.on("message", listener);
  });
  const preflight = await connect(host.websocketUrl);
  const preflightRequests: unknown[] = [];
  preflight.on("message", raw => { const frame = JSON.parse(raw.toString()); if (frame.method === "item/tool/requestUserInput") preflightRequests.push(frame); });
  try {
    await request(preflight, 99, "initialize", {});
    await request(socket, 1, "initialize", {});
    await request(socket, 4, "thread/resume", { threadId: "s1" });
    dsh.publish({ payload: { type: "session/event", sessionId: "s1", event: { type: "turn/start", seq: 90, time: 100, data: { turn: 2 } } } });
    const incoming = next("item/tool/requestUserInput");
    dsh.publish({ rpcId: "native-question", payload: { type: "question/requested", sessionId: "s1", questions: [{ id: "choose", question: "Which?", options: [{ label: "A" }] }] } });
    const ask = await incoming;
    assert.equal(ask.id, "native-question");
    assert.equal(ask.params.turnId, "dsh-turn-s1-2");
    await request(preflight, 100, "thread/list", {});
    assert.deepEqual(preflightRequests, []);
    await new Promise<void>(resolve => { socket.once("close", resolve); socket.close(); });
    socket = await connect(host.websocketUrl);
    const replay = next("item/tool/requestUserInput");
    await request(socket, 2, "initialize", {});
    await request(socket, 5, "thread/resume", { threadId: "s1" });
    assert.equal((await replay).id, ask.id);
    const resolved = next("serverRequest/resolved");
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: ask.id, result: { answers: { choose: { answers: ["A"] } } } }));
    assert.equal((await resolved).params.requestId, ask.id);
    assert.deepEqual(dsh.responses, [{ type: "client-response", rpcId: "native-question", result: { ok: true, value: {
      sessionId: "s1", answer: { answers: [{ id: "choose", selected: ["A"] }] },
    } } }]);
    socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
    assert.ok(await request(socket, 3, "thread/list", {}));
  } finally { preflight.close(); socket.close(); await host.close(); await dsh.close(); }
});

test("process RPC survives WebSocket replacement without contacting the Agent harness", async () => {
  const host = await startLocalAgentHost({ dshUrl: "http://127.0.0.1:1", token: "process-test" });
  let socket = await connect(host.websocketUrl);
  try {
    await request(socket, 1, "process/spawn", {
      processHandle: "persistent-shell", command: ["/bin/bash", "--noprofile", "--norc"],
      tty: true, size: { cols: 80, rows: 24 },
    });
    await request(socket, 2, "process/writeStdin", { processHandle: "persistent-shell", deltaBase64: Buffer.from("export RPC_STATE=alive\n").toString("base64") });
    await new Promise<void>(resolve => { socket.once("close", () => resolve()); socket.close(); });
    socket = await connect(host.websocketUrl);
    const listed = await request(socket, 3, "process/list");
    assert.equal(listed.processes[0].processHandle, "persistent-shell");
    assert.equal(listed.processes[0].phase, "running");
    await request(socket, 4, "process/writeStdin", { processHandle: "persistent-shell", deltaBase64: Buffer.from("printf 'RPC_%s\\n' \"$RPC_STATE\"; exit 0\n").toString("base64") });
    let snapshot;
    for (let attempt = 0; attempt < 200; attempt++) {
      snapshot = await request(socket, 10 + attempt, "process/attach", { processHandle: "persistent-shell", afterSequence: 0 });
      if (snapshot.phase === "exited") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(snapshot.phase, "exited");
    assert.match(snapshot.output.map((c: { deltaBase64: string }) => Buffer.from(c.deltaBase64, "base64").toString()).join(""), /RPC_alive/);
  } finally { socket.close(); await host.close(); }
});

test("local Agent Host authenticates and projects DSH history into stable AppServer turns", async () => {
  const dsh = await fakeDsh();
  const host = await startLocalAgentHost({ dshUrl: dsh.url, token: "test-token" });
  try {
    await assert.rejects(connect(host.websocketUrl.replace("test-token", "wrong")));
    const socket = await connect(host.websocketUrl);
    try {
      const initialized = await request(socket, 1, "initialize", {});
      assert.equal(initialized.codexHome, "/home/tester");
      const listed = await request(socket, 2, "thread/list", { limit: 10 });
      assert.equal(listed.data[0].name, "Demo");
      const models = await request(socket, 4, "model/list", { limit: 10 });
      assert.equal(models.data[0].displayName, "V4 Flash");
      assert.equal(models.data[0].isDefault, true);
      const firstPage = await request(socket, 41, "model/list", { limit: 1 });
      assert.equal(firstPage.data.length, 1);
      const resumed = await request(socket, 3, "thread/resume", { threadId: "s1" });
      assert.equal(resumed.thread.turns.length, 1);
      assert.deepEqual(resumed.thread.turns[0].items.map((item: { type: string }) => item.type), ["userMessage", "reasoning", "agentMessage"]);
      assert.equal(resumed.thread.turns[0].items[0].content[0].text, "hello");
      assert.equal(resumed.thread.turns[0].items[0].clientId, "history-client-message");
      assert.equal(resumed.thread.turns[0].items[2].text, "world");
    } finally {
      socket.close();
    }
  } finally {
    await host.close();
    await dsh.close();
  }
});

test("local Agent Host applies the selected DSH model before opening a real event-owned Turn", async () => {
  const dsh = await fakeDsh();
  const host = await startLocalAgentHost({ dshUrl: dsh.url, token: "turn-token" });
  try {
    const socket = await connect(host.websocketUrl);
    try {
      await request(socket, 10, "initialize", {});
      const models = await request(socket, 11, "model/list", { limit: 10 });
      const started = await request(socket, 12, "thread/start", {
        cwd: "/workspace/demo",
        model: models.data[0].id,
      });
      const turn = await request(socket, 13, "turn/start", {
        threadId: started.thread.id,
        model: models.data[0].id,
        effort: "high",
        input: [{ type: "text", text: "hello", text_elements: [] }],
      });
      assert.equal(turn.turn.id, "dsh-turn-s-new-1");
      assert.equal(dsh.calls.filter((call) => call.method === "session.selectModel").length, 2);
      assert.deepEqual(
        dsh.calls.findLast((call) => call.method === "session.selectModel")?.payload,
        { sessionId: "s-new", provider: "deepseek", model: "deepseek-v4-flash", reasoningEffort: "high" },
      );
      assert.equal(dsh.calls.find((call) => call.method === "session.prompt")?.payload.mode, "queue");
    } finally {
      socket.close();
    }
  } finally {
    await host.close();
    await dsh.close();
  }
});

test("local Agent Host projects DSH's authoritative queue and translates queue controls", async () => {
  const dsh = await fakeDsh();
  const host = await startLocalAgentHost({ dshUrl: dsh.url, token: "queue-token" });
  try {
    const socket = await connect(host.websocketUrl);
    try {
      const initialized = await request(socket, 50, "initialize", {});
      assert.deepEqual(initialized.capabilities.extensions["opencraft/thread-queue"], {
        version: 2,
        reorder: false,
        atomicSteer: true,
        perItemPause: false,
      });
      assert.equal(initialized.capabilities.extensions["opencraft/profile-skills"].version, 1);
      assert.equal(initialized.capabilities.extensions["opencraft/profile-skills"].features.install, true);
      assert.equal(initialized.capabilities.extensions["opencraft/profile-skills"].features.officialCatalog, false);
      const started = await request(socket, 51, "thread/start", { cwd: "/workspace/demo" });
      await request(socket, 52, "turn/start", {
        threadId: started.thread.id,
        clientUserMessageId: "initial-client-message",
        input: [{ type: "text", text: "start", text_elements: [] }],
      });

      const added = await request(socket, 53, "thread/queue/add", {
        threadId: started.thread.id,
        clientUserMessageId: "queued-client-message",
        input: [{ type: "text", text: "follow up", text_elements: [] }],
      });
      assert.equal(added.queuedSubmission.clientUserMessageId, "queued-client-message");
      assert.equal(added.queuedSubmission.input[0].text, "follow up");

      const listed = await request(socket, 54, "thread/queue/list", { threadId: started.thread.id });
      assert.deepEqual(listed.data, [added.queuedSubmission]);

      const updated = await request(socket, 55, "thread/queue/update", {
        threadId: started.thread.id,
        queuedSubmissionId: added.queuedSubmission.id,
        input: [{ type: "text", text: "edited", text_elements: [] }],
      });
      assert.equal(updated.queuedSubmission.input[0].text, "edited");

      const steered = await request(socket, 56, "thread/queue/steer", {
        threadId: started.thread.id,
        expectedTurnId: `dsh-turn-${started.thread.id}-1`,
        queuedSubmissionId: added.queuedSubmission.id,
      });
      assert.equal(steered.turnId, `dsh-turn-${started.thread.id}-1`);
      assert.equal(dsh.calls.findLast((call) => call.method === "session.updateQueue")?.payload.action.kind, "steer");
      assert.equal(dsh.calls.filter((call) => call.method === "session.prompt" && call.payload.mode === "steer").length, 0);

      const empty = await request(socket, 57, "thread/queue/list", { threadId: started.thread.id });
      assert.deepEqual(empty.data, []);
    } finally {
      socket.close();
    }
  } finally {
    await host.close();
    await dsh.close();
  }
});

test("local Agent Host routes Profile Skills mutations to its isolated DSH user root", async () => {
  const dsh = await fakeDsh();
  const skillsDirectory = await mkdtemp(join(tmpdir(), "opencraft-local-host-skills-"));
  const host = await startLocalAgentHost({
    dshUrl: dsh.url,
    token: "skills-token",
    skillsDirectory,
  });
  const socket = await connect(host.websocketUrl);
  try {
    const initialized = await request(socket, 70, "initialize", {});
    assert.equal(initialized.capabilities.extensions["opencraft/profile-skills"].features.install, true);
    const markdown = "---\nname: routed-skill\ndescription: Routed Skill\n---\n\nUse it.\n";
    const receipt = await request(socket, 71, "skills/install", {
      scope: { type: "local-dsh", root: "user" },
      identifier: "routed-skill",
      operationId: "install-routed-skill",
      artifact: { name: "routed-skill", files: [{ path: "SKILL.md", content: markdown }] },
    });
    assert.equal(receipt.action.state, "succeeded");
    const listed = await request(socket, 72, "skills/installed/list", {
      scope: { type: "local-dsh", root: "user" },
    });
    assert.deepEqual(listed.data.map((skill: { name: string }) => skill.name), ["routed-skill"]);
  } finally {
    socket.close();
    await host.close();
    await dsh.close();
    await rm(skillsDirectory, { recursive: true, force: true });
  }
});

test("local Agent Host exposes generic runtime settings without leaking DSH method names to the client", async () => {
  const dsh = await fakeDsh();
  const host = await startLocalAgentHost({ dshUrl: dsh.url, token: "settings-token" });
  try {
    const socket = await connect(host.websocketUrl);
    try {
      await request(socket, 20, "initialize", {});
      const status = await request(socket, 21, "runtime/status/read", {});
      assert.deepEqual(status, {
        engineId: "dsh",
        displayName: "DeepSeek Harness",
        version: "0.0.1-test",
        cwd: "/workspace/demo",
        provider: "deepseek",
        model: "deepseek-v4-flash",
      });
      const settings = await request(socket, 22, "runtime/settings/describe", {});
      assert.equal(settings.namespaces[0].ns, "agent-default-model");
      const credentials = await request(socket, 23, "runtime/credentials/describe", { refs: ["DEEPSEEK_API_KEY"] });
      assert.equal(credentials.credentials.DEEPSEEK_API_KEY.configured, true);
      await request(socket, 24, "runtime/settings/mutate", {
        ns: "agent-default-model",
        expectedRevision: 2,
        ops: [{ op: "set", path: ["model"], value: "deepseek-v4-flash" }],
      });
      await request(socket, 25, "runtime/credentials/set", { ref: "DEEPSEEK_API_KEY", value: "write-only" });
      const discovered = await request(socket, 26, "runtime/models/discover", {
        source: "catalog",
        settingsNs: "llm-pi-ai",
        provider: "openai",
        apiKey: "probe-only",
      });
      assert.equal(discovered.models[0].id, "gpt-test");
      assert.deepEqual(
        dsh.calls.findLast((call) => call.method === "settings.mutate")?.payload,
        {
          ns: "agent-default-model",
          expectedRevision: 2,
          ops: [{ op: "set", path: ["model"], value: "deepseek-v4-flash" }],
        },
      );
      assert.deepEqual(
        dsh.calls.findLast((call) => call.method === "llm.discoverModels")?.payload,
        { settingsNs: "llm-pi-ai", provider: "openai" },
      );
      assert.deepEqual(
        dsh.calls.findLast((call) => call.method === "credentials.set")?.payload,
        { ref: "DEEPSEEK_API_KEY", value: "write-only" },
      );
    } finally {
      socket.close();
    }
  } finally {
    await host.close();
    await dsh.close();
  }
});
