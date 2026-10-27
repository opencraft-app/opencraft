import assert from 'node:assert/strict';
import test from 'node:test';
import { hostCleanupFixture, flushCleanup, trackCleanup, type CleanupMode } from './fixtures/host-cleanup';
const cleanupFailure = (error: unknown) => (error as { code?: string; retryable?: boolean })?.code === 'APP_HOST_CLEANUP_FAILED' && (error as { retryable?: boolean }).retryable === false;

test('a service admission revoked before the deferred factory cannot allocate a transport', async () => {
  const f = hostCleanupFixture({ lifetime: 'server' }); let authorized = true;
  try {
    const opening = f.server.ensureHostConnected('a', () => { if (!authorized) throw Error('revoked service admission'); });
    const rejected = assert.rejects(opening);
    authorized = false; await rejected;
    assert.equal(f.physicals.length, 0, 'a revoked service intent is not current demand');
  } finally { await f.close(); }
});

test('a revoked service admission cannot cancel a valid peer or report its success as its own', async () => {
  const f = hostCleanupFixture({ lifetime: 'server' }); let authorized = true;
  try {
    const obsolete = f.server.ensureHostConnected('a', () => { if (!authorized) throw Error('revoked service admission'); });
    const rejected = assert.rejects(obsolete, /revoked service admission/);
    const current = f.server.ensureHostConnected('a');
    authorized = false; await current; await rejected;
    assert.equal(f.physicals.length, 1); assert.equal(f.physicals[0]!.released, false);
    assert.equal(f.server.hostState('a'), 'open');
  } finally { await f.close(); }
});
for (const mode of ['reject','throw','reject-released'] as const) test(`${mode} close quarantines the same physical owner until explicit reset`, async () => {
  const f = hostCleanupFixture({ onCreate(p, i) { if (i === 0) p.mode = mode; } });
  try {
    const first = f.channel(); await first.connect(); const physical = f.physicals[0]!;
    await first.close(); assert.equal(f.server.hostState('a'), 'failed');
    const blocked = f.channel(); await assert.rejects(blocked.connect(), cleanupFailure);
    assert.equal(f.physicals.length, 1); assert.equal(physical.closeCalls, 1, 'ordinary connect must not retry failed cleanup');
    assert.equal(physical.released, mode === 'reject-released');
    physical.mode = 'success'; await f.server.resetHost('a');
    assert.equal(physical.closeCalls, 2); assert.equal(physical.released, true);
    assert.equal(f.server.hostState('a'), 'closed');
    await f.channel().connect(); assert.equal(f.physicals.length, 2);
  } finally { await f.close(); }
});

test('a pending physical cleanup retains its barrier and a late status cannot retire a successor', async () => {
  const f = hostCleanupFixture();
  try {
    const first = f.channel(); await first.connect(); const old = f.physicals[0]!; old.mode = 'hold';
    const closing = trackCleanup(first.close()); await flushCleanup();
    const next = f.channel(), opening = trackCleanup(next.connect()); await flushCleanup();
    assert.equal(closing.state, 'pending'); assert.equal(opening.state, 'pending'); assert.equal(f.physicals.length, 1);
    old.closeGate.resolve(); await closing.promise; await opening.promise;
    assert.equal(opening.state, 'resolved'); assert.equal(f.physicals.length, 2);
    old.statusCallbacks[0]!({ state: 'failed' }); await flushCleanup();
    assert.equal(f.server.hostState('a'), 'open'); assert.equal(next.status.state, 'open');
  } finally { await f.close(); }
});

test('each failed trusted reset performs one cleanup attempt on the retained transport', async () => {
  const f = hostCleanupFixture({ onCreate(p, i) { if (!i) p.mode = 'reject'; } });
  try {
    await f.channel().connect(); const physical = f.physicals[0]!;
    await assert.rejects(f.server.resetHost('a'), cleanupFailure); assert.equal(physical.closeCalls, 1);
    await assert.rejects(f.server.resetHost('a'), cleanupFailure); assert.equal(physical.closeCalls, 2);
    assert.equal(f.physicals.length, 1);
    physical.mode = 'success'; await f.server.resetHost('a'); assert.equal(physical.closeCalls, 3);
    await f.channel().connect(); assert.equal(f.physicals.length, 2);
  } finally { await f.close(); }
});

for (const mode of ['reject','throw'] as const) test(`failed startup retains ${mode} cleanup rather than opening a second factory`, async () => {
  const f = hostCleanupFixture({ onCreate(p, i) { if (!i) { p.failStart = true; p.mode = mode; } } });
  try {
    await assert.rejects(f.channel().connect(), cleanupFailure);
    assert.equal(f.server.hostState('a'), 'failed');
    await assert.rejects(f.channel().connect(), cleanupFailure);
    assert.equal(f.physicals.length, 1); const old = f.physicals[0]!; assert.equal(old.closeCalls, 1);
    old.mode = 'success'; await f.server.resetHost('a'); await f.channel().connect();
    assert.equal(old.released, true); assert.equal(f.physicals.length, 2);
  } finally { await f.close(); }
});

