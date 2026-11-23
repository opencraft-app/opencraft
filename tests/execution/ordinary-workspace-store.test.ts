import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { OrdinaryWorkspaceStore } from '../../apps/local-agent-host/src/ordinary-workspace-store';
const scope={principalId:'alice',hostId:'host-a'}, selection='a'.repeat(64);
function fixture(t:test.TestContext) {
 const root=mkdtempSync(join(tmpdir(),'ordinary-workspaces-')), opened=new Set<OrdinaryWorkspaceStore>();
 t.after(()=>{for(const s of opened)s.close();rmSync(root,{recursive:true,force:true})});
 return {root,open:()=>{const s=new OrdinaryWorkspaceStore(root,'deployment-a');opened.add(s);return s},close:(s:OrdinaryWorkspaceStore)=>{s.close();opened.delete(s)}};
}
test('idempotent admission isolates principal, Host, and creation intent',t=>{
 const f=fixture(t),s=f.open();const a=s.admit(scope,'intent-a',selection);
 assert.deepEqual(s.admit(scope,'intent-a',selection),a);
 assert.notEqual(s.admit({...scope,principalId:'bob'},'intent-a',selection).workspaceId,a.workspaceId);
 assert.notEqual(s.admit({...scope,hostId:'host-b'},'intent-a',selection).workspaceId,a.workspaceId);
 assert.notEqual(s.admit(scope,'intent-b',selection).workspaceId,a.workspaceId);
 assert.throws(()=>s.admit(scope,'intent-a','b'.repeat(64)),/conflict/);
 assert.throws(()=>s.read({...scope,principalId:'bob'},a.workspaceId),/not found/);
});
test('thread attach is immutable, scoped and unique within a Host',t=>{
 const f=fixture(t),s=f.open();const a=s.admit(scope,'a',selection),b=s.admit(scope,'b',selection);
 s.attachThread(scope,a.workspaceId,'thread-a');s.attachThread(scope,a.workspaceId,'thread-a');
 assert.equal(s.forThread(scope,'thread-a')?.workspaceId,a.workspaceId);
 assert.equal(s.forThread({...scope,principalId:'bob'},'thread-a'),null);
 assert.throws(()=>s.attachThread(scope,a.workspaceId,'thread-b'),/another thread/);
 assert.throws(()=>s.attachThread(scope,b.workspaceId,'thread-a'));
 assert.equal(s.read(scope,b.workspaceId).threadId,null);
});
test('compute restart preserves workspace, fences stale callbacks and retains ambiguous outcomes',t=>{
 const f=fixture(t),s=f.open(),row=s.admit(scope,'intent',selection),lease=s.beginCreate(scope,row.workspaceId);
 s.confirmCreated(scope,lease,'instance-1');s.beginRelease(scope,lease);s.markUncertain(scope,lease);f.close(s);
 const restarted=f.open();assert.equal(restarted.read(scope,row.workspaceId).instanceId,'instance-1');
 assert.throws(()=>restarted.beginCreate(scope,row.workspaceId),/reconciliation/);
 restarted.confirmComputeAbsent(scope,lease);const next=restarted.beginCreate(scope,row.workspaceId);
 assert.equal(next.workspaceId,lease.workspaceId);assert.equal(next.generation,2);
 assert.throws(()=>restarted.confirmCreated(scope,lease,'old-instance'),/Stale/);
 assert.throws(()=>restarted.confirmComputeAbsent(scope,lease),/Stale/);
 restarted.confirmCreated(scope,next,'instance-2');assert.equal(restarted.read(scope,row.workspaceId).phase,'live');
 assert.throws(()=>restarted.confirmComputeAbsent(scope,next),/Stale/);
});
test('two journal connections cannot acquire duplicate create ownership',t=>{
 const f=fixture(t),a=f.open(),b=f.open(),row=a.admit(scope,'intent',selection);
 assert.equal(b.admit(scope,'intent',selection).workspaceId,row.workspaceId);
 a.beginCreate(scope,row.workspaceId);assert.throws(()=>b.beginCreate(scope,row.workspaceId),/reconciliation/);
 assert.equal(b.read(scope,row.workspaceId).phase,'creating');
});
test('actual child-process restart retains identity and unknown create blocks retry',t=>{
 const f=fixture(t),s=f.open(),row=s.admit(scope,'intent',selection);s.attachThread(scope,row.workspaceId,'thread-a');s.beginCreate(scope,row.workspaceId);f.close(s);
 const module=new URL('../../apps/local-agent-host/src/ordinary-workspace-store.ts',import.meta.url).href;
 const code=`import {OrdinaryWorkspaceStore} from ${JSON.stringify(module)};const s=new OrdinaryWorkspaceStore(${JSON.stringify(f.root)},'deployment-a');const scope=${JSON.stringify(scope)};const row=s.forThread(scope,'thread-a');let blocked=false;try{s.beginCreate(scope,row.workspaceId)}catch{blocked=true}console.log(JSON.stringify({row,blocked}));s.close();`;
 const out=execFileSync(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),'--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'}});
 const result=JSON.parse(out);assert.equal(result.row.workspaceId,row.workspaceId);assert.equal(result.row.generation,1);assert.equal(result.row.phase,'creating');assert.equal(result.blocked,true);
});
test('deployment identity and private journal filesystem cannot be silently replaced',t=>{
 const f=fixture(t),s=f.open();s.admit(scope,'intent',selection);
 assert.throws(()=>new OrdinaryWorkspaceStore(f.root,'deployment-b'),/deployment mismatch/);
 const shared=join(f.root,'shared');mkdirSync(shared,{mode:0o755});assert.throws(()=>new OrdinaryWorkspaceStore(shared,'deployment-a'),/private/);
 const linked=join(f.root,'linked');mkdirSync(linked,{mode:0o700});symlinkSync(join(f.root,'ordinary-workspaces.sqlite'),join(linked,'ordinary-workspaces.sqlite'));
 assert.throws(()=>new OrdinaryWorkspaceStore(linked,'deployment-a'));
});
test('private restart inventory includes pre-thread intents and reconstructs compute owner',t=>{
 const f=fixture(t),s=f.open();const a=s.admit(scope,'unbound',selection),b=s.admit({...scope,principalId:'bob'},'unbound',selection);
 const first=s.beginCreate(scope,a.workspaceId);s.beginCreate({...scope,principalId:'bob'},b.workspaceId);f.close(s);
 const reopened=f.open(),page=reopened.pendingForHost(scope.hostId,'',1);assert.equal(page.length,1);
 const next=reopened.pendingForHost(scope.hostId,page[0].binding.workspaceId,1);assert.equal(next.length,1);
 assert.equal(reopened.pendingForHost(scope.hostId,next[0].binding.workspaceId,1).length,0);
 assert.equal(reopened.read(scope,a.workspaceId).leaseOwner,first.owner);assert.equal(reopened.read(scope,a.workspaceId).threadId,null);
 assert.throws(()=>reopened.confirmCreated(scope,{...first,owner:'wrong'},'instance'),/Stale/);
 assert.deepEqual(reopened.pendingForHost('other-host'),[]);
});

