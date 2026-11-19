import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHandsTerminal } from '../../scripts/container-deployment/terminal.mjs';
import { createHandsTerminalService, terminalResourceOwnerId, HostTerminalTransport } from '../../scripts/host-terminal-transport.js';
import { deploymentPaths } from '../../scripts/container-deployment/paths.mjs';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import { OPENCRAFT_METHOD_ACCESS_EXTENSION } from '@opencraft/appserver-protocol';
import type { DuplexTransport, TransportSubmissionContext } from '@opencraft/appserver-client';
import { WebSocket, WebSocketServer } from 'ws';
import { startHeadlessServer } from '../../scripts/headless-server.mjs';

class Engine implements DuplexTransport {
  status = { state: 'idle' as 'idle' | 'open' | 'closed' };
  frames: any[] = []; listeners = new Set<(frame: string) => void>();
  async connect() { this.status = { state: 'open' }; }
  async close() { this.status = { state: 'closed' }; }
  subscribeStatus() { return () => {}; }
  subscribeMessage(listener: (frame: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async send(frame: string) {
    const value = JSON.parse(frame); this.frames.push(value);
    if (['thread/archive','thread/unarchive'].includes(value.method)) for (const listener of this.listeners) listener(JSON.stringify({id:value.id,[LOGICAL_CLIENT_FIELD]:value[LOGICAL_CLIENT_FIELD],result:{}}));
    if (value.method === 'initialize') for (const listener of this.listeners) listener(JSON.stringify({ id: value.id,
      [LOGICAL_CLIENT_FIELD]: value[LOGICAL_CLIENT_FIELD], result: { capabilities: { extensions: {
        [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { version: 1, methods: ['thread/read', 'model/list', 'process/spawn'] },
      } } } }));
  }
}
const context = (actorId: string): TransportSubmissionContext => ({ sender: null,
  actorContext: { actorId, generation: 1, credentialId: null, expiresAt: Date.now() + 60000 } });
const owner = (actor: string, threadId: string | null = 'thread') => ({ account: actor, hostId: 'local-codex', threadId, projectId: null });
const output = (snapshot: any) => (snapshot.output ?? []).map((entry: any) => Buffer.from(entry.deltaBase64, 'base64').toString()).join('');
async function until(read: () => Promise<any>, accept: (value: any) => boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Terminal test timed out');
}
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'oc-hands-pty-'));
  const paths = deploymentPaths({ OPENCRAFT_DATA_DIR: join(root, 'state'), OPENCRAFT_WORKSPACE_DIR: join(root, 'work') });
  await mkdir(paths.runtimeDirectory, { recursive: true });
  const stop = await startHandsTerminal(paths, { verify: false });
  const services: ReturnType<typeof createHandsTerminalService>[] = [];
  const service = (tokenFile = paths.terminalToken) => { const value = createHandsTerminalService({ directory: paths.terminalDirectory, endpoint: paths.terminalEndpoint, tokenFile }); services.push(value); return value; };
  t.after(async () => { for (const service of services) service.close(); await stop(); await rm(root, { recursive: true, force: true }); });
  const spawn = (handle: string, cwd = paths.runtimeDirectory) => ({ processHandle: handle, cwd,
    command: ['/bin/bash', '--noprofile', '--norc'], tty: true, size: { cols: 80, rows: 24 }, threadId: 'thread' });
  return { root, paths, service, spawn };
}

test('Hands owns the same PTY across Host reconnections, with replay, input, resize and explicit termination', async t => {
  const f = await fixture(t), first = f.service(), scope = owner('alice');
  await first.dispatch('process/spawn', f.spawn('kept'), scope);
  await first.dispatch('process/writeStdin', { processHandle: 'kept', deltaBase64: Buffer.from("export KEPT=survives; printf 'FIRST_PID=%s\\n' $$\n").toString('base64') }, scope);
  const original = await until(() => first.dispatch('process/attach', { processHandle: 'kept', afterSequence: 0 }, scope), value => /FIRST_PID=\d+/.test(output(value)));
  const pid = output(original).match(/FIRST_PID=(\d+)/)![1]; first.close();
  const second = f.service();
  assert.equal((await second.dispatch('process/list', {}, owner('alice', null)) as any).processes.length, 1);
  await second.dispatch('process/resizePty', { processHandle: 'kept', size: { cols: 101, rows: 33 } }, scope);
  await second.dispatch('process/writeStdin', { processHandle: 'kept', deltaBase64: Buffer.from("printf 'SECOND_PID=%s VALUE=%s\\n' $$ \"$KEPT\"; stty size\n").toString('base64') }, scope);
  const replay = await until(() => second.dispatch('process/attach', { processHandle: 'kept', afterSequence: original.nextSequence }, scope), value => output(value).includes('33 101'));
  assert.match(output(replay), new RegExp(`SECOND_PID=${pid} VALUE=survives`));
  await second.dispatch('process/kill', { processHandle: 'kept' }, scope);
  await until(() => second.dispatch('process/attach', { processHandle: 'kept', afterSequence: 0 }, scope), value => value.phase === 'exited');
});

