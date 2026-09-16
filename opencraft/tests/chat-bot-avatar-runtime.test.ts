import assert from "node:assert/strict";
import test from "node:test";

import {
  BotAvatarScheduler,
  botAvatarActivityLevel,
  botAvatarRateHz,
  type BotAvatarSchedulerHost,
} from "../plugins/bot-chat/src/bot-avatar-runtime";
import { BotAvatarClock } from "../plugins/bot-chat/src/bot-avatar-clock";
import {
  createBotAvatarMotionModel,
  stepBotAvatarSprings,
} from "../plugins/bot-chat/src/bot-avatar-springs";
import { BotAvatarEffectController } from "../plugins/bot-chat/src/bot-avatar-morph";
import {
  BOT_AVATAR_RING_SAMPLES,
  botAvatarShapeRing,
  botAvatarSpanAtY,
  fitBotAvatarEyeCenter,
  interpolateBotAvatarRings,
} from "../plugins/bot-chat/src/bot-avatar-geometry";
import { BOT_AVATAR_SHAPE_NAMES } from "../plugins/bot-chat/src/bot-avatar-shapes";
import { BotAvatarBehaviorController } from "../plugins/bot-chat/src/bot-avatar-behavior";
import { createBotAvatarMaterial } from "../plugins/bot-chat/src/bot-avatar-material";
import { BOT_AVATAR_MOTION } from "../plugins/bot-chat/src/bot-avatar-motion";

class ManualFrameHost implements BotAvatarSchedulerHost {
  now = 0;
  frameRequests = 0;
  timerRequests = 0;
  private frameId = 0;
  private timerId = 0;
  private readonly frames = new Map<number, (time: number) => void>();
  private readonly timers = new Map<number, () => void>();

  requestFrame = (callback: (time: number) => void): number => {
    this.frameRequests += 1;
    const id = ++this.frameId;
    this.frames.set(id, callback);
    return id;
  };

  cancelFrame = (id: number): void => {
    this.frames.delete(id);
  };

  setTimer = (callback: () => void): number => {
    this.timerRequests += 1;
    const id = ++this.timerId;
    this.timers.set(id, callback);
    return id;
  };

  clearTimer = (id: number): void => {
    this.timers.delete(id);
  };

  flushFrame(time: number): void {
    this.now = time;
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    for (const callback of callbacks) callback(time);
  }

  flushTimer(): void {
    const callbacks = [...this.timers.values()];
    this.timers.clear();
    for (const callback of callbacks) callback();
  }
}

test("one Stage scheduler owns the frame request for every live Bot source", () => {
  const host = new ManualFrameHost();
  const scheduler = new BotAvatarScheduler(host);
  const delivered: string[] = [];

  scheduler.subscribe(() => delivered.push("a"), 60);
  scheduler.subscribe(() => delivered.push("b"), 60);

  assert.equal(host.frameRequests, 1);
  host.flushFrame(17);
  assert.deepEqual(delivered, ["a", "b"]);
  assert.equal(host.frameRequests, 2);
  scheduler.dispose();
});

test("a parked avatar clock resumes without advancing through hidden time", () => {
  const clock = new BotAvatarClock(100);

  assert.deepEqual(clock.advance(116), { now: 16, delta: 0.016 });
  clock.park(120);
  assert.deepEqual(clock.advance(5_000), { now: 20, delta: 0 });
  clock.unpark(5_000);
  assert.deepEqual(clock.advance(5_016), { now: 36, delta: 0.016 });
});

test("ambient Bots share a low-frequency timer and hidden Bots schedule nothing", () => {
  const host = new ManualFrameHost();
  const scheduler = new BotAvatarScheduler(host);
  const delivered: string[] = [];

  scheduler.subscribe(() => delivered.push("ambient-a"), 8);
  scheduler.subscribe(() => delivered.push("ambient-b"), 8);
  scheduler.subscribe(() => delivered.push("hidden"), 0);
  assert.equal(host.frameRequests, 0);
  assert.equal(host.timerRequests, 1);

  host.flushTimer();
  assert.equal(host.frameRequests, 1);
  host.flushFrame(125);
  assert.deepEqual(delivered, ["ambient-a", "ambient-b"]);
  scheduler.dispose();
});

