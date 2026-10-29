import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { EmployeeGitVaultStore } from '../../scripts/employee-git-vault-store.js';
import { AccountEnvironment } from '../../scripts/account-environment.js';
import { ExecutionEnvironmentRuntime, environmentProjectId, type EnvironmentExecutionScope } from '../../scripts/execution-environment.js';
import { ThreadIdentityDatabase } from '../../apps/opencraft-daemon/src/thread-identity-database.js';
import { ExecutionLeaseStore } from '../../apps/opencraft-daemon/src/execution-lease-store.js';
import { HostProcessService } from '../../apps/local-agent-host/src/process-service.js';
import { PiShellWorker, shellText } from '../../plugins/pi-engine/src/shell.js';
import { AcpEngine } from '../../plugins/acp-engine/src/index.js';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { EXECUTION_ENVIRONMENT_FIELD } from '../../scripts/execution-environment.js';
import { buildDshCapabilityPlugin } from '../../scripts/package-dsh-capability-runtime.mjs';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const program = "process.stdout.write(require('node:crypto').createHash('sha256').update(process.env.SERVICE_KEY??'missing').digest('hex'))";
const entry = (value: string) => ({ name: 'SERVICE_KEY', value, secret: true });
const scope = (account = 'employee:alice', projectId: string | null = 'a', threadId: string | null = null): EnvironmentExecutionScope => ({ account, projectId, threadId, hostId: 'opencraft-server' });
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'environment-injection-')), vault = new EmployeeGitVaultStore(root);
  const runtime = new ExecutionEnvironmentRuntime(root, vault), environment = new AccountEnvironment(vault);
  const directory = join(root, 'thread-identities', 'opencraft-server'); await mkdir(directory, { recursive: true });
  const database = new ThreadIdentityDatabase(directory), leases = new ExecutionLeaseStore(database.database);
  environment.replace('employee:alice', { projectId: null }, 0, [entry('alice-global')]);
  environment.replace('employee:bob', { projectId: null }, 0, [entry('bob-global')]);
  environment.replace('employee:alice', { projectId: environmentProjectId('opencraft-server', 'a') }, 0, [entry('alice-a')]);
  const admit = (threadId: string, account: string, inputId = 'input') => {
    runtime.bind('opencraft-server', threadId, 'a');
    leases.capture(threadId, inputId, { principal: { provider: 'employee', subject: account }, ownership: 'human' });
    leases.begin(threadId, inputId); leases.started(threadId, 'turn-' + inputId, inputId);
  };
  t.after(async () => { database.close(); vault.close(); await rm(root, { recursive: true, force: true }); });
  return { root, vault, runtime, environment, leases, admit };
}
async function until(read: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await read()) { if (Date.now() > deadline) throw new Error('Environment process did not settle'); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('packaged DSH capability resource loads without a source tree or TypeScript loader', async t => {
  const root = await mkdtemp(join(tmpdir(), 'environment-packaged-dsh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = join(root, 'runtime/dsh/opencraft-capability-plugin.mjs');
  await buildDshCapabilityPlugin(plugin);
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    "const plugin=await import(process.argv[1]);if(typeof plugin.apply!=='function')process.exit(1);console.log('loaded')", plugin],
    { cwd: root, env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(stdout.trim(), 'loaded');
});

test('execution scope follows original admitted input; envelopes reject tampering, replay, method and project substitution', async t => {
  const f = await fixture(t); f.admit('thread-a', 'alice');
  assert.equal(f.runtime.execution('opencraft-server', 'thread-a', 'input').account, 'employee:alice');
  assert.equal(f.runtime.execution('opencraft-server', 'thread-a', 'forged').account, null);
  const original = scope('employee:alice', 'a', 'thread-a');
  const token = f.runtime.seal(original, 'turn/start');
  assert.throws(() => f.runtime.open(token, 'local-codex', 'turn/start', { threadId: 'thread-a' }));
  assert.throws(() => f.runtime.open(token, 'opencraft-server', 'thread/start', { threadId: 'thread-a' }));
  assert.throws(() => f.runtime.open(token, 'opencraft-server', 'turn/start', { threadId: 'thread-a', projectId: 'b' }));
  assert.throws(() => f.runtime.open(token + 'x', 'opencraft-server', 'turn/start', { threadId: 'thread-a' }));
  assert.deepEqual(f.runtime.open(token, 'opencraft-server', 'turn/start', { threadId: 'thread-a' }), original);
  assert.throws(() => f.runtime.open(token, 'opencraft-server', 'turn/start', { threadId: 'thread-a' }));
  assert.throws(() => f.runtime.scope({ sender: null, executionPrincipal: { provider: 'employee', subject: 'alice' }, validUntil: Date.now() + 5000 }, 'opencraft-server', { threadId: 'thread-a', projectId: 'b' }));
});

test('Workbench PTYs use employee/project snapshots and refuse another employee or project control', async t => {
  const f = await fixture(t), service = new HostProcessService(f.runtime); t.after(() => service.close());
  const launch = async (id: string, execution: EnvironmentExecutionScope) => {
    service.dispatch('process/spawn', { processHandle: id, tty: true, command: [process.execPath, '-e', program], cwd: f.root, size: { cols: 100, rows: 30 } }, execution);
    await until(() => (service.dispatch('process/attach', { processHandle: id, afterSequence: 0 }, execution) as any).phase === 'exited');
    return (service.dispatch('process/attach', { processHandle: id, afterSequence: 0 }, execution) as any).output.map((row: any) => Buffer.from(row.deltaBase64, 'base64').toString()).join('').trim();
  };
  assert.equal(await launch('one', scope()), hash('alice-a'));
  assert.equal(await launch('two', scope('employee:alice', 'b')), hash('alice-global'));
  assert.equal(await launch('three', scope('employee:bob')), hash('bob-global'));
  assert.throws(() => service.dispatch('process/attach', { processHandle: 'one', afterSequence: 0 }, scope('employee:bob')));
  assert.throws(() => service.dispatch('process/kill', { processHandle: 'one' }, scope('employee:alice', 'b')));
  assert.deepEqual((service.dispatch('process/list', {}, scope()) as any).processes.map((row: any) => row.processHandle), ['one']);
  assert.throws(() => service.dispatch('process/spawn', { processHandle: 'override', tty: true, command: ['/bin/true'], size: { cols: 80, rows: 24 }, env: { SERVICE_KEY: 'forged' } }, scope()));
});

test('Pi shell workers and native execution environments use isolated snapshots; new workers see edits', async t => {
  const f = await fixture(t); const workers: PiShellWorker[] = []; const events: unknown[] = [];
  t.after(async () => { await Promise.all(workers.map(worker => worker.stop())); });
  const worker = (execution: EnvironmentExecutionScope) => {
    const result = new PiShellWorker({ cwd: f.root, directory: join(f.root, 'worker-' + workers.length), threadId: 'pi-test', environment: f.runtime.snapshot(execution), onNotification(event) { events.push(event); }, onLost() {} });
    workers.push(result); return result;
  };
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}`;
  const old = worker(scope()); await old.start();
  f.environment.replace('employee:alice', { projectId: environmentProjectId('opencraft-server', 'a') }, 1, [entry('alice-new')]);
  for (const [peer, expected] of [[old, 'alice-a'], [worker(scope()), 'alice-new'], [worker(scope('employee:alice', 'b')), 'alice-global'], [worker(scope('employee:bob')), 'bob-global']] as const) {
    const output = await peer.call({ command, mode: 'dispatch', background: true });
    const id = output.details?.sessionId; let text = shellText(output);
    await until(async () => { if (text.includes(hash(expected)) || JSON.stringify(events).includes(hash(expected))) return true; text += shellText(await peer.call({ sessionId: id })); return text.includes(hash(expected)); });
  }
  const env = new NodeExecutionEnv({ cwd: f.root, shellEnv: f.runtime.snapshot(scope()).apply(process.env) });
  t.after(() => env.cleanup(BACKGROUND_CONTEXT));
  let output = '';
  const result = await env.exec([process.execPath, '-e', program], { onOutput: text => { output += text; } }, BACKGROUND_CONTEXT);
  assert.equal(result.ok, true); assert.equal(output, hash('alice-new'));
});

test('ACP sessions own separate native processes and keep injected values out of metadata, errors and diagnostics', async t => {
  const f = await fixture(t);
  const peer = join(f.root, 'peer.mjs');
  await writeFile(peer, `import {createInterface} from 'node:readline'; import {createHash} from 'node:crypto';
    const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
    createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line), p=m.params;
    if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}}}}});
    else if(m.method==='session/new')send({id:m.id,result:{sessionId:'native-one'}});
    else if(m.method==='session/prompt'){process.stderr.write(process.env.SERVICE_KEY??'');send({method:'session/update',params:{sessionId:p.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:createHash('sha256').update(process.env.SERVICE_KEY??'missing').digest('hex')}}}});send({id:m.id,result:{stopReason:'end_turn'}});}
    else send({id:m.id,result:{}});});`);
  const engine = new AcpEngine({ cwd: f.root, command: process.execPath, args: [peer], dataDirectory: join(f.root, 'acp'), executionEnvironment: f.runtime });
  t.after(() => engine.close()); const messages: any[] = []; engine.subscribe((method, params) => messages.push({ method, params }));
  const client = { notify() {}, async request() {} };
  let lastThread = "";
  for (const [account, project, expected] of [['alice', 'a', 'alice-a'], ['bob', 'a', 'bob-global'], ['alice', 'b', 'alice-global']]) {
    const execution = scope('employee:' + account, project);
    const created = await engine.request('thread/start', { cwd: f.root, [EXECUTION_ENVIRONMENT_FIELD]: f.runtime.seal({ ...execution, threadId: null }, 'thread/start') }, client);
    const threadId = lastThread = created.thread.id;
    f.admit(threadId, account); f.runtime.bind('opencraft-server', threadId, project);
    await engine.request('turn/start', { threadId, clientUserMessageId: 'input', input: [{ type: 'text', text: 'probe' }] }, client);
    await until(() => messages.some(row => row.method === 'turn/completed' && row.params.threadId === threadId));
    const snapshot = engine.snapshot(threadId); assert.ok(JSON.stringify(snapshot).includes(hash(expected)));
    for (const value of ['alice-a', 'bob-global', 'alice-global']) assert.equal(JSON.stringify([snapshot, engine.occupancy, created]).includes(value), false);
  }
  assert.equal(new Set(engine.processIds).size, 4);
  assert.deepEqual(f.runtime.redact({ error: 'child failed: alice-a', nested: ['bob-global'] }), { error: 'child failed: [REDACTED]', nested: ['[REDACTED]'] });
  f.leases.finished(lastThread, 'turn-input');
  await engine.suspend();
  assert.equal(f.runtime.execution('opencraft-server', lastThread).account, null);
  await engine.request('thread/resume', { threadId: lastThread }, client);
  f.admit(lastThread, 'alice', 'next'); f.runtime.bind('opencraft-server', lastThread, 'b');
  const next = await engine.request('turn/start', { threadId: lastThread, clientUserMessageId: 'next', input: [{ type: 'text', text: 'again' }] }, client);
  await until(() => messages.some(row => row.method === 'turn/completed' && row.params.turn.id === next.turn.id));
  assert.ok(JSON.stringify(engine.snapshot(lastThread)).includes(hash('alice-global')));
  const snapshot = f.runtime.snapshot(scope());
  assert.equal(JSON.stringify(snapshot).includes('alice-a'), false); assert.equal(inspect(snapshot).includes('alice-a'), false);
  for (const file of await readdir(join(f.root, 'acp'))) {
    const bytes = await readFile(join(f.root, 'acp', file));
    assert.equal(bytes.includes(Buffer.from('alice-a')), false);
  }
});

test('pinned DSH bash and terminal spawn boundaries inject only the admitted employee/project', async t => {
  const f = await fixture(t);
  const { existsSync } = await import('node:fs');
  const pinned = resolve(process.env.OPENCRAFT_DSH_RUNTIME ?? 'runtime/dsh');
  if (!existsSync(join(pinned, 'node_modules/@deepseek-ai/dsh-bash-local/lib/index.js'))) { t.skip('Pinned DSH runtime is not installed'); return; }
  const { patchDshThreadEnvironment } = await import('../../scripts/patch-dsh-thread-environment.mjs');
  const { registerDshExecutionEnvironment } = await import('../../apps/local-agent-host/src/dsh-execution-environment.mjs');
  const { pathToFileURL } = await import('node:url'); const { build } = await import('esbuild');
  const isolated = join(f.root, 'pinned');
  for (const name of ['dsh-bash-local', 'dsh-terminal-bash']) {
    const target = join(isolated, 'node_modules/@deepseek-ai', name, 'lib/index.js');
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, await readFile(join(pinned, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
  }
  await patchDshThreadEnvironment(isolated);
  const module = join(isolated, 'node_modules/@deepseek-ai/dsh-bash-local/lib/index.js'), output = join(f.root, 'executor.mjs');
  await build({ stdin: { contents: await readFile(module, 'utf8'), resolveDir: join(pinned, 'node_modules/@deepseek-ai/dsh-bash-local/lib'), sourcefile: module }, outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" } });
  const { LocalBashExecutor } = await import(pathToFileURL(output).href);
  const terminal = await readFile(join(isolated, 'node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js'), 'utf8');
  const start = terminal.indexOf('function childEnvironment('), end = terminal.indexOf('\n/**', start);
  assert.ok(start >= 0 && end > start);
  const childEnvironment = new Function('CONTROLLED_PROMPT', terminal.slice(start, end) + ';return childEnvironment;')('probe> ');
  let port: any;
  registerDshExecutionEnvironment({ provide(_name: string, value: unknown) { port = value; }, inject(_deps: unknown, setup: any) { setup({ shellEnv: { register() {} } }); } }, (native: string) => native.replace('native-', ''), f.runtime);
  for (const [id, account, projectId, expected] of [['one', 'alice', 'a', 'alice-a'], ['two', 'bob', 'a', 'bob-global'], ['three', 'alice', 'b', 'alice-global']]) {
    f.admit(id, account); f.runtime.bind('opencraft-server', id, projectId);
    const ctx = { get: () => port };
    const shell = LocalBashExecutor.prototype.spawnSpec.call({ ctx, config: { maxSpillBytes: 10000, maxOutputBytes: 10000, graceMs: 100 } }, { workdir: f.root, env: {}, dshEnv: { DSH_SESSION_ID: 'native-' + id, DSH_OPENCRAFT_THREAD_ID: id } }, ['unused'], 10000);
    const terminalEnv = childEnvironment({ owner: { id: 'native-' + id, ctx }, sessionId: 'terminal' }, 'bash');
    for (const env of [shell.env, terminalEnv]) {
      assert.equal((await promisify(execFile)(process.execPath, ['-e', program], { cwd: f.root, env })).stdout, hash(expected));
    }
  }
});


test('failed ACP native session creation releases its environment process and remains retryable', async t => {
  const f = await fixture(t), peer = join(f.root, 'failure-peer.mjs'), pids = join(f.root, 'pids');
  await writeFile(peer, `import {createInterface} from 'node:readline';import{appendFileSync}from'node:fs';appendFileSync(process.argv[2],process.pid+'\\n');
    const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
    if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}}}}});
    else if(m.method==='session/new')send({id:m.id,error:{code:-32602,message:'fixture rejected creation'}});else send({id:m.id,result:{}});});`);
  const engine = new AcpEngine({ cwd: f.root, command: process.execPath, args: [peer, pids], dataDirectory: join(f.root, 'failed-acp'), executionEnvironment: f.runtime });
  t.after(() => engine.close());
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(engine.request('thread/start', { cwd: f.root, [EXECUTION_ENVIRONMENT_FIELD]: f.runtime.seal(scope('employee:alice', 'a', null), 'thread/start') }, { notify() {}, async request() {} }));
    assert.equal(engine.processIds.length, 1);
    assert.deepEqual(await engine.catalogThreadIds(), []);
  }
  for (const pid of (await readFile(pids, 'utf8')).trim().split('\n').map(Number)) if (!engine.processIds.includes(pid)) assert.throws(() => process.kill(pid, 0));
});

test('Pi durable tools follow the admitted input across employees and register every live worker for handoff', async t => {
  const f = await fixture(t);
  const { PiDurableSession } = await import('../../plugins/pi-engine/src/session.js');
  const { createModels } = await import('@earendil-works/pi-ai');
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import('@earendil-works/pi-ai/providers/faux');
  const faux = fauxProvider({ tokensPerSecond: 100000 }), models = createModels(); models.setProvider(faux.provider);
  const native = await PiDurableSession.open({ threadId: 'pi-durable-environment', cwd: f.root, file: join(f.root, 'pi.sqlite'), agentDirectory: f.root, executionEnvironment: f.runtime, projectId: 'a',
    models: models as any, tools: [], onSnapshot() {}, onTool: async () => { throw new Error('Unexpected tool'); }, onExit() {} });
  try {
    await native.configure({ model: { provider: 'faux', modelId: 'faux-1' }, cwd: f.root });
    for (const [index, account, expected] of [[1, 'alice', 'alice-a'], [2, 'bob', 'bob-global']] as const) {
      const inputId = 'human-' + index; f.admit('pi-durable-environment', account, inputId);
      let output = '';
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('bash', { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}` }), { stopReason: 'toolUse' }),
        (ctx: any) => { output = JSON.stringify(ctx.messages.filter((row: any) => row.role === 'toolResult').at(-1)); return fauxAssistantMessage('done'); },
      ]);
      await native.submit('probe', { turnId: inputId, clientId: account, input: [{ type: 'text', text: 'probe' }], createdAtMs: Date.now() }, inputId);
      await until(async () => output.includes(hash(expected)) && !(await native.snapshot()).live.run);
      assert.equal(native.workerProcessIds.length, 2, 'the schema worker and current scoped worker are both registered; idle obsolete scopes are released');
      f.leases.finished('pi-durable-environment', 'turn-' + inputId);
    }
  } finally { await native.close(); }
});

