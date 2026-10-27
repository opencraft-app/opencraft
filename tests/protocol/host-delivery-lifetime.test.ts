import assert from 'node:assert/strict';
import test from 'node:test';
import { hostLifetimeFixture, flushHostLifetime } from './fixtures/host-delivery-lifetime';
import { messageHostFixture } from './fixtures/native-message';
import { JsonRpcAppServerClient } from '@opencraft/appserver-client';

for (const state of ['idle', 'connecting', 'closing', 'closed', 'failed'] as const)
  test(`native ${state} retires readiness before an earlier public Host observer`, async () => {
    const f = hostLifetimeFixture(); let next: Promise<void> | undefined, inside: string | undefined, once = false;
    f.client.subscribeHost('a', event => {
      if (event.status?.state !== state || once) return; once = true;
      inside = channel.status.state; next = channel.connect(); void next.catch(() => {});
    });
    const channel = f.client.createTransport('a');
    try {
      await channel.connect(); const old = f.claim('a');
      f.status('a', 1, { state }); await flushHostLifetime(); await next;
      assert.equal(inside, state); assert.equal(channel.status.state, 'open');
      assert.notEqual(f.claim('a').leaseId, old.leaseId);
    } finally { f.client.close(); await channel.close(); }
  });

test('frame retirement rejects send before any queued child status observer', async () => {
  const f = hostLifetimeFixture(), channel = f.client.createTransport('a');
  let outcome = 'not-issued', inside: string | undefined;
  channel.subscribeMessage(() => {
    f.status('a', 1, { state: 'closed' }); inside = channel.status.state;
    void channel.send('must not cross').then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
  });
  try {
    await channel.connect(); f.frame('a', 1); await flushHostLifetime();
    assert.equal(inside, 'closed'); assert.equal(outcome, 'rejected');
    assert.equal(f.sent.filter(m => m.type === 'host/send').length, 0);
  } finally { f.client.close(); await channel.close(); }
});

for (const termination of ['native', 'local', 'bridge'] as const)
  test(`${termination} retirement settles held forwarding locally without old ACK cooperation`, async () => {
    const f = hostLifetimeFixture({ maxPendingRequests: 1 }), a = f.client.createTransport('a');
    let outcome = 'pending';
    try {
      await a.connect(); const sent = a.send('unknown remote outcome').then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
      let closing: Promise<void> | undefined;
      if (termination === 'native') f.status('a', 1, { state: 'closed' });
      else if (termination === 'local') closing = a.close(); else f.client.close();
      await flushHostLifetime(); assert.equal(outcome, 'rejected'); await sent; await closing;
      if (termination !== 'bridge') {
        const b = f.client.createTransport('b'); await b.connect(); assert.equal(b.status.state, 'open');
        f.acknowledge(f.held[0]!); await flushHostLifetime(); assert.equal(b.status.state, 'open'); await b.close();
      }
      assert.equal(f.sent.filter(m => m.type === 'host/send').length, 1);
    } finally { f.client.close(); await a.close(); }
  });

test('native loss between own ACK receipt and promise adoption cannot grant stale readiness', async () => {
  const f = hostLifetimeFixture({ holdConnect: true }), channel = f.client.createTransport('a');
  try {
    const connection = channel.connect(), rejected = assert.rejects(connection, /retired|disconnected|loss/);
    await flushHostLifetime(); f.acknowledge(f.claim('a'), 7);
    f.status('a', 7, { state: 'idle', reason: 'native loss after ACK' }); await rejected;
    assert.notEqual(channel.status.state, 'open');
  } finally { f.client.close(); await channel.close(); }
});

test('local lease close cancels only its own forwarding wait, including same Host generation peers', async () => {
  const f = hostLifetimeFixture({ holdConnect: true }), a = f.client.createTransport('a'), peer = f.client.createTransport('a');
  try {
    const first = a.connect(); await flushHostLifetime(); f.acknowledge(f.claim('a'), 7); await first;
    const second = peer.connect(); await flushHostLifetime(); f.acknowledge(f.claim('a'), 7); await second;
    let own = 'pending', other = 'pending';
    const p = a.send('own').then(() => { own = 'resolved'; }, () => { own = 'rejected'; });
    const q = peer.send('peer').then(() => { other = 'resolved'; }, () => { other = 'rejected'; });
    await a.close(); await flushHostLifetime(); assert.equal(own, 'rejected'); assert.equal(other, 'pending');
    const peerSend = f.held.find(m => m.type === 'host/send' && m.frame === 'peer')!;
    f.acknowledge(peerSend); await q; await p; assert.equal(other, 'resolved'); assert.equal(peer.status.state, 'open');
  } finally { f.client.close(); await a.close(); await peer.close(); }
});

