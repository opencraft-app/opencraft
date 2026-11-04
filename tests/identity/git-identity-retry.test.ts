import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retryGitIdentity } from '../../scripts/git-identity-retry';
import { queryGitIdentityBroker, GitIdentityTransportError } from '../../scripts/git-identity-ipc';

test('lookup waits through recovery, keeps correlation, and never replays a command', async () => {
  let clock = 0, calls = 0; const ids = new Set();
  const result = await retryGitIdentity('synthetic', { op: 'open' }, {
    now: () => clock, sleep: async ms => { clock += ms; },
    query: async (_socket, request, timeout) => {
      assert.ok(timeout! <= 2000); ids.add((request as any).requestId); calls++;
      return clock < 3000 ? { status: 'unavailable', reason: 'live-inspection-unavailable' } : { status: 'configured' };
    },
  });
  assert.equal(result.status, 'configured'); assert.ok(clock >= 3000); assert.ok(calls > 4); assert.equal(ids.size, 1);
});
test('a deadline caps lookup time including transport and backoff', async () => {
  let clock = 0;
  await assert.rejects(retryGitIdentity('synthetic', {}, {
    budgetMs: 450, now: () => clock, sleep: async ms => { clock += ms; },
    query: async (_socket, _request, timeout) => { clock += timeout!; throw new GitIdentityTransportError('ipc-timeout'); },
  }), /ipc-timeout.*elapsedMs=450.*refusing server-account fallback/);
  assert.equal(clock, 450);
});
test('expired execution and changed lease never wait for a successor', async () => {
  for (const reply of [{ status: 'expired' }, { status: 'unavailable', reason: 'lease-changed' }]) {
    let calls = 0;
    await assert.rejects(retryGitIdentity('synthetic', {}, { query: async () => { calls++; return reply; } }), /execution-expired|lease-changed/);
    assert.equal(calls, 1);
  }
});
test('arbitrary reply or exception text cannot leak through diagnostics', async () => {
  for (const query of [async () => ({ status: 'unavailable', reason: 'synthetic-secret' }), async () => { throw Error('synthetic-secret'); }]) {
    let clock = 0;
    await assert.rejects(retryGitIdentity('synthetic', {}, { budgetMs: 1, now: () => clock, sleep: async ms => { clock += ms; }, query }), error => !String(error).includes('synthetic-secret'));
  }
});
test('IPC distinguishes a silent broker from disconnect and invalid response', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'git-ipc-reasons-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const mode of ['timeout', 'disconnect', 'invalid'] as const) {
    const socket = join(dir, mode); const server = createServer(client => {
      client.on('error', () => {});
      client.once('data', () => { if (mode === 'disconnect') client.end(); if (mode === 'invalid') client.end('null\n'); });
    });
    await new Promise<void>(resolve => server.listen(socket, resolve));
    await assert.rejects(queryGitIdentityBroker(socket, {}, 30), (error: any) => error.reason === ({ timeout: 'ipc-timeout', disconnect: 'ipc-disconnected', invalid: 'ipc-invalid-response' })[mode]);
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
