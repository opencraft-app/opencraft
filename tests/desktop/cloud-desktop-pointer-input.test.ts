import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { bindDesktopPointerInput } from "../../plugins/cloud-desktop/src/pointer-input";
import type { RfbClient } from "../../plugins/cloud-desktop/src/rfb-client";

function fixture(beforeRemotePress?: () => void) {
  const dom = new JSDOM('<div id="surface"><canvas width="200" height="200"></canvas></div><div id="pad"></div>');
  const element = dom.window.document.getElementById("surface")!, canvas = element.querySelector("canvas")!;
  Object.defineProperties(element, { clientWidth: { value: 200 }, clientHeight: { value: 200 } });
  canvas.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 200 } as DOMRect);
  let next = 0, allowed = false;
  const frames = new Map<number, FrameRequestCallback>();
  dom.window.requestAnimationFrame = callback => { frames.set(++next, callback); return next; };
  dom.window.cancelAnimationFrame = id => { frames.delete(id); };
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  dom.window.setTimeout = (handler, delay = 0) => {
    assert.equal(typeof handler, "function");
    timers.set(++next, { at: now + delay, run: handler as () => void }); return next;
  };
  dom.window.clearTimeout = id => { timers.delete(id!); };
  const packets: { x: number; y: number; mask: number }[] = [];
  const client = { getInputCanvas: () => canvas, setPointerInputManaged() {}, focus() {},
    sendPointer: (x: number, y: number, mask: number) => packets.push({ x, y, mask }) } as unknown as RfbClient;
  const input = bindDesktopPointerInput(element, client, () => allowed, beforeRemotePress);
  const pad = dom.window.document.getElementById("pad")!;
  const detach = input.attachTrackpad(pad);
  return { packets, input, frames, timers, canvas, pad,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run(); }
    },
    padEvent(type: string, id: number, x: number, y: number) {
      const event = new dom.window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
      Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: "touch" } });
      pad.dispatchEvent(event);
    }, allow(value: boolean) { allowed = value; },
    event(type: string, id: number, x: number, y: number, pointerType = "touch", buttons = 0) {
      const event = new dom.window.MouseEvent(type, { clientX: x, clientY: y, buttons, bubbles: true, cancelable: true });
      Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType } });
      canvas.dispatchEvent(event);
    },
    frame() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); },
    close() { detach(); input.dispose(); dom.window.close(); } };
}

test("only a confirmed single-finger tap writes once; a cancelled touch never clicks", () => {
  const f = fixture(); f.event("pointerdown", 1, 80, 80); f.event("pointerup", 1, 80, 80);
  assert.deepEqual(f.packets, []); f.allow(true);
  f.event("pointerdown", 1, 80, 80); f.event("pointerup", 1, 80, 80);
  assert.deepEqual(f.packets.map(p => p.mask), [1, 0]);
  f.event("pointerdown", 2, 80, 80); f.event("pointercancel", 2, 80, 80);
  assert.deepEqual(f.packets.map(p => p.mask), [1, 0]); f.close();
});

test("geometry changes retire a physical touch without revoking its grant or remapping its origin", () => {
  const f = fixture(); f.allow(true);
  f.event("pointerdown", 1, 80, 80);
  f.canvas.getBoundingClientRect = () => ({ x: 0, y: 30, width: 200, height: 200 } as DOMRect);
  f.event("pointermove", 1, 85, 100); f.event("pointerup", 1, 85, 100);
  assert.deepEqual(f.packets, [], "old touch cannot become a drag/click in new geometry");
  f.event("pointerdown", 2, 80, 80); f.event("pointerup", 2, 80, 80);
  assert.deepEqual(f.packets.map(p => p.mask), [1, 0], "fresh touch keeps the same valid authorization");
  f.event("pointerdown", 3, 80, 80); f.event("pointermove", 3, 100, 80);
  f.canvas.width = 50;
  f.event("pointerup", 3, 100, 80);
  assert.equal(f.packets.at(-1)?.mask, 0, "resizing during a drag releases its old pressed button");
  assert.equal(f.packets.at(-1)?.x, 49, "release remains legal after a framebuffer shrink");
  f.close();
});

