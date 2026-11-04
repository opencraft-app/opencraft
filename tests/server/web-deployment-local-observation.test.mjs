import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { updateLocalServer, observeLocalUpdate } from '../../scripts/update-server-local.mjs';

for (const transport of ['slow headers', 'slow body', 'disconnected status']) test(`local updater observes ${transport} without a second installation`, { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'update-observation-'));
  await writeFile(join(root, 'admin-key'), 'test-administrator-key');
  const archive = join(root, 'fixture.tgz'); await writeFile(archive, 'fixture archive');
  let accepted = false; let installs = 0; let polls = 0; const budgets = []; const submissionBudgets = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    // Scale the observation's real transport watchdog: 75ms represents 75s.
    if (accepted) { budgets.push(milliseconds); return timeout(Math.max(1, Math.floor(milliseconds / 1000))); }
    submissionBudgets.push(milliseconds); return timeout(milliseconds);
  });
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && request.url.endsWith('/login')) {
      response.setHeader('set-cookie', 'session=fixture; Path=/'); response.end(JSON.stringify({ ok: true })); return;
    }
    if (request.method === 'POST' && request.url.endsWith('/install-local')) {
      installs++; accepted = true; response.statusCode = 202; response.end(JSON.stringify({ jobId: 'accepted-job' })); return;
    }
    if (accepted) {
      polls++;
      if (transport === 'disconnected status' && polls === 1) { response.destroy(); return; }
      if (transport === 'slow body') response.flushHeaders();
      await delay(75);
      response.end(JSON.stringify({ current: { version: '1.1.0', buildId: 'target' },
        job: { id: 'accepted-job', version: '1.1.0', phase: 'completed' }, execution: { ready: true } })); return;
    }
    response.end(JSON.stringify({ localInstall: true, current: { version: '1.0.0', buildId: 'old' }, job: null }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await updateLocalServer({ version: '1.1.0', buildId: 'target', archive,
      stateDirectory: root, url: `http://127.0.0.1:${server.address().port}` });
    assert.equal(result.buildId, 'target'); assert.equal(result.execution.ready, true);
    assert.equal(installs, 1); assert.equal(polls, transport === 'disconnected status' ? 2 : 1);
    assert.ok(budgets.every(milliseconds => milliseconds > 75_000));
    assert.ok(submissionBudgets.at(-1) > 75_000, 'the single install POST shares the observation budget');
  } finally {
    t.mock.restoreAll();
    const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed;
    await rm(root, { recursive: true, force: true });
  }
});


const completed = () => ({ current: { version: '1.1.0', buildId: 'target' },
  job: { id: 'accepted-job', version: '1.1.0', phase: 'completed' }, execution: { ready: true } });
const observing = overrides => ({ jobId: 'accepted-job', version: '1.1.0', buildId: 'target', ...overrides });

test('job observation covers ninety seconds of verification and keeps one total deadline', async t => {
  let elapsed = 0; let reads = 0; const budgets = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', milliseconds => { budgets.push(milliseconds); return timeout(milliseconds); });
  const result = await observeLocalUpdate(observing({ deadline: 900_000, now: () => elapsed,
    sleep: async milliseconds => { elapsed += milliseconds; }, status: async () => {
      reads++;
      if (reads === 1) { elapsed += 90_000; return { job: { id: 'accepted-job', version: '1.1.0', phase: 'verifying' } }; }
      return completed();
    } }));
  assert.equal(result.execution.ready, true); assert.equal(reads, 2);
  assert.equal(elapsed, 90_500); assert.deepEqual(budgets, [900_000, 809_500]);
});

test('terminal failure is reported immediately instead of waiting out the budget', async () => {
  let reads = 0; let waits = 0;
  await assert.rejects(observeLocalUpdate(observing({ deadline: 900_000, now: () => 0,
    sleep: async () => { waits++; }, status: async () => {
      reads++; return { job: { id: 'accepted-job', version: '1.1.0', phase: 'failed', error: 'verification rejected' } };
    } })), /verification rejected/);
  assert.equal(reads, 1); assert.equal(waits, 0);
});

for (const mismatch of ['job', 'job version', 'release version', 'build']) test(`completed ${mismatch} mismatch cannot authorize success`, async () => {
  const snapshot = completed();
  if (mismatch === 'job') snapshot.job.id = 'another-job';
  if (mismatch === 'job version') snapshot.job.version = '2.0.0';
  if (mismatch === 'release version') snapshot.current.version = '2.0.0';
  if (mismatch === 'build') snapshot.current.buildId = 'another-build';
  let reads = 0;
  await assert.rejects(observeLocalUpdate(observing({ deadline: 900_000, now: () => 0,
    sleep: async () => assert.fail('identity mismatch must stop immediately'), status: async () => { reads++; return snapshot; } })), /identity/);
  assert.equal(reads, 1);
});

for (const unavailable of [false, true]) test(`total observation budget bounds ${unavailable ? 'unavailable transport' : 'pending job'} without resetting`, async () => {
  let elapsed = 0; let reads = 0; const waits = [];
  await assert.rejects(observeLocalUpdate(observing({ deadline: 1200, now: () => elapsed,
    sleep: async milliseconds => { waits.push(milliseconds); elapsed += milliseconds; }, status: async () => {
      reads++; elapsed += 100;
      if (unavailable) throw new Error('untrusted transport detail');
      return { job: { id: 'accepted-job', version: '1.1.0', phase: 'verifying' } };
    } })), error => /timed out for job accepted-job; the server operation may still be running/.test(error.message)
      && !/untrusted/.test(error.message));
  assert.equal(elapsed, 1200); assert.equal(reads, 2); assert.deepEqual(waits, [500, 500]);
});

test('a stuck status request consumes only the remaining overall budget', { timeout: 1000 }, async () => {
  let reads = 0; const started = performance.now();
  await assert.rejects(observeLocalUpdate(observing({ deadline: started + 40,
    status: signal => new Promise((resolve, reject) => {
      reads++; const timer = setTimeout(() => resolve(completed()), 500);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }) })), /server operation may still be running/);
  assert.equal(reads, 1); assert.ok(performance.now() - started < 500);
});
