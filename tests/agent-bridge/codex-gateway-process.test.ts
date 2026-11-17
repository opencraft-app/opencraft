import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { resolve, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCodexPreview } from './fixtures/codex-preview.js';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';

test('Codex bridge continues one native tool/turn across gateway SIGKILL and durable input evidence replays once', async t => {
  const fixture = await createCodexPreview();
  const seed = fixture.createTransport(), seedFrames: any[] = [];
  await seed.connect(); seed.subscribeMessage(raw => seedFrames.push(JSON.parse(raw)));
  let sequence = 0, child: ChildProcess | undefined;
  const init = { capabilities: { extensions: { 'opencraft/steer-evidence': { version: 1 } } } };
  const seedRequest = async (method: string, params: unknown) => {
    const id = `seed:${++sequence}`; await seed.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: 'seed' }));
    const frame = seedFrames.find(f => f.id === id); assert(frame); assert.equal(frame.error, undefined); return frame.result;
  };
  const stop = async (proc?: ChildProcess) => { if (!proc || proc.exitCode !== null || proc.signalCode !== null) return; const done = once(proc, 'exit'); proc.send('close'); await done; };
  t.after(async () => { await stop(child); await seed.close(); await fixture.close(); });
  await seedRequest('initialize', init);
  await seedRequest('thread/start', { cwd: '/remote', agentBridge: { threadId: 'preview', clientRequestId: 'create' } });
  const started = await seedRequest('turn/start', { threadId: fixture.publicId, clientUserMessageId: 'start', input: [{ type: 'text', text: 'run once' }] });
  const turnId = started.turn.id; await seed.close();
  const frames: any[] = [];
  const open = async () => {
    const proc = fork(resolve('tests/agent-bridge/fixtures/codex-gateway-process.ts'), { execArgv: ['--import', 'tsx'], stdio: ['ignore','ignore','pipe','ipc'], env: { ...process.env, P2A_GATEWAY_CONFIG: JSON.stringify(fixture.gatewayOptions) } });
    proc.on('message', frame => frames.push(frame));
    const [ready] = await once(proc, 'message'); assert(ready.ready); return proc;
  };
  const request = async (method: string, params: unknown) => {
    const id = `gateway:${++sequence}`, deadline = Date.now() + 10000;
    child!.send({ id, method, params });
    while (Date.now() < deadline) { const frame = frames.find(f => f.id === id); if (frame) { assert.equal(frame.error, undefined, JSON.stringify(frame.error)); return frame.result; } await new Promise(r => setTimeout(r, 15)); }
    throw Error('Gateway RPC timed out');
  };
  child = await open(); const beforePid = child.pid;
  await request('initialize', init); await request('thread/resume', { threadId: fixture.publicId });
  await request('turn/steer', { threadId: fixture.publicId, expectedTurnId: turnId, clientUserMessageId: 'steer', input: [{ type: 'text', text: 'finish once' }] });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  fixture.confirm(); fixture.finish(); // native side progresses with no gateway
  child = await open(); assert.notEqual(child.pid, beforePid);
  await request('initialize', init); await request('thread/resume', { threadId: fixture.publicId });
  const history = await request('thread/read', { threadId: fixture.publicId, includeTurns: true });
  assert.equal(history.thread.turns[0].id, turnId); assert.equal(history.thread.turns[0].status, 'completed');
  assert.equal(history.thread.turns[0].items.filter((item: any) => item.clientId === 'steer').length, 1);
  const status = await request('opencraft/steer/status', { threadId: fixture.publicId });
  assert.equal(status.inputs.length, 1); assert.equal(status.inputs[0].evidence.value, 'context-confirmed');
  assert.deepEqual(fixture.counts(), { starts: 1, steers: 1 });
});

test('fresh AppHost inspector reads an active Bridge turn without resuming native execution', async t => {
  const { AppHostServer } = await import('../../packages/app-host-server/src/index.js');
  const { callConversationHost } = await import('../../scripts/conversation-execution.mjs');
  const fixture = await createCodexPreview(), transport = fixture.createTransport(), frames: any[] = [];
  await transport.connect(); transport.subscribeMessage(raw => frames.push(JSON.parse(raw)));
  const host = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: 'server', createTransport: () => transport });
  t.after(async () => { await host.close(); await transport.close(); await fixture.close(); });
  let sequence = 0;
  const request = async (method: string, params = {}) => {
    const id = ++sequence;
    await transport.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: 'original' }));
    const frame = frames.find(frame => frame.id === id); assert(frame); assert.equal(frame.error, undefined); return frame.result;
  };
  await request('initialize');
  await request('thread/start', { cwd: '/remote', agentBridge: { threadId: 'preview', clientRequestId: 'create' } });
  const started = await request('turn/start', { threadId: fixture.publicId, clientUserMessageId: 'input', input: [{ type: 'text', text: 'active turn' }] });
  const database = new DatabaseSync(join(dirname(fixture.gatewayOptions.inboxPath), 'host.db'), { readOnly: true });
  t.after(() => database.close());
  const commandCount = () => database.prepare('SELECT count(*) AS total FROM commands').get()!.total;
  const before = commandCount();
  for (let inspection = 0; inspection < 20; inspection++) {
    const result = await callConversationHost(host, { hostId: 'local-codex', threadId: fixture.publicId },
      'browser-execution-inspect', 'thread/turns/list', { threadId: fixture.publicId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }, { sender: null }, 2000);
    assert.equal(result.data.length, 1); assert.equal(result.data[0].id, started.turn.id);
    assert.equal(result.data[0].status, 'inProgress');
  }
  const observe = (body: unknown) => fetch(fixture.gatewayOptions.url + '/observe', { method: 'POST',
    headers: { authorization: 'Bearer ' + fixture.gatewayOptions.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const base = { serverId: fixture.gatewayOptions.serverId, threadId: fixture.publicId, params: {} };
  assert.equal((await observe({ ...base, method: 'turn/start' })).status, 409);
  assert.equal((await observe({ ...base, method: 'history/read', serverId: 'foreign-server' })).status, 409);
  assert.equal(commandCount(), before, 'observations must not append durable command receipts');
  assert.deepEqual(fixture.counts(), { starts: 1, steers: 0 });
});