test('Native dispatch is durable before response and compute deletion cannot unblock retry',t=>{
 const f=fixture(t),s=f.open(),row=s.admit(scope,'native-intent',selection),lease=s.beginCreate(scope,row.workspaceId);
 s.confirmCreated(scope,lease,'instance');s.beginThreadStart(scope,lease);
 assert.throws(()=>s.beginThreadStart(scope,lease),/reconciliation/);
 assert.throws(()=>s.attachThread(scope,row.workspaceId,'bypass'),/reconciliation/);
 s.beginRelease(scope,lease);s.confirmComputeAbsent(scope,lease);f.close(s);
 const restarted=f.open();assert.throws(()=>restarted.beginCreate(scope,row.workspaceId),/Native thread creation requires reconciliation/);
 assert.equal(restarted.pendingForHost(scope.hostId).length,0);
 const pending=restarted.pendingThreadStarts(scope.hostId);assert.equal(pending.length,1);
 assert.equal(pending[0].binding.workspaceId,row.workspaceId);
 assert.equal(restarted.pendingThreadStarts('other-host').length,0);
 assert.equal(restarted.pendingThreadStarts(scope.hostId,row.workspaceId).length,0);
 assert.throws(()=>restarted.confirmThreadStarted({...scope,principalId:'bob'},lease,'native-thread'),/not found/);
 assert.throws(()=>restarted.confirmThreadStarted(scope,{...lease,generation:2},'native-thread'),/Stale/);
 restarted.confirmThreadStarted(scope,lease,'native-thread');
 restarted.confirmThreadStarted(scope,lease,'native-thread');
 assert.equal(restarted.pendingThreadStarts(scope.hostId).length,0);
 assert.throws(()=>restarted.confirmThreadStarted(scope,lease,'another-thread'),/another thread/);
 assert.equal(restarted.beginCreate(scope,row.workspaceId).generation,2);
 assert.throws(()=>restarted.confirmThreadStarted(scope,lease,'native-thread'),/Stale/);
});
test('two connections cannot dispatch twice; colliding Native receipt rolls back both records',t=>{
 const f=fixture(t),a=f.open(),b=f.open(),row=a.admit(scope,'native-intent',selection),lease=a.beginCreate(scope,row.workspaceId);
 assert.throws(()=>a.beginThreadStart(scope,lease),/Invalid/);
 a.confirmCreated(scope,lease,'instance');a.beginThreadStart(scope,lease);
 assert.throws(()=>b.beginThreadStart(scope,lease),/reconciliation/);
 const other=a.admit(scope,'other',selection);a.attachThread(scope,other.workspaceId,'occupied');
 assert.throws(()=>b.confirmThreadStarted(scope,lease,'occupied'));
 assert.equal(a.read(scope,row.workspaceId).threadId,null);
 assert.equal(a.pendingThreadStarts(scope.hostId).length,1);
 b.confirmThreadStarted(scope,lease,'correct');
 assert.equal(a.forThread(scope,'correct')?.workspaceId,row.workspaceId);
 assert.throws(()=>a.beginThreadStart(scope,lease),/Invalid/);
});
test('separate process restart retains unresolved Native dispatch after compute release',t=>{
 const f=fixture(t),s=f.open(),row=s.admit(scope,'native-crash',selection),lease=s.beginCreate(scope,row.workspaceId);
 s.confirmCreated(scope,lease,'instance');s.beginThreadStart(scope,lease);
 s.beginRelease(scope,lease);s.confirmComputeAbsent(scope,lease);f.close(s);
 const module=new URL('../../apps/local-agent-host/src/ordinary-workspace-store.ts',import.meta.url).href;
 const code=`import {OrdinaryWorkspaceStore} from ${JSON.stringify(module)};const s=new OrdinaryWorkspaceStore(${JSON.stringify(f.root)},'deployment-a');let blocked=false;try{s.beginCreate(${JSON.stringify(scope)},${JSON.stringify(row.workspaceId)})}catch{blocked=true}console.log(JSON.stringify({blocked,pending:s.pendingThreadStarts('host-a').length}));s.close();`;
 const out=execFileSync(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),'--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'}});
 assert.deepEqual(JSON.parse(out),{blocked:true,pending:1});
});

