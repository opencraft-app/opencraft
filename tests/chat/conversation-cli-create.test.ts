import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const firstPending = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let createCount = 0, inputCount = 0, readable = true, admitted = true;
  let mode: "held" | "normal" | "unknown" | "lost-first" = "held";
  const capabilities = { metadata: true, read: true, boundedRead: true, create: true, queue: true, steer: true };
  const execution: ConversationExecutionPort = {
    hostId: "fixture",
    serverId,
    owns: (id) => id === serverId || id === otherServer,
    directory: () => ({ instanceId: "fixture", servers: [serverId, otherServer].map(id => ({
      serverId: id, label: "Fixture", engine: "codex", connectionState: "ready", capabilities,
    })) }),
    async create(target, content, operationKey, _context, rememberThread) {
      createCount++;
      if (mode === "unknown") return { operationKey, ref: null, creationState: "unknown", firstMessageState: "unknown" };
      const ref = { serverId: target.serverId, threadId: "thread-" + createCount };
      assert.equal(content, "synthetic input");
      await rememberThread!(ref);
      inputCount++;
      if (mode === "held") {
        firstPending.resolve();
        await releaseFirst.promise;
      }
      return { operationKey, ref, creationState: "created", firstMessageState: mode === "lost-first" ? "unknown" : "submitted" };
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
  assert.deepEqual([createCount, inputCount], [4, 3]);
  await deployment.close();
  deployment = await open();

  const restarted = deployment.service, restored = deployment.actor;
  for (const [key, result] of [["same", settled], ["allocate-lost", unknown], ["first-lost", firstLost]]) {
    assert.deepEqual(await restarted.command(restored, lookup(key)), { found: true, receipt: result });
    assert.deepEqual(await restarted.command(restored, create(key)), result);
  }
  assert.deepEqual([createCount, inputCount], [4, 3], "restart or lookup never resumes a mutation");
  readable = false;
  await assert.rejects(restarted.command(restored, lookup("same")), { status: 403 });
  admitted = false;
  await assert.rejects(restarted.command(restored, lookup("first-lost")), { status: 401 });
});
