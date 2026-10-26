import assert from 'node:assert/strict';
import test from 'node:test';
import { flushForwarding, heldForwardingFrame, hostForwardingFixture } from './fixtures/host-forwarding';
const params = { clientInfo: { name: 'forwarding-lifetime', version: '1' } };

for (const contextual of [false, true]) for (const state of ['idle', 'connecting', 'closing', 'closed', 'failed'] as const)
  test(`${contextual ? 'contextual' : 'ordinary'} native ${state} frees same-page initialize without old forwarding cooperation`, async () => {
    const f = hostForwardingFixture({ contextual }), page = f.renderer(); let oldOutcome = 'pending', nextOutcome = 'pending';
    try {
      await page.client.connect(params);
      const old = page.client.requestRaw('hold', { tag: 'old' }).then(() => { oldOutcome = 'resolved'; }, () => { oldOutcome = 'rejected'; });
      await flushForwarding(); assert.equal(f.physical.held.length, 1);
      f.physical.publish({ state }); f.physical.publish({ state: 'open' }); await flushForwarding();
      const next = page.client.connect(params).then(() => { nextOutcome = 'resolved'; }, () => { nextOutcome = 'rejected'; });
      await flushForwarding();
      assert.equal(oldOutcome, 'rejected'); assert.equal(page.transport.status.state, 'open');
      assert.equal(nextOutcome, 'resolved'); assert.equal(page.client.connectionGeneration, 2);
      assert.deepEqual(await page.client.requestRaw('echo', { current: true }), { current: true });
      assert.equal(f.physical.held[0]!.signal?.aborted, true);
      assert.equal(f.physical.entries.filter(e => e.tag === 'old').length, 1);
      if (contextual) assert.ok(f.physical.entries.find(e => e.tag === 'old')!.context);
      await old; await next;
    } finally { await f.close(); }
  });

for (const failure of [false, true]) test(`old native ${failure ? 'failure' : 'success'} cannot settle or retire a successor wait`, async () => {
  const f = hostForwardingFixture(), page = f.renderer(); let oldOutcome = 'pending', newOutcome = 'pending';
  try {
    await page.transport.connect();
    const old = page.transport.send(heldForwardingFrame('old')).then(() => { oldOutcome = 'resolved'; }, () => { oldOutcome = 'rejected'; });
    await flushForwarding(); f.physical.publish({ state: 'closed' }); f.physical.publish({ state: 'open' }); await flushForwarding();
    await page.transport.connect();
    const next = page.transport.send(heldForwardingFrame('new')).then(() => { newOutcome = 'resolved'; }, () => { newOutcome = 'rejected'; });
    await flushForwarding(); assert.equal(f.physical.held.length, 2); assert.equal(oldOutcome, 'rejected');
    f.physical.settle('old', failure); await flushForwarding(); assert.equal(newOutcome, 'pending');
    assert.equal(f.physical.held[1]!.signal?.aborted, false); f.physical.settle('new'); await next; await old;
    assert.equal(newOutcome, 'resolved'); assert.equal(page.transport.status.state, 'open');
  } finally { await f.close(); }
});

test('a live forwarding operation retains FIFO until its native result is available', async () => {
  const f = hostForwardingFixture(), page = f.renderer();
  try {
    await page.transport.connect(); const first = page.transport.send(heldForwardingFrame('first'));
    await flushForwarding(); const second = page.transport.send(heldForwardingFrame('second'));
    await flushForwarding(); assert.deepEqual(f.physical.held.map(e => e.tag), ['first']);
    f.physical.settle('first'); await first; await flushForwarding(); assert.deepEqual(f.physical.held.map(e => e.tag), ['first', 'second']);
    f.physical.settle('second'); await second;
  } finally { await f.close(); }
});

test('fresh page actual Client is a successful control while another page has a held native send', async () => {
  const f = hostForwardingFixture(), page = f.renderer();
  try {
    await page.client.connect(params); const old = page.client.requestRaw('hold', { tag: 'old' }).catch(() => {});
    await flushForwarding(); const fresh = f.renderer(); await fresh.client.connect(params);
    assert.deepEqual(await fresh.client.requestRaw('echo', { fresh: true }), { fresh: true });
    assert.equal(f.physical.held.length, 1); f.physical.settle('old'); await flushForwarding();
    // This synthetic held RPC intentionally has no execution response.
    await page.close(); await old;
  } finally { await f.close(); }
});

