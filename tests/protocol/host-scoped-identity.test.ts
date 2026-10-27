import assert from 'node:assert/strict';
import test from 'node:test';
import { hostScopeFixture } from './fixtures/host-scopes';
import { flushCleanup, trackCleanup } from './fixtures/host-cleanup';

async function open(f: ReturnType<typeof hostScopeFixture>, p: ReturnType<ReturnType<typeof hostScopeFixture>['page']>, host: string, lease: string) {
  const grant = await p.bridge.connectHost(host, lease);
  assert.ok((await p.rpc(host, lease, grant.generation, 'initialize'))?.result);
  return { host, lease, generation: grant.generation, physical: f.current(host) };
}
async function echo(p: ReturnType<ReturnType<typeof hostScopeFixture>['page']>, owner: { host: string; lease: string; generation: number }, token: string) {
  assert.deepEqual((await p.rpc(owner.host, owner.lease, owner.generation, 'echo', { token }))?.result, { token });
}
const code = (e: unknown, expected: string) => e instanceof Error && 'code' in e && e.code === expected;

for (const reverse of [false, true]) test(`same lease on two Hosts retires only its captured native client (reverse=${reverse})`, async () => {
  const f = hostScopeFixture(), p = f.page();
  try {
    const a = await open(f, p, reverse ? 'b' : 'a', 'shared'), b = await open(f, p, reverse ? 'a' : 'b', 'shared');
    await echo(p, a, 'both-a'); await echo(p, b, 'both-b');
    await p.bridge.disconnectHost(a.host, a.lease, a.generation);
    assert.equal(a.physical.notifications.length, 1); assert.equal(b.physical.notifications.length, 0);
    assert.equal(a.physical.initializedClients.size, 0); assert.equal(b.physical.initializedClients.size, 1);
    assert.equal(a.physical.closeCalls, 0); assert.equal(b.physical.closeCalls, 0);
    await echo(p, b, 'peer-survives');
  } finally { await f.close(); }
});

test('different lease names remain independent across Hosts', async () => {
  const f = hostScopeFixture(), p = f.page();
  try {
    const a = await open(f, p, 'a', 'alpha'), b = await open(f, p, 'b', 'beta');
    await p.bridge.disconnectHost(a.host, a.lease, a.generation);
    assert.equal(a.physical.notifications.length, 1); assert.equal(b.physical.notifications.length, 0); await echo(p, b, 'different-lease-control');
  } finally { await f.close(); }
});

test('Renderer exit retains and notifies every Host registration even when lease names match', async () => {
  const f = hostScopeFixture(), p = f.page();
  try {
    const a = await open(f, p, 'a', 'shared'), b = await open(f, p, 'b', 'shared');
    p.connection.close(); await flushCleanup();
    for (const owner of [a, b]) { assert.equal(owner.physical.notifications.length, 1); assert.equal(owner.physical.initializedClients.size, 0); assert.equal(owner.physical.closeCalls, 0); }
  } finally { await f.close(); }
});

for (const routing of [false, true]) test(`opaque Host/lease tuple boundaries cannot alias in the delivery registry (routing=${routing})`, async () => {
  const f = hostScopeFixture({ routing }), p = f.page();
  try {
    const a = await open(f, p, 'a\0b', 'c'), b = await open(f, p, 'a', 'b\0c');
    await echo(p, a, 'delimiter-a'); await echo(p, b, 'delimiter-b');
    await p.bridge.disconnectHost(a.host, a.lease, a.generation); await echo(p, b, 'delimiter-peer');
  } finally { await f.close(); }
});

test('a failed logical cleanup fences only its own Host while the peer accepts new work', async () => {
  const f = hostScopeFixture(), p = f.page();
  try {
    const a = await open(f, p, 'a', 'shared'), b = await open(f, p, 'b', 'shared'); a.physical.notifyMode = 'reject';
    await assert.rejects(p.bridge.disconnectHost(a.host, a.lease, a.generation));
    await assert.rejects(p.bridge.connectHost('a', 'new-a'), e => code(e, 'APP_HOST_LOGICAL_CLEANUP_FAILED'));
    await echo(p, b, 'failure-peer'); const peer = await open(f, p, 'b', 'new-b'); await echo(p, peer, 'new-peer');
    assert.equal(b.physical.notifications.length, 0); assert.equal(b.physical.closeCalls, 0);
  } finally { await f.close(); }
});

