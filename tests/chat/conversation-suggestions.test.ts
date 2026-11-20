import assert from 'node:assert/strict';
import test from 'node:test';
import {createConversationExecution,createRoutedConversationExecution} from '../../scripts/conversation-execution.mjs';

function hostFixture(){
 const requests:any[]=[];
 const host={accept(endpoint:any){const unsubscribe=endpoint.subscribe((message:any)=>{
  if(message.type==='hello')endpoint.postMessage({type:'ready'});
  if(message.type==='host/connect')endpoint.postMessage({type:'response',requestId:'connect',ok:true,result:{generation:1}});
  if(message.type==='host/send'){
   const rpc=JSON.parse(message.frame);if(rpc.method!=='initialize')requests.push({...rpc,hostId:message.hostId});
   const result=rpc.method==='initialize'?{}:{data:Array.from({length:30},(_,i)=>({id:'thread-'+i,name:'Title '+i,cwd:'/project',updatedAt:1700000000,turns:[{secret:'must not cross projection'}]})),nextCursor:'next'};
   endpoint.postMessage({type:'host/frame',hostId:message.hostId,generation:1,frame:JSON.stringify({id:rpc.id,result})});
  }
 });return {close:unsubscribe};}};
 return {host,requests};
}
test('suggestions issue one bounded, unarchived, DB-only title query and never read history',async()=>{
 const {host,requests}=hostFixture();const port=createConversationExecution(()=>host,{serverId:'server',hostId:'host'});
 for(const [search,limit] of [['',8],['方案',20]] as const){
  const r=await port.discover(search,null,{limit});const q=requests.at(-1);
  assert.equal(q.method,'thread/list');assert.deepEqual(q.params,{limit,searchTerm:search||null,archived:false,cursor:null,useStateDbOnly:true,sortKey:'updated_at',sortDirection:'desc'});
  assert.equal(r.conversations.length,limit);assert.equal(r.nextCursor,null);assert.equal(JSON.stringify(r).includes('secret'),false);
 }
 assert.equal(requests.length,2);
});
test('composer discovery stays on its execution namespace instead of aggregating every engine',async()=>{
 const {host,requests}=hostFixture();const port=createRoutedConversationExecution(()=>host,{machineId:'test',engines:['dsh'],getInputs:async()=>null});
 await port.discover('',null,{limit:8,sourceThreadId:'thread-current'});
 assert.equal(requests.length,1);assert.equal(requests[0].hostId,'local-codex');
});
