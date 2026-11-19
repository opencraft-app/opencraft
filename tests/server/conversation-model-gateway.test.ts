import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {WebSocket} from 'ws';
import {AppHostServer} from '../../packages/app-host-server/src/index';
import {ActorStore} from '../../packages/access-control/src/actors';
import {ActorAccess} from '../../packages/access-control/src/actor-access';
import {ThreadAccessStore, ThreadAccessSession} from '../../packages/access-control/src/thread-access';
import {CodexEngineAdapter} from '../../apps/opencraft-daemon/src/codex-engine-adapter';
import {AccountPoolStore, CodexAccountPoolProxy, ModelGatewayStore, startCodexAccountPoolServer} from '@opencraft/account-pool-host';
import {createWorkbenchWebServer} from '../../scripts/serve-workbench-web.mjs';
import {EmployeeGitVaultStore} from '../../scripts/employee-git-vault-store';
import {AccountEnvironment} from '../../scripts/account-environment';
import {ExecutionEnvironmentRuntime, EXECUTION_ENVIRONMENT_FIELD} from '../../scripts/execution-environment';
import {ExecutionEnvironmentTransport} from '../../scripts/execution-environment-transport';

const model = 'configured/alice-key/model';
/** Real loopback HTTP/WS, Actor/Thread ACL, Codex adapter, account proxy and SQLite.
 * Only login verification, native execution and the upstream model are fixtures.
 * No production state, identities, credentials or paid provider calls are used. */
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-model-gateway-'));
  const oldPath = process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
  const ledgerPath = join(root, 'model-gateway.sqlite');
  process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = ledgerPath;
  const cleanup: (() => void | Promise<unknown>)[] = [];
  t.after(async () => {
    try { for (const close of cleanup.reverse()) await close(); } finally {
      if (oldPath === undefined) delete process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
      else process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE = oldPath;
      await rm(root, {recursive: true, force: true});
    }
  });
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Isolated model fixture</title>');
  const actors = new ActorStore(join(root, 'actors.sqlite')); cleanup.push(() => actors.close());
  const permissions = new ThreadAccessStore(join(root, 'access.sqlite'), actors); cleanup.push(() => permissions.close());
  const ledger = new ModelGatewayStore(ledgerPath); cleanup.push(() => ledger.close());
  const vault = new EmployeeGitVaultStore(root); cleanup.push(() => vault.close());
  const environments = new AccountEnvironment(vault);
  const runtime = new ExecutionEnvironmentRuntime(root, vault); cleanup.push(() => runtime.close());
  const principals = new Map(['alice', 'bob'].map(subject => [subject, {provider: 'fixture', subject,
    displayName: subject, expiresAt: Date.now() + 120000}]));
  const contexts = Object.fromEntries([...principals].map(([subject, principal]) => [subject, actors.resolveHuman(principal)]));
  for (const name of ['alice', 'bob']) {
    ledger.configure(contexts[name]!.actorId, {monthlyTokens: 10000, requestTokens: 100, concurrency: 4}, 0, 'fixture-admin');
    environments.replace('fixture:' + name, {projectId: null}, 0, [{name: 'SERVICE_KEY', value: 'synthetic-env-' + name, secret: true}]);
  }
  const aliceId = contexts.alice!.actorId, bobId = contexts.bob!.actorId;
  ledger.prepareContribution('alice-key', aliceId, 'fixture-template');
  ledger.contributionState('alice-key', aliceId, 'shared');
  const revoked = new Set<string>();
  const principal = (request: any) => principals.get(String(request.headers['x-fixture-user'])) ?? null;
  const access = new ActorAccess(actors, {authenticateHuman: principal,
    admitted: p => !revoked.has(p.subject), administrator: () => false, isHumanCurrent: p => !revoked.has(p.subject)});
  let truncated = false;
  const upstreamCalls: {authorization: string | undefined; model: string}[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamCalls.push({authorization: req.headers.authorization, model: input.model});
    res.writeHead(200, {'content-type': 'text/event-stream'});
    if (truncated) res.end('data: {"type":"response.completed"}\n\n');
    else res.end('data: ' + JSON.stringify({type: 'response.completed', response: {id: 'synthetic-response-' + upstreamCalls.length,
      status: 'completed', usage: {input_tokens: 10, output_tokens: 5, total_tokens: 15,
        input_tokens_details: {cached_tokens: 7}}}}) + '\n\n');
  });
  cleanup.push(() => new Promise<void>(r => {upstream.closeAllConnections(); upstream.close(() => r());}));
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}`;
  const accounts = new AccountPoolStore({databasePath: join(root, 'accounts.sqlite'), secretsDirectory: join(root, 'secrets')});
  cleanup.push(() => accounts.close());
  const hostToken = accounts.issueHostToken('fixture-native');
  const proxy = new CodexAccountPoolProxy({store: accounts, upstreamBaseUrl: upstreamUrl,
    configuredResponses: {catalog: async () => [], resolve: async () => ({baseUrl: upstreamUrl + '/v1',
      model: 'synthetic-upstream-model', apiKey: 'synthetic-model-key-alice'})}});
  const accountServer = await startCodexAccountPoolServer({proxy}); cleanup.push(() => accountServer.close());
  const nativeCalls: any[] = [], sealedInputs: {account: string | null; overlay: unknown}[] = [];
  let rpcId = 0, nativeProcess: ChildProcessWithoutNullStreams | null = null;
  const nativeFile = join(root, 'native-fixture.mjs');
  await writeFile(nativeFile, String.raw`
