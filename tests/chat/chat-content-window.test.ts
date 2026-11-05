import assert from "node:assert/strict";
import test from "node:test";
import { WebConversationContentWindow } from "../../packages/timeline-host-web/src/content-window";

test("measured content survives suspension; placeholders, hidden views and retired observations cannot overwrite it", () => {
  const oldIO = globalThis.IntersectionObserver, oldRO = globalThis.ResizeObserver;
  let intersect: IntersectionObserverCallback = () => undefined;
  let resize: ResizeObserverCallback = () => undefined;
  let io: IntersectionObserver, ro: ResizeObserver;
  const observed = new Set<Element>();
  class IO {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; io = this as unknown as IntersectionObserver; }
    observe(element: Element) { observed.add(element); }
    unobserve(element: Element) { observed.delete(element); }
    disconnect() { observed.clear(); }
  }
  class RO {
    constructor(callback: ResizeObserverCallback) { resize = callback; ro = this as unknown as ResizeObserver; }
    observe() {} unobserve() {} disconnect() {}
  }
  Object.assign(globalThis, { IntersectionObserver: IO, ResizeObserver: RO });
  try {
    let height = 800;
    const root = { get clientHeight() { return height; } } as HTMLElement;
    const document = { activeElement: null, getSelection: () => null };
    const element = { ownerDocument: document, contains: () => false, querySelector: () => null } as unknown as HTMLElement;
    const owner = new WebConversationContentWindow(), visibility: boolean[] = [];
    const release = owner.observe(element, "stable", visible => visibility.push(visible));
    owner.attach(root);
    assert(observed.has(element));
    intersect([{ target: element, isIntersecting: true } as IntersectionObserverEntry], io!);
    owner.rendered(element, true);
    const measurement = (size: number) => [{ target: element, borderBoxSize: [{ blockSize: size }] } as unknown as ResizeObserverEntry];
    resize(measurement(143), ro!);
    owner.rendered(element, false);
    resize(measurement(27), ro!);
    assert.equal(owner.height("stable", 27), 143);
    const restored = new WebConversationContentWindow();
    restored.restore({ ...owner.capture(), invalid: Number.NaN });
    assert.equal(restored.height("stable", 27), 143);
    assert.equal(restored.height("invalid", 27), 27);
    restored.dispose();
    height = 0;
    intersect([{ target: element, isIntersecting: false } as IntersectionObserverEntry], io!);
    assert.deepEqual(visibility, [true]);
    height = 800;
    release();
    intersect([{ target: element, isIntersecting: false } as IntersectionObserverEntry], io!);
    assert.deepEqual(visibility, [true]);
    owner.dispose();
    resize(measurement(999), ro!);
    assert.equal(owner.height("stable", 27), 27);
  } finally { Object.assign(globalThis, { IntersectionObserver: oldIO, ResizeObserver: oldRO }); }
});
