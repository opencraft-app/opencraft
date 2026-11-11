import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxPool, type SandboxBackend, type SandboxOutput } from '@opencraft/sandbox';
import { Peer } from '../../apps/agent-bridge-host/src/peer.js';
import type { Generation } from '../../apps/agent-bridge-host/src/types.js';
const config = { id: 'test', digest: 'test', launch: { command: ['fake'], cwd: '/fake', env: {} } } as Generation;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function harness(callback: (id: string, method: string, params: unknown) => Promise<void>, cleanupFails = false, pipeFailureAt = Infinity) {
  let output!: (value: SandboxOutput) => void;
  let exit!: (value: { code: number }) => void;
  let closed = 0, writes = 0;
  const exited = new Promise<{ code: number }>(resolve => { exit = resolve; });
  const backend: SandboxBackend = { id: 'memory', async initialize() {}, async close() {}, async create(_id, resources) {
    return { resources, capabilities: { terminal: false }, async spawn(_command, consume) {
      output = consume!;
      return { id: 'fake', kind: 'process', exited, async writeStdin() { writes++; if (writes >= pipeFailureAt) throw Object.assign(Error('write EPIPE'), { code: 'EPIPE' }); }, async closeStdin() {}, async terminate() { exit({ code: 0 }); } };
    }, async close() { closed++; exit({ code: 0 }); if (cleanupFails) throw Error('Cleanup unconfirmed'); } };
  } };
  const pool = await createSandboxPool({ id: 'peer-test', capacity: { cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 } }, backend);
  const peer = new Peer(config, callback);
  await peer.start(pool);
  const emit = () => output({ stream: 'stdout', data: Buffer.from(['one', 'two'].map(id => JSON.stringify({ jsonrpc: '2.0', id, method: 'thread/identity', params: { threadId: 'thread', providerThreadId: id } })).join('\n') + '\n') });
  return { peer, pool, emit, exit, get closed() { return closed; }, get writes() { return writes; } };
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
    const h = await harness(async () => { throw Error('Storage owner failed'); }, cleanupFails);
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
  const h = await harness(async (_id, _method, params: any) => { committed.push(params.providerThreadId); }, false, 2);
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
