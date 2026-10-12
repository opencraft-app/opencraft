import assert from 'node:assert/strict';
import test from 'node:test';
import { TASKS } from '@opencraft/appserver-protocol';
import type { SubmitIntent, SubmissionReceipt } from '@opencraft/composer-core';
import { TaskConversationFlow } from '../apps/workbench-web/src/runtime/task-conversation-flow';

const intent = { target: { type: 'new-thread', draftId: 'draft' } } as SubmitIntent;
const receipt = { hostId: 'remote', threadId: 'thread', turnId: null } as SubmissionReceipt;
function setup() {
 const values=new Map<string,string>();
 const storage={get length(){return values.size;},key:(index:number)=>[...values.keys()][index]??null,getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
 const task={id:'task',title:'Work',description:'',status:'todo',projectServerId:null,projectId:null};
 return {values,storage,task};
}
import {TasksSqliteStore} from '../plugins/tasks/src/sqlite';

test('confirmed thread receipt reconciles conflicts and lost acknowledgements without any execution replay',async()=>{
 const {storage,values,task}=setup();
 const store=new TasksSqliteStore(':memory:'); store.create(task as any);
 let writes=0;
 const flow=new TaskConversationFlow({storage,storageKey:()=> 'account-a',serverId:host=>host,request:async(method,params)=>{
  if(method===TASKS.read)return store.read((params as any).id) as any;
  assert.equal(method,TASKS.attach); writes++;
  if(writes===1){store.update({...task,id:'task',expectedRevision:1,title:'Concurrent edit'});throw new Error('conflict');}
  store.attach(params as any); throw new Error('lost acknowledgement');
 }});
 flow.register('draft','task'); await flow.created(intent,receipt);
 assert.equal(writes,2); assert.equal(store.read('task').conversations.length,1);
 assert.equal(store.read('task').title,'Concurrent edit'); assert.deepEqual(flow.pending(),[]);
 assert.equal(values.size,0); flow.dispose();store.close();
});

test('failed linking retains the actual receipt across reload and only retries association',async()=>{
 const {storage,task}=setup();
 const store=new TasksSqliteStore(':memory:');store.create(task as any);
 let offline=true;let writes=0;
 const ports={storage,storageKey:()=> 'account-a',serverId:(host:string)=>host,request:async(method:any,params:any)=>{
  if(offline)throw new Error('offline');
  if(method===TASKS.read)return store.read(params.id) as any;
  writes++;return store.attach(params) as any;
 }};
 const flow=new TaskConversationFlow(ports); flow.register('draft','task'); await flow.created(intent,receipt);
 assert.deepEqual(flow.pending(),[{taskId:'task',serverId:'remote',threadId:'thread'}]);flow.dispose();
 const restored=new TaskConversationFlow(ports);offline=false;await Promise.all([restored.retry('task'),restored.retry('task')]);
 assert.equal(writes,1);assert.equal(store.read('task').conversations[0].threadId,'thread');assert.deepEqual(restored.pending(),[]);
 restored.dispose();store.close();
});

test('account revocation fences a late authority read and clears the old placement journal',async()=>{
 const {storage,values,task}=setup();
 const store=new TasksSqliteStore(':memory:');store.create(task as any);
 let resolve!:(value:any)=>void;let writes=0;
 const flow=new TaskConversationFlow({storage,storageKey:()=> 'account-a',serverId:host=>host,request:async(method)=>{
  if(method===TASKS.read)return await new Promise(r=>{resolve=r;}) as any;
  writes++;return {tasks:[]} as any;
 }});
 flow.register('draft','task');const pending=flow.created(intent,receipt);flow.revoke();resolve(store.read('task'));await pending;
 assert.equal(writes,0);assert.deepEqual(flow.pending(),[]);assert.equal(values.size,0);
 flow.dispose();store.close();
});

test('denied browser persistence rejects placement before any conversation can be created',()=>{
 const flow=new TaskConversationFlow({storage:{length:0,key:()=>null,getItem:()=>null,setItem:()=>{throw new Error('denied');},removeItem:()=>{}},storageKey:()=> 'a',serverId:host=>host,request:async()=>{throw new Error('unexpected');}});
 assert.throws(()=>flow.register('draft','task'),/denied/);assert.deepEqual(flow.pending(),[]);flow.dispose();
});

test('separate client drafts do not overwrite each other in the same browser profile',async()=>{
 const {storage,values}=setup();
 const ports={storage,storageKey:()=> 'account-a',serverId:(host:string)=>host,request:async()=>{throw new Error('offline');}};
 const a=new TaskConversationFlow(ports),b=new TaskConversationFlow(ports);
 a.register('draft','task-a');b.register('another-draft','task-b');
 await a.created(intent,receipt);
 await b.created({...intent,target:{type:'new-thread',draftId:'another-draft',execution:{} as any}}, {...receipt,threadId:'another-thread'});
 assert.equal(values.size,2);
 const restored=new TaskConversationFlow(ports);
 assert.deepEqual(restored.pending().map(link=>link.taskId).sort(),['task-a','task-b']);
 a.dispose();b.dispose();restored.dispose();
});
