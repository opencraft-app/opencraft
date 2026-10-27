import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationFixture, flushCleanup, trackCleanup } from './fixtures/host-notifications';

test('a held logical notification cannot postpone last-claim physical release', async () => {
  const f = notificationFixture({ onCreate(p) { p.notifyMode = 'hold'; } });
  try {
    const c = f.page().channel(); await c.open();
    const closing = trackCleanup(c.client.close()); await flushCleanup();
    assert.equal(f.physicals[0]!.closeCalls, 1); assert.equal(f.physicals[0]!.released, true);
    assert.equal(closing.state, 'resolved'); assert.equal(c.transport.status.state, 'closed');
    assert.equal(f.physicals[0]!.notifications.length, 1);
  } finally { await f.close(); }
});

test('notification retirement still waits for actual physical release before replacement', async () => {
  const f = notificationFixture({ onCreate(p, i) { if (!i) { p.notifyMode = 'hold'; p.mode = 'hold'; } } });
  try {
    const page = f.page(), first = page.channel(); await first.open();
    const closing = trackCleanup(first.client.close()); await flushCleanup();
    assert.equal(f.physicals[0]!.closeCalls, 1); assert.equal(closing.state, 'pending');
    const next = page.channel(), opening = trackCleanup(next.open()); await flushCleanup();
    assert.equal(opening.state, 'pending'); assert.equal(f.physicals.length, 1);
    f.physicals[0]!.closeGate.resolve(); await closing.promise; await opening.promise;
    assert.equal(opening.state, 'resolved'); assert.equal(f.physicals.length, 2);
    assert.deepEqual(await next.client.requestRaw('echo', { after: 'actual release' }), { after: 'actual release' });
  } finally { await f.close(); }
});

test('physical cleanup failure wins over a held logical notification and retains its fence', async () => {
  const f = notificationFixture({ onCreate(p) { p.notifyMode = 'hold'; p.mode = 'reject'; } });
  try {
    const page = f.page(), grant = await page.bridge.connectHost('a', 'cleanup-failure');
    const closing = trackCleanup(page.bridge.disconnectHost('a', 'cleanup-failure', grant.generation)); await flushCleanup();
    assert.equal(f.physicals[0]!.closeCalls, 1); assert.equal(closing.state, 'rejected');
    assert.equal((closing.error as { code?: string }).code, 'APP_HOST_CLEANUP_FAILED');
    assert.equal(f.server.hostState('a'), 'failed');
    await assert.rejects(page.channel().transport.connect(), { code: 'APP_HOST_CLEANUP_FAILED' });
    assert.equal(f.physicals.length, 1);
  } finally { await f.close(); }
});

test('Renderer closure joins an unknown pending notification instead of sending it twice', async () => {
  const f = notificationFixture({ lifetime: 'server', onCreate(p) { p.notifyMode = 'hold'; } });
  try {
    const page = f.page(), c = page.channel(); await c.open();
    const closing = trackCleanup(c.client.close()); await flushCleanup();
    assert.equal(f.physicals[0]!.notifications.length, 1);
    page.bridge.close(); await closing.promise; await flushCleanup();
    assert.equal(f.physicals[0]!.notifications.length, 1); assert.equal(f.physicals[0]!.closeCalls, 0);
  } finally { await f.close(); }
});

test('a synchronous background notification throw cannot skip physical cleanup', async () => {
  const f = notificationFixture({ onCreate(p) { p.notifyMode = 'throw'; } });
  try {
    const page = f.page(); await page.channel().open();
    assert.doesNotThrow(() => page.connection.close()); await flushCleanup();
    assert.equal(f.physicals[0]!.closeCalls, 1); assert.equal(f.physicals[0]!.released, true);
  } finally { await f.close(); }
});

test('a service notification deadline preserves a peer and cannot retry an unknown write on detach', async () => {
  const f = notificationFixture({ lifetime: 'server', onCreate(p) { p.notifyMode = 'hold'; } });
  try {
    const page = f.page(), peer = page.channel(); await peer.open();
    const grant = await page.bridge.connectHost('a', 'held-notification');
    const closing = trackCleanup(page.bridge.disconnectHost('a', 'held-notification', grant.generation)); await flushCleanup();
    await f.deadline();
    assert.equal(closing.state, 'rejected'); assert.equal((closing.error as { code?: string }).code, 'APP_HOST_DISCONNECT_TIMEOUT');
    assert.deepEqual(await peer.client.requestRaw('echo', { peer: 'alive' }), { peer: 'alive' });
    assert.equal(f.physicals[0]!.closeCalls, 0); assert.equal(f.physicals[0]!.notifications.length, 1);
    page.connection.close(); await flushCleanup();
    // Only the still-live peer gets a new notification at detach.
    assert.equal(f.physicals[0]!.notifications.length, 2);
  } finally { await f.close(); }
});