test('a fresh own ACK can grant the same Host record generation without reviving the retired lease', async () => {
  const f = hostLifetimeFixture({ holdConnect: true }), channel = f.client.createTransport('a');
  try {
    const first = channel.connect(); await flushHostLifetime(); f.acknowledge(f.claim('a'), 7); await first;
    const old = f.claim('a'); f.status('a', 7, { state: 'closed' });
    f.status('a', 7, { state: 'open' }); await assert.rejects(channel.send('no shared grant'));
    const next = channel.connect(); await flushHostLifetime(); f.acknowledge(f.claim('a'), 7); await next;
    assert.notEqual(f.claim('a').leaseId, old.leaseId); assert.equal(channel.status.state, 'open');
  } finally { f.client.close(); await channel.close(); }
});

test('a terminal admitted before own ACK is remembered before queued Host observations', async () => {
  const f = hostLifetimeFixture({ holdConnect: true });
  f.client.subscribeHost('a', event => {
    if (!event.frame) return;
    f.status('a', 7, { state: 'failed', reason: 'pre-ACK native policy', failure: { code: 'APP_HOST_POLICY', recovery: 'manual' } });
    f.acknowledge(f.claim('a'), 7);
  });
  const channel = f.client.createTransport('a');
  try {
    const next = channel.connect(), rejected = assert.rejects(next, /pre-ACK native policy/);
    await flushHostLifetime(); f.frame('a', 7); await rejected;
    assert.equal(channel.status.failure?.recovery, 'manual');
  } finally { f.client.close(); await channel.close(); }
});

test('a startup caller abort after successful handoff cannot cancel its current forwarding lifetime', async () => {
  const f = hostLifetimeFixture(), channel = f.client.createTransport('a'), caller = new AbortController();
  try {
    await channel.connect(caller.signal); caller.abort();
    const send = channel.send('current'); f.acknowledge(f.held.at(-1)!); await send;
    assert.equal(channel.status.state, 'open');
  } finally { f.client.close(); await channel.close(); }
});

test('actual Client retains successful reinitialization from an early public Host closed observer', async () => {
  const f = messageHostFixture(); let next: Promise<unknown> | undefined;
  const params = { clientInfo: { name: 'native-lifetime-control', version: '1' } };
  f.client.subscribeHost('a', event => { if (event.status?.state === 'closed') { next = client.connect(params); void next.catch(() => {}); } });
  const transport = f.client.createTransport('a'), client = new JsonRpcAppServerClient({ hostId: 'a', transport, requestTimeoutMs: 0 });
  try {
    await client.connect(params); assert.equal(client.connectionGeneration, 1);
    f.lost('a'); await flushHostLifetime(); await next;
    assert.equal(client.connectionGeneration, 2); assert.equal(transport.status.state, 'open');
  } finally { await client.close(); f.client.close(); }
});

test('native retirement frees forwarding budget before the first external Host status callback', async () => {
  const f = hostLifetimeFixture({ maxPendingRequests: 1 }); let next: Promise<void> | undefined;
  f.client.subscribeHost('a', event => {
    if (event.status?.state === 'closed') { next = b.send('peer control admitted in callback'); void next.catch(() => {}); }
  });
  const a = f.client.createTransport('a'), b = f.client.createTransport('b');
  try {
    await a.connect(); await b.connect();
    const old = a.send('unknown remote result'), rejected = assert.rejects(old, /aborted/);
    f.status('a', 1, { state: 'closed' });
    assert.equal(f.sent.filter(m => m.type === 'host/send').length, 2);
    f.acknowledge(f.held.at(-1)!); await next; await rejected;
    assert.equal(b.status.state, 'open');
  } finally { f.client.close(); await a.close(); await b.close(); }
});

test('native generation loss retires every matching lease forwarding wait', async () => {
  const f = hostLifetimeFixture({ holdConnect: true }), a = f.client.createTransport('a'), b = f.client.createTransport('a');
  try {
    const first = a.connect(); await flushHostLifetime(); f.acknowledge(f.claim('a'), 7); await first;
    const second = b.connect(); await flushHostLifetime(); f.acknowledge(f.claim('a'), 7); await second;
    const p = assert.rejects(a.send('one'), /aborted/), q = assert.rejects(b.send('two'), /aborted/);
    f.status('a', 7, { state: 'closed' }); await p; await q;
    assert.equal(a.status.state, 'closed'); assert.equal(b.status.state, 'closed');
  } finally { f.client.close(); await a.close(); await b.close(); }
});
