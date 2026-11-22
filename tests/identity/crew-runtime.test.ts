import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "../../packages/access-control/src/actors";
import { Collaboration } from "../../packages/access-control/src/collaboration";
import { ServerSpacesLedger } from "../../packages/access-control/src/server-spaces-ledger";
const { createPersonalAssistantHost } = await import("../../apps/personal-assistant/src/runtime/host-supervisor.mjs");

async function waitFor(predicate: () => Promise<boolean> | boolean, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("Expected state not reached");
}

// The real Host spawns the real assistant process; the deterministic fixture stands in for a model.
test("a member messages a space Bot: the Host-run Bot takes the work, answers on the chain and finishes it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crew-runtime-")),
    storage = await openServerDatabase(directory),
    actors = new ActorStore(storage),
    service = new Collaboration(storage, actors);
  const human = (name: string) =>
    actors.resolveHuman({ provider: "local", subject: name, displayName: name, expiresAt: Date.now() + 600000 })!;
  const alice = human("Alice"),
    bob = human("Bob");
  let host: any;
  t.after(async () => {
    await host?.close();
    await service.close();
    actors.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });

  await service.personalAssistant(alice, "opencraft/personal-assistant/claim");
  const created = (await service.personalAssistant(alice, "opencraft/personal-assistant/bots/create", {
    name: "Alan",
    duties: "Release notes",
    environment: { kind: "local" },
    clientRequestId: "alan",
  })) as { assistant: { actorId: string; binding: { botId: string } } };
  const alan = created.assistant;
  const ledger = new ServerSpacesLedger(storage.database);
  ledger.bootstrap(alice.actorId, []);
  const team = (ledger.command(alice, { action: "create", name: "Team" }) as { spaceId: string }).spaceId;
  const code = (ledger.command(alice, { action: "invite", spaceId: team }) as { code: string }).code;
  ledger.command(bob, { action: "join", code });
  ledger.command(alice, { action: "addBot", spaceId: team, actorId: alan.actorId });

  host = await (createPersonalAssistantHost as any)({
    directory,
    service,
    intervalMs: 30,
    readConfig: async () => ({ maxRuntimes: 3, profileOptions: { mode: "fixture", telemetry: { enabled: false } } }),
  });
  await waitFor(() => host.state(alan.binding.botId).phase === "running");

  const sent = (await service.communicate(bob, "send", {
    targetActorId: alan.actorId,
    content: "看看 2.3 的发布说明",
    idempotencyKey: "bob-1",
  })) as { messageId: string };
  const work = storage.database.prepare("SELECT id FROM crew_work WHERE message_id=?").get(sent.messageId) as
    { id: string } | undefined;
  assert.ok(work, "the message opened crew work");
  const state = () =>
    String(
      (storage.database.prepare("SELECT state FROM crew_work WHERE id=?").get(work.id) as { state: string }).state,
    );

  const between = () =>
    (
      storage.database
        .prepare(
          "SELECT COUNT(*) AS n FROM actor_messages WHERE (author_id=? AND target_id=?) OR (author_id=? AND target_id=?)",
        )
        .get(bob.actorId, alan.actorId, alan.actorId, bob.actorId) as { n: number }
    ).n;
  await waitFor(() => between() === 2);
  await waitFor(() => state() === "closed");
  const replies = storage.database
    .prepare("SELECT author_id,target_id FROM actor_messages WHERE author_id=?")
    .all(alan.actorId) as { author_id: string; target_id: string }[];
  assert.deepEqual(
    replies.map((r) => r.target_id),
    [bob.actorId],
    "the Bot answered the member who gave it the work, once",
  );

  // The Bot's own owner keeps a private line: no crew work, the reply comes back as before.
  const before = (storage.database.prepare("SELECT COUNT(*) AS n FROM crew_work").get() as { n: number }).n;
  await service.communicate(alice, "send", { targetActorId: alan.actorId, content: "你好", idempotencyKey: "alice-1" });
  assert.equal((storage.database.prepare("SELECT COUNT(*) AS n FROM crew_work").get() as { n: number }).n, before);
  await waitFor(
    () =>
      (
        storage.database
          .prepare("SELECT COUNT(*) AS n FROM actor_messages WHERE author_id=? AND target_id=?")
          .get(alan.actorId, alice.actorId) as { n: number }
      ).n === 1,
  );

  // The desk: any member of the space can look at the Bot's working session, read through the Host.
  const desk = await service.crewDesk(alice, { botId: alan.actorId });
  assert.deepEqual(desk.environment, { kind: "local" });
  assert.deepEqual(
    desk.conversations.map((c) => c.actor.actorId),
    [bob.actorId],
    "one conversation per dispatcher; the owner's private line is not on the desk",
  );
  assert.deepEqual(
    desk.selected?.messages.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.match(desk.selected!.messages[0]!.text, /看看 2\.3 的发布说明/);
  assert.ok(!JSON.stringify(desk).includes("你好"));
  assert.deepEqual(desk.operations, [], "the Bot's owner sees its operations; the fixture made none");
  assert.equal(
    (await service.crewDesk(bob, { botId: alan.actorId })).operations,
    undefined,
    "a member who owns neither the Bot nor the team does not see its operations",
  );
  const carol = human("Carol");
  await assert.rejects(
    service.crewDesk(carol, { botId: alan.actorId }),
    /crew_work_denied/,
    "outside the space there is no desk",
  );
  await host.close();
  host = undefined;
  await assert.rejects(
    service.crewDesk(alice, { botId: alan.actorId }),
    /crew_desk_unavailable/,
    "a stopped Bot shows no desk; nothing is read from its files",
  );
});