test("resize drops a queued pair sample and retains contact quarantine until every finger lifts", () => {
  const f = fixture(); f.allow(true);
  f.event("pointerdown", 1, 50, 80); f.event("pointerdown", 2, 150, 80);
  f.event("pointermove", 1, 50, 110); f.event("pointermove", 2, 150, 110);
  f.canvas.width = 300;
  f.event("pointerup", 1, 50, 110); f.frame();
  f.event("pointerdown", 3, 70, 110); f.event("pointerup", 3, 70, 110);
  assert.deepEqual(f.packets, [], "resize cannot commit queued scroll or allow a joined finger to click");
  f.event("pointerup", 2, 150, 110);
  f.event("pointerdown", 4, 80, 80); f.event("pointerup", 4, 80, 80);
  assert.deepEqual(f.packets.map(p => p.mask), [1, 0]); f.close();
});

test("single drag clamps outside pixels and capture loss releases its button", () => {
  const f = fixture(); f.allow(true);
  f.event("pointerdown", 1, 80, 80); f.event("pointermove", 1, 300, -10);
  assert.deepEqual(f.packets, [{ x: 80, y: 80, mask: 1 }, { x: 199, y: 0, mask: 1 }]);
  f.event("lostpointercapture", 1, 300, -10);
  assert.equal(f.packets.at(-1)?.mask, 0); f.close();
});

test("two-finger fast translation is sampled as a pair, not misclassified as transient one-finger pinch", () => {
  const f = fixture(); f.allow(true);
  f.event("pointerdown", 1, 60, 120); f.event("pointerdown", 2, 140, 120);
  f.event("pointermove", 1, 60, 40); f.event("pointermove", 2, 140, 40);
  assert.equal(f.frames.size, 1); assert.deepEqual(f.packets, []);
  f.frame(); assert.deepEqual(f.packets.map(p => p.mask), [16, 0]);
  f.event("pointerup", 1, 60, 40); f.event("pointerup", 2, 140, 40);
  assert.deepEqual(f.packets.map(p => p.mask), [16, 0], "remaining finger cannot commit a tap"); f.close();
});

test("pinch is local under observing or controlling, never remote Ctrl or wheel", () => {
  for (const allowed of [false, true]) {
    const f = fixture(); f.allow(allowed);
    f.event("pointerdown", 1, 60, 100); f.event("pointerdown", 2, 140, 100);
    f.event("pointermove", 1, 20, 100); f.event("pointermove", 2, 180, 100); f.frame();
    assert.ok(f.canvas.style.transform.includes("scale(2)")); assert.deepEqual(f.packets, []); f.close();
  }
});

test("revocation cancels queued pair input and retained fingers cannot join a successor grant", () => {
  const f = fixture(); f.allow(true);
  f.event("pointerdown", 1, 60, 120); f.event("pointerdown", 2, 140, 120);
  f.event("pointermove", 1, 60, 40); f.event("pointermove", 2, 140, 40);
  f.allow(false); f.input.reset(); assert.equal(f.frames.size, 0);
  f.allow(true); f.frame(); f.event("pointerup", 2, 140, 40);
  f.event("pointerdown", 3, 140, 40); f.event("pointermove", 1, 60, 0); f.event("pointermove", 3, 140, 0); f.frame();
  f.event("pointerup", 1, 60, 0); f.event("pointerup", 3, 140, 0);
  assert.deepEqual(f.packets, []);
  f.event("pointerdown", 4, 100, 100); f.event("pointerup", 4, 100, 100);
  assert.deepEqual(f.packets.map(p => p.mask), [1, 0]); f.close();
});

test("mouse button mask maps native right/middle; held old drag cannot revive after reset", () => {
  const f = fixture(); f.allow(true);
  f.event("pointerdown", 1, 100, 100, "mouse", 2); assert.equal(f.packets.at(-1)?.mask, 4);
  f.input.reset(); assert.equal(f.packets.at(-1)?.mask, 0);
  const length = f.packets.length;
  f.event("pointermove", 1, 120, 120, "mouse", 2); assert.equal(f.packets.length, length);
  f.event("pointerup", 1, 120, 120, "mouse", 0);
  f.event("pointerdown", 1, 100, 100, "mouse", 4); assert.equal(f.packets.at(-1)?.mask, 2); f.close();
});

