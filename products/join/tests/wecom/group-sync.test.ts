import '../../plugins/wecom/assistant-install.mjs';
import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{openServerDatabase}from'@opencraft/storage-node/server';import{ActorStore}from'../../../../packages/access-control/src/actors';import{Collaboration}from'../../../../packages/access-control/src/collaboration';
import{syncHash,syncConfig,syncSnapshot}from'../../plugins/wecom/group-sync.mjs';
import{createGroupSyncPump}from'../../plugins/wecom/mirror/group-sync-target.mjs';
import{groupSyncProvider}from'../../plugins/wecom/mirror/group-sync-provider.mjs';
async function fixture(t:test.TestContext){
 const dir=await mkdtemp(join(tmpdir(),'wecom-sync-')),old=process.env.OPENCRAFT_DATA_DIR,oldWs=process.env.OPENCRAFT_WORKSPACE_DIR;process.env.OPENCRAFT_DATA_DIR=dir;process.env.OPENCRAFT_WORKSPACE_DIR=dir+'-ws';
 const storage=await openServerDatabase(dir),actors=new ActorStore(storage),service=new Collaboration(storage,actors),db=storage.database;
 t.after(async()=>{await service.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});if(old===undefined)delete process.env.OPENCRAFT_DATA_DIR;else process.env.OPENCRAFT_DATA_DIR=old;if(oldWs===undefined)delete process.env.OPENCRAFT_WORKSPACE_DIR;else process.env.OPENCRAFT_WORKSPACE_DIR=oldWs;});
 const human=(id:string)=>actors.resolveHuman({provider:'tencentoa',subject:id,displayName:id,expiresAt:Date.now()+3600000})!;
 const alice=human('alice'),bob=human('bob'),carol=human('carol');for(const[c,id]of[[alice,'WA'],[bob,'WB'],[carol,'WC']]as const)actors.bindHuman(c,{provider:'wecom.wxfixture',subject:id,displayName:id,expiresAt:Date.now()+3600000});
 const channel=(c:any,op:string,p:any={})=>service.communicate(c,'opencraft/channels/'+op,p),group=await channel(alice,'group/create',{title:'Native',memberActorIds:[bob.actorId],clientRequestId:'group'});
 await service.personalAssistant(alice,'opencraft/personal-assistant/claim');
 const provision=await service.provisionPersonalAssistant(alice),bot=actors.authenticateSession(provision.credential.token)!;
 const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']),incarnation='sync-fixture';
 const native=(method:string,params:any={})=>service.synchronizeChannels({method,params:{...params,incarnation}});await native('configure',{bindings:[{source,channelId:group.id}]});
 await native('ingest',{source,arrival:{source,id:'mention',author:'WA',text:'@助理 hi',mentioned:true,at:1000}});
 const[scope]=await service.communicate(bot,'join/wecom-assistant/scopes',{});
 const cli=(...args:string[])=>service.communicate(bot,'join/wecom-assistant/cli',{scope:scope.scope,argv:[...args,'--group',group.id]});
 const cmd=(verb:string,p:any={})=>native('join/wecom-sync/'+verb,{source,...p});
 const binding={serverId:'one',humanKey:syncHash(['wecom','wxfixture','WA']),generation:'provider-epoch'};
 const read=()=>cmd('read',{sourceEpoch:epoch()});const epoch=()=>String(db.prepare('SELECT epoch FROM actor_channel_sources WHERE source=?').get(source)!.epoch);
 const snapshot=(name='Provider',memberIds=['WA','WB'])=>({externalId:'room',name,memberIds});
 const configure=(raw:any)=>cli('sync','configure',JSON.stringify(raw),'--idempotency-key','config-'+syncHash(raw));
 const observe=async(s=snapshot())=>{const ticket=await cmd('observe',{sourceEpoch:epoch()});return cmd('snapshot',{sourceEpoch:epoch(),...ticket,snapshot:s,binding});};

 return{service,storage,actors,db,alice,bob,carol,group,source,channel,cli,cmd,binding,epoch,read,snapshot,configure,observe};
}
function providerFixture(){let snapshot={externalId:'room',name:'old',memberIds:['WA','WB']},updates=0,unknown=false;const kv=new Map(),binding={serverId:'one',humanKey:syncHash(['wecom','wxfixture','WA']),generation:'p'},source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']);
 const svc={authorizedSource:async()=>binding,store:{prefix:'fixture:',command:async(...a:any[])=>{if(a[0]==='GET')return kv.get(a[1])??null;if(a[0]==='SET'){if(a.includes('NX')&&kv.has(a[1]))return null;kv.set(a[1],a[2]);return'OK';}}},transport:{syncSnapshot:async()=>snapshot,updateChat:async(s:any,change:any)=>{updates++;if(unknown)throw Error('lost ack');snapshot={...snapshot,...(change.name?{name:change.name}:{}),memberIds:[...snapshot.memberIds,...(change.add??[])].filter(id=>!(change.remove??[]).includes(id))};return'delivered';}}};
 const input={action:'apply',source,binding,sourceEpoch:'n',writeDeadline:Date.now()+30000,id:'a'.repeat(64),ownerUserId:'WA',base:'old',change:{kind:'name',name:'new'}};return{svc,input,binding,updates:()=>updates,setUnknown:()=>unknown=true,setSnapshot:(s:any)=>snapshot=s};}
test('provider checks bases and binding, verifies actual changes and never repeats an uncertain write',async()=>{
 const f=providerFixture();assert.equal((await groupSyncProvider(f.svc,{id:'one'},f.input,AbortSignal.timeout(1000))).state,'confirmed');assert.equal(f.updates(),1);assert.equal((await groupSyncProvider(f.svc,{id:'one'},f.input,AbortSignal.timeout(1000))).state,'confirmed');assert.equal(f.updates(),1);
 const u=providerFixture();u.setUnknown();assert.equal((await groupSyncProvider(u.svc,{id:'one'},u.input,AbortSignal.timeout(1000))).state,'unknown');assert.equal((await groupSyncProvider(u.svc,{id:'one'},u.input,AbortSignal.timeout(1000))).state,'unknown');assert.equal(u.updates(),1);
 const c=providerFixture();c.setSnapshot({externalId:'room',name:'changed elsewhere',memberIds:['WA']});assert.equal((await groupSyncProvider(c.svc,{id:'one'},c.input,AbortSignal.timeout(1000))).state,'conflict');assert.equal(c.updates(),0);
 await assert.rejects(groupSyncProvider(c.svc,{id:'one'},{...c.input,binding:{...c.binding,generation:'wrong'}},AbortSignal.timeout(1000)),/denied/);
});

test('strict provider snapshot rejects malformed/wrong-room responses without silently filtering a permission roster',async()=>{
 const{createWeComChannelTransport}=await import('../../plugins/wecom/channel-transport.mjs');const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']);let info:any={chatid:'room',name:'Group',userlist:['WA','fwfixture']};
 const transport=createWeComChannelTransport({corpId:'wxfixture',serviceId:'fwfixture',corpSecret:'fixture',token:'fixturetoken',aesKey:Buffer.alloc(32,7).toString('base64').replace(/=$/u,''),relayIngress:true,fetcher:async(url:any)=>String(url).includes('/chat/get')?Response.json({errcode:0,chat_info:info}):Response.json({errcode:0,access_token:'fixture',expires_in:7200})});
 assert.deepEqual((await transport.syncSnapshot(source,AbortSignal.timeout(1000))).memberIds,['WA']);info={...info,chatid:'another'};await assert.rejects(transport.syncSnapshot(source,AbortSignal.timeout(1000)),/invalid_snapshot/);info={...info,chatid:'room',userlist:['WA',null]};await assert.rejects(transport.syncSnapshot(source,AbortSignal.timeout(1000)),/invalid_snapshot/);await transport.close?.();
});


