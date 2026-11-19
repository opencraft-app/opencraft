import test from'node:test';import assert from'node:assert/strict';
import{assistantAction}from'../../plugins/wecom/mirror/interactions.mjs';
import{parseInteractionAction}from'../../plugins/wecom/interaction-actions.mjs';
import{readProviderState}from'../../plugins/wecom/mirror/provider-state.mjs';
const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']),taskId='oc-m-'+'a'.repeat(40);
function fixture(){const binding={serverId:'server',humanKey:'owner',generation:'g'},card={task_id:taskId,multi:true,owner:'owner',binding,deliveryStatus:'delivered',participants:['owner','other','gone'],main_title:{title:'午餐'},checkbox:{question_key:'q0',option_list:[{id:'a',text:'面'},{id:'b',text:'饭'}]}};let closed=false;const sent=[],events=[],answers=[{author:'owner',actor:'主人',choice:'面',selected:[{questionKey:'q0',optionIds:['a']}]}];const svc={store:{snapshot:async()=>({binding}),card:async()=>card,submitCard:async(s,id,author,answer,close)=>{closed||=close;return{closed:!!closed,answers};},ingest:async e=>events.push(e)},transport:{chatMembers:async()=>['owner','other','wbci'],sendMarkdown:async m=>{sent.push(m);return'delivered';},sendFile:async(s,name,bytes)=>{sent.push({name,bytes});return'delivered';}},authorizedSource:async(server,key)=>{if(server.id!=='server'||key!==source)throw Error('denied');return binding;}};return{svc,card,sent,events,run:(action,owner='owner')=>assistantAction(svc,{id:'server'},{source,owner,kind:'collection-control',taskId,action,requestId:'command-'+action},AbortSignal.timeout(2000))};}
test('owner can close once and export actual responses; no ResponseCode or arbitrary card handler exposed',async()=>{
 const f=fixture();assert.equal(await f.run('close'),'delivered');assert.equal(f.sent.length,1);assert.match(f.sent[0].text,/已结束/u);assert.equal(f.events[0].mentioned,false);assert.equal(await f.run('close'),'delivered');assert.equal(f.sent.length,1);
 assert.equal(await f.run('export'),'delivered');assert.equal(f.sent[1].name,'午餐.csv');assert.deepEqual([...f.sent[1].bytes.subarray(0,3)],[239,187,191]);assert.match(f.sent[1].bytes.toString(),/主人.*owner.*面/u);
 for(const action of ['close','export'])assert.equal(parseInteractionAction('/收集操作 '+JSON.stringify({action,taskId})).kind,'collection-control');
 assert.throws(()=>parseInteractionAction('/收集操作 '+JSON.stringify({action:'update',taskId})));assert.throws(()=>parseInteractionAction('/收集操作 '+JSON.stringify({action:'close',taskId,responseCode:'fake'})));
});
test('collection mutation rejects other owners, retired generation and unconfirmed delivery',async()=>{
 const f=fixture();await assert.rejects(f.run('close','other'),/denied/);f.card.binding={...f.card.binding,generation:'old'};await assert.rejects(f.run('export'),/denied/);assert.equal(f.sent.length,0);
 const g=fixture();g.card.deliveryStatus='pending';assert.equal(await g.run('close'),'rejected');assert.equal(g.sent.length,0);
});
test('structured collection read returns current initial participants, missing members, paginated raw answers and missing status',async()=>{
 const f=fixture(),params={source,owner:'owner',query:{kind:'interaction',taskId}};
 const result=await readProviderState(f.svc,{id:'server'},params,AbortSignal.timeout(2000));assert.deepEqual(result.participantIds,['owner','other']);assert.deepEqual(result.pendingMemberIds,['other']);assert.equal(result.total,1);
 f.svc.store.card=async()=>null;assert.deepEqual(await readProviderState(f.svc,{id:'server'},params,AbortSignal.timeout(2000)),{taskId,status:'missing'});
 await assert.rejects(readProviderState(f.svc,{id:'server'},{...params,owner:'intruder'},AbortSignal.timeout(2000)),/denied/);
});
