import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { startIndependentAcpHost } from '../../scripts/server-deployment/acp-host.mjs';
import { attachEngineHost } from '../../scripts/server-deployment/engine-host-client.mjs';

async function connect(url) {
  const socket = new WebSocket(url), calls = new Map(); let sequence = 0;
  socket.on('message', bytes => { const frame = JSON.parse(String(bytes)); const pending = calls.get(frame.id); if (!pending || frame.method) return; calls.delete(frame.id); frame.error ? pending.reject(new Error(frame.error.message)) : pending.resolve(frame.result); });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const request = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; calls.set(id, { resolve, reject }); socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  await request('initialize', { clientInfo: { name: 'fixture', version: '1' } });
  return { socket, request };
}

test('independent Claude ACP Host retains native PID and turn when a gateway attachment closes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'independent-acp-host-test-')), configPath = join(root, 'generation.json');
  await writeFile(configPath, JSON.stringify({ command: process.execPath, args: [resolve('tests/fixtures/acp-engine-peer.mjs')], cwd: root }), { mode: 0o600 });
  const options = { id: 'claude-code', descriptorPath: join(root, 'host.json'), dataDirectory: join(root, 'data'), runtimeDirectory: root,
    initialGeneration: { id: 'one', configPath } };
  const host = await startIndependentAcpHost(options);
  const descriptor = JSON.parse(await readFile(options.descriptorPath, 'utf8'));
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const attachment = await attachEngineHost(options.descriptorPath, options.dataDirectory, descriptor.machineId, ['claude-code'], 'claude-code');
  const gateway = await connect(attachment.websocketUrl);
  const created = await gateway.request('thread/start', {});
  assert.match(created.thread.id, /^claude_/);
  const started = await gateway.request('turn/start', { threadId: created.thread.id, input: [{ type: 'text', text: 'wait' }] });
  const before = host.provider.snapshot().generations[0];
  assert.equal(before.occupancy.activeTurns, 1);
  gateway.socket.close(); await attachment.close();
  const deadline = Date.now() + 3000;
  while (host.provider.snapshot().generations[0].occupancy.activeTurns && Date.now() < deadline) await delay(20);
  const after = host.provider.snapshot().generations[0];
  assert.equal(after.pid, before.pid); assert.equal(after.occupancy.activeTurns, 0);
  const successor = await connect((await attachEngineHost(options.descriptorPath, options.dataDirectory, descriptor.machineId, ['claude-code'], 'claude-code')).websocketUrl);
  t.after(() => successor.socket.close());
  const read = await successor.request('thread/read', { threadId: created.thread.id });
  assert.equal(read.thread.id, created.thread.id);
  const snapshot = await host.provider.request('opencraft/orchestration/status', { threadId: created.thread.id }, { notify() {}, async request() {} });
  assert.equal(snapshot.turnId, started.turn.id); assert.equal(snapshot.state, 'completed');
  const unauthorized = await fetch(new URL('/generations', descriptor.controlUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'activate', id: 'bad' }) });
  assert.equal(unauthorized.status, 403);
});

test('DSH ACP native tool results retain the 0.2 message body through the shared history projection', async () => {
  const { normalizeDshAcpNativeEvent } = await import('../../scripts/server-deployment/dsh-acp-history.mjs');
  const { projectDshNativeEvents } = await import('../../apps/local-agent-host/src/dsh-appserver-adapter.ts');
  const nativeResult = { type: 'tool/result', seq: 3, time: 150, data: { turn: 1, message: {
    role: 'tool', source: { kind: 'tool', callId: 'call' }, toolCallId: 'call', isError: false,
    content: [{ type: 'text', text: 'native tool output' }],
  } } };
  const original = JSON.stringify(nativeResult);
  const turns = projectDshNativeEvents('native-id', [
    { event: { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } } },
    { event: { type: 'tool/call', seq: 1, time: 110, data: { turn: 1, callId: 'call', name: 'example', arguments: '{}' } } },
    { event: normalizeDshAcpNativeEvent(nativeResult) },
    { event: { type: 'turn/end', seq: 4, time: 160, data: { turn: 1, reason: { kind: 'completed' } } } },
  ], { cwd: '/workspace' });
  const tool = turns[0].items.find(item => item.type === 'dynamicToolCall');
  assert.deepEqual(tool.contentItems, [{ type: 'inputText', text: 'native tool output' }]);
  assert.equal(JSON.stringify(nativeResult), original);
});

