import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {openServerDatabase} from '../../packages/storage-node/src/server';
import {ActorStore} from '../../packages/access-control/src/actors';
import {InstanceAccess,MembershipStore} from '../../packages/access-control/src/index';
import {ThreadAccessStore} from '../../packages/access-control/src/thread-access';
import {Collaboration,type ConversationExecutionPort} from '../../packages/access-control/src/collaboration';
import {ThreadDirectory} from '../../packages/app-host-server/src/thread-directory';
import {OpenCraftHostStateDatabase} from '../../apps/opencraft-daemon/src/opencraft-host-state-database';

async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'trusted-count-')),owner=await openServerDatabase(join(root,'hub')),host=new OpenCraftHostStateDatabase(join(root,'host'));
 const actors=new ActorStore(owner),members=new MembershipStore(owner),access=new InstanceAccess(members,[],actors,['fixture']);
 const human=actors.resolveHuman({provider:'fixture',subject:'one',displayName:'One',expiresAt:Date.now()+600000})!,other=actors.resolveHuman({provider:'fixture',subject:'two',displayName:'Two',expiresAt:Date.now()+600000})!;
 const resources=new ThreadAccessStore(join(root,'access'),actors);
 const directory=new ThreadDirectory(host.database,{list:async()=>{throw Error('No refresh');},changed:()=>{}});
 let reads=0,hook:()=>void=()=>{};
 const forbidden=async()=>{throw Error('No execution');};
 const port:ConversationExecutionPort={hostId:'local-codex',serverId:'server',directory:()=>({instanceId:'fixture',servers:[{serverId:'server',engine:'codex',label:'Count',connectionState:'ready',capabilities:{metadata:true,read:true,boundedRead:true,queue:true,steer:true,threadCount:true}}]}),
  validate:forbidden,receipt:forbidden,add:forbidden,steer:forbidden,cancel:forbidden,
  threadCount:async(_s,req,ctx,signal)=>{reads++;hook();return directory.countRead(req,JSON.stringify(ctx.actorContext),()=>{ctx.resourceOwner!.assertCurrent();signal.throwIfAborted();});}};
 const service=new Collaboration(owner,actors,port,Date.now,()=>{throw Error('No old admission');},()=>{throw Error('No old callback');},async(c,check)=>{
  const privateView=resources.captureCountReadView(c),admission=await access.captureCountAdmission(c,check);
  return !privateView||!admission?null:{...admission,allows:r=>privateView.allows(r.serverId,r.threadId),validate:()=>privateView.validate()&&admission.validate()};});
 t.after(async()=>{await service.close();directory.close();resources.close();members.close();actors.close();host.close();await owner.close();await rm(root,{recursive:true,force:true});});
 const seed=(id:string,name:unknown=null,archived=0,deleted=0)=>host.database.prepare('INSERT INTO opencraft_thread_catalog VALUES(?,?,?,?,?,?,?)').run(id,JSON.stringify({id,name}),1,archived,1,1,deleted);
 const warm=()=>host.database.prepare("INSERT OR REPLACE INTO opencraft_catalog_sync VALUES(0,123,1,123,'ready')").run();
 return {root,owner,host,actors,members,resources,human,other,service,directory,port,seed,warm,get reads(){return reads;},set hook(h:()=>void){hook=h;}};
}

test('exact counts all registered discoverable threads including nameless; exclusions and zero writes',async t=>{
 const f=await fixture(t);f.warm();f.seed('nameless');f.seed('one','same');f.seed('two','same');f.seed('archived',null,1);f.seed('deleted',null,0,1);
 f.resources.created('server','two',f.other);f.resources.set('server','two','private',1,f.other);
 const before=[f.owner.database,f.host.database].map(db=>db.prepare('SELECT total_changes() AS n').get()!.n);
 const count=await f.service.threadCount(f.human,'server');assert.equal(count.status,'exact');assert.equal(count.value,2);
 assert.equal(count.unit,'threads');assert.equal(count.consistency,'authorized-stable-window');assert.equal(count.coverage,'recorded-only');
 assert.deepEqual([f.owner.database,f.host.database].map(db=>db.prepare('SELECT total_changes() AS n').get()!.n),before);
 assert.equal((await f.service.threadCount(f.other,'server')).value,3);
});