test('cancelled startup cleanup failure is not automatically retried inside the same reset', async () => {
  const f = hostCleanupFixture({ onCreate(p, i) { if (!i) { p.holdStart = true; p.mode = 'reject'; } } });
  try {
    const starting = trackCleanup(f.channel().connect()); await flushCleanup();
    const resetting = trackCleanup(f.server.resetHost('a')); await flushCleanup();
    f.physicals[0]!.startGate.resolve(); await starting.promise; await resetting.promise;
    assert.equal(resetting.state, 'rejected'); assert.ok(cleanupFailure(resetting.error));
    assert.equal(f.physicals[0]!.closeCalls, 1); assert.equal(f.server.hostState('a'), 'failed');
    await assert.rejects(f.channel().connect(), cleanupFailure); assert.equal(f.physicals.length, 1);
  } finally { await f.close(); }
});

test('partial subscription construction detaches already-acquired callbacks and retains failed cleanup', async () => {
  const f = hostCleanupFixture({ onCreate(p, i) { if (!i) { p.throwStatusSubscription = true; p.mode = 'reject'; } } });
  try {
    await assert.rejects(f.channel().connect(), cleanupFailure); const physical = f.physicals[0]!;
    assert.equal(physical.detachCalls, 1); assert.equal(physical.closeCalls, 1);
    await assert.rejects(f.channel().connect(), cleanupFailure); assert.equal(f.physicals.length, 1);
    physical.mode = 'success'; await f.server.resetHost('a'); assert.equal(physical.released, true);
  } finally { await f.close(); }
});

test('one throwing detach cannot skip another detach or successful physical release', async () => {
  const f = hostCleanupFixture();
  try {
    const first = f.channel(); await first.connect(); const old = f.physicals[0]!; old.throwMessageDetach = true;
    await first.close(); assert.equal(old.detachCalls, 2); assert.equal(old.closeCalls, 1); assert.equal(old.released, true);
    assert.equal(f.server.hostState('a'), 'failed');
    old.throwMessageDetach = false; await f.server.resetHost('a');
    assert.equal(old.detachCalls, 3); assert.equal(old.closeCalls, 2);
    assert.equal(f.server.hostState('a'), 'closed'); await f.channel().connect(); assert.equal(f.physicals.length, 2);
  } finally { await f.close(); }
});

for (const mode of ['reject','throw','reject-released'] as const) test(`shutdown reports ${mode} cleanup and retries its retained handle on a later close`, async () => {
  const f = hostCleanupFixture({ onCreate(p) { p.mode = mode; } });
  try {
    await f.channel().connect(); const old = f.physicals[0]!;
    await assert.rejects(f.server.close(), cleanupFailure); assert.equal(old.closeCalls, 1);
    assert.equal(f.server.hostState('a'), 'failed'); assert.equal(f.physicals.length, 1);
    old.mode = 'success'; await f.server.close(); assert.equal(old.closeCalls, 2); assert.equal(old.released, true);
    assert.equal(f.server.hostState('a'), 'idle');
  } finally { await f.close(); }
});

test('shutdown waits for a pending factory and reports its failed late cleanup', async () => {
  const f = hostCleanupFixture({ onCreate(p) { p.holdStart = true; p.mode = 'reject'; } });
  try {
    const startup = trackCleanup(f.channel().connect()); await flushCleanup();
    const closing = trackCleanup(f.server.close()); await flushCleanup(); assert.equal(closing.state, 'pending');
    f.physicals[0]!.startGate.resolve(); await closing.promise;
    // The opaque Port has no close-event contract. Its shared bridge owner
    // ends local requests after observing the Server shutdown outcome.
    f.bridge.close(); await startup.promise;
    assert.equal(closing.state, 'rejected'); assert.ok(cleanupFailure(closing.error)); assert.equal(f.physicals[0]!.closeCalls, 1);
    f.physicals[0]!.mode = 'success'; await f.server.close(); assert.equal(f.physicals[0]!.released, true);
  } finally { await f.close(); }
});

test('server-owned lifetime does not close on page detach, but failed explicit reset remains fenced', async () => {
  const f = hostCleanupFixture({ lifetime: 'server', onCreate(p, i) { if (!i) p.mode = 'reject'; } });
  try {
    const page = f.channel(); await page.connect(); await page.close(); assert.equal(f.physicals[0]!.closeCalls, 0);
    await assert.rejects(f.server.resetHost('a'), cleanupFailure);
    await assert.rejects(f.channel().connect(), cleanupFailure); assert.equal(f.physicals.length, 1);
    f.physicals[0]!.mode = 'success'; await f.server.resetHost('a'); await f.channel().connect(); assert.equal(f.physicals.length, 2);
  } finally { await f.close(); }
});

