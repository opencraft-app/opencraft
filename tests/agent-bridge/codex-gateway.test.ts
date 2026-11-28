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
import type { Storage } from '../../apps/agent-bridge-host/src/storage.js';
import { attachGateway } from '../../apps/agent-bridge-host/src/server.js';
import { codexDeclaration } from '../../apps/agent-bridge-host/src/codex-declaration.js';
import { createServerCodexBridge } from '../../apps/opencraft-daemon/src/bridge-execution-admission';
import { CodexProviderBridge } from '../../apps/opencraft-daemon/src/codex-provider-bridge.js';
import { CodexProviderBridgeSession } from '../../apps/opencraft-daemon/src/codex-provider-bridge-session.js';
import { BridgeGatewaySession, BridgeOutboxReadError } from '../../apps/agent-bridge-host/src/gateway-session.js';
import { localTestBackend } from './fixtures/local-backend.js';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import { AppServerRpcError, type AppServerClient } from '@opencraft/appserver-client';
import { COLLABORATION_METHOD, encodeConversationRef } from '@opencraft/appserver-protocol/collaboration';
import type { TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import { BRIDGE_MAX_FRAME_BYTES } from '@opencraft/agent-bridge-protocol';
import { readTurnsPage } from '../../packages/appserver-session/src/history-strategies';
const token = 'private-test-token-00000000000000000000';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, predicate: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) { const v = await read(); if (predicate(v)) return v; await delay(15); }
  throw Error('Expected condition not observed');
}

for (const { status, manualPull, connects } of [
  { status: 503, manualPull: false, connects: true },
  { status: 409, manualPull: false, connects: false },
  { status: 503, manualPull: true, connects: false },
]) test(`initial Bridge read ${status}, manualPull=${manualPull} respects the scheduled retry owner`, async () => {
  let pulls = 0, nativeConnections = 0;
  const session = new CodexProviderBridgeSession({
    status: { state: 'open' },
    async connect() { nativeConnections++; },
    async close() {},
    subscribeStatus: () => () => {},
    subscribeMessage: () => () => {},
    async send() {},
  }, publish => new BridgeGatewaySession({
    serverId: 'fixture',
    async request(path) {
      assert.equal(path.split('?')[0], '/snapshot');
      return Response.json({ routes: [], nativeSessions: [], interactions: [] });
    },
    inbox: {
      async cursor() { return 0; },
      async read() { return []; },
      async readIdentities() { return []; }, async readPendingInteractions() { return []; },
      async pull() { if (++pulls === 1) throw new BridgeOutboxReadError(status); },
      async close() {},
    },
  }, publish), { manualPull });
  try {
    if (connects) {
      await session.connect();
      assert.equal(nativeConnections, 1);
      await until(() => pulls, count => count >= 2);
    } else {
      await assert.rejects(session.connect(), { status });
      assert.equal(nativeConnections, 0);
    }
  } finally { await session.close(); }
});

test('exclusive Codex bridge keeps passive legacy history reads on the native reader', async () => {
  const methods: string[] = [], releases: string[] = [];
  const session = new CodexProviderBridgeSession({
    status: { state: 'open' },
    async connect() {}, async close() {},
    subscribeStatus: () => () => {}, subscribeMessage: () => () => {},
    async send(raw) { methods.push(JSON.parse(raw).method); },
  }, publish => new BridgeGatewaySession({
    serverId: 'fixture',
    async request() { assert.fail('Passive native read must not send a bridge request'); },
    inbox: { async cursor() { return 0; }, async read() { return []; }, async readIdentities() { return []; }, async readPendingInteractions() { return []; },
      async pull() {}, async close() {} },
  }, publish), { exclusive: true, async releaseForAdoption(id) { releases.push(id); return false; } });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    session.sendWithContext(JSON.stringify({ id: method, method, params, [LOGICAL_CLIENT_FIELD]: 'fixture' }), { sender: null });
  await send('initialize');
  const passive = ['thread/read', 'thread/turns/list', 'thread/items/list', 'thread/searchOccurrences',
    'thread/queue/list', 'thread/queue/find', 'thread/queue/collaborationReceipt', 'thread/goal/get', 'opencraft/steer/status'];
  for (const method of passive)
    await send(method, { threadId: 'old-native-thread', ...(method === 'thread/read' ? { watch: false } : {}) });
  assert.deepEqual(releases, []);
  assert.deepEqual(methods, ['initialize', ...passive]);
  await send('thread/read', { threadId: 'old-native-thread', watch: true });
  assert.deepEqual(releases, ['old-native-thread']);
});

test('collaboration references for a Bridge conversation use the authorized Host lane and public identity', async () => {
  const threadId = 'bridge:codex:source';
  const context = { sender: null, validUntil: Date.now() + 60_000 };
  const reference = encodeConversationRef({ serverId: 'server:fixture:codex', threadId });
  const frames: any[] = [];
  let reply: (raw: string) => void;
  const session = new CodexProviderBridgeSession({
    status: { state: 'open' },
    async connect() {}, async close() {}, async send() { assert.fail('Expected trusted context'); },
    subscribeStatus: () => () => {},
    subscribeMessage(listener) { reply = listener; return () => {}; },
    async sendWithContext(raw, received) {
      assert.equal(received, context);
      const frame = JSON.parse(raw);
      if (frame.method === 'initialize') return;
      assert.equal(frame.method, COLLABORATION_METHOD);
      assert.deepEqual(frame.params, { action: 'reference', threadId });
      reply(JSON.stringify({ id: frame.id, result: { reference }, [LOGICAL_CLIENT_FIELD]: 'fixture' }));
    },
  }, publish => {
    const gateway = new BridgeGatewaySession({
      serverId: 'fixture',
      async request() { assert.fail('Collaboration must not dispatch an engine command'); },
      inbox: { async cursor() { return 0; }, async read() { return []; }, async readIdentities() { return []; },
        async readPendingInteractions() { return []; }, async pull() {}, async close() {} },
    }, publish);
    gateway.reserve(threadId);
    return gateway;
  }, { exclusive: true, async releaseForAdoption() { assert.fail('Collaboration must not adopt a thread'); } });
  const send = (method: string, params = {}) => session.sendWithContext(JSON.stringify({
    id: method, method, params, [LOGICAL_CLIENT_FIELD]: 'fixture',
  }), context);
  session.subscribeMessage(raw => frames.push(JSON.parse(raw)));
  try {
    await send('initialize');
    await send(COLLABORATION_METHOD, { action: 'reference', threadId });
    assert.deepEqual(frames.find(frame => frame.id === COLLABORATION_METHOD)?.result, { reference });
  } finally { await session.close(); }
});

for (const transition of ['none', 'unsubscribe', 'archive-and-reopen']) test(`a watched history read sends its result before restoring approvals, transition=${transition}`, async () => {
  const threadId = 'bridge:codex:history-with-approval';
  let publish!: (threadId: string, frame: unknown) => void;
  let restores = 0;
  const pending = Promise.withResolvers<unknown[]>();
  const entered = Promise.withResolvers<void>();
  const frames: { id?: string; method?: string; result?: unknown }[] = [];
  const session = new CodexProviderBridgeSession({
    status: { state: 'open' },
    async connect() {}, async close() {}, async send() {},
    subscribeStatus: () => () => {}, subscribeMessage: () => () => {},
  }, deliver => {
    publish = deliver;
    const gateway = new BridgeGatewaySession({
      serverId: 'fixture',
      async request(path) {
        assert.equal(path, '/observe');
        return Response.json({ thread: { id: threadId, turns: [] } });
      },
      inbox: { async cursor() { return 0; }, async read() { return []; }, async readIdentities() { return []; }, async readPendingInteractions() { return []; },
        async pull() {}, async close() {} },
    }, deliver);
    gateway.reserve(threadId);
    gateway.pendingInteractions = async () => {
      if (++restores > 1) return [];
      entered.resolve();
      return pending.promise;
    };
    return gateway;
  });
  const send = (method: string, params = {}) => session.send(JSON.stringify({
    id: method, method, params, [LOGICAL_CLIENT_FIELD]: 'fixture',
  }));
  session.subscribeMessage(raw => frames.push(JSON.parse(raw)));
  const requests = [{
    method: 'interaction/request',
    params: { interactionId: 'approval', payload: {
      method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn', itemId: 'command' },
    } },
  }];
  await send('initialize');
  const watching = send('thread/read', { threadId, watch: true });
  try {
    await entered.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(frames.find(frame => frame.id === 'thread/read')?.result, { thread: { id: threadId, turns: [] } });
    await watching;
    if (transition === 'unsubscribe') await send('thread/unsubscribe', { threadId });
    if (transition === 'archive-and-reopen') {
      publish(threadId, { method: 'thread/archived', params: { threadId } });
      publish(threadId, { method: 'thread/unarchived', params: { threadId } });
      await send('thread/read', { threadId, watch: true });
      assert.equal(restores, 2, 'reopening should admit a fresh approval read');
    }
    pending.resolve(requests);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.some(frame => frame.method === 'item/commandExecution/requestApproval'), transition === 'none');
  } finally {
    pending.resolve(requests);
    await watching;
    await session.close();
  }
});

