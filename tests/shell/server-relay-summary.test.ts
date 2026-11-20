import assert from 'node:assert/strict';
import test from 'node:test';
import { relaySummary } from '../../apps/workbench-web/src/runtime/server-relay-summary';
const peer = { id: 'peer-a', name: 'Join Hub', endpoint: 'https://join.woa.com:18490', connected: true };
test('relay summary preserves current endpoint and observed connection state, not private snapshot data', () => {
  assert.deepEqual(relaySummary({ schemaVersion: 1, peers: [{ ...peer, credential: 'secret', origins: ['private'], allowTransit: true }], invitations: ['secret'] }), [peer]);
  assert.deepEqual(relaySummary({ schemaVersion: 1, peers: [{ ...peer, endpoint: null, connected: false }] }), [{ ...peer, endpoint: null, connected: false }]);
  assert.deepEqual(relaySummary({ schemaVersion: 1, peers: [] }), []);
});
test('malformed, duplicate and credential-bearing relay endpoints cannot masquerade as current status', () => {
  for (const value of [null, {}, { schemaVersion: 2, peers: [] }, { schemaVersion: 1, peers: [peer, peer] }, ...['https://user:password@example.com', 'javascript:alert(1)', 'https://example.com/?secret=x', 'https://example.com/#token'].map(endpoint => ({ schemaVersion: 1, peers: [{ ...peer, endpoint }] }))]) assert.throws(() => relaySummary(value));
});
