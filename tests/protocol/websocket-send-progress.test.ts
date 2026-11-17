import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketSendProgress } from "../../packages/appserver-transport-websocket/src/send-progress";

class Socket {
  readyState = 1;
  bufferedAmount = 0;
  send(frame: string) { this.bufferedAmount += new TextEncoder().encode(frame).length; }
}

test("one physical FIFO attributes drain to its own frame, excluding concurrent and unobserved traffic", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new Socket(), owner = new WebSocketSendProgress(socket);
  const first: number[] = [], second: number[] = [];
  owner.send("chat");
  owner.send("文".repeat(4), undefined, { onProgress: p => { assert.equal(p.total, 12); first.push(p.loaded); } });
  owner.send("control");
  owner.send("abcde", undefined, { onProgress: p => second.push(p.loaded) });
  assert.deepEqual(first, [0]); assert.deepEqual(second, [0]);
  socket.bufferedAmount -= 10; t.mock.timers.tick(50);
  assert.deepEqual(first, [0, 6]); assert.deepEqual(second, [0]);
  socket.bufferedAmount -= 6; t.mock.timers.tick(50);
  assert.deepEqual(first, [0, 6, 12]); assert.deepEqual(second, [0]);
  socket.bufferedAmount -= 9; t.mock.timers.tick(50);
  assert.deepEqual(second, [0, 2]);
  socket.bufferedAmount = 0; t.mock.timers.tick(50);
  assert.deepEqual(second, [0, 2, 5]);
  owner.dispose();
});

test("cancellation, close, observers throwing and synchronous reentry cannot corrupt sibling sends", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new Socket(), owner = new WebSocketSendProgress(socket);
  const cancelled = new AbortController(), old: number[] = [], next: number[] = [];
  owner.send("first", undefined, { signal: cancelled.signal, onProgress: p => old.push(p.loaded) });
  cancelled.abort();
  owner.send("second", undefined, { onProgress: p => { if (p.loaded === 0) throw new Error("observer"); next.push(p.loaded); } });
  socket.bufferedAmount = 0; t.mock.timers.tick(50);
  assert.deepEqual(old, [0]); assert.deepEqual(next, [6]);
  owner.send("third", undefined, { onProgress: p => { if (p.loaded === 5) owner.send("fourth", undefined, { onProgress: q => next.push(q.loaded) }); } });
  socket.bufferedAmount = 0; t.mock.timers.tick(50);
  assert.deepEqual(next, [6, 0]);
  owner.dispose(); socket.bufferedAmount = 0; t.mock.timers.tick(500);
  assert.deepEqual(next, [6, 0]);
  assert.throws(() => owner.send("late"), /closed/);
});

test("opaque native bridges do not fabricate sent bytes", () => {
  const frames: string[] = [];
  const owner = new WebSocketSendProgress({ readyState: 1, send: f => frames.push(f) });
  owner.send("opaque", undefined, { onProgress: () => assert.fail("No native byte counter") });
  assert.deepEqual(frames, ["opaque"]); owner.dispose();
});