for (const archiveDuringRead of [false, true]) test(`archived watched history does not attach a live subscription, race=${archiveDuringRead}`, async () => {
  const threadId = 'bridge:codex:archived-history';
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const frames: any[] = [];
  const pending = [{ method: 'interaction/request', params: {
    interactionId: 'approval', payload: { method: 'item/commandExecution/requestApproval',
      params: { threadId, turnId: 'turn', itemId: 'command' } },
  } }];
  let reads = 0, recoveries = 0, archived = !archiveDuringRead, omitArchiveState = false;
  let publish!: (threadId: string, frame: unknown) => void;
  const session = new CodexProviderBridgeSession({
    status: { state: 'open' }, async connect() {}, async close() {}, async send() {},
    subscribeStatus: () => () => {}, subscribeMessage: () => () => {},
  }, deliver => {
    publish = deliver;
    const gateway = new BridgeGatewaySession({
      serverId: 'fixture',
      async request(path) {
        if (path === '/queue') return Response.json({ data: [], steering: [], nextCursor: null });
        assert.equal(path, '/observe');
        const metadata = { id: threadId, turns: [], ...(omitArchiveState ? {} : { archived }) };
        if (++reads === 1) { entered.resolve(); await release.promise; }
        return Response.json({ thread: metadata });
      },
      inbox: { async cursor() { return 0; }, async read() { return []; }, async readIdentities() { return []; },
        async readPendingInteractions() { return []; }, async pull() {}, async close() {} },
    }, deliver);
    gateway.reserve(threadId);
    gateway.pendingInteractions = async () => { recoveries++; return pending; };
    gateway.command = async () => ({ goal: null });
    return gateway;
  });
  session.subscribeMessage(raw => frames.push(JSON.parse(raw)));
  const send = (id: string, method: string, params = {}) => session.send(JSON.stringify({
    id, method, params, [LOGICAL_CLIENT_FIELD]: 'fixture',
  }));
  const related = { method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn', itemId: 'reply', delta: 'late' } };
  await send('init', 'initialize');
  await send('queue', 'thread/queue/list', { threadId });
  assert.deepEqual(frames.find(frame => frame.id === 'queue')?.result?.data, []);
  await send('goal', 'thread/goal/get', { threadId });
  assert.equal(frames.find(frame => frame.id === 'goal')?.result?.goal, null);
  publish(threadId, related);
  const history = send('archive-read', 'thread/read', { threadId, watch: true, openArchivedHistory: true });
  try {
    await entered.promise;
    if (archiveDuringRead) {
      archived = true;
      publish(threadId, { method: 'thread/archived', params: { threadId } });
    }
    publish(threadId, related);
    release.resolve();
    await history;
    assert.ok(frames.find(frame => frame.id === 'archive-read')?.result?.thread);
    publish(threadId, related);
    assert.equal(recoveries, 0);
    assert.ok(!frames.some(frame => frame.method === related.method || frame.method === 'item/commandExecution/requestApproval'));
    if (archiveDuringRead) assert.ok(frames.some(frame => frame.method === 'thread/archived'));
    omitArchiveState = true;
    await send('legacy-read', 'thread/read', { threadId, watch: true, openArchivedHistory: true });
    assert.equal(recoveries, 0, 'missing metadata cannot reopen an already archived subscription');
    archived = false;
    publish(threadId, { method: 'thread/unarchived', params: { threadId } });
    assert.ok(frames.some(frame => frame.method === 'thread/unarchived'));
    await send('active-read', 'thread/read', { threadId, watch: true });
    await until(() => frames.find(frame => frame.method === 'item/commandExecution/requestApproval'), Boolean);
    assert.equal(recoveries, 1);
  } finally {
    release.resolve();
    await history;
    await session.close();
  }
});

test('a watched full history read attaches after metadata and before requesting the body', async () => {
  const threadId = 'bridge:codex:live-history';
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const frames: any[] = [];
  const requested: boolean[] = [];
  let publish!: (threadId: string, frame: unknown) => void;
  const session = new CodexProviderBridgeSession({
    status: { state: 'open' }, async connect() {}, async close() {}, async send() {},
    subscribeStatus: () => () => {}, subscribeMessage: () => () => {},
  }, deliver => {
    publish = deliver;
    const gateway = new BridgeGatewaySession({
      serverId: 'fixture',
      async request(path, body) {
        assert.equal(path, '/observe');
        const includeTurns = (body as { params: { includeTurns: boolean } }).params.includeTurns;
        requested.push(includeTurns);
        if (includeTurns) { entered.resolve(); await release.promise; }
        return Response.json({ thread: { id: threadId, turns: [] } });
      },
      inbox: { async cursor() { return 0; }, async read() { return []; }, async readIdentities() { return []; },
        async readPendingInteractions() { return []; }, async pull() {}, async close() {} },
    }, deliver);
    gateway.reserve(threadId);
    gateway.pendingInteractions = async () => [];
    return gateway;
  });
  session.subscribeMessage(raw => frames.push(JSON.parse(raw)));
  const send = (id: string, method: string, params = {}) => session.send(JSON.stringify({
    id, method, params, [LOGICAL_CLIENT_FIELD]: 'fixture',
  }));
  await send('init', 'initialize');
  const history = send('read', 'thread/read', { threadId, includeTurns: true, watch: true });
  try {
    await entered.promise;
    assert.deepEqual(requested, [false, true]);
    publish(threadId, { method: 'item/agentMessage/delta', params: { threadId, turnId: 'turn', itemId: 'reply', delta: 'live' } });
    assert.ok(frames.some(frame => frame.method === 'item/agentMessage/delta'));
    assert.ok(!frames.some(frame => frame.id === 'read'));
  } finally {
    release.resolve();
    await history;
    await session.close();
  }
});

test('a ledger-confirmed settlement clears the shared approval before its outbox event arrives', async () => {
  const threadId = 'bridge:codex:approval-ledger', route = JSON.stringify(['fixture', threadId]);
  const interactionId = 'approval';
  const requested = { seq: 1, route, generation: 'g', payload: {
    method: 'interaction/request',
    params: { interactionId, payload: {
      method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn', itemId: 'command' },
    } },
  } };
  const events = [requested];
  let pending = true, unavailable = false, delayedBody = false;
  const frames: any[] = [];
  const session = new CodexProviderBridgeSession({
    status: { state: 'open' },
    async connect() {}, async close() {}, async send() {},
    subscribeStatus: () => () => {}, subscribeMessage: () => () => {},
  }, publish => new BridgeGatewaySession({
    serverId: 'fixture',
    async request(path) {
      if (path === '/observe') return Response.json({ thread: { id: threadId, turns: [] } });
      assert.equal(path.split('?')[0], '/snapshot');
      return Response.json({ routes: [{ route, generation: 'g' }], nativeSessions: [],
        interactions: pending ? [
          { route, id: interactionId }, ...(delayedBody ? [{ route, id: 'later' }] : []),
        ] : [] });
    },
    inbox: {
      async cursor() { return 0; }, async read(after) { return events.filter(row => row.seq > after); },
      async readIdentities() { return []; }, async readPendingInteractions() { return []; }, async close() {},
      async pull() { if (unavailable) throw new BridgeOutboxReadError(503); },
    },
  }, publish), { manualPull: true, initialEventPull: false });
  const send = (id: string, method: string, params = {}) => session.send(JSON.stringify({
    id, method, params, [LOGICAL_CLIENT_FIELD]: 'fixture',
  }));
  session.subscribeMessage(raw => frames.push(JSON.parse(raw)));
  try {
    await session.connect();
    await send('init', 'initialize', { capabilities: { extensions: { 'opencraft/shared-interactions': { version: 1 } } } });
    await send('watch', 'thread/read', { threadId, watch: true });
    await send('pending', 'opencraft/interactions/read', { threadId });
    assert.deepEqual(frames.find(frame => frame.id === 'pending').result.requests.map(request => request.id), [interactionId]);
    delayedBody = true;
    await send('incomplete', 'opencraft/interactions/read', { threadId });
    const incomplete = frames.find(frame => frame.id === 'incomplete');
    assert.equal(incomplete.error.code, -32083);
    assert.equal(incomplete.error.data.code, 'SOURCE_UNAVAILABLE');
    pending = false;
    unavailable = true;
    await send('settled', 'opencraft/interactions/read', { threadId });
    assert.deepEqual(frames.find(frame => frame.id === 'settled').result.requests, []);
    const changes = () => frames.filter(frame => frame.method === 'opencraft/interactions/changed').map(frame => frame.params.requests.length);
    assert.deepEqual(changes(), [1, 0]);
    unavailable = false;
    events.push({ ...requested, seq: 2, payload: { ...requested.payload, method: 'interaction/resolved' } });
    await session.pull();
    assert.deepEqual(changes(), [1, 0]);
  } finally { await session.close(); }
});

test('a displayed approval can be answered while another request body is in flight', async () => {
  const threadId = 'bridge:codex:scoped-approval', route = JSON.stringify(['fixture', threadId]);
  const shown = { seq: 1, route, generation: 'g', payload: {
    method: 'interaction/request',
    params: { interactionId: 'visible', payload: {
      method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn', itemId: 'command' },
    } },
  } };
  let late = false;
  const commands: unknown[] = [], frames: any[] = [];
  const session = new CodexProviderBridgeSession({
    status: { state: 'open' },
    async connect() {}, async close() {}, async send() {},
    subscribeStatus: () => () => {}, subscribeMessage: () => () => {},
  }, publish => new BridgeGatewaySession({
    serverId: 'fixture',
    async request(path, body) {
      if (path === '/observe') return Response.json({ thread: { id: threadId, turns: [] } });
      if (path === '/command') { commands.push(body); return Response.json(null); }
      if (path.startsWith('/command?id=')) return Response.json({ state: 'accepted', response: { result: {} } });
      assert.equal(path.split('?')[0], '/snapshot');
      return Response.json({ routes: [{ route, generation: 'g' }], nativeSessions: [], interactions: [
        { route, id: 'visible' }, ...(late ? [{ route, id: 'still-in-transit' }] : []),
      ] });
    },
    inbox: {
      async cursor() { return 0; }, async read(after) { return after === 0 ? [shown] : []; },
      async readIdentities() { return []; }, async readPendingInteractions() { return []; }, async close() {}, async pull() {},
    },
  }, publish), { manualPull: true, initialEventPull: false });
  const send = (id: string, method: string, params = {}) => session.send(JSON.stringify({
    id, method, params, [LOGICAL_CLIENT_FIELD]: 'fixture',
  }));
  session.subscribeMessage(raw => frames.push(JSON.parse(raw)));
  try {
    await session.connect();
    await send('init', 'initialize', { capabilities: { extensions: { 'opencraft/shared-interactions': { version: 1 } } } });
    await send('watch', 'thread/read', { threadId, watch: true });
    await send('first', 'opencraft/interactions/read', { threadId });
    assert.deepEqual(frames.find(frame => frame.id === 'first').result.requests.map(request => request.id), ['visible']);
    late = true;
    await send('partial', 'opencraft/interactions/read', { threadId });
    assert.equal(frames.find(frame => frame.id === 'partial').error.data.code, 'SOURCE_UNAVAILABLE');
    const answer = { threadId, interactionId: 'visible', submissionId: 'answer', result: { decision: 'decline' } };
    await send('answer', 'opencraft/interactions/respond', answer);
    const response = frames.find(frame => frame.id === 'answer');
    assert.equal(response.error, undefined);
    assert.equal(response.result.disposition, 'submitted');
    assert.deepEqual(commands, [{
      serverId: 'fixture', threadId, commandId: 'interaction:visible', method: 'interaction/resolve',
      params: { interactionId: 'visible', result: answer.result },
    }]);
  } finally { await session.close(); }
});

for (const at of ['publication', 'hydration', 'resolution']) test(`an expired approval source or subscriber fences an undispatched claim at ${at}`, async () => {
  const threadId = 'bridge:codex:approval-owner', route = JSON.stringify(['fixture', threadId]);
  const shown = { seq: 1, route, generation: 'g', payload: {
    method: 'interaction/request',
    params: { interactionId: 'approval', payload: {
      method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn', itemId: 'command' },
    } },
  } };
  const frames: any[] = [], commands: unknown[] = [];
  let current = true, waitingToWrite = false;
  const events = [shown];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const session = new CodexProviderBridgeSession({
    status: { state: 'open' },
    async connect() {}, async close() {}, async send() {},
    subscribeStatus: () => () => {}, subscribeMessage: () => () => {},
  }, publish => {
    const gateway = new BridgeGatewaySession({
      serverId: 'fixture',
      async request(path, body) {
        if (path === '/observe') return Response.json({ thread: { id: threadId, turns: [] } });
        if (path === '/command') { commands.push(body); return Response.json(null); }
        if (path.startsWith('/command?id=')) return Response.json({ state: 'accepted', response: { result: {} } });
        assert.equal(path.split('?')[0], '/snapshot');
        return Response.json({ routes: [{ route, generation: 'g' }], nativeSessions: [], interactions: [{ route, id: 'approval' }] });
      },
      inbox: {
        async cursor() { return 0; }, async read(after) { return events.filter(event => event.seq > after); },
        async readIdentities() { return []; }, async readPendingInteractions() { return []; }, async close() {}, async pull() {},
      },
    }, publish);
    const hydrate = gateway.hydrateThread.bind(gateway);
    gateway.hydrateThread = async id => {
      if (waitingToWrite && at !== 'publication') {
        waitingToWrite = false;
        entered.resolve();
        await release.promise;
      }
      return hydrate(id);
    };
    return gateway;
  }, { manualPull: true, initialEventPull: false });
  const send = (client: string, id: string, method: string, params = {}, guarded = false) => session.sendWithContext(
    JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }),
    { sender: null, ...(guarded ? { resourceOwner: { id: 'fixture-owner', assertCurrent() {
      if (!current) throw Error('Subscription expired');
    } } } : {}) },
  );
  session.subscribeMessage(raw => {
    const frame = JSON.parse(raw);
    frames.push(frame);
    if (frame.method !== 'opencraft/interactions/changed' || !current ||
        frame.params.requests[0]?.state !== 'responding') return;
    waitingToWrite = true;
    if (at === 'publication') current = false;
  });
  const latest = () => frames.filter(frame => frame.method === 'opencraft/interactions/changed').at(-1)?.params.requests[0]?.state;
  try {
    await session.connect();
    for (const client of ['original', 'peer']) {
      await send(client, client + '-init', 'initialize', { capabilities: { extensions: { 'opencraft/shared-interactions': { version: 1 } } } });
      await send(client, client + '-watch', 'thread/read', { threadId, watch: true });
    }
    await send('peer', 'pending', 'opencraft/interactions/read', { threadId });
    const request = { threadId, interactionId: 'approval', submissionId: 'original-answer', result: { decision: 'accept' } };
    const first = send('original', 'answer', 'opencraft/interactions/respond', request, true);
    if (at !== 'publication') {
      await entered.promise;
      if (at === 'resolution') {
        events.push({ ...shown, seq: 2, payload: { ...shown.payload, method: 'interaction/resolved' } });
        await session.pull();
      } else current = false;
      release.resolve();
    }
    await first;
    const fault = frames.find(frame => frame.id === 'answer').error;
    assert.equal(fault?.data.code, at === 'resolution' ? 'SOURCE_CHANGED' : 'SOURCE_UNAVAILABLE');
    assert.equal(fault.data.submissionOutcome, 'rejected');
    assert.equal(commands.length, 0);
    if (at === 'resolution') {
      assert.equal(latest(), undefined);
      return;
    }
    assert.equal(latest(), 'pending');
    await send('peer', 'peer-answer', 'opencraft/interactions/respond', {
      ...request, submissionId: 'peer-answer', result: { decision: 'decline' },
    });
    assert.equal(frames.find(frame => frame.id === 'peer-answer').result?.disposition, 'submitted');
    assert.equal(commands.length, 1);
    assert.deepEqual((commands[0] as { params: unknown }).params, {
      interactionId: 'approval', result: { decision: 'decline' },
    });
  } finally { release.resolve(); await session.close(); }
});

