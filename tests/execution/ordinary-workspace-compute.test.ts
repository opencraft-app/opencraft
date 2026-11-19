import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrdinaryWorkspaceStore } from "../../apps/local-agent-host/src/ordinary-workspace-store";
import {
  OrdinaryWorkspaceCompute,
  OrdinaryWorkspaceAdmissionRejected,
  type WorkspaceAllocation,
} from "../../apps/local-agent-host/src/ordinary-workspace-compute";
const authority = { principalId: "alice", hostId: "host" };
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "workspace-compute-")),
    store = new OrdinaryWorkspaceStore(root, "test"),
    owner = new OrdinaryWorkspaceCompute(store);
  t.after(async () => {
    await owner.close().catch(() => {});
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const workspaceId = (await store.admit(authority, "intent", "a".repeat(64))).workspaceId;
  let closes = 0;
  const allocation: WorkspaceAllocation = {
    instanceId: "instance",
    environment: {
      resources: { cpuMillis: 1000, memoryBytes: 1024 },
      capabilities: { terminal: false },
      async spawn() {
        throw Error("not used");
      },
      async close() {},
    },
    async close() {
      closes++;
    },
  };
  return {
    store,
    owner,
    workspaceId,
    allocation,
    get closes() {
      return closes;
    },
    options: {
      authority,
      workspaceId,
      async authorize() {},
      async allocate() {
        return allocation;
      },
    },
  };
}
test("durable claim precedes allocation; release preserves ID and advances next generation", async (t) => {
  const f = await fixture(t);
  const a = await f.owner.create({
    ...f.options,
    async allocate(lease) {
      assert.equal((await f.store.read(authority, f.workspaceId)).phase, "creating");
      assert.equal(lease.owner, (await f.store.read(authority, f.workspaceId)).leaseOwner);
      return f.allocation;
    },
  });
  assert.equal((await f.store.read(authority, f.workspaceId)).instanceId, "instance");
  await a.close();
  assert.equal((await f.store.read(authority, f.workspaceId)).phase, "idle");
  await f.owner.create(f.options);
  assert.equal((await f.store.read(authority, f.workspaceId)).generation, 2);
  await f.owner.close();
  assert.equal(f.closes, 2);
});
test("unknown create and occupied workspace both block retries; shutdown does not hide uncertainty", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.owner.create({
      ...f.options,
      async allocate() {
        throw Error("409 workspace_in_use");
      },
    }),
  );
  assert.equal((await f.store.read(authority, f.workspaceId)).phase, "uncertain");
  await assert.rejects(f.owner.create(f.options), /reconciliation/);
  await assert.rejects(f.owner.close(), /unconfirmed/);
  assert.equal(f.closes, 0);
});
test("authorization revoked after allocation reclaims instance without exposing it", async (t) => {
  const f = await fixture(t);
  let allocated = false;
  await assert.rejects(
    f.owner.create({
      ...f.options,
      async allocate() {
        allocated = true;
        return f.allocation;
      },
      async authorize() {
        if (allocated) throw Error("revoked");
      },
    }),
    /revoked/,
  );
  assert.equal(f.closes, 1);
  assert.equal((await f.store.read(authority, f.workspaceId)).phase, "idle");
});
test("shutdown waits for and reclaims late allocation", async (t) => {
  const f = await fixture(t);
  let resolve!: (a: WorkspaceAllocation) => void, started!: () => void;
  const began = new Promise<void>((r) => (started = r));
  const pending = f.owner.create({
    ...f.options,
    allocate: async () => {
      started();
      return new Promise((r) => (resolve = r));
    },
  });
  const failed = assert.rejects(pending, /closed/);
  await began;
  const closing = f.owner.close();
  resolve(f.allocation);
  await failed;
  await closing;
  assert.equal(f.closes, 1);
  assert.equal((await f.store.read(authority, f.workspaceId)).phase, "idle");
});
test("late allocation cleanup failure rejects shutdown and preserves recovery fence", async (t) => {
  const f = await fixture(t);
  f.allocation.close = async () => {
    throw Error("network");
  };
  let resolve!: (a: WorkspaceAllocation) => void, started!: () => void;
  const began = new Promise<void>((r) => (started = r));
  const pending = assert.rejects(
    f.owner.create({
      ...f.options,
      allocate: async () => {
        started();
        return new Promise((r) => (resolve = r));
      },
    }),
    /closed/,
  );
  await began;
  const closing = assert.rejects(f.owner.close(), /unconfirmed/);
  resolve(f.allocation);
  await pending;
  await closing;
  assert.equal((await f.store.read(authority, f.workspaceId)).phase, "uncertain");
});
test("readonly reconciliation refuses live/unknown members and clears only verified absence", async (t) => {
  const f = await fixture(t);
  await f.store.beginCreate(authority, f.workspaceId);
  for (const result of ["present", "unknown"] as const)
    await assert.rejects(f.owner.reconcileAbsent({ ...f.options, inspect: async () => result }), /reconciliation/);
  assert.equal(f.closes, 0);
  await f.owner.reconcileAbsent({ ...f.options, inspect: async () => "absent" });
  assert.equal((await f.store.read(authority, f.workspaceId)).phase, "idle");
  await f.owner.create(f.options);
});
test("stale recovery result cannot clear a later generation", async (t) => {
  const f = await fixture(t);
  const first = await f.store.beginCreate(authority, f.workspaceId);
  await assert.rejects(
    f.owner.reconcileAbsent({
      ...f.options,
      inspect: async () => {
        await f.store.confirmComputeAbsent(authority, first);
        await f.store.beginCreate(authority, f.workspaceId);
        return "absent";
      },
    }),
    /Stale/,
  );
  assert.equal((await f.store.read(authority, f.workspaceId)).phase, "creating");
  assert.equal((await f.store.read(authority, f.workspaceId)).generation, 2);
});
test("definite pre-provider rejection is retryable without clearing retained volume identity", async (t) => {
  const f = await fixture(t);
  const first = await f.owner.create({
    ...f.options,
    allocate: async () => ({ ...f.allocation, privateVolumeId: "volume" }),
  });
  await first.close();
  await assert.rejects(
    f.owner.create({
      ...f.options,
      allocate: async (lease) => {
        throw new OrdinaryWorkspaceAdmissionRejected(lease);
      },
    }),
  );
  const rejected = await f.store.read(authority, f.workspaceId);
  assert.equal(rejected.phase, "idle");
  assert.equal(rejected.generation, 2);
  assert.equal(rejected.privateVolumeId, "volume");
  const retry = await f.owner.create(f.options);
  assert.equal((await f.store.read(authority, f.workspaceId)).generation, 3);
  await retry.close();
  await f.owner.close();
});
test("stale, serialized or post-receipt rejection cannot clear a live or uncertain provider result", async (t) => {
  for (const mode of ["stale", "serialized", "receipt"]) {
    const f = await fixture(t);
    await assert.rejects(
      f.owner.create({
        ...f.options,
        allocate: async (lease) => {
          if (mode === "receipt")
            await f.store.recordProviderReceipt(authority, lease, {
              instanceId: "instance",
              privateVolumeId: "volume",
            });
          if (mode === "serialized") throw { name: "OrdinaryWorkspaceAdmissionRejected", lease };
          throw new OrdinaryWorkspaceAdmissionRejected(
            mode === "stale" ? { ...lease, generation: lease.generation + 1 } : lease,
          );
        },
      }),
    );
    assert.equal((await f.store.read(authority, f.workspaceId)).phase, "uncertain");
    await assert.rejects(f.owner.close(), /unconfirmed/);
  }
});