test('cold, changing source, ACL ABA and externally committed ABA cannot publish partial totals',async t=>{
 const f=await fixture(t);f.seed('one');
 assert.equal((await f.service.threadCount(f.human,'server')).status,'unknown');f.warm();
 f.hook=()=>{f.host.database.prepare('UPDATE opencraft_thread_catalog SET updated_at=updated_at+1').run();};
 // A raw external write after capture is detected by original connection total_changes.
 let called=0;f.hook=()=>{if(++called===2)f.host.database.prepare('UPDATE opencraft_thread_catalog SET updated_at=updated_at+1').run();};
 assert.equal((await f.service.threadCount(f.human,'server')).status,'unknown');
 called=0;f.hook=()=>{if(++called===2){f.members.setActor(f.human.actorId,'member',false,'fixture');f.members.setActor(f.human.actorId,'member',true,'fixture');}};
 assert.equal((await f.service.threadCount(f.human,'server')).status,'unknown');
 const external=new DatabaseSync(join(f.root,'hub','opencraft-server.sqlite'));t.after(()=>external.close());
 called=0;f.hook=()=>{if(++called===2){external.prepare('UPDATE actors SET enabled=0 WHERE id=?').run(f.human.actorId);external.prepare('UPDATE actors SET enabled=1 WHERE id=?').run(f.human.actorId);}};
 assert.equal((await f.service.threadCount(f.human,'server')).status,'unknown');
});

test('128/1k/12k/16k complete sources remain usable, yield controls and exceed cap honestly',async t=>{
 for(const size of [128,1000,12000,16000,16385])await t.test(String(size),async t=>{
  const f=await fixture(t);f.warm();f.host.database.exec('BEGIN');for(let i=0;i<size;i++)f.seed('t'+i);f.host.database.exec('COMMIT');
  let ticks=0;const timer=setInterval(()=>ticks++,0),started=performance.now();
  const count=await f.service.threadCount(f.human,'server');clearInterval(timer);
  assert.equal(count.status,size>16384?'unknown':'exact');assert.equal(count.value,size>16384?null:size);
  if(size>=1000&&size<=16384)assert.ok(ticks>0);
  t.diagnostic(JSON.stringify({threads:size,milliseconds:performance.now()-started,controlTicks:ticks,status:count.status}));
 });
});

test('Session/wrong server/expired/revoked denied; no owner proof unknown; missing port unsupported',async t=>{
 const f=await fixture(t);f.warm();
 await assert.rejects(f.service.threadCount({...f.human,expiresAt:0},'server'),{status:401});
 await assert.rejects(f.service.threadCount(f.human,'elsewhere'),{status:403});
 const agent=f.actors.createSession('Fixture',f.human.actorId);
 // Actor context must be authentic; unknown body fields never authenticate a Session.
 await assert.rejects(f.service.threadCount({...f.human,actorId:agent.id},'server'));
 f.members.setActor(f.human.actorId,'member',false,'fixture');await assert.rejects(f.service.threadCount(f.human,'server'),{status:403});
 f.members.setActor(f.human.actorId,'member',true,'fixture');f.port.threadCount=undefined;
 await assert.rejects(f.service.threadCount(f.human,'server'),{status:409,code:'unsupported_capability'});
});

