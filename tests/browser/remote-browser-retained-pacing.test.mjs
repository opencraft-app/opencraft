import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBrowserService } from '../../scripts/remote-browser-service.mjs';
const settle = () => new Promise(resolve => setImmediate(resolve));
test('unsupported retained pacing is cached until native retirement; transient errors retry', async () => {
  const host = Object.create(RemoteBrowserService.prototype); host.child = {};
  const p = { id: 'page', live: true }, viewer = { visible: true, decodeFps: 30 };
  host.viewers = () => new Map([[{}, viewer]]);
  let calls = 0; host.request = async () => { calls++; throw new Error('Unsupported browser command'); };
  host.displayPace(p); await settle();
  for (let i = 0; i < 20; i++) { viewer.decodeFps = i % 2 ? 10 : 30; host.displayPace(p); await settle(); }
  assert.equal(calls, 1); host.resetVisibility(p); host.displayPace(p); await settle(); assert.equal(calls, 2);
  host.resetVisibility(p); host.request = async () => { calls++; throw new Error('Temporary transport failure'); };
  host.displayPace(p); await settle(); host.displayPace(p); await settle(); assert.equal(calls, 4);
});
test('late unsupported result cannot disable pacing on a replacement native generation', async () => {
  const host = Object.create(RemoteBrowserService.prototype); host.child = {};
  const p = { id: 'page', live: true }; host.viewers = () => new Map([[{}, { visible: true }]]);
  let reject; host.request = () => new Promise((_resolve, fail) => { reject = fail; });
  host.displayPace(p); host.child = {}; host.resetVisibility(p);
  reject(new Error('Unsupported browser command')); await settle(); assert.equal(p.displayRateUnsupported, false);
});

test('one page retirement fences its late pacing result while the pool transport remains intact', async () => {
  const host = Object.create(RemoteBrowserService.prototype); host.child = {};
  const p = { id: 'page', live: true }; host.viewers = () => new Map([[{}, { visible: true }]]);
  let reject; host.request = () => new Promise((_resolve, fail) => { reject = fail; });
  const transport = host.child; host.displayPace(p); host.resetVisibility(p); p.displayFps = 10;
  reject(new Error('Unsupported browser command')); await settle();
  assert.equal(host.child, transport); assert.equal(p.displayRateUnsupported, false); assert.equal(p.displayFps, 10);
});

test('an older transient failure cannot invalidate a newer acknowledged pacing update', async () => {
  const host = Object.create(RemoteBrowserService.prototype); host.child = {};
  const p = { id: 'page', live: true }, viewer = { visible: true, decodeFps: 30 };
  host.viewers = () => new Map([[{}, viewer]]); const jobs = [];
  host.request = (_page, _method, input) => new Promise((resolve, reject) => jobs.push({ ...input, resolve, reject }));
  host.displayPace(p); viewer.decodeFps = 10; host.displayPace(p);
  assert.deepEqual(jobs.map(job => job.fps), [30, 10]);
  jobs[1].resolve(); await settle(); jobs[0].reject(new Error('Temporary transport failure')); await settle();
  host.displayPace(p); assert.equal(jobs.length, 2); assert.equal(p.displayFps, 10);
});
