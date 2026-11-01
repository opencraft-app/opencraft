import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runParent,ensureParentDelivery,parentRecoverySocket} from '../../scripts/full-upgrade/parent.mjs';
const digest='a'.repeat(64);
async function fixture(t,call){const root=await mkdtemp(join(tmpdir(),'full-parent-'));t.after(()=>rm(root,{recursive:true,force:true}));return {config:{stateRoot:root,deployLock:join(root,'lock')},deps:{recipe:async()=>({recipeSha256:digest,recipe:{steps:[{id:'provider',ownerId:'provider',sha256:digest},{id:'consumer',ownerId:'consumer',sha256:digest}]}}),target:async()=>({root,manifestSha256:digest,releaseId:'test-release'}),call}};}
test('full parent runs dependency order under the real shared kernel lock and keeps receipts',async t=>{
 const calls=[];const f=await fixture(t,async(step,input,fd)=>{const info=await readFile('/proc/self/fdinfo/'+fd,'utf8');assert.match(info,/FLOCK/);assert.ok(info.split('\n').some(line=>line.startsWith('lock:')&&line.trim().split(/\s+/)[5]===String(input.lockAuthority.pid)));assert.match(await readFile('/proc/'+input.lockAuthority.pid+'/stat','utf8'),/python/);calls.push(input.action+':'+step.id);return {...input,stepId:step.id,ownerId:step.ownerId,outcome:'applied',healthy:true};});
 const r=await runParent(f.config,{operationId:'test-parent'},f.deps);assert.equal(r.job.state,'completed');assert.deepEqual(calls,['inspect:provider','inspect:consumer','apply:provider','apply:consumer']);
 calls.length=0;await runParent(f.config,{operationId:'test-parent'},f.deps);assert.deepEqual(calls,['inspect:provider','inspect:consumer']);
});
test('lost child response recovers that exact intent and never reapplies it',async t=>{
 const calls=[];const f=await fixture(t,async(step,input)=>{calls.push(input.action+':'+step.id);if(input.action==='apply'&&step.id==='provider')throw Error('lost-response');return {...input,stepId:step.id,ownerId:step.ownerId,outcome:input.action==='recover'?'recovered':'applied',targetMatched:true,healthy:true};});
 const r=await runParent(f.config,{operationId:'lost-child'},f.deps);assert.equal(r.job.state,'completed');assert.equal(calls.filter(x=>x==='apply:provider').length,1);assert.ok(calls.includes('recover:provider'));
});
test('healthy old owner recovery stops the graph rather than claiming the target applied',async t=>{
 const calls=[];const f=await fixture(t,async(step,input)=>{calls.push(input.action+':'+step.id);return {...input,stepId:step.id,ownerId:step.ownerId,outcome:input.action==='apply'?'recovered':'applied',targetMatched:false,healthy:true};});
 const r=await runParent(f.config,{operationId:'old-recovery'},f.deps);assert.equal(r.job.state,'rolled-back');assert.ok(!calls.includes('apply:consumer'));
});
test('historical generations remain explicitly draining in the full parent',async t=>{
 const f=await fixture(t,async(step,input)=>({...input,stepId:step.id,ownerId:step.ownerId,outcome:step.id==='provider'?'draining':'applied',healthy:true}));
 assert.equal((await runParent(f.config,{operationId:'keep-history'},f.deps)).job.state,'active-draining');
});

test('official delivery submission is observed to a terminal state and never replayed',async t=>{
 const root=await mkdtemp(join(tmpdir(),'parent-delivery-'));t.after(()=>rm(root,{recursive:true,force:true}));let submits=0,observes=0;
 const config={fullCiBeforeParent:true,mode:'ci',ciRequest:['request'],ciObserve:['observe']};
 const deps={command:async name=>{if(name==='request'){submits++;return '';}observes++;return JSON.stringify({manualPending:observes===1,admission:{status:observes===1?'building':'current'}});},sleep:async()=>{}};
 await ensureParentDelivery(config,root,deps);await ensureParentDelivery(config,root,deps);assert.equal(submits,1);assert.ok(observes>=2);
});
test('recovery IPC path remains below the Unix socket limit for long operation IDs',()=>{
 assert.ok(Buffer.byteLength(parentRecoverySocket({runtimeRoot:'/run/opencraft-upgrade'},'full-'+digest))<108);
});
