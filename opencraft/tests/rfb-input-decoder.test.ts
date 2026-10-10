import assert from "node:assert/strict";
import test from "node:test";
import { RfbInputDecoder } from "../apps/local-agent-host/src/desktop/rfb-input-decoder.js";
import type { NativeControlLease } from "../apps/local-agent-host/src/desktop/native-control.js";

function fixture() {
  const calls: unknown[] = [];
  let current: NativeControlLease | undefined;
  const lease = (): NativeControlLease => ({ isValid: () => true, subscribeRevoked: () => () => {},
    release() {}, key: (symbol, down) => calls.push([symbol, down]), pointer: (x, y, mask) => calls.push([x, y, mask]) });
  const decoder = new RfbInputDecoder(() => current);
  for (const byte of Buffer.from("RFB 003.008\n\x01\x01")) decoder.push(Buffer.from([byte]));
  return { decoder, calls, lease, set(value?: NativeControlLease) { current = value; } };
}
const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 97]);
test("RFB input requires the same confirmed grant at first byte and completion", () => {
  const f = fixture(); f.decoder.push(key); assert.deepEqual(f.calls, []);
  f.decoder.push(key.subarray(0, 1)); f.set(f.lease()); f.decoder.push(key.subarray(1)); assert.deepEqual(f.calls, []);
  f.decoder.push(key.subarray(0, 3)); f.set(f.lease()); f.decoder.push(key.subarray(3)); assert.deepEqual(f.calls, []);
  f.decoder.push(key); assert.deepEqual(f.calls, [[97, true]]);
  f.decoder.push(key.subarray(0, 2)); f.set(); f.decoder.push(key.subarray(2)); assert.equal(f.calls.length, 1);
});
test("RFB handles fragmented negotiation, multiple messages, extended keys and does not execute clipboard", () => {
  const f = fixture(); f.set(f.lease());
  const encoding = Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]);
  const clipboard = Buffer.from([6, 0, 0, 0, 0, 0, 0, 1, 97]);
  const extended = Buffer.from([255, 0, 0, 1, 0, 0, 0, 98, 0, 0, 0, 48]);
  const messages = Buffer.concat([encoding, clipboard, key, Buffer.from([5, 1, 0, 50, 0, 60]), extended]);
  for (const byte of messages) f.decoder.push(Buffer.from([byte]));
  assert.deepEqual(f.calls, [[97, true], [50, 60, 1], [98, true]]);
});
test("RFB malformed/unsupported/oversized client messages fail closed", () => {
  assert.throws(() => fixture().decoder.push(Buffer.from([42])));
  assert.throws(() => fixture().decoder.push(Buffer.from([4, 2])));
  assert.throws(() => fixture().decoder.push(Buffer.from([255, 1])));
  assert.throws(() => fixture().decoder.push(Buffer.from([6, 0, 0, 0, 127, 255, 255, 255])));
  assert.throws(() => new RfbInputDecoder(() => undefined).push(Buffer.from("RFB 003.003\n")));
});
