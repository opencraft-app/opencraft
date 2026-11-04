import assert from 'node:assert/strict';
import test from 'node:test';

import {JsonRpcAppServerClient} from '@opencraft/appserver-client';
import {createCordisThreadSessionRuntime} from '@opencraft/appserver-session';
import {MemoryTransport} from '@opencraft/appserver-transport-memory';
import {encodeJsonRpcMessage,isJsonRpcRequest,parseJsonRpcMessage} from '@opencraft/appserver-protocol';
const turn=(status='inProgress')=>({id:'t',historyWindowId:'window',status,itemsView:'full',items:[{id:'a',type:'agentMessage',text:status==='inProgress'?'partial':'complete answer',completed:status==='completed'}],...(status==='completed'?{durationMs:1000,completedAt:10}:{})});
async function fixture(initialTurns=[turn()]){
 let revision=1,canonical=initialTurns,serverPeer;
 const transport=new MemoryTransport({receive(raw,peer){serverPeer=peer;const req=parseJsonRpcMessage(raw);if(!isJsonRpcRequest(req))return;
 const send=result=>peer.send(encodeJsonRpcMessage({id:req.id,result}));
 if(req.method==='thread/turns/list'){send({data:[...canonical].reverse(),nextCursor:null});return;}
 if(req.method==='initialize'){send({codexHome:'/synthetic',platformFamily:'unix',platformOs:'linux',userAgent:'synthetic'});return;}
 send({thread:{id:'a',sessionId:'a',path:'/synthetic',cwd:'/synthetic',updatedAt:revision,historyMode:'message-window',turns:[]},model:'synthetic',modelProvider:'synthetic',cwd:'/synthetic',runtimeWorkspaceRoots:[],approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{},initialTurnsPage:{data:[...canonical].reverse(),nextCursor:null},turnsBackwardsCursor:null,itemsBackwardsCursor:null});
 }});
 const client=new JsonRpcAppServerClient({hostId:'synthetic',transport});await client.connect({clientInfo:{name:'synthetic',version:'1'}});
 const session=await createCordisThreadSessionRuntime({client,historyModeHint:'message-window'});
 session.historyStrategies.register({name:'synthetic-window',priority:1000,matches:()=>true,async load(){return {source:'message-window',turns:canonical,complete:true,olderCursor:null,itemsPaginationByTurnId:{}};}});
 await session.resume.resume({threadId:'a'});
 return {session,client,async notify(method,params){serverPeer.send(encodeJsonRpcMessage({method,params}));await new Promise(r=>setImmediate(r));},complete(){canonical=[turn('completed')];revision++;},async close(){await session.dispose();await client.close();}};
}
test('legacy message-window force restore replaces a stale running Turn with its canonical terminal snapshot',async()=>{
 const f=await fixture();try{
  assert.equal(f.session.views.get('a').turns[0].status,'inProgress');f.complete();
  await f.session.resume.resume({threadId:'a',force:true});
  const result=f.session.views.get('a').turns[0];assert.equal(result.status,'completed');assert.equal(result.items[0].text,'complete answer');assert.equal(result.durationMs,1000);
 }finally{await f.close();}
});
test('message-window refresh promotes the canonical terminal Turn',async()=>{
 const f=await fixture();try{
  f.complete();assert.equal(await f.session.resume.refreshHistory('a'),true);
  assert.equal(f.session.views.get('a').turns[0].status,'completed');
 }finally{await f.close();}
});
test('control: canonical read replaces the stale running Turn',async()=>{
 const f=await fixture();try{f.complete();await f.session.resume.read('a');const result=f.session.views.get('a').turns[0];assert.equal(result.status,'completed');assert.equal(result.durationMs,1000);}finally{await f.close();}
});
for(const clock of [{startedAt:10},{startedAtMs:10000},{turnStartedAtMs:10000}])test('completion derives duration using prior clock '+Object.keys(clock)[0],async()=>{
 const f=await fixture([{id:'t',status:'inProgress',itemsView:'full',error:null,startedAt:null,completedAt:null,durationMs:null,...clock,items:[]}]);try{
  await f.session.resume.read('a');
  await f.notify('turn/completed',{threadId:'a',turn:{id:'t',status:'completed',itemsView:'summary',error:null,startedAt:null,completedAt:12,durationMs:null,items:[]}});
  const result=f.session.views.get('a').turns[0];assert.equal(result.status,'completed');
  assert.equal(result.durationMs,2000);
 }finally{await f.close();}
});
