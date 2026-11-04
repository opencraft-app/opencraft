import assert from 'node:assert/strict';
import test from 'node:test';
import { readConversationPage, projectConversationMetadata } from '../../scripts/conversation-projections.mjs';
import { CollaborationClient } from '../../packages/appserver-client/src/collaboration';
import { MemoryTransport } from '@opencraft/appserver-transport-memory';
import { encodeJsonRpcMessage, isJsonRpcRequest } from '@opencraft/appserver-protocol';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRoutedConversationExecution } from '../../scripts/conversation-execution.mjs';

test('metadata is an allowlisted server projection without title fallback or message content', () => {
  const result = projectConversationMetadata('server', { id: 'thread', name: 'sensitive-title', preview: 'sensitive-preview',
    turns: [{ items: [{ text: 'sensitive-message' }] }], status: { type: 'idle' }, cwd: '/repo', projectId: null });
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
  assert.equal(result.cwd, '/repo'); assert.equal(result.runtime, 'idle');
  assert.equal(projectConversationMetadata('server', { id: 't', preview: 'body' }, true).title, undefined);
});

test('history pages bound native reads, preserve Unicode long-message tails and fence watermarks', async () => {
  const ref = { serverId: 's', threadId: 't' }, content = '🦉'.repeat(4501);
  let revision = 1;
  const calls: any[] = [];
  const invoke = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/read') { assert.equal(params.includeTurns, false); return { thread: { id: 't', updatedAt: revision } }; }
    assert.equal(method, 'thread/items/list'); assert.equal(params.limit, 1);
    return { data: [{ turnId: 'turn', item: { type: 'agentMessage', id: 'item', text: content } }], nextCursor: null };
  };
  let cursor: string | null = null, text = '';
  do {
    const page = await readConversationPage(invoke, ref, cursor);
    assert.ok(Array.from(page.entries[0].text).length <= 2000);
    text += page.entries[0].text; cursor = page.nextCursor;
  } while (cursor);
  assert.equal(text, content);
  const page = await readConversationPage(invoke, ref, null);
  revision++;
  await assert.rejects(readConversationPage(invoke, ref, page.nextCursor), { code: 'history_changed' });
  assert.ok(calls.length > 0);
});

test('old Host capabilities fail before issuing content reads or mutations', async () => {
  const methods: string[] = [];
  const transport = new MemoryTransport({ server: { receive(frame, peer) {
    const message = JSON.parse(frame);
    if (!isJsonRpcRequest(message)) return;
    methods.push(message.method);
    if (message.method === 'initialize') peer.send(encodeJsonRpcMessage({ id: message.id, result: { codexHome: '/synthetic', platformFamily: 'unix', platformOs: 'linux', userAgent: 'fixture', capabilities: { extensions: { 'opencraft/collaboration': { version: 1, read: true, boundedRead: true } } } } }));
  } } });
  const client = new CollaborationClient(transport);
  try {
    await client.connect();
    await assert.rejects(client.metadata({ serverId: 's', threadId: 't' }), { code: 'UNSUPPORTED_CAPABILITY' });
    await assert.rejects(client.tail({ serverId: 's', threadId: 't' }, 1), { code: 'UNSUPPORTED_CAPABILITY' });
    assert.throws(() => client.discover('s', undefined, false, { projectId: 'p' }), { code: 'UNSUPPORTED_CAPABILITY' });
    assert.deepEqual(methods, ['initialize']);
  } finally { await client.close(); }
});

test('unsupported engines reject bounded logs before any native history read', () => {
  let opened = 0;
  const execution = createRoutedConversationExecution(() => ({hostState: () => 'idle', accept() { opened++; throw Error('must not open'); }}),
    {machineId:'fixture',engines:['dsh'],getInputs:async()=>undefined});
  const server = execution.directory().servers.find((row: any) => row.engine === 'dsh');
  assert.equal(server.capabilities.exactResult, false);
  assert.throws(()=>execution.exactResult({serverId:server.serverId,threadId:'legacy-dsh'},'target',true,null),{code:'unsupported_capability'});
  assert.equal(server.capabilities.tailRead, false);
  assert.throws(() => execution.readTail({serverId:server.serverId,threadId:'legacy-dsh'},1), {code:'unsupported_capability'});
  assert.equal(server.capabilities.read, false); assert.equal(server.capabilities.boundedRead, false);
  assert.throws(() => execution.readBounded({serverId:server.serverId,threadId:'legacy-dsh'},null), {code:'unsupported_capability'});
  assert.equal(opened,0);
});

