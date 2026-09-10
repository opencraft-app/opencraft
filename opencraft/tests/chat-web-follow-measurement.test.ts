import assert from "node:assert/strict";
import test from "node:test";
import { WebConversationViewportOwner } from "@opencraft/timeline-host-web";

test("r3562 viewport observer owns only the scrollport, initializes once, coalesces and cancels frames", () => {
  const originalObserver = globalThis.ResizeObserver;
  const originalWindow = globalThis.window;
  let callback: ResizeObserverCallback;
  const observed = new Set<Element>();
  const frames = new Map<number, FrameRequestCallback>();
  const listeners = new Map<string, () => void>();
  let nextFrame = 0;
  globalThis.ResizeObserver = class {
    constructor(next: ResizeObserverCallback) { callback = next; }
    observe(element: Element) { observed.add(element); }
    disconnect() { observed.clear(); }
  } as typeof ResizeObserver;
  globalThis.window = {
    requestAnimationFrame(fn: FrameRequestCallback) { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    addEventListener(name: string, fn: () => void) { listeners.set(name, fn); },
    removeEventListener(name: string) { listeners.delete(name); },
  } as unknown as Window & typeof globalThis;
  const owner = new WebConversationViewportOwner(0);
  const content = {} as Element;
  const scrollport = { firstElementChild: content } as HTMLDivElement;
  let changes = 0;
  try {
    owner.scrollElementRef.current = scrollport;
    const release = owner.observeViewportGeometry(() => changes++);
    assert.equal(changes, 1, "initial update does not wait for observer delivery");
    assert.deepEqual([...observed], [scrollport], "content ancestors must never join the viewport observer");
    callback!([], {} as ResizeObserver);
    callback!([], {} as ResizeObserver);
    listeners.get("resize")!();
    assert.equal(frames.size, 1);
    for (const [id, frame] of frames) { frames.delete(id); frame(16); }
    assert.equal(changes, 2);
    callback!([], {} as ResizeObserver);
    release();
    assert.equal(frames.size, 0);
    assert.equal(observed.size, 0);
    assert.equal(listeners.size, 0);
    owner.scrollElementRef.current = null;
  } finally {
    owner.scrollElementRef.current = null;
    owner.dispose();
    globalThis.ResizeObserver = originalObserver;
    globalThis.window = originalWindow;
  }
});

test("r3562 observer commits rows before follow targets; stale registrations and disposed owners cannot publish", () => {
  const originalObserver = globalThis.ResizeObserver;
  const originalNode = globalThis.Node;
  let callback: ResizeObserverCallback;
  const observed = new Set<Element>();
  globalThis.ResizeObserver = class {
    constructor(next: ResizeObserverCallback) { callback = next; }
    observe(element: Element) { observed.add(element); }
    unobserve(element: Element) { observed.delete(element); }
    disconnect() { observed.clear(); }
  } as typeof ResizeObserver;
  globalThis.Node = { DOCUMENT_POSITION_FOLLOWING: 4 } as typeof Node;
  const element = (order: number) => ({
    dataset: {},
    offsetHeight: 500,
    order,
    compareDocumentPosition(other: { order: number }) { return other.order > order ? 4 : 2; },
  }) as unknown as HTMLDivElement;
  const row = element(0), first = element(1), last = element(2);
  const record = (target: Element, height: number) => ({ target, borderBoxSize: [{ blockSize: height }] }) as unknown as ResizeObserverEntry;
  const owner = new WebConversationViewportOwner(0);
  try {
    owner.observeTurn("one", row);
    assert.deepEqual(owner.measureNewlyMountedTurns(), [{ turnKey: "one", heightPx: 500 }]);
    owner.observeTurn("one", row);
    assert.deepEqual(owner.measureNewlyMountedTurns(), [], "stable refs must not remount a measured row");
    owner.observeTurn("removed-before-paint", element(3));
    owner.observeTurn("removed-before-paint", null);
    assert.deepEqual(owner.measureNewlyMountedTurns(), [], "retired rows cannot enter the pre-paint transaction");
    const releaseFirst = owner.observeLatestTurnFollowContent("one", first)!;
    const releaseLast = owner.observeLatestTurnFollowContent("one", last)!;
    const events: unknown[] = [];
    owner.setLatestTurnMeasurementListener((change) => events.push(change));
    owner.setMeasurementListener((batch) => {
      events.push("row-commit");
      assert.equal(batch.measurements[0]?.heightPx, 500);
      releaseLast(); // Simulates flushSync retiring a target from this same batch.
      owner.publishLatestTurnHeightChange({ turnKey: "one", heightDeltaPx: 0, heightPx: 500 });
    });
    callback!([record(last, 200), record(row, 500), record(first, 100)], {} as ResizeObserver);
    assert.equal(events[0], "row-commit");
    assert.deepEqual(events[1], { kind: "turn-height", turnKey: "one", heightDeltaPx: 0, heightPx: 500, element: row });
    assert.deepEqual(events[2], { kind: "follow-content", turnKey: "one", followContentHeightPx: 100, element: first });

    events.length = 0;
    callback!([record(first, 140)], {} as ResizeObserver);
    assert.deepEqual(events, [{ kind: "follow-content", turnKey: "one", followContentHeightPx: 140, element: first }]);
    releaseFirst();
    events.length = 0;
    callback!([record(first, 900), record(last, 900)], {} as ResizeObserver);
    assert.deepEqual(events, []);
    owner.dispose();
    callback!([record(row, 900)], {} as ResizeObserver);
    assert.deepEqual(events, []);
    assert.equal(observed.size, 0);
  } finally {
    owner.dispose();
    globalThis.ResizeObserver = originalObserver;
    globalThis.Node = originalNode;
  }
});