test("spring targets change without resetting the current visual frame", () => {
  const model = createBotAvatarMotionModel();
  model.x.target = 10;
  stepBotAvatarSprings(model, { stiffness: 168, damping: 24 }, 1 / 60);
  const beforeRetarget = model.x.value;

  model.x.target = -10;
  stepBotAvatarSprings(model, { stiffness: 168, damping: 24 }, 1 / 60);

  assert.ok(beforeRetarget > 0 && beforeRetarget < 10);
  assert.ok(model.x.value > -10);
  assert.notEqual(model.x.value, model.x.target);
});

test("effects have an explicit reset enter hold exit done lifecycle", () => {
  const effects = new BotAvatarEffectController({
    enterDurationMs: 180,
    exitDurationMs: 140,
  });

  effects.transitionTo("dots", 0);
  assert.deepEqual(effects.sample(0), {
    effect: "dots",
    phase: "reset",
    progress: 0,
  });
  assert.equal(effects.sample(90).phase, "enter");
  assert.deepEqual(effects.sample(180), {
    effect: "dots",
    phase: "hold",
    progress: 1,
  });

  effects.transitionTo("none", 200);
  assert.equal(effects.sample(270).phase, "exit");
  assert.deepEqual(effects.sample(340), {
    effect: "none",
    phase: "done",
    progress: 0,
  });
});

test("all fourteen effects exit cleanly and direct switches preserve outgoing geometry", () => {
  const effectNames = new Set(
    Object.values(BOT_AVATAR_MOTION)
      .map((preset) => preset.effect)
      .filter((effect) => effect !== "none"),
  );
  assert.equal(effectNames.size, 14);
  for (const effect of effectNames) {
    const controller = new BotAvatarEffectController();
    controller.transitionTo(effect, 0);
    assert.equal(controller.sample(180).phase, "hold", effect);
    controller.transitionTo("none", 200);
    assert.equal(controller.sample(340).phase, "done", effect);
  }

  const controller = new BotAvatarEffectController();
  controller.transitionTo("dots", 0);
  controller.sample(180);
  controller.transitionTo("orbit", 200);
  assert.deepEqual(controller.sample(270), {
    effect: "dots",
    phase: "exit",
    progress: 0.125,
  });
  assert.deepEqual(controller.sample(340), {
    effect: "orbit",
    phase: "reset",
    progress: 0,
  });
});

test("an effect completes once even while its semantic state remains active", () => {
  const controller = new BotAvatarEffectController({
    enterDurationMs: 180,
    holdDurationMs: 900,
    exitDurationMs: 140,
  });
  controller.transitionTo("progress", 0);
  assert.equal(controller.sample(180).phase, "hold");
  assert.deepEqual(controller.sample(1_080), {
    effect: "progress",
    phase: "exit",
    progress: 1,
  });
  assert.deepEqual(controller.sample(1_220), {
    effect: "none",
    phase: "done",
    progress: 0,
  });
});

test("every original OpenCraft shape uses one interpolable ring topology", () => {
  for (const shape of BOT_AVATAR_SHAPE_NAMES) {
    const ring = botAvatarShapeRing(shape);
    assert.equal(ring.length, BOT_AVATAR_RING_SAMPLES, shape);
    assert.equal(
      ring.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)),
      true,
      shape,
    );
  }

  const blob = botAvatarShapeRing("blob");
  const shield = botAvatarShapeRing("shield");
  const halfway = interpolateBotAvatarRings(blob, shield, 0.5);
  assert.equal(halfway.length, BOT_AVATAR_RING_SAMPLES);
  assert.equal(halfway[0]?.[0], (blob[0]![0] + shield[0]![0]) / 2);
});

