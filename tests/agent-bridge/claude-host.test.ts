import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { BridgeHost, type Generation } from '../../apps/agent-bridge-host/src/index.js';
import { CLAUDE_BRIDGE_DECLARATION } from '../../apps/claude-code-bridge/src/declaration.js';
import { localTestBackend } from './fixtures/local-backend.js';

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve('tsx');
const artifact = resolve('tests/agent-bridge/fixtures/fake-claude-bridge.ts');
const policy = { id: 'claude-bridge-test', capacity: { cpuMillis: 8000, memoryBytes: 16 * 1024 ** 3 } };
const token = 'test-private-token-000000000000000000000';

async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let index = 0; index < 300; index += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((accept) => setTimeout(accept, 20));
  }
  throw Error('Condition timed out');
}

async function setup(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'claude-bridge-host-'));
  const host = await BridgeHost.open({ path: join(root, 'host.db'), policy, backend: localTestBackend() });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const config: Generation = {
    id: 'claude-g1',
    artifact,
    digest: createHash('sha256').update(await readFile(artifact)).digest('hex'),
    provider: CLAUDE_BRIDGE_DECLARATION,
    launch: {
      command: [process.execPath, '--import', tsxLoader, artifact],
      cwd: root,
      env: { ...process.env } as Record<string, string>,
    },
  };
  await host.add(config);
  await host.activate('claude-g1', '');
  return { host, root };
}

const command = (commandId: string, method: string, params: Record<string, unknown> = {}, threadId = 'thread-claude') => ({
  commandId,
  serverId: 'server-1',
  threadId,
  method,
  params,
});

async function accepted(host: BridgeHost, id: string) {
  return until(() => host.query(id), (receipt) => receipt?.state === 'accepted');
}

test('Host + scripted Claude bridge holds a turn for a steer result and projects one turn', async (t) => {
  const { host } = await setup(t);
  await host.accept(command('create', 'session/create', { cwd: '/tmp/claude-host-test', model: 'haiku' }));
  const created = await accepted(host, 'create');
  assert.ok(created.response && 'result' in created.response);
  const providerThreadId = (created.response as any).result.providerThreadId;
  assert.match(providerThreadId, /^[0-9a-f-]{36}$/u);

  await host.accept(command('start', 'turn/start', {
    inputId: 'in1',
    clientRequestId: 'client-1',
    text: 'First prompt',
  }));
  await accepted(host, 'start');
  await host.accept(command('steer', 'turn/steer', {
    inputId: 's1',
    clientRequestId: 'client-2',
    text: 'Steer prompt',
  }));
  await accepted(host, 'steer');

  const events = await until(
    () => host.events(0, 256),
    (batch: any[]) => JSON.stringify(batch).includes('turn.completed'),
  );
  const canonical = events
    .map((row: any) => row.payload)
    .filter((payload: any) => payload?.kind === 'canonical')
    .map((payload: any) => payload.event);
  assert.equal(canonical.filter((event: any) => event.kind === 'turn.started').length, 1);
  assert.equal(canonical.filter((event: any) => event.kind === 'turn.completed').length, 1);
  const completed = canonical.find((event: any) => event.kind === 'turn.completed');
  assert.equal(completed.status, 'completed');
  const steerStates = canonical.filter((event: any) => event.kind === 'input.state' && event.status.inputId === 's1');
  assert.equal(steerStates.at(-1).status.evidence.value, 'context-confirmed');
  assert.equal(steerStates.at(-1).status.outcome, 'context-confirmed');

  const startReceipt = await host.query('start');
  assert.equal(startReceipt?.state, 'accepted');
  await host.accept(command('close', 'session/close')); await accepted(host, 'close');
  const high = events.at(-1).seq; await host.ack(high);
  await host.releaseThread('server-1', 'thread-claude');
});

test('a rejected first session/create does not brick the Thread identity', async (t) => {
  const { host } = await setup(t);
  await host.accept(command('bad-create', 'session/create', {}));
  const rejected = await until(() => host.query('bad-create'), (receipt) => receipt?.state === 'rejected');
  assert.equal((rejected?.response as any)?.error?.kind, 'invalid');
  await host.accept(command('good-create', 'session/create', { cwd: '/tmp/claude-host-test' }));
  const acceptedCreate = await accepted(host, 'good-create');
  assert.ok(acceptedCreate.response && 'result' in acceptedCreate.response);
  assert.match((acceptedCreate.response as any).result.providerThreadId, /^[0-9a-f-]{36}$/u);
});

test('Host records a stale steer explicitly instead of executing it twice', async (t) => {
  const { host } = await setup(t);
  await host.accept(command('create', 'session/create', { cwd: '/tmp/claude-host-test', model: 'haiku' }));
  await accepted(host, 'create');
  await host.accept(command('start', 'turn/start', { inputId: 'in1', clientRequestId: 'c1', text: 'One' }));
  await accepted(host, 'start');
  await until(() => host.events(0, 256), (batch: any[]) => JSON.stringify(batch).includes('turn.completed'));
  const stale = await host.accept(command('late', 'turn/steer', {
    inputId: 'late',
    clientRequestId: 'late-client',
    text: 'Too late',
    expectedTurnId: 'ct1',
  }));
  const receipt = await until(
    () => host.query('late'),
    (value) => value?.state !== 'registered' && value?.state !== 'dispatching',
  );
  assert.equal(receipt?.state, 'rejected');
  assert.equal((receipt?.response as any)?.error?.kind, 'stale-target');
  assert.equal(stale.state, 'registered');
});