test('native group commits offline rename and member add immediately; delivery is durable and native dedupe is preserved',async t=>{
 const f=await fixture(t);await f.configure({name:'both',members:'both',historyAccess:'full'});
 await f.channel(f.alice,'group/rename',{channelId:f.group.id,title:'Local',clientRequestId:'rename'});
 await f.channel(f.alice,'group/member/set',{channelId:f.group.id,actorId:f.carol.actorId,present:true,clientRequestId:'add'});
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Local');assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),true);
 assert.equal((await f.read()).operations.length,2);assert.equal(await f.cmd('claim',{sourceEpoch:f.epoch()}),null);
 await f.channel(f.alice,'group/rename',{channelId:f.group.id,title:'Local',clientRequestId:'rename'});assert.equal((await f.read()).operations.length,2);
 await f.observe();assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Local');assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),true);
 const op=await f.cmd('claim',{sourceEpoch:f.epoch()});assert.equal(op.base,'Provider');await f.cmd('settle',{sourceEpoch:f.epoch(),id:op.id,attempt:op.attempt,state:'confirmed',snapshot:f.snapshot('Local'),binding:f.binding});
 assert.equal((await f.read()).operations[0].state,'confirmed');assert.equal((await f.read()).operations.length,2);
});
test('failed native owner/capacity validation rolls back its delivery intent in the same transaction',async t=>{
 const f=await fixture(t);await f.configure({name:'both',members:'both',historyAccess:'full'});
 await assert.rejects(f.channel(f.bob,'group/rename',{channelId:f.group.id,title:'bad',clientRequestId:'bad'}),/owner_required/);
 await assert.rejects(f.channel(f.alice,'group/member/set',{channelId:f.group.id,actorId:f.alice.actorId,present:false,clientRequestId:'self'}),/channel_denied/);
 assert.equal((await f.read()).operations.length,0);assert.equal(f.service.channels.isMember(f.group.id,f.alice.actorId),true);
});
test('initial observation preserves native state; optional external bootstrap imports title and eligible members without deleting native-only people',async t=>{
 const f=await fixture(t);await f.configure({name:'both',members:'both',historyAccess:'full'});await f.observe(f.snapshot('External',['WA','WC']));
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Native');assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),true);assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),false);
 await f.observe(f.snapshot('External changed',['WA','WC','unknown']));assert.equal(f.service.channels.get(f.alice,f.group.id).title,'External changed');assert.equal((await f.read()).operations.length,0);
});
test('simultaneous native and external additions merge by member, echo never creates a reverse operation',async t=>{
 const f=await fixture(t);await f.configure({name:'both',members:'both',historyAccess:'full'});await f.observe(f.snapshot('P',['WA']));
 await f.channel(f.alice,'group/member/set',{channelId:f.group.id,actorId:f.carol.actorId,present:true,clientRequestId:'local-add'});
 await f.observe(f.snapshot('P',['WA','WB']));assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),true);assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),true);
 const op=await f.cmd('claim',{sourceEpoch:f.epoch()});assert.equal(op.userId,'WC');await f.cmd('settle',{sourceEpoch:f.epoch(),id:op.id,attempt:op.attempt,state:'confirmed',snapshot:f.snapshot('P',['WA','WB','WC']),binding:f.binding});
 await f.observe(f.snapshot('P',['WA','WB','WC']));assert.equal((await f.read()).operations.length,1);
});
test('removal is immediate, stale unchanged presence cannot undo it, a confirmed later external rejoin can restore it with a new epoch',async t=>{
 const f=await fixture(t);await f.configure({members:'both',historyAccess:'full'});await f.observe();const epoch=f.service.channels.memberEpoch(f.group.id,f.bob.actorId);
 await f.channel(f.alice,'group/member/set',{channelId:f.group.id,actorId:f.bob.actorId,present:false,clientRequestId:'remove'});
 assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),false);await f.observe();assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),false);
 const op=await f.cmd('claim',{sourceEpoch:f.epoch()});await f.cmd('settle',{sourceEpoch:f.epoch(),id:op.id,attempt:op.attempt,state:'confirmed',snapshot:f.snapshot('Provider',['WA']),binding:f.binding});
 await f.observe();assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),true);assert.notEqual(f.service.channels.memberEpoch(f.group.id,f.bob.actorId),epoch);assert.equal((await f.read()).operations.length,1);
});
test('old own echo cannot undo a newer local edit; ambiguous first write blocks only delivery, never native edits',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});await f.observe();
 await f.cli('sync','request',JSON.stringify({kind:'name',name:'A'}),'--idempotency-key','a');const first=await f.cmd('claim',{sourceEpoch:f.epoch()});
 await f.channel(f.alice,'group/rename',{channelId:f.group.id,title:'B',clientRequestId:'b'});
 await f.cmd('settle',{sourceEpoch:f.epoch(),id:first.id,attempt:first.attempt,state:'unknown',snapshot:f.snapshot(),binding:f.binding});
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'B');const recovered=await f.cmd('claim',{sourceEpoch:f.epoch()});assert.equal(recovered.id,first.id);assert.equal(recovered.readOnly,true);
 await f.cmd('settle',{sourceEpoch:f.epoch(),id:first.id,attempt:first.attempt,state:'confirmed',snapshot:f.snapshot('A'),binding:f.binding});assert.equal(f.service.channels.get(f.alice,f.group.id).title,'B');
 const second=await f.cmd('claim',{sourceEpoch:f.epoch()});assert.equal(second.name,'B');assert.equal(second.base,'A');
 await f.cmd('settle',{sourceEpoch:f.epoch(),id:second.id,attempt:second.attempt,state:'confirmed',snapshot:f.snapshot('B'),binding:f.binding});assert.equal((await f.read()).operations.filter((o:any)=>o.state==='confirmed').length,2);
});
test('external deltas revoke members, but endpoint outage and external owner departure do not disable native ownership',async t=>{
 const f=await fixture(t);await f.configure({members:'both',historyAccess:'full'});await f.observe();
 await f.cmd('error',{sourceEpoch:f.epoch(),code:'network_down'});assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),true);
 await f.observe(f.snapshot('P',[]));assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),false);assert.equal(f.service.channels.isMember(f.group.id,f.alice.actorId),true);assert.equal((await f.read()).conflicts[0].reason,'native_owner_retained');
 await f.channel(f.alice,'group/rename',{channelId:f.group.id,title:'Still native',clientRequestId:'still'});assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Still native');
});
test('external identity unlink revokes imported access without revoking separately granted native membership',async t=>{
 const f=await fixture(t);await f.configure({members:'both',historyAccess:'full',initial:'external'});await f.observe(f.snapshot('P',['WA','WB','WC']));assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),true);
 for(const id of ['WB','WC'])f.db.prepare('DELETE FROM actor_bindings WHERE binding=?').run(JSON.stringify(['wecom.wxfixture',id]));await f.observe(f.snapshot('P',['WA','WB','WC']));
 assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),false);assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),true);
});
test('unmapped native Humans and local Bots remain usable, not guessed into provider identities',async t=>{
 const f=await fixture(t);await f.configure({members:'both',historyAccess:'full'});
 const unmapped=f.actors.resolveHuman({provider:'tencentoa',subject:'unmapped',displayName:'Unmapped',expiresAt:Date.now()+3600000})!;
 const bot=String(f.db.prepare('SELECT actor_id FROM personal_assistants WHERE owner_human_id=?').get(f.alice.actorId)!.actor_id);
 for(const actorId of [unmapped.actorId,bot])await f.channel(f.alice,'group/member/set',{channelId:f.group.id,actorId,present:true,clientRequestId:actorId});
 await f.observe();assert.equal(f.service.channels.isMember(f.group.id,unmapped.actorId),true);assert.equal(f.service.channels.isMember(f.group.id,bot),true);assert.equal((await f.read()).operations.length,0);
});
test('source retirement and delayed observation are fenced while native edits remain usable after disconnect',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});const a=await f.cmd('observe',{sourceEpoch:f.epoch()}),b=await f.cmd('observe',{sourceEpoch:f.epoch()});
 await f.cmd('snapshot',{sourceEpoch:f.epoch(),...b,snapshot:f.snapshot(),binding:f.binding});await assert.rejects(f.cmd('snapshot',{sourceEpoch:f.epoch(),...a,snapshot:f.snapshot('stale'),binding:f.binding}),/stale_snapshot/);
 await assert.rejects(f.cmd('snapshot',{sourceEpoch:'wrong',...b,snapshot:f.snapshot(),binding:f.binding}),/retired/);
 f.db.prepare('DELETE FROM actor_channel_sources WHERE source=?').run(f.source);await f.channel(f.alice,'group/rename',{channelId:f.group.id,title:'Independent',clientRequestId:'offline'});assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Independent');
});
test('provider rejection keeps successful native edit and records divergence, cancelling queued delivery does not undo native edit',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});await f.observe();await f.cli('sync','request',JSON.stringify({kind:'name',name:'Local'}),'--idempotency-key','local');const op=await f.cmd('claim',{sourceEpoch:f.epoch()});
 await f.cmd('settle',{sourceEpoch:f.epoch(),id:op.id,attempt:op.attempt,state:'rejected',snapshot:f.snapshot(),binding:f.binding});await f.observe();assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Local');
 const next=await f.cli('sync','request',JSON.stringify({kind:'name',name:'Next'}),'--idempotency-key','next');await f.cli('sync','cancel',next.id,'--idempotency-key','cancel');assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Next');
});
test('capacity blocks additions without rolling back remote removals and retries after capacity frees',async t=>{
 const f=await fixture(t);for(let i=0;i<62;i++) {const c=f.actors.resolveHuman({provider:'tencentoa',subject:'extra'+i,displayName:'extra',expiresAt:Date.now()+3600000})!;await f.channel(f.alice,'group/member/set',{channelId:f.group.id,actorId:c.actorId,present:true,clientRequestId:'extra'+i});}
 await f.configure({members:'both',historyAccess:'full',initial:'external'});await f.observe(f.snapshot('P',['WA','WB','WC']));assert.deepEqual((await f.read()).capacityBlocked,[f.carol.actorId]);
 await f.observe(f.snapshot('P',['WA','WC']));assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),false);assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),true);
});
test('pump reads initial facts, applies journaled local edits and recovers from a new coordinator instance',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});let actual=f.snapshot();const errors:any[]=[],requests:any[]=[];
 const make=()=>createGroupSyncPump({call:(method:string,p:any)=>f.service.synchronizeChannels({method,params:p}),request:async(action:string,p:any)=>{requests.push(p);if(p.action==='apply')actual=f.snapshot(p.change.name);return{state:'confirmed',snapshot:actual,binding:f.binding};},onError:(e:any)=>errors.push(e)});
 const first=make();await first.poll();await first.close();await f.cli('sync','request',JSON.stringify({kind:'name',name:'Updated'}),'--idempotency-key','pump');const second=make();await second.poll();await second.close();assert.equal((await f.read()).snapshot.name,'Updated');assert.deepEqual(errors,[]);assert.equal(requests.length,2);
});

test('late dispatch authorization expires before provider mutation, even without a surviving Redis receipt',async()=>{
 const p=providerFixture();assert.equal((await groupSyncProvider(p.svc,{id:'one'},{...p.input,writeDeadline:Date.now()-1},AbortSignal.timeout(1000))).state,'unknown');assert.equal(p.updates(),0);
});
test('changing synchronization direction cannot silently execute older pending commands',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});await f.cli('sync','request',JSON.stringify({kind:'name',name:'Pending'}),'--idempotency-key','pending');await assert.rejects(f.configure({name:'off'}),/configuration_pending/);
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Pending');
});
test('a native title above provider limit still commits locally and reports unsupported external delivery',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});const title='A'.repeat(80);await f.channel(f.alice,'group/rename',{channelId:f.group.id,title,clientRequestId:'long'});
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,title);assert.equal((await f.read()).operations[0].reason,'provider_title_limit');
});

test('binding revocation during a provider read rejects retired facts',async()=>{
 const f=providerFixture();let n=0;f.svc.authorizedSource=async()=>++n===1?f.binding:{...f.binding,generation:'retired'};
 await assert.rejects(groupSyncProvider(f.svc,{id:'one'},{...f.input,action:'read'},AbortSignal.timeout(1000)),/denied/);assert.equal(f.updates(),0);
});

test('lost request before Relay receipt can retry after its write grant expires; expired receipts cannot prove nonexecution',async()=>{
 const f=providerFixture();const missing={...f.input,action:'verify',writeDeadline:Date.now()-1};assert.equal((await groupSyncProvider(f.svc,{id:'one'},missing,AbortSignal.timeout(1000))).state,'not_started');assert.equal(f.updates(),0);
 assert.equal((await groupSyncProvider(f.svc,{id:'one'},{...missing,writeDeadline:Date.now()-8*86400000},AbortSignal.timeout(1000))).state,'unknown');
 const fresh={...f.input,writeDeadline:Date.now()+30000};assert.equal((await groupSyncProvider(f.svc,{id:'one'},fresh,AbortSignal.timeout(1000))).state,'confirmed');assert.equal(f.updates(),1);
});
test('confirmed nonexecution requeues the same local intent with a new attempt, and late old completions are fenced',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});await f.observe();await f.cli('sync','request',JSON.stringify({kind:'name',name:'Retry'}),'--idempotency-key','retry');const first=await f.cmd('claim',{sourceEpoch:f.epoch()});
 const row=await f.read();row.operations[0].writeDeadline=Date.now()-1;f.db.prepare('UPDATE join_wecom_group_sync SET value=? WHERE source=?').run(JSON.stringify(row),f.source);
 await f.cmd('settle',{sourceEpoch:f.epoch(),id:first.id,attempt:first.attempt,state:'not_started',snapshot:f.snapshot(),binding:f.binding});const retry=await f.cmd('claim',{sourceEpoch:f.epoch()});assert.equal(retry.id,first.id);assert.notEqual(retry.attempt,first.attempt);assert.equal(retry.readOnly,false);
 await assert.rejects(f.cmd('settle',{sourceEpoch:f.epoch(),id:first.id,attempt:first.attempt,state:'confirmed',snapshot:f.snapshot('Retry'),binding:f.binding}),/attempt_retired/);
});

