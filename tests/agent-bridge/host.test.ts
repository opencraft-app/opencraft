import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openManagedDatabase } from '@opencraft/sqlite-node';
import { BridgeHost, GatewayInbox, attachGateway, dispatchSettlement, type Generation } from '../../apps/agent-bridge-host/src/index.js';
import { Storage } from '../../apps/agent-bridge-host/src/storage.js';
import { migrations } from '../../apps/agent-bridge-host/src/migrations.js';
import { localTestBackend } from './fixtures/local-backend.js';
import { negotiateHandshake, type BridgeDeclaration } from '@opencraft/agent-bridge-protocol';
const token = 'test-private-token-000000000000000000000';
const declaration: BridgeDeclaration = {
  providerId: 'fake', protocolVersion: 1, grammarRange: { min: 1, max: 1 }, approvalExecutor: 'provider', minNativeVersion: '1', probeBasis: 'fake fixture',
  capabilities: { model: false, reasoning: false, history: false, usage: false, approval: false, inputContentTypes: ['text'], cliExecutable: false, forkCheckpoint: false, skills: false, installation: false,
    steer: { deliveryMethods: [], evidenceKinds: [], withdrawal: 'none', contentLimits: { maxBytes: 1024, allowedContentTypes: ['text'] }, maxPendingWithoutNativeId: 1, fallbackPolicy: 'reject-unknown' } },
};
async function config(root: string, id = 'g1', hostPid = process.pid): Promise<Generation> {
  const artifact = resolve('tests/agent-bridge/fixtures/fake-bridge.mjs');
  const handshake = negotiateHandshake({ protocolVersion: 1, grammarRange: { min: 1, max: 1 } }, declaration);
  assert(handshake.ok);
  return { id, artifact, digest: createHash('sha256').update(await readFile(artifact)).digest('hex'), provider: declaration,
    launch: { command: [process.execPath, artifact], cwd: root, env: { HANDSHAKE: JSON.stringify(handshake.result), EXECUTIONS: join(root, 'executions'), HOST_PID: String(hostPid) } } };
}
const policy = { id: 'test-bridge', capacity: { cpuMillis: 16000, memoryBytes: 32 * 1024 ** 3 } };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 150; i++) { const value = await read(); if (predicate(value)) return value; await delay(25); }
  throw Error('Condition timed out');
}
async function setup(t: any, maxSpoolBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-p1b-'));
  const host = await BridgeHost.open({ path: join(root, 'host.db'), policy, backend: localTestBackend(), maxSpoolBytes });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  await host.add(await config(root)); await host.activate('g1', '');
  return { host, root };
}
const command = (commandId: string, method: string = 'session/create', params = {}, threadId = 'thread-1') => ({ commandId, serverId: 'server-1', threadId, method, params });
async function accepted(host: BridgeHost, id: string) { return until(() => host.query(id), r => r?.state === 'accepted'); }
async function rpc(url: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, 200); return response.json();
}
function child(file: string, env: Record<string, string>): ChildProcess {
  return fork(resolve('tests/agent-bridge/fixtures/' + file), { execArgv: ['--import', 'tsx'], env: { ...process.env, ...env }, stdio: ['ignore','ignore','pipe','ipc'] });
}
async function stop(proc: ChildProcess) { if (proc.exitCode !== null || proc.signalCode !== null) return; const exit = once(proc, 'exit'); proc.send('close'); await exit; }

test('durable admission, input digest and duplicate commandId do not resend native mutation', async t => {
  const { host, root } = await setup(t);
  assert.equal((await host.snapshot()).databaseOutcome.status, 'fresh');
  const first = await host.accept(command('create'));
  assert.equal(first.state, 'registered'); assert.equal(first.epoch, 1);
  await accepted(host, 'create');
  await host.accept(command('start', 'turn/start')); await accepted(host, 'start');
  await host.accept(command('start', 'turn/start'));
  await assert.rejects(host.accept(command('start', 'turn/start', { changed: true })), /different input/);
  assert.equal((await readFile(join(root, 'executions'), 'utf8')).trim().split('\n').length, 1);
});

