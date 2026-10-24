import test from 'node:test';
import assert from 'node:assert/strict';
import { bindWebSocketInput } from '../../packages/remote-interaction/src/websocket';
import { bindWebRTCInput } from '../../packages/remote-interaction/src/webrtc';
const identity = { resourceId: 'existing-page', incarnation: 'native-incarnation', connectionEpoch: 'connection-1' };

for (const kind of ['websocket', 'webrtc'] as const) {
  test(kind + ' uses the same bounded, non-replaying input contract', () => {
    let sent: string[] = [], closed = 0, fail = false;
    const wire = { readyState: kind === 'websocket' ? 1 : 'open', bufferedAmount: 0, ordered: true,
      maxRetransmits: null, maxPacketLifeTime: null,
      send(value: string) { if (fail) throw Error('unknown write'); sent.push(value); }, close() { closed++; } };
    const transport = kind === 'websocket' ? bindWebSocketInput(identity, wire as any) : bindWebRTCInput(identity, wire as any);
    assert.equal(transport.sendInput('one'), 'sent'); assert.deepEqual(sent, ['one']);
    wire.bufferedAmount = 65536; assert.equal(transport.sendInput('two'), 'blocked');
    wire.bufferedAmount = 0; assert.equal(transport.sendInput('中'.repeat(22000)), 'oversize');
    assert.deepEqual(sent, ['one'], 'blocked writes are never queued or replayed');
    fail = true; assert.equal(transport.sendInput('three'), 'unknown'); assert.equal(closed, 1);
    assert.equal(transport.sendInput('must-not-replay'), 'closed', 'a write exception retires the adapter even before native close completes');
    wire.readyState = kind === 'websocket' ? 3 : 'closed';
    assert.equal(transport.sendInput('four'), 'closed'); assert(Object.isFrozen(transport.attachment));
  });
}
test('RTC rejects unordered and partially reliable input channels', () => {
  const base = { readyState: 'open', bufferedAmount: 0, ordered: true, maxRetransmits: null,
    maxPacketLifeTime: null, send() {}, close() {} };
  for (const change of [{ordered:false},{maxRetransmits:0},{maxPacketLifeTime:500}])
    assert.throws(() => bindWebRTCInput(identity, {...base,...change}), /reliable ordered/);
});
