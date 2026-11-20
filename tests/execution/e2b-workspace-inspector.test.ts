import test from 'node:test';
import assert from 'node:assert/strict';
import { createE2BPersistentWorkspaceInspector } from '../../packages/sandbox-e2b/src/workspace-inspector';
const binding = { workspaceId: 'ws-' + 'a'.repeat(32), privateVolumeId: '11111111-1111-1111-1111-111111111111' };
const empty = { schemaVersion: 2, workspaceID: binding.workspaceId, privateVolumeID: binding.privateVolumeId, phase: 'ready', generation: 2, members: [] };
const volume = { volumeID: binding.privateVolumeId, token: 'MUST_NOT_ESCAPE' };
function fixture(values: any[], authorize = async (_id: string) => {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const inspect = createE2BPersistentWorkspaceInspector({ apiUrl: 'https://provider.test', readApiKey: async () => 'private-key', authorize }, async (url, init) => {
    calls.push({ url: String(url), init: init! });
    if (!values.length) throw Error('Unexpected request');
    const value = values.shift(); if (value instanceof Error) throw value;
    return value instanceof Response ? value : Response.json(value);
  });
  return { inspect, calls };
}
test('requires unchanged empty family and independently verified retained volume; GET only', async () => {
  let checks = 0;
  const f = fixture([empty, volume, empty], async id => { assert.equal(id, binding.workspaceId); checks++; });
  assert.equal(await f.inspect(binding), 'absent'); assert.equal(checks, 2);
  assert.equal(f.calls.length, 3);
  for (const call of f.calls) { assert.equal(call.init.method, 'GET'); assert.equal(call.init.redirect, 'error'); assert.ok(call.init.signal); }
});
test('any remaining family member blocks recovery without deleting or connecting it', async () => {
  for (const state of ['running', 'paused', 'unknown', 'deleted']) {
    const f = fixture([{ ...empty, members: [{ sandboxID: 'other-member', state }] }]);
    assert.equal(await f.inspect(binding), 'present'); assert.equal(f.calls.length, 1);
  }
});
test('HTTP failures, wrong workspace/volume, unsupported schema and pending phase fail closed', async () => {
  for (const response of [new Response('', { status: 404 }), new Response('', { status: 401 }), new Response('', { status: 409 }),
    { ...empty, workspaceID: 'another' }, { ...empty, privateVolumeID: 'another' }, { ...empty, schemaVersion: 1 },
    { ...empty, phase: 'creating' }, { ...empty, members: null }, { ...empty, generation: undefined }, new Error('PRIVATE_PROVIDER_DETAIL')]) {
    const f = fixture([response]); assert.equal(await f.inspect(binding), 'unknown');
  }
  for (const result of [new Response('', { status: 404 }), { volumeID: 'replacement' }]) {
    const f = fixture([empty, result]); assert.equal(await f.inspect(binding), 'unknown'); assert.equal(f.calls.length, 2);
  }
});
test('changed generation or a new family member during inspection does not clear the fence', async () => {
  assert.equal(await fixture([empty, volume, { ...empty, generation: 3 }]).inspect(binding), 'unknown');
  assert.equal(await fixture([empty, volume, { ...empty, members: [{}] }]).inspect(binding), 'present');
});
test('revoked authorization, invalid identity and oversized metadata cannot prove absence', async () => {
  let checks = 0;
  const f = fixture([empty, volume, empty], async () => { if (++checks === 2) throw Error('revoked'); });
  assert.equal(await f.inspect(binding), 'unknown');
  const invalid = fixture([]); assert.equal(await invalid.inspect({ ...binding, workspaceId: '../escape' }), 'unknown'); assert.equal(invalid.calls.length, 0);
  assert.equal(await fixture([new Response('x'.repeat(65537))]).inspect(binding), 'unknown');
  const denied = fixture([], async () => { throw Error('denied'); }); assert.equal(await denied.inspect(binding), 'unknown'); assert.equal(denied.calls.length, 0);
});
test('rejects credential-bearing or insecure installation endpoints', () => {
  for (const apiUrl of ['http://remote.test', 'https://user:secret@example.test', 'https://example.test/path', 'https://example.test?key=secret'])
    assert.throws(() => createE2BPersistentWorkspaceInspector({ apiUrl, readApiKey: async () => '', authorize: async () => {} }));
});
