import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorStore } from '../../packages/access-control/src/actors';
import { Collaboration, type ConversationExecutionPort } from '../../packages/access-control/src/collaboration';
import { ThreadAccessStore } from '../../packages/access-control/src/thread-access';
import { openServerDatabase } from '../../packages/storage-node/src/server';
import { CollaborationClient } from '../../packages/appserver-client/src/collaboration';
import { MemoryTransport } from '@opencraft/appserver-transport-memory';
import { run } from '../../apps/opencraft-cli/src/main';
import { classify } from '../../apps/opencraft-cli/src/errors';
import { CliSshTransport } from '../../apps/opencraft-cli/src/ssh';
const ref = { serverId: 'server', threadId: 'thread' };
async function fixture(t: test.TestContext) {
  const root=await mkdtemp(join(tmpdir(),'queue-requests-')),owner=await openServerDatabase(root),actors=new ActorStore(owner);
  const human=actors.resolveHuman({provider:'fixture',subject:'one',displayName:'One',expiresAt:Date.now()+600_000})!;
  const other=actors.resolveHuman({provider:'fixture',subject:'two',displayName:'Two',expiresAt:Date.now()+600_000})!;
  const access=new ThreadAccessStore(join(root,'access.sqlite'),actors);let allowed=true,revoke=false,checks=0,business=0;
  const forbidden=async()=>{business++;throw Error('business call from read');};
  const port:ConversationExecutionPort={serverId:'server',hostId:'host',owns:id=>['server','other-server'].includes(id),directory:()=>({instanceId:'i',servers:[]}),validate:forbidden,receipt:forbidden,add:forbidden,steer:forbidden,cancel:forbidden};
  let service:Collaboration;const open=()=>service=new Collaboration(owner,actors,port,Date.now,()=>allowed,(c,r)=>{if(revoke&&++checks===2)allowed=false;return allowed&&access.allows(r.serverId,r.threadId,c);});open();
  t.after(async()=>{await service.close();access.close();actors.close();await owner.close();await rm(root,{recursive:true,force:true});});
  const seed=owner.database.prepare(`INSERT INTO actor_execution_requests (id,requester_id,requester_generation,target_id,target_generation,binding_epoch,thread_id,mode,state,created_at,updated_at,target_kind,server_id) VALUES(?,?,1,'target',0,0,?,?,?,1,1,'conversation',?)`);
  return {root,owner,actors,human,other,access,port,get service(){return service;},get business(){return business;},set allowed(v:boolean){allowed=v;},set revoke(v:boolean){revoke=v;},async reopen(){await service.close();open();},
    add:(id:string,actor=human.actorId,thread='thread',state='accepted',mode='queue',server='server')=>seed.run(id,actor,thread,mode,state,server),
    read:(cursor?:string,limit?:number,context=human,target=ref)=>service.queueRequests(context,target,cursor??null,limit)};
}
test('own/ref/queue facts and frozen settings are allowlisted without business writes or Host calls',async t=>{
  const f=await fixture(t),sent=f.service.sendConversation(f.human,{reference:ref,content:'PRIVATE BODY',idempotencyKey:'known-key'});
  f.add('other',f.other.actorId);f.add('thread',f.human.actorId,'other');f.add('server',f.human.actorId,'thread','accepted','queue','other-server');
  for(const state of ['accepted','transferring','queued','unknown','submitted','injected','rejected','cancelled'])f.add(state,f.human.actorId,'thread',state);
  f.add('steer',f.human.actorId,'thread','accepted','steer');f.owner.database.prepare('INSERT INTO conversation_input_settings VALUES(?,?,?)').run('queued','model-frozen','medium');
  const before=f.owner.database.prepare('SELECT total_changes() AS n').get()!.n,page=f.read();
  assert.deepEqual(page.entries.map(x=>x.requestId),[sent.requestId,'accepted','transferring','queued','unknown']);
  assert.equal(page.scope,'own-hub-queue-requests');assert.equal(page.source,'hub-request-ledger');assert.equal(page.consistency,'bounded-membership-live-state');assert.equal(page.complete,true);
  assert.deepEqual(page.entries.find(x=>x.requestId==='queued')!.requestedSettings,{model:'model-frozen',reasoningEffort:'medium'});
  assert.ok(page.entries.every(x=>x.operationKey===null&&x.actualTurnSettings===null&&x.nativeConfirmedConfiguration===null&&x.taskOutcome==='unknown'));
  assert.equal(/PRIVATE|known-key/.test(JSON.stringify(page)),false);
  assert.deepEqual(Object.keys(page.entries[0]).sort(),['requestId','operationKey','mode','deliveryState','targetTurnId','createdAt','updatedAt','requestedSettings','nativeConfirmedConfiguration','actualTurnSettings','taskOutcome'].sort());
  assert.equal(f.owner.database.prepare('SELECT total_changes() AS n').get()!.n,before);assert.equal(f.business,0);
  assert.deepEqual(f.read(undefined,50,f.other).entries.map(x=>x.requestId),['other']);
  assert.deepEqual(f.read(undefined,50,f.human,{...ref,threadId:'other'}).entries.map(x=>x.requestId),['thread']);
  assert.deepEqual(f.read(undefined,50,f.human,{...ref,serverId:'other-server'}).entries.map(x=>x.requestId),['server']);
});
test('human/private/owned grant and final revocation boundaries are preserved',async t=>{
  const f=await fixture(t);f.add('one');f.access.created('server','thread',f.human);f.access.set('server','thread','private',1,f.human);
  assert.throws(()=>f.read(undefined,1,f.other),{status:403});f.access.set('server','thread','shared',2,f.human);
  f.service.orchestration.createThread({threadId:'thread',serverId:'server',driverKind:'codex',ownerActorId:f.human.actorId,parentThreadId:null,lifecycleOwnerThreadId:null,forkedFromId:null,visibility:'visible',engineHostGeneration:null,nativeSessionId:null,runtimeStatus:'idle',rootTurnId:null,turnId:null,delegationRevision:1,autoExchangeDepth:0,hasDirectUserInput:false,userInputExcerpt:null});
  assert.throws(()=>f.read(undefined,1,f.other),{status:403});f.actors.setGrant(f.other.actorId,'opencraft://conversation/v1/server/thread','conversation.read',true,'fixture');assert.deepEqual(f.read(undefined,1,f.other).entries,[]);
  const session=f.actors.createSession('Session','fixture'),credential=f.actors.issueCredential(session.id,Date.now()+60000,'fixture');
  assert.throws(()=>f.read(undefined,1,f.actors.authenticateSession(credential.token)!),{status:403});assert.throws(()=>f.read(undefined,1,{...f.human,generation:f.human.generation+1}),{status:401});
  await assert.rejects(f.service.command(f.human,{action:'queueRequests',reference:ref,principal:{provider:'fake',subject:'fake'}}),{status:400});
  f.revoke=true;assert.throws(()=>f.read(),{status:403});f.allowed=false;assert.throws(()=>f.read(),{status:401});assert.equal(f.business,0);
});
test('opaque cursors bind sparse membership, survive live changes, reject rebinding, tamper and owner restart',async t=>{
  const f=await fixture(t);f.owner.database.exec('BEGIN');for(let n=0;n<2400;n++)f.add('noise-'+n,f.other.actorId);for(let n=0;n<251;n++)f.add('own-'+n);f.owner.database.exec('COMMIT');
  const first=f.read(undefined,100);assert.equal(first.entries.length,0);assert.ok(first.nextCursor);assert.equal(first.complete,false);
  for(const [context,target] of [[f.other,ref],[f.human,{...ref,threadId:'other'}],[f.human,{...ref,serverId:'other-server'}]] as const)assert.throws(()=>f.read(first.nextCursor!,100,context,target),{code:'queue_cursor_invalid'});
  const bytes=Buffer.from(first.nextCursor!,'base64url');bytes[bytes.length-1]^=1;assert.throws(()=>f.read(bytes.toString('base64url')),{code:'queue_cursor_invalid'});
  f.add('late');f.owner.database.prepare("UPDATE actor_execution_requests SET state='submitted' WHERE id='own-200'").run();
  const ids:string[]=[];let page=first,pages=0;while(page.nextCursor){page=f.read(page.nextCursor,100);ids.push(...page.entries.map(x=>x.requestId));assert.ok(++pages<10);}
  assert.equal(ids.length,250);assert.equal(new Set(ids).size,250);assert.equal(ids.includes('late'),false);assert.equal(ids.includes('own-200'),false);assert.equal(page.complete,true);
  await f.reopen();assert.throws(()=>f.read(first.nextCursor!),{code:'queue_cursor_invalid'});assert.equal(f.read().scope,'own-hub-queue-requests');assert.equal(f.business,0);
});
test('100k unrelated rows use primary-key windows, with explicit budget/IO failures and no key scan',async t=>{
  const f=await fixture(t);f.owner.database.exec('BEGIN');for(let n=0;n<100_000;n++)f.add('noise-'+n,f.other.actorId);f.add('last');f.owner.database.exec('COMMIT');
  const prepare=f.owner.database.prepare.bind(f.owner.database),queries:string[]=[];t.mock.method(f.owner.database,'prepare',(sql:string)=>{queries.push(sql);return prepare(sql);});
  const page=f.read();assert.equal(page.entries.length,0);assert.ok(page.nextCursor);
  const scan=queries.find(q=>q.includes('NOT INDEXED'))!,plan=prepare('EXPLAIN QUERY PLAN '+scan).all(0,1024,f.human.actorId,'server','thread',100);
  assert.match(JSON.stringify(plan),/INTEGER PRIMARY KEY.*rowid>\?.*rowid<\?/u);assert.equal(/SCAN|TEMP B-TREE/u.test(JSON.stringify(plan)),false);assert.equal(queries.some(q=>q.includes('actor_send_keys')),false);
  console.info('queue-window-plan',JSON.stringify({rows:100001,plan,firstPageEntries:page.entries.length,hasContinuation:!!page.nextCursor}));
  for(const limit of [0,101,1.5,null,'2'])assert.throws(()=>f.service.queueRequests(f.human,ref,null,limit as any),{status:400});
  t.mock.method(performance,'now',(()=>{let calls=0;return()=>calls++===0?0:101;})());assert.throws(()=>f.read(),{code:'queue_read_unavailable'});t.mock.restoreAll();
  t.mock.method(f.owner.database,'prepare',(sql:string)=>{if(sql.includes('actor_execution_requests'))throw Error('private IO detail');return prepare(sql);});assert.throws(()=>f.read(),{code:'queue_read_unavailable'});
  assert.equal(classify({data:{code:'queue_read_unavailable',status:503}}).code,'QUEUE_READ_UNAVAILABLE');
});
test('old Hub and malformed CLI options reject before queue action; CLI uses only independently negotiated typed read',async t=>{
  const methods:string[]=[];const client=new CollaborationClient(new MemoryTransport({server:{receive(frame,peer){const m=JSON.parse(frame);if(m.id===undefined)return;methods.push(m.method);peer.send(JSON.stringify({id:m.id,result:{capabilities:{extensions:{'opencraft/collaboration':{version:1,servers:true,queue:true}}}}}));}}}));
  await client.connect();await assert.rejects(client.queueRequests(ref),{code:'UNSUPPORTED_CAPABILITY'});await client.close();assert.deepEqual(methods,['initialize']);
  for(const flags of [['--limit','0'],['--limit','101'],['--limit','1.5'],['--limit','01'],['--request','id'],['--model','fake']])await assert.rejects(run(['queue','list','opencraft://conversation/v1/server/thread',...flags]),{code:'INVALID_ARGUMENTS'});
  const root=await mkdtemp(join(tmpdir(),'queue-cli-')),prior=process.env.OPENCRAFT_CONFIG;process.env.OPENCRAFT_CONFIG=join(root,'config');t.after(async()=>{if(prior===undefined)delete process.env.OPENCRAFT_CONFIG;else process.env.OPENCRAFT_CONFIG=prior;await rm(root,{recursive:true,force:true});});
  await writeFile(process.env.OPENCRAFT_CONFIG,JSON.stringify({schemaVersion:1,defaultConnection:'fixture',connections:{fixture:{sshAlias:'fixture',instanceId:'i'}}}));const actions:any[]=[];let capable=true;
  t.mock.method(CliSshTransport.prototype,'connect',async function(this:any){this.update({state:'open'});});
  t.mock.method(CliSshTransport.prototype,'send',async function(this:any,frame:string){const m=JSON.parse(frame);if(m.id===undefined)return;actions.push(m.params);const result=m.method==='initialize'?{capabilities:{extensions:{'opencraft/collaboration':{version:1,servers:true,queueRequests:capable}}}}:m.params.action==='servers'?{instanceId:'i',actor:{kind:'human'},servers:[{serverId:'server',capabilities:{queueRequests:capable}}]}:{entries:[],complete:false,nextCursor:'continue'};for(const listener of this.messages)listener(JSON.stringify({id:m.id,result}));});
  assert.equal((await run(['queue','list','opencraft://conversation/v1/server/thread','--cursor','opaque','--limit','100']) as any).nextCursor,'continue');assert.deepEqual(actions.at(-1),{action:'queueRequests',reference:ref,cursor:'opaque',limit:100});capable=false;
  const count=actions.filter(a=>a?.action==='queueRequests').length;await assert.rejects(run(['queue','list','opencraft://conversation/v1/server/thread']),{code:'UNSUPPORTED_CAPABILITY'});assert.equal(actions.filter(a=>a?.action==='queueRequests').length,count);
});

