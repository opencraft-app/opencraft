import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { bindDesktopPointerInput } from "../plugins/cloud-desktop/src/pointer-input";
import type { RfbClient } from "../plugins/cloud-desktop/src/rfb-client";

function fixture(beforeRemotePress?: () => void) {
  const dom = new JSDOM('<div id="surface"><canvas width="200" height="200"></canvas></div>');
  const element = dom.window.document.getElementById("surface")!, canvas = element.querySelector("canvas")!;
  Object.defineProperties(element, { clientWidth: { value: 200 }, clientHeight: { value: 200 } });
  canvas.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 200 } as DOMRect);
  let next = 0, allowed = false;
  const frames = new Map<number, FrameRequestCallback>();
  dom.window.requestAnimationFrame = callback => { frames.set(++next, callback); return next; };
  dom.window.cancelAnimationFrame = id => { frames.delete(id); };
  const packets: { x: number; y: number; mask: number }[] = [];
  const client = { getInputCanvas: () => canvas, setPointerInputManaged() {}, focus() {},
    sendPointer: (x: number, y: number, mask: number) => packets.push({ x, y, mask }) } as unknown as RfbClient;
  const input = bindDesktopPointerInput(element, client, () => allowed, beforeRemotePress);
  return { packets, input, frames, canvas, allow(value: boolean) { allowed = value; },
    event(type: string, id: number, x: number, y: number, pointerType = "touch", buttons = 0) {
      const event = new dom.window.MouseEvent(type, { clientX: x, clientY: y, buttons, bubbles: true, cancelable: true });
      Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType } });
      canvas.dispatchEvent(event);
    },
    frame() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); },
    close() { input.dispose(); dom.window.close(); } };
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