test('a revoked Host continuation never reaches Bridge command custody', async () => {
  const frames: any[] = [];
  let commits = 0;
  const threadId = 'bridge:codex:recovery';
  const session = new CodexProviderBridgeSession({
    status: { state: 'open' },
    async connect() {}, async close() {},
    subscribeStatus: () => () => {}, subscribeMessage: () => () => {},
    async send() {},
  }, publish => {
    const gateway = new BridgeGatewaySession({
      serverId: 'fixture',
      async request() { assert.fail('Revoked continuation reached the Engine Host'); },
      inbox: { async cursor() { return 0; }, async read() { return []; }, async readIdentities() { return []; }, async readPendingInteractions() { return []; },
        async pull() {}, async close() {} },
    }, publish);
    gateway.reserve(threadId);
    return gateway;
  });
  session.subscribeMessage(raw => frames.push(JSON.parse(raw)));
  await session.send(JSON.stringify({ id: 'init', method: 'initialize', [LOGICAL_CLIENT_FIELD]: 'host' }));
  await session.sendWithContext(JSON.stringify({ id: 'continue', method: 'turn/start',
    params: { threadId, clientUserMessageId: 'restart-recovery:fixture', input: [] }, [LOGICAL_CLIENT_FIELD]: 'host' }),
  { sender: null, commitExecution() { commits++; return false; } });
  assert.equal(commits, 1);
  assert.equal(frames.find(frame => frame.id === 'continue').error.data.submissionOutcome, 'rejected');
});