test('ordinary assistant edits use native operations and business receipts, with no synthetic chat message or provider bypass',async t=>{
 const f=await fixture(t);await f.configure({name:'both',members:'both',historyAccess:'full'});await f.observe();
 const before=Number(f.db.prepare('SELECT count(*) AS n FROM actor_messages').get()!.n);
 const rename=await f.cli('chat','rename','Natural name','--idempotency-key','ordinary-name');
 assert.equal(rename.local.state,'applied');assert.equal(rename.wecom.state,'pending');assert.ok(rename.receiptId.startsWith('group-edit:'));
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Natural name');
 const added=await f.cli('chat','add','carol','--idempotency-key','ordinary-add');assert.equal(added.wecom.state,'pending');assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),true);
 const removed=await f.cli('chat','remove','bob','--idempotency-key','ordinary-remove');assert.equal(removed.wecom.state,'pending');assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),false);
 const row=await f.read();assert.deepEqual(row.operations.map((o:any)=>o.kind==='name'?o.name:[o.userId,o.present]),['Natural name',['WC',true],['WB',false]]);
 assert.equal(Number(f.db.prepare('SELECT count(*) AS n FROM actor_messages').get()!.n),before);
 assert.deepEqual(await f.cli('status',rename.receiptId),rename);
 const op=await f.cmd('claim',{sourceEpoch:f.epoch()});await f.cmd('settle',{sourceEpoch:f.epoch(),id:op.id,attempt:op.attempt,state:'confirmed',snapshot:f.snapshot('Natural name'),binding:f.binding});
 assert.equal((await f.cli('status',rename.receiptId)).wecom.state,'confirmed');
 assert.equal((await f.cli('chat','rename','Natural name','--idempotency-key','ordinary-name')).wecom.state,'confirmed');assert.equal((await f.read()).operations.length,3);
 await assert.rejects(f.cli('chat','rename','Different','--idempotency-key','ordinary-name'),/idempotency_conflict/);
 assert.equal((await f.cli('capabilities')).commands.some((s:string)=>s.startsWith('sync ')),false);
});

test('ordinary assistant edit commits locally during outage and reports conflict or uncertainty without pretending success',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});
 const a=await f.cli('chat','rename','Offline','--idempotency-key','offline');assert.equal(a.wecom.state,'pending');assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Offline');
 await f.cmd('error',{sourceEpoch:f.epoch(),code:'network_down'});assert.equal((await f.cli('status',a.receiptId)).wecom.state,'pending');
 await f.observe();const op=await f.cmd('claim',{sourceEpoch:f.epoch()});
 await f.cmd('settle',{sourceEpoch:f.epoch(),id:op.id,attempt:op.attempt,state:'unknown',snapshot:f.snapshot(),binding:f.binding});assert.equal((await f.cli('status',a.receiptId)).wecom.state,'unconfirmed');
 const b=await f.cli('chat','rename','New intent','--idempotency-key','new-intent');assert.equal(b.local.state,'applied');
 await f.cmd('settle',{sourceEpoch:f.epoch(),id:op.id,attempt:op.attempt,state:'conflict',snapshot:f.snapshot('Changed externally'),binding:f.binding});
 const result=await f.cli('status',a.receiptId);assert.equal(result.wecom.state,'needs_attention');assert.match(result.changes[0].wecom.message,/其他操作/);assert.equal(f.service.channels.get(f.alice,f.group.id).title,'New intent');
});

test('inbound-only and disabled fields remain native-only for assistant edits, with no legacy provider fallback',async t=>{
 const f=await fixture(t);await f.configure({name:'inbound',members:'observe'});await f.observe();
 const a=await f.cli('chat','rename','Local','--idempotency-key','local-only');const b=await f.cli('chat','add','carol','--idempotency-key','local-add');
 assert.equal(a.wecom.state,'local_only');assert.equal(b.wecom.state,'local_only');assert.equal((await f.read()).operations.length,0);assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),true);
 assert.equal(Number(f.db.prepare('SELECT count(*) AS n FROM join_wecom_assistant_replies').get()!.n),0);
});

test('members use registered RTX, never guessed userid/display name or implicit registration; native-only humans still work',async t=>{
 const f=await fixture(t);await f.configure({members:'both',historyAccess:'full'});
 const count=Number(f.db.prepare('SELECT count(*) AS n FROM actors').get()!.n);
 await assert.rejects(f.cli('chat','add','WC','--idempotency-key','userid-is-not-rtx'),/identity_required/);
 await assert.rejects(f.cli('chat','add','not-registered','--idempotency-key','unknown'),/identity_required/);
 assert.equal(Number(f.db.prepare('SELECT count(*) AS n FROM actors').get()!.n),count);assert.equal((await f.read()).operations.length,0);
 const local=f.actors.resolveHuman({provider:'tencentoa',subject:'localonly',displayName:'Local only',expiresAt:Date.now()+3600000})!;
 const result=await f.cli('chat','add','localonly','--idempotency-key','local-person');assert.equal(result.local.state,'applied');assert.equal(result.wecom.state,'needs_attention');assert.match(result.changes[0].wecom.message,/尚未关联/);
 assert.equal(f.service.channels.isMember(f.group.id,local.actorId),true);assert.equal((await f.read()).operations.length,0);
});

test('batch edit rolls back native changes, receipts and outgoing journal together if any member fails',async t=>{
 const f=await fixture(t);await f.configure({name:'both',members:'both',historyAccess:'full'});
 const bot=f.actors.authenticateSession((await f.service.provisionPersonalAssistant(f.alice)).credential.token)!;
 const [b]=await f.service.communicate(bot,'join/wecom-assistant/scopes',{});
 const edit=(p:any)=>f.service.communicate(bot,'join/wecom-assistant/edit',{scope:b.scope,...p});
 const keys=Number(f.db.prepare('SELECT count(*) AS n FROM actor_send_keys').get()!.n);
 await assert.rejects(edit({id:'bad-batch',remove:['bob','alice'],add:['carol'],name:'Should rollback'}),/channel_denied/);
 assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),true);assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),false);assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Native');
 assert.equal((await f.read()).operations.length,0);assert.equal(Number(f.db.prepare('SELECT count(*) AS n FROM actor_send_keys').get()!.n),keys);
 await assert.rejects(edit({id:'overlap',remove:['bob'],add:['bob']}),/change_conflict/);
 const good=await edit({id:'good-batch',remove:['bob'],add:['carol'],name:'Together'});assert.equal(good.changes.length,3);assert.equal((await f.read()).operations.length,3);
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Together');
});

test('native owner and current assistant scope remain mandatory for ordinary edits and result reads',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});
 await f.service.personalAssistant(f.bob,'opencraft/personal-assistant/claim');const token=await f.service.provisionPersonalAssistant(f.bob),bot=f.actors.authenticateSession(token.credential.token)!;
 await f.service.synchronizeChannels({method:'ingest',params:{incarnation:'sync-fixture',source:f.source,arrival:{source:f.source,id:'bob-mention',author:'WB',text:'hi',mentioned:true,at:1001}}});
 const [b]=await f.service.communicate(bot,'join/wecom-assistant/scopes',{});
 const bob=(...args:string[])=>f.service.communicate(bot,'join/wecom-assistant/cli',{scope:b.scope,argv:[...args,'--group',f.group.id]});
 await assert.rejects(bob('chat','rename','Not mine','--idempotency-key','bob-rename'),/owner_required/);
 const a=await f.cli('chat','rename','Mine','--idempotency-key','alice-rename');await assert.rejects(bob('status',a.receiptId),/result_unavailable/);
 await f.channel(f.alice,'group/member/set',{channelId:f.group.id,actorId:f.bob.actorId,present:false,clientRequestId:'revoke-bob'});
 await assert.rejects(bob('status',a.receiptId),/denied/);
});

test('legacy pre-adoption edit receipt never executes again natively after connection adoption',async t=>{
 const f=await fixture(t);const before=await f.cli('chat','rename','Legacy name','--idempotency-key','legacy');assert.ok(before.messageId);
 await f.configure({name:'both'});assert.deepEqual(await f.cli('chat','rename','Legacy name','--idempotency-key','legacy'),before);
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Native');assert.equal((await f.read()).operations.length,0);
 await assert.rejects(f.cli('chat','rename','Changed','--idempotency-key','legacy'),/idempotency_conflict/);
});

test('confirmed business receipt survives journal compaction; expired receipt dedupe never replays older edits',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});await f.observe();const a=await f.cli('chat','rename','First','--idempotency-key','first');const op=await f.cmd('claim',{sourceEpoch:f.epoch()});
 await f.cmd('settle',{sourceEpoch:f.epoch(),id:op.id,attempt:op.attempt,state:'confirmed',snapshot:f.snapshot('First'),binding:f.binding});
 let row=await f.read();row.operations=[];f.db.prepare('UPDATE join_wecom_group_sync SET value=? WHERE source=?').run(JSON.stringify(row),f.source);
 assert.equal((await f.cli('status',a.receiptId)).wecom.state,'confirmed');
 delete row.editReceipts[a.receiptId];f.db.prepare('UPDATE join_wecom_group_sync SET value=? WHERE source=?').run(JSON.stringify(row),f.source);
 await f.cli('chat','rename','New','--idempotency-key','new');const again=await f.cli('chat','rename','First','--idempotency-key','first');
 assert.equal(again.wecom.state,'unconfirmed');assert.equal(f.service.channels.get(f.alice,f.group.id).title,'New');assert.equal((await f.read()).operations.length,1);
 await assert.rejects(f.cli('chat','rename','Forged','--idempotency-key','first'),/idempotency_conflict/);
});

test('ordinary CLI to real Worker and background pump verifies provider facts after recovery without additional group chatter',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});const provider=providerFixture(),errors:any[]=[];
 provider.setSnapshot(f.snapshot());
 const request=async(_action:string,p:any)=>groupSyncProvider(provider.svc,{id:'one'},p,AbortSignal.timeout(1000));
 const make=()=>createGroupSyncPump({call:(method:string,p:any)=>f.service.synchronizeChannels({method,params:p}),request,onError:(e:any)=>errors.push(e)});
 const first=make();await first.poll();await first.close();
 const result=await f.cli('chat','rename','Natural recovery','--idempotency-key','natural-recovery');
 const before=Number(f.db.prepare('SELECT count(*) AS n FROM actor_messages').get()!.n);
 provider.setUnknown();const second=make();await second.poll();await second.close();assert.equal(provider.updates(),1);assert.equal((await f.cli('status',result.receiptId)).wecom.state,'unconfirmed');
 // The provider eventually shows the requested result, but the original response was lost.
 provider.setSnapshot(f.snapshot('Natural recovery'));const third=make();await third.poll();await third.close();
 assert.equal(provider.updates(),1);assert.equal((await f.cli('status',result.receiptId)).wecom.state,'confirmed');assert.deepEqual(errors,[]);
 assert.equal(Number(f.db.prepare('SELECT count(*) AS n FROM actor_messages').get()!.n),before);
});

test('assistant uses native title limit while truthfully reporting the smaller provider limit',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});const name='N'.repeat(80);
 const result=await f.cli('chat','rename',name,'--idempotency-key','long-native-title');assert.equal(f.service.channels.get(f.alice,f.group.id).title,name);
 assert.equal(result.local.state,'applied');assert.equal(result.wecom.state,'needs_attention');assert.match(result.changes[0].wecom.message,/长度限制/);
});