test('known notification failure remains observable and permits one detach retry', async () => {
  const f = notificationFixture({ lifetime: 'server', onCreate(p) { p.notifyMode = 'reject'; } });
  try {
    const page = f.page(), grant = await page.bridge.connectHost('a', 'known-failure');
    await assert.rejects(page.bridge.disconnectHost('a', 'known-failure', grant.generation), /synthetic rejected notification/);
    assert.equal(f.physicals[0]!.notifications.length, 1);
    page.connection.close(); await flushCleanup(); assert.equal(f.physicals[0]!.notifications.length, 2);
  } finally { await f.close(); }
});

test('failed logical cleanup fences new admissions while a live peer continues using its Host', async () => {
  const f = notificationFixture({ lifetime: 'server', onCreate(p) { p.notifyMode = 'reject'; } });
  try {
    const failed = f.page(), peer = f.page().channel(); await peer.open();
    const grant = await failed.bridge.connectHost('a', 'failed-cleanup');
    await assert.rejects(failed.bridge.disconnectHost('a', 'failed-cleanup', grant.generation));
    const arriving = f.page().channel();
    await assert.rejects(arriving.transport.connect(), { code: 'APP_HOST_LOGICAL_CLEANUP_FAILED' });
    assert.deepEqual(await peer.client.requestRaw('echo', { peer: 'continues' }), { peer: 'continues' });
    assert.equal(f.physicals.length, 1); assert.equal(f.physicals[0]!.closeCalls, 0);
    f.physicals[0]!.notifyMode = 'success'; failed.connection.close(); await flushCleanup();
    await arriving.open(); assert.equal(f.physicals[0]!.notifications.length, 2);
  } finally { await f.close(); }
});

test('a late success clears only its failed notification admission fence and never revives its waiter', async () => {
  const f = notificationFixture({ lifetime: 'server', onCreate(p) { p.notifyMode = 'hold'; } });
  try {
    const page = f.page(), grant = await page.bridge.connectHost('a', 'late-cleanup');
    const closing = trackCleanup(page.bridge.disconnectHost('a', 'late-cleanup', grant.generation)); await flushCleanup();
    await f.deadline(); assert.equal(closing.state, 'rejected');
    const next = f.page().channel(); await assert.rejects(next.transport.connect(), { code: 'APP_HOST_LOGICAL_CLEANUP_FAILED' });
    page.connection.close(); await flushCleanup(); assert.equal(f.physicals[0]!.notifications.length, 1);
    f.physicals[0]!.releaseNotifications(); await flushCleanup();
    await next.open(); assert.equal(closing.state, 'rejected'); assert.equal(f.physicals.length, 1);
    assert.deepEqual(await next.client.requestRaw('echo', { healed: true }), { healed: true });
  } finally { await f.close(); }
});

test('synchronous provider reentry joins the notification owner installed before its call', async () => {
  const f = notificationFixture({ lifetime: 'server', onCreate(p) { p.notifyMode = 'hold'; } });
  try {
    const page = f.page(), grant = await page.bridge.connectHost('a', 'reentrant');
    const p = f.physicals[0]!; p.onNotify = () => { p.onNotify = undefined; page.connection.close(); };
    const closing = trackCleanup(f.server.handle(page.connection, { type: 'host/disconnect', hostId: 'a', leaseId: 'reentrant', generation: grant.generation, requestId: 'direct-close' }));
    await flushCleanup(); assert.equal(p.notifications.length, 1); assert.equal(p.closeCalls, 0);
    await f.deadline(); await closing.promise; assert.equal(closing.state, 'rejected');
  } finally { await f.close(); }
});

test('notification timeout installs its failure fence before a provider abort callback reenters', async () => {
  const f = notificationFixture({ lifetime: 'server', onCreate(p) { p.notifyMode = 'hold'; } });
  try {
    const page = f.page(), grant = await page.bridge.connectHost('a', 'timeout-reentry');
    const p = f.physicals[0]!; let reentry: ReturnType<typeof trackCleanup> | undefined;
    p.onNotify = () => p.notifications.at(-1)!.signal?.addEventListener('abort', () => {
      reentry = trackCleanup(f.server.handle(page.connection, { type: 'host/connect', hostId: 'a', leaseId: 'after-timeout', requestId: 'reentry' }));
    }, { once: true });
    const closing = trackCleanup(page.bridge.disconnectHost('a', 'timeout-reentry', grant.generation)); await flushCleanup();
    await f.deadline(); assert.equal(closing.state, 'rejected'); assert.equal(reentry?.state, 'rejected');
    assert.equal((reentry?.error as { code?: string }).code, 'APP_HOST_LOGICAL_CLEANUP_FAILED');
    assert.equal(f.physicals.length, 1);
  } finally { await f.close(); }
});

