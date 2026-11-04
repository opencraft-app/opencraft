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

const tool=(status='inProgress')=>({id:'tool',type:'commandExecution',pluginId:null,scriptPath:null,command:'printf ok',cwd:'/synthetic',processId:null,source:'agent',commandActions:[],exitCode:status==='completed'?0:null,durationMs:null,status,aggregatedOutput:status==='completed'?'ok':''});
const full=(id='target')=>({id,status:'completed',itemsView:'full',items:[item('answer')]});

test('lifecycle clocks survive persistence and owner reopen',async t=>{
 const {registerBuiltinThreadProjectors}=await import('../../packages/appserver-session/src/projectors.js');
 const projectors:any[]=[];registerBuiltinThreadProjectors({threadResumeProjectors:{register:()=>()=>{}},threadNotificationProjectors:{register:(p:any)=>{projectors.push(p);return()=>{};}}} as any);
 const projector=projectors.find(p=>p.name==='item-notifications'),f=await fixture(t);
 f.history.observe('turn/started',{threadId:'thread',turn:{id:'target',status:'inProgress'}});
 let view:any={threadId:'thread',turns:[{id:'target',status:'inProgress',items:[]}],notificationRevision:0};
 for(const event of [{method:'item/started',params:{threadId:'thread',turnId:'target',item:tool(),startedAtMs:1000}},{method:'item/completed',params:{threadId:'thread',turnId:'target',item:tool('completed'),completedAtMs:4000}}]){view=projector.project(view,event);f.history.observe(event.method,event.params);}
 const live=view.turns[0].items[0];await f.reopen();const stored=f.history.read('thread/items/list',{threadId:'thread',turnId:'target'}).data[0].item;
 results.push({case:'notification-clocks',live:{startedAtMs:live.startedAtMs,completedAtMs:live.completedAtMs},stored:{startedAtMs:stored.startedAtMs,completedAtMs:stored.completedAtMs}});
 assert.equal(live.startedAtMs,1000);assert.equal(live.completedAtMs,4000);assert.equal(stored.startedAtMs,live.startedAtMs);assert.equal(stored.completedAtMs,live.completedAtMs);
});

for(const persisted of [false,true])test(`Item page envelope clocks survive actual Session hydration; persisted=${persisted}`,async t=>{
 const {hydrateReadTurnItems}=await import('../../packages/appserver-session/src/history-strategies.js');const f=await fixture(t);
 const page={data:[{turnId:'target',item:tool('completed'),startedAtMs:1000,completedAtMs:4000}],nextCursor:null};
 if(persisted)f.history.importResult('thread/items/list',{threadId:'thread',turnId:'target'},page,f.history.revision('thread'));
 const turns=await hydrateReadTurnItems({client:{request:async()=>persisted?f.history.read('thread/items/list',{threadId:'thread',turnId:'target'}):page} as any,threadId:'thread',requestTimeoutMs:1000},[{id:'target',status:'completed',itemsView:'notLoaded',items:[]}] as any);
 const row=turns[0].items![0];results.push({case:'page-envelope-clocks',persisted,startedAtMs:row.startedAtMs,completedAtMs:row.completedAtMs});
 assert.equal(row.startedAtMs,1000);assert.equal(row.completedAtMs,4000);
});

test('a header-only observation cannot reopen a completed Turn in durable history',async t=>{
 const {applyCommittedHistory}=await import('../../packages/appserver-session/src/committed-history.js');const f=await fixture(t),completed=full();
 f.history.importResult('thread/turns/list',{threadId:'thread'},{data:[completed],nextCursor:null},f.history.revision('thread'));let update:any;
 f.history.subscribeCommitted((_ids,_revision,updates)=>{update=updates.get('thread');});
 const imported=f.history.importResult('thread/turns/list',{threadId:'thread',itemsView:'notLoaded'},{data:[{id:'target',status:'inProgress',itemsView:'notLoaded',items:[]}],nextCursor:null},f.history.revision('thread'));
 const hot=applyCommittedHistory([completed] as any,update)[0];await f.reopen();const cold=f.history.read('thread/turns/list',{threadId:'thread',itemsView:'full'}).data[0];
 results.push({case:'terminal-turn-regression',imported,hot:hot.status,cold:cold.status});assert.equal(hot.status,'completed');assert.equal(cold.status,hot.status);
});

test('full refresh preserves already observed lifecycle timestamps',async t=>{
 const f=await fixture(t),initial={...full(),items:[{...tool('completed'),startedAtMs:1000,completedAtMs:4000}]};
 f.history.importResult('thread/turns/list',{threadId:'thread'},{data:[initial],nextCursor:null},f.history.revision('thread'));
 f.history.importResult('thread/turns/list',{threadId:'thread'},{data:[{...initial,items:[tool('completed')]}],nextCursor:null},f.history.revision('thread'));
 const row=f.history.read('thread/turns/list',{threadId:'thread',itemsView:'full'}).data[0].items[0];results.push({case:'clock-erasure-by-full-refresh',startedAtMs:row.startedAtMs,completedAtMs:row.completedAtMs});assert.equal(row.startedAtMs,1000);assert.equal(row.completedAtMs,4000);
});

for(const persisted of [false,true])test(`mismatched source Turn cannot be silently relabelled by storage; persisted=${persisted}`,async t=>{
 const {hydrateReadTurnItems}=await import('../../packages/appserver-session/src/history-strategies.js');const f=await fixture(t),page={data:[{turnId:'other-turn',item:item('foreign')}],nextCursor:null};
 if(persisted)assert.throws(()=>f.history.importResult('thread/items/list',{threadId:'thread',turnId:'target'},page,f.history.revision('thread')),/unexpected group/);
 let accepted=false,error:string|undefined,ids:string[]=[];
 try{const turns=await hydrateReadTurnItems({client:{request:async()=>page} as any,threadId:'thread',requestTimeoutMs:1000},[{id:'target',status:'completed',itemsView:'notLoaded',items:[]}] as any);accepted=true;ids=turns[0].items!.map(r=>r.id!);}catch(e){error=String(e);}
 results.push({case:'source-turn-mismatch',persisted,accepted,error,ids});assert.equal(accepted,false,'identity mismatch must remain an error through persistence');
});