test('private socket authentication, account/Host scope and physical workspace boundaries fail closed', async t => {
  const f = await fixture(t), service = f.service();
  await service.dispatch('process/spawn', f.spawn('private'), owner('alice'));
  assert.equal((await service.dispatch('process/list', {}, owner('bob')) as any).processes.length, 0);
  await assert.rejects(service.dispatch('process/attach', { processHandle: 'private', afterSequence: 0 }, owner('bob')), /unavailable/);
  await assert.rejects(service.dispatch('process/kill', { processHandle: 'private' }, { ...owner('alice'), hostId: 'other' }), /unavailable/);
  await assert.rejects(service.dispatch('process/attach', { processHandle: 'private', afterSequence: 0 }, owner('alice', 'other')), /unavailable/);
  await assert.rejects(service.dispatch('process/spawn', f.spawn('escape', '/'), owner('alice')), /unavailable/);
  await symlink('/', join(f.paths.runtimeDirectory, 'escape'));
  await assert.rejects(service.dispatch('process/spawn', f.spawn('symlink', join(f.paths.runtimeDirectory, 'escape')), owner('alice')), /unavailable/);
  const token = join(f.root, 'wrong.token'); await writeFile(token, '0'.repeat(64), { mode: 0o600 });
  await assert.rejects(f.service(token).probe(), /closed/);
  assert.equal((await service.dispatch('process/list', {}, owner('alice')) as any).processes.length, 1);
});

test('terminal environment contains execution values and explicit overlay, without Brain credentials or loader overrides', async t => {
  const f = await fixture(t), service = f.service();
  const old = process.env.OPENCRAFT_TEST_BRAIN_SECRET; process.env.OPENCRAFT_TEST_BRAIN_SECRET = 'should-never-cross';
  t.after(() => { if (old === undefined) delete process.env.OPENCRAFT_TEST_BRAIN_SECRET; else process.env.OPENCRAFT_TEST_BRAIN_SECRET = old; });
  await assert.rejects(service.dispatch('process/spawn', { ...f.spawn('bad-env'), env: { NODE_OPTIONS: '--import evil' } }, owner('alice')), /reserved/);
  await service.dispatch('process/spawn', { ...f.spawn('env'), env: { TERMINAL_VALUE: 'visible' } }, owner('alice'));
  await service.dispatch('process/writeStdin', { processHandle: 'env', deltaBase64: Buffer.from("printf 'VALUE=%s SECRET=%s\\n' \"$TERMINAL_VALUE\" \"$OPENCRAFT_TEST_BRAIN_SECRET\"\n").toString('base64') }, owner('alice'));
  const result = await until(() => service.dispatch('process/attach', { processHandle: 'env', afterSequence: 0 }, owner('alice')), value => /VALUE=visible SECRET=\r?\n/.test(output(value)));
  assert.ok(!output(result).includes('should-never-cross'));
});