test('old completion cannot forget a replacement registration using the same trusted local key', async () => {
  const f = notificationFixture({ lifetime: 'server', onCreate(p) { p.notifyMode = 'hold'; } });
  try {
    const page = f.page(), grant = await page.bridge.connectHost('a', 'same-key');
    const old = trackCleanup(page.bridge.disconnectHost('a', 'same-key', grant.generation)); await flushCleanup();
    // The production Client uses fresh lease IDs. This additionally challenges
    // the Server's captured-object cleanup guard without claiming remote reuse is safe.
    await page.bridge.connectHost('a', 'same-key');
    f.physicals[0]!.notifications[0]!.gate.resolve(); await old.promise;
    page.connection.close(); await flushCleanup();
    assert.equal(f.physicals[0]!.notifications.length, 2, 'the replacement registration still needs its own disconnect');
  } finally { await f.close(); }
});

test('Renderer detach cannot retry a known notification after physical cleanup has started', async () => {
  const f = notificationFixture({ onCreate(p) { p.notifyMode = 'reject'; p.mode = 'hold'; } });
  try {
    const page = f.page(), grant = await page.bridge.connectHost('a', 'closing-physical');
    const closing = trackCleanup(f.server.handle(page.connection, { type: 'host/disconnect', hostId: 'a', leaseId: 'closing-physical', generation: grant.generation, requestId: 'direct' }));
    await flushCleanup(); page.connection.close(); await flushCleanup();
    assert.equal(f.physicals[0]!.notifications.length, 1); assert.equal(f.physicals[0]!.closeCalls, 1);
    f.physicals[0]!.closeGate.resolve(); await closing.promise;
    assert.equal(closing.state, 'rejected'); assert.equal(f.physicals[0]!.released, true);
  } finally { await f.close(); }
});

test('failed cleanup stops serial registration growth without disconnecting an admitted peer', async () => {
  const f = notificationFixture({ lifetime: 'server', onCreate(p) { p.notifyMode = 'reject'; } });
  try {
    const page = f.page(), peer = page.channel(); await peer.open();
    const grant = await page.bridge.connectHost('a', 'first-failed');
    await assert.rejects(page.bridge.disconnectHost('a', 'first-failed', grant.generation));
    for (let i = 0; i < 40; i++) await assert.rejects(page.bridge.connectHost('a', `blocked-${i}`), { code: 'APP_HOST_LOGICAL_CLEANUP_FAILED' });
    assert.equal(f.physicals[0]!.notifications.length, 1); assert.equal(f.physicals.length, 1);
    assert.deepEqual(await peer.client.requestRaw('echo', { after: 40 }), { after: 40 });
  } finally { await f.close(); }
});

test('a late rejection retains manual admission failure until the captured physical owner is reset', async () => {
  const f = notificationFixture({ lifetime: 'server', onCreate(p) { p.notifyMode = 'hold'; } });
  try {
    const page = f.page(), grant = await page.bridge.connectHost('a', 'late-failure');
    const closing = trackCleanup(page.bridge.disconnectHost('a', 'late-failure', grant.generation)); await flushCleanup();
    await f.deadline(); page.connection.close();
    f.physicals[0]!.notifications[0]!.gate.reject(Error('late provider rejection')); await flushCleanup();
    assert.equal(closing.state, 'rejected'); assert.equal(f.physicals[0]!.notifications.length, 1);
    const next = f.page(); await assert.rejects(next.bridge.connectHost('a', 'still-blocked'), { code: 'APP_HOST_LOGICAL_CLEANUP_FAILED' });
    await f.server.resetHost('a'); const fresh = next.channel(); await fresh.open();
    assert.equal(f.physicals[0]!.released, true); assert.equal(f.physicals.length, 2);
    assert.deepEqual(await fresh.client.requestRaw('echo', { fresh: true }), { fresh: true });
  } finally { await f.close(); }
});

test('one late success cannot clear another logical client cleanup failure', async () => {
  const f = notificationFixture({ lifetime: 'server', onCreate(p) { p.notifyMode = 'hold'; } });
  try {
    const page = f.page(), a = await page.bridge.connectHost('a', 'first'), b = await page.bridge.connectHost('a', 'second');
    const first = trackCleanup(page.bridge.disconnectHost('a', 'first', a.generation));
    const second = trackCleanup(page.bridge.disconnectHost('a', 'second', b.generation)); await flushCleanup();
    await f.deadline(); assert.equal(first.state, 'rejected'); assert.equal(second.state, 'rejected');
    f.physicals[0]!.notifications[0]!.gate.resolve(); await flushCleanup();
    await assert.rejects(page.bridge.connectHost('a', 'not-yet'), { code: 'APP_HOST_LOGICAL_CLEANUP_FAILED' });
    f.physicals[0]!.notifications[1]!.gate.resolve(); await flushCleanup();
    const fresh = page.channel(); await fresh.open(); assert.deepEqual(await fresh.client.requestRaw('echo', { both: 'clean' }), { both: 'clean' });
  } finally { await f.close(); }
});

