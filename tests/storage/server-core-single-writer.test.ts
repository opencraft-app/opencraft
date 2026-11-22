import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openServerCoreOwner } from "@opencraft/storage-node/server-owner";
import { parsePrincipal } from "@opencraft/identity-core";
import { ActorStore } from "../../packages/access-control/src/actors";
import { Collaboration } from "../../packages/access-control/src/collaboration";
import { ThreadOrchestrationLedger, type ThreadRelation } from "../../packages/access-control/src/orchestration-ledger";
import { OrchestrationRuntimeWorker } from "../../packages/access-control/src/orchestration-runtime-store";
import { ServerSpacesRuntime } from "../../packages/access-control/src/server-spaces-runtime";

// docs/architecture/server/server-core-owner.md: in Headless, orchestration,
// communication and Server spaces run on the Server core owner's connection.
const entry = new URL("../../apps/headless-server/src/server-core-worker.mjs", import.meta.url);
const snapshot = { threadId: "child", rootTurnId: "root", turnId: "turn", state: "active" as const };
/** Lets a call reach the owner Worker before the next one is issued. */
const posted = () => new Promise((resolve) => setImmediate(resolve));
const relation = (threadId: string): ThreadRelation => ({ threadId, serverId: "fixture-server", driverKind: "codex",
  ownerActorId: "fixture-actor", parentThreadId: null, lifecycleOwnerThreadId: null, forkedFromId: null, visibility: "visible",
  engineHostGeneration: null, nativeSessionId: null, runtimeStatus: "starting", rootTurnId: null, turnId: null,
  delegationRevision: 1, autoExchangeDepth: 0, hasDirectUserInput: false, userInputExcerpt: null });

/** Open handles on the Server database file across all threads of this process. */
async function serverDatabaseHandles(directory: string): Promise<number> {
  const target = join(directory, "opencraft-server.sqlite");
  let count = 0;
  for (const fd of await readdir("/proc/self/fd")) {
    try { if (await readlink(join("/proc/self/fd", fd)) === target) count++; } catch { /* closed meanwhile */ }
  }
  return count;
}

async function composition(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "server-core-single-writer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = await openServerCoreOwner(directory, { entry });
  // Domains not yet moved run on the transitional network-thread connection.
  const actors = new ActorStore(storage);
  const alice = actors.resolveHuman(parsePrincipal({ provider: "local", subject: "alice", displayName: "Alice", expiresAt: Date.now() + 600_000 })!)!;
  const bob = actors.resolveHuman(parsePrincipal({ provider: "local", subject: "bob", displayName: "Bob", expiresAt: Date.now() + 600_000 })!)!;
  new ThreadOrchestrationLedger(storage.database).createThread(relation("child"));
  const baseline = await serverDatabaseHandles(directory);
  const orchestration = new OrchestrationRuntimeWorker(storage);
  await orchestration.start();
  const spaces = new ServerSpacesRuntime({ owner: storage, ownerActorId: alice.actorId });
  await spaces.ready;
  const collaboration = new Collaboration(storage, actors, undefined, Date.now, () => true, orchestration);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await collaboration.close();
    await spaces.close();
    await orchestration.close();
    actors.close();
    await storage.close();
  };
  t.after(close);
  return { directory, storage, actors, alice, bob, orchestration, spaces, collaboration, baseline, close };
}

test("a Headless composition opens no Server database connection beyond the owner and the transitional one", async (t) => {
  if (process.platform !== "linux") return t.skip("reads /proc/self/fd");
  const f = await composition(t);
  // Owner Worker connection, the network thread's transitional connection, and
  // the descriptor SQLite keeps for the closed migration probe while locks are held.
  assert.ok(f.baseline <= 3, `baseline handles: ${f.baseline}`);
  await f.orchestration.observe(snapshot, 1000);
  const space = await f.spaces.command(f.alice, { action: "create", name: "Project" });
  assert.equal(f.spaces.directory(f.alice).spaces.some((s) => s.id === space.spaceId), true, "projection published with the reply");
  const group = await f.collaboration.communicate(f.alice, "opencraft/channels/group/create",
    { title: "Room", memberActorIds: [f.bob.actorId], clientRequestId: "room" });
  assert.ok(group.id, "communication commits on the owner connection");
  assert.equal(await f.collaboration.personalAssistantAssignments().then(() => true), true);
  assert.equal(await serverDatabaseHandles(f.directory), f.baseline,
    "orchestration, communication and spaces add no connection to the Server database");

  // The probe detects connections: a standalone Worker would be one more.
  const standalone = new OrchestrationRuntimeWorker(join(f.directory, "opencraft-server.sqlite"));
  await standalone.start();
  try {
    assert.equal(await serverDatabaseHandles(f.directory), f.baseline + 1);
  } finally {
    await standalone.close();
  }
});

