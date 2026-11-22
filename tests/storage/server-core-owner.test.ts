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