test('real gateway process restart leaves independent Host/bridge PID and Turn running; durable projection has no duplicates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-process-'));
  const proc = child('host-process.ts', { TEST_DB: join(root, 'host.db'), TEST_TOKEN: token });
  let gateway: ChildProcess | undefined;
  t.after(async () => { if (gateway) await stop(gateway); await stop(proc); await rm(root, { recursive: true, force: true }); });
  const [descriptor] = await once(proc, 'message');
  await rpc(descriptor.url, '/generation/add', await config(root, 'g1', descriptor.pid));
  await rpc(descriptor.url, '/generation/activate', { id: 'g1', expected: '' });
  await rpc(descriptor.url, '/command', command('create'));
  const created = await until(() => rpc(descriptor.url, '/command?id=create'), r => r.state === 'accepted');
  const bridgePid = created.response.result.pid;
  await rpc(descriptor.url, '/command', command('start', 'turn/start'));
  await delay(250);
  const env = { INBOX_DB: join(root, 'gateway.db'), HOST_URL: descriptor.url, TEST_TOKEN: token };
  gateway = child('gateway-process.ts', env); await once(gateway, 'message');
  let answer = once(gateway, 'message'); gateway.send('pull'); const [first] = await answer; assert(first.events.length > 0);
  gateway.kill('SIGKILL'); await once(gateway, 'exit');
  await delay(1700);
  gateway = child('gateway-process.ts', env); await once(gateway, 'message');
  answer = once(gateway, 'message'); gateway.send('pull'); const [second] = await answer;
  assert(second.events.some((e: any) => e.payload.event?.kind === 'turn.completed'));
  answer = once(gateway, 'message'); gateway.send('pull'); const [third] = await answer; assert.deepEqual(third.events, []);
  assert.equal((await rpc(descriptor.url, '/health')).pid, descriptor.pid);
  process.kill(bridgePid, 0);
  const turns = [...first.events, ...second.events].filter((e: any) => e.payload.event?.kind.startsWith('turn.'));
  assert(turns.every((e: any) => e.payload.event.atMs > Date.UTC(2020, 0, 1)));
  assert.equal(new Set(turns.map((e: any) => e.payload.event.turnId)).size, 1);
  assert.equal(new Set([...first.events, ...second.events].map((e: any) => e.seq)).size, first.events.length + second.events.length);
  assert.equal((await readFile(join(root, 'executions'), 'utf8')).trim().split('\n').length, 1);
});

test('Host SIGKILL after native send recovers unknown and never performs second native execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-crash-'));
  let proc = child('host-process.ts', { TEST_DB: join(root, 'host.db'), TEST_TOKEN: token });
  let nativePid: number | undefined;
  t.after(async () => { await stop(proc); if (nativePid) { try { process.kill(-nativePid, 'SIGKILL'); } catch {} } await rm(root, { recursive: true, force: true }); });
  let [descriptor] = await once(proc, 'message');
  await rpc(descriptor.url, '/generation/add', await config(root, 'g1', descriptor.pid));
  await rpc(descriptor.url, '/generation/activate', { id: 'g1', expected: '' });
  await rpc(descriptor.url, '/command', command('create'));
  nativePid = (await until(() => rpc(descriptor.url, '/command?id=create'), r => r.state === 'accepted')).response.result.pid;
  const exit = once(proc, 'exit');
  // It may die after admission response or while the response is in flight.
  await rpc(descriptor.url, '/command', command('crash', 'turn/start', { crashWindow: true })).catch(() => {});
  await exit;
  proc = child('host-process.ts', { TEST_DB: join(root, 'host.db'), TEST_TOKEN: token }); [descriptor] = await once(proc, 'message');
  const recovered = await rpc(descriptor.url, '/command?id=crash'); assert.equal(recovered.state, 'unknown'); assert.equal(recovered.epoch, 1);
  const duplicate = await rpc(descriptor.url, '/command', command('crash', 'turn/start', { crashWindow: true })); assert.equal(duplicate.state, 'unknown');
  await delay(200);
  assert.equal((await readFile(join(root, 'executions'), 'utf8')).trim().split('\n').length, 1);
});

test('generation activation pins old threads and refuses retirement until native work and outbox drain', async t => {
  const { host, root } = await setup(t);
  await host.accept(command('create')); await accepted(host, 'create');
  await host.add(await config(root, 'g2')); await host.activate('g2', 'g1');
  await assert.rejects(host.activate('g1', 'g1'), /Stale/);
  await host.accept(command('new', 'session/create', {}, 'thread-2')); await accepted(host, 'new');
  assert.equal((await host.query('new'))?.generation, 'g2');
  await host.accept(command('old-start', 'turn/start')); await accepted(host, 'old-start');
  assert.equal((await host.query('old-start'))?.generation, 'g1');
  await assert.rejects(host.retire('g1'), /bindings/);
  await assert.rejects(host.releaseThread('server-1', 'thread-1'), /work/);
  await delay(1800);
  await host.accept(command('close', 'session/close')); await accepted(host, 'close');
  await assert.rejects(host.releaseThread('server-1', 'thread-1'), /unacknowledged/);
  const events = await host.events(0); await host.ack(events.at(-1).seq);
  assert((await host.snapshot()).nativeSessions.some((row: any) => row.native_id.startsWith('native-')));
  await host.releaseThread('server-1', 'thread-1'); await host.retire('g1');
  await assert.rejects(host.accept(command('rebind-old')), /permanently closed/);
});