test('Hands defaults missing character locale to UTF-8 and preserves explicit locale choices', async t => {
  const keys = ['LANG', 'LC_ALL', 'LC_CTYPE'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  } });
  for (const key of keys) delete process.env[key];
  const f = await fixture(t), service = f.service(), scope = owner('locale');
  const cases = [
    { id: 'default-paste', env: {}, paste: true, utf8: true },
    { id: 'default-typing', env: {}, paste: false, utf8: true },
    { id: 'empty-locale', env: { LANG: '', LC_ALL: '', LC_CTYPE: '' }, paste: true, utf8: true },
    { id: 'explicit-lang', env: { LANG: 'C' }, paste: true, utf8: false },
    { id: 'explicit-all', env: { LC_ALL: 'C' }, paste: true, utf8: false },
    { id: 'explicit-ctype', env: { LC_CTYPE: 'C' }, paste: true, utf8: false },
    { id: 'inherited-ctype', env: {}, inherited: 'C', paste: true, utf8: false },
  ];
  for (const sample of cases) {
    if (sample.inherited) process.env.LC_CTYPE = sample.inherited; else delete process.env.LC_CTYPE;
    await service.dispatch('process/spawn', { ...f.spawn(sample.id), env: sample.env }, scope);
    const read = () => service.dispatch('process/attach', { processHandle: sample.id, afterSequence: 0 }, scope);
    await until(read, value => output(value).includes('$ '));
    const text = '中文输入测试';
    const escapedChinese = [344, 270, 255].map(octal => String.fromCharCode(92) + octal).join('');
    await service.dispatch('process/writeStdin', { processHandle: sample.id,
      deltaBase64: Buffer.from(sample.paste ? '[200~' + text + '[201~' : text).toString('base64') }, scope);
    const result = await until(read, value => sample.utf8 ? output(value).includes(text) : output(value).includes(escapedChinese));
    if (sample.utf8) assert.ok(!output(result).includes(escapedChinese), sample.id);
    else assert.ok(!output(result).includes(text), sample.id);
    await service.dispatch('process/kill', { processHandle: sample.id }, scope);
  }
});

test('unified Host transport preserves engine methods, routes PTYs away from native and rechecks revoked output authority', async t => {
  const f = await fixture(t), native = new Engine(), service = f.service();
  let valid = true;
  const transport = new HostTerminalTransport(native, service, (context, params) => {
    if (!valid || !context.actorContext) throw new Error('revoked');
    return owner(context.actorContext.actorId, params.threadId ?? null);
  });
  t.after(() => transport.close()); const messages: any[] = [];
  transport.subscribeMessage(frame => messages.push(JSON.parse(frame)));
  await transport.connect();
  await transport.sendWithContext(JSON.stringify({ id: 1, method: 'initialize', params: {}, [LOGICAL_CLIENT_FIELD]: 'alice-client' }), context('alice'));
  const methods = messages[0].result.capabilities.extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION].methods;
  assert.ok(methods.includes('thread/read') && methods.includes('process/list') && methods.includes('process/attach'));
  const call = async (id: number, method: string, params: any, actor = 'alice', client = 'alice-client') => {
    await transport.sendWithContext(JSON.stringify({ id, method, params, identity: { owner: 'alice' }, [LOGICAL_CLIENT_FIELD]: client }), context(actor));
    return messages.find(value => value.id === id);
  };
  assert.equal((await call(2, 'process/spawn', f.spawn('transport'))).error, undefined);
  await transport.sendWithContext(JSON.stringify({ id: 3, method: 'initialize', params: {}, [LOGICAL_CLIENT_FIELD]: 'bob-client' }), context('bob'));
  assert.ok((await call(4, 'process/attach', { processHandle: 'transport', afterSequence: 0 }, 'bob', 'bob-client')).error);
  assert.ok(!native.frames.some(value => value.method.startsWith('process/')));
  valid = false; const before = messages.length;
  await service.dispatch('process/writeStdin', { processHandle: 'transport', deltaBase64: Buffer.from("echo NO_LEAK\n").toString('base64') }, owner('alice'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(messages.length, before);
});

test('an unavailable Hands owner does not break engine connection or silently execute a local process', async t => {
  const f = await fixture(t), token = join(f.root, 'missing.token'), native = new Engine();
  const transport = new HostTerminalTransport(native, f.service(token), () => owner('alice'));
  t.after(() => transport.close()); const messages: any[] = [];
  transport.subscribeMessage(frame => messages.push(JSON.parse(frame))); await transport.connect();
  await transport.sendWithContext(JSON.stringify({ id: 1, method: 'initialize', params: {} }), context('alice'));
  assert.equal(messages[0].result.capabilities.extensions['opencraft/terminal'].available, false);
  assert.ok(!messages[0].result.capabilities.extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION].methods.includes('process/spawn'));
  await transport.sendWithContext(JSON.stringify({ id: 2, method: 'process/spawn', params: f.spawn('no-fallback') }), context('alice'));
  assert.ok(messages[1].error); assert.equal(native.frames.length, 1);
});