for(const window of ['GET','SET NX','SET final'])test(`binding changes during Redis ${window} never return retired facts or authorize another write`,async()=>{
 const f=providerFixture(),command=f.svc.store.command;let changed=false;
 f.svc.authorizedSource=async()=>changed?{...f.binding,generation:'retired'}:f.binding;
 f.svc.store.command=async(...args:any[])=>{const result=await command(...args);if(window==='GET'&&args[0]==='GET'||window==='SET NX'&&args[0]==='SET'&&args.includes('NX')||window==='SET final'&&args[0]==='SET'&&!args.includes('NX'))changed=true;return result;};
 await assert.rejects(groupSyncProvider(f.svc,{id:'one'},{...f.input,...(window==='GET'?{action:'verify'}:{})},AbortSignal.timeout(1000)),/denied/);
 assert.equal(f.updates(),window==='SET final'?1:0);
});

test('verify preserves a persisted rejection when the native settle acknowledgment was lost',async()=>{
 const f=providerFixture();f.svc.transport.updateChat=async()=> 'rejected';
 assert.equal((await groupSyncProvider(f.svc,{id:'one'},f.input,AbortSignal.timeout(1000))).state,'rejected');
 assert.equal((await groupSyncProvider(f.svc,{id:'one'},{...f.input,action:'verify'},AbortSignal.timeout(1000))).state,'rejected');
});

test('external sync status is member-readable, owner-triggered, private and absent on native groups',async t=>{
 const f=await fixture(t),status=(c:any,id=f.group.id)=>f.channel(c,'group/sync/status',{channelId:id});
 const native=await f.channel(f.alice,'group/create',{title:'Native only',memberActorIds:[f.bob.actorId],clientRequestId:'native-only'});
 assert.equal(await status(f.alice,native.id),null);
 const view=await status(f.alice);assert.equal(view.mentionIngress,'text-only');assert.equal(view.state,'never');assert.equal(view.lastSyncedAt,null);assert.equal(view.canRefresh,true);
 assert.equal((await status(f.bob)).canRefresh,false);
 assert.deepEqual(Object.keys(view).sort(),['provider','configured','canRefresh','state','lastSyncedAt','lastAttemptAt','name','members','pendingOperations','mentionIngress'].sort());
 await assert.rejects(status(f.carol),/channel_denied/);
 await assert.rejects(f.channel(f.bob,'group/sync/refresh',{channelId:f.group.id,clientRequestId:'forbidden'}),/owner_required/);
 await assert.rejects(f.channel(f.alice,'group/sync/status',{channelId:f.group.id,source:f.source}),/invalid_input/);
 await assert.rejects(f.channel(f.alice,'group/sync/refresh',{channelId:f.group.id}),/idempotency_key_required/);
});

test('manual refresh persists, coalesces clicks and is observation-only before explicit configuration',async t=>{
 const f=await fixture(t),refresh=(key:string)=>f.channel(f.alice,'group/sync/refresh',{channelId:f.group.id,clientRequestId:key});
 const pending=await refresh('one');assert.equal(pending.state,'pending');assert.equal(pending.lastSyncedAt,null);
 const id=(await f.read()).refresh.id;await refresh('one');await refresh('two');assert.equal((await f.read()).refresh.id,id);
 assert.deepEqual((await f.read()).config,syncConfig());let calls=0;
 const pump=createGroupSyncPump({call:(method:string,params:any)=>f.service.synchronizeChannels({method,params}),request:async()=>{calls++;return{snapshot:f.snapshot('External',['WA','WB','WC']),binding:f.binding};}});
 await pump.poll();await pump.close();assert.equal(calls,1);
 const status=await f.channel(f.bob,'group/sync/status',{channelId:f.group.id});assert.equal(status.state,'idle');assert.ok(status.lastSyncedAt);assert.ok(status.lastAttemptAt);
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Native');assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),false);
 await refresh('one');assert.equal((await f.read()).refresh.state,'succeeded');assert.equal((await f.read()).refresh.id,id);
});

test('manual refresh bypasses the next automatic deadline and applies only authorized configured directions',async t=>{
 const f=await fixture(t);await f.configure({name:'inbound',members:'inbound',historyAccess:'full',initial:'external',pollMs:300000});let calls=0,actual=f.snapshot();
 const pump=createGroupSyncPump({now:()=>1000,call:(method:string,params:any)=>f.service.synchronizeChannels({method,params}),request:async()=>{calls++;return{snapshot:actual,binding:f.binding};}});
 await pump.poll();await pump.poll();assert.equal(calls,1);
 actual=f.snapshot('New external',['WA','WC']);await f.cli('sync','refresh','--idempotency-key','force-now');await pump.poll();await pump.close();assert.equal(calls,2);
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'New external');assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),false);assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),true);
 assert.equal((await f.read()).refresh.state,'succeeded');assert.equal((await f.read()).config.historyAccess,'full');
});

test('failed refresh preserves last success and a new request recovers without waiting for the automatic deadline',async t=>{
 const f=await fixture(t);await f.configure({name:'inbound',pollMs:300000});await f.observe();const last=(await f.read()).lastSyncedAt;let fail=true;
 const pump=createGroupSyncPump({now:()=>1000,call:(method:string,params:any)=>f.service.synchronizeChannels({method,params}),request:async()=>{if(fail)throw Error('network_down');return{snapshot:f.snapshot('Recovered'),binding:f.binding};}});
 await f.cli('sync','refresh','--idempotency-key','fail');await pump.poll();let view=await f.channel(f.alice,'group/sync/status',{channelId:f.group.id});assert.equal(view.state,'error');assert.equal(view.lastSyncedAt,last);assert.equal((await f.read()).refresh.state,'failed');
 fail=false;await f.cli('sync','refresh','--idempotency-key','recover');await pump.poll();await pump.close();view=await f.channel(f.alice,'group/sync/status',{channelId:f.group.id});assert.equal(view.state,'idle');assert.ok(view.lastSyncedAt>=last);assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Recovered');
});

test('a refresh requested during an older provider read is not acknowledged by the older read',async t=>{
 const f=await fixture(t);await f.configure({name:'inbound',pollMs:300000});const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0;
 const pump=createGroupSyncPump({now:()=>1000,call:(method:string,params:any)=>f.service.synchronizeChannels({method,params}),request:async()=>{if(++calls===1){entered.resolve();await release.promise;}return{snapshot:f.snapshot(),binding:f.binding};}});
 const older=pump.poll();await entered.promise;await f.cli('sync','refresh','--idempotency-key','after-start');release.resolve();await older;
 assert.equal((await f.read()).refresh.state,'pending');await pump.poll();await pump.close();assert.equal(calls,2);assert.equal((await f.read()).refresh.state,'succeeded');
});

test('retired source cannot be refreshed and stale completion cannot advance a successful-sync timestamp',async t=>{
 const f=await fixture(t);await f.configure({name:'inbound'});await f.observe();const last=(await f.read()).lastSyncedAt;
 const oldEpoch=f.epoch(),ticket=await f.cmd('observe',{sourceEpoch:oldEpoch});f.db.prepare('UPDATE actor_channel_sources SET active=0 WHERE source=?').run(f.source);
 const view=await f.channel(f.bob,'group/sync/status',{channelId:f.group.id});assert.equal(view.state,'disconnected');assert.equal(view.canRefresh,false);
 await assert.rejects(f.cli('sync','refresh','--idempotency-key','retired'),/wecom_assistant_denied/);
 await assert.rejects(f.channel(f.alice,'group/sync/refresh',{channelId:f.group.id,clientRequestId:'retired'}),/binding_required/);
 await assert.rejects(f.cmd('snapshot',{sourceEpoch:oldEpoch,...ticket,snapshot:f.snapshot('Wrong'),binding:f.binding}),/retired/);
 assert.equal(JSON.parse(String(f.db.prepare('SELECT value FROM join_wecom_group_sync WHERE source=?').get(f.source)!.value)).lastSyncedAt,last);
});

test('manual refresh drains queued native changes and does not finish after the first partial receipt',async t=>{
 const f=await fixture(t);await f.configure({name:'both',members:'both',historyAccess:'full',pollMs:300000});await f.observe();
 await f.cli('sync','request',JSON.stringify({kind:'name',name:'Local'}),'--idempotency-key','local');await f.cli('sync','request',JSON.stringify({kind:'member',userId:'WC',present:true}),'--idempotency-key','member');await f.cli('sync','refresh','--idempotency-key','drain');let actual=f.snapshot(),calls=0;
 const pump=createGroupSyncPump({now:()=>1000,call:(method:string,params:any)=>f.service.synchronizeChannels({method,params}),request:async(_a:string,p:any)=>{calls++;if(p.change.kind==='name')actual=f.snapshot(p.change.name,actual.memberIds);else actual=f.snapshot(actual.name,[...actual.memberIds,p.change.userId]);return{state:'confirmed',snapshot:actual,binding:f.binding};}});
 await pump.poll();assert.equal((await f.read()).refresh.state,'pending');await pump.poll();await pump.close();assert.equal(calls,2);assert.equal((await f.read()).refresh.state,'succeeded');
});

test('uncertain provider write leaves manual refresh failed, never reports completion or authorizes replay',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});await f.observe();const last=(await f.read()).lastSyncedAt;await f.cli('sync','request',JSON.stringify({kind:'name',name:'Uncertain'}),'--idempotency-key','uncertain');await f.cli('sync','refresh','--idempotency-key','verify');
 const pump=createGroupSyncPump({call:(method:string,params:any)=>f.service.synchronizeChannels({method,params}),request:async()=>({state:'unknown',snapshot:f.snapshot(),binding:f.binding})});await pump.poll();await pump.close();
 const row=await f.read();assert.equal(row.refresh.state,'failed');assert.equal(row.lastSyncedAt,last);assert.equal((await f.cmd('claim',{sourceEpoch:f.epoch()})).readOnly,true);assert.equal((await f.channel(f.alice,'group/sync/status',{channelId:f.group.id})).state,'error');
});

test('checking an unconfigured group does not adopt legacy edits or consume a later explicit bootstrap',async t=>{
 const f=await fixture(t);await f.cli('sync','refresh','--idempotency-key','check-only');let calls=0;
 const pump=createGroupSyncPump({call:(method:string,params:any)=>f.service.synchronizeChannels({method,params}),request:async()=>{calls++;return{snapshot:f.snapshot('External',['WA','WB','WC']),binding:f.binding};}});
 await pump.poll();await pump.poll();assert.equal(calls,1);assert.equal((await f.channel(f.alice,'group/sync/status',{channelId:f.group.id})).configured,false);
 const edited=await f.cli('chat','rename','Legacy provider action','--idempotency-key','legacy-after-check');assert.ok(edited.messageId);assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Native');
 await f.configure({name:'inbound',members:'inbound',historyAccess:'full',initial:'external'});assert.equal((await f.read()).snapshot,null);
 const next=createGroupSyncPump({call:(method:string,params:any)=>f.service.synchronizeChannels({method,params}),request:async()=>({snapshot:f.snapshot('External',['WA','WB','WC']),binding:f.binding})});
 await next.poll();await next.close();await pump.close();assert.equal(f.service.channels.get(f.alice,f.group.id).title,'External');assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),true);
});

