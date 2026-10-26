import assert from 'node:assert/strict';
import test from 'node:test';
import {ThreadOrchestrationResource} from '../../packages/workbench-runtime/src/thread-orchestration-resource';
const call={turnId:'turn',itemId:'item'},view={threadId:'parent',calls:[{...call,toolCallStatus:'complete',deliveryStatus:'queued',receiverThreadIds:['child'],childRuntimeStatus:{child:'active'}}]};

test('control cache restores current ledger facts, preserves display on read failure and releases polling',async()=>{
 let fail=false,reads=0;
 const resource=new ThreadOrchestrationResource({supported:()=>true,async read(){reads++;if(fail)throw Error('offline');return view;}});
 const release=resource.subscribe('parent',[call],()=>{});
 await resource.refresh('parent');assert.deepEqual(resource.getSnapshot('parent'),view);
 fail=true;await resource.refresh('parent');assert.deepEqual(resource.getSnapshot('parent'),view);
 release();resource.dispose();assert.equal(reads,2);
});

test('late replies from a retired connection cannot restore old control state',async()=>{
 let resolve!:(value:unknown)=>void;
 const resource=new ThreadOrchestrationResource({supported:()=>true,read:()=>new Promise(r=>{resolve=r;})});
 const release=resource.subscribe('parent',[call],()=>{}),pending=resource.refresh('parent');
 resource.reset();resolve(view);await pending;assert.equal(resource.getSnapshot('parent'),null);
 release();resource.dispose();
});

test('large visible histories read all tool identities in bounded pages without truncating older cards',async()=>{
 const batches:number[]=[];
 const resource=new ThreadOrchestrationResource({supported:()=>true,async read(threadId,calls){batches.push(calls.length);return {threadId,calls:calls.map(call=>({...view.calls[0],...call}))};}});
 const release=resource.subscribe('parent',Array.from({length:205},(_,i)=>({...call,itemId:String(i)})),()=>{});
 await resource.refresh('parent');assert.deepEqual(batches,[100,100,5]);assert.equal(resource.getSnapshot('parent')!.calls.length,205);
 release();resource.dispose();
});