test('synchronous factory reentry joins an already-published startup operation', async () => {
  let reentry: ReturnType<typeof trackCleanup> | undefined;
  const f = hostCleanupFixture({ lifetime: 'server', onCreate(_p, i) { if (!i) reentry = trackCleanup(f.server.ensureHostConnected('a')); } });
  try {
    await f.channel().connect(); await flushCleanup(); assert.equal(reentry?.state, 'resolved'); assert.equal(f.physicals.length, 1);
  } finally { await f.close(); }
});

test('successful rollback of a failed startup preserves its logical failure and permits a new intent', async () => {
  const f = hostCleanupFixture({ onCreate(p, i) { if (!i) p.failStart = true; } });
  try {
    await assert.rejects(f.channel().connect(), /synthetic startup failure/);
    assert.equal(f.physicals[0]!.released, true); assert.equal(f.physicals[0]!.closeCalls, 1);
    assert.equal(f.server.hostState('a'), 'failed');
    await f.channel().connect(); assert.equal(f.physicals.length, 2); assert.equal(f.server.hostState('a'), 'open');
  } finally { await f.close(); }
});

test('an arrival during failed-startup rollback owns a fresh startup after the old physical release', async () => {
  const f = hostCleanupFixture({ onCreate(p, i) { if (!i) { p.failStart = true; p.mode = 'hold'; } } });
  try {
    const old = trackCleanup(f.channel().connect()); await flushCleanup();
    assert.equal(old.state, 'pending'); assert.equal(f.server.hostState('a'), 'closing');
    const next = f.channel(), arriving = trackCleanup(next.connect()); await flushCleanup();
    assert.equal(arriving.state, 'pending'); assert.equal(f.physicals.length, 1);
    f.physicals[0]!.closeGate.resolve(); await old.promise; await arriving.promise;
    assert.equal(old.state, 'rejected'); assert.equal(arriving.state, 'resolved'); assert.equal(f.physicals.length, 2);
    assert.equal(f.server.hostState('a'), 'open'); assert.equal(next.status.state, 'open');
  } finally { await f.close(); }
});

test('synchronous close-provider reentry waits on the published physical barrier', async () => {
  let reentry: ReturnType<typeof trackCleanup> | undefined;
  const f = hostCleanupFixture({ onCreate(p, i) { if (!i) p.onClose = () => {
    reentry = trackCleanup(f.server.handle(f.connection, { type: 'host/connect', hostId: 'a', leaseId: 'close-reentry', requestId: 'reentry' }));
  }; } });
  try {
    const first = f.channel(); await first.connect(); await first.close(); await flushCleanup(); await reentry?.promise;
    assert.equal(reentry?.state, 'resolved'); assert.equal(f.physicals.length, 2); assert.equal(f.physicals[0]!.released, true);
  } finally { await f.close(); }
});

test('reset revokes a caller already waiting on physical close before any replacement factory starts', async () => {
  const f = hostCleanupFixture();
  try {
    const first = f.channel(); await first.connect(); const physical = f.physicals[0]!; physical.mode = 'hold';
    const closing = trackCleanup(first.close()); await flushCleanup();
    const obsolete = trackCleanup(f.channel().connect()); await flushCleanup();
    const resetting = trackCleanup(f.server.resetHost('a')); await flushCleanup();
    physical.closeGate.resolve(); await closing.promise; await resetting.promise; await obsolete.promise; await flushCleanup();
    assert.equal(obsolete.state, 'rejected'); assert.equal(f.physicals.length, 1, 'revoked startup cannot create an unowned transport');
    assert.equal(f.server.hostState('a'), 'closed');
  } finally { await f.close(); }
});

test('a post-reset arrival survives while the pre-reset close waiter is rejected', async () => {
  const f = hostCleanupFixture();
  try {
    const first = f.channel(); await first.connect(); f.physicals[0]!.mode = 'hold';
    const closing = trackCleanup(first.close()); await flushCleanup();
    const old = trackCleanup(f.channel().connect()); await flushCleanup();
    const resetting = trackCleanup(f.server.resetHost('a')); await flushCleanup();
    const fresh = f.channel(), current = trackCleanup(fresh.connect()); await flushCleanup();
    f.physicals[0]!.closeGate.resolve(); await closing.promise; await resetting.promise; await old.promise; await current.promise;
    assert.equal(old.state, 'rejected'); assert.equal(current.state, 'resolved'); assert.equal(f.physicals.length, 2);
    assert.equal(fresh.status.state, 'open'); assert.equal(f.server.hostState('a'), 'open');
  } finally { await f.close(); }
});
