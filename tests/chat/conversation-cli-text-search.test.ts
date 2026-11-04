import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openServerDatabase} from '../../packages/storage-node/src/server';
import {ConversationHistory} from '../../packages/app-host-server/src/conversation-history';
import {ConversationHistoryWorker} from '../../packages/app-host-server/src/conversation-history-worker';
import {ActorStore} from '../../packages/access-control/src/actors';
import {ThreadAccessStore} from '../../packages/access-control/src/thread-access';
import {Collaboration,type ConversationExecutionPort} from '../../packages/access-control/src/collaboration';
import {publicTextQuery,PUBLIC_TEXT_SEARCH_MODE} from '@opencraft/appserver-protocol/collaboration';
import {classify} from '../../apps/opencraft-cli/src/errors';
type V=Record<string,any>;
const agent=(id:string,text:string,extra:V={})=>({id,type:'agentMessage',phase:'final_answer',text,...extra});
async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'public-text-')),owner=await openServerDatabase(root),history=new ConversationHistory(owner.database,'local-codex');
 const actors=new ActorStore(owner),human=actors.resolveHuman({provider:'fixture',subject:'one',displayName:'One',expiresAt:Date.now()+600000})!,other=actors.resolveHuman({provider:'fixture',subject:'two',displayName:'Two',expiresAt:Date.now()+600000})!;
 const access=new ThreadAccessStore(join(root,'access.sqlite'),actors),worker=new ConversationHistoryWorker(join(root,'opencraft-server.sqlite'));await worker.start();let portHistory=worker.create('local-codex');
 let calls=0,admitted=true;
 const forbidden=async()=>{calls++;throw Error('No execution');};
 const port:ConversationExecutionPort={serverId:'server',hostId:'local-codex',directory:()=>({instanceId:'i',servers:[{serverId:'server',label:'fixture',engine:'codex',connectionState:'ready',capabilities:{metadata:true,read:true,boundedRead:true,queue:true,steer:true,publicTextSearch:true}}]}),validate:forbidden,receipt:forbidden,add:forbidden,steer:forbidden,cancel:forbidden,
 publicTextSearch:async(_s,r,c,signal)=>{c.resourceOwner!.assertCurrent();const cancellation=new Int32Array(new SharedArrayBuffer(4));const abort=()=>Atomics.store(cancellation,0,1);signal.addEventListener('abort',abort,{once:true});try{return await portHistory.publicTextRead(r,{deadline:c.validUntil!,cancellation});}finally{signal.removeEventListener('abort',abort);}}};
 let service=new Collaboration(owner,actors,port,Date.now,()=>admitted,(c,r)=>access.allows(r.serverId,r.threadId,c));
 t.after(async()=>{await service.close();await worker.close();access.close();actors.close();await owner.close();await rm(root,{recursive:true,force:true});});
 const seed=(id:string,items:V[],extra:V={})=>history.importResult('thread/read',{threadId:id,includeTurns:true},{thread:{id,cwd:'/body-only',name:'name-only',preview:'preview-only',createdAt:1,updatedAt:1,ephemeral:false,...extra,turns:[{id:'turn',status:'completed',itemsView:'full',items}]}},history.revision(id));
 return{root,owner,history,actors,human,other,access,port,seed,get service(){return service;},get calls(){return calls;},set admitted(v:boolean){admitted=v;},
 async reopenHub(){await service.close();service=new Collaboration(owner,actors,port,Date.now,()=>admitted,(c,r)=>access.allows(r.serverId,r.threadId,c));},
 async reopenReader(){await portHistory.close?.();portHistory=worker.create('local-codex');},
 search:(query='needle',cursor:string|null=null,c=human,server='server')=>service.publicTextSearch(c,server,query,cursor)};
}
test('public-text policy on real History worker: phase, hidden payload, Unicode and read-only',async t=>{
 const f=await fixture(t);f.seed('one',[agent('a','Needle café 数据库 alpha beta 😀',{stdout:'hiddenstdout',description:'hiddendescription'}),agent('b','commentaryneedle',{phase:'commentary'}),agent('c','unknownphase',{phase:'future'}),{id:'u',type:'userMessage',text:'usertop',content:[{type:'text',text:'userfirst'},{type:'text',text:'usersecond'},{type:'image',description:'hiddenattachment'}]},{id:'tool',type:'commandExecution',command:'toolcommand',stdout:'toolstdout',stderr:'toolstderr',diff:'tooldiff'}, {id:'image',type:'imageGeneration',revisedPrompt:'imageprompt'},{id:'activity',type:'agentActivity',text:'notassistant'}]);
 const before=f.owner.database.prepare('SELECT total_changes() AS n').get()!.n;
 for(const q of ['hiddenstdout','hiddendescription','usertop','hiddenattachment','toolcommand','toolstdout','toolstderr','tooldiff','imageprompt','preview-only','name-only','notassistant'])assert.equal((await f.search(q)).entries.length,0,q);
 for(const q of ['needle','cafe','数据库','beta alpha','commentaryneedle','unknownphase','userfirst usersecond'])assert.equal((await f.search(q)).entries.length,1,q);
 assert.equal((await f.search('eedle')).entries.length,0);await assert.rejects(f.search('😀'),{code:'invalid_query'});assert.equal(publicTextQuery('𐐀'.repeat(512)).length,1024);assert.throws(()=>publicTextQuery('𐐀'.repeat(513)));
 const page=await f.search();assert.equal(page.mode,PUBLIC_TEXT_SEARCH_MODE);assert.equal(page.coverage,'indexed-recorded-only');assert.deepEqual(page.count,{unit:'items',status:'unknown',value:null});assert.equal(page.entries[0].snippet.includes('hidden'),false);assert.deepEqual(Object.keys(page.entries[0]).sort(),['itemId','ref','role','snippet','turnId']);assert.equal(f.calls,0);assert.equal(f.owner.database.prepare('SELECT total_changes() AS n').get()!.n,before);
});
test('raw code point limit survives NFKD expansion; authenticated cursors stay bounded',async t=>{
 const f=await fixture(t),hangul='각'.repeat(200),expanded='ﷺ'.repeat(512);
 f.seed('hangul',[agent('a',hangul)]);assert.equal((await f.search(hangul)).entries.length,1);
 for(let i=0;i<140;i++)f.seed('row-'+i,[agent('a',expanded)]);
 const first=await f.search(expanded);assert.ok(first.nextCursor);assert.ok(first.nextCursor.length<8192);
 const next=await f.search(expanded,first.nextCursor);assert.ok(next.entries.length>0);
});
test('human/private/shared/orchestration read grant and final revocation',async t=>{
 const f=await fixture(t);f.seed('private',[agent('a','needle')]);f.access.created('server','private',f.human);f.access.set('server','private','private',1,f.human);
 assert.equal((await f.search('needle',null,f.other)).entries.length,0);f.access.set('server','private','shared',2,f.human);
 f.service.orchestration.createThread({threadId:'private',serverId:'server',driverKind:'codex',ownerActorId:f.human.actorId,parentThreadId:null,lifecycleOwnerThreadId:null,forkedFromId:null,visibility:'visible',engineHostGeneration:null,nativeSessionId:null,runtimeStatus:'idle',rootTurnId:null,turnId:null,delegationRevision:1,autoExchangeDepth:0,hasDirectUserInput:false,userInputExcerpt:null});
 f.actors.setGrant(f.other.actorId,'opencraft://conversation/v1/server/private','conversation.discover',true,f.human.actorId);
 assert.equal((await f.search('needle',null,f.other)).entries.length,0,'discover-only excludes body');
 f.actors.setGrant(f.other.actorId,'opencraft://conversation/v1/server/private','conversation.read',true,f.human.actorId);assert.equal((await f.search('needle',null,f.other)).entries.length,1);
 const original=f.port.publicTextSearch!;f.port.publicTextSearch=async(...args)=>{const r=await original(...args);if(args[1].kind==='validate')f.admitted=false;return r;};await assert.rejects(f.search(),{code:'actor_authentication_required'});
 f.admitted=true;await assert.rejects(f.search('needle',null,{...f.human,generation:999}),{code:'actor_authentication_required'});await assert.rejects(f.search('needle',null,f.human,'other'),{code:'conversation_action_denied'});
});
test('130+ Items, cross-scope/denied empty windows, stable traversal and authenticated bindings',async t=>{
 const f=await fixture(t),peer=new ConversationHistory(f.owner.database,'peer');
 peer.importResult('thread/read',{threadId:'peer',includeTurns:true},{thread:{id:'peer',cwd:'/synthetic',createdAt:1,updatedAt:1,ephemeral:false,turns:[{id:'turn',status:'completed',itemsView:'full',items:Array.from({length:130},(_,i)=>agent('p-'+i,'needle'))}]}},peer.revision('peer'));
 f.owner.database.exec('BEGIN');
 for(let i=0;i<140;i++)f.seed('row-'+i,[agent('a','needle'),agent('b','needle')]);f.owner.database.exec('COMMIT');
 let page=await f.search(),first=page;assert.equal(page.entries.length,0);assert.ok(page.nextCursor);const ids:string[]=[];let pages=1;
 while(page.nextCursor){page=await f.search('needle',page.nextCursor);ids.push(...page.entries.map(x=>x.ref.threadId+':'+x.itemId));assert.ok(page.entries.length<=30);assert.ok(++pages<100);}assert.equal(ids.length,280);assert.equal(new Set(ids).size,280);
 for(const [q,c] of [['other',f.human],['needle',f.other]] as const)await assert.rejects(f.search(q,first.nextCursor,c),{code:'text_search_cursor_invalid'});
 await assert.rejects(f.search('needle',first.nextCursor!.slice(0,-4)+'AAAA'),{code:'text_search_cursor_invalid'});
 f.history.observe('item/completed',{threadId:'row-0',turnId:'turn',item:agent('a','changed')});await assert.rejects(f.search('needle',first.nextCursor),{code:'text_search_changed'});
 const fresh=await f.search();await f.reopenHub();await assert.rejects(f.search('needle',fresh.nextCursor),{code:'text_search_cursor_invalid'});
});
test('partial visibility, oversized, corrupt payload, cold model: never revive or implicitly repair',async t=>{
 const f=await fixture(t);await assert.rejects(f.search(),{code:'text_search_unknown'});f.seed('one',[agent('a','oldneedle')]);
 f.history.importResult('thread/turns/list',{threadId:'one',cursor:null,limit:1,itemsView:'full'},{data:[{id:'new',status:'completed',itemsView:'full',items:[agent('b','newneedle')]}],nextCursor:'older'},f.history.revision('one'));
 assert.equal((await f.search('oldneedle')).entries.length,0);assert.equal((await f.search('newneedle')).entries.length,1);
 f.seed('huge',[agent('a','needle '+'x'.repeat(300000))]);await assert.rejects(f.search(),{code:'text_search_unavailable'});
 f.history.searchIndex.remove('huge');const hash=f.owner.database.prepare("SELECT hash FROM conversation_events WHERE scope='local-codex' AND thread_id='one' AND type='agentMessage' AND current=1 ORDER BY revision DESC LIMIT 1").get()!.hash;
 f.owner.database.prepare("UPDATE conversation_payloads SET body='bad' WHERE scope='local-codex' AND hash=?").run(hash);await assert.rejects(f.search(),{code:'text_search_unavailable'});
 assert.equal(f.calls,0);assert.equal(classify({data:{code:'text_search_unavailable',status:503}}).retryable,false);
});
test('deadline/cancel before IO; total body budget; fixed PK cost under a 10000-row foreign scope',async t=>{
 const f=await fixture(t),control={deadline:Date.now()+5000,cancellation:new Int32Array(new SharedArrayBuffer(4))};
 f.seed('one',[agent('a','needle')]);const prepare=f.owner.database.prepare.bind(f.owner.database);let queried=0;
 t.mock.method(f.owner.database,'prepare',(sql:string)=>{queried++;return prepare(sql);});Atomics.store(control.cancellation,0,1);
 await assert.rejects(f.history.publicTextRead({kind:'window',cursor:null},control),{code:'text_search_unavailable'});assert.equal(queried,0);t.mock.restoreAll();
 const peer=new ConversationHistory(f.owner.database,'peer');peer.importResult('thread/read',{threadId:'bulk',includeTurns:true},{thread:{id:'bulk',cwd:'/synthetic',createdAt:1,updatedAt:1,ephemeral:false,turns:[{id:'turn',status:'completed',itemsView:'full',items:[]}]}},peer.revision('bulk'));
 f.owner.database.exec('BEGIN');for(let i=0;i<10000;i++)peer.searchIndex.put('bulk','cost-'+i,1,agent('a','needle'));f.owner.database.exec('COMMIT');
 const before=f.owner.database.prepare('SELECT total_changes() AS n').get()!.n,window=await f.history.publicTextRead({kind:'window',cursor:null},{deadline:Date.now()+1000});assert.equal(window.fence.position,128);assert.ok(window.candidates.length<=128);
 const plan=f.owner.database.prepare('EXPLAIN QUERY PLAN SELECT id FROM conversation_search_documents WHERE id>? AND id<=? ORDER BY id LIMIT 128').all(0,128);assert.match(JSON.stringify(plan),/INTEGER PRIMARY KEY/);
 assert.equal(f.owner.database.prepare('SELECT total_changes() AS n').get()!.n,before);
 console.info('public-text-cost-proof',JSON.stringify({syntheticForeignDocs:10000,windowWidth:128,candidates:window.candidates.length,plan:plan.map(x=>x.detail),nativeCalls:f.calls}));
 // Authorized nonmatching bodies consume the same page byte budget as matching ones.
 const fresh=new ConversationHistory(f.owner.database,'budget');fresh.importResult('thread/read',{threadId:'b',includeTurns:true},{thread:{id:'b',cwd:'/synthetic',createdAt:1,updatedAt:1,ephemeral:false,turns:[{id:'t',status:'completed',itemsView:'full',items:Array.from({length:36},(_,i)=>agent('i'+i,'x'.repeat(250000)))}]}},fresh.revision('b'));
 const first=await fresh.publicTextRead({kind:'window',cursor:null},{deadline:Date.now()+5000}); // Early foreign windows are intentionally empty.
 const w=await fresh.publicTextRead({kind:'window',cursor:{...first.fence,position:first.fence.upper-37}},{deadline:Date.now()+5000});
 await assert.rejects(fresh.publicTextRead({kind:'project',cursor:{...w.fence,position:w.fence.upper-37},positions:w.candidates.map(x=>x.position),query:'missing'}, {deadline:Date.now()+5000}),{code:'text_search_unavailable'});
});
test('old Hub/Host/mode, non-equivalent engines, forged fields and Session fail closed',async t=>{
 const f=await fixture(t);f.seed('one',[agent('a','needle')]);
 await assert.rejects(f.service.command(f.human,{action:'publicTextSearch',serverId:'server',query:'needle',principal:{actorId:f.human.actorId}}),(e:any)=>e.status===400);
 const session=f.actors.createSession('synthetic session',f.human.actorId),credential=f.actors.issueCredential(session.id,Date.now()+300000,f.human.actorId),context=f.actors.authenticateSession(credential.token)!;
 await assert.rejects(f.search('needle',null,context),{code:'conversation_action_denied'});
 const {createConversationExecution,callConversationHost}=await import('../../scripts/conversation-execution.mjs');
 const engine=createConversationExecution(()=>{throw Error('No Host');},{serverId:'s',hostId:'h',engine:'pi'});await assert.rejects(async()=>engine.publicTextSearch('s',{}, {},new AbortController().signal),{code:'unsupported_capability'});
 const {CollaborationClient}=await import('../../packages/appserver-client/src/collaboration'),{MemoryTransport}=await import('@opencraft/appserver-transport-memory');
 for(const cap of [{version:1},{version:1,publicTextSearch:true,publicTextSearchMode:'other'}]){const methods:string[]=[],client=new CollaborationClient(new MemoryTransport({server:{receive(raw,peer){const m=JSON.parse(raw);if(m.id===undefined)return;methods.push(m.method);peer.send(JSON.stringify({id:m.id,result:{capabilities:{extensions:{'opencraft/collaboration':cap}}}}));}}}));await client.connect();await assert.rejects(client.publicTextSearch('s','needle'),{code:'UNSUPPORTED_CAPABILITY'});await client.close();assert.deepEqual(methods,['initialize']);}
 const {PUBLIC_TEXT_SEARCH_METHOD}=await import('@opencraft/appserver-protocol/collaboration');let operations=0;
 const host={accept(port:any){const un=port.subscribe((m:any)=>{if(m.type==='hello')port.postMessage({type:'ready'});if(m.type==='host/connect')port.postMessage({type:'response',requestId:'connect',ok:true,result:{generation:1}});if(m.type==='host/send'){const frame=JSON.parse(m.frame);if(frame.method==='initialize')port.postMessage({type:'host/frame',hostId:'h',generation:1,frame:JSON.stringify({id:'init',result:{capabilities:{extensions:{}}}})});else operations++;}});return{close(){un();}};}};
 await assert.rejects(callConversationHost(host,{hostId:'h',threadId:''},'text',PUBLIC_TEXT_SEARCH_METHOD,{kind:'window',cursor:null}),{code:'unsupported_capability'});assert.equal(operations,0);
});
test('real History transport: trusted context, asynchronous cancellation, control lane and source lifetime fence',async t=>{
 const f=await fixture(t);f.seed('one',[agent('a','needle')]);
 const {ConversationHistoryTransport}=await import('../../packages/app-host-server/src/conversation-history-transport');
 const {PUBLIC_TEXT_SEARCH_METHOD}=await import('@opencraft/appserver-protocol/collaboration');
 const messages=new Set<(s:string)=>void>(),statuses=new Set<(s:any)=>void>();let native=0;
 const inner:any={status:{state:'open'},connect(){},send(){native++;throw Error('No Native calls');},sendWithContext(){native++;throw Error('No Native calls');},close(){},subscribeMessage(f:(s:string)=>void){messages.add(f);return()=>messages.delete(f);},subscribeStatus(f:(s:any)=>void){statuses.add(f);return()=>statuses.delete(f);}};
 const transport=new ConversationHistoryTransport(inner,f.history),frames:V[]=[];transport.subscribeMessage(raw=>frames.push(JSON.parse(raw)));t.after(()=>transport.close());
 const trusted:any={sender:null,actorContext:f.human,collaborationRequestId:'thread-text-search',resourceOwner:{id:'fixture',assertCurrent(){}},validUntil:Date.now()+9000};
 const send=(id:string,method:string,params:V={},context=trusted,signal?:AbortSignal)=>transport.sendWithContext(JSON.stringify({id,method,params}),context,signal);
 await transport.connect();await send('init','initialize');await send('window',PUBLIC_TEXT_SEARCH_METHOD,{kind:'window',cursor:null});const window=frames.find(x=>x.id==='window').result;
 await send('forged',PUBLIC_TEXT_SEARCH_METHOD,{kind:'window',cursor:null},{...trusted,actorContext:undefined});assert.equal(frames.find(x=>x.id==='forged').error.data.code,'text_search_unavailable');
 const original=f.history.publicTextRead.bind(f.history);let release!:()=>void,entered!:()=>void;const inRead=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let cancellation:Int32Array|undefined;
 t.mock.method(f.history,'publicTextRead',async(r,c)=>{cancellation=c.cancellation;entered();await gate;return original(r,c);});
 const controller=new AbortController(),pending=send('slow',PUBLIC_TEXT_SEARCH_METHOD,{kind:'window',cursor:null},trusted,controller.signal);await inRead;
 await send('control','initialize');assert.ok(frames.find(x=>x.id==='control').result,'control reply while history read pending');controller.abort();assert.equal(Atomics.load(cancellation!,0),1);release();await pending;
 assert.equal(frames.find(x=>x.id==='slow').error.data.code,'text_search_unavailable');t.mock.restoreAll();
 for(const status of statuses)status({state:'failed'});await transport.connect();
 await send('old',PUBLIC_TEXT_SEARCH_METHOD,{kind:'validate',cursor:window.fence});assert.equal(frames.find(x=>x.id==='old').error.data.code,'text_search_changed');assert.equal(native,0);
});
test('old model, malformed coverage and oversized identity never trigger implicit preparation',async t=>{
 const f=await fixture(t);f.seed('one',[agent('a','needle')]);
 const set=f.owner.database.prepare("UPDATE conversation_threads SET model_version=? WHERE scope='local-codex'");set.run(1);
 const before=f.owner.database.prepare('SELECT total_changes() AS n').get()!.n;await assert.rejects(f.search(),{code:'text_search_unavailable'});assert.equal(f.owner.database.prepare('SELECT total_changes() AS n').get()!.n,before);set.run(2);
 f.owner.database.prepare("UPDATE conversation_threads SET history=? WHERE scope='local-codex'").run(JSON.stringify({state:'complete',visible:'untrusted'}));await assert.rejects(f.search(),{code:'text_search_unavailable'});
 f.seed('one',[agent('a','needle')]); // prepare a fresh, valid source through its original fixture owner.
 f.owner.database.prepare("UPDATE conversation_search_documents SET item_id=? WHERE scope='local-codex' AND record_id<>'thread/metadata'").run('x'.repeat(5000));await assert.rejects(f.search(),{code:'text_search_unavailable'});
});
test('nine-second total deadline cancels an asynchronous source instead of replaying input',{timeout:12000},async t=>{
 const f=await fixture(t);f.seed('one',[agent('a','needle')]);let aborted=false;
 f.port.publicTextSearch=async(_s,_r,_c,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));
 const keep=setTimeout(()=>{},11000);t.after(()=>clearTimeout(keep));const start=Date.now();await assert.rejects(f.search(),{code:'text_search_unavailable'});assert.ok(aborted);assert.ok(Date.now()-start>=8900&&Date.now()-start<11000);assert.equal(f.calls,0);
});
test('10000 same-scope private documents authorize only one PK window; denied candidates never enter payload projection',async t=>{
 const f=await fixture(t);f.seed('denied',[]);f.access.created('server','denied',f.other);f.access.set('server','denied','private',1,f.other);
 f.owner.database.exec('BEGIN');for(let i=0;i<10000;i++)f.history.searchIndex.put('denied','cost-'+i,1,agent('a','needle'));f.owner.database.exec('COMMIT');
 const original=f.port.publicTextSearch!;let candidates=0,allowed=-1;
 f.port.publicTextSearch=async(...args)=>{const result=await original(...args);if(args[1].kind==='window')candidates=result.candidates.length;if(args[1].kind==='project')allowed=args[1].positions.length;return result;};
 const page=await f.search();assert.equal(page.entries.length,0);assert.ok(page.nextCursor);assert.equal(candidates,128);assert.equal(allowed,0);assert.equal(f.calls,0);
});
