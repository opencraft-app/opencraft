import assert from 'node:assert/strict';
import test from 'node:test';
import { hostClaimFixture, flushClaims, heldForwardingFrame, claimInitialize } from './fixtures/host-claims';
const releases = (r: ReturnType<ReturnType<typeof hostClaimFixture>['renderer']>) => r.wire.filter(m => m.type === 'host/disconnect');

for (const logical of [false, true]) test(`renewed claim is reclaimed before last channel close, logical=${logical}`, async () => {
  const f = hostClaimFixture({ logical }), r = f.renderer(), { transport } = r.channel();
  try {
    await transport.connect(); const physical = f.physical;
    physical.publish({ state: 'closed' }); physical.publish({ state: 'open' }); await flushClaims();
    await transport.connect(); await flushClaims();
    assert.equal(physical.closeCalls, 0, 'fresh reservation protects physical handoff');
    assert.equal(f.physicals.length, 1); assert.equal(releases(r).length, 1, 'obsolete claim released');
    await transport.close(); assert.equal(physical.closeCalls, 1);
    assert.equal(releases(r).length, 2); assert.equal(new Set(releases(r).map(m => m.leaseId)).size, 2);
  } finally { await f.close(); }
});

test('repeated same-generation renewal releases every unique old claim once', async () => {
  const f = hostClaimFixture(), r = f.renderer(), { transport } = r.channel();
  try {
    await transport.connect();
    for (let i = 0; i < 12; i++) {
      f.physical.publish({ state: 'closed' }); f.physical.publish({ state: 'open' }); await flushClaims();
      await transport.connect(); await flushClaims();
      assert.equal(releases(r).length, i + 1); assert.equal(f.physical.closeCalls, 0);
    }
    await transport.close(); assert.equal(f.physical.closeCalls, 1); assert.equal(releases(r).length, 13);
    assert.equal(new Set(releases(r).map(m => m.leaseId)).size, 13);
  } finally { await f.close(); }
});

for (const sharedBridge of [false, true]) test(`renewal and close preserve peer claim, sharedBridge=${sharedBridge}`, async () => {
  const f = hostClaimFixture(), r = f.renderer(), peer = sharedBridge ? r : f.renderer();
  const first = r.channel(), second = peer.channel();
  try {
    await first.transport.connect(); await second.transport.connect();
    f.physical.publish({ state: 'closed' }); f.physical.publish({ state: 'open' }); await flushClaims();
    await first.transport.connect(); await second.client.connect(claimInitialize);
    await first.transport.close(); assert.equal(f.physical.closeCalls, 0);
    assert.deepEqual(await second.client.requestRaw('echo', { peer: true }), { peer: true });
    await second.transport.close(); assert.equal(f.physical.closeCalls, 1);
  } finally { await f.close(); }
});

test('server-owned physical Host survives reclamation of every Renderer claim', async () => {
  const f = hostClaimFixture({ lifetime: 'server' }), r = f.renderer(), { transport } = r.channel();
  try {
    await transport.connect(); f.physical.publish({ state: 'closed' }); f.physical.publish({ state: 'open' }); await flushClaims();
    await transport.connect(); await transport.close();
    assert.equal(releases(r).length, 2); assert.equal(f.physical.closeCalls, 0);
    await f.server.close(); assert.equal(f.physical.closeCalls, 1);
  } finally { await f.close(); }
});

test('withheld obsolete release ACK does not consume the sole current control slot', async () => {
  const f = hostClaimFixture({ maxPending: 1 }), r = f.renderer(), page = r.channel();
  try {
    await page.client.connect(claimInitialize); r.withheld.add('host/disconnect');
    f.physical.publish({ state: 'closed' }); f.physical.publish({ state: 'open' }); await flushClaims();
    await page.client.connect(claimInitialize); await flushClaims();
    assert.equal(releases(r).length, 1); assert.equal(r.heldReplies.length, 1);
    assert.equal(page.client.connectionGeneration, 2);
    assert.deepEqual(await page.client.requestRaw('echo', { fresh: true }), { fresh: true });
    r.withheld.clear(); r.releaseReplies(); await flushClaims();
    assert.deepEqual(await page.client.requestRaw('echo', { late: true }), { late: true });
    await page.transport.close(); assert.equal(f.physical.closeCalls, 1);
  } finally { await f.close(); }
});