test('CLI help and invalid arguments return one versioned JSON value with stable exit codes', async () => {
  const invoke = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx',
    fileURLToPath(new URL('../../apps/opencraft-cli/src/main.ts', import.meta.url)), ...args, '--json']);
  const help = JSON.parse((await invoke('--help')).stdout);
  assert.equal(help.schemaVersion, 1); assert.equal(help.ok, true);
  for (const args of [['unknown'], ['thread','show'], ['thread','show','ref','--cursor','bad'], ['thread','log','ref','--tail','0'], ['thread','log','ref','--tail','6'], ['thread','log','ref','--tail','1','--cursor','old'], ['thread','show','ref','--tail','1']]) {
    await assert.rejects(invoke(...args), (error: any) => {
      assert.equal(error.code, 2); const output = JSON.parse(error.stdout);
      assert.equal(output.ok, false); assert.equal(output.error.code, args[0] === 'unknown' ? 'UNKNOWN_COMMAND' : 'INVALID_ARGUMENTS');
      return true;
    });
  }
});

test('live append invalidates forward cursors but bounded tail observes latest partial Turn without global fencing', async () => {
  const ref = {serverId:'s',threadId:'t'};
  let revision=1;
  const calls:any[]=[];
  const invoke=async(method:string,params:any)=>{
    calls.push({method,params});
    if(method==='thread/read')return {thread:{id:'t',updatedAt:revision}};
    if(method==='thread/turns/list')return {data:[{id:'live',items:[],itemsView:'notLoaded'}],nextCursor:'older-turn'};
    const desc=params.sortDirection==='desc';
    return {data:[{turnId:'live',item:{id:desc?'reply':'old',type:'agentMessage',text:desc?'x'.repeat(4000)+`MARKER-${revision}`:'earliest'.repeat(1000)}}],nextCursor:'older-item'};
  };
  const forward=await readConversationPage(invoke,ref,null);
  revision++;
  await assert.rejects(readConversationPage(invoke,ref,forward.nextCursor),{code:'history_changed'});
  const {readConversationTail}=await import('../../scripts/conversation-projections.mjs');
  calls.length=0;
  const tail=await readConversationTail(invoke,ref,1);
  assert.ok(tail.entries.at(-1).text.endsWith('MARKER-2'));
  assert.ok(Array.from(tail.entries[0].text).length<=2000);
  assert.equal(tail.entries[0].partial,true);
  assert.equal(tail.nextCursor,null);
  assert.equal(tail.truncated,true);
  assert.deepEqual(calls.map(c=>c.method),['thread/read','thread/turns/list','thread/items/list']);
  assert.equal(calls[1].params.limit,1);assert.equal(calls[2].params.limit,30);
  assert.ok(calls.slice(1).every(c=>c.params.sortDirection==='desc'));
  revision++;
  assert.ok((await readConversationTail(invoke,ref,1)).entries.at(-1).text.endsWith('MARKER-3'));
});