test('record retirement frees old forwarding but keeps the physical close barrier', async () => {
  const f = hostForwardingFixture(), page = f.renderer(); let nextOutcome = 'pending';
  try {
    await page.client.connect(params); const old = page.client.requestRaw('hold', { tag: 'old' }).catch(() => {});
    await flushForwarding(); const physical = f.physical; physical.holdClose = true;
    const resetting = f.server.resetHost('a'); await flushForwarding();
    const next = page.client.connect(params).then(() => { nextOutcome = 'resolved'; }, () => { nextOutcome = 'rejected'; });
    await flushForwarding(); assert.equal(f.physicals.length, 1); assert.equal(nextOutcome, 'pending');
    physical.closeGate.resolve(); await resetting; await flushForwarding();
    assert.equal(f.physicals.length, 2); assert.equal(nextOutcome, 'resolved');
    assert.deepEqual(await page.client.requestRaw('echo', { reset: true }), { reset: true }); await old; await next;
  } finally { await f.close(); }
});

test('frames queued before same-record native loss cannot enter its open successor', async () => {
  const f = hostForwardingFixture(), page = f.renderer();
  try {
    await page.transport.connect();
    const old = page.transport.send(heldForwardingFrame('old')).catch(() => {});
    await flushForwarding(); const queued = page.transport.send(heldForwardingFrame('queued-old')).catch(() => {});
    await flushForwarding(); assert.deepEqual(f.physical.held.map(e => e.tag), ['old']);
    f.physical.publish({ state: 'closed' }); f.physical.publish({ state: 'open' }); await flushForwarding();
    assert.deepEqual(f.physical.held.map(e => e.tag), ['old'], 'old queued work must be fenced before native forwarding');
    await page.transport.connect(); let outcome = 'pending';
    const next = page.transport.send(JSON.stringify({ method: 'echo', params: { current: true } })).then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
    await flushForwarding(); assert.equal(outcome, 'resolved'); await old; await queued; await next;
  } finally { await f.close(); }
});

for (const contextual of [false, true]) test(`${contextual ? 'contextual' : 'ordinary'} native synchronous forwarding error advances a live queue`, async () => {
  const f = hostForwardingFixture({ contextual }), page = f.renderer();
  try {
    await page.transport.connect(); await assert.rejects(page.transport.send(JSON.stringify({ method: 'sync-throw' })), /synthetic synchronous/);
    await page.transport.send(JSON.stringify({ method: 'echo', params: { afterError: true } }));
    assert.equal(page.transport.status.state, 'open');
  } finally { await f.close(); }
});

test('repeated open observations cannot replace a live native forwarding owner', async () => {
  const f = hostForwardingFixture(), page = f.renderer(); let outcome = 'pending';
  try {
    await page.transport.connect(); const old = page.transport.send(heldForwardingFrame('old')).catch(() => {});
    await flushForwarding(); f.physical.publish({ state: 'open' }); f.physical.publish({ state: 'open' });
    f.physical.publish({ state: 'closed' }); f.physical.publish({ state: 'open' }); await flushForwarding();
    await page.transport.connect(); const current = page.transport.send(JSON.stringify({ method: 'echo' })).then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
    await flushForwarding(); assert.equal(outcome, 'resolved'); assert.equal(f.physical.held[0]!.signal?.aborted, true);
    await old; await current;
  } finally { await f.close(); }
});

test('native loss releases local queues of every Renderer sharing that Host', async () => {
  const f = hostForwardingFixture(), a = f.renderer(), b = f.renderer(); let readyA = 'pending', readyB = 'pending';
  try {
    await a.client.connect(params); await b.client.connect(params);
    const oldA = a.client.requestRaw('hold', { tag: 'a' }).catch(() => {}), oldB = b.client.requestRaw('hold', { tag: 'b' }).catch(() => {});
    await flushForwarding(); assert.equal(f.physical.held.length, 2);
    f.physical.publish({ state: 'closed' }); f.physical.publish({ state: 'open' }); await flushForwarding();
    const nextA = a.client.connect(params).then(() => { readyA = 'resolved'; }, () => { readyA = 'rejected'; });
    const nextB = b.client.connect(params).then(() => { readyB = 'resolved'; }, () => { readyB = 'rejected'; });
    await flushForwarding(); assert.equal(readyA, 'resolved'); assert.equal(readyB, 'resolved');
    assert.deepEqual(await b.client.requestRaw('echo', { peer: true }), { peer: true }); await oldA; await oldB; await nextA; await nextB;
  } finally { await f.close(); }
});