for(const cli of [false,true,'timeout','initial','contradiction','closed-contradiction','git'])test(`bundled Codex bridge through durable Host: CLI ${cli}, opt-in, steer, reattach and ID continuity`, async t => {
  const git = cli === 'git';
  const initial=git||cli==='initial'||String(cli).includes('contradiction');
  let serverStarted=0,serverReset=0;
  const root = await mkdtemp(join(tmpdir(), 'codex-p2a-'));
  const native = createServer(), control = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.end(JSON.stringify(req.url === '/launch' ? { dataDirectory: root, launch: { args: [], env: { OPENCRAFT_CODEX_POOL_AUTH_TOKEN: 'synthetic-test' }, auth: { type: 'chatgptAuthTokens', accessToken: 'synthetic-test', chatgptAccountId: 'opencraft-account-pool' } } } : { protocolVersion: 1, pid: process.pid, codexPid: process.pid, nativeSocket: join(root, 'native.sock') }));
  });
  const ws = new WebSocketServer({ server: native });
  const resumeRequests: unknown[] = [];
  let nativePeer: WebSocket | undefined, starts = 0, steers = 0;
  let approvalAnswer: unknown, approvalAnswers = 0;
  const permissionAnswers: unknown[] = [];
  const toolReplies: any[] = [], hostToolCalls: any[] = [];
  let startDynamicTools: any;
  const creationTools = () => [{ type: 'function', name: 'host_declared', description: 'Host tool', inputSchema: { type: 'object' } }];
  const nativeTool = (context: any, tool: any, args: unknown) => tool.name === 'host_tool'
    ? (hostToolCalls.push({ context, tool, args }), Promise.resolve({ success: true, contentItems: [{ type: 'inputText', text: 'host answered' }] })) : null;
  let hasRollout=!initial,initialConfig:any;
  const rollout = join(root, 'native-rollout.jsonl');
  const gitAdmissions: unknown[] = [], gitSettlements: unknown[] = [];
  const gitEvents: [string, unknown, unknown][] = [];
  const nativeTurn = () => starts === 1 ? 'native-turn' : 'native-turn-' + starts;
  let loaded=true,nativeActive=false,issued=0,revoked=0,blockRetirement=cli==='timeout';const nativeConfigurations:any[]=[];
  const lifecycleCalls:any[]=[];const nativeStartInputs:unknown[]=[];const settingsCalls:any[]=[];const titleCalls:any[]=[];const oldStarts:any[]=[];const releaseCalls:string[]=[];let releaseAnswer=false;
  let holdFullHistory: ((reply: () => void) => void) | undefined;
  ws.on('connection', socket => {
    socket.on('message', raw => {
      const f = JSON.parse(String(raw));
      if (f.id === 'native-approval' && f.result) { approvalAnswer = f.result; approvalAnswers++; }
      if (f.id === 'native-permissions' && f.result) permissionAnswers.push(f.result);
      if (typeof f.id === 'string' && f.id.startsWith('native-tool') && f.method === undefined) { toolReplies.push(f); return; }
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: f.id, result }));
      const event = (method: string, params: unknown) => socket.send(JSON.stringify({ method, params }));
      if (f.params?.threadId === 'native-old') {
        if (f.method === 'thread/read') { reply({ thread: { id: 'native-old', status: { type: 'notLoaded' }, turns: [] } }); return; }
        if (f.method === 'thread/resume') { reply({ thread: { id: 'native-old', turns: [] } }); return; }
        if (f.method === 'turn/start') { oldStarts.push(f.params); reply({ turn: { id: 'old-turn-1' } }); return; }
      }
      if (f.method === 'initialize') {
        if (f.params.clientInfo.name === 'opencraft-codex-bridge') nativePeer = socket;
        reply({ userAgent: 'codex/0.167.2' });
      }
      if (['thread/fork','thread/name/set','thread/archive','thread/unarchive','thread/delete','thread/goal/get','thread/goal/set','thread/goal/clear'].includes(f.method)) {
        lifecycleCalls.push({method:f.method,params:f.params});
        if (f.method === 'thread/fork') reply({ thread: { id: 'native-fork', parentThreadId: f.params.threadId, cwd: root, createdAt: 10, updatedAt: 10, turns: [] } });
        else if (f.method === 'thread/unarchive') reply({ thread: { id: f.params.threadId, cwd: root, createdAt: 10, updatedAt: 10, turns: [] } });
        else if (f.method === 'thread/goal/set' || f.method === 'thread/goal/get') reply({ goal: { objective: 'ship it', status: 'active' } });
        else if (f.method === 'thread/goal/clear') reply({ cleared: true });
        else reply({});
      }
      if (f.method === 'thread/start') {if (git) assert.equal(f.params.historyMode, 'paginated');initialConfig=f.params.config;startDynamicTools=f.params.dynamicTools;reply({sandbox:{type:'readOnly'},approvalPolicy:'never',approvalsReviewer:'user',thread: { id: 'native-new', cwd: root, createdAt: 10, updatedAt: 10, turns: [] }});}
      if(f.method==='turn/start'&&f.params.clientUserMessageId==='initial-invalid'){socket.send(JSON.stringify({id:f.id,error:{code:-32602,message:'invalid input'}}));return;}
      if (f.method === 'turn/start' && f.params.clientUserMessageId === 'unknown-start') { socket.send(JSON.stringify({ id: f.id, error: { code: -32000, message: 'Opaque native failure' } })); return; }
      if (f.method === 'turn/start') {
        assert.equal(f.params.opencraftExecutionAdmission,undefined);assert.equal(f.params.executionSource,undefined);assert.equal(f.params.opencraftSessionMcp,undefined);
        nativeStartInputs.push(f.params.input);
        hasRollout=true;nativeActive=true;starts++; event('turn/started', { threadId: 'native-new', turn: { id: nativeTurn() } });
        event('item/started', { threadId: 'native-new', turnId: nativeTurn(), item: {
          type: 'commandExecution', id: 'tool', command: 'cat input.txt', cwd: root, status: 'inProgress',
          source: 'unifiedExecStartup', processId: 'fixture-pty',
          commandActions: [{ type: 'read', command: 'cat input.txt', name: 'input.txt', path: 'input.txt' }],
        } });
        if(String(cli).includes('contradiction')){
          if(cli==='closed-contradiction'){nativeActive=false;event('turn/completed',{threadId:'native-new',turn:{id:'native-turn',status:'completed'}});}
          socket.send(JSON.stringify({id:f.id,error:{code:-32602,message:'refused after start'}}));return;
        }
        reply({ turn: { id: nativeTurn(), status: 'inProgress', items: [] } });
      }
      if (f.method === 'turn/steer') {
        steers++; assert.equal(f.params.expectedTurnId, 'native-turn');
        event('item/started', { threadId: 'native-new', turnId: 'native-turn', item: { type: 'userMessage', id: 'steer-item', clientId: f.params.clientUserMessageId, content: f.params.input } });
        reply({ turnId: 'native-turn' });
      }
      if (f.method === 'thread/read' && f.params.includeTurns && !hasRollout) {
        if (git) {
          void writeFile(rollout, JSON.stringify({ type: 'session_meta' }) + '\n').then(() => {
            hasRollout = true;
            socket.send(JSON.stringify({ id: f.id, error: { code: -32601, message: 'list_turns is not supported yet' } }));
          });
        } else socket.send(JSON.stringify({id:f.id,error:{code:-32600,message:'thread native-new is not materialized yet; includeTurns is unavailable before first user message'}}));
        return;
      }
      if (f.method === 'thread/read') {
        const sendHistory = () => reply({ thread: { id: 'native-new',...(git ? { path: rollout } : {}),status:{type:!loaded?'notLoaded':nativeActive?'active':'idle'}, turns: [{ id: 'native-turn', items: [{ type: 'commandExecution', id: 'tool', command: 'cat input.txt', commandActions: [{ type: 'business-data', threadId: 'business-thread', id: 'native-turn' }] }] }] } });
        if (holdFullHistory && f.params.includeTurns) {
          const hold = holdFullHistory;
          holdFullHistory = undefined;
          hold(sendHistory);
        } else sendHistory();
      }
      if (f.method === 'thread/searchOccurrences') {
        assert.equal(f.params.threadId, 'native-new');
        reply({ data: [{ turnId: 'native-turn', itemId: 'legacy-item', snippet: 'fixture' }], nextCursor: null });
      }
      if (f.method === 'thread/items/list') {
        assert.equal(f.params.threadId, 'native-new');
        if (f.params.turnId === undefined) {
          assert.equal(f.params.sortDirection, 'desc');
          reply({ data: [{ turnId: 'native-turn', item: { type: 'commandExecution', id: 'tool', command: 'cat input.txt' } }], nextCursor: null });
          return;
        }
        assert.equal(f.params.turnId, 'historical-turn');
        reply({ data: [{ turnId: 'historical-turn', item: { type: 'agentMessage', id: 'old-answer', text: 'old excerpt' } }], nextCursor: null });
      }
      if (f.method === 'thread/turns/list') {
        if (f.params.itemsView === 'presentation') {
          socket.send(JSON.stringify({ id: f.id, error: { code: -32602, message: 'Unsupported native itemsView' } }));
          return;
        }
        if (f.params.limit === 2 && f.params.itemsView === 'notLoaded') {
          reply({ data: [{ id: 'historical-turn', status: 'completed', items: [] }], nextCursor: null });
          return;
        }
        if (f.params.itemsView === 'full') {
          const bytes = f.params.limit === 10 ? BRIDGE_MAX_FRAME_BYTES + 1 : 2 * 1024 * 1024;
          const text = '界'.repeat(Math.ceil(bytes / 3));
          reply({ data: [{ id: 'native-turn', status: 'completed', itemsView: 'full', items: [{ type: 'agentMessage', id: 'large', text }] }], nextCursor: 'older-turn' });
          return;
        }
        assert.deepEqual(f.params, { threadId: 'native-new', limit: 1, cursor: null, sortDirection: 'desc', itemsView: 'notLoaded' });
        reply({ data: [{ id: 'native-turn', status: nativeActive ? 'inProgress' : 'completed', items: [] }], nextCursor: 'older-turn' });
      }
      if(f.method==='thread/unsubscribe'){if(!blockRetirement)loaded=false;reply({});}
      if(f.method==='thread/settings/update'){settingsCalls.push(f.params);reply({});}
      if (git && f.method === 'thread/resume' && loaded && starts === 0 && hasRollout) {
        socket.send(JSON.stringify({ id: f.id, error: { code: -32601, message: 'list_turns is not supported yet' } }));
        return;
      }
      if(f.method==='thread/resume'&&!hasRollout){socket.send(JSON.stringify({id:f.id,error:{code:-32600,message:'no rollout found'}}));return;}
      if (f.method === 'thread/resume') {resumeRequests.push(f.params);loaded=true;if(f.params.config)nativeConfigurations.push(f.params);reply({sandbox:{type:'readOnly'},approvalPolicy:'never',thread: { id: 'native-new', turns: [] }});}
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
        if (f.id !== undefined) legacyListener(JSON.stringify({ id: f.id, [LOGICAL_CLIENT_FIELD]: f[LOGICAL_CLIENT_FIELD], result: f.method === 'initialize' ? { capabilities: {} }
          : f.method === 'thread/search' ? { data: [{ thread: { id: 'native-new' }, snippet: 'fixture' }] }
          : f.method === 'thread/list' && f.params?.limit === 3 ? { data: [{ id: 'native-new' }, { id: 'native-child', parentThreadId: 'native-new' }] }
          : ['opencraft/schedules/read', 'opencraft/schedules/save', 'opencraft/turn-recovery/read'].includes(f.method)
            ? { owner: 'legacy-host', threadId: f.params.threadId }
          : f.method === 'opencraft/codex/maintenance/read'  ? { paused, pendingAdmissions: 0, rejectedAdmissions: 2 } : { data: [{ id: 'native-old' }, { id: 'native-new' }] } }));
      },
    };
    const options={url:attachment.url,token,serverId:'server',inboxPath:join(root,'gateway.db')};
    const next=cli?createServerCodexBridge(legacy,options,{
      async admit(threadId,inputId){return {serverId:'server',threadId,execution:{inputId,executionId:inputId}};},
      sign:scope=>'signed:'+scope.execution!.inputId,...(initial?{async prepareSessionMcp(){return {configuration:{url:'http://127.0.0.1:1/mcp',http_headers:{Authorization:'Bearer platform-mcp'}}};}}:{}),sessionMcp:async()=>({url:'http://127.0.0.1:1/mcp',http_headers:{Authorization:'Bearer platform-mcp'}}),started:()=>{serverStarted++;},rejectedBeforeStart:()=>{serverReset++;},
    }, {
      admissionPaused: () => paused, nativeTool, creationTools,
      ...(git ? { executionGit: {
        async prepare(nativeThreadId, inputId, context) {
          const actor = context.executionPrincipal?.subject;
          gitAdmissions.push([nativeThreadId, inputId, actor]);
          if (actor === 'revoked') throw Error('fixture credential service unavailable');
          return {
            environment: actor ? {
              OPENCRAFT_GIT_CAPABILITY: 'synthetic-git-seal-' + actor + '-' + gitAdmissions.length,
              OPENCRAFT_GIT_BIN: '/git/bin', PATH: '/git/bin:/usr/bin', BASH_ENV: '/git/shell-env.sh',
            } : {},
            settle(outcome, turnId) { gitSettlements.push([inputId, outcome, turnId]); },
          };
        },
        notification(method, params) { gitEvents.push([method, params.threadId, params.turnId]); },
      } } : {}),
    }):new CodexProviderBridge(legacy,options,{admissionPaused:()=>paused,nativeTool,creationTools,
      prepareInput: async (threadId, clientId, input, context, purpose) => {
        if (context.sender && clientId === undefined && purpose !== 'queue-edit') throw new Error('Message identity is required');
        staged.push([threadId, clientId]);
        return input.map((item: any) => item.type === 'mention' ? { type: 'text', text: `file at ${item.path}` } : item);
      },
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
  const request = async (method: string, params: unknown = {}, sender?: typeof verifiedSender, execution?: TransportSubmissionContext) => {
    const id = ++sequence;
    const raw = JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: 'client' });
    if (execution) await transport!.sendWithContext(raw, execution);
    else if (sender) await transport!.sendWithContext(raw, { sender, validUntil: Date.now() + 60_000 });
    else await transport!.send(raw);
    const frame = await until(() => frames.find(f => f.id === id), Boolean);
    if (frame.error) throw new AppServerRpcError(frame.error);
    return frame.result;
  };
  const initialized = await request('initialize', { capabilities: { extensions: { 'opencraft/steer-evidence': { version: 1 } } } });
  const bridgeHistory = initialized.capabilities.extensions['opencraft/execution-engines'].providers
    .find((provider: { id: string }) => provider.id === 'codex-bridge').extensions['opencraft/read-history'];
  assert.equal(bridgeHistory.initialTurnsPage, true);
  assert.notEqual(bridgeHistory.itemDetails, true);
  if (!cli || cli === true) {
    await transport.send(JSON.stringify({ id: 'directory-init', method: 'initialize', params: {}, [LOGICAL_CLIENT_FIELD]: 'directory-reader' }));
    await until(() => frames.find(f => f.id === 'directory-init' && f[LOGICAL_CLIENT_FIELD] === 'directory-reader'), Boolean);
  }
  const created = await request('thread/start', { cwd: root, approvalPolicy: 'never', sandbox: 'read-only', agentBridge: { threadId: 'bridge:codex:public-new', clientRequestId: 'create' },
    dynamicTools: [{ type: 'function', name: 'client_declared', description: 'Client tool', inputSchema: { type: 'object' } }, { type: 'function', name: 'host_declared', description: 'Shadowed', inputSchema: { type: 'object' } }] }, cli ? undefined : verifiedSender);
  assert.equal(created.thread.id, 'bridge:codex:public-new');
  if (!cli) {
    const threadId = created.thread.id;
    // A renderer that negotiated with the previous Gateway can still read
    // through this one. The provider fixture rejects the renderer-only mode.
    const initial = { limit: 1, sortDirection: 'desc', itemsView: 'presentation' };
    assert.equal((await request('thread/read', { threadId, initialTurnsPage: initial })).initialTurnsPage.data[0].itemsView, 'full');
    assert.equal((await request('thread/turns/list', { threadId, ...initial })).data[0].itemsView, 'full');
    await assert.rejects(request('thread/turns/list', { threadId, ...initial, detailItemId: 'tool' }), { code: -32601 });
  }
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
    await transport.send(JSON.stringify({id:failedId,method:'turn/start',params:{threadId:'bridge:codex:public-new',clientUserMessageId:'start',input:[{type:'text',text:'read'}]},[LOGICAL_CLIENT_FIELD]:'client'}));
    const failed=await until(()=>frames.find(frame=>frame.id===failedId),Boolean);
    assert.equal(failed.error.data.submissionOutcome,'rejected');
    assert.equal(failed.error.data.cliStage,'native-configuration');
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
    assert.ok(!frames.some(f => f.method === 'opencraft/thread-catalog/changed' && f.params.change.type === 'upsert'),
      'an unsubmitted draft has no committed directory row');
    await request('thread/name/set',{threadId:pub,name:'Renamed'});
    await request('thread/goal/set',{threadId:pub,objective:'ship it'});
    assert.deepEqual((await request('thread/goal/get',{threadId:pub})).goal,{objective:'ship it',status:'active'});
    await request('thread/goal/clear',{threadId:pub});
    const historyInFlight = Promise.withResolvers<() => void>();
    holdFullHistory = historyInFlight.resolve;
    const lateHistory = assert.rejects(request('thread/read', { threadId: pub, includeTurns: true }), { code: -32071 });
    const releaseHistory = await historyInFlight.promise;
    try {
      await request('thread/archive',{threadId:pub});
    } finally {
      releaseHistory();
    }
    await lateHistory;
    const initialPage = { threadId: pub, initialTurnsPage: { limit: 2, itemsView: 'full', sortDirection: 'desc' } };
    await assert.rejects(request('thread/read', initialPage), {
      code: -32071, data: { code: 'THREAD_ARCHIVED', bridgeErrorKind: 'explicit-reject', submissionOutcome: 'rejected', retryable: false },
    });
    const archivedPage = await request('thread/read', { ...initialPage, openArchivedHistory: true });
    assert.equal(archivedPage.thread.archived, true);
    assert.ok(Array.isArray(archivedPage.initialTurnsPage.data));
    assert.ok(Array.isArray((await request('thread/turns/list', {
      threadId: pub, limit: 1, openArchivedHistory: true,
    })).data));
    assert.ok(Array.isArray((await request('thread/items/list', {
      threadId: pub, sortDirection: 'desc', openArchivedHistory: true,
    })).data));
    assert.equal((await request('thread/unarchive',{threadId:pub})).thread.id,pub);
    const forked=(await request('thread/fork',{threadId:pub})).thread.id;
    assert.match(forked,/^bridge:codex:/u); assert.notEqual(forked,pub); assert.equal(currentGateway().owns(forked),true);
    await request('thread/delete',{threadId:forked});
    const directoryChanges = await until(() => {
      const changes = frames.slice(lifecycleFrom).filter(f => f[LOGICAL_CLIENT_FIELD] === 'directory-reader'
        && f.method === 'opencraft/thread-catalog/changed').map(f => f.params.change);
      return changes.some(change => change.type === 'remove' && change.threadId === forked) ? changes : undefined;
    }, Boolean);
    assert.deepEqual(directoryChanges.filter(change => change.type === 'remove').map(change => change.threadId), [pub, forked]);
    assert.deepEqual(directoryChanges.filter(change => change.type === 'upsert').map(change => change.thread.id), [pub, forked]);
    assert.equal(directoryChanges.find(change => change.type === 'upsert' && change.thread.id === forked)?.thread.parentThreadId, pub);
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
  if (git) {
    const threadId = created.thread.id;
    const start = (inputId: string, actor?: string) => request('turn/start', {
      threadId, clientUserMessageId: inputId, input: [{ type: 'text', text: inputId }],
    }, undefined, { sender: null, ...(actor ? {
      executionPrincipal: { provider: 'fixture', subject: actor }, validUntil: Date.now() + 30_000,
    } : {}) });
    const finish = async (turnId: string) => {
      nativeActive = false;
      nativePeer!.send(JSON.stringify({ method: 'turn/completed', params: {
        threadId: 'native-new', turn: { id: turnId, status: 'completed' },
      } }));
      await until(() => gitEvents.some(([method, thread, turn]) => method === 'turn/completed' && thread === 'native-new' && turn === turnId), Boolean);
      await until(() => revoked, count => count >= starts);
    };
    await start('first', 'alice');
    assert.equal(starts, 1);
    const first = nativeConfigurations.at(-1).config['shell_environment_policy.set'];
    assert.equal(first.OPENCRAFT_GIT_CAPABILITY, 'synthetic-git-seal-alice-1');
    assert.equal(first.OPENCRAFT_THREAD_CLI, 'fixture');
    assert.equal(first.PATH, '/git/bin:fixture:/usr/bin');
    assert.deepEqual(gitSettlements[0], ['first', 'accepted', 'native-turn']);
    await finish('native-turn');

    await start('second', 'bob');
    assert.equal(nativeConfigurations.at(-1).config['shell_environment_policy.set'].OPENCRAFT_GIT_CAPABILITY, 'synthetic-git-seal-bob-2');
    await finish('native-turn-2');
    await assert.rejects(start('denied', 'revoked'), { message: 'git_execution_unavailable' });
    assert.equal(starts, 2);
    await start('third');
    assert.deepEqual(nativeConfigurations.at(-1).config['shell_environment_policy.set'], { OPENCRAFT_THREAD_CLI: 'fixture', PATH: 'fixture' });
    assert.deepEqual(gitAdmissions, [
      ['native-new', 'first', 'alice'], ['native-new', 'second', 'bob'], ['native-new', 'denied', 'revoked'], ['native-new', 'third', undefined],
    ]);
    assert.ok(!JSON.stringify(frames).includes('synthetic-git-seal'));
    await finish('native-turn-3');
    return;
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
  const receiptId = 'bridge-mutation:' + createHash('sha256').update(JSON.stringify([created.thread.id, 'turn/start', 'start'])).digest('hex');
  const acceptedReceiptId = cli === 'timeout' ? receiptId + ':retry:000000000001' : receiptId;
  assert.deepEqual((await host.query(acceptedReceiptId))?.identities?.turn, { nativeId: 'native-turn', id: turnId });
  if (cli === 'timeout') {
    assert.equal((await host.query(receiptId))?.state, 'rejected');
    assert.equal(starts, 1);
  }
  if (!cli) {
    const threadId = created.thread.id;
    const queuedImage = { type: 'localImage', path: '/work/screenshot.png' };
    const added = await request('thread/queue/add', {
      threadId, clientUserMessageId: 'queue-original', input: [{ type: 'text', text: 'before edit' }, queuedImage],
    }, verifiedSender);
    const editedInput = [{ type: 'text', text: 'after edit' }, queuedImage];
    const edited = await request('thread/queue/update', {
      threadId, queuedSubmissionId: added.queuedSubmission.id, input: editedInput,
    }, { kind: 'employee', loginName: 'bob' });
    assert.equal(edited.queuedSubmission.id, added.queuedSubmission.id);
    assert.equal(edited.queuedSubmission.clientUserMessageId, 'queue-original');
    assert.deepEqual(edited.queuedSubmission.input, editedInput);
    assert.deepEqual(staged.at(-1), [threadId, undefined]);
    assert.equal((await request('thread/queue/delete', {
      threadId, queuedSubmissionId: added.queuedSubmission.id,
    }, verifiedSender)).deleted, true);

    const image = { id: 'native-image', type: 'imageGeneration', status: 'completed', revisedPrompt: null, result: 'fixture-image', failure: null };
    const mcp = { id: 'native-mcp', type: 'mcpToolCall', server: 'fixture', tool: 'generate', status: 'completed',
      result: { content: [{ type: 'image', mimeType: 'image/png', data: 'Zml4dHVyZQ==' }], structuredContent: null, _meta: null } };
    const dynamic = { id: 'native-dynamic', type: 'dynamicToolCall', tool: 'fixture', status: 'completed', arguments: {},
      contentItems: [{ type: 'inputText', text: 'dynamic fixture' }], success: true };
    const prompt = { id: 'native-hook', type: 'hookPrompt', fragments: [{ text: 'Fixture instruction', hookRunId: 'hook-run' }] };
    const compaction = { id: 'native-compaction', type: 'contextCompaction' };
    const search = { id: 'native-search', type: 'webSearch', query: 'fixture', action: { type: 'search', query: 'fixture', queries: null }, results: null };
    const collab = { id: 'native-collab', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed',
      senderThreadId: 'native-new', receiverThreadIds: ['native-child'], prompt: null, model: null, reasoningEffort: null,
      agentsStates: { 'native-child': { status: 'running', message: null } } };
    const child = { id: 'native-child-start', type: 'subAgentActivity', kind: 'started', agentThreadId: 'native-child', agentPath: 'root/helper' };
    const command = await until(() => frames.find(f =>
      f.method === 'item/started' && f.params.item?.type === 'commandExecution' && f.params.turnId === turnId), Boolean);
    assert.deepEqual(command.params.item.commandActions, [
      { type: 'read', command: 'cat input.txt', name: 'input.txt', path: 'input.txt' },
    ]);
    assert.equal(command.params.item.processId, 'fixture-pty');
    assert.equal(command.params.item.source, 'unifiedExecStartup');
    const emitNative = (method: string, fields: Record<string, unknown>) => nativePeer!.send(JSON.stringify({
      method, params: { threadId: 'native-new', turnId: 'native-turn', ...fields },
    }));
    emitNative('item/commandExecution/terminalInteraction', { itemId: 'tool', processId: 'fixture-pty', stdin: 'hello\n' });
    const terminal = await until(() => frames.find(f => f.method === 'item/commandExecution/terminalInteraction'), Boolean);
    assert.equal(terminal.params.threadId, threadId);
    assert.equal(terminal.params.turnId, turnId);
    assert.equal(terminal.params.itemId, command.params.item.id);
    assert.equal(terminal.params.stdin, 'hello\n');
    assert.equal(terminal.params.processId, 'fixture-pty');

    const asyncMessage = { id: 'native-async', type: 'agentMessage', text: 'What now?', delivery: 'async',
      phase: 'commentary', questions: [{ title: 'What now?', options: ['Continue', 'Stop'] }] };
    emitNative('item/started', { item: asyncMessage });
    const question = await until(() => frames.find(f => f.method === 'item/started' && f.params.item.type === 'agentMessage'), Boolean);
    assert.deepEqual(question.params.item.questions, asyncMessage.questions);
    emitNative('item/completed', { item: { ...asyncMessage, questions: null } });
    const answered = await until(() => frames.find(f => f.method === 'item/completed' && f.params.item.id === question.params.item.id), Boolean);
    assert.deepEqual(answered.params.item.questions, asyncMessage.questions);
    for (const item of [image, mcp, dynamic, prompt, compaction, search, collab, child]) {
      nativePeer!.send(JSON.stringify({ method: 'item/completed', params: { threadId: 'native-new', turnId: 'native-turn', item } }));
      const delivered = await until(() => frames.find(f => f.method === 'item/completed' && f.params.item.type === item.type), Boolean);
      assert.equal(delivered.params.threadId, created.thread.id);
      assert.equal(delivered.params.turnId, turnId);
      assert.notEqual(delivered.params.item.id, item.id);
      assert.deepEqual(delivered.params.item, { ...item, id: delivered.params.item.id });
      const started = frames.find(f => f.method === 'item/started' && f.params.item.id === delivered.params.item.id);
      assert.deepEqual(started?.params.item, delivered.params.item);
    }
    const status = { type: 'active', activeFlags: ['waitingOnApproval'] };
    nativePeer!.send(JSON.stringify({ method: 'thread/status/changed', params: { threadId: 'native-new', status } }));
    const delivered = await until(() => frames.find(f => f.method === 'thread/status/changed' &&
      f.params.status?.activeFlags?.includes('waitingOnApproval')), Boolean);
    assert.equal(delivered.params.threadId, created.thread.id);
    assert.deepEqual(delivered.params.status, status);
  }
  if (cli === true) {
    const firstCatalog = await until(() => frames.find(f => f[LOGICAL_CLIENT_FIELD] === 'directory-reader'
      && f.method === 'opencraft/thread-catalog/changed' && f.params.change.type === 'upsert'
      && f.params.change.thread.id === created.thread.id), Boolean);
    assert.deepEqual(firstCatalog.params.change.thread.turns, []);
    await request('thread/name/set', { threadId: created.thread.id, name: 'Catalog rename' });
    await until(() => frames.find(f => f[LOGICAL_CLIENT_FIELD] === 'directory-reader'
      && f.params?.change?.name === 'Catalog rename'), Boolean);
    await transport.send(JSON.stringify({ method: 'runtime/client/disconnect', [LOGICAL_CLIENT_FIELD]: 'directory-reader' }));
  }
  if (!cli) {
    const attemptedLimits: number[] = [];
    const client = {
      async request(method: string, params: { limit: number }) {
        attemptedLimits.push(params.limit);
        try { return await request(method, params); }
        catch (error) {
          assert.ok(error instanceof AppServerRpcError);
          assert.equal(error.code, -32072);
          assert.equal((error.data as { code: string }).code, 'HISTORY_RESPONSE_TOO_LARGE');
          throw error;
        }
      },
    } as unknown as AppServerClient;
    const executionPeer = nativePeer;
    const page = await readTurnsPage({ client, threadId: created.thread.id, requestTimeoutMs: 30_000 }, null);
    assert.deepEqual(attemptedLimits, [10, 5]);
    assert.equal(page.nextCursor, 'older-turn');
    assert.ok(Buffer.byteLength((page.data[0].items[0] as { text: string }).text) >= 2 * 1024 * 1024);
    assert.equal(nativePeer, executionPeer);
    assert.equal(executionPeer!.readyState, 1, 'oversize history leaves the native execution connection open');
  }
  if (!cli) {
    const threadId = created.thread.id;
    const historical = await request('thread/turns/list', { threadId, limit: 2, itemsView: 'notLoaded' });
    const items = await request('thread/items/list', { threadId, turnId: historical.data[0].id, limit: 1 });
    assert.equal(items.data[0].item.text, 'old excerpt');
    const allItems = await request('thread/items/list', { threadId, limit: 1, sortDirection: 'desc' });
    assert.equal(allItems.data[0].turnId, turnId);
    assert.equal(allItems.data[0].item.command, 'cat input.txt');
    assert.notEqual(allItems.data[0].item.id, 'tool');
    const listing = await request('thread/list', { limit: 3 });
    assert.equal(listing.data[1].parentThreadId, listing.data[0].id);
    const search = await request('thread/search', { searchTerm: 'fixture' });
    assert.equal(search.data[0].thread.id, threadId);
    const occurrences = await request('thread/searchOccurrences', { threadId, searchTerm: 'fixture' });
    assert.equal(occurrences.data[0].turnId, turnId);
    for (const method of ['opencraft/schedules/read', 'opencraft/schedules/save', 'opencraft/turn-recovery/read']) {
      assert.deepEqual(await request(method, { threadId }), { owner: 'legacy-host', threadId });
      await assert.rejects(() => request(method, { threadId: 'native-new' }), /native owner bypass refused/);
    }
    await request('thread/resume', { threadId, excludeTurns: true, model: 'resume-model',
      sandbox: 'read-only', approvalPolicy: 'on-request' });
    assert.deepEqual(resumeRequests.at(-1), { threadId: 'native-new', excludeTurns: true, model: 'resume-model',
      sandbox: 'read-only', approvalPolicy: 'on-request' });
    const gateway = currentGateway();
    const pull = gateway.pull;
    gateway.pull = async () => { throw Error('fixture outbox unavailable'); };
    try {
      const metadata = await request('thread/read', { threadId, includeTurns: false, watch: false });
      assert.equal(metadata.thread.id, threadId);
      assert.deepEqual(metadata.thread.turns, []);
    } finally {
      gateway.pull = pull;
    }

    const reader = 'directory-reader';
    const initial = { threadId, includeTurns: false, watch: false, initialTurnsPage: { limit: 2, itemsView: 'notLoaded' } };
    await transport.send(JSON.stringify({ id: 'metadata-only', method: 'thread/read', params: initial, [LOGICAL_CLIENT_FIELD]: reader }));
    const response = await until(() => frames.find(f => f.id === 'metadata-only'), Boolean);
    assert.equal(response.result.initialTurnsPage.data[0].id, 'historical-turn');
    nativePeer!.send(JSON.stringify({ method: 'thread/settings/updated', params: {
      threadId: 'native-new', threadSettings: { model: 'metadata-probe' }
    } }));
    await until(() => frames.some(f => f.method === 'thread/settings/updated' && f[LOGICAL_CLIENT_FIELD] === 'client'
      && f.params?.threadSettings?.model === 'metadata-probe'), Boolean);
    assert.ok(!frames.some(f => f.method === 'thread/settings/updated' && f[LOGICAL_CLIENT_FIELD] === reader));
    await transport.send(JSON.stringify({ id: 'start-watching', method: 'thread/read',
      params: { threadId, watch: true }, [LOGICAL_CLIENT_FIELD]: reader }));
    await until(() => frames.find(f => f.id === 'start-watching'), Boolean);
    nativePeer!.send(JSON.stringify({ method: 'thread/settings/updated', params: {
      threadId: 'native-new', threadSettings: { model: 'watching-probe' }
    } }));
    await until(() => frames.some(f => f.method === 'thread/settings/updated' && f[LOGICAL_CLIENT_FIELD] === reader
      && f.params?.threadSettings?.model === 'watching-probe'), Boolean);
    await transport.send(JSON.stringify({ method: 'runtime/client/disconnect', [LOGICAL_CLIENT_FIELD]: reader }));
  }
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
  if (!cli) {
    const threadId = created.thread.id;
    const sharedRequest = async (client: string, method: string, params: Record<string, unknown>) => {
      const id = ++sequence;
      await transport!.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }));
      return until(() => frames.find(f => f.id === id), Boolean);
    };
    for (const client of ['shared-a', 'shared-b']) {
      const init = await sharedRequest(client, 'initialize', { capabilities: { extensions: { 'opencraft/shared-interactions': { version: 1 } } } });
      assert.equal(init.result.capabilities.extensions['opencraft/execution-engines'].providers
        .find((p: any) => p.id === 'codex-bridge').extensions['opencraft/shared-interactions'].version, 1);
      assert.ok((await sharedRequest(client, 'thread/read', { threadId, watch: true })).result);
    }
    const method = 'item/permissions/requestApproval';
    nativePeer!.send(JSON.stringify({ id: 'native-permissions', method, params: { threadId: 'native-new', turnId: 'native-turn', itemId: 'tool', permissions: {} } }));
    await until(() => frames.some(f => f[LOGICAL_CLIENT_FIELD] === 'shared-a' && f.method === 'opencraft/interactions/changed'
      && f.params.requests.some((r: any) => r.method === method)), Boolean);
    assert.ok(!frames.some(f => f.method === method && ['shared-a', 'shared-b'].includes(f[LOGICAL_CLIENT_FIELD])));
    const snapshot = await sharedRequest('shared-b', 'opencraft/interactions/read', { threadId });
    const approval = snapshot.result.requests.find((item: any) => item.method === method);
    assert.equal(approval.params.threadId, threadId);
    assert.equal(approval.params.turnId, turnId);
    const params = { threadId, interactionId: approval.id, result: { permissions: {}, scope: 'turn' } };
    const replies = await Promise.all(['shared-a', 'shared-b'].map(client =>
      sharedRequest(client, 'opencraft/interactions/respond', { ...params, submissionId: client })));
    assert.ok(replies.every(r => r.result && !r.error));
    await until(() => permissionAnswers.length, n => n === 1);
    assert.deepEqual(permissionAnswers, [params.result]);
  }
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
  if (cli === false) {
    const notifyChange = (id: string, diff: string) => nativePeer!.send(JSON.stringify({
      method: 'item/completed',
      params: { threadId: 'native-new', turnId: 'native-turn', item: {
        id, type: 'fileChange', status: 'completed',
        changes: [{ path: '/fixture/output.txt', kind: { type: 'add' }, diff }],
      } },
    }));
    notifyChange('large-file-change', 'x'.repeat(2 * 1024 * 1024));
    notifyChange('small-file-change', 'small diff');
    await until(() => frames.find(frame => frame.method === 'item/completed'
      && frame.params.item.type === 'fileChange'), Boolean);
    assert.ok(frames.some(frame => frame.method === 'warning'
      && frame.params.message === 'File change details are unavailable in the live Bridge stream'));
    const fileChanges = frames.filter(frame => frame.method === 'item/completed'
      && frame.params.item.type === 'fileChange');
    assert.deepEqual(fileChanges.map(frame => frame.params.item.changes[0].diff), ['small diff']);
    assert.equal((host.diagnostics() as Array<{ failed: boolean }>).some(peer => peer.failed), false);
  }
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
    // Model a rejected reservation and a goal probe whose reply was lost.
    const storage = (host as unknown as { storage: Storage }).storage;
    const recordOutcome = async (threadId: string, commandId: string, method: string, state: 'rejected' | 'unknown') => {
      const route = JSON.stringify(['server', threadId]);
      await storage.call('admit', { route, digest: commandId, maxSpoolBytes: 1024 * 1024,
        command: { serverId: 'server', threadId, commandId, method, params: {} } });
      if (state === 'unknown') await storage.call('dispatch', { id: commandId });
      await storage.call('settle', { id: commandId, state, response: state === 'rejected' ?
        { jsonrpc: '2.0', id: commandId, error: { code: -32001, message: 'cliUnavailable' } } : null });
    };
    await recordOutcome('native-old', 'old-adopt-rejected', 'session/adopt', 'rejected');
    await recordOutcome('native-old', 'old-goal-unknown', 'goal/get', 'unknown');
    await recordOutcome('native-uncertain', 'uncertain-adopt-rejected', 'session/adopt', 'rejected');
    await recordOutcome('native-uncertain', 'uncertain-adopt-unknown', 'session/adopt', 'unknown');
    await transport.close();
    transport = await createTransport();
    await request('initialize');
    await request('thread/resume', { threadId: 'bridge:codex:public-new' });
    assert.equal(currentGateway().owns('native-old'), false, 'a failed adoption cannot pin a native Thread after restart');
    assert.equal(currentGateway().owns('native-uncertain'), true, 'unknown adoption retains ownership fencing');
    await assert.rejects(host.accept({
      serverId: 'server', threadId: 'native-uncertain', commandId: 'uncertain-adopt-retry',
      method: 'session/adopt', params: { providerThreadId: 'native-uncertain' },
    }), /Thread already exists/);

    // Retry only the retryable adoption; retain the public ID and send exactly once.
    releaseAnswer=true;
    await request('turn/start',{threadId:'native-old',clientUserMessageId:'old-2',input:[{type:'text',text:'now bridged'}]});
    assert.equal(currentGateway().owns('native-old'),true);
    assert.equal(startsToLegacy(),1,'the adopted turn never reaches the local Host');
    assert.equal(oldStarts.length,1);
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