test("shape-aware eye fitting keeps the complete eye inside every outline", () => {
  for (const shape of BOT_AVATAR_SHAPE_NAMES) {
    const ring = botAvatarShapeRing(shape);
    const centerY = 19;
    const centerX = fitBotAvatarEyeCenter(ring, 40, centerY, 5, 1.2, 7);
    const [left, right] = botAvatarSpanAtY(ring, centerY);
    assert.ok(centerX - 2.5 >= left + 1.2 - 0.01, shape);
    assert.ok(centerX + 2.5 <= right - 1.2 + 0.01, shape);
  }
});

test("behavior scheduling is deterministic and state entry preserves spring values", () => {
  const firstModel = createBotAvatarMotionModel();
  const secondModel = createBotAvatarMotionModel();
  const first = new BotAvatarBehaviorController(
    "bot:nova",
    "idle",
    0,
    firstModel,
  );
  const second = new BotAvatarBehaviorController(
    "bot:nova",
    "idle",
    0,
    secondModel,
  );

  first.update(2_000, firstModel);
  second.update(2_000, secondModel);
  assert.equal(firstModel.x.target, secondModel.x.target);
  assert.equal(firstModel.rotation.target, secondModel.rotation.target);

  firstModel.x.value = 4.25;
  const transition = first.setState("thinking", 2_100, firstModel);
  assert.equal(transition.entered, true);
  assert.equal(firstModel.x.value, 4.25);
  assert.equal(firstModel.eyeScale.target, 0.82);
});

test("multi-Bot scheduling gives work, attention, ambience, and visibility distinct rates", () => {
  assert.equal(
    botAvatarActivityLevel({ visible: true, working: true, targeted: false }),
    "active",
  );
  assert.equal(
    botAvatarActivityLevel({ visible: true, working: false, targeted: true }),
    "attentive",
  );
  assert.equal(
    botAvatarActivityLevel({ visible: true, working: false, targeted: false }),
    "ambient",
  );
  assert.equal(
    botAvatarActivityLevel({ visible: false, working: true, targeted: true }),
    "hidden",
  );
  assert.equal(botAvatarRateHz("active", false), 60);
  assert.equal(botAvatarRateHz("attentive", false), 30);
  assert.equal(botAvatarRateHz("ambient", false), 8);
  assert.equal(botAvatarRateHz("active", true), 0);
});

test("an idle Bot that receives attention wakes before settling into listening", () => {
  const model = createBotAvatarMotionModel();
  const behavior = new BotAvatarBehaviorController(
    "bot:muse",
    "idle",
    0,
    model,
  );

  behavior.setState("listening", 100, model);
  assert.equal(behavior.snapshotState(), "waking");
  behavior.update(749, model);
  assert.equal(behavior.snapshotState(), "waking");
  behavior.update(750, model);
  assert.equal(behavior.snapshotState(), "listening");
});

test("notification and celebration poses are one-shot presentation actions", () => {
  const model = createBotAvatarMotionModel();
  const behavior = new BotAvatarBehaviorController("bot:vela", "idle", 0, model);

  behavior.setState("notifying", 100, model);
  assert.equal(behavior.snapshotState(), "notifying");
  behavior.update(800, model);
  assert.equal(behavior.snapshotState(), "idle");

  behavior.setState("celebrate", 900, model);
  assert.equal(behavior.snapshotState(), "celebrate");
  behavior.update(2_100, model);
  assert.equal(behavior.snapshotState(), "idle");
});

test("material identity depends on the Bot identity color, never motion state", () => {
  const material = createBotAvatarMaterial("#1677ff");
  assert.deepEqual(createBotAvatarMaterial("#1677ff"), material);
  assert.equal(material.base, "#1677ff");
  assert.match(material.highlight, /#1677ff/);
  assert.match(material.shadow, /#1677ff/);
});