import {createInterface} from 'node:readline';
const models=new Map(),active=new Map();let threads=0,turns=0;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
createInterface({input:process.stdin}).on('line',raw=>{
 const call=JSON.parse(raw);let result={};
 if(call.method==='initialize')result={capabilities:{}};
 if(['thread/start','thread/fork'].includes(call.method)){
  const id='isolated-thread-'+(++threads),selected=call.params.model??'configured/alice-key/model';models.set(id,selected);
  result={thread:{id,projectId:null,status:{type:'idle'},turns:[],model:selected},model:selected};
 }
 if(['thread/read','thread/resume'].includes(call.method)){
  const id=call.params.threadId;result={thread:{id,projectId:null,status:{type:active.has(id)?'active':'idle'},turns:[],model:models.get(id)},model:models.get(id)};
 }
 if(call.method==='thread/list'||call.method==='thread/loaded/list')result={data:[],nextCursor:null};
 if(call.method==='thread/turns/list'||call.method==='thread/items/list')result={data:[],nextCursor:null};
 if(call.method==='model/list')result={data:[{id:'configured/alice-key/model',model:'configured/alice-key/model'},{id:'platform-model',model:'platform-model'}]};
 if(call.method==='turn/start'){
  if(active.has(call.params.threadId)){emit({id:call.id,error:{code:-32600,message:'Thread already active'}});return;}
  const turn={id:'isolated-turn-'+(++turns),status:'inProgress'};active.set(call.params.threadId,turn.id);result={turn};
 }
 if(call.method==='fixture/complete'){
  const id=active.get(call.params.threadId);active.delete(call.params.threadId);
  emit({method:'turn/completed',params:{threadId:call.params.threadId,turn:{id,status:'completed',items:[]}}});return;
 }
 if(call.id!==undefined)emit({id:call.id,result});
});
`);
  const adapter = new CodexEngineAdapter({executable: process.execPath, runtimeDirectory: root,
    dataDirectory: join(root, 'codex'), nativeCodexHomeDirectory: join(root, 'native-home'),
    upstreamBaseUrl: upstreamUrl, fetch: async () => Response.json({}),
    spawnAppServer: ({cwd}) => {
      const child = spawn(process.execPath, [nativeFile], {cwd, env: {HOME: root, PATH: process.env.PATH}, stdio: ['pipe', 'pipe', 'pipe']});
      nativeProcess = child;
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((chunk: any, ...args: any[]) => {
        for (const line of String(chunk).split('\n').filter(Boolean)) nativeCalls.push(JSON.parse(line));
        return (write as any)(chunk, ...args);
      }) as typeof child.stdin.write;
      return child;
    }, createMaintenanceClient: async () => {throw Error('Fixture maintenance not used');},
    modelActor: context => actors.isCurrent(context) ? actors.get(context.actorId) : null,
    logDiagnostic: () => {}});
  // tokenUsage identity/query composition is omitted: model admission has its own identity resolver.
  const host = new AppHostServer({logicalClientRouting: true, physicalHostLifetime: 'server',
    createRpcAccessSession: (_h: any, c: any, send: any) => new ThreadAccessSession(permissions, () => 'fixture-server', c.actorContext, send,
      undefined, () => c.resourceOwner?.assertCurrent()),
    createTransport: () => new ExecutionEnvironmentTransport({
      get status() {return adapter.status;}, connect: signal => adapter.connect(signal), close: () => adapter.close(),
      subscribeMessage: fn => adapter.subscribeMessage(fn), subscribeStatus: fn => adapter.subscribeStatus(fn),
      send: (frame, signal) => adapter.send(frame, signal),
      async sendWithContext(frame, context, signal) {
        const call = JSON.parse(frame);
        if (call.method === 'turn/start') {
          const scope = runtime.open(call.params[EXECUTION_ENVIRONMENT_FIELD], 'local-codex', call.method, call.params);
          sealedInputs.push({account: scope.account, overlay: runtime.snapshot(scope).overlay().SERVICE_KEY});
        }
        return adapter.sendWithContext(frame, context, signal);
      }}, runtime, 'local-codex')});
  cleanup.push(() => host.close());
  const identity = {admissionStatus: () => 204,
    connectionContext: (r: any) => ({sender: {kind: 'employee', loginName: principal(r)?.subject},
      executionPrincipal: principal(r), validUntil: Date.now() + 120000}), handle: () => false};
  const gateway = await createWorkbenchWebServer({root, loopbackOnly: true, actorService: access,
    identityService: identity, appHostServer: host, appServerTarget: null, onAppHostDiagnostic: () => {}});
  cleanup.push(() => gateway.close());
  const address = await gateway.listen({host: '127.0.0.1', port: 0}), origin = `http://127.0.0.1:${address.port}`;
  const sockets: WebSocket[] = [];
  cleanup.push(() => {for (const socket of sockets) socket.terminate();});
  async function page(user: 'alice' | 'bob') {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/apphost', {origin, headers: {'x-fixture-user': user}});
    sockets.push(socket); const frames: any[] = []; socket.on('message', raw => frames.push(JSON.parse(String(raw)))); await once(socket, 'open');
    async function wait(predicate: (frame: any) => boolean) {
      const end = Date.now() + 7000;
      while (Date.now() < end) {const value = frames.find(predicate); if (value) return value; await new Promise(r => setTimeout(r, 5));}
      throw Error('Isolated model Gateway RPC deadline');
    }
    socket.send(JSON.stringify({type: 'hello', protocolVersion: 2, rendererId: user})); await wait(x => x.type === 'ready');
    socket.send(JSON.stringify({type: 'host/connect', hostId: 'local-codex', leaseId: 'lease', requestId: 'connect'}));
    const generation = (await wait(x => x.type === 'response' && x.requestId === 'connect')).result.generation;
    async function rpc(method: string, params: any = {}) {
      const id = ++rpcId, requestId = 'send-' + id;
      socket.send(JSON.stringify({type: 'host/send', requestId, hostId: 'local-codex', leaseId: 'lease', generation,
        frame: JSON.stringify({id, method, params})}));
      const reply = await wait(x => x.type === 'host/frame' && JSON.parse(x.frame).id === id || x.type === 'response' && x.requestId === requestId && x.error);
      return reply.type === 'host/frame' ? JSON.parse(reply.frame) : {error: reply.error};
    }
    assert.ok((await rpc('initialize')).result); return {rpc, frames};
  }
  const alice = await page('alice'), bob = await page('bob');
  const infer = (threadId: string, turnId: string, token = hostToken) => fetch(accountServer.url + '/v1/responses', {
    method: 'POST', headers: {'content-type': 'application/json', 'x-opencraft-account-pool-token': token,
      'thread-id': threadId, 'x-codex-turn-metadata': JSON.stringify({turn_id: turnId})},
    body: JSON.stringify({model, input: 'synthetic inference; no real user content'})});
  const complete = async (threadId: string, turnId: string) => {
    assert.equal(ledger.execution(threadId)?.state, 'active');
    nativeProcess!.stdin.write(JSON.stringify({method: 'fixture/complete', params: {threadId}}) + '\n');
    const until = Date.now() + 5000;
    while (ledger.execution(threadId)?.state === 'active' && Date.now() < until) await new Promise(r => setTimeout(r, 5));
    assert.notEqual(ledger.execution(threadId)?.state, 'active', 'matching native completion must close the execution');
  };
  return {alice, bob, aliceId, bobId, contexts, ledger, permissions, upstreamCalls, nativeCalls, sealedInputs, infer, complete,
    truncate: () => {truncated = true;}, revoked};
}