for (const proven of [true, false]) test(`model catalog category crosses the Host only with non-allocation proof=${proven}`, async () => {
  const frames: any[] = [];
  const session = new CodexProviderBridgeSession({
    status: { state: 'open' }, async connect() {}, async close() {}, async send() {},
    subscribeStatus: () => () => {}, subscribeMessage: () => () => {},
  }, publish => {
    const gateway = new BridgeGatewaySession({
      serverId: 'fixture', async request() { assert.fail('No native operation is needed'); },
      inbox: { async cursor() { return 0; }, async read() { return []; }, async readIdentities() { return []; },
        async readPendingInteractions() { return []; }, async pull() {}, async close() {} },
    }, publish);
    gateway.command = async (_thread, _id, method) => {
      assert.equal(method, 'session/create');
      throw Object.assign(Error('Models are temporarily unavailable. Try again later.'), {
        code: -32006, kind: 'explicit-reject', data: { creationRejectionCode: 'model_catalog_unavailable',
          ...(proven ? { creationOutcome: 'not-allocated' } : {}) },
      });
    };
    return gateway;
  });
  session.subscribeMessage(raw => frames.push(JSON.parse(raw)));
  try {
    await session.send(JSON.stringify({ [LOGICAL_CLIENT_FIELD]: 'fixture', id: 'init', method: 'initialize', params: {} }));
    await session.sendWithContext(JSON.stringify({ [LOGICAL_CLIENT_FIELD]: 'fixture', id: 'create', method: 'thread/start', params: {
      agentBridge: { threadId: 'bridge:codex:no-models', clientRequestId: 'no-models' },
    } }), { sender: null });
    const error = frames.find(frame => frame.id === 'create').error;
    assert.equal(error.code, -32006);
    assert.equal(error.data.creationOutcome, proven ? 'not-allocated' : undefined);
    assert.equal(error.data.creationRejectionCode, proven ? 'model_catalog_unavailable' : undefined);
  } finally { await session.close(); }
});

