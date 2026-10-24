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