test('HTTP/WS creator binding and real proxy dispatch keep Key, Actor and exact Turn independent', {timeout: 30000}, async t => {
  const f = await fixture(t);
  const created = await f.alice.rpc('thread/start', {model, creator: f.bobId, creatorActorId: f.bobId});
  assert.ok(created.result, JSON.stringify(created.error)); const thread = created.result.thread.id;
  assert.deepEqual(f.ledger.conversationModel(thread), {creator: f.aliceId, provider: 'alice-key', revision: 0});
  assert.equal(f.ledger.canUse('alice-key', f.bobId), false);
  assert.ok((await f.bob.rpc('thread/resume', {threadId: thread, model, creatorActorId: f.bobId})).result);
  const catalog = await f.bob.rpc('model/list');
  assert.ok(catalog.result); assert.ok(!catalog.result.data.some((row: any) => row.id === model));
  let previousTurn: string | null = null;
  for (const [page, authorizer, account, env] of [[f.alice, f.aliceId, 'fixture:alice', 'synthetic-env-alice'],
    [f.bob, f.bobId, 'fixture:bob', 'synthetic-env-bob']] as const) {
    const started = await page.rpc('turn/start', {threadId: thread, model, clientUserMessageId: 'input-' + authorizer,
      input: [{type: 'text', text: 'synthetic'}], actorId: f.aliceId, __opencraftEnvironment: 'forged'});
    assert.ok(started.result, JSON.stringify(started.error)); const turn = started.result.turn.id;
    if (previousTurn) {
      const calls = f.upstreamCalls.length, stale = await f.infer(thread, previousTurn);
      assert.equal(stale.status, 403); await stale.text(); assert.equal(f.upstreamCalls.length, calls);
    }
    const response = await f.infer(thread, turn); assert.equal(response.status, 200); await response.text();
    const row = f.ledger.requests(authorizer).find(row => row.turn === turn)!;
    assert.ok(row); assert.equal(row.thread, thread); assert.equal(row.actor, authorizer); assert.equal(row.key_owner, f.aliceId);
    assert.equal(row.credential, model); assert.equal(row.actual, 15); assert.equal(row.cache_read_tokens, 7);
    assert.equal(row.input_tokens, 10); assert.equal(row.output_tokens, 5); assert.equal(row.cache_write_tokens, null);
    assert.deepEqual(f.sealedInputs.at(-1), {account, overlay: env});
    await f.complete(thread, turn); previousTurn = turn;
  }
  assert.equal(f.upstreamCalls.length, 2);
  assert.ok(f.upstreamCalls.every(call => call.authorization === 'Bearer synthetic-model-key-alice' && call.model === 'synthetic-upstream-model'));
  assert.equal(f.ledger.requests(f.aliceId).length, 1); assert.equal(f.ledger.requests(f.bobId).length, 1);
  // These are overlapping spending ceilings, NOT additive per-Actor analytics.
  // Alice owns both requests' Key; Bob authorizes only his own Turn.
  assert.equal(f.ledger.summary(f.aliceId).usedTokens, 30); assert.equal(f.ledger.summary(f.bobId).usedTokens, 15);
  assert.equal(f.ledger.conversationModel(thread)?.creator, f.aliceId);
  assert.ok(!JSON.stringify(f.bob.frames).includes('synthetic-model-key'));
  assert.ok(!JSON.stringify(f.bob.frames).includes('synthetic-env-'));
});