test('group settings status and refresh traverse the actual authenticated AppServer and Worker boundary',async t=>{
 const f=await fixture(t);const{ImChannelsAppServer}=await import('../../../../scripts/im-channels-appserver.mjs');const{LOGICAL_CLIENT_FIELD}=await import('../../../../packages/app-host-protocol/src/index');
 const transport=new ImChannelsAppServer(()=>f.service);await transport.connect();t.after(()=>transport.close());const pending=new Map<string,(v:any)=>void>();const unsubscribe=transport.subscribeMessage((frame:string)=>{const v=JSON.parse(frame);pending.get(v.id)?.(v);});t.after(unsubscribe);
 async function rpc(actor:any,method:string,params:any={}){
  const id=crypto.randomUUID(),wait=Promise.withResolvers<any>();pending.set(id,wait.resolve);
  const context={actorContext:actor,sender:null,resourceOwner:{id:actor.actorId,assertCurrent(){assert.ok(f.actors.isCurrent(actor));}}};
  await transport.sendWithContext(JSON.stringify({jsonrpc:'2.0',id,method,params,[LOGICAL_CLIENT_FIELD]:actor.actorId}),context);
  const response=await Promise.race([wait.promise,new Promise((_,reject)=>{const timeout=setTimeout(()=>reject(Error('RPC test timeout')),5000);timeout.unref();})]);pending.delete(id);return response;
 }
 await rpc(f.alice,'initialize');await rpc(f.bob,'initialize');
 const status=await rpc(f.bob,'opencraft/channels/group/sync/status',{channelId:f.group.id});assert.equal(status.result.canRefresh,false);assert.equal(status.result.state,'never');
 assert.equal((await rpc(f.bob,'opencraft/channels/group/sync/refresh',{channelId:f.group.id,clientRequestId:'denied'})).error.message,'channel_denied');
 const accepted=await rpc(f.alice,'opencraft/channels/group/sync/refresh',{channelId:f.group.id,clientRequestId:'wire'});assert.equal(accepted.result.state,'pending');assert.equal((await f.read()).refresh.state,'pending');
});

test('explicit adoption fences a provider read that began while the group was observation-only',async t=>{
 const f=await fixture(t);await f.cli('sync','refresh','--idempotency-key','observation');const ticket=await f.cmd('observe',{sourceEpoch:f.epoch()});
 await f.configure({name:'inbound',initial:'external'});await assert.rejects(f.cmd('snapshot',{sourceEpoch:f.epoch(),...ticket,snapshot:f.snapshot('Old read'),binding:f.binding}),/stale_snapshot/);
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Native');await f.observe(f.snapshot('Fresh read'));assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Fresh read');
});

test('saturated remote backlog cannot roll back a valid native edit or discard uncertain writes',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});const row=await f.read();
 row.operations=Array.from({length:4096},(_,i)=>({kind:'name',name:'old',id:'old'+i,digest:'old'+i,state:i===0?'unknown':'queued',sequence:i+1}));row.sequence=4096;row.inflight='old0';
 f.db.prepare('UPDATE join_wecom_group_sync SET value=? WHERE source=?').run(JSON.stringify(row),f.source);
 const r=await f.cli('chat','rename','Still usable','--idempotency-key','saturated');assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Still usable');assert.equal(r.wecom.state,'needs_attention');assert.match(r.changes[0].wecom.message,/未发送/);
 const after=await f.read();assert.equal(after.operations[0].state,'unknown');assert.equal(after.inflight,'old0');assert.equal(after.operations.at(-1).reason,'delivery_capacity');
 await f.cli('chat','rename','Still usable','--idempotency-key','saturated');assert.equal((await f.read()).operations.length,4097);
});

test('reconnection resets observations and fences old operations without changing native state or granting history',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});await f.observe();await f.cli('chat','rename','Local','--idempotency-key','before-reconnect');const old=await f.cmd('claim',{sourceEpoch:f.epoch()});const oldEpoch=f.epoch();
 f.db.prepare('UPDATE actor_channel_sources SET epoch=? WHERE source=?').run('replacement-epoch',f.source);
 // A new native mention obtains the new scope, as it does after real reconnection.
 await f.service.synchronizeChannels({method:'ingest',params:{incarnation:'sync-fixture',source:f.source,arrival:{source:f.source,id:'new-mention',author:'WA',text:'hi',mentioned:true,at:2000}}});
 const token=await f.service.provisionPersonalAssistant(f.alice),bot=f.actors.authenticateSession(token.credential.token)!;const [b]=await f.service.communicate(bot,'join/wecom-assistant/scopes',{});
 const cli=(...args:string[])=>f.service.communicate(bot,'join/wecom-assistant/cli',{scope:b.scope,argv:[...args,'--group',f.group.id]});
 await cli('sync','configure',JSON.stringify({name:'both'}),'--idempotency-key','reconnect');const row=await f.read();
 assert.equal(row.sourceEpoch,'replacement-epoch');assert.equal(row.snapshot,null);assert.equal(row.operations.length,0);assert.equal(row.config.historyAccess,'none');assert.equal(row.config.members,'observe');assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Local');
 const saved=Object.values(row.editReceipts)[0] as any;assert.equal(saved.changes[0].delivery.reason,'connection_replaced_unknown');
 await assert.rejects(f.cmd('settle',{sourceEpoch:oldEpoch,id:old.id,attempt:old.attempt,state:'confirmed',snapshot:f.snapshot('stale'),binding:f.binding}),/retired/);
 await f.observe();assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Local');
});

test('mixed confirmed and native-only batch reports partial rather than all-local',async t=>{
 const f=await fixture(t);await f.configure({name:'both',members:'observe'});await f.observe();
 const token=await f.service.provisionPersonalAssistant(f.alice),bot=f.actors.authenticateSession(token.credential.token)!;const [b]=await f.service.communicate(bot,'join/wecom-assistant/scopes',{});
 const r=await f.service.communicate(bot,'join/wecom-assistant/edit',{scope:b.scope,id:'mixed',name:'Mixed',add:['carol'],remove:[]});const op=await f.cmd('claim',{sourceEpoch:f.epoch()});
 await f.cmd('settle',{sourceEpoch:f.epoch(),id:op.id,attempt:op.attempt,state:'confirmed',snapshot:f.snapshot('Mixed'),binding:f.binding});assert.equal((await f.service.communicate(bot,'join/wecom-assistant/cli',{scope:b.scope,argv:['status',r.receiptId,'--group',f.group.id]})).wecom.state,'partial');
});

test('terminal edit failures go only to their original assistant, with durable acknowledgment and no group message',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});const token=await f.service.provisionPersonalAssistant(f.alice),bot=f.actors.authenticateSession(token.credential.token)!;const [b]=await f.service.communicate(bot,'join/wecom-assistant/scopes',{});
 const {assistantHostExtension}=await import('../../../../apps/personal-assistant/src/runtime/host-extension.mjs');
 const call=(op:string,p:any={})=>assistantHostExtension().request(f.service,bot,'join/wecom-assistant/'+op,{scope:b.scope,...p}).result;
 const r=await call('cli',{argv:['chat','rename','N'.repeat(80),'--idempotency-key','failure-report','--group',f.group.id]});
 const results=await call('edit-results');assert.equal(results.length,1);assert.equal(results[0].receiptId,r.receiptId);
 assert.equal((await call('edit-result-ack',{receiptId:r.receiptId,revision:'wrong'})).acknowledged,false);assert.equal((await call('edit-results')).length,1);
 assert.equal((await call('edit-result-ack',{receiptId:r.receiptId,revision:results[0].revision})).acknowledged,true);assert.deepEqual(await call('edit-results'),[]);
 assert.equal(Number(f.db.prepare('SELECT count(*) AS n FROM join_wecom_assistant_replies').get()!.n),0);
});

test('assistant-created connection adopts title sync without importing members or enabling history, and never overwrites policy',async t=>{
 const f=await fixture(t);const binding={...f.binding,actorId:f.alice.actorId,source:f.source,nativeGroup:true};
 await f.cmd('adopt-created',{binding});const row=await f.read();assert.equal(row.config.name,'both');assert.equal(row.config.members,'observe');assert.equal(row.config.historyAccess,'none');
 await f.observe(f.snapshot('External',['WA','WB','WC']));assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),false);
 await f.configure({name:'off'});await f.cmd('adopt-created',{binding});assert.equal((await f.read()).config.name,'off');
});

test('automatic adoption rejects untrusted owners and does not turn an ordinary binding into member authorization',async t=>{
 const f=await fixture(t);await assert.rejects(f.cmd('adopt-created',{binding:{...f.binding,source:f.source,actorId:f.bob.actorId,nativeGroup:true}}),/binding_mismatch/);
 await f.cmd('adopt-created',{binding:{...f.binding,source:f.source,actorId:f.alice.actorId}});
 assert.equal(Number(f.db.prepare('SELECT count(*) AS n FROM join_wecom_group_sync').get()!.n),0);
});

test('trusted reattachment renews the same owner connection without CLI configuration or replaying old writes',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});await f.cli('chat','rename','Before','--idempotency-key','rebind-old');
 f.db.prepare('UPDATE actor_channel_sources SET epoch=? WHERE source=?').run('new-epoch-auto',f.source);
 await f.cmd('adopt-created',{binding:{...f.binding,source:f.source,actorId:f.alice.actorId}});
 const row=await f.read();assert.equal(row.sourceEpoch,'new-epoch-auto');assert.equal(row.operations.length,0);assert.equal(row.config.name,'both');assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Before');
});

test('trusted reattachment preserves a manually checked legacy group as observation-only',async t=>{
 const f=await fixture(t);await f.cli('sync','refresh','--idempotency-key','legacy-check');f.db.prepare('UPDATE actor_channel_sources SET epoch=? WHERE source=?').run('renewed-observation-epoch',f.source);
 await f.cmd('adopt-created',{binding:{...f.binding,source:f.source,actorId:f.alice.actorId}});const row=await f.read();assert.equal(row.sourceEpoch,'renewed-observation-epoch');assert.equal(row.observationOnly,true);assert.equal(row.snapshot,null);assert.equal(row.refresh,undefined);
 assert.equal((await f.channel(f.alice,'group/sync/status',{channelId:f.group.id})).configured,false);assert.equal((await f.service.synchronizeChannels({method:'join/wecom-sync/list',params:{}}))[0].paused,true);
});

