import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ThreadDirectory} from '../../packages/app-host-server/src/thread-directory';
import {OpenCraftHostStateDatabase} from '../../apps/opencraft-daemon/src/opencraft-host-state-database';
import {openServerDatabase} from '../../packages/storage-node/src/server';
import {ActorStore} from '../../packages/access-control/src/actors';
import {Collaboration,type ConversationExecutionPort} from '../../packages/access-control/src/collaboration';
import {ThreadAccessStore} from '../../packages/access-control/src/thread-access';
import {recordedNameQuery} from '@opencraft/appserver-protocol/collaboration';
import {classify} from '../../apps/opencraft-cli/src/errors';

export async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'name-search-')),owner=await openServerDatabase(join(root,'hub')),hostOwner=new OpenCraftHostStateDatabase(join(root,'host'));
 const actors=new ActorStore(owner),human=actors.resolveHuman({provider:'fixture',subject:'one',displayName:'One',expiresAt:Date.now()+600000})!,other=actors.resolveHuman({provider:'fixture',subject:'two',displayName:'Two',expiresAt:Date.now()+600000})!;
 const access=new ThreadAccessStore(join(root,'access.sqlite'),actors);let admitted=true,refreshes=0,calls=0;
 let catalog=new ThreadDirectory(hostOwner.database,{list:async()=>{refreshes++;throw Error('No request source reads');},changed:()=>{}});
 const forbidden=async()=>{calls++;throw Error('Unexpected execution');};
 const port:ConversationExecutionPort={serverId:'server',hostId:'local-codex',directory:()=>({instanceId:'i',servers:[{serverId:'server',label:'fixture',engine:'codex',connectionState:'ready',capabilities:{metadata:true,read:true,boundedRead:true,queue:true,steer:true,threadSearch:true}}]}),validate:forbidden,receipt:forbidden,add:forbidden,steer:forbidden,cancel:forbidden,
  threadSearch:async(_s,req,ctx,signal)=>{signal.throwIfAborted();return catalog.searchNames(req,()=>{ctx.resourceOwner?.assertCurrent();signal.throwIfAborted();});}};
 let service=new Collaboration(owner,actors,port,Date.now,()=>admitted,(c,r)=>access.allows(r.serverId,r.threadId,c));
 t.after(async()=>{await service.close();catalog.close();access.close();actors.close();hostOwner.close();await owner.close();await rm(root,{recursive:true,force:true});});
 const seed=(id:string,name:unknown='Needle',metadata:Record<string,unknown>={})=>hostOwner.database.prepare('INSERT INTO opencraft_thread_catalog VALUES(?,?,?,?,?,?,?)').run(id,JSON.stringify({id,cwd:'/not-name',updatedAt:1,name,preview:'preview-only',...metadata}),1,0,1,1,0);
 const warm=()=>hostOwner.database.prepare("INSERT OR REPLACE INTO opencraft_catalog_sync VALUES(0,123,1,123,'ready')").run();
 return {root,owner,hostOwner,actors,human,other,access,port,seed,warm,get catalog(){return catalog;},get service(){return service;},get calls(){return calls;},get refreshes(){return refreshes;},set admitted(v:boolean){admitted=v;},
  async reopenHub(){await service.close();service=new Collaboration(owner,actors,port,Date.now,()=>admitted,(c,r)=>access.allows(r.serverId,r.threadId,c));},
  reopenCatalog(){catalog.close();catalog=new ThreadDirectory(hostOwner.database,{list:async()=>{refreshes++;throw Error('No refresh');},changed:()=>{}});},
  search:(query='Needle',cursor:string|null=null,context=human,server='server',field:unknown='name')=>service.threadSearch(context,server,field,query,cursor)};
}
test('name-only NFC/case-sensitive literal scope and allowlist; zero source reads/writes',async t=>{
 const f=await fixture(t);f.warm();f.seed('one','Cafe\u0301 Needle');f.seed('two','needle');f.seed('missing',null);f.seed('preview','Other',{preview:'Needle',cwd:'/Needle',turns:[{text:'Needle'}]});
 const before=f.hostOwner.database.prepare('SELECT total_changes() AS n').get()!.n,page=await f.search('Café');
 assert.deepEqual(page.entries,[{ref:{serverId:'server',threadId:'one'},name:'Cafe\u0301 Needle'}]);assert.equal(page.observedAt,123);assert.equal(page.scope,'authorized-recorded-names');assert.equal(page.coverage,'recorded-only');assert.equal(page.consistency,'revision-bound');assert.equal(page.complete,true);assert.deepEqual(page.count,{status:'unknown',value:null,unit:'threads'});
 assert.equal((await f.search()).entries.length,1);assert.equal((await f.search('needle')).entries.length,1);assert.equal(f.refreshes,0);assert.equal(f.calls,0);assert.equal(f.hostOwner.database.prepare('SELECT total_changes() AS n').get()!.n,before);
 assert.equal(recordedNameQuery('😀'.repeat(512)).length,1024);assert.throws(()=>recordedNameQuery('😀'.repeat(513)));await assert.rejects(f.search(''),{code:'invalid_query'});await assert.rejects(f.search('Needle',null,f.human,'server','body'),{code:'invalid_field'});
});
test('private/shared, discover-only orchestration grant, human and final revocation',async t=>{
 const f=await fixture(t);f.warm();f.seed('private');f.access.created('server','private',f.human);f.access.set('server','private','private',1,f.human);assert.equal((await f.search('Needle',null,f.other)).entries.length,0);
 f.access.set('server','private','shared',2,f.human);f.service.orchestration.createThread({threadId:'private',serverId:'server',driverKind:'codex',ownerActorId:f.human.actorId,parentThreadId:null,lifecycleOwnerThreadId:null,forkedFromId:null,visibility:'visible',engineHostGeneration:null,nativeSessionId:null,runtimeStatus:'idle',rootTurnId:null,turnId:null,delegationRevision:1,autoExchangeDepth:0,hasDirectUserInput:false,userInputExcerpt:null});
 assert.equal((await f.search('Needle',null,f.other)).entries.length,0);f.actors.setGrant(f.other.actorId,'opencraft://conversation/v1/server/private','conversation.discover',true,'fixture');assert.equal((await f.search('Needle',null,f.other)).entries.length,1);assert.equal(f.actors.can(f.other,'opencraft://conversation/v1/server/private','conversation.read'),false);
 const readPort=f.port.threadSearch!;f.port.threadSearch=async(...args)=>{const page=await readPort(...args);if(args[1].kind==='validate')f.actors.setGrant(f.other.actorId,'opencraft://conversation/v1/server/private','conversation.discover',false,'fixture');return page;};
 await assert.rejects(f.search('Needle',null,f.other),{status:403});f.port.threadSearch=readPort;

 await assert.rejects(f.search('Needle',null,{...f.human,generation:f.human.generation+1}),{status:401});await assert.rejects(f.search('Needle',null,f.human,'wrong'),{status:404});
 const session=f.actors.createSession('Session','fixture'),credential=f.actors.issueCredential(session.id,Date.now()+60000,'fixture');await assert.rejects(f.search('Needle',null,f.actors.authenticateSession(credential.token)!),{status:403});
 await assert.rejects(f.service.command(f.human,{action:'threadSearch',serverId:'server',field:'name',query:'Needle',principal:{provider:'fake',subject:'fake'}}),{status:400});
 const original=f.port.threadSearch!;f.port.threadSearch=async(...args)=>{const page=await original(...args);if(args[1].kind==='validate')f.admitted=false;return page;};await assert.rejects(f.search(),{status:401});
});
test('11000 rows, denied windows, 30-result pages and cursor binding/change/tamper/restart',async t=>{
 const f=await fixture(t);f.warm();f.hostOwner.database.exec('BEGIN');for(let i=0;i<11000;i++){f.seed('row-'+i);if(i<1024){f.access.created('server','row-'+i,f.other);f.access.set('server','row-'+i,'private',1,f.other);}}f.hostOwner.database.exec('COMMIT');
 const first=await f.search();assert.equal(first.entries.length,0);assert.ok(first.nextCursor);assert.equal(first.complete,false);
 let page=first;const ids:string[]=[];while(page.nextCursor){page=await f.search('Needle',page.nextCursor);assert.ok(page.entries.length<=30);ids.push(...page.entries.map(x=>x.ref.threadId));}assert.equal(ids.length,9976);assert.equal(new Set(ids).size,ids.length);
 for(const [q,c] of [['other',f.human],['Needle',f.other]] as const)await assert.rejects(f.search(q,first.nextCursor,c),{code:'thread_search_cursor_invalid'});
 const bytes=Buffer.from(first.nextCursor!,'base64url');bytes[bytes.length-1]^=1;await assert.rejects(f.search('Needle',bytes.toString('base64url')),{code:'thread_search_cursor_invalid'});
 f.catalog.observe('thread/name/updated',{threadId:'row-2000',threadName:'Changed'});await assert.rejects(f.search('Needle',first.nextCursor),{code:'thread_search_changed'});
 const fresh=await f.search();f.reopenCatalog();await assert.rejects(f.search('Needle',fresh.nextCursor),{code:'thread_search_changed'});
 const current=await f.search();await f.reopenHub();await assert.rejects(f.search('Needle',current.nextCursor),{code:'thread_search_cursor_invalid'});assert.equal(f.refreshes,0);assert.equal(f.calls,0);
});
test('cold/bad/oversized source, changing sync and unsupported fail without refresh',async t=>{
 const f=await fixture(t);await assert.rejects(f.search(),{code:'thread_search_unavailable'});f.warm();f.seed('bad');
 for(const raw of ['bad',JSON.stringify({name:'x'.repeat(70000)}),JSON.stringify({name:'x'.repeat(4097)})]){f.hostOwner.database.prepare('UPDATE opencraft_thread_catalog SET metadata_json=?').run(raw);await assert.rejects(f.search(),{code:'thread_search_unavailable'});}
 f.hostOwner.database.prepare('UPDATE opencraft_thread_catalog SET metadata_json=?').run(JSON.stringify({name:'Needle'}));const original=f.port.threadSearch!;
 f.port.threadSearch=async(...args)=>{if(args[1].kind==='validate')f.hostOwner.database.prepare("UPDATE opencraft_catalog_sync SET state='syncing'").run();return original(...args);};await assert.rejects(f.search(),{code:'thread_search_changed'});
 f.port.threadSearch=async()=>{throw Object.assign(Error('Unsupported'),{code:'unsupported_capability'});};await assert.rejects(f.search(),{code:'unsupported_capability'});
 const error=classify({data:{code:'thread_search_unavailable',status:503}});assert.equal(error.code,'THREAD_SEARCH_UNAVAILABLE');assert.equal(error.retryable,false);assert.equal(f.refreshes,0);
});
test('slow source shares nine-second deadline and abort; slow ACL/row scan is bounded', {timeout:15000},async t=>{
 const keepAlive=setTimeout(()=>{},12000);t.after(()=>clearTimeout(keepAlive));
 const f=await fixture(t);f.warm();let aborted=false;
 f.port.threadSearch=async(_s,_req,_ctx,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));
 const began=performance.now();await assert.rejects(f.search(),{code:'thread_search_unavailable'});assert.ok(aborted);assert.ok(performance.now()-began>=8900&&performance.now()-began<12000);
 assert.equal(f.refreshes,0);assert.equal(f.calls,0);
});
for(const official of [false,true])test(`human SSH -> Hub discover-only -> real local Host17 directory; official=${official}`,{skip:official&&!process.env.OPENCRAFT_NAME_SEARCH_NATIVE,timeout:60000},async t=>{
 const {spawn}=await import('node:child_process'),{writeFile,mkdir}=await import('node:fs/promises'),{default:ssh2}=await import('ssh2');
 const {AppHostServer}=await import('../../packages/app-host-server/src/index'),{CodexEngineAdapter}=await import('../../apps/opencraft-daemon/src/codex-engine-adapter');
 const {ConversationHistoryTransport}=await import('../../packages/app-host-server/src/conversation-history-transport'),{ConversationHistory}=await import('../../packages/app-host-server/src/conversation-history');
 const {ThreadAccessSession}=await import('../../packages/access-control/src/thread-access');
 const {createSshHttpIngress}=await import('../../plugins/ssh-http-ingress/src/index.mjs'),{createSshNativeRpcGateway}=await import('../../scripts/ssh-native-rpc-gateway.mjs');
 const {createRoutedConversationExecution}=await import('../../scripts/conversation-execution.mjs'),{run}=await import('../../apps/opencraft-cli/src/main');
 const {DatabaseSync}=await import('node:sqlite');
 const f=await fixture(t),server='server:fixture:codex',home=join(f.root,'native-home');await mkdir(join(home,'sessions','2026','11','03'),{recursive:true});
 const rowsTotal=official?3:130;const ids=Array.from({length:rowsTotal},(_,i)=>official?`01a19a00-0000-7000-8000-${String(i+1).padStart(12,'0')}`:'name-'+i);
 if(official){
   const {readFile}=await import('node:fs/promises'),{createHash}=await import('node:crypto');assert.equal(createHash('sha256').update(await readFile(process.env.OPENCRAFT_NAME_SEARCH_NATIVE!)).digest('hex'),'628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1');
   await writeFile(join(home,'session_index.jsonl'),ids.map((id,i)=>JSON.stringify({id,thread_name:'Synthetic '+i,updated_at:'2026-11-03T00:00:00Z'})).join('\n')+'\n');
   for(const [i,id] of ids.entries()){
     const stamp='2026-11-03T00:00:00Z',rows=[{timestamp:stamp,type:'session_meta',payload:{id,timestamp:stamp,cwd:'/synthetic',originator:'codex_cli_rs',cli_version:'0.162.1',source:'cli',model_provider:'openai'}},{timestamp:stamp,type:'event_msg',payload:{type:'user_message',message:'Synthetic title '+i,images:[],local_images:[],text_elements:[]}}];
     await writeFile(join(home,'sessions','2026','11','03',`rollout-2026-11-03T00-00-00-${id}.jsonl`),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
   }
   // Fixture preparation only: Native's public read repairs its own synthetic state index.
   // The product directory uses state-only metadata and never performs this repair.
   const {createInterface}=await import('node:readline'),{once}=await import('node:events');
   const prep=spawn('unshare',['-n',process.env.OPENCRAFT_NAME_SEARCH_NATIVE!,'app-server'],{env:{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
   const lines=createInterface({input:prep.stdout});let n=0;const pending=new Map<number,(v:any)=>void>();
   lines.on('line',raw=>{try{const v=JSON.parse(raw);pending.get(v.id)?.(v);}catch{}});
   const rpc=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const id=++n,timer=setTimeout(()=>reject(Error('Synthetic Native preparation timeout')),10000);pending.set(id,v=>{clearTimeout(timer);pending.delete(id);v.error?reject(Error('Synthetic read failed')):resolve(v.result);});prep.stdin.write(JSON.stringify({id,method,params})+'\n');});
   try{await rpc('initialize',{clientInfo:{name:'synthetic-name-index',version:'1'},capabilities:{experimentalApi:true}});prep.stdin.write(JSON.stringify({method:'initialized'})+'\n');let cursor:string|null=null,total=0;do{const page=await rpc('thread/list',{limit:100,cursor,archived:false,useStateDbOnly:false,sourceKinds:['cli']});total+=page.data.length;cursor=page.nextCursor;}while(cursor);assert.equal(total,rowsTotal);}
   finally{lines.close();prep.kill();await once(prep,'exit');}
 }
 const nativeMethods:string[]=[];let host:any;
 const adapter=new CodexEngineAdapter({executable:official?process.env.OPENCRAFT_NAME_SEARCH_NATIVE!:process.execPath,runtimeDirectory:f.root,dataDirectory:join(f.root,'adapter'),nativeCodexHomeDirectory:home,upstreamBaseUrl:'http://127.0.0.1:9',fetch:async()=>{throw Error('No model HTTP');},
 spawnAppServer:({cwd,env})=>{const command=official?'unshare':process.execPath,args=official?['-n',process.env.OPENCRAFT_NAME_SEARCH_NATIVE!,'app-server']:[new URL('../fixtures/fake-codex-stdio-appserver.mjs',import.meta.url).pathname];
   const child=spawn(command,args,{cwd,env:official?{PATH:process.env.PATH,HOME:home,CODEX_HOME:home,LANG:'C.UTF-8'}:{...env,OPENCRAFT_TEST_NAME_DIRECTORY:'1'},stdio:['pipe','pipe','pipe']});
   const write=child.stdin.write.bind(child.stdin);child.stdin.write=((chunk:any,...args:any[])=>{try{nativeMethods.push(JSON.parse(String(chunk)).method);}catch{}return (write as any)(chunk,...args);}) as any;return child;},
 createMaintenanceClient:async()=>{throw Error('No maintenance');},logDiagnostic:()=>{},collaboration:{serverId:server,command:(c,b)=>f.service.command(c,b),authorize(){throw Error('No execution');},started(){throw Error('No execution');},tool:async()=>{throw Error('No tool');}}});
 let reconciliation:Promise<unknown>=Promise.resolve(),goals:Promise<unknown>=Promise.resolve();const reconcile=(adapter as any).reconcileExecutionLeases.bind(adapter),discover=(adapter as any).discoverActiveGoals.bind(adapter);t.mock.method(adapter as any,'reconcileExecutionLeases',()=>reconciliation=reconcile());t.mock.method(adapter as any,'discoverActiveGoals',()=>goals=discover());
 const history=new ConversationHistory(f.owner.database,'local-codex'),transport=new ConversationHistoryTransport(adapter,history);
 host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',hostDefinitions:[{hostId:'local-codex',label:'Codex'}],createTransport:()=>transport,
 createRpcAccessSession:(_id,c,emit)=>new ThreadAccessSession(f.access,()=>server,c.actorContext,emit,undefined,()=>c.resourceOwner?.assertCurrent())});
 Object.assign(f.port,createRoutedConversationExecution(()=>host,{machineId:'fixture',engines:[],getInputs:()=>null}));
 const hostKey=ssh2.utils.generateKeyPairSync('ed25519'),keys={one:ssh2.utils.generateKeyPairSync('ed25519'),two:ssh2.utils.generateKeyPairSync('ed25519')},gateways:any[]=[];
 const ingress=createSshHttpIngress({hostKey:hostKey.private,authorizedKeys:{legacy:[hostKey.public]},httpPort:1,codexPort:1,resolveAuthorizedKeys:(name:string)=>name in keys?[keys[name as keyof typeof keys].public]:[],authorizeSession:(name:string)=>{const c=name==='one'?f.human:f.other;return {submissionContext:{sender:{kind:'employee',loginName:'synthetic'},actorContext:c,validUntil:c.expiresAt,resourceOwner:{id:'fixture',assertCurrent(){if(!f.actors.isCurrent(c))throw Error('revoked');}}},isCurrent:()=>f.actors.isCurrent(c)};},createNativeSession:async(a:any)=>{const g=await createSshNativeRpcGateway(host,a);gateways.push(g);return g;}});
 const address=await ingress.listen({port:0});t.after(async()=>{await ingress.close();for(const g of gateways)await g.close();await host.close();});
 const sshConfig=join(f.root,'ssh_config'),known=join(f.root,'known_hosts'),config=join(f.root,'connections.json');let ssh='';
 for(const name of ['one','two'] as const){const path=join(f.root,name);await writeFile(path,keys[name].private,{mode:0o600});ssh+=`Host names-${name}\n  HostName 127.0.0.1\n  Port ${address.port}\n  User ${name}\n  IdentityFile ${path}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${known}\n`;}
 await writeFile(sshConfig,ssh);await writeFile(known,`[127.0.0.1]:${address.port} ${hostKey.public}\n`);await writeFile(config,JSON.stringify({schemaVersion:1,connections:Object.fromEntries(['one','two'].map(name=>[name,{sshAlias:'names-'+name,sshConfig,instanceId:'fixture'}]))}));
 const prior=process.env.OPENCRAFT_CONFIG;process.env.OPENCRAFT_CONFIG=config;t.after(()=>{if(prior===undefined)delete process.env.OPENCRAFT_CONFIG;else process.env.OPENCRAFT_CONFIG=prior;});
 const cli=(name:string,...args:string[])=>run(['thread','search','--server',server,'--field','name',official?'Synthetic':'Needle','--connection',name,...args]) as Promise<any>;
 // Warm the real local adapter normally; its independent lifecycle owns initial sync.
 await run(['server','list','--connection','one']);await (adapter as any).durableCatalog.settled();await reconciliation;await goals;
 assert.ok((adapter as any).durableCatalog);const same=(adapter as any).durableCatalog;
 const db=new DatabaseSync(join(f.root,'adapter','opencraft-host-state.sqlite'),{readOnly:true});t.after(()=>db.close());
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM opencraft_thread_catalog WHERE deleted=0').get()!.n,rowsTotal);assert.equal(db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get()!.n,17);
 f.access.created(server,ids[0],f.human);f.access.set(server,ids[0],'private',1,f.human);
 // Freeze history work to prove this stays on the control path, not a cold history lane.
 const revision=history.revision.bind(history);t.mock.method(history,'revision',((thread:string)=>thread===''?revision(thread):new Promise(()=>{})) as any);
 const before=nativeMethods.length,businessBefore=f.owner.database.prepare('SELECT COUNT(*) AS n FROM actor_execution_requests').get()!.n,changes=db.prepare('SELECT total_changes() AS n').get()!.n;
 const first=await cli('one');assert.equal(first.entries.length,Math.min(30,rowsTotal));assert.equal(!!first.nextCursor,rowsTotal>30);let page=first,seen=first.entries.length;while(page.nextCursor){page=await cli('one','--cursor',page.nextCursor);seen+=page.entries.length;}assert.equal(seen,rowsTotal);
 assert.ok(!(await cli('two')).entries.some((x:any)=>x.ref.threadId===ids[0]));if(first.nextCursor)await assert.rejects(cli('two','--cursor',first.nextCursor),(e:any)=>classify(e).code==='THREAD_SEARCH_CURSOR_INVALID');
 assert.equal((adapter as any).durableCatalog,same);assert.equal(f.owner.database.prepare('SELECT COUNT(*) AS n FROM actor_execution_requests').get()!.n,businessBefore);assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,changes);
 assert.deepEqual(nativeMethods.slice(before),[],'search itself does not initialize Native, list, read or start work');
 console.info('name-search-ssh-proof',JSON.stringify({official,humanActors:2,rows:rowsTotal,pages:Math.ceil(rowsTotal/30),localOwner:true,hostSchema:17,source:'host-thread-directory',searchNativeCalls:0,businessWrites:0,modelInputs:0}));
});
test('local streaming metadata sync yields across 11000 rows, is unique/idempotent, cancels on retirement',async t=>{
 const f=await fixture(t);f.catalog.close();let reads=0,heartbeats=0,cancelled=false;
 const port={streamingSync:true,incrementalScan:true,changed:()=>{},list:async(p:any,signal:AbortSignal)=>{reads++;signal.throwIfAborted();if(p.archived)return{data:[],nextCursor:null};const start=Number(p.cursor??0);return{data:Array.from({length:Math.min(200,11000-start)},(_,i)=>({id:'stream-'+(start+i),cwd:'/synthetic',name:'Needle',updatedAt:start+i+1,createdAt:1,ephemeral:false})),nextCursor:start+200<11000?String(start+200):null};}};
 const catalog=new ThreadDirectory(f.hostOwner.database,port);t.after(()=>catalog.close());
 const timer=setInterval(()=>heartbeats++,1);t.after(()=>clearInterval(timer));catalog.start();
 assert.throws(()=>catalog.searchNames({kind:'window',query:'Needle',cursor:null}),{code:'thread_search_unavailable'},'cold read never joins source hydration');await catalog.settled();assert.ok(heartbeats>0);assert.equal(reads,56);assert.equal(f.hostOwner.database.prepare('SELECT count(*) AS n FROM opencraft_thread_catalog WHERE deleted=0').get()!.n,11000);
 const snapshot=catalog.searchNames({kind:'window',query:'Needle',cursor:null});assert.equal(snapshot.entries.length,1024);const before=reads;catalog.searchNames({kind:'validate',cursor:snapshot.fence});assert.equal(reads,before);
 const plan=f.hostOwner.database.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM opencraft_thread_catalog NOT INDEXED WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 1024').all(0,1024);assert.ok(JSON.stringify(plan).includes('INTEGER PRIMARY KEY'));
 // The same owner's existing job is reused; close aborts outstanding pure metadata IO.
 catalog.close();const closing=new ThreadDirectory(f.hostOwner.database,{...port,list:(_p,signal)=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(signal.reason);},{once:true}))});const job=closing.refresh();assert.equal(closing.refresh(),job);closing.close();await job.catch(()=>{});assert.equal(cancelled,true);
});
test('old Hub/mode/Host and non-equivalent engine never fall back to Native search',async()=>{
 const {CollaborationClient}=await import('../../packages/appserver-client/src/collaboration'),{MemoryTransport}=await import('@opencraft/appserver-transport-memory');
 const {run}=await import('../../apps/opencraft-cli/src/main'),{callConversationHost,createConversationExecution}=await import('../../scripts/conversation-execution.mjs');
 for(const cap of [{version:1},{version:1,threadSearch:true,threadSearchMode:'other'}]){
  const methods:string[]=[],client=new CollaborationClient(new MemoryTransport({server:{receive(raw,peer){const m=JSON.parse(raw);if(m.id===undefined)return;methods.push(m.method);peer.send(JSON.stringify({id:m.id,result:{capabilities:{extensions:{'opencraft/collaboration':cap}}}}));}}}));
  await client.connect();await assert.rejects(client.threadSearch('s','query'),{code:'UNSUPPORTED_CAPABILITY'});await client.close();assert.deepEqual(methods,['initialize']);
 }
 for(const argv of [['thread','search','--server','s','--field','body','text'],['thread','search','--server','s','--field','name','x'.repeat(513)],['thread','search','--server','s','--field','name','text','--model','fake']])await assert.rejects(run(argv),{code:'INVALID_ARGUMENTS'});
 const {THREAD_SEARCH_METHOD}=await import('@opencraft/appserver-protocol/collaboration');let operations=0;
 const host={accept(port:any){let receive:any;const un=port.subscribe((m:any)=>{if(m.type==='hello')port.postMessage({type:'ready'});if(m.type==='host/connect')port.postMessage({type:'response',requestId:'connect',ok:true,result:{generation:1}});if(m.type==='host/send'){const frame=JSON.parse(m.frame);if(frame.method==='initialize')port.postMessage({type:'host/frame',hostId:'h',generation:1,frame:JSON.stringify({id:'init',result:{capabilities:{extensions:{}}}})});else operations++;}});return{close(){un();}};}};
 await assert.rejects(callConversationHost(host,{hostId:'h',threadId:''},'names',THREAD_SEARCH_METHOD,{kind:'window',query:'text',cursor:null}),{code:'unsupported_capability'});assert.equal(operations,0);
 const engine=createConversationExecution(()=>{throw Error('No Host');},{serverId:'s',hostId:'h',engine:'pi'});await assert.rejects(async()=>engine.threadSearch('s',{}, {},new AbortController().signal),{code:'unsupported_capability'});
});
test('owner budget and IO failures do not silently skip metadata or schedule hydration',async t=>{
 const f=await fixture(t);f.warm();f.seed('one');let time=0;
 t.mock.method(performance,'now',()=>{time+=101;return time;});assert.throws(()=>f.catalog.searchNames({kind:'window',query:'Needle',cursor:null}),{code:'thread_search_unavailable'});t.mock.restoreAll();
 const prepare=f.hostOwner.database.prepare.bind(f.hostOwner.database);t.mock.method(f.hostOwner.database,'prepare',(sql:string)=>{if(sql.includes('opencraft_thread_catalog'))throw Error('private IO reason');return prepare(sql);});await assert.rejects(f.search(),{code:'thread_search_unavailable'});assert.equal(f.refreshes,0);
});