test('an unknown notification deadline and its late result cannot retire another Host', async () => {
  const f = hostScopeFixture(), p = f.page();
  try {
    const a = await open(f, p, 'a', 'shared'), b = await open(f, p, 'b', 'shared'); a.physical.notifyMode = 'hold';
    const retiring = trackCleanup(p.bridge.disconnectHost(a.host, a.lease, a.generation)); await flushCleanup(); assert.equal(retiring.state, 'pending');
    await f.deadline(); await retiring.promise; assert.equal(retiring.state, 'rejected'); assert.ok(code(retiring.error, 'APP_HOST_DISCONNECT_TIMEOUT'));
    await echo(p, b, 'deadline-peer'); a.physical.releaseNotifications(); await flushCleanup(); await echo(p, b, 'late-peer');
    assert.equal(b.physical.notifications.length, 0); assert.equal(a.physical.closeCalls, 0);
  } finally { await f.close(); }
});

test('a late captured success cannot forget a subsequently registered peer Host', async () => {
  const f = hostScopeFixture(), p = f.page();
  try {
    const a = await open(f, p, 'a', 'shared'); a.physical.notifyMode = 'hold';
    const retiring = trackCleanup(p.bridge.disconnectHost(a.host, a.lease, a.generation)); await flushCleanup();
    const b = await open(f, p, 'b', 'shared'); a.physical.releaseNotifications(); await retiring.promise;
    await echo(p, b, 'registered-during-retirement'); await p.bridge.disconnectHost(b.host, b.lease, b.generation);
    assert.equal(a.physical.notifications.length, 1); assert.equal(b.physical.notifications.length, 1);
  } finally { await f.close(); }
});

test('last-claim physical cleanup remains local when another Host uses the same lease', async () => {
  const f = hostScopeFixture({ lifetime: 'last-claim' }), p = f.page();
  try {
    const a = await open(f, p, 'a', 'shared'), b = await open(f, p, 'b', 'shared');
    await p.bridge.disconnectHost(a.host, a.lease, a.generation);
    assert.equal(a.physical.closeCalls, 1); assert.equal(a.physical.released, true); assert.equal(b.physical.closeCalls, 0);
    assert.equal(b.physical.notifications.length, 0); await echo(p, b, 'last-claim-peer');
  } finally { await f.close(); }
});

test('trusted aliases on different Hosts do not suppress one another during detach', async () => {
  const f = hostScopeFixture(), p = f.page(), peer = f.page();
  try {
    const a = await open(f, p, 'a', 'a-lease'), b = await open(f, peer, 'b', 'b-lease');
    p.connection.rememberLogicalClient('trusted-alias', 'a'); peer.connection.rememberLogicalClient('trusted-alias', 'b');
    p.connection.close(); await flushCleanup();
    assert.ok(a.physical.notifications.some(n => n.key === 'trusted-alias')); assert.equal(b.physical.notifications.length, 0); await echo(peer, b, 'alias-peer');
  } finally { await f.close(); }
});

test('reset of one Host retires its captured unknown cleanup without touching a peer or replacement', async () => {
  const f = hostScopeFixture(), p = f.page();
  try {
    const a = await open(f, p, 'a', 'shared'); a.physical.notifyMode = 'hold';
    const retiring = trackCleanup(p.bridge.disconnectHost(a.host, a.lease, a.generation)); await flushCleanup();
    const b = await open(f, p, 'b', 'shared'); await f.server.resetHost('a'); await retiring.promise;
    const next = await open(f, p, 'a', 'fresh-a'); a.physical.releaseNotifications(); await flushCleanup();
    await echo(p, b, 'reset-peer'); await echo(p, next, 'reset-successor'); assert.equal(b.physical.closeCalls, 0);
  } finally { await f.close(); }
});
