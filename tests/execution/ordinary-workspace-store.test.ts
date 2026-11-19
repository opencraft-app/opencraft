import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { OrdinaryWorkspaceStore } from "../../apps/local-agent-host/src/ordinary-workspace-store";
const scope = { principalId: "alice", hostId: "host-a" },
  selection = "a".repeat(64);
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ordinary-workspaces-")),
    opened = new Set<OrdinaryWorkspaceStore>();
  t.after(async () => {
    for (const s of opened) await s.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    open: () => {
      const s = new OrdinaryWorkspaceStore(root, "deployment-a");
      opened.add(s);
      return s;
    },
    close: async (s: OrdinaryWorkspaceStore) => {
      await s.close();
      opened.delete(s);
    },
  };
}
test("idempotent admission isolates principal, Host, and creation intent", async (t) => {
  const f = await fixture(t),
    s = f.open();
  const a = await s.admit(scope, "intent-a", selection);
  assert.deepEqual(await s.admit(scope, "intent-a", selection), a);
  assert.notEqual((await s.admit({ ...scope, principalId: "bob" }, "intent-a", selection)).workspaceId, a.workspaceId);
  assert.notEqual((await s.admit({ ...scope, hostId: "host-b" }, "intent-a", selection)).workspaceId, a.workspaceId);
  assert.notEqual((await s.admit(scope, "intent-b", selection)).workspaceId, a.workspaceId);
  await assert.rejects(async () => await s.admit(scope, "intent-a", "b".repeat(64)), /conflict/);
  await assert.rejects(async () => await s.read({ ...scope, principalId: "bob" }, a.workspaceId), /not found/);
});
test("thread attach is immutable, scoped and unique within a Host", async (t) => {
  const f = await fixture(t),
    s = f.open();
  const a = await s.admit(scope, "a", selection),
    b = await s.admit(scope, "b", selection);
  await s.attachThread(scope, a.workspaceId, "thread-a");
  await s.attachThread(scope, a.workspaceId, "thread-a");
  assert.equal((await s.forThread(scope, "thread-a"))?.workspaceId, a.workspaceId);
  assert.equal(await s.forThread({ ...scope, principalId: "bob" }, "thread-a"), null);
  await assert.rejects(async () => await s.attachThread(scope, a.workspaceId, "thread-b"), /another thread/);
  await assert.rejects(async () => await s.attachThread(scope, b.workspaceId, "thread-a"));
  assert.equal((await s.read(scope, b.workspaceId)).threadId, null);
});
test("compute restart preserves workspace, fences stale callbacks and retains ambiguous outcomes", async (t) => {
  const f = await fixture(t),
    s = f.open(),
    row = await s.admit(scope, "intent", selection),
    lease = await s.beginCreate(scope, row.workspaceId);
  await s.confirmCreated(scope, lease, "instance-1");
  await s.beginRelease(scope, lease);
  await s.markUncertain(scope, lease);
  await f.close(s);
  const restarted = f.open();
  assert.equal((await restarted.read(scope, row.workspaceId)).instanceId, "instance-1");
  await assert.rejects(async () => await restarted.beginCreate(scope, row.workspaceId), /reconciliation/);
  await restarted.confirmComputeAbsent(scope, lease);
  const next = await restarted.beginCreate(scope, row.workspaceId);
  assert.equal(next.workspaceId, lease.workspaceId);
  assert.equal(next.generation, 2);
  await assert.rejects(async () => await restarted.confirmCreated(scope, lease, "old-instance"), /Stale/);
  await assert.rejects(async () => await restarted.confirmComputeAbsent(scope, lease), /Stale/);
  await restarted.confirmCreated(scope, next, "instance-2");
  assert.equal((await restarted.read(scope, row.workspaceId)).phase, "live");
  await assert.rejects(async () => await restarted.confirmComputeAbsent(scope, next), /Stale/);
});
test("two journal connections cannot acquire duplicate create ownership", async (t) => {
  const f = await fixture(t),
    a = f.open(),
    b = f.open(),
    row = await a.admit(scope, "intent", selection);
  assert.equal((await b.admit(scope, "intent", selection)).workspaceId, row.workspaceId);
  await a.beginCreate(scope, row.workspaceId);
  await assert.rejects(async () => await b.beginCreate(scope, row.workspaceId), /reconciliation/);
  assert.equal((await b.read(scope, row.workspaceId)).phase, "creating");
});
test("actual child-process restart retains identity and unknown create blocks retry", async (t) => {
  const f = await fixture(t),
    s = f.open(),
    row = await s.admit(scope, "intent", selection);
  await s.attachThread(scope, row.workspaceId, "thread-a");
  await s.beginCreate(scope, row.workspaceId);
  await f.close(s);
  const module = new URL("../../apps/local-agent-host/src/ordinary-workspace-store.ts", import.meta.url).href;
  const code = `import {OrdinaryWorkspaceStore} from ${JSON.stringify(module)};const s=new OrdinaryWorkspaceStore(${JSON.stringify(f.root)},'deployment-a');const scope=${JSON.stringify(scope)};const row=await s.forThread(scope,'thread-a');let blocked=false;try{await s.beginCreate(scope,row.workspaceId)}catch{blocked=true}console.log(JSON.stringify({row,blocked}));await s.close();`;
  const out = execFileSync(
    process.execPath,
    ["--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e", code],
    { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
  );
  const result = JSON.parse(out);
  assert.equal(result.row.workspaceId, row.workspaceId);
  assert.equal(result.row.generation, 1);
  assert.equal(result.row.phase, "creating");
  assert.equal(result.blocked, true);
});
test("deployment identity and private journal filesystem cannot be silently replaced", async (t) => {
  const f = await fixture(t),
    s = f.open();
  await s.admit(scope, "intent", selection);
  const wrongDeployment = new OrdinaryWorkspaceStore(f.root, "deployment-b");
  await assert.rejects(wrongDeployment.outcome, /deployment mismatch/);
  await assert.rejects(wrongDeployment.close(), /deployment mismatch/);
  const shared = join(f.root, "shared");
  mkdirSync(shared, { mode: 0o755 });
  const sharedOwner = new OrdinaryWorkspaceStore(shared, "deployment-a");
  await assert.rejects(sharedOwner.outcome, /private/);
  await assert.rejects(sharedOwner.close(), /private/);
  const linked = join(f.root, "linked");
  mkdirSync(linked, { mode: 0o700 });
  symlinkSync(join(f.root, "ordinary-workspaces.sqlite"), join(linked, "ordinary-workspaces.sqlite"));
  const linkedOwner = new OrdinaryWorkspaceStore(linked, "deployment-a");
  await assert.rejects(linkedOwner.outcome);
  await assert.rejects(linkedOwner.close());
});
test("private restart inventory includes pre-thread intents and reconstructs compute owner", async (t) => {
  const f = await fixture(t),
    s = f.open();
  const a = await s.admit(scope, "unbound", selection),
    b = await s.admit({ ...scope, principalId: "bob" }, "unbound", selection);
  const first = await s.beginCreate(scope, a.workspaceId);
  await s.beginCreate({ ...scope, principalId: "bob" }, b.workspaceId);
  await f.close(s);
  const reopened = f.open(),
    page = await reopened.pendingForHost(scope.hostId, "", 1);
  assert.equal(page.length, 1);
  const next = await reopened.pendingForHost(scope.hostId, page[0].binding.workspaceId, 1);
  assert.equal(next.length, 1);
  assert.equal((await reopened.pendingForHost(scope.hostId, next[0].binding.workspaceId, 1)).length, 0);
  assert.equal((await reopened.read(scope, a.workspaceId)).leaseOwner, first.owner);
  assert.equal((await reopened.read(scope, a.workspaceId)).threadId, null);
  await assert.rejects(
    async () => await reopened.confirmCreated(scope, { ...first, owner: "wrong" }, "instance"),
    /Stale/,
  );
  assert.deepEqual(await reopened.pendingForHost("other-host"), []);
});
test("Native dispatch is durable before response and compute deletion cannot unblock retry", async (t) => {
  const f = await fixture(t),
    s = f.open(),
    row = await s.admit(scope, "native-intent", selection),
    lease = await s.beginCreate(scope, row.workspaceId);
  await s.confirmCreated(scope, lease, "instance");
  await s.beginThreadStart(scope, lease);
  await assert.rejects(async () => await s.beginThreadStart(scope, lease), /reconciliation/);
  await assert.rejects(async () => await s.attachThread(scope, row.workspaceId, "bypass"), /reconciliation/);
  await s.beginRelease(scope, lease);
  await s.confirmComputeAbsent(scope, lease);
  await f.close(s);
  const restarted = f.open();
  await assert.rejects(
    async () => await restarted.beginCreate(scope, row.workspaceId),
    /Native thread creation requires reconciliation/,
  );
  assert.equal((await restarted.pendingForHost(scope.hostId)).length, 0);
  const pending = await restarted.pendingThreadStarts(scope.hostId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].binding.workspaceId, row.workspaceId);
  assert.equal((await restarted.pendingThreadStarts("other-host")).length, 0);
  assert.equal((await restarted.pendingThreadStarts(scope.hostId, row.workspaceId)).length, 0);
  await assert.rejects(
    async () => await restarted.confirmThreadStarted({ ...scope, principalId: "bob" }, lease, "native-thread"),
    /not found/,
  );
  await assert.rejects(
    async () => await restarted.confirmThreadStarted(scope, { ...lease, generation: 2 }, "native-thread"),
    /Stale/,
  );
  await restarted.confirmThreadStarted(scope, lease, "native-thread");
  await restarted.confirmThreadStarted(scope, lease, "native-thread");
  assert.equal((await restarted.pendingThreadStarts(scope.hostId)).length, 0);
  await assert.rejects(
    async () => await restarted.confirmThreadStarted(scope, lease, "another-thread"),
    /another thread/,
  );
  assert.equal((await restarted.beginCreate(scope, row.workspaceId)).generation, 2);
  await assert.rejects(async () => await restarted.confirmThreadStarted(scope, lease, "native-thread"), /Stale/);
});
test("two connections cannot dispatch twice; colliding Native receipt rolls back both records", async (t) => {
  const f = await fixture(t),
    a = f.open(),
    b = f.open(),
    row = await a.admit(scope, "native-intent", selection),
    lease = await a.beginCreate(scope, row.workspaceId);
  await assert.rejects(async () => await a.beginThreadStart(scope, lease), /Invalid/);
  await a.confirmCreated(scope, lease, "instance");
  await a.beginThreadStart(scope, lease);
  await assert.rejects(async () => await b.beginThreadStart(scope, lease), /reconciliation/);
  const other = await a.admit(scope, "other", selection);
  await a.attachThread(scope, other.workspaceId, "occupied");
  await assert.rejects(async () => await b.confirmThreadStarted(scope, lease, "occupied"));
  assert.equal((await a.read(scope, row.workspaceId)).threadId, null);
  assert.equal((await a.pendingThreadStarts(scope.hostId)).length, 1);
  await b.confirmThreadStarted(scope, lease, "correct");
  assert.equal((await a.forThread(scope, "correct"))?.workspaceId, row.workspaceId);
  await assert.rejects(async () => await a.beginThreadStart(scope, lease), /Invalid/);
});
test("separate process restart retains unresolved Native dispatch after compute release", async (t) => {
  const f = await fixture(t),
    s = f.open(),
    row = await s.admit(scope, "native-crash", selection),
    lease = await s.beginCreate(scope, row.workspaceId);
  await s.confirmCreated(scope, lease, "instance");
  await s.beginThreadStart(scope, lease);
  await s.beginRelease(scope, lease);
  await s.confirmComputeAbsent(scope, lease);
  await f.close(s);
  const module = new URL("../../apps/local-agent-host/src/ordinary-workspace-store.ts", import.meta.url).href;
  const code = `import {OrdinaryWorkspaceStore} from ${JSON.stringify(module)};const s=new OrdinaryWorkspaceStore(${JSON.stringify(f.root)},'deployment-a');let blocked=false;try{await s.beginCreate(${JSON.stringify(scope)},${JSON.stringify(row.workspaceId)})}catch{blocked=true}console.log(JSON.stringify({blocked,pending:(await s.pendingThreadStarts('host-a')).length}));await s.close();`;
  const out = execFileSync(
    process.execPath,
    ["--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e", code],
    { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
  );
  assert.deepEqual(JSON.parse(out), { blocked: true, pending: 1 });
});