test('unnamed provider groups traverse strict transport and native refresh without changing title or granting access',async t=>{
 const f=await fixture(t);await f.channel(f.alice,'group/sync/refresh',{channelId:f.group.id,clientRequestId:'unnamed'});
 const {createWeComChannelTransport}=await import('../../plugins/wecom/channel-transport.mjs');
 let info:any={chatid:'room',name:'',userlist:['WA','WC','fwfixture']};
 const transport=createWeComChannelTransport({corpId:'wxfixture',serviceId:'fwfixture',corpSecret:'fixture',token:'fixturetoken',aesKey:Buffer.alloc(32,7).toString('base64').replace(/=$/u,''),relayIngress:true,fetcher:async(url:any)=>String(url).includes('/chat/get')?Response.json({errcode:0,chat_info:info}):Response.json({errcode:0,access_token:'fixture',expires_in:7200})});
 const pump=createGroupSyncPump({call:(method:string,params:any)=>f.service.synchronizeChannels({method,params}),request:async()=>({snapshot:await transport.syncSnapshot(f.source,AbortSignal.timeout(1000)),binding:f.binding})});
 await pump.poll();await pump.close();
 const row=await f.read(),status=await f.channel(f.alice,'group/sync/status',{channelId:f.group.id});
 assert.equal(row.snapshot.name,'');assert.deepEqual(row.snapshot.memberIds,['WA','WC']);assert.equal(row.refresh.state,'succeeded');assert.equal(row.lastError,null);assert.equal(row.observationOnly,true);
 assert.equal(status.state,'idle');assert.equal(status.configured,false);assert.equal(status.name,'off');assert.equal(status.members,'observe');
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Native');assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),true);assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),false);assert.deepEqual(row.imported,{});assert.equal(row.operations.length,0);
 for(const bad of [undefined,null,123,' ','\n','\ud800']){info={chatid:'room',name:bad,userlist:['WA']};await assert.rejects(transport.syncSnapshot(f.source,AbortSignal.timeout(1000)),/invalid_snapshot/);}
 for(const bad of [null,['WA',null],['WA','WA'],['WA','bad id']]){info={chatid:'room',name:'',userlist:bad};await assert.rejects(transport.syncSnapshot(f.source,AbortSignal.timeout(1000)),/invalid_snapshot/);}
 await transport.close?.();
});

test('empty external titles never project locally, including explicit bootstrap and named-to-empty transitions',async t=>{
 const f=await fixture(t);await f.configure({name:'both',initial:'external'});
 await f.observe(f.snapshot(''));assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Native');
 await f.observe(f.snapshot('Named'));assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Named');
 await f.observe(f.snapshot(''));assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Named');
 await f.channel(f.alice,'group/rename',{channelId:f.group.id,title:'Local',clientRequestId:'from-empty'});
 assert.equal((await f.cmd('claim',{sourceEpoch:f.epoch()})).base,'');
});

test('provider can rename an unnamed group with an exact empty base while retaining authorization checks',async()=>{
 const f=providerFixture();f.setSnapshot({externalId:'room',name:'',memberIds:['WA','WB']});
 assert.equal((await groupSyncProvider(f.svc,{id:'one'},{...f.input,base:''},AbortSignal.timeout(1000))).state,'confirmed');assert.equal(f.updates(),1);
 const denied=providerFixture();denied.setSnapshot({externalId:'room',name:'',memberIds:['WB']});
 assert.equal((await groupSyncProvider(denied.svc,{id:'one'},{...denied.input,base:''},AbortSignal.timeout(1000))).state,'rejected');assert.equal(denied.updates(),0);
});

test('unnamed display uses the complete provider roster without granting unknown people or writing a name',async t=>{
 const f=await fixture(t);await f.configure({name:'both',members:'both',historyAccess:'full',initial:'external'});
 const snapshot=f.snapshot('',['WA','UNKNOWN']);
 const presentation={...snapshot,membershipSource:'provider',members:[{id:'WA',name:'skipzhang'},{id:'UNKNOWN',name:'ruippan'}]};
 const observe=async(value:any=presentation,s=snapshot)=>{const ticket=await f.cmd('observe',{sourceEpoch:f.epoch()});return f.cmd('snapshot',{sourceEpoch:f.epoch(),...ticket,snapshot:s,presentation:value,binding:f.binding});};
 await observe();
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'ruippan;skipzhang');
 assert.equal(f.service.channels.list(f.alice).find(g=>g.id===f.group.id)?.title,'ruippan;skipzhang');
 assert.equal(f.db.prepare('SELECT title FROM actor_channels WHERE id=?').get(f.group.id)!.title,'Native');
 assert.equal((await f.read()).operations.length,0);
 await observe(null);assert.equal(f.service.channels.get(f.alice,f.group.id).title,'ruippan;skipzhang');
 assert.equal(f.actors.findHuman({provider:'wecom.wxfixture',subject:'UNKNOWN'}),null);
 assert.throws(()=>f.service.channels.get(f.carol,f.group.id),/channel_denied/);
 // A departed participant must not linger, and raw IDs cannot impersonate names.
 await observe({...presentation,members:[{id:'WA',name:'WA'},{id:'UNKNOWN',name:'ruippan'}]});
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Native');
 await observe(presentation,f.snapshot('',['WA']));assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Native');
 await observe();await f.channel(f.alice,'group/rename',{channelId:f.group.id,title:'Explicit',clientRequestId:'explicit'});
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Explicit');
 assert.equal((await f.read()).operations[0].name,'Explicit');
 const op=await f.cmd('claim',{sourceEpoch:f.epoch()});
 await f.cmd('settle',{sourceEpoch:f.epoch(),id:op.id,attempt:op.attempt,state:'rejected',snapshot,presentation,binding:f.binding});
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Explicit');
 await observe(presentation);assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Explicit');
});

test('label reads reuse provider-query and cannot fail group synchronization',async()=>{
 for(const unavailable of [false,true]){
  const commands:any[]=[],requests:any[]=[];
  const snapshot={externalId:'room',name:'',memberIds:['WA','UNKNOWN']};
  const presentation={...snapshot,membershipSource:'provider',members:[{id:'WA',name:'Alice'},{id:'UNKNOWN',name:'Other'}]};
  const pump=createGroupSyncPump({call:async(method:string,p:any)=>{commands.push([method,p]);switch(method.split('/').at(-1)){case'list':return[{source:'source',sourceEpoch:'epoch',pollMs:30000}];case'read':return{ownerUserId:'WA',config:{name:'both'}};case'begin':return{refreshId:null};case'claim':return null;case'observe':return{observation:1,sequence:0};}},request:async(method:string,p:any)=>{requests.push([method,p]);if(method==='provider-query'){if(unavailable)throw Error('denied');return presentation;}return{snapshot,binding:{}};}});
  await pump.poll();await pump.close();
  assert.deepEqual(requests[1],['provider-query',{source:'source',owner:'WA',query:{kind:'chat'}}]);
  const result=commands.find(([m])=>m.endsWith('/snapshot'));assert.ok(result);
  assert.equal(result[1].presentation,unavailable?undefined:presentation);
  assert.equal(commands.some(([m])=>m.endsWith('/error')),false);
 }
});

test('disabled or observation-only name sync and absent snapshots skip cosmetic reads without blocking settle',async()=>{
 for(const options of [{config:{name:'off'}},{config:{name:'both'},observationOnly:true},{config:{name:'both'},missing:true}]){
  const commands:any[]=[],requests:string[]=[];
  const pump=createGroupSyncPump({call:async(method:string,p:any)=>{commands.push([method,p]);switch(method.split('/').at(-1)){case'list':return[{source:'source',sourceEpoch:'epoch',pollMs:30000}];case'read':return{ownerUserId:'WA',...options};case'begin':return{refreshId:null};case'claim':return{kind:'name',name:'Explicit',id:'op',attempt:'a'};}},request:async(method:string)=>{requests.push(method);return{state:'unknown',snapshot:'missing'in options?undefined:{externalId:'room',name:'',memberIds:['WA']},binding:{}};}});
  await pump.poll();await pump.close();assert.deepEqual(requests,['group-sync']);
  assert.ok(commands.some(([m])=>m.endsWith('/settle')));assert.equal(commands.some(([m])=>m.endsWith('/error')),false);
 }
});

test('fresh IOA RTX evidence links an existing Actor through owner then syncs membership without registering a duplicate',async t=>{
 const f=await fixture(t);
 const {createRtxMemberEvidence,synchronizeRtxMembers}=await import('../../plugins/tencentoa/src/rtx-directory.mjs');
 const p={provider:'tencentoa',subject:'110337',displayName:'Unrelated label',attributes:{loginName:'ruippan'},aliases:['login:ruippan'],expiresAt:Date.now()+60000};
 const employee=f.actors.resolveHuman(p)!;
 await f.configure({members:'inbound',historyAccess:'full',initial:'external'});
 const count=f.actors.list().length,credentials=f.db.prepare('SELECT count(*) AS n FROM actor_credentials').get()!.n;
 const rows=new Map<string,string>();
 const resolve=createRtxMemberEvidence({knownPrincipals:async()=>[p],read:async(k:string)=>rows.get(k)??null,evaluate:async(_s:string,[k]:string[],[old,next]:string[])=>{if((rows.get(k)??'')!==old)return 0;rows.set(k,next);return 1;}},async(_source:string,id:string)=>{if(id!=='T03370011A')throw Error('unresolved');return 'ruippan';});
 const errors:any[]=[];let tick=0;
 const pump=createGroupSyncPump({call:(method:string,params:any)=>f.service.synchronizeChannels({method,params}),
   linkMembers:(source:string,snapshot:any,evidence:any)=>synchronizeRtxMembers(f.service,source,snapshot,evidence),
   request:async(_method:string,input:any)=>{assert.equal(input.resolveMembers,true);const snapshot=f.snapshot('Provider',['WA','WB','T03370011A']);return{snapshot,binding:f.binding,memberEvidence:await resolve(f.source,snapshot.memberIds)};},onError:(e:any)=>errors.push(e)});
 await pump.poll();await pump.close();assert.deepEqual(errors,[]);
 assert.equal(f.actors.findHuman({provider:'wecom.wxfixture',subject:'T03370011A'})?.id,employee.actorId);
 assert.equal(f.service.channels.isMember(f.group.id,employee.actorId),true);
 assert.equal(f.actors.resolveHuman(p)?.actorId,employee.actorId);
 assert.equal(f.actors.list().length,count);assert.equal(f.db.prepare('SELECT count(*) AS n FROM actor_credentials').get()!.n,credentials);
});