for (const logical of [false, true]) test(`channel close bypasses held live forwarding, logical=${logical}`, async () => {
  const f = hostClaimFixture({ logical }), r = f.renderer(), page = r.channel();
  let outcome = 'pending';
  try {
    await page.transport.connect(); const old = page.transport.send(heldForwardingFrame('admitted')).catch(() => {});
    await flushClaims(); const native = f.physical;
    const closing = page.transport.close().then(() => { outcome = 'closed'; });
    await flushClaims(); assert.equal(outcome, 'closed'); assert.equal(native.closeCalls, 1);
    assert.equal(native.held[0]!.signal?.aborted, true); assert.equal(native.entries.filter(e => e.tag === 'admitted').length, 1);
    await old; await closing;
  } finally { await f.close(); }
});

test('claim release fences its queued frame and preserves another lease on the same queue', async () => {
  const f = hostClaimFixture(), r = f.renderer(), first = r.channel(), peer = r.channel();
  let closingOutcome = 'pending', peerOutcome = 'pending';
  try {
    await first.transport.connect(); await peer.client.connect(claimInitialize);
    const old = first.transport.send(heldForwardingFrame('old')).catch(() => {}); await flushClaims();
    const queued = first.transport.send(heldForwardingFrame('obsolete-queued')).catch(() => {}); await flushClaims();
    const closing = first.transport.close().then(() => { closingOutcome = 'closed'; });
    const echo = peer.client.requestRaw('echo', { live: true }).then(value => { peerOutcome = 'resolved'; return value; });
    void echo.catch(() => {});
    await flushClaims(); assert.equal(closingOutcome, 'closed'); assert.equal(peerOutcome, 'resolved');
    assert.equal(f.physical.closeCalls, 0); assert.equal(f.physical.entries.filter(e => e.tag === 'obsolete-queued').length, 0);
    assert.deepEqual(await echo, { live: true }); await old; await queued; await closing;
    await peer.transport.close(); assert.equal(f.physical.closeCalls, 1);
  } finally { await f.close(); }
});

test('last claim close still waits for the physical close barrier', async () => {
  const f = hostClaimFixture(), r = f.renderer(), first = r.channel(), second = r.channel();
  let closed = false, successor = false;
  try {
    await first.transport.connect(); const previous = f.physical; previous.holdClose = true;
    const closing = first.transport.close().then(() => { closed = true; }); await flushClaims();
    const connecting = second.transport.connect().then(() => { successor = true; }); await flushClaims();
    assert.equal(closed, false); assert.equal(successor, false); assert.equal(f.physicals.length, 1);
    previous.closeGate.resolve(); await closing; await connecting;
    assert.equal(f.physicals.length, 2); await second.transport.close();
  } finally { await f.close(); }
});

test('closed pending channel releases its own late grant exactly once and leaves a peer alive', async () => {
  const f = hostClaimFixture(), r = f.renderer(), page = r.channel(), peer = r.channel();
  let openingOutcome = 'pending';
  try {
    await peer.transport.connect(); r.withheld.add('host/connect');
    const opening = page.transport.connect().then(() => { openingOutcome = 'resolved'; }, () => { openingOutcome = 'rejected'; });
    await flushClaims(); assert.equal(r.heldReplies.length, 1);
    await page.transport.close(); await flushClaims(); assert.equal(openingOutcome, 'rejected');
    r.withheld.clear(); r.releaseReplies(); await flushClaims();
    assert.equal(releases(r).length, 1); assert.equal(f.physical.closeCalls, 0);
    await peer.transport.close(); assert.equal(f.physical.closeCalls, 1); await opening;
  } finally { await f.close(); }
});

test('closing a known claim cannot be denied by a peer occupying normal request budget', async () => {
  const f = hostClaimFixture({ maxPending: 1 }), r = f.renderer(), page = r.channel(), peer = r.channel();
  let closed = false;
  try {
    await page.transport.connect(); await peer.transport.connect();
    const old = peer.transport.send(heldForwardingFrame('peer-held')).catch(() => {}); await flushClaims();
    const closing = page.transport.close().then(() => { closed = true; }); await flushClaims();
    assert.equal(closed, true); assert.equal(f.physical.closeCalls, 0);
    assert.equal(f.physical.held[0]!.signal?.aborted, false, 'releasing another claim cannot cancel its peer');
    await peer.transport.close(); assert.equal(f.physical.closeCalls, 1); await old; await closing;
  } finally { await f.close(); }
});

