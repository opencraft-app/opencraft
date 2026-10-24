import assert from "node:assert/strict";
import test from "node:test";
import { createReplicaDatabaseIdentityMigration } from "../../packages/appserver-replica-storage-expo/src/database-identity";

const current = "opencraft-appserver-replica.db";

test("native identity migration probes only exact owned names, never imports into current state", async () => {
  const calls: string[] = [];
  const prepare = createReplicaDatabaseIdentityMigration({ exists(name) { calls.push(name); return name === current; }, async snapshot() { throw new Error("unexpected read"); }, async install() { throw new Error("unexpected write"); } });
  await prepare(current); assert.deepEqual(calls, [current]);
  calls.length = 0;
  for (const name of ["custom.db", "other-opencraft-appserver-replica.db"]) await prepare(name);
  assert.deepEqual(calls, []);
});

test("missing history leaves fresh creation to the normal database owner", async () => {
  let installed = false;
  const prepare = createReplicaDatabaseIdentityMigration({ exists: () => false, async snapshot() { throw new Error("missing source must not be opened"); }, async install() { installed = true; } });
  await prepare(current); assert.equal(installed, false);
});