test('cold count initialization and internal set read negotiate without physical Native or replacing History initialization',async t=>{
 const {CodexEngineAdapter}=await import('../../apps/opencraft-daemon/src/codex-engine-adapter');
 const {ConversationHistory}=await import('../../packages/app-host-server/src/conversation-history');
 const {ConversationHistoryTransport}=await import('../../packages/app-host-server/src/conversation-history-transport');
 const {THREAD_COUNT_METHOD,THREAD_COUNT_CAPABILITY}=await import('@opencraft/appserver-protocol/collaboration');
 const f=await fixture(t);let spawned=0;
 const adapter=new CodexEngineAdapter({runtimeDirectory:f.root,dataDirectory:join(f.root,'cold'),executable:'/no-native',upstreamBaseUrl:'http://127.0.0.1:9',
  spawnAppServer:()=>{spawned++;throw Error('No Native');},createMaintenanceClient:async()=>{throw Error('No maintenance');}});
 const history=new ConversationHistory(f.owner.database,'count-fixture'),transport=new ConversationHistoryTransport(adapter,history);
 t.after(()=>transport.close());await transport.connect();
 const responses:any[]=[];transport.subscribeMessage(frame=>responses.push(JSON.parse(frame)));
 const context={sender:null,actorContext:f.human,validUntil:Date.now()+9000,collaborationRequestId:'thread-count',resourceOwner:{id:'thread-count',assertCurrent:()=>{assert.ok(f.actors.isCurrent(f.human));}}};
 await transport.sendWithContext(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'count',version:'1'},capabilities:{extensions:{[THREAD_COUNT_CAPABILITY]:true}}},__opencraftClient:'count'}),context);
 assert.equal(responses.find(r=>r.id===1)?.result.capabilities.extensions[THREAD_COUNT_CAPABILITY].version,1);
 await transport.sendWithContext(JSON.stringify({id:2,method:THREAD_COUNT_METHOD,params:{kind:'capture'},__opencraftClient:'count'}),context);
 const deadline=Date.now()+1000;while(!responses.some(r=>r.id===2)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,1));
 assert.deepEqual(responses.find(r=>r.id===2)?.result,{status:'unknown'});
 assert.equal(spawned,0);assert.equal(await history.initialization(),null);
 await transport.sendWithContext(JSON.stringify({method:'runtime/client/disconnect',params:{},__opencraftClient:'count'}),context);
 assert.equal((adapter as any).countReadClients.size,0);assert.equal(spawned,0);
});

test('cancellation after capture stops traversal, and private/grant ABA cannot produce exact',async t=>{
 const f=await fixture(t);f.warm();for(let i=0;i<500;i++)f.seed('t'+i);
 let current=true;f.hook=()=>{setImmediate(()=>{current=false;});};
 assert.equal((await f.service.threadCount(f.human,'server',()=>current)).status,'unknown');
 assert.equal(f.reads,1,'no validation read or retry after cancellation');
 f.resources.created('server','t0',f.human);let calls=0;
 f.hook=()=>{if(++calls===2){f.resources.set('server','t0','private',1,f.human);f.resources.set('server','t0','shared',2,f.human);}};
 assert.equal((await f.service.threadCount(f.human,'server')).status,'unknown');
});