test('a gateway preserves ordinary turns on a legacy Codex router and refuses configured variables before owner handoff', async t => {
  const f = await fixture(t);
  const { createServer } = await import('node:http'); const { WebSocketServer } = await import('ws');
  const { startControlServer } = await import('../../apps/codex-core/src/control-server.js');
  const { CodexEngineAdapter } = await import('../../apps/opencraft-daemon/src/codex-engine-adapter.js');
  const { LOGICAL_CLIENT_FIELD } = await import('@opencraft/app-host-protocol');
  const nativeSocket = join(f.root, 'legacy-native.sock'), endpoint = join(f.root, 'legacy-control.sock');
  const server = createServer(), sockets = new WebSocketServer({ noServer: true }), methods: string[] = [];
  server.on('upgrade', (request, socket, head) => sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client)));
  let turn = 0;
  sockets.on('connection', socket => socket.on('message', bytes => {
    const frame = JSON.parse(String(bytes)), params = frame.params ?? {}; methods.push(frame.method);
    const emit = (value: unknown) => socket.send(JSON.stringify(value));
    let result: unknown = {};
    if (frame.method === 'initialize') result = { userAgent: 'legacy-fixture', platformFamily: 'unix', capabilities: { extensions: {} } };
    if (frame.method === 'thread/start') result = { thread: { id: 'legacy-thread', cwd: f.root, turns: [], status: { type: 'idle' } } };
    if (frame.method === 'thread/list') result = { data: [], nextCursor: null };
    if (frame.method === 'turn/start') { result = { turn: { id: 'turn-' + ++turn, status: 'inProgress', items: [] } }; emit({ method: 'turn/started', params: { threadId: params.threadId, ...(result as object) } }); }
    if (frame.method === 'fixture/complete') emit({ method: 'turn/completed', params: { threadId: 'legacy-thread', turn: { id: 'turn-' + turn, status: 'completed', items: [] } } });
    if (frame.id !== undefined) emit({ id: frame.id, result });
  }));
  await new Promise<void>(resolve => server.listen(nativeSocket, resolve));
  const token = 'synthetic-' + randomUUID();
  const control = await startControlServer(endpoint, token, async request => ({ status: 200, value: request.url === '/health'
    ? { protocolVersion: 1, pid: process.pid, codexPid: process.pid, nativeSocket, dataDirectory: join(f.root, 'codex'), proxyBaseUrl: 'http://127.0.0.1:9', routingEpoch: 'legacy' }
    : { lease: 'legacy-lease', routingEpoch: 'legacy', fenceEpoch: 0, fencedGenerationIds: [], routes: [] } }));
  const adapter = new CodexEngineAdapter({ executable: process.execPath, runtimeDirectory: f.root, dataDirectory: join(f.root, 'codex'), coreEndpoint: endpoint, coreAuthToken: token, coreHostOverlays: true, executionEnvironment: f.runtime, logDiagnostic() {} });
  const frames: any[] = []; adapter.subscribeMessage(frame => frames.push(JSON.parse(frame))); let sequence = 0;
  const call = async (method: string, params: object, account = 'charlie') => {
    const id = ++sequence;
    await adapter.sendWithContext(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: 'legacy-client' }), { sender: { kind: 'employee', loginName: account }, executionPrincipal: { provider: 'employee', subject: account }, validUntil: Date.now() + 60_000 });
    await until(() => frames.some(frame => frame.id === id)); const response = frames.find(frame => frame.id === id);
    if (response.error) throw new Error(response.error.message); return response.result;
  };
  try {
    await adapter.connect(); await call('initialize', {});
    const created = await call('thread/start', {});
    await call('turn/start', { threadId: created.thread.id, clientUserMessageId: 'one', input: [{ type: 'text', text: 'first' }] });
    await call('fixture/complete', {});
    await call('turn/start', { threadId: created.thread.id, clientUserMessageId: 'two', input: [{ type: 'text', text: 'next' }] });
    assert.equal(methods.filter(method => method === 'turn/start').length, 2);
    assert.equal(methods.includes('opencraft/environment/capability'), false, 'an old router must not receive an unsupported capability request');
    await assert.rejects(call('thread/start', {}, 'alice'), /owner handoff/);
  } finally {
    await adapter.close(); await control.close(); for (const socket of sockets.clients) socket.terminate(); sockets.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('ACP cold explicit selection enforces model policy on its account-scoped native transport', async t => {
  const f = await fixture(t);
  const { ModelPolicyStore } = await import('@opencraft/model-usage-policy');
  const path = join(f.root, 'policy.sqlite'), policy = new ModelPolicyStore(path);
  t.after(() => policy.close());
  const engine = new AcpEngine({ cwd: f.root, command: process.execPath, args: [resolve('tests/fixtures/acp-engine-peer.mjs')],
    dataDirectory: join(f.root, 'policy-acp'), executionEnvironment: f.runtime, modelPolicyPath: path,
    env: { ACP_TEST_MODELS: '1', ACP_TEST_MODEL_CONFIG_ID: 'model-selector' } });
  t.after(() => engine.close());
  const client = { notify() {}, async request() {} };
  const { thread } = await engine.request('thread/start', { cwd: f.root,
    [EXECUTION_ENVIRONMENT_FIELD]: f.runtime.seal(scope('employee:alice', 'a'), 'thread/start') }, client);
  f.admit(thread.id, 'alice', 'selection');
  await engine.suspend();
  policy.write(0, [{ engine: 'acp', model: 'acp:blocked-native' }], 'admin');
  await assert.rejects(engine.request('turn/start', { threadId: thread.id, clientUserMessageId: 'selection',
    model: 'acp:blocked-native', input: [{ type: 'text', text: 'denied' }] }, client), /restricted/);
  const result = await engine.request('turn/start', { threadId: thread.id, clientUserMessageId: 'selection',
    model: 'acp:allowed-native', input: [{ type: 'text', text: 'allowed' }] }, client);
  assert.equal(result.turn.status, 'inProgress');
  assert.equal((await engine.request('thread/read', { threadId: thread.id }, client)).thread.model, 'acp:allowed-native');
  await until(() => engine.snapshot(thread.id).activeTurn === null || engine.executionObservation(thread.id).turn?.status !== 'inProgress');
  await engine.close();
});
