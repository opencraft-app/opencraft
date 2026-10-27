import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ThreadIdentityDatabase } from "../../apps/opencraft-daemon/src/thread-identity-database";
import { ThreadIdentity, readThreadMessageIds } from "../../apps/opencraft-daemon/src/thread-identity";
const employee = (loginName: string) => ({ kind: "employee" as const, loginName });
const context = (name: string) => ({ sender: employee(name), validUntil: Date.now() + 60_000 });
test("Hub metadata owner persists provenance and completion; rejects tampered/newer schemas without replacing data", async t => {
  const root = await mkdtemp(join(tmpdir(), "identity-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let owner = new ThreadIdentityDatabase(root);
  assert.equal(owner.outcome.status, "fresh");
  owner.database.prepare("INSERT INTO ioa_thread_creators VALUES(?,?)").run("legacy", "alice");
  owner.database.prepare("INSERT INTO ioa_presence_sync VALUES(?,?)").run("legacy", 12);
  const ledger = owner.database.prepare("SELECT * FROM schema_migrations").all(); owner.close();
  owner = new ThreadIdentityDatabase(root); assert.equal(owner.outcome.status, "up-to-date");
  assert.deepEqual(owner.database.prepare("SELECT * FROM schema_migrations").all(), ledger);
  assert.equal(owner.database.prepare("SELECT login_name FROM ioa_thread_creators WHERE thread_id='legacy'").get()?.login_name, "alice");
  owner.close();
  const path = join(root, "thread-identity.sqlite"), raw = new DatabaseSync(path);
  raw.exec("UPDATE schema_migrations SET checksum='tampered'"); raw.close();
  assert.throws(() => new ThreadIdentityDatabase(root), (error: any) => error.kind === "history-mismatch");
  const verify = new DatabaseSync(path); assert.equal(verify.prepare("SELECT login_name FROM ioa_thread_creators").get()?.login_name, "alice");
  verify.prepare("UPDATE schema_migrations SET version=99,checksum=? WHERE version=1").run(ledger[0].checksum as string); verify.close();
  assert.throws(() => new ThreadIdentityDatabase(root), (error: any) => error.kind === "newer-schema");
});

test("common history reconciliation is paginated, abortable and rejects repeated cursors", async () => {
  const pages: unknown[] = [{ data: [{ item: { type: "userMessage", clientId: "one" } }], nextCursor: "next" },
    { data: [{ item: { type: "userMessage", client_id: "two" } }, { item: { type: "agentMessage", clientId: "ignore" } }], nextCursor: null }];
  const calls: unknown[] = [];
  assert.deepEqual(await readThreadMessageIds(async (_method, params) => { calls.push(params); return pages.shift(); }, "t"), ["one", "two"]);
  assert.equal((calls[1] as any).cursor, "next");
  await assert.rejects(readThreadMessageIds(async () => ({ data: [], nextCursor: "same" }), "t"), /cursor/);
  await assert.rejects(readThreadMessageIds(async () => { throw Error("must not read"); }, "t", undefined, AbortSignal.abort()), /cancelled/);
});