test('authenticated Gateway AppHost routes the existing terminal protocol to Hands and reattaches after browser reconnect', async t => {
  const f = await fixture(t), native = new Engine(), webRoot = join(f.root, 'web');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>Terminal integration fixture</title>');
  await writeFile(join(webRoot, 'version.json'), JSON.stringify({ schemaVersion: 1, buildId: 'terminal-test', headlessServer: true, headlessHostId: 'opencraft-server' }));
  const principal = { provider: 'terminal-fixture', subject: 'alice', displayName: 'Alice', expiresAt: Date.now() + 60000 };
  const agent = new WebSocketServer({ port: 0, host: '127.0.0.1' }), agentEngines: Engine[] = [];
  await new Promise<void>(resolve => agent.once('listening', resolve));
  t.after(async () => { for (const socket of agent.clients) socket.terminate(); await new Promise<void>(resolve => agent.close(() => resolve())); });
  agent.on('connection', socket => {
    const engine = new Engine(); agentEngines.push(engine);
    engine.subscribeMessage(frame => { if (socket.readyState === WebSocket.OPEN) socket.send(frame); });
    socket.on('message', raw => { void engine.send(raw.toString()); });
  });
  const app = await startHeadlessServer({ root: f.root, webRoot, dataDirectory: join(f.root, 'gateway'), port: 0,
    accessMemberProviders: [principal.provider],
    terminalOwner: { directory: f.paths.terminalDirectory, endpoint: f.paths.terminalEndpoint, tokenFile: f.paths.terminalToken },
    createCodexTransport: () => native,
    startAgentHost: async () => ({ websocketUrl: `ws://127.0.0.1:${(agent.address() as any).port}/rpc`, close() {} }),
  }, { createIdentity: async () => ({ providers: [{ authenticate: (request: any) => request.headers['x-fixture-proof'] === 'verified' ? principal : null }], close() {} }) });
  t.after(() => app.close());
  let sequence = 0;
  async function browser(rendererId: string, hostId = 'local-codex') {
    const socket = new WebSocket(app.url.replace(/^http/, 'ws') + '/apphost', { origin: app.url, headers: { 'x-fixture-proof': 'verified' } });
    t.after(() => socket.terminate());
    const frames: any[] = [];
    socket.on('message', raw => frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const wait = (accept: (frame: any) => boolean) => until(async () => frames.find(accept), Boolean);
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, rendererId }));
    await wait(frame => frame.type === 'ready');
    socket.send(JSON.stringify({ type: 'host/connect', requestId: 'connect', hostId, leaseId: rendererId }));
    const connected = await wait(frame => frame.type === 'response' && frame.requestId === 'connect');
    assert.equal(connected.ok, true);
    async function rpc(method: string, params: any = {}) {
      const id = ++sequence;
      socket.send(JSON.stringify({ type: 'host/send', requestId: String(id), hostId, leaseId: rendererId,
        generation: connected.result.generation, frame: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }));
      const response = await wait(frame => frame.type === 'host/frame' && JSON.parse(frame.frame).id === id);
      const reply = JSON.parse(response.frame);
      assert.equal(reply.error, undefined, JSON.stringify(reply));
      return reply.result;
    }
    const initialized = await rpc('initialize', { clientInfo: { name: 'terminal-fixture', version: '1' } });
    assert.equal(initialized.capabilities.extensions['opencraft/terminal'].available, true);
    return { socket, rpc };
  }
  const first = await browser('first');
  await first.rpc('process/spawn', f.spawn('gateway'));
  await first.rpc('process/writeStdin', { processHandle: 'gateway', deltaBase64: Buffer.from("export BROWSER_STATE=preserved; printf 'BROWSER_PID=%s\\n' $$\n").toString('base64') });
  const original = await until(() => first.rpc('process/attach', { processHandle: 'gateway', afterSequence: 0 }), value => /BROWSER_PID=\d+/.test(output(value)));
  const pid = output(original).match(/BROWSER_PID=(\d+)/)![1];
  await new Promise<void>(resolve => { first.socket.once('close', resolve); first.socket.close(); });
  const second = await browser('second');
  assert.ok((await second.rpc('process/list')).processes.some((process: any) => process.processHandle === 'gateway'));
  await second.rpc('process/writeStdin', { processHandle: 'gateway', deltaBase64: Buffer.from("printf 'RESTORED_PID=%s STATE=%s\\n' $$ \"$BROWSER_STATE\"\n").toString('base64') });
  const replay = await until(() => second.rpc('process/attach', { processHandle: 'gateway', afterSequence: original.nextSequence }), value => /STATE=preserved/.test(output(value)));
  assert.match(output(replay), new RegExp(`RESTORED_PID=${pid} STATE=preserved`));
  await second.rpc('process/kill', { processHandle: 'gateway' });
  assert.ok(!native.frames.some(frame => frame.method.startsWith('process/')));
  await second.rpc('process/spawn', f.spawn('archive-owned'));
  await second.rpc('thread/archive', {threadId:'thread'});
  const privateOwner=f.service();
  await until(()=>privateOwner.threadScopes(), scopes=>Array.isArray(scopes));
  // A direct private poll asks the actual owner, not a renderer's removed tab.
  await until(async()=>{
    const list=await second.rpc('process/list');
    return list.processes.find((p:any)=>p.processHandle==='archive-owned')?.phase;
  },phase=>phase==='exited');

  // The shipped Server UI also uses /appserver. It must use the very same
  // owner and authority as its AppHost lease, without forwarding to DSH.
  const raw = new WebSocket(app.url.replace(/^http/, 'ws') + '/appserver', { origin: app.url, headers: { 'x-fixture-proof': 'verified' } });
  t.after(() => raw.terminate()); const replies: any[] = [];
  raw.on('message', frame => replies.push(JSON.parse(frame.toString())));
  await new Promise<void>((resolve, reject) => { raw.once('open', resolve); raw.once('error', reject); });
  async function rawRpc(method: string, params: any = {}) {
    const id = ++sequence; raw.send(JSON.stringify({ id, method, params }));
    const reply = await until(async () => replies.find(frame => frame.id === id), Boolean);
    assert.equal(reply.error, undefined, JSON.stringify(reply)); return reply.result;
  }
  const initialized = await rawRpc('initialize');
  assert.equal(initialized.capabilities.extensions['opencraft/terminal'].available, true);
  await rawRpc('process/spawn', f.spawn('raw-server'));
  await rawRpc('process/writeStdin', { processHandle: 'raw-server', deltaBase64: Buffer.from("printf 'RAW_GATEWAY_PID=%s\\n' $$\n").toString('base64') });
  const fromRaw = await until(() => rawRpc('process/attach', { processHandle: 'raw-server', afterSequence: 0 }), value => /RAW_GATEWAY_PID=\d+/.test(output(value)));
  await new Promise<void>(resolve => { raw.once('close', resolve); raw.close(); });
  const serverLease = await browser('server-lease', 'opencraft-server');
  const fromLease = await serverLease.rpc('process/attach', { processHandle: 'raw-server', afterSequence: 0 });
  assert.equal(output(fromLease).match(/RAW_GATEWAY_PID=(\d+)/)![1], output(fromRaw).match(/RAW_GATEWAY_PID=(\d+)/)![1]);
  await serverLease.rpc('process/kill', { processHandle: 'raw-server' });
  assert.ok(agentEngines.every(engine => !engine.frames.some(frame => frame.method.startsWith('process/'))));
});

test('draft resource adoption is scoped to the creating human as well as the scope alias', async t => {
  const f=await fixture(t),service=f.service(),alice=owner('alice',null),bob=owner('bob',null);
  await service.dispatch('process/spawn',{...f.spawn('draft-a'),threadId:null,resourceOwnerId:'same-draft'},alice);
  await service.dispatch('process/spawn',{...f.spawn('draft-b'),threadId:null,resourceOwnerId:'same-draft'},bob);
  await service.releaseThread('local-codex','bound-thread',false,[{owner:terminalResourceOwnerId('alice','local-codex'),resourceOwnerId:'same-draft'}]);
  assert.equal((await service.dispatch('process/attach',{processHandle:'draft-a',afterSequence:0},alice) as any).phase,'exited');
  assert.equal((await service.dispatch('process/attach',{processHandle:'draft-b',afterSequence:0},bob) as any).phase,'running');
  await assert.rejects(service.dispatch('process/spawn',{...f.spawn('late-draft'),threadId:null,resourceOwnerId:'same-draft'},alice));
});