test('tail bounds bytes, preserves message order, omits tools and stops on cancellation', async () => {
  const {readConversationTail}=await import('../../scripts/conversation-projections.mjs');
  const ref={serverId:'s',threadId:'t'};
  const page=await readConversationTail(async(method:string,params:any)=>method==='thread/read'?{thread:{id:'t'}}:method==='thread/turns/list'
    ? {data:[{id:'new'},{id:'old'}],nextCursor:null}
    : {data:[{turnId:params.turnId,item:{id:params.turnId+'a',type:'agentMessage',text:'answer'}},
      {turnId:params.turnId,item:{id:'tool',type:'commandExecution',output:'private tool'}},
      {turnId:params.turnId,item:{id:params.turnId+'u',type:'userMessage',content:[{type:'text',text:'question'}]}}],nextCursor:null},ref,2);
  assert.deepEqual(page.entries.map((e:any)=>[e.turnId,e.role]),[['old','user'],['old','assistant'],['new','user'],['new','assistant']]);
  assert.equal(page.truncated,false);
  let calls=0;
  const budget=await readConversationTail(async(method:string)=>{
    calls++;
    if(method==='thread/read')return {thread:{id:'t'}};
    if(method==='thread/turns/list')return {data:[{id:'t'},{id:'older'}],nextCursor:null};
    return {data:Array.from({length:30},(_,i)=>({turnId:'t',item:{id:String(i),type:'agentMessage',text:'🦉'.repeat(4000)}})),nextCursor:null};
  },ref,2);
  assert.ok(Buffer.byteLength(JSON.stringify(budget.entries))<24000);assert.equal(calls,3);
  assert.equal(budget.truncated,true);assert.deepEqual(budget.partialTurnIds,['t']);
  const controller=new AbortController();calls=0;
  await assert.rejects(readConversationTail(async()=>{calls++;controller.abort();return {data:[{id:'t'}]};},ref,1,controller.signal),{name:'AbortError'});
  assert.equal(calls,1);
});

test('real CLI run forwards tail through negotiated client and rejects old Servers', async t => {
  const {run}=await import('../../apps/opencraft-cli/src/main');
  const {CliSshTransport}=await import('../../apps/opencraft-cli/src/ssh');
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const {join}=await import('node:path');
  const {tmpdir}=await import('node:os');
  const root=await mkdtemp(join(tmpdir(),'cli-tail-')), prior=process.env.OPENCRAFT_CONFIG;
  t.after(async()=>{if(prior===undefined)delete process.env.OPENCRAFT_CONFIG;else process.env.OPENCRAFT_CONFIG=prior;await rm(root,{recursive:true,force:true});});
  process.env.OPENCRAFT_CONFIG=join(root,'connections.json');
  await writeFile(process.env.OPENCRAFT_CONFIG,JSON.stringify({schemaVersion:1,defaultConnection:'test',connections:{test:{sshAlias:'fixture',instanceId:'i'}}}));
  let capable=true,found=true;const requests:any[]=[];
  t.mock.method(CliSshTransport.prototype,'connect',async function(this:any){this.update({state:'open'});});
  t.mock.method(CliSshTransport.prototype,'send',async function(this:any,frame:string){
    const msg=JSON.parse(frame);if(msg.id===undefined)return;
    requests.push(msg);
    const result=msg.method==='initialize'?{capabilities:{extensions:{'opencraft/collaboration':{version:1,servers:true,boundedRead:true,tailRead:capable,metadata:true,metadataDiscovery:true,lookup:true,queue:true}}}}
      :msg.params.action==='servers'?{instanceId:'i',actor:{id:'a',kind:'human',generation:1},servers:[{serverId:'s',capabilities:{boundedRead:true,tailRead:capable,queue:true}}]}
      :msg.params.action==='discover'?{conversations:[{ref:{serverId:'s',threadId:'t'},attention:null,...(msg.params.includeTitle?{title:'中文 & title'}:{})}],nextCursor:null}
      :msg.params.action==='metadata'?{ref:msg.params.reference,attention:null}
      :msg.params.action==='lookup'?found?{found:true,receipt:{ref:msg.params.reference}}:{found:false,ref:msg.params.reference,deliveryState:'unknown'}
      :msg.params.action==='send'?{messageId:'m',requestId:'r',replayed:false}
      :{ref:msg.params.reference,history:{entries:[{text:'TAIL-RUN'}]}};
    for(const listener of this.messages)listener(JSON.stringify({id:msg.id,result}));
  });
  const result=await run(['thread','log','opencraft://conversation/v1/s/t','--tail','2','--json']) as any;
  assert.equal(result.history.entries[0].text,'TAIL-RUN');
  assert.deepEqual(requests.at(-1).params,{action:'read',reference:{serverId:'s',threadId:'t'},bounded:true,tail:2});
  // Enable a UI base, then feed returned links back through real CLI parsing.
  const config=JSON.parse(await (await import('node:fs/promises')).readFile(process.env.OPENCRAFT_CONFIG!,'utf8'));
  config.connections.test.webUrl='https://example.test/base/';await writeFile(process.env.OPENCRAFT_CONFIG!,JSON.stringify(config));
  const shown=await run(['thread','show','opencraft://conversation/v1/s/t']) as any;assert.ok(shown.uiLink);
  const again=await run(['thread','show',shown.uiLink]) as any;assert.deepEqual(again.ref,{serverId:'s',threadId:'t'});
  const sent=await run(['thread','send',shown.uiLink,'synthetic','--key','k']) as any;assert.equal(sent.uiLink,shown.uiLink);
  const listed=await run(['thread','list']) as any;assert.ok(listed.conversations[0].uiLink);assert.equal(new URL(listed.conversations[0].uiLink).searchParams.has('title'),false);
  const titled=await run(['thread','list','--include-title']) as any;assert.equal(new URL(titled.conversations[0].uiLink).searchParams.get('title'),'中文 & title');
  const lookup=await run(['thread','lookup',shown.uiLink,'--key','k']) as any;assert.equal(lookup.uiLink,shown.uiLink);
  found=false;const missing=await run(['thread','lookup',shown.uiLink,'--key','missing']) as any;assert.equal(missing.uiLink,null);assert.equal(missing.deliveryState,'unknown');
  capable=false;requests.length=0;
  await assert.rejects(run(['thread','log','opencraft://conversation/v1/s/t','--tail','1']),{code:'UNSUPPORTED_CAPABILITY'});
  assert.equal(requests.some(r=>r.params?.action==='read'),false);
});

