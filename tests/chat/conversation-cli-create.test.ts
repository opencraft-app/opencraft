import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppHostServer } from "@opencraft/app-host-server";
import { createRoutedConversationExecution } from "@opencraft/access-control/conversation-execution";
import { ActorStore } from "../../packages/access-control/src/actors";
import { Collaboration } from "../../packages/access-control/src/collaboration";
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
