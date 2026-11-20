import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OrdinaryWorkspaceStore } from '../../apps/local-agent-host/src/ordinary-workspace-store';
import { OrdinaryWorkspaceCompute, type WorkspaceAllocation } from '../../apps/local-agent-host/src/ordinary-workspace-compute';
import { createE2BPersistentWorkspaceInspector } from '../../packages/sandbox-e2b/src/workspace-inspector';
const authority = { principalId: 'alice', hostId: 'host' }, volume = '11111111-1111-1111-1111-111111111111';
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'receipt-recovery-')), stores: OrdinaryWorkspaceStore[] = [];
  const open = () => { const store = new OrdinaryWorkspaceStore(root, 'deployment'); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); });
  const store = open(), row = store.admit(authority, 'intent', 'a'.repeat(64));
  return { root, store, open, row, lease: store.beginCreate(authority, row.workspaceId) };
}
test('receipt survives compute release, reuses original volume and fences replacement/stale callbacks', t => {
  const f = fixture(t), receipt = { instanceId: 'instance-1', privateVolumeId: volume };
  f.store.recordProviderReceipt(authority, f.lease, receipt);
  assert.equal(f.store.recordProviderReceipt(authority, f.lease, receipt).phase, 'creating');
  assert.throws(() => f.store.confirmCreated(authority, f.lease, 'wrong-instance'), /conflict/);
  f.store.confirmCreated(authority, f.lease, receipt.instanceId); f.store.beginRelease(authority, f.lease); f.store.confirmComputeAbsent(authority, f.lease);
  const next = f.store.beginCreate(authority, f.row.workspaceId);
  assert.equal(f.store.read(authority, f.row.workspaceId).privateVolumeId, volume);
  assert.throws(() => f.store.recordProviderReceipt(authority, f.lease, receipt), /Stale/);
  assert.throws(() => f.store.recordProviderReceipt(authority, next, { ...receipt, privateVolumeId: 'replacement' }), /conflict/);
  assert.equal(f.store.read(authority, f.row.workspaceId).instanceId, null);
  f.store.recordProviderReceipt(authority, next, { ...receipt, instanceId: 'instance-2' });
});
test('reopened owner uses persisted volume with actual inspector and clears only verified absence', async t => {
  const f = fixture(t); f.store.recordProviderReceipt(authority, f.lease, { instanceId: 'prior-instance', privateVolumeId: volume });
  const reopened = f.open(), owner = new OrdinaryWorkspaceCompute(reopened);
  const calls: string[] = [];
  const inspect = createE2BPersistentWorkspaceInspector({ apiUrl: 'https://provider.test', readApiKey: async () => 'test-key', authorize: async () => {} }, async (url, init) => {
    assert.equal(init?.method, 'GET'); calls.push(String(url));
    return Response.json(String(url).includes('/volumes/') ? { volumeID: volume } : { schemaVersion: 2, workspaceID: f.row.workspaceId, privateVolumeID: volume, phase: 'ready', generation: 1, members: [] });
  });
  await owner.reconcileRetained({ authority, workspaceId: f.row.workspaceId, authorize: async () => {}, inspect });
  assert.equal(calls.length, 3); assert.ok(calls[1].endsWith(volume));
  assert.equal(reopened.read(authority, f.row.workspaceId).phase, 'idle');
  assert.equal(reopened.read(authority, f.row.workspaceId).privateVolumeId, volume); await owner.close();
});
test('legacy missing receipt cannot learn replacement volume or call remote inspector', async t => {
  const f = fixture(t), owner = new OrdinaryWorkspaceCompute(f.store); let reads = 0;
  await assert.rejects(owner.reconcileRetained({ authority, workspaceId: f.row.workspaceId, authorize: async () => {}, inspect: async () => { reads++; return 'absent'; } }), /reconciliation/);
  assert.equal(reads, 0); assert.equal(f.store.read(authority, f.row.workspaceId).phase, 'creating'); await owner.close();
});
test('remaining family members and revoked authority preserve durable recovery fence', async t => {
  const f = fixture(t); f.store.recordProviderReceipt(authority, f.lease, { instanceId: 'instance', privateVolumeId: volume });
  const owner = new OrdinaryWorkspaceCompute(f.store);
  for (const state of ['present', 'unknown'] as const) await assert.rejects(owner.reconcileRetained({ authority, workspaceId: f.row.workspaceId, authorize: async () => {}, inspect: async () => state }), /reconciliation/);
  let checks = 0;
  await assert.rejects(owner.reconcileRetained({ authority, workspaceId: f.row.workspaceId, authorize: async () => { if (++checks > 1) throw Error('revoked'); }, inspect: async () => 'absent' }), /revoked/);
  assert.equal(f.store.read(authority, f.row.workspaceId).phase, 'creating'); await owner.close();
});
test('receipt callback before allocator failure remains recoverable, not forgotten', async t => {
  const f = fixture(t); f.store.confirmComputeAbsent(authority, f.lease); const owner = new OrdinaryWorkspaceCompute(f.store);
  await assert.rejects(owner.create({ authority, workspaceId: f.row.workspaceId, authorize: async () => {}, allocate: async lease => {
    f.store.recordProviderReceipt(authority, lease, { instanceId: 'late-instance', privateVolumeId: volume }); throw Error('lost response');
  } }), /lost response/);
  const row = f.store.read(authority, f.row.workspaceId); assert.equal(row.phase, 'uncertain'); assert.equal(row.instanceId, 'late-instance'); assert.equal(row.privateVolumeId, volume);
  await assert.rejects(owner.close(), /unconfirmed/);
});
test('allocation volume receipt is durable before exposing execution and survives close', async t => {
  const f = fixture(t); f.store.confirmComputeAbsent(authority, f.lease); const owner = new OrdinaryWorkspaceCompute(f.store); let closes = 0;
  const allocation: WorkspaceAllocation = { instanceId: 'allocated', privateVolumeId: volume, environment: {
    resources: { cpuMillis: 1000, memoryBytes: 1024 }, capabilities: { terminal: false }, async spawn() { throw Error('unused'); }, async close() {},
  }, async close() { closes++; } };
  const result = await owner.create({ authority, workspaceId: f.row.workspaceId, authorize: async () => {}, allocate: async () => allocation });
  assert.equal(result.privateVolumeId, volume); assert.equal(f.store.read(authority, f.row.workspaceId).privateVolumeId, volume);
  await owner.close(); assert.equal(closes, 1); assert.equal(f.store.read(authority, f.row.workspaceId).phase, 'idle'); assert.equal(f.store.read(authority, f.row.workspaceId).privateVolumeId, volume);
});
test('schema2 migration preserves interrupted state without inventing a volume', t => {
  const f = fixture(t), db = new DatabaseSync(join(f.root, 'ordinary-workspaces.sqlite'));
  try { db.exec("ALTER TABLE ordinary_workspaces DROP COLUMN private_volume_id; UPDATE workspace_journal_meta SET value='2' WHERE key='schema'"); } finally { db.close(); }
  const reopened = f.open(); assert.equal(reopened.read(authority, f.row.workspaceId).phase, 'creating'); assert.equal(reopened.read(authority, f.row.workspaceId).privateVolumeId, null);
});