test('production multi-engine entry aggregates Pi and two independently rooted ACP owners and preserves their running native inputs on close', async t => {
  const { startIndependentEngineHost } = await import('../../scripts/server-deployment/engine-host.mjs');
  const { ModelConfigurationRepository } = await import('../../apps/local-agent-host/src/model-config/repository.ts');
  const { SessionCapabilities } = await import('../../packages/session-capabilities/src/index.ts');
  const { SessionCapabilityMcp, capabilitySigningKey } = await import('../../packages/session-capabilities/src/mcp.ts');
  const { readDaemonMachineIdentity } = await import('../../apps/opencraft-daemon/src/machine-identity.ts');
  const root = await mkdtemp(join(tmpdir(), 'acp-production-aggregation-test-')), piRoot = join(root, 'pi');
  const machine = await readDaemonMachineIdentity(piRoot), authorizations = [], owners = [];
  const capability = new SessionCapabilityMcp(new SessionCapabilities(), capabilitySigningKey(join(piRoot, 'session-capabilities.key')), undefined, {
    descriptorPath: join(piRoot, 'session-capabilities.json'), authorizeInput(session, inputId) {
      authorizations.push({ ...session, inputId });
      return ['acp', 'claude-code'].some(id => session.serverId === `server:${machine.machineId}:${id}` && inputId === `actor-input:${id}-accepted`);
    },
  });
  await capability.listen();
  let aggregate, gateway;
  t.after(async () => {
    gateway?.socket.close(); await aggregate?.close();
    await Promise.all(owners.map(owner => owner.host.close())); await capability.close(); await rm(root, { recursive: true, force: true });
  });
  await new ModelConfigurationRepository(join(piRoot, 'models')).initialize({ schemaVersion: 1, revision: 0, providers: [], defaultModel: null });
  for (const id of ['acp', 'claude-code']) {
    const configPath = join(root, `${id}-generation.json`), dataDirectory = join(root, id);
    await writeFile(configPath, JSON.stringify({ command: process.execPath, args: [resolve('tests/fixtures/acp-engine-peer.mjs')], cwd: root, permission: 'allow-once' }), { mode: 0o600 });
    const descriptorPath = join(root, `${id}-host.json`);
    const host = await startIndependentAcpHost({ id, descriptorPath, dataDirectory, runtimeDirectory: root, machineIdentityDirectory: piRoot,
      sessionCapabilitiesDirectory: piRoot, initialGeneration: { id: 'one', configPath } });
    owners.push({ id, dataDirectory, descriptorPath, host });
  }
  assert.notEqual(owners[0].dataDirectory, owners[1].dataDirectory);
  const options = { descriptorPath: join(root, 'aggregate.json'), dataDirectory: piRoot, runtimeDirectory: root,
    engines: ['pi', 'acp', 'claude-code'], defaultEngine: 'pi', remoteEngines: owners.map(({ id, descriptorPath, dataDirectory }) => ({ id, descriptorPath, dataDirectory })) };
  aggregate = await startIndependentEngineHost(options); gateway = await connect(aggregate.websocketUrl);
  const engines = await gateway.request('runtime/engines/list'); assert.deepEqual(engines.data.map(engine => engine.id).sort(), ['acp', 'claude-code', 'pi']);
  const models = await gateway.request('model/list'); assert.deepEqual(models.unavailableEngines, []); assert.ok(Array.isArray(models.data));
  const attachment = await attachEngineHost(options.descriptorPath, piRoot, machine.machineId, options.engines, 'pi');
  for (const owner of owners) {
    const created = await gateway.request('thread/start', { model: `${owner.id}:fixture` }); owner.threadId = created.thread.id;
    assert.ok(created.thread.id.startsWith(owner.id === 'acp' ? 'acp_' : 'claude_'));
    const inputId = `actor-input:${owner.id}-accepted`;
    const receipt = await attachment.inputs.submit(created.thread.id, inputId, 'wait', () => true);
    assert.equal(receipt.state, 'delivered'); owner.turnId = receipt.turnId; owner.nativePid = owner.host.provider.snapshot().generations[0].pid;
    assert.deepEqual(await attachment.inputs.receipt(created.thread.id, inputId), receipt);
    assert.equal(owner.host.provider.snapshot().generations[0].occupancy.activeTurns, 1);
  }
  assert.equal(new Set(owners.map(owner => owner.nativePid)).size, 2);
  await aggregate.close();
  const deadline = Date.now() + 3000;
  while (owners.some(owner => owner.host.provider.snapshot().generations[0].occupancy.activeTurns) && Date.now() < deadline) await delay(20);
  for (const owner of owners) {
    assert.equal(owner.host.provider.snapshot().generations[0].pid, owner.nativePid);
    const status = await owner.host.provider.request('opencraft/orchestration/status', { threadId: owner.threadId }, { notify() {}, async request() {} });
    assert.equal(status.turnId, owner.turnId); assert.equal(status.state, 'completed');
    const remote = await attachEngineHost(owner.descriptorPath, owner.dataDirectory, machine.machineId, [owner.id], owner.id);
    assert.equal((await remote.getIdentity()).pid, process.pid);
    const admitted = authorizations.filter(call => call.threadId === owner.threadId);
    assert.ok(admitted.length > 0);
    assert.ok(admitted.every(call => call.serverId === `server:${machine.machineId}:${owner.id}` && call.inputId === `actor-input:${owner.id}-accepted`));
  }
});