test('late old physical notification failure cannot fence or dispose its successor', async () => {
  const f = notificationFixture({ lifetime: 'server', onCreate(p) { p.notifyMode = 'hold'; } });
  try {
    const page = f.page(), grant = await page.bridge.connectHost('a', 'old-physical');
    const closing = trackCleanup(page.bridge.disconnectHost('a', 'old-physical', grant.generation)); await flushCleanup();
    await f.deadline(); await f.server.resetHost('a');
    const next = page.channel(); await next.open();
    f.physicals[0]!.notifications[0]!.gate.reject(Error('late obsolete native result')); await flushCleanup();
    const peer = page.channel(); await peer.open();
    assert.equal(closing.state, 'rejected'); assert.equal(f.physicals.length, 2); assert.equal(f.physicals[1]!.closeCalls, 0);
    assert.deepEqual(await next.client.requestRaw('echo', { successor: 'alive' }), { successor: 'alive' });
  } finally { await f.close(); }
});

test('a logical cleanup fence cannot block existing recovery of a non-open native transport', async () => {
  const f = notificationFixture({ lifetime: 'server', onCreate(p, i) { if (!i) p.notifyMode = 'reject'; } });
  try {
    const page = f.page(), grant = await page.bridge.connectHost('a', 'before-native-loss');
    await assert.rejects(page.bridge.disconnectHost('a', 'before-native-loss', grant.generation));
    const old = f.physicals[0]!; old.publish({ state: 'closed' });
    const fresh = page.channel(), opening = trackCleanup(fresh.open()); await flushCleanup();
    assert.equal(old.closeCalls, 1, 'existing native recovery must attempt real cleanup despite a logical failure');
    assert.equal(old.released, true); assert.equal(opening.state, 'resolved'); assert.equal(f.physicals.length, 2);
    assert.deepEqual(await fresh.client.requestRaw('echo', { native: 'recovered' }), { native: 'recovered' });
  } finally { await f.close(); }
});

test('native recovery still requires successful physical release when a logical fence exists', async () => {
  const f = notificationFixture({ lifetime: 'server', onCreate(p, i) { if (!i) p.notifyMode = 'reject'; } });
  try {
    const page = f.page(), grant = await page.bridge.connectHost('a', 'native-failed-release');
    await assert.rejects(page.bridge.disconnectHost('a', 'native-failed-release', grant.generation));
    const old = f.physicals[0]!; old.mode = 'reject'; old.publish({ state: 'closed' });
    const next = page.channel(), opening = trackCleanup(next.transport.connect()); await flushCleanup();
    assert.equal(old.closeCalls, 1); assert.equal(old.released, false); assert.equal(f.physicals.length, 1);
    assert.equal(opening.state, 'rejected'); assert.equal((opening.error as { code?: string }).code, 'APP_HOST_CLEANUP_FAILED');
    old.mode = 'success'; await f.server.resetHost('a'); await next.open(); assert.equal(f.physicals.length, 2);
  } finally { await f.close(); }
});

test('a native recovery observer timeout cannot release resources or start an unowned replacement', async () => {
  const f = notificationFixture({ lifetime: 'server', onCreate(p, i) { if (!i) p.notifyMode = 'reject'; } });
  try {
    const page = f.page(), grant = await page.bridge.connectHost('a', 'native-held-release');
    await assert.rejects(page.bridge.disconnectHost('a', 'native-held-release', grant.generation));
    const old = f.physicals[0]!; old.mode = 'hold'; old.publish({ state: 'closed' });
    const next = page.channel(), opening = trackCleanup(next.transport.connect()); await flushCleanup();
    assert.equal(old.closeCalls, 1); assert.equal(opening.state, 'pending');
    await f.deadline(); assert.equal(opening.state, 'rejected');
    assert.equal((opening.error as { code?: string }).code, 'APP_HOST_CLEANUP_TIMEOUT');
    assert.equal(old.released, false); assert.equal(f.physicals.length, 1);
    old.closeGate.resolve(); await flushCleanup(); assert.equal(f.physicals.length, 1);
    await next.open(); assert.equal(f.physicals.length, 2);
    assert.deepEqual(await next.client.requestRaw('echo', { after: 'physical release' }), { after: 'physical release' });
  } finally { await f.close(); }
});