test('tail shared deadline closes the owned Host lane during a blocked native read', async () => {
  const {callConversationHost}=await import('../../scripts/conversation-execution.mjs');
  const controller=new AbortController();let closed=0;
  const host={accept(endpoint:any){
    const unsubscribe=endpoint.subscribe((message:any)=>{
      if(message.type==='hello')endpoint.postMessage({type:'ready'});
      if(message.type==='host/connect')endpoint.postMessage({type:'response',requestId:'connect',ok:true,result:{generation:1}});
      if(message.type==='host/send'){
        const rpc=JSON.parse(message.frame);
        if(rpc.method==='initialize')endpoint.postMessage({type:'host/frame',hostId:'host',generation:1,frame:JSON.stringify({id:rpc.id,result:{}})});
        else controller.abort();
      }
    });return {close(){closed++;unsubscribe();}};
  }};
  await assert.rejects(callConversationHost(host,{hostId:'host',threadId:'t'},'tail','thread/items/list',{},undefined,1000,controller.signal),{name:'AbortError'});
  assert.equal(closed,1);
});

test('canonical human links preserve base paths and resource identity across routes and Unicode', async()=>{
 const {conversationLink,parseConversationRef}=await import('../../packages/appserver-protocol/src/collaboration');
 const {conversationUiLink}=await import('../../apps/opencraft-cli/src/main');
 const {resolveConversationReferenceNavigation}=await import('../../apps/workbench-web/src/runtime/conversation-reference-navigation');
 for(const host of ['local','ssh:remote/员工']){
   const ref={serverId:'server:21b6b553-92d1-460d-baf1-956779315d55:codex',threadId:'thread/中文?#&'};
   const title='问题 & 回复 / #标题',link=conversationLink('https://example.test/base/path/?old=secret#discard',ref,title),url=new URL(link);
   assert.equal(url.pathname,'/base/path/');assert.equal(url.searchParams.get('old'),null);assert.equal(url.hash,'');
   assert.equal(url.searchParams.get('title'),title);assert.deepEqual(parseConversationRef(link),ref);
   const calls:any[]=[];
   const location=await resolveConversationReferenceNavigation(ref,['wrong',host],async(id,method,params)=>{
     calls.push({id,method,params});
     return method==='opencraft/collaboration'?{ref:id===host?ref:{...ref,serverId:'another-server'}}:{thread:{id:ref.threadId}};
   });
   assert.equal(location.key.hostId,host);assert.equal(location.key.threadId,ref.threadId);
   assert.ok(calls.every(c=>c.method!=='thread/read'||c.params.includeTurns===false));
   assert.equal(conversationUiLink(undefined,ref),null);assert.equal(conversationUiLink('https://example.test/',null),null);
 }
});

