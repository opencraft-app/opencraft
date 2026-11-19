import { legacyWorkspaceJournal } from "../fixtures/ordinary-workspace-legacy";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OrdinaryWorkspaceStore } from "../../apps/local-agent-host/src/ordinary-workspace-store";
import {
  OrdinaryWorkspaceCompute,
  type WorkspaceAllocation,
} from "../../apps/local-agent-host/src/ordinary-workspace-compute";
import { createE2BPersistentWorkspaceInspector } from "../../packages/sandbox-e2b/src/workspace-inspector";
const authority = { principalId: "alice", hostId: "host" },
  volume = "11111111-1111-1111-1111-111111111111";
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "receipt-recovery-")),
    stores: OrdinaryWorkspaceStore[] = [];
  const open = () => {
    const store = new OrdinaryWorkspaceStore(root, "deployment");
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores) await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const store = open(),
    row = await store.admit(authority, "intent", "a".repeat(64));
  return { root, store, open, row, lease: await store.beginCreate(authority, row.workspaceId) };
}
test("receipt survives compute release, reuses original volume and fences replacement/stale callbacks", async (t) => {
  const f = await fixture(t),
    receipt = { instanceId: "instance-1", privateVolumeId: volume };
  await f.store.recordProviderReceipt(authority, f.lease, receipt);
  assert.equal((await f.store.recordProviderReceipt(authority, f.lease, receipt)).phase, "creating");
  await assert.rejects(async () => await f.store.confirmCreated(authority, f.lease, "wrong-instance"), /conflict/);
  await f.store.confirmCreated(authority, f.lease, receipt.instanceId);
  await f.store.beginRelease(authority, f.lease);
  await f.store.confirmComputeAbsent(authority, f.lease);
  const next = await f.store.beginCreate(authority, f.row.workspaceId);
  assert.equal((await f.store.read(authority, f.row.workspaceId)).privateVolumeId, volume);
  await assert.rejects(async () => await f.store.recordProviderReceipt(authority, f.lease, receipt), /Stale/);
  await assert.rejects(
    async () => await f.store.recordProviderReceipt(authority, next, { ...receipt, privateVolumeId: "replacement" }),
    /conflict/,
  );
  assert.equal((await f.store.read(authority, f.row.workspaceId)).instanceId, null);
  await f.store.recordProviderReceipt(authority, next, { ...receipt, instanceId: "instance-2" });
});
test("reopened owner uses persisted volume with actual inspector and clears only verified absence", async (t) => {
  const f = await fixture(t);
  await f.store.recordProviderReceipt(authority, f.lease, { instanceId: "prior-instance", privateVolumeId: volume });
  const reopened = f.open(),
    owner = new OrdinaryWorkspaceCompute(reopened);
  const calls: string[] = [];
  const inspect = createE2BPersistentWorkspaceInspector(
    { apiUrl: "https://provider.test", readApiKey: async () => "test-key", authorize: async () => {} },
    async (url, init) => {
      assert.equal(init?.method, "GET");
      calls.push(String(url));
      return Response.json(
        String(url).includes("/volumes/")
          ? { volumeID: volume }
          : {
              schemaVersion: 2,
              workspaceID: f.row.workspaceId,
              privateVolumeID: volume,
              phase: "ready",
              generation: 1,
              members: [],
            },
      );
    },
  );
  await owner.reconcileRetained({ authority, workspaceId: f.row.workspaceId, authorize: async () => {}, inspect });
  assert.equal(calls.length, 3);
  assert.ok(calls[1].endsWith(volume));
  assert.equal((await reopened.read(authority, f.row.workspaceId)).phase, "idle");
  assert.equal((await reopened.read(authority, f.row.workspaceId)).privateVolumeId, volume);
  await owner.close();
});
test("legacy missing receipt cannot learn replacement volume or call remote inspector", async (t) => {
  const f = await fixture(t),
    owner = new OrdinaryWorkspaceCompute(f.store);
  let reads = 0;
  await assert.rejects(
    owner.reconcileRetained({
      authority,
      workspaceId: f.row.workspaceId,
      authorize: async () => {},
      inspect: async () => {
        reads++;
        return "absent";
      },
    }),
    /reconciliation/,
  );
  assert.equal(reads, 0);
  assert.equal((await f.store.read(authority, f.row.workspaceId)).phase, "creating");
  await owner.close();
});
test("remaining family members and revoked authority preserve durable recovery fence", async (t) => {
  const f = await fixture(t);
  await f.store.recordProviderReceipt(authority, f.lease, { instanceId: "instance", privateVolumeId: volume });
  const owner = new OrdinaryWorkspaceCompute(f.store);
  for (const state of ["present", "unknown"] as const)
    await assert.rejects(
      owner.reconcileRetained({
        authority,
        workspaceId: f.row.workspaceId,
        authorize: async () => {},
        inspect: async () => state,
      }),
      /reconciliation/,
    );
  let checks = 0;
  await assert.rejects(
    owner.reconcileRetained({
      authority,
      workspaceId: f.row.workspaceId,
      authorize: async () => {
        if (++checks > 1) throw Error("revoked");
      },
      inspect: async () => "absent",
    }),
    /revoked/,
  );
  assert.equal((await f.store.read(authority, f.row.workspaceId)).phase, "creating");
  await owner.close();
});
test("receipt callback before allocator failure remains recoverable, not forgotten", async (t) => {
  const f = await fixture(t);
  await f.store.confirmComputeAbsent(authority, f.lease);
  const owner = new OrdinaryWorkspaceCompute(f.store);
  await assert.rejects(
    owner.create({
      authority,
      workspaceId: f.row.workspaceId,
      authorize: async () => {},
      allocate: async (lease) => {
        await f.store.recordProviderReceipt(authority, lease, { instanceId: "late-instance", privateVolumeId: volume });
        throw Error("lost response");
      },
    }),
    /lost response/,
  );
  const row = await f.store.read(authority, f.row.workspaceId);
  assert.equal(row.phase, "uncertain");
  assert.equal(row.instanceId, "late-instance");
  assert.equal(row.privateVolumeId, volume);
  await assert.rejects(owner.close(), /unconfirmed/);
});
test("allocation volume receipt is durable before exposing execution and survives close", async (t) => {
  const f = await fixture(t);
  await f.store.confirmComputeAbsent(authority, f.lease);
  const owner = new OrdinaryWorkspaceCompute(f.store);
  let closes = 0;
  const allocation: WorkspaceAllocation = {
    instanceId: "allocated",
    privateVolumeId: volume,
    environment: {
      resources: { cpuMillis: 1000, memoryBytes: 1024 },
      capabilities: { terminal: false },
      async spawn() {
        throw Error("unused");
      },
      async close() {},
    },
    async close() {
      closes++;
    },
  };
  const result = await owner.create({
    authority,
    workspaceId: f.row.workspaceId,
    authorize: async () => {},
    allocate: async () => allocation,
  });
  assert.equal(result.privateVolumeId, volume);
  assert.equal((await f.store.read(authority, f.row.workspaceId)).privateVolumeId, volume);
  await owner.close();
  assert.equal(closes, 1);
  assert.equal((await f.store.read(authority, f.row.workspaceId)).phase, "idle");
  assert.equal((await f.store.read(authority, f.row.workspaceId)).privateVolumeId, volume);
});
test("known unledgered predecessor migration preserves interrupted state without inventing a volume", async (t) => {
  const f = await fixture(t);
  await f.store.close();
  legacyWorkspaceJournal(f.root, 3);
  const reopened = f.open();
  assert.equal((await reopened.read(authority, f.row.workspaceId)).phase, "creating");
  assert.equal((await reopened.read(authority, f.row.workspaceId)).privateVolumeId, null);
});