test('fork membership and ambiguous dispatch survive restart without changing primary or compute', t => {
 const f = fixture(t), s = f.open(), row = s.admit(scope, 'main', selection);
 s.attachThread(scope, row.workspaceId, 'parent'); const lease = s.beginCreate(scope, row.workspaceId); s.confirmCreated(scope, lease, 'instance');
 const fork = s.beginThreadFork(scope, 'parent', 'side');
 assert.throws(() => s.beginThreadFork(scope, 'parent', 'side'), /reconciliation/);
 assert.throws(() => s.beginThreadFork({ ...scope, principalId: 'bob' }, 'parent', 'side'), /not found/);
 s.confirmThreadForked(scope, fork.lease, 'side', 'child');
 assert.equal(s.forThread(scope, 'child')?.workspaceId, row.workspaceId);
 assert.equal(s.read(scope, row.workspaceId).threadId, 'parent');
 assert.equal(s.beginThreadFork(scope, 'parent', 'side').threadId, 'child');
 assert.throws(() => s.beginThreadFork(scope, 'child', 'side'), /conflict/);
 s.beginThreadFork(scope, 'child', 'unknown'); f.close(s);
 const next = f.open(); assert.equal(next.hasThread(scope.hostId, 'child'), true);
 assert.equal(next.forThread({ ...scope, principalId: 'bob' }, 'child'), null);
 assert.throws(() => next.beginThreadFork(scope, 'child', 'unknown'), /reconciliation/);
 assert.equal(next.read(scope, row.workspaceId).instanceId, 'instance');
});

