import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { WebSocketServer } from "ws";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { COLLABORATION_METHOD } from "@opencraft/appserver-protocol/collaboration";
import { attachGateway, BridgeHost, codexDeclaration } from "@opencraft/agent-bridge-host";
import { createServerCodexBridgeHost } from "../../apps/opencraft-daemon/src/codex-bridge-host.js";
import { localTestBackend } from "./fixtures/local-backend.js";

test("ServerCodexBridgeHost runs single-stack Codex Bridge with sender attribution, collaboration, and child orchestration without CodexEngineAdapter", async (t) => {
  const root = await mkdtemp("/tmp/ocsb-");
  const coreSock = join(root, "core.sock");
  const nativeSock = join(root, "native.sock");
  const bridgeToken = "private-bridge-token-00000000000000000000";

  const sessions = new Map<string, { id: string; cwd: string; loaded: boolean; name?: string; turns: any[] }>();
  let seq = 0;

  const coreHttp = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/launch") {
      res.end(
        JSON.stringify({
          dataDirectory: root,
          launch: {
            args: [],
            env: { OPENCRAFT_CODEX_POOL_AUTH_TOKEN: "tok" },
            auth: { type: "chatgptAuthTokens", accessToken: "tok", chatgptAccountId: "opencraft-account-pool" },
          },
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        protocolVersion: 1,
        pid: process.pid,
        codexPid: process.pid,
        nativeSocket: nativeSock,
        executionIncarnation: "inc-1",
        accounts: [],
      }),
    );
  });

  const nativeHttp = createServer();
  const nativeWs = new WebSocketServer({ server: nativeHttp });
  nativeWs.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: frame.id,
            result: {
              userAgent: "codex/0.167.2",
              codexHome: join(root, "native-home"),
              capabilities: { extensions: {} },
            },
          }),
        );
        return;
      }
      if (frame.method === "initialized") return;
      if (frame.method === "thread/start") {
        const id = `native-${++seq}`;
        const cwd = String(frame.params?.cwd ?? root);
        sessions.set(id, { id, cwd, loaded: true, turns: [] });
        socket.send(
          JSON.stringify({
            id: frame.id,
            result: {
              thread: { id, cwd, status: { type: "idle" }, turns: [] },
              cwd,
              model: frame.params?.model ?? "gpt-test",
              approvalPolicy: frame.params?.approvalPolicy ?? "never",
              sandbox: { type: "dangerFullAccess" },
            },
          }),
        );
        return;
      }
      if (frame.method === "thread/unsubscribe") {
        const current = sessions.get(frame.params?.threadId);
        if (current) current.loaded = false;
        socket.send(JSON.stringify({ id: frame.id, result: {} }));
        return;
      }
      if (frame.method === "thread/resume") {
        const current = sessions.get(frame.params.threadId) ?? {
          id: frame.params.threadId,
          cwd: root,
          loaded: true,
          turns: [],
        };
        current.loaded = true;
        socket.send(
          JSON.stringify({
            id: frame.id,
            result: {
              thread: { id: current.id, cwd: current.cwd, status: { type: "idle" }, turns: current.turns },
              cwd: current.cwd,
              model: "gpt-test",
              approvalPolicy: "never",
              sandbox: { type: "dangerFullAccess" },
            },
          }),
        );
        return;
      }
      if (frame.method === "thread/read") {
        const current = sessions.get(frame.params.threadId);
        if (!current) {
          socket.send(JSON.stringify({ id: frame.id, error: { code: -32602, message: "Thread not found" } }));
          return;
        }
        socket.send(
          JSON.stringify({
            id: frame.id,
            result: {
              thread: {
                id: current.id,
                cwd: current.cwd,
                name: current.name ?? null,
                status: { type: current.loaded ? "idle" : "notLoaded" },
                turns: frame.params.includeTurns ? current.turns : [],
              },
            },
          }),
        );
        return;
      }
      if (frame.method === "thread/name/set") {
        const current = sessions.get(frame.params.threadId);
        if (current) current.name = frame.params.name;
        socket.send(JSON.stringify({ id: frame.id, result: {} }));
        return;
      }
      if (frame.method === "thread/list") {
        socket.send(
          JSON.stringify({
            id: frame.id,
            result: {
              data: [...sessions.values()].map((s) => ({
                id: s.id,
                cwd: s.cwd,
                name: s.name ?? null,
                status: { type: "idle" },
              })),
              nextCursor: null,
            },
          }),
        );
        return;
      }
      if (frame.method === "turn/start") {
        const current = sessions.get(frame.params.threadId)!;
        const turnId = `turn-${++seq}`;
        const userItem = {
          id: `u-${seq}`,
          type: "userMessage",
          clientId: frame.params.clientUserMessageId ?? null,
          content: frame.params.input ?? [],
        };
        const agentItem = {
          id: `a-${seq}`,
          type: "agentMessage",
          text: "ack",
          phase: "final_answer",
          delivery: null,
          questions: null,
          memoryCitation: null,
        };
        current.turns.push({ id: turnId, status: "completed", error: null, items: [userItem, agentItem] });
        socket.send(JSON.stringify({ id: frame.id, result: { turn: { id: turnId } } }));
        queueMicrotask(() => {
          for (const client of nativeWs.clients) {
            client.send(
              JSON.stringify({ method: "turn/started", params: { threadId: current.id, turn: { id: turnId } } }),
            );
            client.send(
              JSON.stringify({ method: "item/started", params: { threadId: current.id, turnId, item: userItem } }),
            );
            client.send(
              JSON.stringify({ method: "item/completed", params: { threadId: current.id, turnId, item: userItem } }),
            );
            client.send(
              JSON.stringify({ method: "item/started", params: { threadId: current.id, turnId, item: agentItem } }),
            );
            client.send(
              JSON.stringify({ method: "item/completed", params: { threadId: current.id, turnId, item: agentItem } }),
            );
            client.send(
              JSON.stringify({
                method: "turn/completed",
                params: { threadId: current.id, turn: { id: turnId, status: "completed", error: null } },
              }),
            );
          }
        });
        return;
      }
      socket.send(JSON.stringify({ id: frame.id, result: {} }));
    });
  });

  await Promise.all([
    new Promise<void>((r) => coreHttp.listen(coreSock, r)),
    new Promise<void>((r) => nativeHttp.listen(nativeSock, r)),
  ]);

  const coreConfig = join(root, "core.json");
  await writeFile(coreConfig, JSON.stringify({ endpoint: coreSock, token: "core-token" }), { mode: 0o600 });
  const artifact = join(root, "codex-main.cjs");
  await build({
    entryPoints: [resolve("apps/agent-bridge-host/src/codex-main.ts")],
    outfile: artifact,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const bridgeHost = await BridgeHost.open({
    path: join(root, "engine-host.sqlite"),
    policy: { id: "server-single-stack-test", capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 } },
    backend: localTestBackend(),
    executionCli: {
      async issue(source: any) {
        assert.ok(String(source.credential).length > 0);
        return { environment: { OPENCRAFT_THREAD_CLI: "fixture" }, async revoke() {} };
      },
    },
  });
  const attachment = await attachGateway(bridgeHost, bridgeToken);
  await bridgeHost.add({
    id: "codex-1",
    artifact,
    digest: createHash("sha256")
      .update(await readFile(artifact))
      .digest("hex"),
    provider: codexDeclaration,
    launch: { command: [process.execPath, artifact, coreConfig], cwd: root, env: {} },
  });
  await bridgeHost.activate("codex-1", "");

  let collabCalls = 0;
  const host = createServerCodexBridgeHost({
    coreEndpoint: coreSock,
    coreAuthToken: "core-token",
    bridge: {
      url: attachment.url,
      token: bridgeToken,
      serverId: "server:test:codex",
      inboxPath: join(root, "gateway-inbox.sqlite"),
    },
    admission: {
      admit: async (threadId, inputId) => ({
        serverId: "server:test:codex",
        threadId,
        execution: { inputId, executionId: `exec:${inputId}` },
      }),
      sign: (s) => JSON.stringify(s),
      started: () => {},
    },
    codexDataDirectory: join(root, "codex"),
    artifactDirectory: join(root, "artifacts"),
    collaboration: {
      command: async (_actor, body) => {
        collabCalls++;
        return { echoedAction: body.action };
      },
      authorize: () => {},
      topology: (id) =>
        id.startsWith("bridge:codex:orch-") ? { parentThreadId: "bridge:codex:parent", visibility: "visible" } : null,
    },
  });

  t.after(async () => {
    await host.close();
    await attachment.close();
    await bridgeHost.close();
    nativeWs.close();
    await Promise.all([
      new Promise<void>((r) => nativeHttp.close(() => r())),
      new Promise<void>((r) => coreHttp.close(() => r())),
    ]);
    await rm(root, { recursive: true, force: true });
  });

  await host.connect();
  const replies = new Map<string | number, any>();
  host.subscribeMessage((raw) => {
    const frame = JSON.parse(raw);
    if (frame.id !== undefined && frame.method === undefined) replies.set(frame.id, frame);
  });

  const rpc = async (id: string, method: string, params: Record<string, unknown>, context: any = { sender: null }) => {
    await host.sendWithContext(
      JSON.stringify({ jsonrpc: "2.0", id, method, params, [LOGICAL_CLIENT_FIELD]: "web-1" }),
      context,
    );
    for (let i = 0; i < 200; i++) {
      if (replies.has(id)) {
        const reply = replies.get(id)!;
        replies.delete(id);
        if (reply.error) throw Object.assign(new Error(reply.error.message), reply.error);
        return reply.result;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`Timeout waiting for ${method}`);
  };

  const aliceContext = {
    sender: { kind: "employee" as const, loginName: "alice" },
    validUntil: Date.now() + 60_000,
    actorContext: { actorId: "actor-alice", generation: 1, credentialId: null, expiresAt: Date.now() + 60_000 },
  };

  const init = await rpc(
    "1",
    "initialize",
    { clientInfo: { name: "test", version: "1" }, capabilities: {} },
    aliceContext,
  );
  assert.ok(init.capabilities.extensions["opencraft/collaboration"]);
  assert.deepEqual(init.capabilities.extensions["opencraft/thread-orchestration-view"], { version: 1 });

  // Collaboration RPC handled without CodexEngineAdapter.
  const collabRes = await rpc("2", COLLABORATION_METHOD, { action: "ping" }, aliceContext);
  assert.equal(collabCalls, 1);
  assert.deepEqual(collabRes, { echoedAction: "ping" });

  // Create Bridge thread, run turn with verified employee sender, and verify sender attribution on read.
  const started = await rpc("3", "thread/start", { cwd: root, model: "gpt-test" }, aliceContext);
  const parentId = started.thread.id as string;
  assert.match(parentId, /^bridge:codex:/);

  await rpc(
    "4",
    "turn/start",
    { threadId: parentId, clientUserMessageId: "msg-alice-1", input: [{ type: "text", text: "hi" }] },
    aliceContext,
  );
  await new Promise((r) => setTimeout(r, 150));
  const history = await rpc("5", "thread/read", { threadId: parentId, includeTurns: true }, aliceContext);
  const userItems = history.thread.turns.flatMap((turn: any) =>
    turn.items.filter((i: any) => i.type === "userMessage"),
  );
  assert.equal(userItems.length, 1);
  assert.deepEqual(userItems[0].sender, { kind: "employee", loginName: "alice" });

  // Orchestration prepare + idempotent create spawns a deterministic Bridge child thread directly.
  const orchContext = {
    sender: null,
    orchestrationOperationId: "spawn-op-1",
    orchestrationCanAdmit: () => true,
  };
  const prepared = await rpc(
    "6",
    "opencraft/orchestration/prepare",
    { operationId: "spawn-op-1", threadId: parentId, arguments: { title: "Child worker" } },
    orchContext,
  );
  assert.equal(prepared.cwd, root);

  const child1 = await rpc(
    "7",
    "opencraft/orchestration/create",
    { operationId: "spawn-op-1", settings: prepared },
    orchContext,
  );
  const child2 = await rpc(
    "8",
    "opencraft/orchestration/create",
    { operationId: "spawn-op-1", settings: prepared },
    orchContext,
  );
  assert.equal(child1.threadId, child2.threadId);
  assert.match(child1.threadId, /^bridge:codex:orch-[0-9a-f]{32}$/);

  const childRead = await rpc("9", "thread/read", { threadId: child1.threadId, includeTurns: false }, aliceContext);
  assert.equal(childRead.thread.parentThreadId, "bridge:codex:parent");
});
