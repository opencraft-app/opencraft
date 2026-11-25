import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { build } from 'esbuild';
import { BridgeHost } from '../../apps/agent-bridge-host/src/host.js';
import { attachGateway } from '../../apps/agent-bridge-host/src/server.js';
import { codexDeclaration } from '../../apps/agent-bridge-host/src/codex-declaration.js';
import { createServerCodexBridge } from '../../apps/opencraft-daemon/src/bridge-execution-admission';
import { CodexProviderBridge } from '../../apps/opencraft-daemon/src/codex-provider-bridge.js';
import { localTestBackend } from './fixtures/local-backend.js';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
const token = 'private-test-token-00000000000000000000';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, predicate: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) { const v = await read(); if (predicate(v)) return v; await delay(15); }
  throw Error('Expected condition not observed');
}

for(const cli of [false,true,'timeout','initial','contradiction','closed-contradiction'])test(`bundled Codex bridge through durable Host: CLI ${cli}, opt-in, steer, reattach and ID continuity`, async t => {
  const initial=cli==='initial'||String(cli).includes('contradiction');
  let serverStarted=0,serverReset=0;
  const root = await mkdtemp(join(tmpdir(), 'codex-p2a-'));
  const native = createServer(), control = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.end(JSON.stringify(req.url === '/launch' ? { dataDirectory: root, launch: { args: [], env: { OPENCRAFT_CODEX_POOL_AUTH_TOKEN: 'synthetic-test' }, auth: { type: 'chatgptAuthTokens', accessToken: 'synthetic-test', chatgptAccountId: 'opencraft-account-pool' } } } : { protocolVersion: 1, pid: process.pid, codexPid: process.pid, nativeSocket: join(root, 'native.sock') }));
  });
  const ws = new WebSocketServer({ server: native });
  let nativePeer: WebSocket | undefined, starts = 0, steers = 0;
  let approvalAnswer: unknown, approvalAnswers = 0;
  const toolReplies: any[] = [], hostToolCalls: any[] = [];
  let startDynamicTools: any;
  const creationTools = () => [{ type: 'function', name: 'host_declared', description: 'Host tool', inputSchema: { type: 'object' } }];
  const nativeTool = (context: any, tool: any, args: unknown) => tool.name === 'host_tool'
    ? (hostToolCalls.push({ context, tool, args }), Promise.resolve({ success: true, contentItems: [{ type: 'inputText', text: 'host answered' }] })) : null;
  let hasRollout=!initial,initialConfig:any;
  let loaded=true,nativeActive=false,issued=0,revoked=0,blockRetirement=cli==='timeout';const nativeConfigurations:any[]=[];
  const lifecycleCalls:any[]=[];const nativeStartInputs:unknown[]=[];const settingsCalls:any[]=[];const titleCalls:any[]=[];const oldStarts:any[]=[];const releaseCalls:string[]=[];let releaseAnswer=false;
  ws.on('connection', socket => {
    nativePeer = socket;
    socket.on('message', raw => {
      const f = JSON.parse(String(raw));
      if (f.id === 'native-approval' && f.result) { approvalAnswer = f.result; approvalAnswers++; }
      if (typeof f.id === 'string' && f.id.startsWith('native-tool') && f.method === undefined) { toolReplies.push(f); return; }
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: f.id, result }));
      const event = (method: string, params: unknown) => socket.send(JSON.stringify({ method, params }));
      if (f.params?.threadId === 'native-old') {
        if (f.method === 'thread/read') { reply({ thread: { id: 'native-old', status: { type: 'notLoaded' }, turns: [] } }); return; }
        if (f.method === 'thread/resume') { reply({ thread: { id: 'native-old', turns: [] } }); return; }
        if (f.method === 'turn/start') { oldStarts.push(f.params); reply({ turn: { id: 'old-turn-1' } }); return; }
      }
      if (f.method === 'initialize') reply({ userAgent: 'codex/0.167.0' });
      if (['thread/fork','thread/name/set','thread/archive','thread/unarchive','thread/delete','thread/goal/get','thread/goal/set','thread/goal/clear'].includes(f.method)) {
        lifecycleCalls.push({method:f.method,params:f.params});
        if (f.method === 'thread/fork') reply({ thread: { id: 'native-fork', cwd: root, turns: [] } });
        else if (f.method === 'thread/unarchive') reply({ thread: { id: f.params.threadId, turns: [] } });
        else if (f.method === 'thread/goal/set' || f.method === 'thread/goal/get') reply({ goal: { objective: 'ship it', status: 'active' } });
        else if (f.method === 'thread/goal/clear') reply({ cleared: true });
        else reply({});
      }
      if (f.method === 'thread/start') {initialConfig=f.params.config;startDynamicTools=f.params.dynamicTools;reply({sandbox:{type:'readOnly'},approvalPolicy:'never',approvalsReviewer:'user',thread: { id: 'native-new', cwd: root, turns: [] }});}
      if(f.method==='turn/start'&&f.params.clientUserMessageId==='initial-invalid'){socket.send(JSON.stringify({id:f.id,error:{code:-32602,message:'invalid input'}}));return;}
      if (f.method === 'turn/start' && f.params.clientUserMessageId === 'unknown-start') { socket.send(JSON.stringify({ id: f.id, error: { code: -32000, message: 'Opaque native failure' } })); return; }
      if (f.method === 'turn/start') {
        assert.equal(f.params.opencraftExecutionAdmission,undefined);assert.equal(f.params.executionSource,undefined);assert.equal(f.params.opencraftSessionMcp,undefined);
        nativeStartInputs.push(f.params.input);
        hasRollout=true;nativeActive=true;starts++; event('turn/started', { threadId: 'native-new', turn: { id: 'native-turn' } });
        event('item/started', { threadId: 'native-new', turnId: 'native-turn', item: { type: 'commandExecution', id: 'tool', command: 'cat input.txt', cwd: root, status: 'inProgress' } });
        if(String(cli).includes('contradiction')){
          if(cli==='closed-contradiction'){nativeActive=false;event('turn/completed',{threadId:'native-new',turn:{id:'native-turn',status:'completed'}});}
          socket.send(JSON.stringify({id:f.id,error:{code:-32602,message:'refused after start'}}));return;
        }
        reply({ turn: { id: 'native-turn', status: 'inProgress', items: [] } });
      }
      if (f.method === 'turn/steer') {
        steers++; assert.equal(f.params.expectedTurnId, 'native-turn');
        event('item/started', { threadId: 'native-new', turnId: 'native-turn', item: { type: 'userMessage', id: 'steer-item', clientId: f.params.clientUserMessageId, content: f.params.input } });
        reply({ turnId: 'native-turn' });
      }
      if (f.method === 'thread/read'&&f.params.includeTurns&&!hasRollout){socket.send(JSON.stringify({id:f.id,error:{code:-32600,message:'thread native-new is not materialized yet; includeTurns is unavailable before first user message'}}));return;}
      if (f.method === 'thread/read') reply({ thread: { id: 'native-new',status:{type:!loaded?'notLoaded':nativeActive?'active':'idle'}, turns: [{ id: 'native-turn', items: [{ type: 'commandExecution', id: 'tool', command: 'cat input.txt', commandActions: [{ type: 'business-data', threadId: 'business-thread', id: 'native-turn' }] }] }] } });
      if (f.method === 'thread/turns/list') {
        assert.deepEqual(f.params, { threadId: 'native-new', limit: 1, cursor: null, sortDirection: 'desc', itemsView: 'notLoaded' });
        reply({ data: [{ id: 'native-turn', status: nativeActive ? 'inProgress' : 'completed', items: [] }], nextCursor: 'older-turn' });
      }
      if(f.method==='thread/unsubscribe'){if(!blockRetirement)loaded=false;reply({});}
      if(f.method==='thread/settings/update'){settingsCalls.push(f.params);reply({});}
      if(f.method==='thread/resume'&&!hasRollout){socket.send(JSON.stringify({id:f.id,error:{code:-32600,message:'no rollout found'}}));return;}
      if (f.method === 'thread/resume') {loaded=true;if(f.params.config)nativeConfigurations.push(f.params);reply({sandbox:{type:'readOnly'},approvalPolicy:'never',thread: { id: 'native-new', turns: [] }});}
    });
  });
  await new Promise<void>(r => native.listen(join(root, 'native.sock'), r));
  await new Promise<void>(r => control.listen(join(root, 'control.sock'), r));
  const config = join(root, 'core.json');
  await writeFile(config, JSON.stringify({ endpoint: join(root, 'control.sock'), token }), { mode: 0o600 });
  const artifact = join(root, 'codex.cjs');
  await build({ entryPoints: [resolve('apps/agent-bridge-host/src/codex-main.ts')], outfile: artifact, bundle: true, platform: 'node', format: 'cjs' });
  const host = await BridgeHost.open({ path: join(root, 'host.db'), policy: { id: 'p2a-test', capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 } }, backend: localTestBackend(),...(cli==='timeout'?{requestTimeoutMs:1000}:{}),...(cli?{executionCli:{...(initial?{async reserve(){return {environment:{OPENCRAFT_THREAD_CLI:'fixture',PATH:'fixture'},async revoke(){}};}}:{}),async issue(source:any){assert.ok(source.credential.startsWith('signed:'));issued++;return {environment:{OPENCRAFT_THREAD_CLI:'fixture',PATH:'fixture'},...(initial?{async rejectBeforeStart(){return {environment:{OPENCRAFT_THREAD_CLI:'fixture',PATH:'fixture'},async revoke(){}};}}:{}),async revoke(){revoked++;}};}}}:{}) });
  const attachment = await attachGateway(host, token);
  let transport: any;
  const currentGateway=()=> (cli?transport.inner:transport).gateway;
  t.after(async () => { await transport?.close(); await attachment.close(); await host.close(); ws.close(); await Promise.all([new Promise<void>(r => native.close(() => r())), new Promise<void>(r => control.close(() => r()))]); await rm(root, { recursive: true, force: true }); });
  await host.add({ id: 'codex-1', artifact, digest: createHash('sha256').update(await readFile(artifact)).digest('hex'), provider: codexDeclaration, launch: { command: [process.execPath, artifact, config], cwd: root, env: {} } });
  await host.activate('codex-1', '');
  const frames: any[] = [], forwarded: any[] = [];
  let paused = false;
  const staged:unknown[]=[];const guarded:[string,string][]=[];
  let legacyListener: (frame: string) => void = () => {};
  const verifiedSender = { kind: 'employee' as const, loginName: 'alice' };
  const identityCalls: Array<{method: string; threadId: unknown; createdId: unknown; inputId: unknown; sender: unknown}> = [];
  const createTransport = async () => {
    const legacy = {
      status: { state: 'open' as const }, async connect() {}, async close() {}, subscribeStatus() { return () => {}; },
      subscribeMessage(listener: (frame: string) => void) { legacyListener = listener; return () => {}; },
      async send(raw: string) {
        const f = JSON.parse(raw); forwarded.push(f);
        if (f.id !== undefined) legacyListener(JSON.stringify({ id: f.id, [LOGICAL_CLIENT_FIELD]: 'client', result: f.method === 'initialize' ? { capabilities: {} }
          : f.method === 'opencraft/codex/maintenance/read' ? { paused, pendingAdmissions: 0, rejectedAdmissions: 2 } : { data: [{ id: 'native-old' }, { id: 'native-new' }] } }));
      },
    };
    const options={url:attachment.url,token,serverId:'server',inboxPath:join(root,'gateway.db')};
    const next=cli?createServerCodexBridge(legacy,options,{
      async admit(threadId,inputId){return {serverId:'server',threadId,execution:{inputId,executionId:inputId}};},
      sign:scope=>'signed:'+scope.execution!.inputId,...(initial?{async prepareSessionMcp(){return {configuration:{url:'http://127.0.0.1:1/mcp',http_headers:{Authorization:'Bearer platform-mcp'}}};}}:{}),sessionMcp:async()=>({url:'http://127.0.0.1:1/mcp',http_headers:{Authorization:'Bearer platform-mcp'}}),started:()=>{serverStarted++;},rejectedBeforeStart:()=>{serverReset++;},
    },{admissionPaused:()=>paused,nativeTool,creationTools}):new CodexProviderBridge(legacy,options,{admissionPaused:()=>paused,nativeTool,creationTools,
      prepareInput:async(threadId,clientId,input)=>{staged.push([threadId,clientId]);return input.map((item:any)=>item.type==='mention'?{type:'text',text:`file at ${item.path}`}:item);},
      projectHistory:(method,_params,result)=>({...(result as object),projected:method}),
      observeTitle:(method,params,result)=>titleCalls.push([method,(params as any).threadId??null,(result as any).thread?.id??(result as any).turn?.id]),
      senderAttribution: () => true,
      observeIdentityResult: (method, params, result, sender) => {
        identityCalls.push({method,threadId:params.threadId,createdId:(result as any).thread?.id,inputId:params.clientUserMessageId,sender});
      },
      adoptExisting:true,newThreads:true,releaseForAdoption:async threadId=>{releaseCalls.push(threadId);return releaseAnswer;},
      queueGuard:async(threadId,method,params,_context,find)=>{
        guarded.push([threadId,method]);
        if(params.clientUserMessageId==='actor-input:forged')throw Object.assign(Error('Actor input requires its trusted admission'),{code:-32600});
        if(method==='thread/queue/collaborationReceipt'){const row=await find({clientUserMessageId:'guarded-queue'});return {result:{receipt:row&&{id:row.id,state:row.state,targetTurnId:row.targetTurnId}}};}
        return null;
      }});
    next.subscribeMessage(raw => frames.push(JSON.parse(raw))); await next.connect(); return next;
  };
  transport = await createTransport();
  let sequence = 0;
  const request = async (method: string, params: unknown = {}, sender?: typeof verifiedSender) => {
    const id = ++sequence;
    const raw = JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: 'client' });
    if (sender) await transport!.sendWithContext(raw, { sender, validUntil: Date.now() + 60_000 });
    else await transport!.send(raw);
    const frame = await until(() => frames.find(f => f.id === id), Boolean);
    assert.equal(frame.error, undefined, JSON.stringify(frame.error)); return frame.result;
  };
  await request('initialize', { capabilities: { extensions: { 'opencraft/steer-evidence': { version: 1 } } } });
  const created = await request('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only', agentBridge: { threadId: 'bridge:codex:public-new', clientRequestId: 'create' },
    dynamicTools: [{ type: 'function', name: 'client_declared', description: 'Client tool', inputSchema: { type: 'object' } }, { type: 'function', name: 'host_declared', description: 'Shadowed', inputSchema: { type: 'object' } }] }, cli ? undefined : verifiedSender);
  assert.equal(created.thread.id, 'bridge:codex:public-new');
  if (!cli) assert.deepEqual(identityCalls[0], {
    method: 'thread/start', threadId: created.thread.id, createdId: created.thread.id, inputId: undefined, sender: verifiedSender,
  });
  // The Host's own tools are declared at creation, replacing a client declaration of the same name.
  assert.deepEqual(startDynamicTools?.map((tool: any) => tool.name), ['client_declared', 'host_declared']);
  if(!cli){
    // With newThreads, a client that does not ask for the bridge still creates its Thread there.
    // (The fixture native has one session, so the Host refuses binding a second; the creation still went to the bridge.)
    const id = ++sequence;
    await transport.send(JSON.stringify({ id, method: 'thread/start', params: { cwd: root }, [LOGICAL_CLIENT_FIELD]: 'client' }));
    const plain = await until(() => frames.find(f => f.id === id), Boolean);
    assert.match(plain.error?.data?.bridgeCommandId ?? '', /^bridge-mutation:/);
    assert.equal(forwarded.some(f => f.method === 'thread/start'), false);
  }
  if(String(cli).includes('contradiction')){
    const id=++sequence;
    await transport.send(JSON.stringify({id,method:'turn/start',params:{threadId:'bridge:codex:public-new',clientUserMessageId:'contradictory-input',input:[{type:'text',text:'one attempt'}]},[LOGICAL_CLIENT_FIELD]:'client'}));
    const response=await until(()=>frames.find(f=>f.id===id),Boolean);
    assert.equal(response.error.data.submissionOutcome,'unknown');
    assert.equal(response.error.data.bridgeErrorKind,'unknown-outcome');
    assert.equal((await host.query(response.error.data.bridgeCommandId))?.state,'unknown');
    assert.equal(serverStarted,1);assert.equal(serverReset,0);assert.equal(starts,1);
    assert.ok(frames.findIndex(f=>f.method==='turn/started')<frames.findIndex(f=>f.id===id));
    if(cli==='closed-contradiction')assert.equal(revoked,1);else assert.equal(revoked,0);
    return;
  }
  if(cli==='timeout') {
    const failedId=++sequence;
    await transport.send(JSON.stringify({id:failedId,method:'turn/start',params:{threadId:'bridge:codex:public-new',clientUserMessageId:'prepare-timeout',input:[{type:'text',text:'not sent'}]},[LOGICAL_CLIENT_FIELD]:'client'}));
    const failed=await until(()=>frames.find(frame=>frame.id===failedId),Boolean);
    assert.equal(failed.error.data.submissionOutcome,'rejected');
    assert.equal((await host.query(failed.error.data.bridgeCommandId))?.state,'rejected');
    assert.equal(starts,0);assert.equal(revoked,1);
    blockRetirement=false;loaded=false;
  }
  if(cli==='initial') {
    const invalid=++sequence;
    await transport.send(JSON.stringify({id:invalid,method:'turn/start',params:{threadId:'bridge:codex:public-new',clientUserMessageId:'initial-invalid',input:[{type:'text',text:'invalid'}]},[LOGICAL_CLIENT_FIELD]:'client'}));
    const refusal=await until(()=>frames.find(f=>f.id===invalid),Boolean);
    assert.equal(refusal.error.data.submissionOutcome,'rejected');assert.equal(starts,0);
  }
  if(cli===false){
    // Maintenance pauses new bridge work like legacy work; reads continue and the
    // snapshot counts bridge refusals, so an operator never sees a false drain.
    paused=true;
    const startsBefore=starts;
    for(const [method,params] of [['turn/start',{threadId:'bridge:codex:public-new',clientUserMessageId:'paused-input',input:[{type:'text',text:'not now'}]}],
      ['thread/start',{cwd:root,agentBridge:{threadId:'bridge:codex:paused-new',clientRequestId:'paused-create'}}],
      ['thread/queue/add',{threadId:'bridge:codex:public-new',clientUserMessageId:'paused-queue',input:[{type:'text',text:'later'}]}]] as const){
      const id=++sequence;
      await transport.send(JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:'client'}));
      const refusal=await until(()=>frames.find(f=>f.id===id),Boolean);
      assert.equal(refusal.error.code,-32000); assert.match(refusal.error.message,/maintenance/u); assert.equal(refusal.error.data.retryable,true);
    }
    assert.equal(starts,startsBefore,'no native turn started while paused');
    assert.equal(currentGateway().owns('bridge:codex:paused-new'),false,'a refused creation reserves nothing');
    const snapshot=await request('opencraft/codex/maintenance/read');
    assert.equal(snapshot.paused,true); assert.equal(snapshot.rejectedAdmissions,5); assert.equal(snapshot.pendingAdmissions,0);
    paused=false;
    // The queue of a bridge Thread is the Host's, reached through the gateway, and declared to clients.
    assert.deepEqual(await request('thread/queue/list',{threadId:'bridge:codex:public-new'}),{data:[],nextCursor:null,steering:[]});
    assert.ok(!forwarded.some(f=>String(f.method).startsWith('thread/queue/')),'bridge queues never reach the legacy owner');
    const init=frames.find(f=>f.result?.capabilities?.extensions?.['opencraft/execution-engines']);
    const provider=init.result.capabilities.extensions['opencraft/execution-engines'].providers.find((entry:any)=>entry.id==='codex-bridge');
    assert.equal(provider.extensions['opencraft/thread-follow-up'].queue,true);
    assert.equal(provider.extensions['opencraft/thread-queue'].version,2);
    const refusal=++sequence;
    await transport.send(JSON.stringify({id:refusal,method:'thread/queue/start',params:{threadId:'bridge:codex:public-new'},[LOGICAL_CLIENT_FIELD]:'client'}));
    assert.match((await until(()=>frames.find(f=>f.id===refusal),Boolean)).error.message,/Queued message is unavailable/u,'Host refusals keep their message');
    // Collaboration checks run before the Host queue sees a request; a refusal is explicit and queues nothing,
    // and receipts are answered by the guard from the Host queue's own rows.
    const forged=++sequence;
    await transport.send(JSON.stringify({id:forged,method:'thread/queue/add',params:{threadId:'bridge:codex:public-new',clientUserMessageId:'actor-input:forged',input:[{type:'text',text:'forged'}]},[LOGICAL_CLIENT_FIELD]:'client'}));
    const forgedReply=await until(()=>frames.find(f=>f.id===forged),Boolean);
    assert.match(forgedReply.error.message,/trusted admission/u); assert.equal(forgedReply.error.data.submissionOutcome,'rejected');
    // An idle Thread would start a queued input at once, so the receipt here reads a row that does not exist.
    assert.equal((await request('thread/queue/collaborationReceipt',{threadId:'bridge:codex:public-new'})).receipt,null);
    assert.deepEqual(guarded.map(([,method])=>method),['thread/queue/list','thread/queue/start','thread/queue/add','thread/queue/collaborationReceipt']);
    assert.ok(guarded.every(([threadId])=>threadId==='bridge:codex:public-new'));
    // Settings, pins, history cancellation and native-initiated metadata reach clients by public identity.
    const publicId='bridge:codex:public-new';
    await request('thread/settings/update',{threadId:publicId,model:'gpt-fixture'});
    assert.deepEqual(settingsCalls.at(-1),{model:'gpt-fixture',threadId:'native-new'});
    nativePeer!.send(JSON.stringify({method:'thread/settings/updated',params:{threadId:'native-new',threadSettings:{model:'gpt-fixture'}}}));
    nativePeer!.send(JSON.stringify({method:'thread/goal/updated',params:{threadId:'native-new',goal:{objective:'model-set',status:'active'}}}));
    nativePeer!.send(JSON.stringify({method:'thread/status/changed',params:{threadId:'native-new',status:{type:'idle'}}}));
    const forwardedSettings=await until(()=>frames.find(f=>f.method==='thread/settings/updated'),Boolean);
    assert.equal(forwardedSettings.params.threadId,publicId); assert.deepEqual(forwardedSettings.params.threadSettings,{model:'gpt-fixture'});
    const forwardedGoal=await until(()=>frames.find(f=>f.method==='thread/goal/updated'&&f.params.goal?.objective==='model-set'),Boolean);
    assert.equal(forwardedGoal.params.threadId,publicId);
    assert.ok(!frames.some(f=>f.method==='thread/status/changed'&&f.params?.threadId==='native-new'),'only allow-listed metadata is forwarded');
    assert.deepEqual(await request('thread/history/cancel',{threadId:publicId,historyReadId:'read-1'}),{cancelled:false});
    await request('opencraft/thread-pins/set',{threadId:publicId,pinned:true});
    assert.deepEqual(forwarded.filter(f=>f.method==='opencraft/thread-pins/set').map(f=>f.params),[{threadId:'native-new',pinned:true}]);
    assert.deepEqual((await request('opencraft/thread-pins/list')).data.map((row:any)=>row.id),['native-old',publicId]);
    legacyListener(JSON.stringify({method:'thread/pins/updated',params:{threadId:'native-new'},[LOGICAL_CLIENT_FIELD]:'client'}));
    assert.equal((await until(()=>frames.find(f=>f.method==='thread/pins/updated'),Boolean)).params.threadId,publicId);
    assert.deepEqual(titleCalls[0],['thread/start',null,'native-new'],'the title generator saw the creation by native identity');
    // Existing thread operations reach native Codex under the bound native ID and
    // come back under public identities, with the same change notifications.
    const lifecycleFrom=frames.length, pub='bridge:codex:public-new', seen=()=>frames.slice(lifecycleFrom).filter(f=>f.method&&f.method.startsWith('thread/')&&f.id===undefined);
    await request('thread/name/set',{threadId:pub,name:'Renamed'});
    await request('thread/goal/set',{threadId:pub,objective:'ship it'});
    assert.deepEqual((await request('thread/goal/get',{threadId:pub})).goal,{objective:'ship it',status:'active'});
    await request('thread/goal/clear',{threadId:pub});
    await request('thread/archive',{threadId:pub});
    assert.equal((await request('thread/unarchive',{threadId:pub})).thread.id,pub);
    const forked=(await request('thread/fork',{threadId:pub})).thread.id;
    assert.match(forked,/^bridge:codex:/u); assert.notEqual(forked,pub); assert.equal(currentGateway().owns(forked),true);
    await request('thread/delete',{threadId:forked});
    assert.deepEqual(lifecycleCalls.map(c=>[c.method,c.params.threadId]),[['thread/name/set','native-new'],['thread/goal/set','native-new'],['thread/goal/get','native-new'],
      ['thread/goal/clear','native-new'],['thread/archive','native-new'],['thread/unarchive','native-new'],['thread/fork','native-new'],['thread/delete','native-fork']]);
    assert.equal(lifecycleCalls[0].params.name,'Renamed'); assert.equal(lifecycleCalls[1].params.objective,'ship it');
    assert.deepEqual(seen().filter(f=>['thread/name/updated','thread/goal/updated','thread/goal/cleared','thread/archived','thread/unarchived','thread/deleted'].includes(f.method)).map(f=>[f.method,f.params.threadId]),
      [['thread/name/updated',pub],['thread/goal/updated',pub],['thread/goal/cleared',pub],['thread/archived',pub],['thread/unarchived',pub],['thread/deleted',forked]]);
    assert.ok(!JSON.stringify(frames).includes('native-fork'),'the native fork identity never reaches clients');
    assert.ok(!forwarded.some(f=>lifecycleCalls.some(c=>c.method===f.method)),'bridge Thread operations never fall through to the legacy owner');
    // A deleted bridge Thread has no session left to operate on.
    const gone=++sequence;
    await transport.send(JSON.stringify({id:gone,method:'thread/name/set',params:{threadId:forked,name:'late'},[LOGICAL_CLIENT_FIELD]:'client'}));
    assert.equal((await until(()=>frames.find(f=>f.id===gone),Boolean)).error.data.submissionOutcome,'rejected');
  }
  const started = await request('turn/start', { threadId: 'bridge:codex:public-new', clientUserMessageId: 'start', input: [{ type: 'text', text: 'read' },
    ...(cli===false?[{ type: 'mention', name: 'input.txt', path: '/work/input.txt' }]:[])] }, cli ? undefined : verifiedSender);
  if(cli===false){
    assert.deepEqual(identityCalls.at(-1), {
      method: 'turn/start', threadId: created.thread.id, createdId: undefined, inputId: 'start', sender: verifiedSender,
    });
    assert.ok(!identityCalls.some(entry => entry.inputId === 'paused-input' || entry.inputId === 'actor-input:forged'));

    // Attachments are staged by the composition before native Codex sees the input.
    assert.deepEqual(nativeStartInputs.at(-1),[{type:'text',text:'read'},{type:'text',text:'file at /work/input.txt'}]);
    assert.deepEqual(staged.at(-1),['bridge:codex:public-new','start']);
    assert.deepEqual(titleCalls.at(-1),['turn/start','native-new','native-turn'],'and the first turn');
  }
  const latest = await request('thread/turns/list', { threadId: 'bridge:codex:public-new', limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
  assert.equal(latest.data.length, 1); assert.equal(latest.data[0].id, started.turn.id); assert.equal(latest.data[0].status, 'inProgress');
  assert.equal(latest.nextCursor, 'older-turn');
  if(cli==='initial'){assert.equal(issued,2);assert.equal(nativeConfigurations.length,0);assert.equal(initialConfig['shell_environment_policy.set'].OPENCRAFT_THREAD_CLI,'fixture');assert.equal(initialConfig['mcp_servers.opencraft_session'].http_headers.Authorization,'Bearer platform-mcp');}
  else if(cli){assert.equal(issued,cli==='timeout'?2:1);assert.equal(nativeConfigurations[0].sandbox,'read-only');assert.equal(nativeConfigurations[0].approvalPolicy,'never');assert.equal(nativeConfigurations[0].config['shell_environment_policy.set'].OPENCRAFT_THREAD_CLI,'fixture');assert.equal(nativeConfigurations[0].config['mcp_servers.opencraft_session'].http_headers.Authorization,'Bearer platform-mcp');}
  const turnId = started.turn.id; assert.notEqual(turnId, 'native-turn');
  // The local Host's desktop serves a bridge Thread: the request reaches it with the public identity.
  await request('opencraft/desktop/attachment/create', { threadId: 'bridge:codex:public-new' });
  assert.equal(forwarded.find(f => f.method === 'opencraft/desktop/attachment/create').params.threadId, 'bridge:codex:public-new');
  // Thread orchestration control goes to the local Host's trusted lane; a bridge parent is named natively.
  await request('opencraft/orchestration/prepare', { operationId: 'operation', threadId: 'bridge:codex:public-new', arguments: {} });
  const orchestration = forwarded.find(f => f.method === 'opencraft/orchestration/prepare');
  assert.equal(orchestration.params.threadId, 'native-new');
  // A dynamic tool the Host owns is answered by the Host and never offered to clients;
  // any other tool still goes to the client, as on the local Host.
  nativePeer!.send(JSON.stringify({ id: 'native-tool-host', method: 'item/tool/call', params: { threadId: 'native-new', turnId: 'native-turn', callId: 'call-host', tool: 'host_tool', arguments: { q: 1 } } }));
  const hostReply = await until(() => toolReplies.find(f => f.id === 'native-tool-host'), Boolean);
  assert.equal(hostReply.result.contentItems[0].text, 'host answered');
  assert.deepEqual({ ...hostToolCalls[0].context, args: hostToolCalls[0].args }, { threadId: 'bridge:codex:public-new', turnId, callId: 'call-host', args: { q: 1 } });
  nativePeer!.send(JSON.stringify({ id: 'native-tool-client', method: 'item/tool/call', params: { threadId: 'native-new', turnId: 'native-turn', callId: 'call-client', tool: 'client_tool', arguments: {} } }));
  const offeredTool = await until(() => frames.find(f => f.method === 'item/tool/call' && f.params?.callId === 'call-client'), Boolean);
  assert.equal(frames.some(f => f.method === 'item/tool/call' && f.params?.callId === 'call-host'), false);
  await transport!.send(JSON.stringify({ id: offeredTool.id, result: { success: true, contentItems: [{ type: 'inputText', text: 'client answered' }] }, [LOGICAL_CLIENT_FIELD]: 'client' }));
  assert.equal((await until(() => toolReplies.find(f => f.id === 'native-tool-client'), Boolean)).result.contentItems[0].text, 'client answered');
  nativePeer!.send(JSON.stringify({ id: 'native-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'native-new', turnId: 'native-turn', itemId: 'tool', command: 'cat input.txt' } }));
  const approval = await until(() => frames.find(f => f.method === 'item/commandExecution/requestApproval'), Boolean);
  assert.equal(approval.params.threadId, 'bridge:codex:public-new');
  assert.equal(approval.params.turnId, turnId); assert.notEqual(approval.params.itemId, 'tool');
  const approvalDecision = cli===true ? 'accept' : 'decline';
  const answerApproval = () => transport!.send(JSON.stringify({ id: approval.id, result: { decision: approvalDecision }, [LOGICAL_CLIENT_FIELD]: 'client' }));
  await request('thread/unsubscribe', { threadId: 'bridge:codex:public-new' });
  await assert.rejects(answerApproval(), /Interaction subscription required/);
  assert.equal(approvalAnswer, undefined);
  // Reinitialize the same logical client: the old grant must not authorize its
  // new connection lifecycle, even if initialize happens within one millisecond.
  await request('initialize');
  await assert.rejects(answerApproval(), /Interaction subscription required/);
  await request('thread/resume', { threadId: 'bridge:codex:public-new' });
  await until(() => frames.filter(f => f.id === approval.id && f.method === approval.method).length, n => n === 2);
  await transport.send(JSON.stringify({ method: 'runtime/client/disconnect', [LOGICAL_CLIENT_FIELD]: 'client' }));
  await request('initialize');
  await assert.rejects(answerApproval(), /Interaction subscription required/);
  // Gateway attachment replacement must recover the very same pending request;
  // native owner/bridge remains alive and does not send a second callback.
  await transport.close(); transport = await createTransport();
  await request('initialize', { capabilities: { extensions: { 'opencraft/steer-evidence': { version: 1 } } } });
  await assert.rejects(answerApproval(), /Conversation subscription required|Interaction subscription required|Logical client|Initialized/);
  await request('thread/resume', { threadId: 'bridge:codex:public-new' });
  const recovered = await until(() => frames.filter(f => f.id === approval.id && f.method === approval.method), rows => rows.length === 3);
  assert.deepEqual(recovered[2].params, approval.params);
  await request('thread/read', { threadId: 'bridge:codex:public-new' });
  assert.equal(frames.filter(f => f.id === approval.id && f.method === approval.method).length, 3);
  await answerApproval();
  await until(() => approvalAnswer, Boolean);
  assert.deepEqual(approvalAnswer, { decision: approvalDecision });
  await assert.rejects(answerApproval(), /Interaction subscription required/);
  assert.equal(approvalAnswers, 1);
  await until(() => currentGateway().interactions.size, size => size === 0);
  assert.equal(currentGateway().interactions.size, 0, 'accepted settlement releases cached request body');
  await request('turn/steer', { threadId: 'bridge:codex:public-new', expectedTurnId: turnId, clientUserMessageId: 'steer', input: [{ type: 'text', text: 'stop after reading' }] });
  await request('turn/steer', { threadId: 'bridge:codex:public-new', expectedTurnId: turnId, clientUserMessageId: 'steer', input: [{ type: 'text', text: 'stop after reading' }] });
  assert.equal(starts, 1); assert.equal(steers, 1);
  const status = await request('opencraft/steer/status', { threadId: 'bridge:codex:public-new' });
  assert.equal(status.inputs[0].admission.value, 'accepted'); assert.equal(status.inputs[0].evidence.value, 'context-confirmed');
  const staleId = ++sequence;
  await transport.send(JSON.stringify({ id: staleId, method: 'turn/steer', params: { threadId: 'bridge:codex:public-new', expectedTurnId: 'absent-turn', clientUserMessageId: 'stale', input: [{ type: 'text', text: 'stale' }] }, [LOGICAL_CLIENT_FIELD]: 'client' }));
  assert.equal(frames.find(f => f.id === staleId)?.error?.code, -32002);
  assert.equal(frames.find(f => f.id === staleId)?.error?.data?.submissionOutcome, 'rejected');
  assert.equal(steers, 1);
  nativePeer!.send(JSON.stringify({ id: 'external-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'native-new', turnId: 'native-turn', itemId: 'tool', command: 'cat input.txt' } }));
  const external = await until(() => frames.find(f => f.method === 'item/commandExecution/requestApproval' && f.id !== approval.id), Boolean);
  nativePeer!.send(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'native-new', requestId: 'external-approval' } }));
  await until(() => frames.some(f => f.method === 'serverRequest/resolved' && f.params.requestId === external.id), Boolean);
  await assert.rejects(transport.send(JSON.stringify({ id: external.id, result: { decision: 'accept' }, [LOGICAL_CLIENT_FIELD]: 'client' })), /Interaction subscription required/);
  assert.equal(currentGateway().interactions.size, 0, 'native resolution releases cached request body');
  const beforeRestart = frames.filter(f => f.method === 'turn/started').length;
  await transport.close(); transport = await createTransport();
  await request('initialize'); await request('thread/resume', { threadId: 'bridge:codex:public-new' });
  assert.equal(frames.filter(f => f.id === approval.id && f.method === approval.method).length, 3, 'settled approval must not reappear from inbox replay');
  assert.equal(frames.filter(f => f.id === external.id && f.method === external.method).length, 1, 'external settlement must not reappear after replacement');
  assert.equal(currentGateway().interactions.size, 0, 'historical settled bodies are not retained during replay');
  nativePeer!.send(JSON.stringify({ method: 'item/completed', params: { threadId: 'native-new', turnId: 'native-turn', item: { type: 'commandExecution', id: 'tool', command: 'cat input.txt', cwd: root, status: 'completed', aggregatedOutput: 'fixture' } } }));
  nativeActive=false;
  nativePeer!.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'native-new', turn: { id: 'native-turn', status: 'completed' } } }));
  await until(() => frames.some(f => f.method === 'turn/completed'), Boolean);
  assert.equal(frames.filter(f => f.method === 'turn/started').length, beforeRestart);
  const read = await request('thread/read', { threadId: 'bridge:codex:public-new', includeTurns: true });
  assert.equal(read.thread.id, 'bridge:codex:public-new'); assert.equal(read.thread.turns[0].id, turnId);
  if(cli===false)assert.equal(read.projected,'thread/read','history reads carry recorded attachments');
  assert.deepEqual(read.thread.turns[0].items[0].commandActions, [{ type: 'business-data', threadId: 'business-thread', id: 'native-turn' }]);
  const list = await request('thread/list'); assert.deepEqual(list.data.map((t: any) => t.id), ['native-old', 'bridge:codex:public-new']);
  const unknownId = ++sequence;
  await transport.send(JSON.stringify({ id: unknownId, method: 'turn/start', params: { threadId: 'bridge:codex:public-new', clientUserMessageId: 'unknown-start', input: [{ type: 'text', text: 'unknown' }] }, [LOGICAL_CLIENT_FIELD]: 'client' }));
  assert.equal(frames.find(f => f.id === unknownId)?.error?.data?.submissionOutcome, 'unknown');
  assert.equal(frames.find(f => f.id === unknownId)?.error?.data?.retryable, false);
  assert.match(frames.find(f => f.id === unknownId)?.error?.data?.bridgeCommandId, /^bridge-mutation:[a-f0-9]{64}$/);
  assert(!forwarded.some(f => f.method === 'turn/start' || f.method === 'turn/steer'));
  if(cli===false){
    const startsToLegacy=()=>forwarded.filter(f=>f.method==='turn/start'&&f.params.threadId==='native-old').length;
    // Declined: the local Host keeps a busy Thread, and its turn goes there.
    await request('turn/start',{threadId:'native-old',clientUserMessageId:'old-1',input:[{type:'text',text:'still local'}]});
    assert.equal(startsToLegacy(),1); assert.equal(currentGateway().owns('native-old'),false); assert.equal(oldStarts.length,0);
    // Released: the bridge adopts the Thread under the same ID; the turn reaches native Codex through the bridge.
    releaseAnswer=true;
    await request('turn/start',{threadId:'native-old',clientUserMessageId:'old-2',input:[{type:'text',text:'now bridged'}]});
    assert.equal(currentGateway().owns('native-old'),true);
    assert.equal(startsToLegacy(),1,'the adopted turn never reaches the local Host');
    assert.equal(oldStarts.at(-1).threadId,'native-old'); assert.equal(oldStarts.at(-1).clientUserMessageId,'old-2');
    assert.deepEqual(releaseCalls,['native-old','native-old']);
    const adoptedRead=await request('thread/read',{threadId:'native-old'});
    assert.equal(adoptedRead.thread.id,'native-old','the public ID is unchanged');
    await request('turn/start',{threadId:'native-old',clientUserMessageId:'old-3',input:[{type:'text',text:'again'}]}).catch(()=>{});
    assert.deepEqual(releaseCalls,['native-old','native-old'],'an adopted Thread is not adopted again');
  }
  nativePeer!.send(JSON.stringify({ id: 'lost-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'native-new', turnId: 'native-turn', itemId: 'tool' } }));
  const lost = await until(() => frames.find(f => f.method === 'item/commandExecution/requestApproval' && f.id !== approval.id && f.id !== external.id), Boolean);
  nativePeer!.terminate();
  await until(() => frames.some(f => f.method === 'serverRequest/resolved' && f.params.requestId === lost.id), Boolean);
  assert.deepEqual((await host.snapshot()).interactions, []);
  assert.equal(currentGateway().interactions.size, 0);
});
