import assert from "node:assert/strict";
import test from "node:test";

import {
  presentationKeyFor,
  PresentationDrainBarrierRegistry,
  WebSocketPresentationQueue,
} from "../src/services/websocket-presentation-queue.ts";

test("queued presentation frames cross the transport boundary without per-socket pacing", () => {
  const queue = new WebSocketPresentationQueue();
  queue.push(Uint8Array.of(1), "item-1");
  queue.push(Uint8Array.of(2), "item-1");
  queue.push(Uint8Array.of(3), "item-1");

  assert.deepEqual(queue.drain().map((chunk) => [...chunk]), [[1], [2], [3]]);
  assert.equal(queue.length, 0);
});

test("ordinary RPC frames are not delayed while presentation order is preserved", () => {
  const queue = new WebSocketPresentationQueue();
  queue.push(Uint8Array.of(1));
  queue.push(Uint8Array.of(2), "item-1");
  queue.push(Uint8Array.of(3));

  assert.deepEqual(queue.drain().map((chunk) => [...chunk]), [[1], [2], [3]]);
  queue.push(Uint8Array.of(4));
  assert.deepEqual(queue.drain().map((chunk) => [...chunk]), [[4]]);
});

test("independent subscribers drain the same presentation burst identically", () => {
  const first = new WebSocketPresentationQueue();
  const second = new WebSocketPresentationQueue();
  for (let value = 1; value <= 64; value += 1) {
    first.push(Uint8Array.of(value), "item-1");
    second.push(Uint8Array.of(value), "item-1");
  }

  assert.deepEqual(first.drain(), second.drain());
  assert.equal(first.length, 0);
  assert.equal(second.length, 0);
});

test("presentation completion waits for every keyed frame to cross the queue", () => {
  let now = 100;
  const order = [];
  const key = presentationKeyFor({ threadId: "thread", turnId: "turn", itemId: "item" });
  const queue = new WebSocketPresentationQueue({
    onPresentationDrained: () => order.push("wire"),
  });
  const barriers = new PresentationDrainBarrierRegistry({
    sockets: () => [{ hasPendingPresentation: (candidate) => queue.hasPendingPresentation(candidate) }],
    now: () => now,
  });
  queue.push(Uint8Array.of(1), key);
  queue.push(Uint8Array.of(2), key);

  assert.equal(barriers.afterDrained(
    { threadId: "thread", turnId: "turn", itemId: "item" },
    () => order.push("completed"),
  ), true);
  assert.deepEqual(queue.drain().map((chunk) => [...chunk]), [[1], [2]]);
  assert.deepEqual(order, ["wire"], "drain callback itself must not run completion work");
  assert.equal(barriers.flush(), 1);
  assert.deepEqual(order, ["wire", "completed"]);
});

test("presentation completion has a bounded deadline for an abandoned client", () => {
  let now = 0;
  const completed = [];
  const barriers = new PresentationDrainBarrierRegistry({
    sockets: () => [{ hasPendingPresentation: () => true }],
    now: () => now,
    timeoutMs: 300,
  });
  assert.equal(barriers.afterDrained(
    { threadId: "thread", turnId: "turn", itemId: "item" },
    () => completed.push(now),
  ), true);
  now = 299;
  assert.equal(barriers.flush(), 0);
  now = 300;
  assert.equal(barriers.flush(), 1);
  assert.deepEqual(completed, [300]);
});
