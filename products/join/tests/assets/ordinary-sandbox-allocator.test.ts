import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrdinaryWorkspaceStore } from '../../../../apps/local-agent-host/src/ordinary-workspace-store';
import { OrdinaryWorkspaceCompute } from '../../../../apps/local-agent-host/src/ordinary-workspace-compute';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InstalledOrdinarySandboxAllocator } from '../../assets/ordinary-sandbox-allocator';
import type { InstalledOrdinaryEnvironmentCatalog } from '../../assets/ordinary-environment-catalog';
import { SandboxCreationFault, type SandboxBackend } from '../../../../packages/sandbox/src/index';

function fixture() {
  let allowed = true, capacity = 2, killed = 0, submitted = 0, mode = 'ok', release: (() => void) | undefined;
  const resources = { cpuMillis: 1, memoryBytes: 1 };
  const runtime = (_context: unknown, environment: { templateId: string }) => ({ policy: { capacity: { cpuMillis: capacity, memoryBytes: capacity },
    lease: { timeoutMs: 30000, renewEveryMs: 1000, maxLifetimeMs: 60000 } }, template: { resources },
    apiUrl: 'https://api.example.test', sandboxUrl: 'https://sandbox.example.test', templateId: environment.templateId,
    async authorize() { if (!allowed) throw Error('revoked'); }, async readApiKey() { if (!allowed) throw Error('revoked'); return 'synthetic'; } });
  const catalog = { runtime } as unknown as InstalledOrdinaryEnvironmentCatalog;
  const requests: string[] = [], workspaceIds: string[] = [];
  const allocator = new InstalledOrdinarySandboxAllocator(catalog, {
    request: (async (url: string | URL | Request) => {
      requests.push(String(url));
      return Response.json({ schemaVersion: 2, workspaceID: String(url).split('/').at(-1),
        privateVolumeID: mode === 'bad-volume' ? 'invalid' : '11111111-1111-1111-1111-111111111111', members: mode === 'missing-member' ? [] : mode === 'multiple-members'
          ? [{sandboxID:'instance-'+submitted},{sandboxID:'foreign'}]
          : [mode === 'invalid-member' ? null : { sandboxID: mode === 'foreign-member' ? 'foreign' : 'instance-'+submitted }] });
    }) as typeof fetch,
    backend: options => ({ id: 'e2b', initialize: async () => {}, close: async () => {},
      async create(identity, selected) {
        submitted++;
        const workspaceId = await options.readWorkspaceId!(identity); workspaceIds.push(workspaceId!);
        if (mode === 'unknown') throw new SandboxCreationFault('unknown');
        if (mode === 'occupied') throw new SandboxCreationFault('not-created');
        if (mode === 'late') await new Promise<void>(resolve => { release = resolve; });
        try { await options.onCreated!({ identity, workspaceId, instanceId: 'instance-' + submitted }); }
        catch { killed++; throw new SandboxCreationFault('not-created'); }
        return { resources: selected, capabilities: { terminal: true }, spawn: async () => { throw Error('unused'); },
          async close() { if (mode === 'cleanup-fails') throw Error('cleanup failed'); killed++; } };
      },
    } satisfies SandboxBackend),
  });
  const admission = (id: number) => ({ context: { scope: 'alice', current: () => allowed },
    environment: { configurationId: 'c', configurationRevision: 'a'.repeat(64), templateId: 'base', cpuMillis: 1, memoryBytes: 1 },
    lease: { workspaceId: 'ws-' + String(id).repeat(32), generation: 1, owner: 'ordinary-' + String(id).repeat(64) },
    authorize: async () => { if (!allowed) throw Error('revoked'); }, onLost() {} });
  return { allocator, admission, requests, workspaceIds, get submitted() { return submitted; }, get waiting() { return !!release; }, get killed() { return killed; },
    revoke() { allowed = false; }, capacity(n: number) { capacity = n; }, mode(value: string) { mode = value; }, release() { release?.(); } };
}

test('ordinary allocations share capacity across templates and keep durable workspace identities', async () => {
  const f = fixture();
  try {
    const first = await f.allocator.allocate(f.admission(1));
    const second = await f.allocator.allocate({ ...f.admission(2), environment: { ...f.admission(2).environment, templateId: 'devtools' } });
    await assert.rejects(f.allocator.allocate(f.admission(3)), /admission rejected before provider create/);
    await assert.rejects(f.allocator.allocate(f.admission(1)), /unavailable/);
    assert.deepEqual(f.workspaceIds, [f.admission(1).lease.workspaceId, f.admission(2).lease.workspaceId]);
    assert.equal(first.privateVolumeId, '11111111-1111-1111-1111-111111111111');
    await first.close(); await second.close();
    const next = await f.allocator.allocate({ ...f.admission(1), lease: { ...f.admission(1).lease, generation: 2, owner: 'ordinary-' + '4'.repeat(64) } });
    assert.equal(f.workspaceIds[2], f.admission(1).lease.workspaceId); await next.close();
  } finally { await f.allocator.close(); }
  assert.equal(f.killed, 3);
});

