import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openServerDatabase, SERVER_DATA_CONTRACT } from "@opencraft/storage-node/server";
import { openServerCoreOwner } from "@opencraft/storage-node/server-owner";
import { ActorStore } from "@opencraft/access-control/actors";

const principal = {
  provider: "fixture",
  subject: "owner-test",
  displayName: "Owner test",
  expiresAt: Number.MAX_SAFE_INTEGER,
};

// Stage 1 of docs/architecture/server/server-core-owner.md: the writer lock,
// migrations and import run in a Worker; the network thread joins the migrated
// database with its own connection for the domains that still run there.
test("the Server owner Worker holds the installation while the network thread uses its own connection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "server-core-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let storage = await openServerCoreOwner(directory);
  assert.equal(storage.outcome.appliedVersion, SERVER_DATA_CONTRACT.migrationVersion);
  assert.equal(storage.contract.hash, SERVER_DATA_CONTRACT.hash);
  await assert.rejects(openServerDatabase(directory), "the owner Worker holds the process writer lock");

  const actors = new ActorStore(storage);
  const context = actors.resolveHuman(principal);
  assert.ok(context, "domains on the network thread read and write through its connection");
  await storage.close();
  await storage.close();

  // Closing released the lock; the data written through the joined connection is durable.
  storage = await openServerCoreOwner(directory);
  try {
    assert.equal(storage.outcome.status, "up-to-date");
    assert.equal(new ActorStore(storage).resolveHuman(principal)?.actorId, context!.actorId);
  } finally {
    await storage.close();
  }
  const offline = await openServerDatabase(directory);
  await offline.close();
});

test("an installation the owner cannot open fails with its lifecycle error and leaves no lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "server-core-owner-busy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const holder = await openServerDatabase(directory);
  try {
    await assert.rejects(openServerCoreOwner(directory));
  } finally {
    await holder.close();
  }
  const storage = await openServerCoreOwner(directory);
  await storage.close();
});

// Domain services moved off the network thread run in the Headless owner
// Worker on the owner connection; the network thread only awaits their port.
test("the Headless owner Worker serves shared notes durably through its async port", async (t) => {
  const Y = await import("yjs");
  const directory = await mkdtemp(join(tmpdir(), "server-core-notes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = new URL("../../apps/headless-server/src/server-core-worker.mjs", import.meta.url);
  type Notes = {
    exchangeThreadNote(serverId: string, threadId: string, update: string, vector: string): { update: string };
  };
  const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  const empty = encode(Y.encodeStateVector(new Y.Doc()));
  const doc = new Y.Doc();
  doc.getText("markdown").insert(0, "shared");

  let storage = await openServerCoreOwner<Notes>(directory, { entry });
  await storage.call.exchangeThreadNote("server", "thread", encode(Y.encodeStateAsUpdate(doc)), empty);
  await assert.rejects(
    storage.call.exchangeThreadNote("server", "thread", "not base64!", empty),
    /Invalid note update/,
  );
  await storage.close();

  storage = await openServerCoreOwner<Notes>(directory, { entry });
  try {
    const { update } = await storage.call.exchangeThreadNote("server", "thread", "", empty);
    const reader = new Y.Doc();
    Y.applyUpdate(reader, Buffer.from(update, "base64"));
    assert.equal(reader.getText("markdown").toString(), "shared");
  } finally {
    await storage.close();
  }
});

test("creation receipt writes await the Server Worker while the main thread services timers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "server-core-create-receipts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = await openServerCoreOwner(directory);
  t.after(() => storage.close());
  const input = { actorId: "fixture-actor", serverId: "server", operationKey: "key", fingerprint: "hash" };
  let settled = false;
  storage.database.exec("BEGIN IMMEDIATE");
  const pending = storage.call.claimConversationCreation(input).finally(() => { settled = true; });
  try {
    await new Promise<void>(resolve => setTimeout(resolve, 60));
    assert.equal(settled, false);
  } finally {
    storage.database.exec("ROLLBACK");
  }
  try {
    assert.deepEqual(await pending, { kind: "fresh" });
    await storage.call.recordConversationAllocation(input, "allocated-thread");
    await storage.call.recordConversationFirstInput(input, "submitted");
    await assert.rejects(storage.call.recordConversationFirstInput(input, "first_rejected"), /did not advance/);
    assert.deepEqual(await storage.call.readConversationCreation(input), { state: "submitted", threadId: "allocated-thread" });
  } finally {
    await storage.close();
  }
});