test('retiring one Host does not cancel another Host local forwarding wait', async () => {
  const f = hostForwardingFixture(), a = f.renderer('a'), b = f.renderer('b'); let outcome = 'pending';
  try {
    await a.transport.connect(); await b.transport.connect(); const physicalA = f.physicals[0]!, physicalB = f.physicals[1]!;
    const oldA = a.transport.send(heldForwardingFrame('a')).catch(() => {});
    const oldB = b.transport.send(heldForwardingFrame('b')).then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
    await flushForwarding(); physicalA.publish({ state: 'closed' }); physicalA.publish({ state: 'open' }); await flushForwarding();
    assert.equal(outcome, 'pending'); assert.equal(physicalB.held[0]!.signal?.aborted, false);
    physicalB.settle('b'); await oldB; await oldA; assert.equal(outcome, 'resolved');
  } finally { await f.close(); }
});

test('native loss inside a provider call retires only the captured old forwarding epoch', async () => {
  const f = hostForwardingFixture(), page = f.renderer(); let outcome = 'pending';
  try {
    await page.transport.connect(); const old = page.transport.send(JSON.stringify({ method: 'cycle', params: { tag: 'old' } })).catch(() => {});
    await flushForwarding(); await page.transport.connect();
    const current = page.transport.send(JSON.stringify({ method: 'echo' })).then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
    await flushForwarding(); assert.equal(outcome, 'resolved'); assert.equal(f.physical.held[0]!.signal?.aborted, true); await old; await current;
  } finally { await f.close(); }
});

test('raw control forwarding retains a native manual failure disposition', async () => {
  const f = hostForwardingFixture(), page = f.renderer(); let outcome = 'pending', code: unknown, retryable: unknown;
  try {
    const lease = page.bridge.createLeaseId(), grant = await page.bridge.connectHost('a', lease);
    const old = page.bridge.sendHostFrame('a', lease, grant.generation, heldForwardingFrame('old')).then(() => { outcome = 'resolved'; }, error => {
      outcome = 'rejected'; code = error.code; retryable = error.retryable;
    });
    await flushForwarding(); f.physical.publish({ state: 'failed', reason: 'manual native policy', failure: { code: 'SSH_AUTH_EXPIRED', recovery: 'manual' } });
    await flushForwarding(); assert.equal(outcome, 'rejected'); assert.equal(code, 'SSH_AUTH_EXPIRED'); assert.equal(retryable, false); await old;
  } finally { await f.close(); }
});

test('a trusted same-key claim replacement cannot authorize an earlier queued frame', async () => {
  const f = hostForwardingFixture(), page = f.renderer(); let queuedOutcome = 'pending';
  try {
    const lease = page.bridge.createLeaseId(), grant = await page.bridge.connectHost('a', lease);
    const old = page.bridge.sendHostFrame('a', lease, grant.generation, heldForwardingFrame('old')); await flushForwarding();
    const queued = page.bridge.sendHostFrame('a', lease, grant.generation, heldForwardingFrame('queued')).then(() => { queuedOutcome = 'resolved'; }, () => { queuedOutcome = 'rejected'; });
    await flushForwarding();
    // This is the actual Server's trusted public API; no private claim map is touched.
    await f.server.handle(page.connection, { type: 'host/disconnect', hostId: 'a', leaseId: lease, generation: grant.generation, requestId: 'trusted-release' });
    await page.bridge.connectHost('a', lease); f.physical.settle('old'); await old; await flushForwarding();
    assert.equal(queuedOutcome, 'rejected'); assert.deepEqual(f.physical.held.map(e => e.tag), ['old']); await queued;
  } finally { await f.close(); }
});

test('a queued packet received while native closed cannot be healed by a later open', async () => {
  const f = hostForwardingFixture(), page = f.renderer(); let outcome = 'pending';
  try {
    const lease = page.bridge.createLeaseId(), grant = await page.bridge.connectHost('a', lease);
    const old = page.bridge.sendHostFrame('a', lease, grant.generation, heldForwardingFrame('old')).catch(() => {});
    await flushForwarding(); f.physical.publish({ state: 'closed' });
    const queued = page.bridge.sendHostFrame('a', lease, grant.generation, heldForwardingFrame('during-loss')).then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
    // Port receipt precedes this open; the old queue's asynchronous dequeue may follow it.
    queueMicrotask(() => f.physical.publish({ state: 'open' })); await flushForwarding();
    assert.equal(outcome, 'rejected'); assert.deepEqual(f.physical.held.map(w => w.tag), ['old']); await old; await queued;
  } finally { await f.close(); }
});
