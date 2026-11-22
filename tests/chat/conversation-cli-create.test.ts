import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { AppHostServer } from "@opencraft/app-host-server";
import { createRoutedConversationExecution } from "@opencraft/access-control/conversation-execution";
import { ActorStore } from "../../packages/access-control/src/actors";
import { openServerCoreOwner } from "@opencraft/storage-node/server-owner";
import { Collaboration, type ConversationExecutionPort } from "../../packages/access-control/src/collaboration";
import { CollaborationClient } from "../../packages/appserver-client/src/collaboration";
import { COLLABORATION_CAPABILITIES } from "@opencraft/appserver-protocol/collaboration";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { run } from "../../apps/opencraft-cli/src/main";

test("create resolves Server project roots, preserves the Actor lane and returns the known thread after uncertain first input", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cli-create-"));
  const root = join(dir, "repo"),
    outside = join(dir, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  await symlink(outside, join(root, "escape"));
  const actors = new ActorStore(join(dir, "actors.sqlite"), Date.now, {
    policy: ({ capability }) => capability !== "conversation.create" || allowed,
  });
  let allowed = true,
    loseFirst = false,
    admitted = true;
  const actor = actors.resolveHuman({
    provider: "local",
    subject: "fixture",
    displayName: "Fixture",
    expiresAt: Date.now() + 60_000,
  })!;
  const serverId = "server:fixture:codex";
  const operations: { hostId: string; method: string; params: Record<string, unknown>; actorId: string | undefined }[] =
    [];
  const host = new AppHostServer({
    logicalClientRouting: true,
    physicalHostLifetime: "server",
    createTransport(hostId) {
      const listeners = new Set<(raw: string) => void>();
      const emit = (message: unknown) => {
        for (const listener of listeners) listener(JSON.stringify(message));
      };
      const handle = (raw: string, actorId?: string) => {
        const packet = JSON.parse(raw),
          { id, method, params, __opencraftClient } = packet;
        if (id === undefined) return;
        if (method !== "initialize") operations.push({ hostId, method, params, actorId });
        const result =
          method === "project/list"
            ? { data: [{ id: "project", roots: [{ path: root }] }], nextCursor: null }
            : method === "thread/start"
              ? { thread: { id: "created-thread", ephemeral: false } }
              : method === "turn/start"
                ? { turn: { id: "first-turn" } }
                : {};
        if (method === "turn/start" && loseFirst)
          emit({ id, __opencraftClient, error: { code: -32000, data: { resultUnknown: true } } });
        else emit({ id, __opencraftClient, result });
      };
      return {
        status: { state: "open" },
        async connect() {},
        async close() {},
        subscribeStatus() {
          return () => {};
        },
        subscribeMessage(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async send(raw) {
          handle(raw);
        },
        async sendWithContext(raw, context) {
          handle(raw, context.actorContext?.actorId);
        },
      };
    },
  });
  const execution = createRoutedConversationExecution(() => host, { machineId: "fixture", engines: ["pi"] });
  const service = new Collaboration(join(dir, "collaboration.sqlite"), actors, execution, Date.now, () => admitted);
  t.after(async () => {
    await service.close();
    await host.close();
    actors.close();
    await rm(dir, { recursive: true, force: true });
  });
  const body = {
    action: "create",
    serverId,
    projectId: "project",
    content: "first message",
    operationKey: "correlation",
    initialPermissionMode: "accept-edits",
  };
  allowed = false;
  await assert.rejects(service.command(actor, body), { status: 403 });
  allowed = true;
  admitted = false;
  await assert.rejects(service.command(actor, body), { status: 401 });
  admitted = true;
  await assert.rejects(service.command(actor, { ...body, initialPermissionMode: "never" }), { status: 400 });
  await assert.rejects(service.command(actor, { ...body, serverId: "server:fixture:pi" }), {
    code: "unsupported_capability",
  });
  assert.deepEqual(operations, []);
  await assert.rejects(service.command(actor, { ...body, cwd: join(root, "escape") }), { code: "invalid_cwd" });
  assert.deepEqual(
    operations.map((row) => row.method),
    ["project/list"],
  );
  operations.length = 0;

  const capabilities = { ...COLLABORATION_CAPABILITIES };
  assert.equal(Object.hasOwn(capabilities, "createLookup"), false);
  let disconnect = false,
    creates = 0;
  const client = new CollaborationClient(
    new MemoryTransport({
      server: {
        async receive(frame, peer) {
          const packet = JSON.parse(frame);
          if (packet.id === undefined) return;
          if (packet.method === "initialize") {
            peer.send(
              JSON.stringify({
                id: packet.id,
                result: { capabilities: { extensions: { "opencraft/collaboration": capabilities } } },
              }),
            );
            return;
          }
          if (packet.params.action === "create") creates++;
          const result = await service.command(actor, packet.params);
          if (disconnect) peer.close("dropped creation response");
          else peer.send(JSON.stringify({ id: packet.id, result }));
        },
      },
    }),
  );
  await client.connect();
  t.after(() => client.close());
  const target = { serverId, projectId: "project", initialPermissionMode: "accept-edits" } as const;
  const ref = { serverId, threadId: "created-thread" };
  assert.deepEqual(await client.create(target, "first message", "one"), {
    operationKey: "one",
    ref,
    creationState: "created",
    firstMessageState: "submitted",
  });
  assert.deepEqual(
    operations.map((row) => [row.hostId, row.method, row.actorId]),
    [
      ["opencraft-server", "project/list", actor.actorId],
      ["local-codex", "thread/start", actor.actorId],
      ["local-codex", "turn/start", actor.actorId],
    ],
  );
  assert.deepEqual(operations[1]!.params, {
    cwd: root,
    runtimeWorkspaceRoots: [root],
    projectId: "project",
    permissions: "opencraft:permission-mode:accept-edits",
  });
  assert.equal(operations[2]!.params.threadId, ref.threadId);

  loseFirst = true;
  assert.deepEqual(await client.create({ serverId, cwd: root }, "first message", "two"), {
    operationKey: "two",
    ref,
    creationState: "created",
    firstMessageState: "unknown",
  });
  disconnect = true;
  await assert.rejects(client.create(target, "first message", "three"));
  assert.equal(creates, 3, "a transport loss does not trigger a lookup or mutation retry");
  assert.equal(operations.filter((row) => row.method === "thread/start").length, 3);
  let revoked = false;
  await assert.rejects(execution.create!({ serverId, cwd: root }, "revoked", "fenced", {
    sender: null, actorContext: actor,
    resourceOwner: { id: "fixture", assertCurrent() {
      if (revoked) throw Object.assign(Error("expired"), { status: 403 });
    } },
  }, async () => { revoked = true; }), { status: 403 });
  assert.equal(operations.filter((row) => row.method === "thread/start").length, 4);
  assert.equal(operations.filter((row) => row.method === "turn/start").length, 3, "local revocation never dispatches or fakes a native reply");

});

test("create and tail reject invalid arguments before opening an SSH profile", async () => {
  for (const args of [
    ["thread", "create", "hello"],
    ["thread", "create", "", "--cwd", "/tmp"],
    ["thread", "create", "hello", "--cwd", "/tmp", "--permission-mode", "never"],
    ["thread", "log", "ref", "--tail", "1", "--cursor", "cursor"],
    ["thread", "log", "ref", "--tail", "6"],
    ["thread", "log", "ref", "--tail", "1e0"],
  ])
    await assert.rejects(run(args), { code: "INVALID_ARGUMENTS" });
});

test("creation lookup records Actor-scoped custody before first input and never replays an unknown or settled operation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cli-create-receipts-"));
  const serverId = "server:fixture:codex";
  const otherServer = "server:fixture:alternate";
  const principal = (subject: string) => ({
    provider: "local", subject, displayName: subject, expiresAt: Date.now() + 60_000,
  });
  const allocationPending = Promise.withResolvers<void>();
  const releaseAllocation = Promise.withResolvers<void>();
  const firstPending = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let createCount = 0, inputCount = 0, readable = true, admitted = true;
  let mode: "held" | "normal" | "unknown" | "lost-first" | "local-fence" | "allocation-rejected" | "first-rejected" = "held";
  const capabilities = { metadata: true, read: true, boundedRead: true, create: true, queue: true, steer: true };
  const execution: ConversationExecutionPort = {
    hostId: "fixture",
    serverId,
    owns: (id) => id === serverId || id === otherServer,
    directory: () => ({ instanceId: "fixture", servers: [serverId, otherServer].map(id => ({
      serverId: id, label: "Fixture", engine: "codex", connectionState: "ready", capabilities,
    })) }),
    async create(target, content, operationKey, context, rememberThread) {
      createCount++;
      if (mode === "held") {
        allocationPending.resolve();
        await releaseAllocation.promise;
      }
      if (mode === "local-fence") {
        admitted = false;
        context.resourceOwner!.assertCurrent();
      }
      if (mode === "allocation-rejected") throw Object.assign(Error("conversation_unavailable"), { status: 404, code: "conversation_unavailable" });
      if (mode === "unknown") return { operationKey, ref: null, creationState: "unknown", firstMessageState: "unknown" };
      const ref = { serverId: target.serverId, threadId: "thread-" + createCount };
      assert.equal(content, "synthetic input");
      await rememberThread!(ref);
      inputCount++;
      if (mode === "held") {
        firstPending.resolve();
        await releaseFirst.promise;
      }
      return { operationKey, ref, creationState: "created", firstMessageState: mode === "lost-first" ? "unknown" : mode === "first-rejected" ? "rejected" : "submitted" };
    },
    async validate() {},
    async receipt() { return null; },
    async add() { return null; },
    async steer() {},
    async cancel() { return false; },
  };
  const open = async () => {
    const owner = await openServerCoreOwner(root);
    const actors = new ActorStore(owner);
    const actor = actors.resolveHuman(principal("first"))!;
    const other = actors.resolveHuman(principal("second"))!;
    const service = new Collaboration(owner, actors, execution, Date.now, () => admitted, undefined, () => readable, owner.call);
    return { actor, other, service, async close() { await service.close(); actors.close(); await owner.close(); } };
  };
  let deployment = await open();
  t.after(async () => {
    releaseAllocation.resolve();
    releaseFirst.resolve();
    await deployment.close();
    await rm(root, { recursive: true, force: true });
  });
  const create = (operationKey: string) => ({ action: "create", serverId, operationKey, cwd: root, content: "synthetic input" });
  const lookup = (operationKey: string) => ({ action: "createLookup", serverId, operationKey });
  const { service, actor, other } = deployment;
  assert.equal(service.capabilities.createLookup, true);
  assert.equal(service.servers(actor).servers[0]!.capabilities.createLookup, true);
  const started = service.command(actor, create("same"));
  await allocationPending.promise;
  const claimed = await service.command(actor, lookup("same"));
  assert.deepEqual(claimed.receipt, { operationKey: "same", ref: null, creationState: "unknown", firstMessageState: "unknown" });
  assert.deepEqual(await service.command(actor, create("same")), claimed.receipt);
  await assert.rejects(service.command(actor, { ...create("same"), content: "different" }), { code: "idempotency_key_reused" });
  await assert.rejects(service.command(actor, { ...create("same"), serverId: otherServer }), { code: "idempotency_key_reused" });
  assert.equal(createCount, 1);
  assert.equal(inputCount, 0);
  releaseAllocation.resolve();
  await firstPending.promise;
  const checkpoint = await service.command(actor, lookup("same"));
  assert.equal(checkpoint.receipt.creationState, "created");
  assert.equal(checkpoint.receipt.firstMessageState, "unknown");
  const replays = await Promise.all(Array.from({ length: 4 }, () => service.command(actor, create("same"))));
  assert.deepEqual(replays, Array(4).fill(checkpoint.receipt));
  await assert.rejects(service.command(actor, { ...create("same"), content: "different" }), { code: "idempotency_key_reused" });
  await assert.rejects(service.command(actor, { ...create("same"), serverId: otherServer }), { code: "idempotency_key_reused" });
  assert.equal((await service.command(actor, { ...lookup("same"), serverId: otherServer })).found, false);
  assert.equal((await service.command(other, lookup("same"))).found, false);
  assert.equal(createCount, 1);
  releaseFirst.resolve();
  const settled = await started;
  assert.equal(settled.firstMessageState, "submitted");
  mode = "normal";
  assert.notDeepEqual((await service.command(other, create("same"))).ref, settled.ref);

  mode = "unknown";
  const unknown = await service.command(actor, create("allocate-lost"));
  assert.equal(unknown.creationState, "unknown");
  mode = "lost-first";
  const firstLost = await service.command(actor, create("first-lost"));
  assert.equal(firstLost.creationState, "created");
  assert.equal(firstLost.firstMessageState, "unknown");
  mode = "local-fence";
  await assert.rejects(service.command(actor, create("local-fence")), { status: 401 });
  admitted = true;
  const localFence = (await service.command(actor, lookup("local-fence"))).receipt;
  assert.equal(localFence.creationState, "unknown");
  mode = "allocation-rejected";
  await assert.rejects(service.command(actor, create("allocation-rejected")), { status: 404, code: "conversation_unavailable" });
  mode = "first-rejected";
  const firstRejected = await service.command(actor, create("first-rejected"));
  assert.equal(firstRejected.firstMessageState, "rejected");
  assert.deepEqual([createCount, inputCount], [7, 4]);
  await deployment.close();
  deployment = await open();

  const restarted = deployment.service, restored = deployment.actor;
  for (const [key, result] of [["same", settled], ["allocate-lost", unknown], ["first-lost", firstLost], ["local-fence", localFence], ["first-rejected", firstRejected]]) {
    assert.deepEqual(await restarted.command(restored, lookup(key)), { found: true, receipt: result });
    assert.deepEqual(await restarted.command(restored, create(key)), result);
  }
  assert.deepEqual(await restarted.command(restored, lookup("allocation-rejected")), { found: true, receipt: {
    operationKey: "allocation-rejected", ref: null, creationState: "rejected", firstMessageState: "unknown", rejectionCode: "conversation_unavailable",
  } });
  await assert.rejects(restarted.command(restored, create("allocation-rejected")), { status: 404, code: "conversation_unavailable" });
  assert.deepEqual([createCount, inputCount], [7, 4], "restart or lookup never resumes a mutation");
  readable = false;
  await assert.rejects(restarted.command(restored, lookup("same")), { status: 403 });
  admitted = false;
  await assert.rejects(restarted.command(restored, lookup("first-lost")), { status: 401 });
});