test('storage lock wait leaves network heartbeat and timers responsive; shutdown drains accepted writes', async t => {
  const { host, root } = await setup(t);
  const gateway = await attachGateway(host, token); t.after(() => gateway.close());
  const lock = new DatabaseSync(join(root, 'host.db')); lock.exec('BEGIN IMMEDIATE');
  let beats = 0; const timer = setInterval(() => beats++, 10);
  const admission = host.accept(command('blocked'));
  let settled = false; void admission.then(() => { settled = true; });
  await delay(150);
  assert.equal(settled, false); assert(beats >= 8);
  assert.equal((await rpc(gateway.url, '/health')).pid, process.pid);
  lock.exec('ROLLBACK'); lock.close(); clearInterval(timer);
  assert.equal((await admission).state, 'registered'); await accepted(host, 'blocked');
});

test('spool overflow refuses new tasks while preserving all active task events', async t => {
  const { host } = await setup(t, 1);
  await host.accept(command('create')); await accepted(host, 'create');
  await host.ack((await host.events(0)).at(-1).seq);
  await host.accept(command('start', 'turn/start')); await accepted(host, 'start');
  await delay(1800);
  await assert.rejects(host.accept(command('new', 'session/create', {}, 'thread-2')), /Spool full/);
  await host.accept(command('stop-when-full', 'turn/stop')); await accepted(host, 'stop-when-full');
  const events = await host.events(1);
  assert(JSON.stringify(events).includes('15,'));
  assert(events.some((e: any) => e.payload.event?.kind === 'turn.completed'));
});

test('v1 migration preserves admission on upgrade and checksum mismatch refuses startup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-migration-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'host.db');
  let { database } = openManagedDatabase({ path, migrations: migrations.slice(0, 1) });
  database.exec("INSERT INTO commands VALUES ('original','digest',4,'route','g','turn/start','dispatching',NULL)"); database.close();
  const store = new Storage(path); assert.equal((await store.ready).status, 'migrated');
  assert.equal((await store.call('query', { id: 'original' })).state, 'unknown'); await store.close();
  database = new DatabaseSync(path); database.exec("UPDATE schema_migrations SET checksum='tampered' WHERE version=1"); database.close();
  const broken = new Storage(path); await assert.rejects(broken.ready, /migration history/); await broken.close().catch(() => {});
});

test('durable inbox transaction deduplicates replay including ack-loss and rejects gaps', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-inbox-')); t.after(() => rm(root, { recursive: true, force: true }));
  const inbox = new GatewayInbox(join(root, 'inbox.db')); await inbox.storage.ready;
  const event = { seq: 1, route: 'route', generation: 'g', payload: { text: 'one' } };
  assert.equal((await inbox.storage.call('inbox', { batch: [event] })).inserted.length, 1);
  await inbox.close();
  const reopened = new GatewayInbox(join(root, 'inbox.db')); await reopened.storage.ready;
  assert.deepEqual((await reopened.storage.call('inbox', { batch: [event] })).inserted, []);
  await assert.rejects(reopened.storage.call('inbox', { batch: [{ ...event, seq: 3 }] }), /gap/);
  assert.equal((await reopened.read()).length, 1); await reopened.close();
});

test('selected sandbox backend failure rejects execution and has no local fallback', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-failure-')); t.after(() => rm(root, { recursive: true, force: true }));
  const backend = localTestBackend(); backend.initialize = async () => { throw Error('unavailable'); };
  const host = await BridgeHost.open({ path: join(root, 'host.db'), policy, backend });
  await host.add(await config(root)); await assert.rejects(host.activate('g1', ''), /provider could not initialize/);
  assert.equal((await host.snapshot()).current, '');
  await host.close().catch(() => {});
});