test('unknown roster member is reserved without access; roster is visible before login and first login retains its membership',async t=>{
 const f=await fixture(t);
 const {createRtxMemberEvidence,synchronizeRtxMembers,rtxReservationClaim}=await import('../../plugins/tencentoa/src/rtx-directory.mjs');
 f.actors.registerHumanReservationResolver(rtxReservationClaim);
 await f.configure({members:'inbound',historyAccess:'full',initial:'external'});
 let principals:any[]=[];
 const rows=new Map<string,string>();
 const resolve=createRtxMemberEvidence({knownPrincipals:async()=>principals,read:async(k:string)=>rows.get(k)??null,evaluate:async(_s:string,[k]:string[],[old,next]:string[])=>{if((rows.get(k)??'')!==old)return 0;rows.set(k,next);return 1;}},async(_source:string,id:string)=>{if(id!=='T03370011A')throw Error('unresolved');return 'ruippan';});
 const errors:any[]=[];let tick=0;
 const pump=createGroupSyncPump({call:(method:string,params:any)=>f.service.synchronizeChannels({method,params}),
  linkMembers:(source:string,snapshot:any,evidence:any)=>synchronizeRtxMembers(f.service,source,snapshot,evidence),
  request:async()=>{const snapshot=f.snapshot('Provider',['WA','WB','T03370011A']);return{snapshot,binding:f.binding,memberEvidence:await resolve(f.source,snapshot.memberIds)};},onError:(e:any)=>errors.push(e),now:()=>Date.now()+(++tick)*1000000});
 const count=f.actors.list().length,credentials=f.db.prepare('SELECT count(*) AS n FROM actor_credentials').get()!.n;
 await pump.poll();assert.deepEqual(errors,[]);
 const pending=f.db.prepare('SELECT actor_id FROM actor_human_reservations').get()!;
 assert.equal(f.service.channels.isMember(f.group.id,String(pending.actor_id)),false);
 const {members:beforeMembers}=await f.channel(f.alice,'group/members/list',{channelId:f.group.id});
 assert.ok(beforeMembers.some((m:any)=>m.actorId===pending.actor_id));
 const memberRow=f.db.prepare('SELECT epoch FROM actor_channel_members WHERE channel_id=? AND actor_id=?').get(f.group.id,pending.actor_id)!;
 assert.ok(memberRow);
 assert.throws(()=>f.service.channels.get({actorId:String(pending.actor_id),generation:1,credentialId:null,expiresAt:Date.now()+60000},f.group.id),/channel_denied/);
 await pump.poll();assert.deepEqual(errors,[]);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM actor_human_reservations').get()!.n,1);

 assert.equal(f.actors.list().length,count+1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM actor_credentials').get()!.n,credentials);
 const p={provider:'tencentoa',subject:'110337',displayName:'ruippan',attributes:{loginName:'ruippan',wecomCorpId:'wxfixture',wecomUserId:'T03370011A',wecomVerifiedUntil:String(Date.now()+50000)},aliases:['login:ruippan'],expiresAt:Date.now()+60000};
 assert.equal(f.actors.resolveHuman(p)?.actorId,pending.actor_id);principals=[p];
 await pump.poll();await pump.close();assert.deepEqual(errors,[]);
 assert.equal(f.service.channels.isMember(f.group.id,String(pending.actor_id)),true);
 assert.equal(f.actors.list().length,count+1);
 assert.equal(f.db.prepare('SELECT epoch FROM actor_channel_members WHERE channel_id=? AND actor_id=?').get(f.group.id,pending.actor_id)!.epoch,memberRow.epoch);
});


test('a dormant roster placeholder is retired when verified evidence finds an existing IOA account',async t=>{
 const f=await fixture(t);
 const {synchronizeRtxMembers}=await import('../../plugins/tencentoa/src/rtx-directory.mjs');
 const principal={provider:'tencentoa',subject:'123456',displayName:'existing',attributes:{loginName:'existing'},aliases:['login:existing'],expiresAt:Date.now()+60000};
 const existing=f.actors.resolveHuman(principal)!;
 await f.configure({members:'inbound',historyAccess:'full',initial:'external'});
 const snapshot=f.snapshot('Provider',['WA','WB','T10001A']);
 const evidence={source:f.source,members:[{userId:'T10001A',rtx:'existing',subject:null as string|null,expiresAt:Date.now()+50000}]};
 await synchronizeRtxMembers(f.service,f.source,snapshot,evidence);await f.observe(snapshot);
 const pending=f.db.prepare("SELECT actor_id FROM actor_human_reservations WHERE state='pending'").get()!;
 assert.ok(f.db.prepare('SELECT 1 FROM actor_channel_members WHERE actor_id=?').get(pending.actor_id));
 evidence.members[0]!.subject='123456';
 await synchronizeRtxMembers(f.service,f.source,snapshot,evidence);await f.observe(snapshot);
 assert.equal(f.actors.get(String(pending.actor_id)),null);
 assert.equal(f.actors.findHuman({provider:'wecom.wxfixture',subject:'T10001A'})?.id,existing.actorId);
 assert.equal(f.service.channels.isMember(f.group.id,existing.actorId),true);
});


async function pendingRoster(t:test.TestContext) {
 const f=await fixture(t);await f.configure({members:'both',historyAccess:'full',initial:'external'});
 const {synchronizeRtxMembers}=await import('../../plugins/tencentoa/src/rtx-directory.mjs');
 const snapshot=f.snapshot('Provider',['WA','WB','T10001A']);
 const evidence={source:f.source,members:[{userId:'T10001A',rtx:'newuser',subject:null,expiresAt:Date.now()+60000}]};
 await synchronizeRtxMembers(f.service,f.source,snapshot,evidence);await f.observe(snapshot);
 const id=String(f.db.prepare("SELECT actor_id FROM actor_human_reservations WHERE alias='newuser'").get()!.actor_id);
 return{f,synchronizeRtxMembers,snapshot,evidence,id};
}
test('revoked reservation cannot block a complete snapshot or another member departure',async t=>{
 const {f,synchronizeRtxMembers,snapshot,evidence,id}=await pendingRoster(t);
 f.actors.setEnabled(id,false,'administrator');snapshot.memberIds=['WA','T10001A'];
 const errors:any[]=[];
 const pump=createGroupSyncPump({call:(method:string,params:any)=>f.service.synchronizeChannels({method,params}),
  linkMembers:(s:string,snap:any,e:any)=>synchronizeRtxMembers(f.service,s,snap,e),
  request:async()=>({snapshot,binding:f.binding,memberEvidence:evidence}),onError:(e:any)=>errors.push(e)});
 await pump.poll();await pump.close();assert.deepEqual(errors,[]);
 assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),false);
 assert.equal(f.db.prepare('SELECT 1 FROM actor_channel_members WHERE channel_id=? AND actor_id=?').get(f.group.id,id),undefined);
 assert.deepEqual((await f.read()).snapshot.memberIds,[...snapshot.memberIds].sort());
 assert.equal(f.actors.get(id)?.enabled,false);assert.deepEqual(f.actors.bindings(id),[]);
 assert.equal(f.db.prepare('SELECT state FROM actor_human_reservations WHERE actor_id=?').get(id)!.state,'revoked');
});
test('pending removal queues once and real provider adapter confirms the simulated remote removal',async t=>{
 const {f,id,snapshot}=await pendingRoster(t),provider=providerFixture(),errors:any[]=[];
 provider.setSnapshot(snapshot);Object.assign(provider.binding,f.binding);
 // Read through the actual provider adapter before issuing the local intent.
 const make=()=>createGroupSyncPump({call:(method:string,params:any)=>f.service.synchronizeChannels({method,params}),
  request:async(_method:string,input:any)=>groupSyncProvider(provider.svc,{id:'one'},input,AbortSignal.timeout(1000)),onError:(e:any)=>errors.push(e)});
 let pump=make();await pump.poll();await pump.close();
 const params={channelId:f.group.id,actorId:id,present:false,clientRequestId:'remove-pending'};
 await f.channel(f.alice,'group/member/set',params);await f.channel(f.alice,'group/member/set',params);
 let row=await f.read();assert.equal(row.operations.length,1);assert.equal(row.operations[0].userId,'T10001A');assert.equal(row.operations[0].present,false);
 assert.equal(f.db.prepare('SELECT 1 FROM actor_channel_members WHERE channel_id=? AND actor_id=?').get(f.group.id,id),undefined);
 pump=make();await pump.poll();await pump.close();row=await f.read();
 assert.deepEqual(errors,[]);assert.equal(row.operations[0].state,'confirmed');assert.equal(provider.updates(),1);
 assert.equal(row.snapshot.memberIds.includes('T10001A'),false);
 assert.deepEqual(f.actors.bindings(id),[]);assert.equal(f.actors.get(id)?.enabled,false);
 await assert.rejects(f.channel(f.alice,'group/member/set',{...params,present:true,clientRequestId:'add-pending'}));
});
for(const variant of ['cross-corp','other-source','ambiguous'] as const)test('pending removal refuses '+variant+' evidence',async t=>{
 const {f,id}=await pendingRoster(t);
 if(variant==='cross-corp')f.db.prepare('UPDATE actor_human_reservations SET binding=? WHERE actor_id=?').run(JSON.stringify(['wecom.wxother','T10001A']),id);
 if(variant==='other-source'||variant==='ambiguous'){
  const row=await f.read();
  if(variant==='other-source'){row.identities={};row.imported={};row.snapshot.memberIds=['WA','WB'];}
  else {row.identities.T20002A=id;row.snapshot.memberIds.push('T20002A');f.db.prepare("INSERT INTO actor_human_reservations SELECT ?,actor_id,login_provider,alias,created_at,state FROM actor_human_reservations WHERE actor_id=?").run(JSON.stringify(['wecom.wxfixture','T20002A']),id);}
  f.db.prepare('UPDATE join_wecom_group_sync SET value=? WHERE source=?').run(JSON.stringify(row),f.source);
 }
 await f.channel(f.alice,'group/member/set',{channelId:f.group.id,actorId:id,present:false,clientRequestId:'remove-untrusted'});
 assert.deepEqual((await f.read()).operations,[]);assert.deepEqual(f.actors.bindings(id),[]);
});

for(const state of ['pending','revoked'] as const)for(const entry of ['sync','chat','native'] as const)test(entry+' removes '+state+' reservation through provider confirmation without admission',async t=>{
 const {f,id,snapshot}=await pendingRoster(t),provider=providerFixture(),errors:any[]=[];
 provider.setSnapshot(snapshot);Object.assign(provider.binding,f.binding);
 if(state==='revoked')f.actors.setEnabled(id,false,'administrator');
 const op={kind:'member',userId:'T10001A',present:false};
 const remove=()=>entry==='sync'?f.cli('sync','request',JSON.stringify(op),'--idempotency-key','remove-reserved'):
  entry==='chat'?f.cli('chat','remove','newuser','--idempotency-key','remove-reserved'):
  f.channel(f.alice,'group/member/set',{channelId:f.group.id,actorId:id,present:false,clientRequestId:'remove-reserved'});
 await assert.rejects(f.cli('sync','request',JSON.stringify({...op,present:true}),'--idempotency-key','add-reserved'),/identity_required/);
 await assert.rejects(f.cli('chat','add','newuser','--idempotency-key','add-reserved'),/identity_required/);
 await remove();await remove();
 assert.equal((await f.read()).operations.length,1);assert.equal((await f.read()).operations[0].userId,'T10001A');
 assert.equal(f.db.prepare('SELECT 1 FROM actor_channel_members WHERE channel_id=? AND actor_id=?').get(f.group.id,id),undefined);
 const pump=createGroupSyncPump({call:(method:string,params:any)=>f.service.synchronizeChannels({method,params}),
  request:async(_method:string,input:any)=>groupSyncProvider(provider.svc,{id:'one'},input,AbortSignal.timeout(1000)),onError:(e:any)=>errors.push(e)});
 await pump.poll();await pump.close();
 assert.deepEqual(errors,[]);assert.equal((await f.read()).operations[0].state,'confirmed');assert.equal(provider.updates(),1);
 assert.equal((await f.read()).snapshot.memberIds.includes('T10001A'),false);
 assert.deepEqual(f.actors.bindings(id),[]);assert.equal(f.actors.get(id)?.enabled,false);
 assert.equal(f.db.prepare('SELECT state FROM actor_human_reservations WHERE actor_id=?').get(id)!.state,state);
});
for(const variant of ['cross-corp','other-source','ambiguous'] as const)test('both CLI removal entries reject '+variant+' reservation evidence',async t=>{
 const {f,id}=await pendingRoster(t);
 if(variant==='cross-corp')f.db.prepare('UPDATE actor_human_reservations SET binding=? WHERE actor_id=?').run(JSON.stringify(['wecom.wxother','T10001A']),id);
 else {
  const row=await f.read();
  if(variant==='other-source'){row.identities={};row.snapshot.memberIds=['WA','WB'];}
  else {row.identities.T20002A=id;row.snapshot.memberIds.push('T20002A');f.db.prepare("INSERT INTO actor_human_reservations SELECT ?,actor_id,login_provider,alias,created_at,state FROM actor_human_reservations WHERE actor_id=?").run(JSON.stringify(['wecom.wxfixture','T20002A']),id);}
  f.db.prepare('UPDATE join_wecom_group_sync SET value=? WHERE source=?').run(JSON.stringify(row),f.source);
 }
 await assert.rejects(f.cli('sync','request',JSON.stringify({kind:'member',userId:'T10001A',present:false}),'--idempotency-key','bad-sync'),/identity_required/);
 await assert.rejects(f.cli('chat','remove','newuser','--idempotency-key','bad-chat'),/identity_required/);
 assert.deepEqual((await f.read()).operations,[]);assert.ok(f.db.prepare('SELECT 1 FROM actor_channel_members WHERE channel_id=? AND actor_id=?').get(f.group.id,id));
});

