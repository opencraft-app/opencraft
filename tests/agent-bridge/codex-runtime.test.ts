import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexBridgeRuntime } from '../../apps/agent-bridge-host/src/codex-runtime.js';
import { CodexOwnerConnection } from '../../apps/agent-bridge-host/src/codex-owner.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { BridgeWireMessage } from '@opencraft/agent-bridge-protocol';
import { createBrowserGrantResolver } from '../../apps/headless-server/src/remote-browser/execution-grant.js';

test('history preserves bounded latest-turn queries for browser admission in multi-turn sessions', async () => {
  const calls: any[] = [], frames: any[] = [];
  const runtime = new CodexBridgeRuntime({ async request(method, params) {
    calls.push({ method, params });
    const turns = [{ id: 'active', status: 'inProgress' }, { id: 'previous', status: 'completed' }];
    return { data: turns.slice(0, Number(params.limit)), nextCursor: null };
  }, resolve() {} }, frame => frames.push(frame));
  await runtime.handle({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: 1, grammarRange: { min: 1, max: 1 } } });
  runtime.adapter.bind('public', 'native');
  const latest = async () => {
    await runtime.handle({ jsonrpc: '2.0', id: 'latest', method: 'history/read', params: {
      threadId: 'public', limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
    } });
    const result = frames.at(-1).result;
    return result.data.length === 1 ? result.data[0] : null;
  };
  const context = { actorId: 'human', generation: 1, credentialId: null, expiresAt: Date.now() + 60000 };
  const resolver = createBrowserGrantResolver({ serverForThread: () => 'server', hostForServer: () => 'host',
    source: async () => ({ context, authorityId: 'authority', turnId: 'active' }), authorize() {}, owner: c => c.actorId,
    currentTurn: latest,
  });
  assert.equal((await resolver({ serverId: 'server', threadId: 'public', execution: { inputId: 'input' } }, true)).turnId, 'active');
  assert.deepEqual(calls.at(-1), { method: 'thread/turns/list', params: { threadId: 'native', limit: 1, cursor: null, sortDirection: 'desc', itemsView: 'notLoaded' } });
  await runtime.handle({ jsonrpc: '2.0', id: 'page', method: 'history/read', params: { threadId: 'public', cursor: 'next', limit: 7, sortDirection: 'asc' } });
  assert.deepEqual(calls.at(-1).params, { threadId: 'native', limit: 7, cursor: 'next', itemsView: 'full', sortDirection: 'asc' });
  await runtime.handle({ jsonrpc: '2.0', id: 'items', method: 'history/read', params: { threadId: 'public', turnId: 'active', cursor: 'items-next', limit: 3 } });
  assert.deepEqual(calls.at(-1), { method: 'thread/items/list', params: { threadId: 'native', turnId: 'active', limit: 3, cursor: 'items-next' } });
});

test('runtime gates initialization, preserves native permission parameters, refuses foreign resume and double approvals', async () => {
  const calls: Array<{ method: string; params: any }> = [], frames: BridgeWireMessage[] = [];
  const resolutions: unknown[] = [];
  const runtime = new CodexBridgeRuntime({ async request(method, params) { calls.push({ method, params }); return { thread: { id: 'native' } }; }, resolve(id, result) { resolutions.push({ id, result }); } }, f => frames.push(f));
  const command = async (method: string, params: unknown) => { await runtime.handle({ jsonrpc: '2.0', id: 'request', method, params }); return frames.at(-1) as any; };
  assert.equal((await command('session/create', {})).error.kind, 'explicit-reject');
  assert.equal((await command('initialize', { protocolVersion: 1, grammarRange: { min: 1, max: 1 } })).result.effectiveCapabilities.steer.withdrawal, 'none');
  assert.equal((await command('session/resume', { threadId: 'foreign' })).error.kind, 'explicit-reject');
  const native = { cwd: '/workspace', approvalPolicy: 'on-request', sandbox: 'read-only' };
  assert('result' in await command('session/create', { threadId: 'public', native }));
  assert.deepEqual(calls[0], { method: 'thread/start', params: native });
  runtime.interaction(123, 'item/commandExecution/requestApproval', { threadId: 'native', turnId: 'turn', command: 'true' });
  const callback = frames.at(-1) as any;
  assert.equal(callback.method, 'interaction/request');
  const params = { threadId: 'public', interactionId: callback.params.interactionId, result: { decision: 'accept' } };
  assert('result' in await command('interaction/resolve', params));
  assert.equal((await command('interaction/resolve', params)).error.kind, 'explicit-reject');
  assert.equal(resolutions.length, 1);
});

