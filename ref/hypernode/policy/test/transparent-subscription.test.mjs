import assert from "node:assert/strict";
import test from "node:test";

import { TransparentSubscriptionService } from "../src/services/transparent-subscription.ts";

function createHarness() {
  const service = Object.assign(Object.create(TransparentSubscriptionService.prototype), {
    threadSubscribers: new Map(),
    catalogBroadcasts: new Map(),
  });
  const first = { connectionId: "first" };
  const second = { connectionId: "second" };
  const fallback = { connectionId: "fallback" };
  return { service, first, second, fallback };
}

test("thread subscriptions survive backend replacement and scope fanout", () => {
  const { service, first, second, fallback } = createHarness();
  service.subscribe(first, "thread-1");
  service.subscribe(second, "thread-1");

  assert.deepEqual(
    service.targets({ connections: new Set([first, fallback]) }, "thread-1"),
    [first, second],
  );
  assert.deepEqual(
    service.targets({ connections: new Set([fallback]) }, "thread-2"),
    [fallback],
  );
});

test("removing a frontend returns every affected thread exactly once", () => {
  const { service, first, second } = createHarness();
  service.subscribe(first, "thread-1");
  service.subscribe(first, "thread-2");
  service.subscribe(second, "thread-2");

  assert.deepEqual(service.removeConnection(first), ["thread-1", "thread-2"]);
  assert.equal(service.hasSubscribers("thread-1"), false);
  assert.equal(service.hasSubscribers("thread-2"), true);
  assert.deepEqual([...service.threadSubscribers.get("thread-2")], [second]);
});

test("catalog notification deduplication is bounded by method and thread", () => {
  const { service } = createHarness();
  assert.equal(service.admitCatalogBroadcast("thread/archived", "thread-1", 10_000), true);
  assert.equal(service.admitCatalogBroadcast("thread/archived", "thread-1", 11_999), false);
  assert.equal(service.admitCatalogBroadcast("thread/unarchived", "thread-1", 11_999), true);
  assert.equal(service.admitCatalogBroadcast("thread/archived", "thread-1", 12_000), true);
});
