import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
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
