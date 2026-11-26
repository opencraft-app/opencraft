import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxPool, type SandboxBackend, type SandboxOutput } from '@opencraft/sandbox';
import { Peer } from '../../apps/agent-bridge-host/src/peer.js';
import type { Generation } from '../../apps/agent-bridge-host/src/types.js';
const config = { id: 'test', digest: 'test', launch: { command: ['fake'], cwd: '/fake', env: {} } } as Generation;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function harness(callback: (id: string, method: string, params: unknown) => Promise<void>, options: {
  cleanupFails?: boolean;
  pipeFailureAt?: number;
  writeGate?: Promise<void>;
  onWrite?: () => void;
  timeoutMs?: number;
} = {}) {
  let output!: (value: SandboxOutput) => void;
  let exit!: (value: { code: number }) => void;
  let closed = 0, writes = 0;
  const exited = new Promise<{ code: number }>(resolve => { exit = resolve; });
  const backend: SandboxBackend = { id: 'memory', async initialize() {}, async close() {}, async create(_id, resources) {
    return { resources, capabilities: { terminal: false }, async spawn(_command, consume) {
      output = consume!;
      return { id: 'fake', kind: 'process', exited, async writeStdin() {
        writes++;
        options.onWrite?.();
        if (writes >= (options.pipeFailureAt ?? Infinity)) throw Object.assign(Error('write EPIPE'), { code: 'EPIPE' });
        await options.writeGate;
      }, async closeStdin() {}, async terminate() { exit({ code: 0 }); } };
    }, async close() { closed++; exit({ code: 0 }); if (options.cleanupFails) throw Error('Cleanup unconfirmed'); } };
  } };
  const pool = await createSandboxPool({ id: 'peer-test', capacity: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 } }, backend);
  const peer = new Peer(config, callback, options.timeoutMs);
  await peer.start(pool);
  const emit = () => output({ stream: 'stdout', data: Buffer.from(['one', 'two'].map(id => JSON.stringify({ jsonrpc: '2.0', id, method: 'thread/identity', params: { threadId: 'thread', providerThreadId: id } })).join('\n') + '\n') });
  const reply = (id: string, result: unknown) => output({ stream: 'stdout', data: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n') });
  return { peer, pool, emit, reply, exit, get closed() { return closed; }, get writes() { return writes; } };
}

test('EOF during callback commit drains every already received request even when acknowledgements cannot be written', async () => {
  const committed: string[] = [];
  const h = await harness(async (_id, _method, params: any) => { await wait(15); committed.push(params.providerThreadId); });
  h.emit(); h.exit({ code: 0 });
  await h.peer.close(); await h.pool.close();
  assert.deepEqual(committed, ['one', 'two']);
});

test('callback storage failure stops the entire sandbox and cleanup failure remains visible', async () => {
  for (const cleanupFails of [false, true]) {
    const h = await harness(async () => { throw Error('Storage owner failed'); }, { cleanupFails });
    h.emit(); await wait(20);
    assert.equal(h.closed, 1);
    if (cleanupFails) {
      await assert.rejects(h.peer.close(), /Cleanup unconfirmed/);
      await assert.rejects(h.pool.close(), /cleanup is unverified/);
    } else { await h.peer.close(); await h.pool.close(); }
    await assert.rejects(h.peer.request('another', 'turn/start', {}), /Storage owner failed/);
  }
});


test('failed callback acknowledgement drains committed facts and refuses subsequent writes without replay', async () => {
  const committed: string[] = [];
  const h = await harness(async (_id, _method, params: any) => { committed.push(params.providerThreadId); }, { pipeFailureAt: 2 });
  try {
    const pending = assert.rejects(h.peer.request('mutation', 'turn/start', {}), /EPIPE/);
    h.emit();
    await pending;
    await wait(20);
    assert.deepEqual(committed, ['one', 'two']);
    assert.equal(h.peer.diagnostic().failed, true);
    assert.equal(h.writes, 2);
    await assert.rejects(h.peer.request('later-mutation', 'turn/start', {}), /EPIPE/);
    assert.equal(h.writes, 2, 'a failed stream cannot authorize a second write');
  } finally { await h.peer.close(); await h.pool.close(); }
});

test('a command deadline releases a blocked stdin write and retires the peer', async () => {
  const held = Promise.withResolvers<void>();
  const h = await harness(async () => {}, { writeGate: held.promise, timeoutMs: 20 });
  let settled = false;
  const pending = assert.rejects(h.peer.request('mutation', 'turn/start', {}), /outcome unknown/)
    .then(() => { settled = true; });
  try {
    await Promise.race([pending, wait(100)]);
    assert.equal(settled, true, 'the request deadline must settle even if the backend write remains held');
    assert.equal(h.peer.diagnostic().failed, true);
    assert.equal(h.closed, 1, 'an unconfirmed write makes this sandbox unsafe for reuse');
    h.reply('mutation', { accepted: true });
    await assert.rejects(h.peer.request('next', 'turn/start', {}), /outcome unknown/);
    assert.equal(h.writes, 1);
  } finally {
    held.resolve();
    await pending;
    await h.peer.close();
    await h.pool.close();
  }
});

test('a reply deadline after a completed stdin write leaves the peer available', async () => {
  const h = await harness(async () => {}, { timeoutMs: 20 });
  try {
    await assert.rejects(h.peer.request('late', 'turn/start', {}), /outcome unknown/);
    assert.equal(h.peer.diagnostic().failed, false);
    assert.equal(h.closed, 0);
    const next = h.peer.request('next', 'model/list', {});
    h.reply('late', { accepted: true });
    h.reply('next', { models: [] });
    assert.deepEqual(await next, { jsonrpc: '2.0', id: 'next', result: { models: [] } });
  } finally {
    await h.peer.close();
    await h.pool.close();
  }
});

test('held callback acknowledgement leaves durable intake and close free to finish', async () => {
  const held = Promise.withResolvers<void>();
  const writing = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  const committed: string[] = [];
  const h = await harness(async (_id, _method, params: any) => {
    committed.push(params.providerThreadId);
    if (params.providerThreadId === 'two') drained.resolve();
  }, { writeGate: held.promise, onWrite: writing.resolve, timeoutMs: 2000 });
  let closing: Promise<void> | undefined;
  try {
    h.emit();
    await writing.promise;
    assert.equal(await Promise.race([drained.promise.then(() => true), wait(100).then(() => false)]), true,
      'the second callback must commit before the first acknowledgement returns');
    assert.deepEqual(committed, ['one', 'two']);
    assert.equal(h.writes, 1, 'acknowledgements are written in order');
    h.exit({ code: 0 });
    closing = h.peer.close();
    assert.equal(await Promise.race([closing.then(() => true), wait(100).then(() => false)]), true,
      'EOF must release the acknowledgement wait even if the backend write stays held');
    assert.equal(h.writes, 1, 'no acknowledgement is started after EOF');
  } finally {
    held.resolve();
    await closing;
    await h.peer.close();
    await h.pool.close();
  }
});

test('a stalled callback reply deadline reclaims the sandbox without dropping committed callbacks', async () => {
  const held = Promise.withResolvers<void>();
  const committed: string[] = [];
  const h = await harness(async (_id, _method, params: any) => {
    committed.push(params.providerThreadId);
  }, { writeGate: held.promise, timeoutMs: 20 });
  try {
    h.emit();
    await wait(100);
    assert.equal(h.peer.diagnostic().failed, true);
    assert.equal(h.closed, 1);
    assert.deepEqual(committed, ['one', 'two']);
    await assert.rejects(h.peer.request('next', 'turn/start', {}), /callback reply write timed out/);
    assert.equal(h.writes, 1);
  } finally {
    held.resolve();
    await h.peer.close();
    await h.pool.close();
  }
});
