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

test("content measurements are scoped to width, typography and loaded fonts; old observers cannot revive them", () => {
  const oldRO = globalThis.ResizeObserver, oldMO = globalThis.MutationObserver;
  let resize: ResizeObserverCallback, mutation: MutationCallback, current: ResizeObserver;
  const listeners = new Map<string, () => void>();
  class RO {
    constructor(callback: ResizeObserverCallback) { resize = callback; current = this as unknown as ResizeObserver; }
    observe() {} unobserve() {} disconnect() {}
  }
  class MO {
    constructor(callback: MutationCallback) { mutation = callback; }
    observe() {} disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: RO, MutationObserver: MO });
  try {
    let width = 400, font = "14px", codeFont = "12px";
    const document = { documentElement: {}, fonts: {
      status: "loaded", size: 1,
      addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
      removeEventListener: (name: string) => listeners.delete(name),
    }, defaultView: { getComputedStyle: () => ({ getPropertyValue: (name: string) => name === "font-size" ? font : name === "--opencraft-chat-code-font-size" ? codeFont : "" }) } };
    const root = { clientHeight: 800, ownerDocument: document, contains: () => true } as unknown as HTMLElement;
    const element = { ownerDocument: document, getBoundingClientRect: () => ({ width }) } as unknown as HTMLElement;
    let refreshed = 0;
    const owner = new WebConversationContentWindow();
    owner.attach(root);
    owner.observe(element, "body", () => {}, () => { refreshed++; });
    owner.rendered(element, true);
    const measure = (height: number) => [{ target: element, borderBoxSize: [{ blockSize: height }] } as unknown as ResizeObserverEntry];
    resize!(measure(200), current!);
    assert.equal(owner.height("body", 27, element), 200);
    const restored = new WebConversationContentWindow();
    restored.restore(owner.capture(), owner.captureMeasurements());
    assert.equal(restored.height("body", 27, element), 200);
    const legacy = new WebConversationContentWindow();
    legacy.restore(owner.capture());
    assert.equal(legacy.height("body", 27, element), 27, "unscoped legacy sizes cannot prove layout compatibility");
    width = 600;
    assert.equal(restored.height("body", 27, element), 27, "restoration at a new width rejects stale geometry before observation");
    let retired = resize!;
    resize!(measure(200), current!);
    assert.equal(owner.height("body", 27, element), 27);
    retired(measure(999), current!);
    assert.equal(owner.height("body", 27, element), 27);
    resize!(measure(100), current!);
    assert.equal(owner.height("body", 27, element), 100);
    owner.rendered(element, false);
    resize!(measure(999), current!);
    assert.equal(owner.height("body", 27, element), 100, "placeholder heights never replace real measurements");
    font = "18px";
    retired = resize!;
    mutation!([{ target: root } as unknown as MutationRecord], {} as MutationObserver);
    assert.equal(owner.height("body", 27, element), 27);
    retired(measure(999), current!);
    assert.equal(owner.height("body", 27, element), 27);
    owner.rendered(element, true);
    resize!(measure(180), current!);
    assert.equal(owner.height("body", 27, element), 180);
    retired = resize!;
    listeners.get("loadingdone")!();
    assert.equal(owner.height("body", 27, element), 27, "font bytes can change metrics without changing the computed font string");
    retired(measure(999), current!);
    assert.equal(owner.height("body", 27, element), 27);
    resize!(measure(190), current!);
    assert.equal(owner.height("body", 27, element), 190);
    codeFont = "15px";
    mutation!([{ target: root } as unknown as MutationRecord], {} as MutationObserver);
    assert.equal(owner.height("body", 27, element), 27, "descendant code typography tokens also invalidate aggregate height");
    resize!(measure(210), current!);
    const beforeLeaving = owner.captureMeasurements();
    assert.ok(refreshed >= 4, "mounted placeholders are notified of invalidation");
    owner.dispose(); restored.dispose(); legacy.dispose();
    assert.equal(listeners.size, 0);
    document.fonts.size = 2;
    const returned = new WebConversationContentWindow();
    returned.restore({}, beforeLeaving);
    assert.equal(returned.height("body", 27, element), 27, "font-set changes while the View is absent also fence restored measurements");
    returned.dispose();
  } finally { Object.assign(globalThis, { ResizeObserver: oldRO, MutationObserver: oldMO }); }
});