test('old history Host rejects tail before sourceRead can reach Native',async()=>{
 const {createConversationExecution}=await import('../../scripts/conversation-execution.mjs');let operations=0;
 const host={accept(endpoint:any){const off=endpoint.subscribe((message:any)=>{
  if(message.type==='hello')endpoint.postMessage({type:'ready'});
  if(message.type==='host/connect')endpoint.postMessage({type:'response',requestId:'connect',ok:true,result:{generation:1}});
  if(message.type==='host/send'){const rpc=JSON.parse(message.frame);if(rpc.method!=='initialize')operations++;
   endpoint.postMessage({type:'host/frame',hostId:'host',generation:1,frame:JSON.stringify({id:rpc.id,result:{capabilities:{extensions:{'opencraft/read-history':{version:1}}}}})});}
 });return {close:off};}};
 const port=createConversationExecution(()=>host,{serverId:'s',hostId:'host'});
 await assert.rejects(port.readTail({serverId:'s',threadId:'t'},1),{code:'unsupported_capability'});assert.equal(operations,0);
});

test('an old Native header view reports unsupported without full-history or Item fallback',async()=>{
 const {createConversationExecution}=await import('../../scripts/conversation-execution.mjs');const calls:string[]=[];
 const host={accept(endpoint:any){const off=endpoint.subscribe((message:any)=>{
  if(message.type==='hello')endpoint.postMessage({type:'ready'});
  if(message.type==='host/connect')endpoint.postMessage({type:'response',requestId:'connect',ok:true,result:{generation:1}});
  if(message.type!=='host/send')return;const rpc=JSON.parse(message.frame);calls.push(rpc.method);
  const result=rpc.method==='initialize'?{capabilities:{extensions:{'opencraft/read-history':{sourceRead:true}}}}:{thread:{id:'t'}};
  endpoint.postMessage({type:'host/frame',hostId:'host',generation:1,frame:JSON.stringify(rpc.method==='thread/turns/list'
    ?{id:rpc.id,error:{code:-32601,data:{code:'UNSUPPORTED_CAPABILITY'}}}:{id:rpc.id,result})});
 });return {close:off};}};
 await assert.rejects(createConversationExecution(()=>host,{serverId:'s',hostId:'host'}).readTail({serverId:'s',threadId:'t'},1),{code:'unsupported_capability'});
 assert.equal(calls.includes('thread/items/list'),false);assert.equal(calls.filter(c=>c==='thread/turns/list').length,1);
});

