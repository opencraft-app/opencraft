import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {ConversationHistory,HistoryNotStored} from '../../packages/app-host-server/src/conversation-history.js';
import {ConversationHistoryTransport} from '../../packages/app-host-server/src/conversation-history-transport.js';
type V=Record<string,any>;

const results:V[]=[];
const item=(id:string)=>({id,type:'agentMessage',text:`item ${id}`});
const metadata={id:'thread',cwd:'/synthetic',createdAt:1,updatedAt:2,historyMode:'paginated',turns:[]};
async function fixture(t:test.TestContext){
 const directory=mkdtempSync(join(tmpdir(),'history-item-audit-'));let storage=await openServerDatabase(directory);let history=new ConversationHistory(storage.database,'local-codex');
 history.importResult('thread/read',{threadId:'thread',includeTurns:true},{thread:{...metadata,turns:['target','live'].map(id=>({id,status:'inProgress',itemsView:'notLoaded',items:[]}))}},0);
 t.after(async()=>{await storage.close();rmSync(directory,{force:true,recursive:true});});
 return {get history(){return history;},async reopen(){await storage.close();storage=await openServerDatabase(directory);history=new ConversationHistory(storage.database,'local-codex');}};
}
class Engine{
 status:any={state:'open'};messages=new Set<(f:string)=>void>();sends:V[]=[];handle:(p:V)=>V|null=()=>({});
 async connect(){}async close(){} subscribeStatus(){return()=>{};}
 subscribeMessage(listener:(f:string)=>void){this.messages.add(listener);return()=>this.messages.delete(listener);}
 emit(packet:V){for(const listener of this.messages)listener(JSON.stringify(packet));}
 async send(frame:string){const p=JSON.parse(frame);this.sends.push(p);let result:V|null;
 if(p.method==='initialize')result={userAgent:'synthetic-item-audit',capabilities:{extensions:{}}};else result=this.handle(p);
 if(p.id!==undefined&&result)this.emit({id:p.id,result,__opencraftClient:p.__opencraftClient});}
}
async function rpc(transport:any,id:number,method:string,params:V={}){
 let response:V|undefined;const remove=transport.subscribeMessage((f:string)=>{const p=JSON.parse(f);if(p.id===id&&!p.method)response=p;});
 try{await transport.send(JSON.stringify({id,method,params}));assert.ok(response);return response;}finally{remove();}
}
function pager(engine:Engine,owner:string){engine.handle=p=>{
 if(p.method!=='thread/items/list')return{};
 const direction=p.params.sortDirection??'asc',cursor=p.params.cursor;
 if(cursor!=null&&!String(cursor).startsWith(`${owner}:${direction}:`)){
  engine.emit({id:p.id,error:{code:-32080,message:'Cursor belongs to a different connection or sort',data:{retryable:true}},__opencraftClient:p.__opencraftClient});return null;
 }
 const items=(direction==='desc'?['c','b','a']:['a','b','c']).map(item),offset=cursor==null?0:Number(String(cursor).split(':').at(-1)),limit=p.params.limit??1;
 return{data:items.slice(offset,offset+limit).map(item=>({turnId:'target',item})),nextCursor:offset+limit<items.length?`${owner}:${direction}:${offset+limit}`:null};
};}
for(const persisted of [false,true])test(`Item continuation survives owner reopen; persisted=${persisted}`,async t=>{
 const f=await fixture(t);f.history.importResult('thread/items/list',{threadId:'thread',turnId:'target'},{data:[{item:item('a')}],nextCursor:'former:asc:1'},f.history.revision('thread'));
 const cursor=f.history.read('thread/items/list',{threadId:'thread',turnId:'target',limit:1}).nextCursor;await f.reopen();
 const engine=new Engine();pager(engine,'current');const transport=persisted?new ConversationHistoryTransport(engine as any,f.history,undefined,1000):engine;t.after(()=>transport.close());await transport.connect();await rpc(transport,1,'initialize');
 const response=await rpc(transport,2,'thread/items/list',{threadId:'thread',turnId:'target',cursor:persisted?cursor:'current:asc:1',limit:2,sortDirection:'asc'});
 results.push({case:'reopen',persisted,error:response.error,ids:response.result?.data?.map((r:V)=>r.item.id),nativeCursors:engine.sends.filter(p=>p.method==='thread/items/list').map(p=>p.params.cursor)});
 assert.equal(response.error,undefined,JSON.stringify(response.error));assert.deepEqual(response.result.data.map((r:V)=>r.item.id),['b','c']);
});
for(const persisted of [false,true])test(`ascending Item read after a descending partial observation; persisted=${persisted}`,async t=>{
 const f=await fixture(t);f.history.importResult('thread/items/list',{threadId:'thread',turnId:'target',sortDirection:'desc'},{data:[{item:item('c')}],nextCursor:'current:desc:1'},f.history.revision('thread'));
 const engine=new Engine();pager(engine,'current');const transport=persisted?new ConversationHistoryTransport(engine as any,f.history,undefined,1000):engine;t.after(()=>transport.close());await transport.connect();await rpc(transport,1,'initialize');
 const first=await rpc(transport,2,'thread/items/list',{threadId:'thread',turnId:'target',limit:3,sortDirection:'asc'}),ids=(first.result?.data??[]).map((r:V)=>r.item.id);let next:V|undefined;
 if(first.result?.nextCursor){next=await rpc(transport,3,'thread/items/list',{threadId:'thread',turnId:'target',limit:3,sortDirection:'asc',cursor:first.result.nextCursor});ids.push(...(next.result?.data??[]).map((r:V)=>r.item.id));}
 results.push({case:'sort-direction',persisted,ids,error:first.error??next?.error,nativeCursors:engine.sends.filter(p=>p.method==='thread/items/list').map(p=>p.params.cursor)});
 assert.equal(first.error??next?.error,undefined);assert.deepEqual(ids,['a','b','c']);
});
test('a fenced Item import must not escape as an unversioned native continuation',async t=>{
 const f=await fixture(t),engine=new Engine();engine.handle=p=>{
  if(p.method!=='thread/items/list')return{};
  engine.emit({method:'item/completed',params:{threadId:'thread',turnId:'live',item:item('new-live')},__opencraftClient:p.__opencraftClient});
  return{data:[{item:item('a'),turnId:'target'}],nextCursor:'current:asc:1'};
 };
 const diagnostics:string[]=[],transport=new ConversationHistoryTransport(engine as any,f.history,x=>diagnostics.push(x),1000);t.after(()=>transport.close());await transport.connect();await rpc(transport,1,'initialize');
 const response=await rpc(transport,2,'thread/items/list',{threadId:'thread',turnId:'target',limit:1,sortDirection:'asc'});let stored=false;try{stored=f.history.read('thread/items/list',{threadId:'thread',turnId:'target'}).data.length>0;}catch(error){assert.ok(error instanceof HistoryNotStored);}
 results.push({case:'fenced-import-fallback',error:response.error,nextCursor:response.result?.nextCursor,historyVersion:response.result?.historyVersion,returnedIds:response.result?.data?.map((r:V)=>r.item.id),stored,diagnostics});
 assert.ok(response.error||response.result.historyVersion&&stored,'supported stored Item replies need committed facts or a retryable failure');
});