test('revoked admission and changed capacity cannot silently create a replacement pool', async () => {
  const f = fixture(); const first = await f.allocator.allocate(f.admission(1)); f.capacity(3);
  await assert.rejects(f.allocator.allocate(f.admission(2)), /admission rejected before provider create/); f.revoke();
  await assert.rejects(f.allocator.allocate(f.admission(3)), /admission rejected before provider create/); assert.equal(f.submitted, 1);
  await first.close(); await f.allocator.close();
});

test('invalid provider volume evidence is reclaimed before allocation is returned', async () => {
  const f = fixture(); f.mode('bad-volume');
  await assert.rejects(f.allocator.allocate(f.admission(1))); assert.equal(f.killed, 1);
  f.mode('ok'); const created = await f.allocator.allocate(f.admission(2)); await created.close(); await f.allocator.close();
});

test('unknown creation retains budget and lease fence rather than retrying elsewhere', async () => {
  const f = fixture(); f.capacity(1); f.mode('unknown');
  await assert.rejects(f.allocator.allocate(f.admission(1)));
  await assert.rejects(f.allocator.allocate(f.admission(1)), /unavailable/);
  await assert.rejects(f.allocator.allocate(f.admission(2)), /admission rejected before provider create/);
  assert.equal(f.submitted, 1); await assert.rejects(f.allocator.close(), /cleanup is unverified/);
});

test('shutdown rejects and reclaims a late created instance without replacing its workspace', async () => {
  const f = fixture(); f.mode('late'); const pending = assert.rejects(f.allocator.allocate(f.admission(1)));
  while (!f.waiting) await new Promise(resolve => setImmediate(resolve));
  const closing = f.allocator.close(); f.release(); await pending; await closing; assert.equal(f.killed, 1);
});

test('failed cleanup retains its budget and fails shutdown visibly', async () => {
  const f = fixture(); f.capacity(1); const created = await f.allocator.allocate(f.admission(1)); f.mode('cleanup-fails');
  await assert.rejects(created.close(), /cleanup failed/);
  await assert.rejects(f.allocator.allocate(f.admission(2)), /admission rejected before provider create/);
  await assert.rejects(f.allocator.close(), /cleanup is unverified/);
});


test('actual compute journal plus allocator retries local capacity rejection without reconciliation', async () => {
 const f=fixture(), root=mkdtempSync(join(tmpdir(),'ordinary-admission-')), store=new OrdinaryWorkspaceStore(root,'test'), compute=new OrdinaryWorkspaceCompute(store);
 const authority={principalId:'alice',hostId:'host'};
 const create=(intent:string)=>{
  const workspaceId=store.admit(authority,intent,'a'.repeat(64)).workspaceId;
  return {workspaceId,run:()=>compute.create({authority,workspaceId,authorize:async()=>{},
    allocate:lease=>f.allocator.allocate({...f.admission(1),lease})})};
 };
 try {
  const a=create('a'),b=create('b'),c=create('c'), first=await a.run(),second=await b.run();
  await assert.rejects(c.run(),/admission rejected before provider create/);
  assert.equal(store.read(authority,c.workspaceId).phase,'idle'); assert.equal(f.submitted,2);
  await first.close(); const retry=await c.run();
  assert.equal(store.read(authority,c.workspaceId).generation,2);assert.equal(f.submitted,3);
  await second.close();await retry.close();await compute.close();await f.allocator.close();
 } finally { await compute.close().catch(()=>{});await f.allocator.close().catch(()=>{});store.close();rmSync(root,{recursive:true,force:true}); }
});


test('SDK not-created after provider invocation does not clear a possible occupied workspace', async () => {
 const f=fixture(),root=mkdtempSync(join(tmpdir(),'ordinary-occupied-')),store=new OrdinaryWorkspaceStore(root,'test'),compute=new OrdinaryWorkspaceCompute(store);
 const authority={principalId:'alice',hostId:'host'},workspaceId=store.admit(authority,'occupied','a'.repeat(64)).workspaceId;
 f.mode('occupied');
 try {
  await assert.rejects(compute.create({authority,workspaceId,authorize:async()=>{},allocate:lease=>f.allocator.allocate({...f.admission(1),lease})}));
  assert.equal(store.read(authority,workspaceId).phase,'uncertain');assert.equal(f.submitted,1);assert.equal(f.killed,0);
  await assert.rejects(compute.close(),/unconfirmed/);await f.allocator.close();
 } finally {await compute.close().catch(()=>{});await f.allocator.close().catch(()=>{});store.close();rmSync(root,{recursive:true,force:true});}
});


test('workspace metadata must identify exactly the instance just created', async () => {
 for (const mode of ['missing-member','multiple-members','invalid-member','foreign-member']) {
  const f=fixture();f.mode(mode);
  try {
   let unexpected: Awaited<ReturnType<typeof f.allocator.allocate>> | undefined;
   try {
    await assert.rejects(async () => { unexpected=await f.allocator.allocate(f.admission(1)); });
   } finally { await unexpected?.close(); }
   assert.equal(f.killed,1,mode);
   assert.equal(f.submitted,1,mode);
   f.mode('ok');
   const created=await f.allocator.allocate(f.admission(2));
   assert.equal(created.instanceId,'instance-2');
   await created.close();
  } finally { await f.allocator.close(); }
 }
});