test('orchestration owner and discover-only grants intersect private scope; grant ABA and forged fields fail closed',async t=>{
 const f=await fixture(t);f.warm();f.seed('owned');
 f.service.orchestration.createThread({threadId:'owned',serverId:'server',driverKind:'codex',ownerActorId:f.human.actorId,parentThreadId:null,lifecycleOwnerThreadId:null,forkedFromId:null,visibility:'visible',engineHostGeneration:null,nativeSessionId:null,runtimeStatus:'idle',rootTurnId:null,turnId:null,delegationRevision:1,autoExchangeDepth:0,hasDirectUserInput:false,userInputExcerpt:null});
 assert.equal((await f.service.threadCount(f.other,'server')).value,0);
 const ref='opencraft://conversation/v1/server/owned';
 f.actors.setGrant(f.other.actorId,ref,'conversation.discover',true,'fixture');
 assert.equal(f.actors.can(f.other,ref,'conversation.read'),false);
 assert.equal((await f.service.threadCount(f.other,'server')).value,1);
 f.resources.created('server','owned',f.human);f.resources.set('server','owned','private',1,f.human);
 assert.equal((await f.service.threadCount(f.other,'server')).value,0,'discover grant does not override private');
 f.resources.set('server','owned','shared',2,f.human);
 let n=0;f.hook=()=>{if(++n===2){f.actors.setGrant(f.other.actorId,ref,'conversation.discover',false,'fixture');f.actors.setGrant(f.other.actorId,ref,'conversation.discover',true,'fixture');}};
 assert.equal((await f.service.threadCount(f.other,'server')).status,'unknown');
 await assert.rejects(f.service.command(f.human,{action:'threadCount',serverId:'server',principal:{provider:'fake',subject:'fake'}}),{status:400});
 const session=f.actors.createSession('Session','fixture'),credential=f.actors.issueCredential(session.id,Date.now()+60000,'fixture');
 await assert.rejects(f.service.threadCount(f.actors.authenticateSession(credential.token)!,'server'),{status:403});
});

test('directory proof refuses transactions, owner close/restart tickets and bounded oversized identifiers',async t=>{
 const f=await fixture(t);f.warm();f.seed('one');
 const capture=f.directory.countRead({kind:'capture'},'owner',()=>{});assert.equal(capture.status,'complete');
 f.host.database.exec('BEGIN');assert.equal(f.directory.countRead({kind:'capture'},'owner',()=>{}).status,'unknown');f.host.database.exec('ROLLBACK');
 if(capture.status!=='complete')return;
 assert.equal(f.directory.countRead({kind:'validate',ticket:capture.ticket},'wrong-owner',()=>{}).status,'unknown');
 const next=f.directory.countRead({kind:'capture'},'owner',()=>{});assert.equal(next.status,'complete');
 if(next.status!=='complete')return;
 f.directory.close();assert.equal(f.directory.countRead({kind:'validate',ticket:next.ticket},'owner',()=>{}).status,'unknown');
 const reopened=new ThreadDirectory(f.host.database,{list:async()=>{throw Error('No refresh');},changed:()=>{}});t.after(()=>reopened.close());
 assert.equal(reopened.countRead({kind:'validate',ticket:next.ticket},'owner',()=>{}).status,'unknown');
 f.seed('x'.repeat(4097));assert.equal(reopened.countRead({kind:'capture'},'owner',()=>{}).status,'unknown');
});

test('cooperative total-budget exhaustion is unknown; definite source corruption is read unavailable',async t=>{
 const f=await fixture(t);f.warm();f.seed('one');
 let clock=0;t.mock.method(performance,'now',()=>clock+=1000);
 assert.equal((await f.service.threadCount(f.human,'server')).status,'unknown');
 t.mock.restoreAll();
 f.host.database.exec('DROP TABLE opencraft_thread_catalog');
 await assert.rejects(f.service.threadCount(f.human,'server'),{status:503,code:'thread_count_unavailable'});
});