test('a current release ACK can be withheld without blocking another Host control budget', async () => {
  const f = hostClaimFixture({ maxPending: 1 }), r = f.renderer(), page = r.channel(), other = r.channel('b');
  let closed = false;
  try {
    await page.transport.connect(); r.withheld.add('host/disconnect');
    const closing = page.transport.close().then(() => { closed = true; }); await flushClaims();
    assert.equal(closed, false); assert.equal(r.heldReplies.length, 1);
    await other.client.connect(claimInitialize);
    assert.deepEqual(await other.client.requestRaw('echo', { other: true }), { other: true });
    r.withheld.clear(); r.releaseReplies(); await closing; await other.transport.close();
  } finally { await f.close(); }
});

test('caller abort and its late own grant share one obsolete-claim release', async () => {
  const f = hostClaimFixture(), r = f.renderer(), page = r.channel(), peer = r.channel();
  try {
    await peer.transport.connect(); r.withheld.add('host/connect');
    const abort = new AbortController();
    const opening = page.transport.connect(abort.signal).catch(() => {}); await flushClaims();
    abort.abort(); await opening; r.withheld.clear(); r.releaseReplies(); await flushClaims();
    assert.equal(releases(r).length, 1); assert.equal(f.physical.closeCalls, 0);
    await page.transport.close(); assert.equal(releases(r).length, 1, 'close cannot release this grant twice');
    await peer.transport.close(); assert.equal(f.physical.closeCalls, 1);
  } finally { await f.close(); }
});

test('a failed obsolete-release Port write fails the bridge instead of silently losing its claim', async () => {
  const f = hostClaimFixture(), r = f.renderer(), page = r.channel();
  let outcome = 'pending';
  try {
    await page.transport.connect(); f.physical.publish({ state: 'closed' }); f.physical.publish({ state: 'open' }); await flushClaims();
    r.throwOnPost.add('host/disconnect');
    const next = page.transport.connect().then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
    await flushClaims(); assert.equal(outcome, 'rejected'); assert.notEqual(page.transport.status.state, 'open');
    assert.equal(r.connection.isClosed, true); await next;
  } finally { await f.close(); }
});

test('an aborted attempt can grant late after the same channel has acquired its successor', async () => {
  const f = hostClaimFixture({ maxPending: 8 }), r = f.renderer(), page = r.channel();
  try {
    r.withheld.add('host/connect'); const abort = new AbortController();
    const old = page.transport.connect(abort.signal).catch(() => {}); await flushClaims();
    assert.equal(r.heldReplies.length, 1); abort.abort(); await old;
    r.withheld.clear(); await page.client.connect(claimInitialize);
    const physical = f.physical; assert.equal(physical.closeCalls, 0);
    r.releaseReplies(); await flushClaims();
    assert.equal(releases(r).length, 1); assert.equal(physical.closeCalls, 0);
    assert.deepEqual(await page.client.requestRaw('echo', { successor: true }), { successor: true });
    await page.transport.close(); assert.equal(physical.closeCalls, 1); assert.equal(releases(r).length, 2);
  } finally { await f.close(); }
});

test('native loss before the own grant releases that rejected grant and allows a fresh attempt', async () => {
  const f = hostClaimFixture(), r = f.renderer(), page = r.channel();
  let oldOutcome = 'pending';
  try {
    r.withheld.add('host/connect');
    const old = page.transport.connect().then(() => { oldOutcome = 'resolved'; }, () => { oldOutcome = 'rejected'; });
    await flushClaims(); const previous = f.physical;
    previous.publish({ state: 'closed' }); previous.publish({ state: 'open' }); await flushClaims();
    r.withheld.clear(); r.releaseReplies(); await old; await flushClaims();
    assert.equal(oldOutcome, 'rejected'); assert.equal(previous.closeCalls, 1); assert.equal(releases(r).length, 1);
    await page.client.connect(claimInitialize); assert.equal(f.physicals.length, 2);
    assert.deepEqual(await page.client.requestRaw('echo', { fresh: true }), { fresh: true });
    await page.transport.close(); assert.equal(f.physical.closeCalls, 1);
  } finally { await f.close(); }
});

test('a failed current-release Port write cannot silently orphan the last remote claim', async () => {
  const f = hostClaimFixture(), r = f.renderer(), page = r.channel();
  try {
    await page.transport.connect(); r.throwOnPost.add('host/disconnect');
    await page.transport.close(); await flushClaims();
    assert.equal(r.connection.isClosed, true, 'required cleanup write failure closes the broken bridge');
    assert.equal(f.physical.closeCalls, 1, 'Server detaches the broken connection attachments');
  } finally { await f.close(); }
});