test("the CLI saves generated creation keys and reads a disconnected operation without a reference", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cli-create-wire-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(join(root, "ssh"), `#!/usr/bin/env node
const socket = require("node:net").connect(${address.port}, "127.0.0.1");
process.stdin.pipe(socket).pipe(process.stdout);
socket.on("error", () => process.exit(1));
`, { mode: 0o700 });
  const configPath = join(root, "connections.json");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, defaultConnection: "fixture", connections: {
    fixture: { sshAlias: "cli-fixture", instanceId: "fixture", defaultServer: "codex" },
  } }));
  const env = { ...process.env, PATH: [root, process.env.PATH].join(delimiter), OPENCRAFT_CONFIG: configPath };
  delete env.OPENCRAFT_THREAD_CLI;
  delete env.OPENCRAFT_THREAD_CLI_CONNECTION;
  const invoke = promisify(execFile);
  const cli = async (args: string[], expected = 0) => {
    const processArgs = ["--import", "tsx", fileURLToPath(new URL("../../apps/opencraft-cli/src/main.ts", import.meta.url)), ...args, "--json"];
    try {
      const { stdout } = await invoke(process.execPath, processArgs, { env, timeout: 10_000 });
      assert.equal(expected, 0);
      return JSON.parse(stdout).data;
    } catch (cause) {
      const error = cause as { code: number; stdout: string; stderr: string };
      assert.equal(error.code, expected, error.stderr);
      return JSON.parse(error.stdout).error;
    }
  };
  let drop = true, legacy = false, actor = "first", createCalls = 0, allocations = 0;
  const ref = { serverId: "codex", threadId: "known-thread" };
  const receipts = new Map<string, object>();
  const seenRecords: string[] = [];
  server.on("connection", socket => {
    socket.on("message", async raw => {
      const request = JSON.parse(raw.toString());
      if (request.id === undefined) return;
      const result = (value: unknown) => socket.send(JSON.stringify({ id: request.id, result: value }));
      if (request.method === "initialize") {
        result({ capabilities: { extensions: { "opencraft/collaboration": { ...COLLABORATION_CAPABILITIES, ...(!legacy ? { createLookup: true } : {}) } } } });
        return;
      }
      const params = request.params;
      if (params.action === "servers") {
        result({ instanceId: "fixture", actor: { id: actor }, servers: [{ serverId: "codex", capabilities: { create: true, createLookup: !legacy } }] });
        return;
      }
      const key = actor + ":" + params.operationKey;
      if (params.action === "createLookup") {
        result(receipts.has(key) ? { found: true, receipt: receipts.get(key) } : { found: false });
        return;
      }
      createCalls++;
      const stored = receipts.get(key);
      if (stored) { result(stored); return; }
      allocations++;
      const receipt = { operationKey: params.operationKey, ref, creationState: "created", firstMessageState: params.operationKey === "reject-first" ? "rejected" : "submitted" };
      receipts.set(key, receipt);
      if (drop) {
        const path = join(root, "operations", "create-" + params.operationKey + ".json");
        seenRecords.push(await readFile(path, "utf8").catch(() => ""));
        socket.terminate();
      } else result(receipt);
    });
  });

  const create = ["thread", "create", "synthetic first input", "--cwd", root];
  const lost = await cli(create, 7);
  assert.equal(lost.code, "CREATE_OUTCOME_UNKNOWN");
  const key = lost.details.operationKey;
  assert.deepEqual(await readdir(join(root, "operations")), ["create-" + key + ".json"]);
  assert.equal(seenRecords.length, 1);
  assert.equal(JSON.parse(seenRecords[0]!).operationKey, key);
  assert.equal(seenRecords[0]!.includes("synthetic first input"), false);
  const lookup = ["thread", "lookup", "--key", key];
  assert.equal((await cli(lookup)).receipt.reference, "opencraft://conversation/v1/codex/known-thread");
  actor = "other";
  assert.equal((await cli(lookup)).found, false);
  actor = "first";
  drop = false;
  assert.deepEqual((await cli([...create, "--key", key])).ref, ref);
  assert.deepEqual([createCalls, allocations], [2, 1]);
  const rejected = await cli([...create, "--key", "reject-first"], 8);
  assert.equal(rejected.code, "FIRST_MESSAGE_REJECTED");
  assert.deepEqual(rejected.details.ref, ref);

  legacy = true;
  assert.equal((await cli(create)).firstMessageState, "submitted");
  assert.equal((await cli(lookup, 6)).code, "UNSUPPORTED_CAPABILITY");
  assert.deepEqual(await readdir(join(root, "operations")), ["create-" + key + ".json"]);
});
