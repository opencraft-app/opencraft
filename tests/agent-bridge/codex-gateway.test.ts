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
import { CodexProviderBridge } from '../../apps/opencraft-daemon/src/codex-provider-bridge.js';
import { localTestBackend } from './fixtures/local-backend.js';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
const token = 'private-test-token-00000000000000000000';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, predicate: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) { const v = await read(); if (predicate(v)) return v; await delay(15); }
  throw Error('Expected condition not observed');
}

test('bundled Codex bridge through durable Host and existing AppServer transport: opt-in, steer, gateway reattach and ID continuity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-p2a-'));
  const native = createServer(), control = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.end(JSON.stringify(req.url === '/launch' ? { dataDirectory: root, launch: { args: [], env: { OPENCRAFT_CODEX_POOL_AUTH_TOKEN: 'synthetic-test' }, auth: { type: 'chatgptAuthTokens', accessToken: 'synthetic-test', chatgptAccountId: 'opencraft-account-pool' } } } : { protocolVersion: 1, pid: process.pid, codexPid: process.pid, nativeSocket: join(root, 'native.sock') }));
  });
  const ws = new WebSocketServer({ server: native });
  let nativePeer: WebSocket | undefined, starts = 0, steers = 0;
  let approvalAnswer: unknown, approvalAnswers = 0;
  ws.on('connection', socket => {
    nativePeer = socket;
    socket.on('message', raw => {
      const f = JSON.parse(String(raw));
      if (f.id === 'native-approval' && f.result) { approvalAnswer = f.result; approvalAnswers++; }
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: f.id, result }));
      const event = (method: string, params: unknown) => socket.send(JSON.stringify({ method, params }));
      if (f.method === 'initialize') reply({ userAgent: 'codex/0.167.0' });
      if (f.method === 'thread/start') reply({ thread: { id: 'native-new', cwd: root, turns: [] } });
      if (f.method === 'turn/start' && f.params.clientUserMessageId === 'unknown-start') { socket.send(JSON.stringify({ id: f.id, error: { code: -32000, message: 'Opaque native failure' } })); return; }
      if (f.method === 'turn/start') {
        starts++; event('turn/started', { threadId: 'native-new', turn: { id: 'native-turn' } });
        event('item/started', { threadId: 'native-new', turnId: 'native-turn', item: { type: 'commandExecution', id: 'tool', command: 'cat input.txt', cwd: root, status: 'inProgress' } });
        reply({ turn: { id: 'native-turn', status: 'inProgress', items: [] } });
      }
      if (f.method === 'turn/steer') {
        steers++; assert.equal(f.params.expectedTurnId, 'native-turn');
        event('item/started', { threadId: 'native-new', turnId: 'native-turn', item: { type: 'userMessage', id: 'steer-item', clientId: f.params.clientUserMessageId, content: f.params.input } });
        reply({ turnId: 'native-turn' });
      }
      if (f.method === 'thread/read') reply({ thread: { id: 'native-new', turns: [{ id: 'native-turn', items: [{ type: 'commandExecution', id: 'tool', command: 'cat input.txt', commandActions: [{ type: 'business-data', threadId: 'business-thread', id: 'native-turn' }] }] }] } });
      if (f.method === 'thread/resume') reply({ thread: { id: 'native-new', turns: [] } });
    });
  });
  await new Promise<void>(r => native.listen(join(root, 'native.sock'), r));
  await new Promise<void>(r => control.listen(join(root, 'control.sock'), r));
  const config = join(root, 'core.json');
  await writeFile(config, JSON.stringify({ endpoint: join(root, 'control.sock'), token }), { mode: 0o600 });
  const artifact = join(root, 'codex.cjs');
  await build({ entryPoints: [resolve('apps/agent-bridge-host/src/codex-main.ts')], outfile: artifact, bundle: true, platform: 'node', format: 'cjs' });
  const host = await BridgeHost.open({ path: join(root, 'host.db'), policy: { id: 'p2a-test', capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 } }, backend: localTestBackend() });
  const attachment = await attachGateway(host, token);
  let transport: CodexProviderBridge | undefined;
  t.after(async () => { await transport?.close(); await attachment.close(); await host.close(); ws.close(); await Promise.all([new Promise<void>(r => native.close(() => r())), new Promise<void>(r => control.close(() => r()))]); await rm(root, { recursive: true, force: true }); });
  await host.add({ id: 'codex-1', artifact, digest: createHash('sha256').update(await readFile(artifact)).digest('hex'), provider: codexDeclaration, launch: { command: [process.execPath, artifact, config], cwd: root, env: {} } });
  await host.activate('codex-1', '');
  const frames: any[] = [], forwarded: any[] = [];
  let legacyListener: (frame: string) => void = () => {};
  const createTransport = async () => {
    const legacy = {
      status: { state: 'open' as const }, async connect() {}, async close() {}, subscribeStatus() { return () => {}; },
      subscribeMessage(listener: (frame: string) => void) { legacyListener = listener; return () => {}; },
      async send(raw: string) {
        const f = JSON.parse(raw); forwarded.push(f);
        if (f.id !== undefined) legacyListener(JSON.stringify({ id: f.id, [LOGICAL_CLIENT_FIELD]: 'client', result: f.method === 'initialize' ? { capabilities: {} } : { data: [{ id: 'native-old' }, { id: 'native-new' }] } }));
      },
    };
    const next = new CodexProviderBridge(legacy, { url: attachment.url, token, serverId: 'server', inboxPath: join(root, 'gateway.db') });
    next.subscribeMessage(raw => frames.push(JSON.parse(raw))); await next.connect(); return next;
  };
  transport = await createTransport();
  let sequence = 0;
  const request = async (method: string, params: unknown = {}) => {
    const id = ++sequence;
    await transport!.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: 'client' }));
    const frame = await until(() => frames.find(f => f.id === id), Boolean);
    assert.equal(frame.error, undefined, JSON.stringify(frame.error)); return frame.result;
  };
  await request('initialize', { capabilities: { extensions: { 'opencraft/steer-evidence': { version: 1 } } } });
  const created = await request('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only', agentBridge: { threadId: 'bridge:codex:public-new', clientRequestId: 'create' } });
  assert.equal(created.thread.id, 'bridge:codex:public-new');
  const started = await request('turn/start', { threadId: 'bridge:codex:public-new', clientUserMessageId: 'start', input: [{ type: 'text', text: 'read' }] });
  const turnId = started.turn.id; assert.notEqual(turnId, 'native-turn');
  nativePeer!.send(JSON.stringify({ id: 'native-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'native-new', turnId: 'native-turn', itemId: 'tool', command: 'cat input.txt' } }));
  const approval = await until(() => frames.find(f => f.method === 'item/commandExecution/requestApproval'), Boolean);
  assert.equal(approval.params.threadId, 'bridge:codex:public-new');
  assert.equal(approval.params.turnId, turnId); assert.notEqual(approval.params.itemId, 'tool');
  const answerApproval = () => transport!.send(JSON.stringify({ id: approval.id, result: { decision: 'decline' }, [LOGICAL_CLIENT_FIELD]: 'client' }));
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
  assert.deepEqual(approvalAnswer, { decision: 'decline' });
  await assert.rejects(answerApproval(), /Interaction subscription required/);
  assert.equal(approvalAnswers, 1);
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
  const beforeRestart = frames.filter(f => f.method === 'turn/started').length;
  await transport.close(); transport = await createTransport();
  await request('initialize'); await request('thread/resume', { threadId: 'bridge:codex:public-new' });
  assert.equal(frames.filter(f => f.id === approval.id && f.method === approval.method).length, 3, 'settled approval must not reappear from inbox replay');
  nativePeer!.send(JSON.stringify({ method: 'item/completed', params: { threadId: 'native-new', turnId: 'native-turn', item: { type: 'commandExecution', id: 'tool', command: 'cat input.txt', cwd: root, status: 'completed', aggregatedOutput: 'fixture' } } }));
  nativePeer!.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'native-new', turn: { id: 'native-turn', status: 'completed' } } }));
  await until(() => frames.some(f => f.method === 'turn/completed'), Boolean);
  assert.equal(frames.filter(f => f.method === 'turn/started').length, beforeRestart);
  const read = await request('thread/read', { threadId: 'bridge:codex:public-new', includeTurns: true });
  assert.equal(read.thread.id, 'bridge:codex:public-new'); assert.equal(read.thread.turns[0].id, turnId);
  assert.deepEqual(read.thread.turns[0].items[0].commandActions, [{ type: 'business-data', threadId: 'business-thread', id: 'native-turn' }]);
  const list = await request('thread/list'); assert.deepEqual(list.data.map((t: any) => t.id), ['native-old', 'bridge:codex:public-new']);
  const unknownId = ++sequence;
  await transport.send(JSON.stringify({ id: unknownId, method: 'turn/start', params: { threadId: 'bridge:codex:public-new', clientUserMessageId: 'unknown-start', input: [{ type: 'text', text: 'unknown' }] }, [LOGICAL_CLIENT_FIELD]: 'client' }));
  assert.equal(frames.find(f => f.id === unknownId)?.error?.data?.submissionOutcome, 'unknown');
  assert.equal(frames.find(f => f.id === unknownId)?.error?.data?.retryable, false);
  assert.match(frames.find(f => f.id === unknownId)?.error?.data?.bridgeCommandId, /^bridge-mutation:[a-f0-9]{64}$/);
  assert(!forwarded.some(f => f.method === 'turn/start' || f.method === 'turn/steer'));
});
