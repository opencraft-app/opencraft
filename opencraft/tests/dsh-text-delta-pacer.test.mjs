import assert from "node:assert/strict";
import test from "node:test";

import {
  splitGraphemes,
  TextDeltaPacerController,
} from "../apps/local-agent-host/src/hypernode/text-delta-pacer.js";

const metadata = Object.freeze({ threadId: "thread-1", turnId: "turn-1", itemId: "item-1" });

function fixture(options = {}) {
  let now = 0;
  const emitted = [];
  const requestedTicks = [];
  const controller = new TextDeltaPacerController({
    now: () => now,
    requestTick: (delayMs) => requestedTicks.push(delayMs),
    emit: (item, delta) => emitted.push({ at: now, item, delta }),
    options,
  });
  return {
    controller,
    emitted,
    requestedTicks,
    setNow(value) { now = value; },
    tick(value) { now = value; controller.tick(value); },
  };
}

test("grapheme segmentation never tears surrogate, combining, flag, or ZWJ clusters", () => {
  assert.deepEqual(splitGraphemes("A😀e\u0301🇨🇳👨‍👩‍👧‍👦"), [
    "A", "😀", "e\u0301", "🇨🇳", "👨‍👩‍👧‍👦",
  ]);
});

test("a coarse provider chunk is spread across frames without exceeding 300ms", () => {
  const harness = fixture();
  const source = "文".repeat(468);
  harness.controller.enqueue(metadata, source, 0);
  for (let at = 0; at <= 320 && harness.controller.items.size > 0; at += 16) {
    harness.tick(at);
  }

  assert.equal(harness.emitted.map(({ delta }) => delta).join(""), source);
  assert.equal(harness.emitted[0].at, 0, "first visible text starts without a buffer wait");
  assert.ok(harness.emitted.length >= 10, "one provider chunk is presented over multiple frames");
  assert.ok(harness.emitted.at(-1).at <= 300, "presentation lag remains hard bounded");
  assert.ok(Math.max(...harness.emitted.map(({ delta }) => splitGraphemes(delta).length)) < 80);
  assert.ok(harness.controller.diagnostics().maximumObservedLagMs <= 300);
});

test("small live deltas stay close to the provider instead of targeting the hard window", () => {
  const harness = fixture();
  for (let frame = 0; frame < 12; frame += 1) {
    const at = frame * 16;
    harness.setNow(at);
    harness.controller.enqueue(metadata, "流式", at);
    harness.tick(at);
  }
  for (let at = 192; at <= 400 && harness.controller.items.size > 0; at += 16) {
    harness.tick(at);
  }

  assert.equal(harness.emitted.map(({ delta }) => delta).join(""), "流式".repeat(12));
  assert.ok(harness.controller.diagnostics().maximumObservedLagMs < 100);
});

test("periodic coarse provider bursts become a continuous 16ms reservoir", () => {
  const harness = fixture();
  const chunk = "虾".repeat(96);
  const arrivals = new Set([0, 288, 576, 864]);
  for (let at = 0; at <= 1_168; at += 16) {
    harness.setNow(at);
    if (arrivals.has(at)) harness.controller.enqueue(metadata, chunk, at);
    harness.tick(at);
  }

  assert.equal(harness.emitted.map(({ delta }) => delta).join(""), chunk.repeat(arrivals.size));
  const visibleFrames = harness.emitted.map(({ at }) => at);
  assert.ok(visibleFrames.length >= 48, "coarse bursts are spread over many animation frames");
  assert.ok(
    Math.max(...visibleFrames.slice(1).map((at, index) => at - visibleFrames[index])) <= 32,
    "cadence memory bridges provider burst boundaries without visible stalls",
  );
  const diagnostics = harness.controller.diagnostics();
  assert.ok(diagnostics.cadenceSamples >= 3);
  assert.ok(diagnostics.maximumObservedLagMs <= 300);
  assert.equal(diagnostics.recentItems.length, 1);
  assert.ok(diagnostics.recentItems[0].maximumGapMs <= 32);
});

