import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir,writeFile,readdir,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runParent,ensureParentDelivery,parentRecoverySocket,copyParentTarget} from '../../scripts/full-upgrade/parent.mjs';
import {command} from '../../scripts/full-upgrade/durable.mjs';
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

test('local full parent uses its installed package delivery adapter, never Main CI',async t=>{
 const root=await mkdtemp(join(tmpdir(),'parent-local-delivery-'));t.after(()=>rm(root,{recursive:true,force:true}));const calls=[];
 const config={mode:'local',fullLocalBeforeParent:true,localRequest:['local-request'],localObserve:['local-observe']};
 await ensureParentDelivery(config,root,{command:async name=>{calls.push(name);return name==='local-observe'?JSON.stringify({manualPending:false,admission:{status:'deployed'}}):'';}});
 assert.deepEqual(calls,['local-request','local-observe']);
});

async function copyFixture(t){
 const root=await mkdtemp(join(tmpdir(),'parent-target-copy-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'package'),pin=join(root,digest);await mkdir(source);
 await writeFile(join(source,'payload'),'signed payload');await writeFile(join(source,'.hidden'),'signed hidden');
 await mkdir(join(source,'collision'));await writeFile(join(source,'collision/item'),'signed child');
 const sibling=pin+'.preparing-'+process.pid;await mkdir(sibling);await writeFile(join(sibling,'keep'),'preexisting stage');
 return {root,source,pin,sibling};
}
test('real failed cp removes only its unique partial stage and preserves source and a reused-PID sibling',async t=>{
 const f=await copyFixture(t);let stage;
 await assert.rejects(copyParentTarget(f.source,f.pin,{command:async(binary,args,options)=>{
  stage=args.at(-1);assert.notEqual(stage,f.sibling);
  await writeFile(join(stage,'partial'),'partial copy');
  // Real cp rejects a directory/non-directory collision without filling a disk.
  await writeFile(join(stage,'collision'),'blocked destination');
  return command(binary,args,options);
 }}),error=>{assert.equal(error.cause.message,'command-failed');assert.deepEqual(error.failure,{stage:'verify-target',code:'target-copy-failed'});return true;});
 await assert.rejects(readFile(join(stage,'partial')),{code:'ENOENT'});
 await assert.rejects(readFile(join(f.pin,'payload')),{code:'ENOENT'});
 assert.equal(await readFile(join(f.source,'payload'),'utf8'),'signed payload');
 assert.equal(await readFile(join(f.sibling,'keep'),'utf8'),'preexisting stage');
 assert.deepEqual((await readdir(f.root)).sort(),['package',f.sibling.split('/').at(-1)].sort());
});
test('target copy preserves dotfiles without a nested package and leaves the accepted pin on a lost rename acknowledgment',async t=>{
 const f=await copyFixture(t),lost=new Error('lost rename acknowledgment');
 await assert.rejects(copyParentTarget(f.source,f.pin,{rename:async(from,to)=>{await rename(from,to);throw lost;}}),error=>error.cause===lost);
 assert.equal(await readFile(join(f.pin,'payload'),'utf8'),'signed payload');
 assert.equal(await readFile(join(f.pin,'.hidden'),'utf8'),'signed hidden');
 assert.equal(await readFile(join(f.pin,'collision/item'),'utf8'),'signed child');
 await assert.rejects(readFile(join(f.pin,'package/payload')),{code:'ENOENT'});
 assert.equal(await readFile(join(f.sibling,'keep'),'utf8'),'preexisting stage');
});
test('cleanup failure preserves both original and cleanup errors without claiming success or deleting siblings',async t=>{
 const f=await copyFixture(t),cleanup=new Error('private cleanup details');let stage,original;
 await assert.rejects(copyParentTarget(f.source,f.pin,{
  command:async(binary,args,options)=>{stage=args.at(-1);await writeFile(join(stage,'collision'),'blocked');try{return await command(binary,args,options);}catch(error){original=error;throw error;}},
  rm:async()=>{throw cleanup;},
 }),error=>{assert.deepEqual(error.errors,[original,cleanup]);assert.deepEqual(error.failure,{stage:'verify-target',code:'target-copy-cleanup-failed'});assert.ok(!JSON.stringify(error).includes('private cleanup details'));return true;});
 assert.equal(await readFile(join(stage,'collision'),'utf8'),'blocked');
 assert.equal(await readFile(join(f.sibling,'keep'),'utf8'),'preexisting stage');
});