for(const persisted of [false,true])test(`real Pi/DSH Item projection after opposite-direction prefix; persisted=${persisted}`,async t=>{
 const {projectedItemsPage}=await import('../../packages/appserver-client/src/projected-history.js');
 const f=await fixture(t),thread={id:'thread',turns:[{id:'target',items:['a','b','c'].map(item)}]};
 const previous=projectedItemsPage(thread,{threadId:'thread',turnId:'target',sortDirection:'desc',limit:1});
 f.history.importResult('thread/items/list',{threadId:'thread',turnId:'target',sortDirection:'desc'},previous,f.history.revision('thread'));
 const engine=new Engine();engine.handle=p=>p.method==='thread/items/list'?projectedItemsPage(thread,p.params):{};
 const transport=persisted?new ConversationHistoryTransport(engine as any,f.history,undefined,1000):engine;t.after(()=>transport.close());await transport.connect();await rpc(transport,1,'initialize');
 const first=await rpc(transport,2,'thread/items/list',{threadId:'thread',turnId:'target',sortDirection:'asc',limit:3}),ids=(first.result?.data??[]).map((r:V)=>r.item.id);let next:V|undefined;
 if(first.result?.nextCursor){next=await rpc(transport,3,'thread/items/list',{threadId:'thread',turnId:'target',sortDirection:'asc',limit:3,cursor:first.result.nextCursor});ids.push(...(next.result?.data??[]).map((r:V)=>r.item.id));}
 results.push({case:'production-projected-items',persisted,ids,error:first.error??next?.error,ended:first.result?.nextCursor===null||next?.result?.nextCursor===null,nativeCursors:engine.sends.filter(p=>p.method==='thread/items/list').map(p=>p.params.cursor)});
 assert.equal(first.error??next?.error,undefined);assert.deepEqual(ids,['a','b','c']);
});
