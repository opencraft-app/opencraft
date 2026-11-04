import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createShutdownDiagnostics } from '../../scripts/shutdown-diagnostics.mjs';

test('a slow flush stays pending while diagnostics identify its stage', async () => {
  const records = [];
  const trace = createShutdownDiagnostics('headless', { report: record => records.push(record), waitingMs: 5 });
  let release, completed = false;
  const held = new Promise(resolve => { release = resolve; });
  const flushing = trace('execution-database', () => held).then(() => { completed = true; });
  try {
    await delay(25);
    assert.equal(completed, false, 'observing a slow flush must never release its owner');
    assert.ok(records.some(record => record.stage === 'execution-database' && record.phase === 'waiting'));
  } finally { release(); await flushing; }
  const count = records.length;
  await delay(15);
  assert.equal(records.length, count, 'finished stages leave no waiting timer');
});

test('failed flush retains its failure and never logs its exception contents', async () => {
  const records = [];
  const trace = createShutdownDiagnostics('headless', { report: record => records.push(record) });
  const failure = new Error('private request contents');
  await assert.rejects(trace('execution-database', () => { throw failure; }), error => error === failure);
  assert.equal(records.at(-1).phase, 'failed');
  assert.equal(JSON.stringify(records).includes(failure.message), false);
});

test('a broken diagnostic sink cannot skip cleanup or hide flush failures', async () => {
  const trace = createShutdownDiagnostics('headless', { report: () => { throw Error('sink unavailable'); } });
  let flushed = false;
  await trace('execution-database', () => { flushed = true; });
  assert.equal(flushed, true);
  const failure = new Error('flush failed');
  await assert.rejects(trace('execution-database', () => Promise.reject(failure)), error => error === failure);
});
