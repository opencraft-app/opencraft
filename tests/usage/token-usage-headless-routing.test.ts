import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { startHeadlessServer } from '../../scripts/headless-server.mjs';
import { readDaemonMachineIdentity } from '../../apps/opencraft-daemon/src/machine-identity.js';
import { TokenUsageStateDatabase } from '../../apps/opencraft-daemon/src/token-usage-state-database.js';
import { OpenCraftTokenUsageLedger } from '../../apps/opencraft-daemon/src/token-usage-ledger.js';

for (const identityOverlay of [false, true]) for (const entry of ['apphost', 'appserver']) for (const engine of ['dsh', 'pi']) test(`Headless ${engine} ${entry} identity=${identityOverlay} entry queries existing deployment statistics without Codex startup`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'usage-headless-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const webRoot = join(root, 'web'), dataDirectory = join(root, 'data');
  await mkdir(webRoot); await writeFile(join(webRoot, 'index.html'), '<title>Fixture</title>');
  await writeFile(join(webRoot, 'version.json'), JSON.stringify({ schemaVersion: 1, buildId: 'test', headlessServer: true, headlessHostId: 'opencraft-server' }));
  const native = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(native, 'listening');
  let nativeQueries = 0;
  native.on('connection', ws => ws.on('message', raw => {
    const request = JSON.parse(raw.toString());
    if (request.method?.startsWith('opencraft/token-usage/')) nativeQueries++;
    if (request.id !== undefined) ws.send(JSON.stringify({ ...request, method: undefined, params: undefined,
      ...(request.method === 'initialize' ? { result: { capabilities: { extensions: {} } } } : { error: { code: -32603, message: `Method not supported by OpenCraft DSH host: ${request.method}` } }) }));
  }));
  t.after(async () => { for (const ws of native.clients) ws.terminate(); await new Promise<void>(resolve => native.close(() => resolve())); });
  const principal = { provider: 'fixture', subject: 'operator', displayName: 'Operator', expiresAt: Date.now() + 60_000 };
  const member = { ...principal, subject: 'member' };
  const memberHeaders = { 'x-test-identity': 'member' };
  const headers = { 'x-test-identity': 'verified' };
  const app = await startHeadlessServer({ root, webRoot, dataDirectory, port: 0, engines: [engine], defaultEngine: engine,
    accessMemberProviders: ['fixture'], codexExecutable: '/must-not-start-codex',
    startAgentHost: async () => ({ websocketUrl: `ws://127.0.0.1:${(native.address() as any).port}`, close: async () => {} }),
  }, { createIdentity: async ({ membership }: any) => {
    membership.set(principal, 'admin', true, 'fixture');
    membership.set(member, 'member', true, 'fixture');
    return { ...(identityOverlay ? { createThreadMetadata: () => ({ methods: [], capabilities: {}, supports: () => false, async request() { throw new Error('Unsupported metadata method'); }, observeResult() {}, observeNotification() {}, close() {} }) } : {}), providers: [{ authenticate: (r: any) => r.headers['x-test-identity'] === 'verified' ? principal : r.headers['x-test-identity'] === 'member' ? member : null }], close() {} };
  } });
  t.after(() => app.close());
  const actor = (await (await fetch(app.url + '/__opencraft_actors/me', { headers })).json() as any).actor;
  const memberActor = (await (await fetch(app.url + '/__opencraft_actors/me', { headers: memberHeaders })).json() as any).actor;
  const machine = await readDaemonMachineIdentity(dataDirectory);
  const state = new TokenUsageStateDatabase(join(dataDirectory, 'codex'));
  const at = Date.parse('2026-10-21T00:00:00Z'), ledger = new OpenCraftTokenUsageLedger(state, `server:${machine.machineId}:codex`, () => at);
  const key = { threadId: 'existing', turnId: 'turn' };
  ledger.startTurn(key, at, 'human', true);
  ledger.recordInput(key, { inputId: 'input', actorId: actor.id, actorKind: 'human', mode: 'start', admission: 'confirmed' });
  ledger.recordInput(key, { inputId: 'member-input', actorId: memberActor.id, actorKind: 'human', mode: 'start', admission: 'confirmed' });
  ledger.recordSource({ ...key, lineage: 'native', sourceId: 'response', kind: 'response', version: 0, provider: 'p', model: 'm', counts: { totalTokens: '1200' } });
  state.close();
  const path = join(dataDirectory, 'codex', 'token-usage.sqlite'), before = await readFile(path);
  const socket = new WebSocket(app.url.replace('http:', 'ws:') + '/' + entry, { headers: { ...headers, origin: app.url } });
  const received: any[] = [];
  socket.on('message', raw => received.push(JSON.parse(raw.toString())));
  t.after(() => socket.terminate()); await once(socket, 'open');
  const wait = async (predicate: (value: any) => boolean) => {
    for (let n = 0; n < 500; n++) { const value = received.find(predicate); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Missing expected Host response');
  };
  let generation: number;
  if (entry === 'apphost') {
    socket.send(JSON.stringify({ type: 'hello', rendererId: 'usage-test', protocolVersion: 2 }));
    await wait(v => v.type === 'ready');
    socket.send(JSON.stringify({ type: 'host/connect', requestId: 'connect', hostId: 'opencraft-server', leaseId: 'lease' }));
    const connected = await wait(v => v.requestId === 'connect'); assert.equal(connected.ok, true);
    generation = connected.result.generation;
  }
  let id = 0;
  const rpc = async (method: string, params: object) => {
    const requestId = ++id, frame = JSON.stringify({ id: requestId, method, params });
    socket.send(entry === 'appserver' ? frame : JSON.stringify({ type: 'host/send', requestId: `rpc-${id}`, hostId: 'opencraft-server', leaseId: 'lease', generation, frame }));
    const result = await wait(v => entry === 'appserver' ? v.id === requestId : v.type === 'host/frame' && JSON.parse(v.frame).id === requestId);
    return entry === 'appserver' ? result : JSON.parse(result.frame);
  };
  const initialized = await rpc('initialize', { clientInfo: { name: 'test', version: '1' }, capabilities: {} });
  assert.equal(initialized.result.capabilities.extensions['opencraft/token-usage'].query, true);
  for (const scope of ['self', 'team']) {
    const reply = await rpc('opencraft/token-usage/query', { from: '2026-10-21', through: '2026-10-21', scope });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error)); assert.equal(reply.result.summary.tokens, scope === 'self' ? '600' : '1200');
  }
  if (entry === 'appserver') {
    // Separate admitted connections retain their own protocol and authority.
    for (const [authHeaders, expectedSelf, expectedTeam] of [[memberHeaders, '600', 403]] as const) {
      const other = new WebSocket(app.url.replace('http:', 'ws:') + '/appserver', { headers: { ...authHeaders, origin: app.url } });
      t.after(() => other.terminate());
      await once(other, 'open');
      const call = async (method: string, params: object) => {
        const response = once(other, 'message');
        other.send(JSON.stringify({ id: ++id, method, params }));
        return JSON.parse((await response)[0].toString());
      };
      await call('initialize', { clientInfo: { name: 'test', version: '1' }, capabilities: {} });
      for (const [scope, expected] of [['self', expectedSelf], ['team', expectedTeam]] as const) {
        const reply = await call('opencraft/token-usage/query', { from: '2026-10-21', through: '2026-10-21', scope });
        if (typeof expected === 'number') assert.equal(reply.error.code, expected);
        else assert.equal(reply.result.summary.tokens, expected);
      }
    }
    const anonymous = new WebSocket(app.url.replace('http:', 'ws:') + '/appserver', { headers: { origin: app.url } });
    t.after(() => anonymous.terminate());
    await assert.rejects(once(anonymous, 'open'), /Unexpected server response: 401/);
    // Non-query RPC remains on the native path.
    assert.equal((await rpc('fixture/unsupported', {})).error.code, engine === 'dsh' ? -32603 : -32000);
  }
  assert.equal(nativeQueries, 0);
  assert.deepEqual(await readFile(path), before, 'queries never mutate the ledger');
  assert.equal((await fetch(app.url + '/__opencraft_actors/me')).status, 401);
});