test("a long orchestration command queues spaces and core writes in FIFO instead of contending for the lock", async (t) => {
  const f = await composition(t);
  await f.orchestration.observe(snapshot, 1000);
  // Fixture-only slow write: the trigger keeps one orchestration statement busy.
  const fixture = new DatabaseSync(join(f.directory, "opencraft-server.sqlite"));
  fixture.exec("PRAGMA foreign_keys=OFF");
  fixture.exec(`CREATE TRIGGER fixture_slow_ack AFTER DELETE ON opencraft_orchestration_acks BEGIN
    SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) SELECT x FROM c);
  END`);
  fixture.exec("INSERT INTO opencraft_orchestration_acks(operation_id) VALUES ('slow')");
  fixture.close();
  const order: string[] = [];
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  t.after(() => clearInterval(timer));
  const started = performance.now();
  const slow = f.orchestration.acknowledge("slow").then(() => { order.push("orchestration"); return performance.now() - started; });
  await posted();
  const space = f.spaces.command(f.alice, { action: "create", name: "Queued" }).then((value) => { order.push("spaces"); return value; });
  await posted();
  const note = f.storage.call.exchangeThreadNote("server", "thread", "", "AA==").then(() => { order.push("core"); });
  await posted();
  const observe = f.orchestration.observe({ ...snapshot, state: "completed" }, 2000).then(() => { order.push("orchestration-2"); });
  const [slowMs, created] = await Promise.all([slow, space, note, observe]);
  clearInterval(timer);
  assert.deepEqual(order, ["orchestration", "spaces", "core", "orchestration-2"], "one owner commits in arrival order");
  assert.ok(slowMs > 50, `the fixture write held the owner (${slowMs} ms)`);
  assert.ok(ticks > 3, "the network thread kept servicing timers while the owner wrote");
  assert.ok(f.spaces.directory(f.alice).spaces.some((s) => s.id === created.spaceId));
  assert.equal(f.storage.database.prepare("SELECT count(*) AS n FROM opencraft_orchestration_acks").get()!.n, 0);
});

test("closing drains queued orchestration, spaces and core writes in order before releasing the owner", async (t) => {
  const f = await composition(t);
  const order: string[] = [];
  const writes: Promise<unknown>[] = [];
  writes.push(f.orchestration.observe(snapshot, 1000).then(() => order.push("observe")));
  await posted();
  writes.push(f.spaces.command(f.alice, { action: "create", name: "Drained" }).then(() => order.push("spaces")));
  await posted();
  writes.push(f.storage.call.exchangeThreadNote("server", "thread", "", "AA==").then(() => order.push("core")));
  await posted();
  writes.push(f.orchestration.observe({ ...snapshot, state: "completed" }, 2000).then(() => order.push("completed")));
  // Seal the ports at once; they drain, and the owner closes last, after every queued write.
  await posted();
  const ports = [f.spaces.close(), f.orchestration.close()];
  await assert.rejects(f.orchestration.observe(snapshot, 3000), /closing/);
  await assert.rejects(f.spaces.command(f.alice, { action: "create", name: "Late" }), /unavailable/);
  const owner = f.close();
  await Promise.all([...writes, ...ports, owner]);
  assert.deepEqual(order, ["observe", "spaces", "core", "completed"]);

  const reopened = await openServerCoreOwner(f.directory, { entry });
  try {
    const ledger = new ThreadOrchestrationLedger(reopened.database);
    assert.equal(ledger.runtimeSnapshot("child")?.state, "completed");
    assert.equal(reopened.database.prepare("SELECT count(*) AS n FROM collaboration_spaces WHERE name='Drained'").get()!.n, 1);
  } finally {
    await reopened.close();
  }
});
