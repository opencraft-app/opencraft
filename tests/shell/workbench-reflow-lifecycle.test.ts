import assert from "node:assert/strict";
import test from "node:test";
import { beginTimelineElementReflow, preserveTimelineElementPositionOnReflow } from "../../packages/timeline-host-web/src/reflow";

function fixture(run: (state: ReturnType<typeof setup>) => void) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  const state = setup();
  Object.defineProperty(globalThis, "window", { configurable: true, value: state.window });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: state.Observer });
  try { run(state); } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousObserver) Object.defineProperty(globalThis, "ResizeObserver", previousObserver);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
}

function setup() {
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextId = 1;
  let layoutTop = 100;
  let connected = true;
  let resize: (() => void) | null = null;
  let disconnects = 0;
  const scroll = { scrollTop: 0, get isConnected() { return connected; } } as HTMLElement;
  const anchor = {
    getBoundingClientRect: () => ({ top: layoutTop - scroll.scrollTop }),
    get isConnected() { return connected; },
    closest: () => ({}),
  } as unknown as HTMLElement;
  return {
    anchor, scroll, frames, timers,
    window: {
      requestAnimationFrame(callback: FrameRequestCallback) { const id = nextId++; frames.set(id, callback); return id; },
      cancelAnimationFrame(id: number) { frames.delete(id); },
      setTimeout(callback: () => void, delay: number) { const id = nextId++; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id: number) { timers.delete(id); },
    },
    Observer: class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() { disconnects++; }
    },
    move(delta: number) { layoutTop += delta; },
    resize() { resize?.(); },
    disconnect() { connected = false; },
    get disconnects() { return disconnects; },
    frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); },
  };
}

test("synchronous disclosure completion compensates before its first collapsed paint", () => fixture(state => {
  const lease = beginTimelineElementReflow(state.anchor, state.scroll);
  state.move(-40);
  lease.complete();
  assert.equal(state.anchor.getBoundingClientRect().top, 100);
  state.frame(); state.frame(); state.frame();
  assert.equal(state.frames.size, 0);
  assert.equal(state.disconnects, 1);
}));

test("animated reflow does not expire at 250ms and releases only after completion", () => fixture(state => {
  const lease = beginTimelineElementReflow(state.anchor, state.scroll);
  for (let frame = 0; frame < 40; frame++) {
    state.move(5); state.frame();
    assert.equal(state.anchor.getBoundingClientRect().top, 100);
    assert.equal(state.frames.size, 1);
  }
  assert.equal(state.timers.size, 0);
  lease.complete(); state.frame(); state.frame(); state.frame();
  state.move(20); state.frame();
  assert.equal(state.anchor.getBoundingClientRect().top, 120);
}));

test("final resize restarts stable-frame settlement", () => fixture(state => {
  const lease = beginTimelineElementReflow(state.anchor, state.scroll);
  lease.complete(); state.frame(); state.frame();
  state.move(30); state.resize(); state.frame();
  assert.equal(state.anchor.getBoundingClientRect().top, 100);
  assert.equal(state.frames.size, 1);
  state.frame(); state.frame();
  assert.equal(state.frames.size, 0);
}));

test("cancellation and disconnected anchors retire their observation and frame", () => fixture(state => {
  const first = beginTimelineElementReflow(state.anchor, state.scroll);
  first.cancel(); first.complete();
  assert.equal(state.frames.size, 0);
  const second = beginTimelineElementReflow(state.anchor, state.scroll);
  state.disconnect(); state.frame(); second.complete();
  assert.equal(state.frames.size, 0);
  assert.equal(state.disconnects, 2);
}));

test("legacy bounded expanders keep their policy but cancellation clears all resources", () => fixture(state => {
  const cancel = preserveTimelineElementPositionOnReflow(state.anchor, state.scroll);
  assert.equal([...state.timers.values()][0]?.delay, 250);
  cancel();
  assert.equal(state.timers.size, 0);
  assert.equal(state.frames.size, 0);
  assert.equal(state.disconnects, 1);
}));