test('real Unix WebSocket Upgrade attaches existing owner, stale error is typed, close never stops owner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-owner-'));
  const native = createServer(), control = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer private-test-token');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/launch' ? { dataDirectory: root, launch: { args: [], env: { OPENCRAFT_CODEX_POOL_AUTH_TOKEN: 'synthetic-test' }, auth: { type: 'chatgptAuthTokens', accessToken: 'synthetic-test', chatgptAccountId: 'opencraft-account-pool' } } } : { protocolVersion: 1, pid: process.pid, codexPid: process.pid, nativeSocket: join(root, 'native.sock') }));
  });
  const ws = new WebSocketServer({ server: native });
  let mutations = 0, refreshed!: (value: unknown) => void;
  const refreshResponse = new Promise(resolve => { refreshed = resolve; });
  ws.on('connection', socket => socket.on('message', raw => {
    const frame = JSON.parse(String(raw));
    if (frame.id === 'native-refresh' && frame.result) refreshed(frame.result);
    if (frame.method === 'initialized') socket.send(JSON.stringify({ id: 'native-refresh', method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized' } }));
    if (frame.method === 'initialize') socket.send(JSON.stringify({ id: frame.id, result: { userAgent: 'codex/0.167.0' } }));
    if (frame.method === 'turn/steer') { mutations++; socket.send(JSON.stringify({ id: frame.id, error: { code: -32602, message: 'no active turn to steer' } })); }
  }));
  await new Promise<void>(resolve => native.listen(join(root, 'native.sock'), resolve));
  await new Promise<void>(resolve => control.listen(join(root, 'control.sock'), resolve));
  const owner = new CodexOwnerConnection(join(root, 'control.sock'), 'private-test-token', () => {}, () => {}, () => {});
  t.after(async () => { owner.close(); ws.close(); await Promise.all([new Promise<void>(resolve => native.close(() => resolve())), new Promise<void>(resolve => control.close(() => resolve()))]); await rm(root, { recursive: true, force: true }); });
  await owner.connect();
  assert.deepEqual(await refreshResponse, { accessToken: 'synthetic-test', chatgptAccountId: 'opencraft-account-pool' });
  await assert.rejects(owner.request('turn/steer', { threadId: 'native', expectedTurnId: 'old', input: [] }), (e: any) => e.kind === 'stale-target');
  assert.equal(mutations, 1);
  owner.close();
  assert.equal(native.listening, true); assert.equal(control.listening, true);
});

test('unknown paramless notifications and unrouteable server requests cannot kill native attachment', () => {
  const refused: (string | number)[] = [];
  const runtime = new CodexBridgeRuntime({ async request() { return {}; }, resolve() {}, reject(id) { refused.push(id); } }, () => {});
  assert.doesNotThrow(() => runtime.notification('future/provider-notification', null));
  assert.doesNotThrow(() => runtime.interaction(1, 'future/private-method', null));
  assert.doesNotThrow(() => runtime.interaction(2, 'item/commandExecution/requestApproval', { command: 'true' }));
  assert.deepEqual(refused, [1, 2]);
});

test('sanitized native 0.162.1 history recording preserves failed outcome without replaying a mutation', async () => {
  const { readFile } = await import('node:fs/promises');
  const recording = JSON.parse(await readFile(new URL('./recordings/codex-0.162.1-history.json', import.meta.url), 'utf8'));
  const frames: BridgeWireMessage[] = [], calls: string[] = [];
  const runtime = new CodexBridgeRuntime({ async request(method, params) { calls.push(method); assert.equal(method, 'thread/read'); assert.equal(params.threadId, 'native-recorded-thread'); return recording.response; }, resolve() {} }, frame => frames.push(frame));
  await runtime.handle({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: 1, grammarRange: { min: 1, max: 1 } } });
  runtime.adapter.bind('recorded-public', 'native-recorded-thread');
  await runtime.handle({ jsonrpc: '2.0', id: 'read', method: 'history/read', params: { threadId: 'recorded-public', view: 'thread', includeTurns: true } });
  const reply = frames.at(-1) as any;
  assert.equal(reply.result.thread.turns[0].status, 'failed');
  assert.equal(reply.result.thread.turns[0].error.codexErrorInfo.responseTooManyFailedAttempts.httpStatusCode, 429);
  assert.deepEqual(calls, ['thread/read']);
});