test('CodexProviderBridge pauses 100ms outbox polling while SSE stream is connected and wakes immediately on outbox events', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-sse-idle-'));
  const host = await BridgeHost.open({
    path: join(root, 'host.db'),
    policy: { id: 'sse-idle', capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 } },
    backend: localTestBackend(),
  });
  const attachment = await attachGateway(host, token);
  let eventPullRequests = 0;
  const sseSockets = new Set<import('node:net').Socket>();
  attachment.server.on('request', (req) => {
    if (req.url?.startsWith('/events?')) eventPullRequests++;
    if (req.url?.startsWith('/events/stream')) sseSockets.add(req.socket);
  });
  const frames: any[] = [];
  const legacy = {
    status: { state: 'open' as const },
    async connect() {},
    async close() {},
    subscribeStatus: () => () => {},
    subscribeMessage: () => () => {},
    async send() {},
  };
  const bridge = new CodexProviderBridge(legacy, {
    url: attachment.url,
    token,
    serverId: 'server-sse',
    inboxPath: join(root, 'inbox.db'),
  });
  bridge.subscribeMessage(raw => frames.push(JSON.parse(raw)));
  t.after(async () => {
    await bridge.close();
    await attachment.close();
    await host.close();
    await rm(root, { recursive: true, force: true });
  });

  await bridge.connect();
  const gateway = (bridge as any).gateway as BridgeGatewaySession;
  await until(() => gateway.isStreamConnected(), Boolean);
  // Wait for initial hello catch-up pull to settle completely.
  await delay(40);
  assert.equal((bridge as any).poll, undefined, '100ms interval timer is cleared while SSE is connected');

  const pullsBeforeIdle = eventPullRequests;
  await delay(450);
  assert.equal(eventPullRequests, pullsBeforeIdle, 'zero HTTP /events pulls occur during a 450ms idle window');

  // Seed a subscribed route and verify SSE outbox wakeup delivers structural events without polling jitter.
  const route = JSON.stringify(['server-sse', 'bridge:codex:sse-wake']);
  const hostStorage = (host as any).storage as Storage;
  await hostStorage.call('add', {
    id: 'g-sse',
    digest: '0'.repeat(64),
    artifact: '/unused/codex.cjs',
    provider: codexDeclaration,
    launch: { command: ['/unused/codex.cjs'], cwd: root, env: {} },
  });
  await hostStorage.call('activate', { id: 'g-sse', expected: '' });
  await hostStorage.call('admit', {
    route,
    digest: 'seed',
    maxSpoolBytes: 1024 * 1024,
    command: { serverId: 'server-sse', threadId: 'bridge:codex:sse-wake', commandId: 'seed', method: 'session/create', params: {} },
  });
  (bridge as any).clients.set('c1', { evidence: false, sharedInteractions: false, epoch: 1 });
  (bridge as any).subscriptions.set('bridge:codex:sse-wake', new Map([['c1', { mode: 'live' }]]));
  const committed = await hostStorage.call<{ high: number; structuralWritten: boolean }>('callback', {
    generation: 'g-sse',
    id: 'cb-wake-1',
    method: 'thread/notification',
    params: { threadId: route, method: 'thread/archived', params: {} },
  });
  (host as any).notifyOutbox(committed.high);
  await until(() => frames.some(f => f.method === 'thread/archived' && f.params?.threadId === 'bridge:codex:sse-wake'), Boolean);
  assert.equal(eventPullRequests, pullsBeforeIdle + 1, 'SSE outbox wakeup triggers exactly one /events pull');

  // Simulate transient SSE drop: fallback polling resumes while disconnected and stops again upon reconnect.
  const transitions: { connected: boolean; hasPoll: boolean }[] = [];
  const unsubscribeState = gateway.subscribeStreamState(connected => {
    transitions.push({ connected, hasPoll: (bridge as any).poll !== undefined });
  });
  for (const sock of sseSockets) sock.destroy();
  await until(
    () => transitions.some(t => !t.connected) && transitions.at(-1)?.connected === true,
    Boolean,
  );
  unsubscribeState();
  assert.equal(transitions.find(t => !t.connected)?.hasPoll, true, '100ms fallback poll activates synchronously on SSE disconnect');
  assert.equal(transitions.at(-1)?.hasPoll, false, '100ms fallback poll clears synchronously on SSE reconnect');
  assert.equal((bridge as any).poll, undefined);
});