test('Thread privacy, forged creation and withdrawn connection fail before upstream dispatch', {timeout: 30000}, async t => {
  const f = await fixture(t);
  const thread = (await f.alice.rpc('thread/start', {model})).result.thread.id;
  f.permissions.set('fixture-server', thread, 'private', 1, f.contexts.alice!);
  const before = f.nativeCalls.filter(call => call.method === 'turn/start').length;
  const denied = await f.bob.rpc('turn/start', {threadId: thread, model, creatorActorId: f.aliceId,
    input: [{type: 'text', text: 'synthetic'}], clientUserMessageId: 'forged-input'});
  assert.equal(denied.error?.code, -32004);
  assert.equal(f.nativeCalls.filter(call => call.method === 'turn/start').length, before);
  const foreign = await f.bob.rpc('thread/start', {model, creatorActorId: f.aliceId});
  assert.equal(foreign.error?.data?.resultUnknown, true);
  assert.equal(f.ledger.conversationModel(foreign.error.data.threadId), null);
  assert.equal(f.nativeCalls.filter(call => call.method === 'thread/start').length, 2, 'unknown allocation must not be repeated');
  const started = await f.alice.rpc('turn/start', {threadId: thread, model, input: [{type: 'text', text: 'synthetic'}], clientUserMessageId: 'creator-input'});
  assert.ok(started.result, JSON.stringify(started.error));
  assert.equal((await f.infer(thread, started.result.turn.id, 'invalid-host-token')).status, 401);
  f.ledger.contributionState('alice-key', f.aliceId, 'withdrawn');
  const withdrawn = await f.infer(thread, started.result.turn.id);
  assert.equal(withdrawn.status, 403); await withdrawn.text();
  assert.equal(f.upstreamCalls.length, 0);
  assert.equal(f.ledger.summary(f.aliceId).heldTokens, 0);
});

