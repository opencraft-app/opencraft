import assert from "node:assert/strict";
import { test } from "node:test";
import { HeartbeatDemand } from "./heartbeat-demand.mjs";

test("each visited slot has exactly one dispatch or skip outcome", () => {
	const meter = new HeartbeatDemand(10, 1000, 100, 0);
	meter.tick(100);
	assert.equal(meter.visit(false, true, true), false);
	assert.equal(meter.visit(true, true, true), false);
	assert.equal(meter.visit(true, false, true), false);
	assert.equal(meter.visit(true, false, false), true);
	const result = meter.snapshot(400);
	assert.equal(result.idealTimerSlots, 4);
	assert.equal(result.visitedSlots, 4);
	assert.equal(result.dispatched, 1);
	assert.equal(result.skippedNotReady, 1);
	assert.equal(result.skippedInFlight, 1);
	assert.equal(result.skippedStopping, 1);
	assert.equal(result.timerSlotDeficit, 0);
});

test("a delayed timer cannot hide missing nominal work behind zero failures", () => {
	const meter = new HeartbeatDemand(10000, 10000, 100, 0);
	meter.tick(1000);
	for (let i = 0; i < 100; i++) meter.visit(true, false, false);
	const result = meter.snapshot(1000);
	assert.equal(result.nominalTargetPerSecond, 1000);
	assert.equal(result.timerSlotTargetPerSecond, 1000);
	assert.equal(result.idealTimerSlots, 1000);
	assert.equal(result.visitedSlots, 100);
	assert.equal(result.dispatched, 100);
	assert.equal(result.timerSlotDeficit, 900);
	assert.equal(result.maxTickGapMs, 1000);
});

test("a busy object preserves the original no-overlap policy while exposing suppressed work", () => {
	const meter = new HeartbeatDemand(1, 100, 100, 0);
	meter.tick(100);
	assert.equal(meter.visit(true, false, false), true);
	meter.tick(200);
	assert.equal(meter.visit(true, true, false), false);
	const result = meter.snapshot(200);
	assert.equal(result.timerSlotDeficit, 0);
	assert.equal(result.dispatched, 1);
	assert.equal(result.skippedInFlight, 1);
});

test("target transition integrates both phases and shutdown drain stops the demand clock", () => {
	const meter = new HeartbeatDemand(8, 50, 10, 0);
	meter.setTarget(5, 100);
	const result = meter.snapshot(200);
	assert.equal(result.idealTimerSlots, 30);
	assert.equal(result.nominalTargetPerSecond, 100);
	assert.equal(result.timerSlotTargetPerSecond, 100);
	meter.stop(200);
	assert.deepEqual(meter.snapshot(2000), result);
	meter.stop(3000);
	assert.deepEqual(meter.snapshot(4000), result);
});

test("discrete timer rounding is reported separately from nominal object frequency", () => {
	const meter = new HeartbeatDemand(8, 50, 10, 0);
	assert.equal(meter.snapshot(100).nominalTargetPerSecond, 160);
	assert.equal(meter.snapshot(100).timerSlotTargetPerSecond, 200);
	assert.equal(meter.snapshot(100).idealTimerSlots, 20);
});