test("touch replaces a held mouse transaction without inheriting its right button or hover", () => {
  const f = fixture(); f.allow(true);
  f.event("pointerdown", 1, 100, 100, "mouse", 2);
  f.event("pointerdown", 2, 80, 80);
  assert.deepEqual(f.packets.map(p => p.mask), [4, 0]);
  f.event("pointermove", 1, 150, 150, "mouse", 2);
  f.event("pointermove", 2, 100, 80);
  assert.deepEqual(f.packets.map(p => p.mask), [4, 0, 1, 1]);
  f.event("pointerup", 1, 150, 150, "mouse", 0);
  assert.equal(f.packets.at(-1)?.mask, 1, "old mouse release cannot release a touch drag");
  f.event("pointerup", 2, 100, 80);
  assert.equal(f.packets.at(-1)?.mask, 0); f.close();
});

test("focus handoff happens before a tap/drag/mouse press and reentrant retirement suppresses the remote press", () => {
  for (const source of ["tap", "drag", "mouse"]) for (const retire of [false, true]) {
    let handoffs = 0;
    const f = fixture(() => {
      handoffs++; assert.equal(f.packets.length, 0, "text must finish before the first remote target-changing packet");
      if (retire) f.input.reset();
    });
    f.allow(true);
    const type = source === "mouse" ? "mouse" : "touch";
    f.event("pointerdown", 1, 80, 80, type, source === "mouse" ? 1 : 0);
    if (source === "drag") f.event("pointermove", 1, 120, 80);
    f.event("pointerup", 1, 120, 80, type);
    assert.equal(handoffs, 1);
    assert.equal(f.packets.length === 0, retire);
    f.close();
  }
});


test("trackpad moves relative to the cursor across lifted strokes; tap uses that cursor, never the finger position", () => {
  const f = fixture();
  f.padEvent("pointerdown", 1, 5, 5); f.padEvent("pointerup", 1, 5, 5);
  assert.deepEqual(f.packets, []); f.allow(true);
  f.padEvent("pointerdown", 2, 5, 5); f.padEvent("pointermove", 2, 25, 15); f.padEvent("pointerup", 2, 25, 15);
  assert.deepEqual(f.packets, [{ x: 125, y: 112, mask: 0 }]);
  f.padEvent("pointerdown", 3, 5, 5); f.padEvent("pointermove", 3, 25, 15); f.padEvent("pointerup", 3, 25, 15);
  assert.deepEqual(f.packets.at(-1), { x: 150, y: 125, mask: 0 });
  f.padEvent("pointerdown", 4, 5, 5); f.padEvent("pointerup", 4, 5, 5);
  assert.deepEqual(f.packets.slice(-2), [{ x: 150, y: 125, mask: 1 }, { x: 150, y: 125, mask: 0 }]);
  f.padEvent("pointerdown", 5, 5, 5); f.padEvent("pointermove", 5, 45, 15);
  assert.equal(f.packets.at(-1)?.mask, 1, "second held tap drags at the relative cursor");
  f.padEvent("pointercancel", 5, 45, 15);
  assert.equal(f.packets.at(-1)?.mask, 0, "cancel releases drag"); f.close();
});

test("two-finger trackpad tap is right-click; scrolling cannot click or become a one-finger stroke", () => {
  const f = fixture(); f.allow(true);
  f.padEvent("pointerdown", 1, 40, 80); f.padEvent("pointerdown", 2, 100, 80);
  f.padEvent("pointerup", 1, 40, 80); f.padEvent("pointerup", 2, 100, 80);
  assert.deepEqual(f.packets.map(p => p.mask), [4, 0]);
  f.padEvent("pointerdown", 10, 40, 80); f.padEvent("pointerup", 10, 40, 80);
  const beforeRight = f.packets.length;
  f.padEvent("pointerdown", 11, 40, 80); f.padEvent("pointerdown", 12, 100, 80);
  f.padEvent("pointerup", 11, 40, 80); f.padEvent("pointerup", 12, 100, 80);
  assert.deepEqual(f.packets.slice(beforeRight).map(p => p.mask), [4, 0], "a recent tap must not inject a left press before two-finger right-click");
  f.packets.length = 0;
  f.padEvent("pointerdown", 3, 40, 80); f.padEvent("pointerdown", 4, 100, 80);
  f.padEvent("pointermove", 3, 40, 40); f.padEvent("pointermove", 4, 100, 40); f.frame();
  f.padEvent("pointerup", 3, 40, 40); f.padEvent("pointermove", 4, 80, 20); f.padEvent("pointerup", 4, 80, 20);
  assert.deepEqual(f.packets.map(p => p.mask), [16, 0]); f.close();
});