test("a backend poll can ingest and present its first paced frame in one lock turn", () => {
  const harness = fixture();

  // AppServer's poll lifecycle first lets engine adapters ingest provider
  // events, then invokes the pacer before the WebSocket is drained. This
  // controller-level contract proves that no independent Tick is required for
  // the first visible frame after a coarse provider burst.
  harness.setNow(48);
  harness.controller.enqueue(metadata, "同锁周期".repeat(24), 48);
  harness.controller.tick(48);

  assert.equal(harness.emitted[0].at, 48);
  assert.ok(harness.emitted[0].delta.length > 0);
  assert.ok(harness.controller.items.size > 0, "remaining text stays paced across later frames");
});

test("rapid backend polls fill the reservoir without breaking the 16ms frame gate", () => {
  const harness = fixture();
  harness.setNow(100);
  harness.controller.enqueue(metadata, "首批".repeat(48), 100);
  harness.controller.tick(100);

  for (const at of [101, 102, 105, 109, 115]) {
    harness.setNow(at);
    harness.controller.enqueue(metadata, "续", at);
    harness.controller.tick(at);
  }

  assert.deepEqual(harness.emitted.map(({ at }) => at), [100]);
  harness.tick(116);
  assert.deepEqual(harness.emitted.map(({ at }) => at), [100, 116]);
  assert.equal(harness.controller.diagnostics().earlyTicksSuppressed, 5);
});

test("a completion barrier accelerates the tail without collapsing it into one frame", () => {
  const harness = fixture();
  const source = "尾".repeat(160);
  const order = [];
  harness.controller.emit = (_item, delta) => {
    harness.emitted.push({ at: harness.controller.now(), item: metadata, delta });
    order.push(`delta:${delta}`);
  };
  harness.controller.enqueue(metadata, source, 0);
  harness.controller.afterDrained(metadata, () => order.push("completed"));
  for (let at = 0; at <= 320 && harness.controller.items.size > 0; at += 16) harness.tick(at);

  assert.equal(order.at(-1), "completed");
  assert.equal(harness.emitted.map(({ delta }) => delta).join(""), source);
  assert.ok(harness.emitted.length >= 6, "the final burst remains visibly paced");
  assert.ok(harness.emitted.at(-1).at <= 176, "completion does not hold a finished answer for 300ms");
});

test("completion is an ordered barrier behind every paced delta", () => {
  const harness = fixture();
  const order = [];
  harness.controller.emit = (_item, delta) => order.push(`delta:${delta}`);
  harness.controller.enqueue(metadata, "complete me smoothly", 0);
  assert.equal(harness.controller.afterDrained(metadata, () => order.push("completed")), true);
  assert.deepEqual(order, []);

  for (let at = 0; at <= 320 && harness.controller.items.size > 0; at += 16) {
    harness.tick(at);
  }
  assert.equal(order.at(-1), "completed");
  assert.equal(
    order.slice(0, -1).map((entry) => entry.slice("delta:".length)).join(""),
    "complete me smoothly",
  );
});

test("failure flush emits pending text before crossing the completion barrier", () => {
  const harness = fixture();
  const order = [];
  harness.controller.emit = (_item, delta) => order.push(`delta:${delta}`);
  harness.controller.enqueue(metadata, "partial", 0);
  harness.controller.afterDrained(metadata, () => order.push("failed"));
  assert.equal(harness.controller.flush(metadata), true);
  assert.deepEqual(order, ["delta:partial", "failed"]);
  assert.equal(harness.controller.items.size, 0);
});

test("interleaved items keep independent rate, deadline, and completion state", () => {
  const harness = fixture();
  const second = { threadId: "thread-2", turnId: "turn-2", itemId: "item-2" };
  const completed = [];
  harness.controller.enqueue(metadata, "甲".repeat(120), 0);
  harness.controller.enqueue(second, "乙".repeat(37), 8);
  harness.controller.afterDrained(metadata, () => completed.push("first"));
  harness.controller.afterDrained(second, () => completed.push("second"));

  for (let at = 0; at <= 320 && harness.controller.items.size > 0; at += 16) {
    harness.tick(at);
  }

  const textFor = (itemId) => harness.emitted
    .filter(({ item }) => item.itemId === itemId)
    .map(({ delta }) => delta)
    .join("");
  assert.equal(textFor(metadata.itemId), "甲".repeat(120));
  assert.equal(textFor(second.itemId), "乙".repeat(37));
  assert.deepEqual(new Set(completed), new Set(["first", "second"]));
  assert.equal(harness.controller.items.size, 0);
  assert.ok(harness.controller.diagnostics().maximumObservedLagMs <= 300);
});