test('real human public-key SSH -> Hub/ACL/SQLite pages never enter execution or Native business',{timeout:60000},async t=>{
  const {spawn}=await import('node:child_process'),{default:ssh2}=await import('ssh2');
  const {AppHostServer}=await import('../../packages/app-host-server/src/index');
  const {CodexEngineAdapter}=await import('../../apps/opencraft-daemon/src/codex-engine-adapter');
  const {ConversationHistoryTransport}=await import('../../packages/app-host-server/src/conversation-history-transport');
  const {ConversationHistory}=await import('../../packages/app-host-server/src/conversation-history');
  const {ThreadAccessSession}=await import('../../packages/access-control/src/thread-access');
  const {createSshHttpIngress}=await import('../../plugins/ssh-http-ingress/src/index.mjs');
  const {createSshNativeRpcGateway}=await import('../../scripts/ssh-native-rpc-gateway.mjs');
  const f=await fixture(t);for(let n=0;n<130;n++)f.add('human-'+n);f.add('other-human',f.other.actorId);
  f.port.directory=()=>({instanceId:'i',servers:[{serverId:'server',label:'Fixture',engine:'codex',connectionState:'ready',capabilities:{metadata:true,read:true,boundedRead:true,queue:true,steer:true,queueRequests:true}}]});
  const nativeMethods:string[]=[];
  const adapter=new CodexEngineAdapter({executable:process.execPath,runtimeDirectory:f.root,dataDirectory:join(f.root,'native-data'),nativeCodexHomeDirectory:join(f.root,'native-home'),upstreamBaseUrl:'http://127.0.0.1:9',fetch:async()=>{throw Error('no model HTTP');},
    spawnAppServer:({cwd,env})=>{const child=spawn(process.execPath,[new URL('../fixtures/fake-codex-stdio-appserver.mjs',import.meta.url).pathname],{cwd,env,stdio:['pipe','pipe','pipe']});const write=child.stdin.write.bind(child.stdin);child.stdin.write=((chunk:any,...args:any[])=>{try{nativeMethods.push(JSON.parse(String(chunk)).method);}catch{}return (write as any)(chunk,...args);}) as any;return child;},
    createMaintenanceClient:async()=>{throw Error('no maintenance');},logDiagnostic:()=>{},collaboration:{serverId:'server',command:(context,body)=>f.service.command(context,body),authorize(){throw Error('no execution');},started(){throw Error('no execution');},tool:async()=>{throw Error('no tools');}}});
  const history=new ConversationHistory(f.owner.database,'local-codex'),transport=new ConversationHistoryTransport(adapter,history);
  const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createTransport:()=>transport,createRpcAccessSession:(_id,context,emit)=>new ThreadAccessSession(f.access,()=>ref.serverId,context.actorContext,emit,undefined,()=>context.resourceOwner?.assertCurrent())});
  const hostKey=ssh2.utils.generateKeyPairSync('ed25519'),keys={one:ssh2.utils.generateKeyPairSync('ed25519'),two:ssh2.utils.generateKeyPairSync('ed25519')},gateways:any[]=[];
  const ingress=createSshHttpIngress({hostKey:hostKey.private,authorizedKeys:{legacy:[hostKey.public]},httpPort:1,codexPort:1,
    resolveAuthorizedKeys:(name:string)=>name in keys?[keys[name as keyof typeof keys].public]:[],
    authorizeSession:(name:string)=>{const context=name==='one'?f.human:f.other;return {submissionContext:{sender:{kind:'employee',loginName:'synthetic'},actorContext:context,validUntil:context.expiresAt,resourceOwner:{id:'fixture',assertCurrent(){if(!f.actors.isCurrent(context))throw Error('revoked');}}},isCurrent:()=>f.actors.isCurrent(context)};},
    createNativeSession:async(authorization:any)=>{const gateway=await createSshNativeRpcGateway(host,authorization);gateways.push(gateway);return gateway;}});
  const address=await ingress.listen({port:0});t.after(async()=>{await ingress.close();for(const gateway of gateways)await gateway.close();await host.close();});
  const sshConfig=join(f.root,'ssh_config'),known=join(f.root,'known_hosts'),config=join(f.root,'connections.json');let ssh='';
  for(const name of ['one','two'] as const){const path=join(f.root,name);await writeFile(path,keys[name].private,{mode:0o600});ssh+=`Host queue-${name}\n  HostName 127.0.0.1\n  Port ${address.port}\n  User ${name}\n  IdentityFile ${path}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${known}\n`;}
  await writeFile(sshConfig,ssh);await writeFile(known,`[127.0.0.1]:${address.port} ${hostKey.public}\n`);await writeFile(config,JSON.stringify({schemaVersion:1,connections:Object.fromEntries(['one','two'].map(name=>[name,{sshAlias:'queue-'+name,sshConfig,instanceId:'i'}]))}));
  const prior=process.env.OPENCRAFT_CONFIG;process.env.OPENCRAFT_CONFIG=config;t.after(()=>{if(prior===undefined)delete process.env.OPENCRAFT_CONFIG;else process.env.OPENCRAFT_CONFIG=prior;});
  const cli=(name:string,...args:string[])=>run(['queue','list','opencraft://conversation/v1/server/thread','--connection',name,...args]) as Promise<any>;
  const first=await cli('one','--limit','100');assert.equal(first.entries.length,100);assert.ok(first.nextCursor);
  const nativeBefore=nativeMethods.length,before=f.owner.database.prepare('SELECT * FROM actor_execution_requests ORDER BY rowid').all();
  const revision=history.revision.bind(history);let blocked=0;t.mock.method(history,'revision',((thread:string)=>{if(thread==='')return revision(thread);blocked++;return new Promise(()=>{});}) as any);
  const next=await cli('one','--cursor='+first.nextCursor,'--limit','100');assert.equal(next.entries.length,30);assert.equal(next.complete,true);
  assert.deepEqual((await cli('two')).entries.map((x:any)=>x.requestId),['other-human']);
  await assert.rejects(cli('two','--cursor='+first.nextCursor),(error:any)=>classify(error).code==='QUEUE_CURSOR_INVALID');
  f.access.created('server','thread',f.human);f.access.set('server','thread','private',1,f.human);await assert.rejects(cli('two'),(error:any)=>['FORBIDDEN','UNAVAILABLE'].includes(classify(error).code));
  assert.deepEqual(f.owner.database.prepare('SELECT * FROM actor_execution_requests ORDER BY rowid').all(),before);assert.equal(f.business,0);assert.equal(blocked,0);
  assert.deepEqual(nativeMethods.slice(nativeBefore).filter(method=>!['initialize','initialized','runtime/client/disconnect'].includes(method)),[]);
  console.info('queue-ssh-proof',JSON.stringify({humanActors:2,firstPage:100,lastPage:30,executionPortCalls:f.business,nativeBusinessCalls:0,historyTargetReads:blocked,modelRequests:0}));
});