// The Core checks what a separately running Bot reports before any of it reaches a client.
test("desk operations reach only the owner, checked and mapped by the Core", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crew-operations-")),
    storage = await openServerDatabase(directory),
    actors = new ActorStore(storage),
    service = new Collaboration(storage, actors);
  t.after(async () => {
    await service.close();
    actors.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  const human = (name: string) =>
    actors.resolveHuman({ provider: "local", subject: name, displayName: name, expiresAt: Date.now() + 600000 })!;
  const alice = human("Alice"),
    bob = human("Bob"),
    carol = human("Carol");
  await service.personalAssistant(alice, "opencraft/personal-assistant/claim");
  const alan = ((await service.personalAssistant(alice, "opencraft/personal-assistant/bots/create", {
    name: "Alan", duties: "Release notes", environment: { kind: "local" }, clientRequestId: "alan",
  })) as { assistant: { actorId: string } }).assistant;
  const ledger = new ServerSpacesLedger(storage.database);
  ledger.bootstrap(alice.actorId, []);
  const team = (ledger.command(alice, { action: "create", name: "Team" }) as { spaceId: string }).spaceId;
  for (const who of [bob, carol]) ledger.command(who, { action: "join", code: (ledger.command(alice, { action: "invite", spaceId: team }) as { code: string }).code });
  ledger.command(alice, { action: "addBot", spaceId: team, actorId: alan.actorId });

  const asked: Record<string, unknown>[] = [];
  let reported: unknown[] = [
    { id: "c1", tool: "environment_run", summary: "git status", at: 1, workId: "w1", actorId: carol.actorId },
    { id: "c2", tool: "crew_message", summary: "done", at: 2, workId: "w2", actorId: "someone-who-left", targetId: carol.actorId },
  ];
  service.attachPersonalAssistantHost({
    state: () => ({ phase: "running" }) as never,
    wake: () => undefined,
    desk: async (_botId: string, _epoch: string, params: Record<string, unknown>) => {
      asked.push(params);
      return { conversations: [], selected: null, operations: reported };
    },
  } as never);

  const forAlice = await service.crewDesk(alice, { botId: alan.actorId });
  assert.deepEqual(asked.at(-1), { operations: true }, "the owner asks the Bot for operations");
  assert.deepEqual(forAlice.operations, [
    { id: "c1", tool: "environment_run", summary: "git status", at: 1, onBehalfOf: { actorId: carol.actorId, displayName: "Carol", kind: "human" } },
    { id: "c2", tool: "crew_message", summary: "done", at: 2, onBehalfOf: null, to: { actorId: carol.actorId, displayName: "Carol", kind: "human" } },
  ]);
  for (const member of [bob, carol]) {
    assert.equal((await service.crewDesk(member, { botId: alan.actorId })).operations, undefined);
    assert.deepEqual(asked.at(-1), {}, "a plain member's read does not ask for operations");
  }

  reported = [{ id: "c3", tool: "read_memory_file", summary: "notes.md", at: 3, actorId: carol.actorId }];
  await assert.rejects(service.crewDesk(alice, { botId: alan.actorId }), /crew_desk_invalid/, "an unknown tool is refused, not passed on");
});