test('CLI selects only visible Servers by ID, unique engine/label, default or canonical reference', async t => {
  const {run, classify}=await import('../../apps/opencraft-cli/src/main');
  const {CliSshTransport}=await import('../../apps/opencraft-cli/src/ssh');
  const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');
  const {join}=await import('node:path');
  const {tmpdir}=await import('node:os');
  const root=await mkdtemp(join(tmpdir(),'cli-server-selection-'));
  const prior=process.env.OPENCRAFT_CONFIG, priorConnection=process.env.OPENCRAFT_CONNECTION;
  delete process.env.OPENCRAFT_CONNECTION;
  process.env.OPENCRAFT_CONFIG=join(root,'connections.json');
  t.after(async()=>{
    if(prior===undefined)delete process.env.OPENCRAFT_CONFIG;else process.env.OPENCRAFT_CONFIG=prior;
    if(priorConnection===undefined)delete process.env.OPENCRAFT_CONNECTION;else process.env.OPENCRAFT_CONNECTION=priorConnection;
    await rm(root,{recursive:true,force:true});
  });
  const config:any={schemaVersion:1,defaultConnection:'test',connections:{test:{sshAlias:'fixture',instanceId:'i'}}};
  const save=()=>writeFile(process.env.OPENCRAFT_CONFIG!,JSON.stringify(config));
  await save();
  const makeServer=(id:string,engine:string,label:string,connectionState='ready')=>({serverId:id,engine,label,connectionState,capabilities:{metadata:true,metadataDiscovery:true,projectDiscovery:true,modelDiscovery:true,threadCount:true,queue:true}});
  let servers=[makeServer('server:i:codex','codex','Primary'),makeServer('server:i:dsh','dsh','DSH'),makeServer('server:i:pi','pi','Pi','unavailable'),makeServer('server:i:dsh-acp','acp','DSH ACP')];
  const actions:any[]=[];
  let unreachable=false;
  t.mock.method(CliSshTransport.prototype,'connect',async function(this:any){if(unreachable)throw Error('offline');this.update({state:'open'});});
  t.mock.method(CliSshTransport.prototype,'send',async function(this:any,raw:string){
    const msg=JSON.parse(raw);if(msg.id===undefined)return;
    if(msg.method!=='initialize')actions.push(msg.params);
    const result=msg.method==='initialize'?{capabilities:{extensions:{'opencraft/collaboration':{version:1,servers:true,metadata:true,metadataDiscovery:true,projectDiscovery:true,modelDiscovery:true,threadCount:true,threadCountMode:'authorized-recorded-threads-v1'}}}}
      :msg.params.action==='servers'?{instanceId:'i',actor:{id:'a',kind:'human',generation:1},servers}
      :msg.params.action==='discover'?{conversations:[],nextCursor:null}
      :msg.params.action==='metadata'?{ref:msg.params.reference,attention:null}:{instanceId:'i'};
    for(const listener of this.messages)listener(JSON.stringify({id:msg.id,result}));
  });
  const ids=()=>servers.map(s=>s.serverId);
  const rejectSelection=async(argv:string[],code:string,expected=ids())=>{
    const before=actions.length;
    await assert.rejects(run(argv),(error:any)=>{
      assert.equal(error.code,code);assert.deepEqual(error.details.servers,expected);
      for(const id of expected)assert.ok(error.message.includes(id));
      assert.match(error.message,/--server.*--default-server/);assert.doesNotMatch(error.message,/unavailable/i);return true;
    });
    assert.deepEqual(actions.slice(before).map(a=>a.action),['servers']);
  };
  assert.deepEqual((await run(['status']) as any).servers,servers);
  await rejectSelection(['thread','list'],'AMBIGUOUS_SERVER');
  await rejectSelection(['status','--server','missing'],'UNKNOWN_SERVER');
  await rejectSelection(['status','--server','server:other:codex'],'UNKNOWN_SERVER');
  for(const selector of ['codex','Primary','server:i:codex']){
    assert.equal((await run(['status','--server',selector]) as any).server.serverId,ids()[0]);
    await run(['thread','list','--server',selector]);assert.equal(actions.at(-1).serverId,ids()[0]);
  }
  assert.equal((await run(['status','--server','Pi']) as any).server.connectionState,'unavailable');
  config.connections.test.defaultServer='server:i:dsh';await save();
  await run(['thread','list']);assert.equal(actions.at(-1).serverId,'server:i:dsh');
  assert.deepEqual((await run(['status']) as any).servers,servers);
  await run(['project','list']);assert.equal(actions.at(-1).serverId,'server:i:dsh');
  await assert.rejects(run(['thread','create','text','--project','p','--cwd','/repo','--key','k']),{code:'UNSUPPORTED_CAPABILITY'});
  await assert.rejects(run(['thread','lookup','--key','k']),{code:'UNSUPPORTED_CAPABILITY'});
  await assert.rejects(run(['thread','search','text','--field','name']),{code:'UNSUPPORTED_CAPABILITY'});
  await run(['server','models','--server','codex']);assert.equal(actions.at(-1).serverId,'server:i:codex');
  await run(['thread','count','--server','codex']);assert.equal(actions.at(-1).serverId,'server:i:codex');
  const ref='opencraft://conversation/v1/'+encodeURIComponent(ids()[0]!)+'/t';
  await run(['thread','show',ref,'--server','Primary']);assert.equal(actions.at(-1).reference.serverId,ids()[0]);
  await run(['thread','show',ref]);assert.equal(actions.at(-1).reference.serverId,ids()[0]);
  await assert.rejects(run(['thread','show',ref,'--server','dsh']),{code:'TARGET_CONFLICT'});
  config.connections.test.defaultServer='stale';await save();await rejectSelection(['thread','list'],'UNKNOWN_SERVER');
  await run(['connection','add','second','--ssh','fixture','--default-server','codex']);
  const persisted=JSON.parse(await readFile(process.env.OPENCRAFT_CONFIG!,'utf8'));
  assert.equal(persisted.connections.second.defaultServer,'server:i:codex');
  servers.push(makeServer('server:second:codex','codex','Other'));
  await rejectSelection(['status','--server','codex'],'AMBIGUOUS_SERVER',['server:i:codex','server:second:codex']);
  servers.push(makeServer('server:third:pi','other','Primary'));
  await rejectSelection(['status','--server','Primary'],'AMBIGUOUS_SERVER',['server:i:codex','server:third:pi']);
  // A full ID wins even if another visible Server uses it as a label.
  servers.push(makeServer('server:fourth:pi','other','server:i:codex'));
  assert.equal((await run(['status','--server','server:i:codex']) as any).server.serverId,'server:i:codex');
  delete config.connections.test.defaultServer;await save();servers=servers.slice(0,1);
  await run(['thread','list']);assert.equal(actions.at(-1).serverId,'server:i:codex');
  servers=[];assert.deepEqual((await run(['status']) as any).servers,[]);
  await rejectSelection(['thread','list'],'UNKNOWN_SERVER',[]);
  const help=(await run(['--help']) as any).help;assert.match(help,/--default-server/);assert.match(help,/unique within the connection/);
  unreachable=true;
  await assert.rejects(run(['status']),error=>classify(error).code==='CONNECTION_UNAVAILABLE');
});