test('late fork evidence survives compute replacement but cannot alias parent or foreign member', t => {
 const f = fixture(t), s = f.open(), row = s.admit(scope, 'main', selection);
 s.attachThread(scope, row.workspaceId, 'parent'); const lease = s.beginCreate(scope, row.workspaceId); s.confirmCreated(scope, lease, 'instance');
 s.beginThreadFork(scope, 'parent', 'side');
 s.beginRelease(scope, lease); s.confirmComputeAbsent(scope, lease); const next = s.beginCreate(scope, row.workspaceId); s.confirmCreated(scope, next, 'next');
 assert.throws(() => s.confirmThreadForked(scope, lease, 'side', 'parent'), /conflict/);
 const other = s.admit(scope, 'other', selection); s.attachThread(scope, other.workspaceId, 'foreign');
 assert.throws(() => s.confirmThreadForked(scope, lease, 'side', 'foreign'), /conflict/);
 s.confirmThreadForked(scope, lease, 'side', 'late');
 assert.equal(s.forThread(scope, 'late')?.generation, next.generation);
 assert.equal(s.read(scope, row.workspaceId).instanceId, 'next');
});

test('fork inventory exposes pending evidence and rejects same-workspace child receipt aliasing', t => {
 const f = fixture(t), s = f.open(), row = s.admit(scope, 'main', selection);
 s.attachThread(scope, row.workspaceId, 'parent'); const lease = s.beginCreate(scope, row.workspaceId); s.confirmCreated(scope, lease, 'instance');
 s.beginThreadFork(scope, 'parent', 'first'); s.beginThreadFork(scope, 'parent', 'second');
 assert.equal(s.pendingForks(scope.hostId).length, 2);
 const page = s.pendingForks(scope.hostId, undefined, 1);
 assert.equal(s.pendingForks(scope.hostId, page[0], 1)[0].intentId, 'second');
 assert.equal(s.pendingForks('foreign-host').length, 0);
 s.confirmThreadForked(scope, lease, 'first', 'child');
 s.confirmThreadForked(scope, lease, 'first', 'child');
 assert.throws(() => s.confirmThreadForked(scope, lease, 'second', 'child'), /membership conflict/);
 assert.deepEqual(s.pendingForks(scope.hostId).map(fork => fork.intentId), ['second']);
 assert.deepEqual(s.pendingForks(scope.hostId)[0].lease, lease);
 assert.equal(s.read(scope, row.workspaceId).phase, 'live');
});


test('schema4 migration backfills primary membership while preserving lease and selection', t => {
 const f=fixture(t),s=f.open(),row=s.admit(scope,'legacy-main',selection);
 s.attachThread(scope,row.workspaceId,'legacy-parent');
 const lease=s.beginCreate(scope,row.workspaceId);s.confirmCreated(scope,lease,'legacy-instance');f.close(s);
 const db=new DatabaseSync(join(f.root,'ordinary-workspaces.sqlite'));
 db.exec("DROP TABLE ordinary_workspace_members; DROP TABLE ordinary_workspace_forks; UPDATE workspace_journal_meta SET value='4' WHERE key='schema'");db.close();
 const migrated=f.open();
 assert.equal(migrated.forThread(scope,'legacy-parent')?.workspaceId,row.workspaceId);
 assert.equal(migrated.forThread(scope,'legacy-parent')?.leaseOwner,lease.owner);
 assert.equal(migrated.forThread(scope,'legacy-parent')?.instanceId,'legacy-instance');
 assert.equal(migrated.forThread({...scope,principalId:'bob'},'legacy-parent'),null);
 const intent=migrated.beginThreadFork(scope,'legacy-parent','migrated-side');
 migrated.confirmThreadForked(scope,intent.lease,'migrated-side','child');
 f.close(migrated);const reopened=f.open();
 assert.equal(reopened.forThread(scope,'child')?.workspaceId,row.workspaceId);
 assert.equal(reopened.read(scope,row.workspaceId).selectionDigest,selection);
});