test('runtime guard forbids main-thread SQL and blocking filesystem IO through actual Host lifecycle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-guard-'));
  const proc = child('host-process.ts', { TEST_DB: join(root, 'host.db'), TEST_TOKEN: token, GUARD_IO: '1' });
  t.after(async () => { await stop(proc); await rm(root, { recursive: true, force: true }); });
  const [descriptor] = await once(proc, 'message');
  await rpc(descriptor.url, '/generation/add', await config(root, 'g1', descriptor.pid));
  await rpc(descriptor.url, '/generation/activate', { id: 'g1', expected: '' });
  await rpc(descriptor.url, '/command', command('guarded'));
  assert.equal((await until(() => rpc(descriptor.url, '/command?id=guarded'), r => r.state === 'accepted')).state, 'accepted');
});

test('Host close reclaims a bridge and its background descendant process group', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-cleanup-'));
  const host = await BridgeHost.open({ path: join(root, 'host.db'), policy, backend: localTestBackend() });
  t.after(() => rm(root, { recursive: true, force: true }));
  await host.add(await config(root)); await host.activate('g1', '');
  await host.accept(command('child', 'session/create', { spawnDescendant: true }));
  const receipt = await accepted(host, 'child');
  const result = (receipt!.response as any).result;
  await host.close();
  // A killed descendant can briefly remain a zombie until PID 1 reaps it.
  for (const pid of [result.pid, result.descendant]) {
    await until(async () => { try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z'); } catch { return true; } }, gone => gone);
  }
});

test('Worker loss rejects outstanding storage operations and cannot fall back to main-thread SQL', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-worker-loss-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Storage(join(root, 'host.db')); await store.ready;
  await (store as any).worker.terminate();
  await assert.rejects(store.call('snapshot'), /worker exited/);
  await assert.rejects(store.close(), /worker exited/);
});

test('generation draining refuses unfinished text streams and queued inputs even after echo evidence and native close', async t => {
  for (const unsettled of ['stream', 'queue']) {
    const { host } = await setup(t);
    await host.accept(command('create', 'session/create', { unsettled })); await accepted(host, 'create');
    await host.accept(command('close', 'session/close')); await accepted(host, 'close');
    const events = await host.events(0); let cursor = events.at(-1).seq; await host.ack(cursor);
    await assert.rejects(host.releaseThread('server-1', 'thread-1'), /work or unknown/);
    await host.accept(command('settle', 'turn/stop', { settle: unsettled })); await accepted(host, 'settle');
    cursor = (await host.events(cursor)).at(-1).seq; await host.ack(cursor);
    await host.releaseThread('server-1', 'thread-1');
  }
});

test('storage Worker loss during a live native task reclaims the bridge and stops new admission', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-live-loss-'));
  const host = await BridgeHost.open({ path: join(root, 'host.db'), policy, backend: localTestBackend() });
  t.after(async () => { await host.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await host.add(await config(root)); await host.activate('g1', '');
  await host.accept(command('create')); const created = await accepted(host, 'create');
  const pid = (created!.response as any).result.pid;
  await host.accept(command('start', 'turn/start')); await accepted(host, 'start');
  await (host as any).storage.worker.terminate();
  await until(async () => { try { process.kill(pid, 0); return false; } catch { return true; } }, gone => gone);
  await assert.rejects(host.accept(command('new', 'session/create', {}, 'thread-2')), /Host closing/);
});

test('storage close seals new calls immediately and drains earlier requests before releasing its writer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-close-drain-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Storage(join(root, 'host.db')); await store.ready;
  const acceptedBeforeClose = store.call('snapshot');
  const closing = store.close();
  assert.equal(store.close(), closing);
  await assert.rejects(store.call('snapshot'), /closing or closed/);
  assert.equal((await acceptedBeforeClose).epoch, 1);
  await closing;
  const reopened = new Storage(join(root, 'host.db')); await reopened.ready;
  assert.equal((await reopened.call('snapshot')).epoch, 2); await reopened.close();
});


test('deterministic provider refusals settle rejected; only ambiguous outcomes stay unknown', () => {
  assert.equal(dispatchSettlement({ jsonrpc: '2.0', id: '1', result: {} }), 'accepted');
  for (const kind of ['explicit-reject', 'invalid', 'unsupported', 'stale-target', 'auth', 'quota', 'frame-too-large'] as const) {
    assert.equal(dispatchSettlement({ jsonrpc: '2.0', id: '1', error: { kind, code: -32000, message: kind } }), 'rejected', kind);
  }
  for (const kind of ['unknown-outcome', 'internal'] as const) {
    assert.equal(dispatchSettlement({ jsonrpc: '2.0', id: '1', error: { kind, code: -32000, message: kind } }), 'unknown', kind);
  }
});