test('native external resolution and owner loss retire the exact interaction without answering it', async () => {
  const frames: any[] = [], answers: unknown[] = [];
  const runtime = new CodexBridgeRuntime({ async request() { return {}; }, resolve(...answer) { answers.push(answer); } }, frame => frames.push(frame));
  runtime.adapter.bind('public', 'native');
  runtime.interaction(7, 'item/commandExecution/requestApproval', { threadId: 'native', turnId: 'turn' });
  const first = frames.at(-1).params.interactionId;
  runtime.notification('serverRequest/resolved', { threadId: 'another', requestId: 7 });
  assert.equal(frames.at(-1).method, 'interaction/request');
  runtime.notification('serverRequest/resolved', { threadId: 'native', requestId: 7 });
  assert.deepEqual(frames.at(-1).params, { threadId: 'public', interactionId: first, reason: 'resolved' });
  const count = frames.length;
  runtime.notification('serverRequest/resolved', { threadId: 'native', requestId: 7 });
  assert.equal(frames.length, count);
  runtime.interaction('7', 'item/commandExecution/requestApproval', { threadId: 'native', turnId: 'turn' });
  const second = frames.at(-1).params.interactionId;
  runtime.lost();
  assert(frames.some(frame => frame.method === 'interaction/resolved' && frame.params.interactionId === second && frame.params.reason === 'connection-lost'));
  assert.deepEqual(answers, []);
});

test('an idle existing native session is adopted under its own ID; an active or mismatched one is refused', async () => {
  const calls: any[] = [], frames: any[] = [];
  const status: Record<string, string> = { idle: 'notLoaded', busy: 'active', moved: 'idle' };
  const runtime = new CodexBridgeRuntime({ async request(method, params) {
    calls.push({ method, threadId: params.threadId });
    if (method === 'thread/read') return { thread: { id: params.threadId, status: { type: status[String(params.threadId)] } } };
    if (method === 'thread/resume') return { thread: { id: params.threadId === 'moved' ? 'elsewhere' : params.threadId } };
    return {};
  }, resolve() {} }, frame => frames.push(frame));
  await runtime.handle({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: 1, grammarRange: { min: 1, max: 1 } } });
  let attempt = 0;
  const adopt = async (id: string) => {
    const requestId = `adopt-${++attempt}`;
    await runtime.handle({ jsonrpc: '2.0', id: requestId, method: 'session/adopt', params: { threadId: id, providerThreadId: id } });
    return frames.find(f => f.id === requestId);
  };
  assert.equal((await adopt('idle')).result.thread.id, 'idle');
  assert.equal(runtime.adapter.nativeSession('idle'), 'idle');
  assert.ok(frames.some(f => f.method === 'thread/identity' && f.params.threadId === 'idle' && f.params.providerThreadId === 'idle'));
  assert.equal((await adopt('busy')).error.kind, 'explicit-reject', 'a session with a turn running stays where it is');
  assert.ok(!calls.some(c => c.method === 'thread/resume' && c.threadId === 'busy'));
  assert.equal((await adopt('moved')).error.kind, 'explicit-reject');
  assert.throws(() => runtime.adapter.nativeSession('moved'), /not bound/u);
  assert.equal((await adopt('idle')).error.kind, 'explicit-reject', 'adopting twice is refused');
});