test('pending-fork classification fence survives actual process restart and clears only on receipt',t=>{
 const f=fixture(t),s=f.open(),row=s.admit(scope,'fence',selection);
 s.attachThread(scope,row.workspaceId,'parent'); const lease=s.beginCreate(scope,row.workspaceId);
 s.confirmCreated(scope,lease,'instance');
 assert.equal(s.hasPendingForks(scope.hostId),false);
 s.beginThreadFork(scope,'parent','uncertain-side');
 assert.equal(s.hasPendingForks(scope.hostId),true);
 assert.equal(s.hasPendingForks('other-host'),false); f.close(s);
 const module=new URL('../../apps/local-agent-host/src/ordinary-workspace-store.ts',import.meta.url).href;
 const code=`import {OrdinaryWorkspaceStore} from ${JSON.stringify(module)};const s=new OrdinaryWorkspaceStore(${JSON.stringify(f.root)},'deployment-a');console.log(JSON.stringify({pending:s.hasPendingForks('host-a'),foreign:s.hasPendingForks('other-host')}));s.close();`;
 const out=execFileSync(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),'--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'}});
 assert.deepEqual(JSON.parse(out),{pending:true,foreign:false});
 const next=f.open();next.confirmThreadForked(scope,lease,'uncertain-side','confirmed-child');
 assert.equal(next.hasPendingForks(scope.hostId),false);
 assert.equal(next.forThread(scope,'confirmed-child')?.workspaceId,row.workspaceId);
});

test('member archive state survives reopen; unknown forks and late child receipts prevent premature compute retirement',t=>{
 const f=fixture(t);let s=f.open();const row=s.admit(scope,'lifecycle',selection),lease=s.beginCreate(scope,row.workspaceId);
 s.confirmCreated(scope,lease,'instance');s.attachThread(scope,row.workspaceId,'parent');
 const fork=s.beginThreadFork(scope,'parent','child');
 s.recordMemberLifecycle(scope.hostId,'parent','archived',1);
 assert.equal(s.canRetireArchivedWorkspace(scope,row.workspaceId),false);
 f.close(s);s=f.open();assert.equal(s.memberArchived(scope.hostId,'parent'),true);
 s.confirmThreadForked(scope,fork.lease,'child','child');
 assert.equal(s.hasActiveMembers(scope,row.workspaceId),true);
 assert.equal(s.canRetireArchivedWorkspace(scope,row.workspaceId),false);
 s.recordMemberLifecycle(scope.hostId,'child','archived',1);
 assert.equal(s.canRetireArchivedWorkspace(scope,row.workspaceId),true);
 f.close(s);s=f.open();assert.equal(s.canRetireArchivedWorkspace(scope,row.workspaceId),true);
 s.recordMemberLifecycle(scope.hostId,'parent','active',2);
 s.recordMemberLifecycle(scope.hostId,'parent','archived',1);
 assert.equal(s.memberArchived(scope.hostId,'parent'),false);
 assert.equal(s.canRetireArchivedWorkspace(scope,row.workspaceId),false);
});

test('private volume deletion requires all archived members permanently deleted and survives restart',t=>{
 const f=fixture(t);let s=f.open();const row=s.admit(scope,'purge',selection),lease=s.beginCreate(scope,row.workspaceId);
 s.recordProviderReceipt(scope,lease,{instanceId:'instance',privateVolumeId:'11111111-1111-1111-1111-111111111111'});
 s.confirmCreated(scope,lease,'instance');s.attachThread(scope,row.workspaceId,'parent');
 const fork=s.beginThreadFork(scope,'parent','side');s.confirmThreadForked(scope,fork.lease,'side','child');
 for(const id of ['parent','child'])s.recordMemberLifecycle(scope.hostId,id,'archived',1);
 s.beginRelease(scope,lease);s.confirmComputeAbsent(scope,lease);
 s.recordMemberLifecycle(scope.hostId,'parent','deleted',2);
 assert.throws(()=>s.beginPrivateVolumeDeletion(scope,row.workspaceId),/not admitted/);
 s.recordMemberLifecycle(scope.hostId,'child','deleted',2);
 const intent=s.beginPrivateVolumeDeletion(scope,row.workspaceId);assert.equal(intent.state,'pending');
 f.close(s);s=f.open();assert.deepEqual(s.beginPrivateVolumeDeletion(scope,row.workspaceId),intent);
 s.confirmPrivateVolumeDeleted(scope,row.workspaceId,intent.volumeId);
 assert.equal(s.beginPrivateVolumeDeletion(scope,row.workspaceId).state,'deleted');
 s.recordMemberLifecycle(scope.hostId,'child','active',3);
 assert.equal(s.allMembersDeleted(scope,row.workspaceId),true);
});
test('deleting an unarchived member cannot authorize private volume deletion',t=>{
 const f=fixture(t),s=f.open(),row=s.admit(scope,'unarchived-delete',selection),lease=s.beginCreate(scope,row.workspaceId);
 s.recordProviderReceipt(scope,lease,{instanceId:'instance',privateVolumeId:'11111111-1111-1111-1111-111111111111'});
 s.confirmCreated(scope,lease,'instance');s.attachThread(scope,row.workspaceId,'thread');
 s.recordMemberLifecycle(scope.hostId,'thread','deleted',1);s.beginRelease(scope,lease);s.confirmComputeAbsent(scope,lease);
 assert.throws(()=>s.beginPrivateVolumeDeletion(scope,row.workspaceId),/confirmed archived/);
});


