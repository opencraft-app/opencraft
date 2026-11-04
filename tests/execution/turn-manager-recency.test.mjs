import test from "node:test";
import assert from "node:assert/strict";
import { createImplementation } from "../../apps/local-agent-host/src/hypernode/turn-manager.js";

class Service { constructor(ctx) { this.ctx = ctx; } }

function fixture(nowMs = 1_735_689_600_123) {
  const thread = { id: "thread-1", turns: [] };
  let persisted = 0;
  const manager = {
    touch: () => thread,
    find: () => thread,
    get: () => thread,
    persistThread: () => { persisted += 1; },
  };
  const TurnManager = createImplementation(Service, (() => { let n = 0; return () => `item-${++n}`; })(), { now: () => nowMs });
  const service = new TurnManager({ principal: { current: () => ({ id: "user-1" }) }, threadManager: manager });
  return { thread, service, persisted: () => persisted, expected: Math.floor(nowMs / 1_000) };
}

test("updates activity timestamps when a user turn starts", () => {
  const f = fixture();
  f.service.start("thread-1", [{ type: "text", text: "hello" }]);
  assert.equal(f.thread.updatedAt, f.expected);
  assert.equal(f.thread.recencyAt, f.expected);
  assert.equal(f.thread.status.type, "active");
  assert.equal(f.persisted(), 1);
});

test("updates activity timestamps when an agent turn starts", () => {
  const f = fixture();
  f.service.startAgent("thread-1");
  assert.equal(f.thread.updatedAt, f.expected);
  assert.equal(f.thread.recencyAt, f.expected);
  assert.equal(f.thread.status.type, "active");
  assert.equal(f.persisted(), 1);
});