test('argument errors identify parameters and usage before connecting', async t => {
  const {run}=await import('../../apps/opencraft-cli/src/main');
  const {CliSshTransport}=await import('../../apps/opencraft-cli/src/ssh');
  t.mock.method(CliSshTransport.prototype,'connect',async()=>{assert.fail('Argument errors must not connect');});
  const cases:[string[],string,string][]=[
    [['status','--wat=PRIVATE_VALUE'],'--wat','status'],
    [['thread','list','--server'],'--server','thread list'],
    [['thread','show'],'ref-or-link','thread show'],
    [['thread','show','ref','--cursor','PRIVATE_VALUE'],'--cursor','thread show'],
    [['status','--server','a','--server','b'],'--server','status'],
    [['thread','lookup'],'--key','thread lookup'],
    [['thread','create','text','--key','k'],'--project','thread create'],
    [['thread','log','ref','--tail','0'],'--tail','thread log'],
    [['interactions','respond','ref','id','--epoch','e','--revision','1','--submission','s','--response-file','/nonexistent'],'--response-file','interactions respond'],
    [['thread','wait','ref','--key','k','--timeout','invalid'],'--timeout','thread wait'],
    [['--connection','status','thread','lookup'],'--key','thread lookup'],
    [['--connection','status','thread','list','--bogus'],'--bogus','thread list'],
  ];
  for(const [argv,parameter,command] of cases)await assert.rejects(run(argv),(error:any)=>{
    assert.equal(error.code,'INVALID_ARGUMENTS');assert.ok(error.details.parameters.includes(parameter));
    assert.equal(error.details.command,command||null);assert.ok(error.details.usage.some((line:string)=>line.startsWith('opencraft '+command)));
    assert.equal(JSON.stringify({message:error.message,details:error.details}).includes('PRIVATE_VALUE'),false);return true;
  });
  await assert.rejects(run(['thread','show','ref','--include-turn-configuration','--delivery','x','--delivery-key','y']),(error:any)=>{
    assert.equal(error.details.reason,'invalid-combination');
    assert.deepEqual(error.details.parameters,['--delivery','--delivery-key','--include-turn-configuration']);return true;
  });
  await assert.rejects(run(['thread','nonexistent']),(error:any)=>{
    assert.equal(error.code,'UNKNOWN_COMMAND');assert.ok(error.details.availableCommands.includes('thread list'));
    assert.match(error.message,/Available commands:/);return true;
  });
});