test('unknown future schema and incomplete published v6 fail closed without repair',t=>{
 const f=fixture(t),s=f.open();s.admit(scope,'integrity',selection);f.close(s);
 const file=join(f.root,'ordinary-workspaces.sqlite'),db=new DatabaseSync(file);
 db.exec("UPDATE workspace_journal_meta SET value='99' WHERE key='schema'");
 assert.throws(()=>f.open(),/Unsupported/);
 assert.equal(db.prepare("SELECT value FROM workspace_journal_meta WHERE key='schema'").get()!.value,'99');
 db.exec("UPDATE workspace_journal_meta SET value='6' WHERE key='schema';DROP TABLE ordinary_workspace_members");
 assert.throws(()=>f.open(),/Incomplete/);
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='ordinary_workspace_members'").get()!.n,0);
 assert.equal(db.prepare("SELECT value FROM workspace_journal_meta WHERE key='schema'").get()!.value,'6');db.close();
});
test('fork custody inventory includes children, and deletion intent fences allocation after restart',t=>{
 const f=fixture(t);let s=f.open();const row=s.admit(scope,'custody',selection),lease=s.beginCreate(scope,row.workspaceId);
 s.recordProviderReceipt(scope,lease,{instanceId:'instance',privateVolumeId:'volume'});s.confirmCreated(scope,lease,'instance');s.attachThread(scope,row.workspaceId,'parent');
 const fork=s.beginThreadFork(scope,'parent','fork');s.confirmThreadForked(scope,fork.lease,'fork','child');
 assert.equal(s.lifecycleForThread(scope.hostId,'child')[0]!.workspaceId,row.workspaceId);
 assert.deepEqual(s.lifecycleForThread('other-host','child'),[]);
 for(const id of ['parent','child']){s.recordMemberLifecycle(scope.hostId,id,'archived',1);s.recordMemberLifecycle(scope.hostId,id,'deleted',2);}
 s.beginRelease(scope,lease);s.confirmComputeAbsent(scope,lease);s.beginPrivateVolumeDeletion(scope,row.workspaceId);f.close(s);s=f.open();
 assert.throws(()=>s.beginCreate(scope,row.workspaceId),/reconciliation/);
 s.confirmPrivateVolumeDeleted(scope,row.workspaceId,'volume');assert.throws(()=>s.beginCreate(scope,row.workspaceId),/reconciliation/);
});


test('placement paging includes every shared member even across a page boundary', t => {
 const f=fixture(t),s=f.open(),row=s.admit(scope,'placement',selection),lease=s.beginCreate(scope,row.workspaceId);
 s.confirmCreated(scope,lease,'instance');s.attachThread(scope,row.workspaceId,'parent');
 const fork=s.beginThreadFork(scope,'parent','side');s.confirmThreadForked(scope,fork.lease,'side','child');
 const first=s.placementPage(scope.hostId,'',1);assert.equal(first.length,1);
 const cursor=first[0]!.workspaceId+'.'+Buffer.from(first[0]!.threadId,'utf8').toString('hex');
 const second=s.placementPage(scope.hostId,cursor,1);assert.equal(second.length,1);
 assert.deepEqual([first[0]!.threadId,second[0]!.threadId].sort(),['child','parent']);
 const last=second[0]!.workspaceId+'.'+Buffer.from(second[0]!.threadId,'utf8').toString('hex');
 assert.equal(s.placementPage(scope.hostId,last,1).length,0);
 assert.throws(()=>s.placementPage(scope.hostId,row.workspaceId),/cursor/);
});
