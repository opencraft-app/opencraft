import assert from 'node:assert/strict';
import test from 'node:test';
import { containsSocketError, flushSockets, socketDisposalFixture, socketTrack, type SocketMode } from './fixtures/socket-disposal';

for (const mode of ['throw-before', 'throw-after'] as SocketMode[]) test(`explicit close retains ${mode} raw Socket and retries it after recovery`, async () => {
  const f = socketDisposalFixture();
  try {
    await f.connect(); const socket = f.sockets[0]!; socket.mode = mode;
    assert.throws(() => f.factory.close(), e => containsSocketError(e, socket.closeError));
    for (const transport of f.transports.values()) await assert.rejects(transport.send('{}'));
    assert.equal(socket.closeCalls, 1); assert.equal(socket.closeAccepted, false);
    socket.mode = 'ok'; f.factory.close(); assert.equal(socket.closeCalls, 2); assert.equal(socket.closeAccepted, true);
    f.factory.close(); assert.equal(socket.closeCalls, 2); assert.equal(f.eventCalls, 1);
  } finally { await f.repair(); }
});
for (const mode of ['throw-before', 'throw-after'] as SocketMode[]) test(`renewal fences allocation behind ${mode} cleanup on the original raw Socket`, async () => {
  const f = socketDisposalFixture();
  try {
    await f.connect(); const socket = f.sockets[0]!; socket.mode = mode;
    try { socket.emit('error'); } catch (e) { assert.ok(containsSocketError(e, socket.closeError)); }
    await assert.rejects(f.transport('a').connect(), e => containsSocketError(e, socket.closeError));
    assert.equal(f.sockets.length, 1); assert.equal(socket.closeAccepted, false);
    socket.mode = 'ok'; await f.connect(); assert.equal(f.sockets.length, 2); assert.equal(socket.closeAccepted, true);
    assert.equal(socket.closeCalls, 3); assert.equal(f.transport('a').status.state, 'open');
  } finally { await f.repair(); }
});
test('an accepted close allows renewal before a held TCP close event', async () => {
  const f = socketDisposalFixture();
  try {
    await f.connect(); const first = f.sockets[0]!; first.mode = 'accept-held'; first.emit('error');
    assert.equal(first.closeAccepted, true); assert.equal(first.resourceLive, true);
    await f.connect(); assert.equal(f.sockets.length, 2); assert.equal(first.closeCalls, 1);
    first.lateFrames(); first.finishClose(); await flushSockets(); assert.equal(f.deliveries.length, 0);
    assert.equal(f.transport('a').status.state, 'open');
  } finally { await f.repair(); }
});
test('event unsubscribe failure cannot skip local retirement, raw close or retain write authority', async () => {
  const f = socketDisposalFixture();
  try {
    await f.connect('a'); await f.connect('b'); f.eventFault(true);
    assert.throws(() => f.factory.close(), e => containsSocketError(e, f.eventError));
    const sends = f.sockets[0]!.sent.length, delivered = f.deliveries.length;
    for (const transport of f.transports.values()) await assert.rejects(transport.send('{}'));
    f.sockets[0]!.lateFrames(); await flushSockets();
    assert.equal(f.sockets[0]!.closeCalls, 1); assert.equal(f.deliveries.length, delivered); assert.equal(f.sockets[0]!.sent.length, sends);
    f.eventFault(false); f.factory.close(); assert.equal(f.eventCalls, 2); assert.equal(f.sockets[0]!.closeCalls, 1);
    f.factory.close(); assert.equal(f.eventCalls, 2);
  } finally { await f.repair(); }
});
for (const path of ['shutdown', 'loss', 'renewal'] as const) test(`synchronous factory.close during ${path} raw disposal cannot forget an unresolved owner`, async () => {
  const f = socketDisposalFixture();
  try {
    await f.connect(); const socket = f.sockets[0]!; socket.mode = 'throw-before';
    if (path === 'renewal') { try { socket.emit('error'); } catch {} }
    socket.onClose = () => f.factory.close();
    if (path === 'shutdown') assert.throws(() => f.factory.close(), e => containsSocketError(e, socket.closeError));
    else if (path === 'loss') { try { socket.emit('error'); } catch (e) { assert.ok(containsSocketError(e, socket.closeError)); } }
    else await assert.rejects(f.transport('a').connect());
    socket.mode = 'ok'; const before = socket.closeCalls; f.factory.close(); assert.equal(socket.closeCalls, before + 1);
    assert.equal(socket.closeAccepted, true); assert.equal(f.sockets.length, 1);
  } finally { await f.repair(); }
});
test('renewal rechecks factory disposal after a successful reentrant raw close', async () => {
  const f = socketDisposalFixture();
  try {
    await f.connect(); const first = f.sockets[0]!; first.mode = 'throw-before'; try { first.emit('error'); } catch {}
    first.mode = 'ok'; first.onClose = () => f.factory.close();
    const attempt = socketTrack(f.transport('a').connect()); await flushSockets(); await attempt.promise;
    assert.equal(attempt.state, 'rejected'); assert.equal(f.sockets.length, 1); assert.equal(first.closeAccepted, true);
  } finally { await f.repair(); }
});
test('both failed disposers are attempted, reported and retried once on their own handles', async () => {
  const f = socketDisposalFixture();
  try {
    await f.connect(); const socket = f.sockets[0]!; socket.mode = 'throw-before'; f.eventFault(true);
    assert.throws(() => f.factory.close(), e => containsSocketError(e, socket.closeError) && containsSocketError(e, f.eventError));
    assert.equal(socket.closeCalls, 1); assert.equal(f.eventCalls, 1);
    socket.mode = 'ok'; f.eventFault(false); f.onEventUnsubscribe(() => f.factory.close()); f.factory.close();
    assert.equal(socket.closeCalls, 2); assert.equal(f.eventCalls, 2); f.factory.close(); assert.equal(f.eventCalls, 2);
  } finally { await f.repair(); }
});