test('real AppHost/History/adapter preserves unknown for source-time and delivery-time ACL ABA',async t=>{
 const {CodexEngineAdapter}=await import('../../apps/opencraft-daemon/src/codex-engine-adapter');
 const {ConversationHistory}=await import('../../packages/app-host-server/src/conversation-history');
 const {ConversationHistoryTransport}=await import('../../packages/app-host-server/src/conversation-history-transport');
 const {AppHostServer}=await import('../../packages/app-host-server/src/index');
 const {callConversationHost}=await import('../../scripts/conversation-execution.mjs');
 const {THREAD_COUNT_METHOD}=await import('@opencraft/appserver-protocol/collaboration');
 for(const phase of ['source','delivery','admission','budget'])await t.test(phase,async t=>{
  const f=await fixture(t);f.warm();f.seed('one');f.members.setActor(f.human.actorId,'member',true,'fixture');
  const external=new DatabaseSync(join(f.root,'hub','opencraft-server.sqlite'));t.after(()=>external.close());
  const aba=()=>{external.prepare('UPDATE actor_members SET enabled=0 WHERE actor_id=?').run(f.human.actorId);external.prepare('UPDATE actor_members SET enabled=1 WHERE actor_id=?').run(f.human.actorId);};
  let spawned=0;
  const adapter=new CodexEngineAdapter({runtimeDirectory:f.root,dataDirectory:join(f.root,'transport'),executable:'/no-native',upstreamBaseUrl:'http://127.0.0.1:9',spawnAppServer:()=>{spawned++;throw Error('No Native');},createMaintenanceClient:async()=>{throw Error('No maintenance');}});
  (adapter as any).durableCatalog=f.directory;
  if(phase==='source'||phase==='budget'){
    const now=performance.now.bind(performance),start=now();let expired=false;
    if(phase==='budget')t.mock.method(performance,'now',()=>expired?start+10000:now());
    const read=f.directory.countRead.bind(f.directory);
    t.mock.method(f.directory,'countRead',(request,scope,check)=>{let calls=0;return read(request,scope,()=>{if(++calls===2){if(phase==='budget')expired=true;else aba();}check();});});
  }else if(phase==='delivery')adapter.subscribeMessage(raw=>{const packet=JSON.parse(raw);if(packet.result?.status==='complete')aba();});
  else {const send=adapter.sendWithContext.bind(adapter);t.mock.method(adapter,'sendWithContext',async(frame,context)=>{if(JSON.parse(frame).method===THREAD_COUNT_METHOD)aba();return send(frame,context);});}
  const transport=new ConversationHistoryTransport(adapter,new ConversationHistory(f.owner.database,'count-fixture'));
  const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',hostDefinitions:[{hostId:'local-codex',label:'Count'}],createTransport:()=>transport});
  t.after(()=>host.close());
  f.port.threadCount=(_server,request,context,signal)=>callConversationHost(host,{hostId:'local-codex',threadId:''},'thread-count',THREAD_COUNT_METHOD,request,context,9000,signal);
  const count=await f.service.threadCount(f.human,'server');
  assert.equal(count.status,'unknown');assert.equal(count.value,null);assert.equal(spawned,0);t.mock.restoreAll();
 });
});

test('Core bridge without count owner negotiates unsupported without forwarding or warming Native',async t=>{
 const {CodexEngineAdapter}=await import('../../apps/opencraft-daemon/src/codex-engine-adapter');
 const {THREAD_COUNT_CAPABILITY}=await import('@opencraft/appserver-protocol/collaboration');
 const f=await fixture(t);let calls=0;
 const adapter=new CodexEngineAdapter({runtimeDirectory:f.root,dataDirectory:join(f.root,'unsupported-core'),executable:'/no-native',upstreamBaseUrl:'http://127.0.0.1:9'});
 (adapter as any).coreBridge={status:{state:'idle'},subscribeMessage:()=>()=>{},subscribeStatus:()=>()=>{},close:async()=>{},sendWithContext:async()=>{calls++;},connect:async()=>{calls++;}};
 t.after(()=>adapter.close());const replies:any[]=[];adapter.subscribeMessage(raw=>replies.push(JSON.parse(raw)));
 await adapter.sendWithContext(JSON.stringify({id:'init',method:'initialize',params:{capabilities:{extensions:{[THREAD_COUNT_CAPABILITY]:true}}},__opencraftClient:'count'}),{sender:null,actorContext:f.human,resourceOwner:{id:'count',assertCurrent:()=>{}}});
 assert.equal(replies[0]?.result.capabilities.extensions['opencraft/collaboration'].threadCount,false);
 assert.equal(calls,0);
});