test('a truncated real HTTP stream stays unknown under its exact member Turn without replay', {timeout: 30000}, async t => {
  const f = await fixture(t), thread = (await f.alice.rpc('thread/start', {model})).result.thread.id;
  const started = await f.bob.rpc('turn/start', {threadId: thread, model, input: [{type: 'text', text: 'synthetic'}], clientUserMessageId: 'member-input'});
  assert.ok(started.result, JSON.stringify(started.error)); const turn = started.result.turn.id;
  f.truncate(); const response = await f.infer(thread, turn); assert.equal(response.status, 200); await response.text();
  const row = f.ledger.requests(f.bobId)[0]!;
  assert.equal(row.actor, f.bobId); assert.equal(row.key_owner, f.aliceId); assert.equal(row.turn, turn);
  assert.equal(row.state, 'unknown'); assert.equal(row.actual, null); assert.equal(row.cache_read_tokens, null);
  assert.equal(f.ledger.summary(f.bobId).heldTokens, 100); assert.equal(f.upstreamCalls.length, 1);
  await f.complete(thread, turn); assert.equal(f.upstreamCalls.length, 1);
});


test('a member cannot bypass the credential owner cap through the real HTTP proxy', {timeout: 30000}, async t => {
  const f = await fixture(t), thread = (await f.alice.rpc('thread/start', {model})).result.thread.id;
  f.ledger.setPersonalLimit(f.aliceId, 99, 0);
  const started = await f.bob.rpc('turn/start', {threadId: thread, model,
    input: [{type: 'text', text: 'synthetic'}], clientUserMessageId: 'capped-member-input'});
  assert.ok(started.result, JSON.stringify(started.error));
  const response = await f.infer(thread, started.result.turn.id);
  assert.equal(response.status, 429); assert.equal((await response.json()).error.code, 'gateway_budget_exhausted');
  assert.equal(f.upstreamCalls.length, 0); assert.equal(f.ledger.requests(f.bobId).length, 0);
  assert.equal(f.ledger.summary(f.aliceId).heldTokens, 0); assert.equal(f.ledger.summary(f.bobId).heldTokens, 0);
});