test('provider diagnostics cross the pump and persist in sync status and pruned business receipts',async t=>{
 const f=await fixture(t);await f.configure({name:'both'});await f.observe();
 const edit=await f.cli('chat','rename','Diagnostic','--idempotency-key','diagnostic');
 const pump=createGroupSyncPump({call:(method:string,p:any)=>f.cmd(method.split('/').at(-1)!,p),request:async(_method:string,p:any)=>({state:'rejected',snapshot:f.snapshot(),binding:f.binding,diagnostics:{operationId:p.id,state:'rejected',action:'rename',write:{stage:'write',errcode:85008,errmsg:'denied https://host/?access_token=hidden\n',apiPath:'/cgi-bin/tencent/chat/update',payload:{secret:'hidden'}},readback:{confirmation:'not_matched'}}})});
 await pump.poll();await pump.close();
 const status=await f.cli('status',edit.receiptId);assert.equal(status.wecom.state,'needs_attention');assert.equal(status.changes[0].wecom.diagnostics.write.errcode,85008);
 assert.ok(!JSON.stringify(status).includes('hidden'));assert.ok(!JSON.stringify(status).includes('payload'));
 const sync=await f.cli('sync','status');assert.ok(JSON.stringify(sync).includes('85008'));
 const {readGroupSync,writeGroupSync}=await import('../../plugins/wecom/group-sync-storage.mjs');
 const row=readGroupSync(f.db,f.source);row.operations=[];writeGroupSync(f.db,row);
 assert.deepEqual((await f.cli('status',edit.receiptId)).changes,status.changes);
});

test('unavailable readback settles unknown without projecting stale roster or changing member epochs',async t=>{
 const f=await fixture(t);await f.configure({name:'both',members:'both',historyAccess:'full'});await f.observe();
 await f.cli('chat','rename','Diagnostic','--idempotency-key','unavailable');
 const before=await f.read(),epoch=f.service.channels.memberEpoch(f.group.id,f.bob.actorId);
 const errors:any[]=[];
 const pump=createGroupSyncPump({call:(method:string,p:any)=>f.cmd(method.split('/').at(-1)!,p),request:async()=>({state:'unknown',snapshot:null,snapshotUnavailable:true,binding:f.binding,diagnostics:{write:{errcode:85008},readback:{confirmation:'unavailable'}}}),onError:(e:any)=>errors.push(e)});
 await pump.poll();await pump.close();
 const after=await f.read();assert.deepEqual(errors,[]);assert.deepEqual(after.snapshot,before.snapshot);assert.deepEqual(after.identities,before.identities);assert.deepEqual(after.imported,before.imported);
 assert.equal(after.operations[0].state,'unknown');assert.equal(after.operations[0].diagnostics.write.errcode,85008);
 assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),true);assert.equal(f.service.channels.memberEpoch(f.group.id,f.bob.actorId),epoch);
 assert.equal(f.service.channels.get(f.alice,f.group.id).title,'Diagnostic');
 const op=after.operations[0];await assert.rejects(f.cmd('settle',{sourceEpoch:f.epoch(),id:op.id,attempt:op.attempt,state:'confirmed',snapshot:null,snapshotUnavailable:true,binding:f.binding}),/unverified/);
});

test('owner-privilege removal failure stays visible after reads and unrelated successful additions and rename',async t=>{
 const f=await fixture(t);await f.configure({name:'both',members:'both',historyAccess:'full'});await f.observe();
 const result=await f.cli('chat','remove','bob','--idempotency-key','owner-required');
 const op=await f.cmd('claim',{sourceEpoch:f.epoch()});
 await f.cmd('settle',{sourceEpoch:f.epoch(),id:op.id,attempt:op.attempt,state:'rejected',snapshot:f.snapshot(),binding:f.binding,
  diagnostics:{action:'remove',write:{stage:'write',apiPath:'/cgi-bin/tencent/chat/update',errcode:86101,errmsg:'operation require owner privilege'}}});
 const status=()=>f.channel(f.alice,'group/sync/status',{channelId:f.group.id});
 assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),false);
 assert.deepEqual((await status()).deliveryIssue,{action:'remove',reason:'owner_required'});
 assert.equal((await status()).state,'error');
 assert.match((await f.cli('status',result.receiptId)).changes[0].wecom.message,/企业微信群主权限/);
 await f.observe();assert.equal((await status()).state,'error');
 // A rejected removal is terminal and never blocks or disables the next action.
 await f.cli('chat','add','carol','--idempotency-key','add-after-denial');
 let next=await f.cmd('claim',{sourceEpoch:f.epoch()});assert.equal(next.userId,'WC');assert.equal(next.present,true);
 await f.cmd('settle',{sourceEpoch:f.epoch(),id:next.id,attempt:next.attempt,state:'confirmed',snapshot:f.snapshot('Provider',['WA','WB','WC']),binding:f.binding});
 await f.cli('chat','rename','888','--idempotency-key','rename-after-denial');
 next=await f.cmd('claim',{sourceEpoch:f.epoch()});assert.equal(next.kind,'name');
 await f.cmd('settle',{sourceEpoch:f.epoch(),id:next.id,attempt:next.attempt,state:'confirmed',snapshot:f.snapshot('888',['WA','WB','WC']),binding:f.binding});
 assert.deepEqual((await status()).deliveryIssue,{action:'remove',reason:'owner_required'});
 assert.equal((await status()).state,'error');
 // A successful refresh checks facts; it does not resend terminal failures.
 const pump=createGroupSyncPump({call:(method:string,params:any)=>f.service.synchronizeChannels({method,params}),request:async(_a:string,p:any)=>{
  assert.equal(p.action,'read');return{snapshot:f.snapshot('888',['WA','WB','WC']),binding:f.binding};}});
 await f.channel(f.alice,'group/sync/refresh',{channelId:f.group.id,clientRequestId:'check-only'});
 await pump.poll();await pump.close();assert.equal((await status()).state,'error');
 // External owner can resolve it independently. A fresh read then clears attention.
 await f.observe(f.snapshot('888',['WA','WC']));assert.equal((await status()).deliveryIssue,undefined);assert.equal((await status()).state,'idle');
 // Historical business receipt still truthfully records the original failure.
 assert.equal((await f.cli('status',result.receiptId)).wecom.state,'needs_attention');
});

test('a newer intent for the same member supersedes its old denial, without suppressing other fields',async t=>{
 const f=await fixture(t);await f.configure({members:'both',historyAccess:'full'});await f.observe();
 await f.cli('chat','remove','bob','--idempotency-key','remove-denied');const op=await f.cmd('claim',{sourceEpoch:f.epoch()});
 await f.cmd('settle',{sourceEpoch:f.epoch(),id:op.id,attempt:op.attempt,state:'rejected',snapshot:f.snapshot(),binding:f.binding,diagnostics:{write:{errcode:86101}}});
 await f.cli('chat','add','bob','--idempotency-key','re-add');const next=await f.cmd('claim',{sourceEpoch:f.epoch()});
 await f.cmd('settle',{sourceEpoch:f.epoch(),id:next.id,attempt:next.attempt,state:'confirmed',snapshot:f.snapshot(),binding:f.binding});
 const view=await f.channel(f.alice,'group/sync/status',{channelId:f.group.id});assert.equal(view.deliveryIssue,undefined);assert.equal(view.state,'idle');
});

test('native self leave survives complete remote roster transitions and does not ask WeCom to remove the person',async t=>{
 const f=await fixture(t);await f.configure({members:'both',historyAccess:'full',initial:'external'});await f.observe();
 const count=(await f.read()).operations.length;
 await f.channel(f.bob,'group/leave',{channelId:f.group.id,clientRequestId:'self-leave'});
 await f.observe(f.snapshot('Provider',['WA']));await f.observe(f.snapshot('Provider',['WA','WB','WC']));
 assert.equal(f.service.channels.isMember(f.group.id,f.bob.actorId),false);
 assert.equal(f.service.channels.isMember(f.group.id,f.carol.actorId),true);
 const state=await f.read();assert.equal(state.operations.length,count);
 assert.ok(state.conflicts.some((v:any)=>v.userId==='WB'&&v.reason==='native_departure_retained'));
});
test('native dissolution fences a provider snapshot already in flight and reports disconnected without losing human history',async t=>{
 const f=await fixture(t);await f.configure({members:'both',name:'both',historyAccess:'full'});await f.observe();
 const ticket=await f.cmd('observe',{sourceEpoch:f.epoch()});
 const summary=await f.channel(f.alice,'group/get',{channelId:f.group.id});
 await f.channel(f.alice,'group/dissolve',{channelId:f.group.id,expectedRevision:summary.lifecycle.revision,clientRequestId:'dissolve'});
 await assert.rejects(f.cmd('snapshot',{sourceEpoch:f.epoch(),...ticket,snapshot:f.snapshot('Late name',['WA','WB','WC']),binding:f.binding}),/retired/);
 const status=await f.channel(f.bob,'group/sync/status',{channelId:f.group.id});assert.equal(status.state,'disconnected');assert.equal(status.canRefresh,false);
 await assert.rejects(f.channel(f.alice,'group/sync/refresh',{channelId:f.group.id,clientRequestId:'revive'}),/channel_dissolved/);
 assert.equal((await f.channel(f.bob,'messages/list',{channelId:f.group.id})).messages.length,1);
 assert.equal(f.db.prepare('SELECT title FROM actor_channels WHERE id=?').get(f.group.id)?.title,'Native');
});