test("revoke, geometry change and media gestures retire trackpad contacts across successor grants", () => {
  const f = fixture(); f.allow(true);
  f.padEvent("pointerdown", 1, 30, 80); f.input.reset();
  f.padEvent("pointerdown", 2, 100, 80); f.padEvent("pointerup", 1, 30, 80);
  f.padEvent("pointermove", 2, 120, 80); f.padEvent("pointerup", 2, 120, 80);
  assert.deepEqual(f.packets, []);
  f.padEvent("pointerdown", 3, 30, 80); f.canvas.width = 100;
  f.padEvent("pointermove", 3, 40, 80); f.padEvent("pointerup", 3, 40, 80);
  assert.deepEqual(f.packets, [], "framebuffer resize retires the previous geometry");
  f.padEvent("pointerdown", 4, 30, 80);
  f.event("pointerdown", 5, 80, 80); f.event("pointercancel", 5, 80, 80);
  f.padEvent("pointerup", 4, 30, 80);
  assert.deepEqual(f.packets, [], "direct media input cancels a held trackpad gesture");
  f.padEvent("pointerdown", 6, 30, 80); f.padEvent("pointerup", 6, 30, 80);
  assert.deepEqual(f.packets.map(p => p.mask), [1, 0]); f.close();
});

test("trackpad press rechecks the grant after composition focus handoff", () => {
  let f: ReturnType<typeof fixture>;
  f = fixture(() => { f.allow(false); f.input.reset(); }); f.allow(true);
  f.padEvent("pointerdown", 1, 30, 80); f.padEvent("pointerup", 1, 30, 80);
  assert.deepEqual(f.packets, []); f.close();
});

test("a stationary 300ms hold starts a relative drag without a preceding tap and releases exactly once", () => {
  const f = fixture(); f.allow(true);
  f.padEvent("pointerdown", 1, 30, 80);
  f.advance(299); assert.deepEqual(f.packets, [], "holding must not click early");
  f.advance(1); assert.deepEqual(f.packets, [{ x: 100, y: 100, mask: 1 }]);
  assert.equal(f.pad.dataset.pressed, "true");
  f.advance(600); assert.equal(f.packets.length, 1, "the hold timer cannot repeat");
  f.padEvent("pointermove", 1, 50, 80);
  assert.deepEqual(f.packets.at(-1), { x: 125, y: 100, mask: 1 });
  f.padEvent("pointerup", 1, 50, 80); f.advance(500);
  assert.deepEqual(f.packets.map(p => p.mask), [1, 1, 0]);
  assert.equal(f.pad.dataset.pressed, "false"); assert.equal(f.timers.size, 0); f.close();
});

test("movement cancels long-press arming permanently for that stroke; tiny finger jitter is tolerated", () => {
  const f = fixture(); f.allow(true);
  f.padEvent("pointerdown", 1, 30, 80); f.advance(100);
  f.padEvent("pointermove", 1, 38, 80); f.padEvent("pointermove", 1, 30, 80);
  f.advance(600); f.padEvent("pointerup", 1, 30, 80);
  assert.ok(f.packets.length > 0); assert.ok(f.packets.every(p => p.mask === 0), "moving then pausing cannot grab anything");
  f.packets.length = 0;
  f.padEvent("pointerdown", 2, 30, 80); f.padEvent("pointermove", 2, 33, 82); f.advance(300);
  assert.equal(f.packets.at(-1)?.mask, 1, "small involuntary movement still permits a hold");
  f.padEvent("pointerup", 2, 33, 82);
  assert.deepEqual(f.packets.slice(1).map(p => p.mask), [1, 0]); f.close();
});

test("a short tap stays a single click and a second finger cancels the pending hold", () => {
  const f = fixture(); f.allow(true);
  f.padEvent("pointerdown", 1, 30, 80); f.advance(299); f.padEvent("pointerup", 1, 30, 80); f.advance(500);
  assert.deepEqual(f.packets.map(p => p.mask), [1, 0]);
  f.packets.length = 0;
  f.padEvent("pointerdown", 2, 30, 80); f.advance(200); f.padEvent("pointerdown", 3, 100, 80);
  f.advance(300); assert.deepEqual(f.packets, []);
  f.padEvent("pointerup", 2, 30, 80); f.padEvent("pointerup", 3, 100, 80);
  assert.deepEqual(f.packets.map(p => p.mask), [4, 0]); f.close();
});

test("joining a held drag with a second finger releases it without converting either contact to a click", () => {
  const f = fixture(); f.allow(true);
  f.padEvent("pointerdown", 1, 30, 80); f.advance(300);
  f.padEvent("pointerdown", 2, 100, 80);
  f.padEvent("pointerup", 1, 30, 80); f.padEvent("pointermove", 2, 120, 80); f.padEvent("pointerup", 2, 120, 80);
  f.advance(500); assert.deepEqual(f.packets.map(p => p.mask), [1, 0]);
  f.padEvent("pointerdown", 3, 30, 80); f.padEvent("pointerup", 3, 30, 80);
  assert.deepEqual(f.packets.map(p => p.mask), [1, 0, 1, 0]); f.close();
});

test("cancel, capture loss, reset, disposal, geometry and grant changes fence pending holds", () => {
  for (const reason of ["pointercancel", "lostpointercapture", "reset", "dispose", "resize", "pad-resize", "grant", "media"]) {
    const f = fixture(); f.allow(true);
    f.padEvent("pointerdown", 1, 30, 80); f.advance(200);
    const stale = [...f.timers.values()].map(timer => timer.run);
    if (reason === "reset") f.input.reset();
    else if (reason === "dispose") f.input.dispose();
    else if (reason === "resize") f.canvas.width = 100;
    else if (reason === "pad-resize") f.pad.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 150 } as DOMRect);
    else if (reason === "grant") f.allow(false);
    else if (reason === "media") { f.event("pointerdown", 2, 50, 50); f.event("pointercancel", 2, 50, 50); }
    else f.padEvent(reason, 1, 30, 80);
    f.advance(300); for (const run of stale) run();
    assert.deepEqual(f.packets, [], reason);
    f.allow(true); f.padEvent("pointermove", 1, 60, 80); f.padEvent("pointerup", 1, 60, 80); f.advance(500);
    assert.deepEqual(f.packets, [], `${reason}: an old held finger cannot enter a successor gesture`); f.close();
  }
});

test("long-press focus handoff can synchronously retire the gesture without a stuck pressed state", () => {
  let f: ReturnType<typeof fixture>;
  f = fixture(() => { f.input.reset(); }); f.allow(true);
  f.padEvent("pointerdown", 1, 30, 80); f.advance(300);
  assert.deepEqual(f.packets, []); assert.equal(f.pad.dataset.pressed, "false");
  f.padEvent("pointermove", 1, 60, 80); f.padEvent("pointerup", 1, 60, 80);
  assert.deepEqual(f.packets, []); f.close();
});

test("an old cleared hold callback cannot start or consume a fresh gesture's timer", () => {
  const f = fixture(); f.allow(true);
  f.padEvent("pointerdown", 1, 30, 80);
  const old = [...f.timers.values()][0]!.run;
  f.input.reset(); f.padEvent("pointerup", 1, 30, 80);
  f.padEvent("pointerdown", 2, 30, 80); old();
  f.advance(299); assert.deepEqual(f.packets, []);
  f.advance(1); assert.deepEqual(f.packets.map(p => p.mask), [1]);
  f.padEvent("pointerup", 2, 30, 80); assert.deepEqual(f.packets.map(p => p.mask), [1, 0]); f.close();
});

test("cancelling or disposing an active stationary hold releases its remote left button", () => {
  for (const reason of ["pointercancel", "lostpointercapture", "reset", "dispose"]) {
    const f = fixture(); f.allow(true);
    f.padEvent("pointerdown", 1, 30, 80); f.advance(300);
    if (reason === "reset") f.input.reset();
    else if (reason === "dispose") f.input.dispose();
    else f.padEvent(reason, 1, 30, 80);
    f.advance(500); assert.deepEqual(f.packets.map(p => p.mask), [1, 0], reason);
    assert.equal(f.pad.dataset.pressed, "false"); f.close();
  }
});
