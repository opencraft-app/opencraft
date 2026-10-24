import assert from "node:assert/strict";
import test from "node:test";
import { createViewportDiagnostics } from "../../apps/workbench-web/src/runtime/viewport-diagnostics";

function fixture(t: test.TestContext) {
  let now = 0;
  let top = 0;
  let revision = "a".repeat(40);
  const reads = { rect: 0, style: 0, hit: 0 };
  const reports: Record<string, number | string>[] = [];
  class Element {
    isContentEditable = true;
    scrollTop = 0;
    closest(_selector: string): unknown { return null; }
    querySelector(_selector: string): unknown { return null; }
    getBoundingClientRect() { reads.rect++; return { top, height: 394, bottom: top + 394 }; }
  }
  const shell = new Element();
  const doc = {
    visibilityState: "visible",
    documentElement: Object.assign(new Element(), { clientHeight: 688 }),
    body: new Element(), activeElement: shell,
    elementFromPoint(_x: number, _y: number): unknown { reads.hit++; return null; },
    querySelector(selector: string) {
      return selector.startsWith("meta") ? { content: revision } : shell;
    },
  };
  const values = {
    document: doc, HTMLElement: Element, innerHeight: 394, innerWidth: 390, scrollY: 294,
    window: {
      screen: { height: 844, width: 390 }, navigator: { standalone: false },
      matchMedia: () => ({ matches: false }),
      visualViewport: { height: 394, width: 390, offsetTop: 294, offsetLeft: 0, pageTop: 294, scale: 1 },
      getComputedStyle: (element?: { paddingTop?: string }) => { reads.style++; return { top: "294px", height: "394px", paddingTop: element?.paddingTop ?? "0px" }; },
    },
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    reports.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 202 });
  });
  return { reports, doc, reads, top(value: number) { top = value; }, advance(ms: number) { now += ms; top++; }, revision(value: string) { revision = value; } };
}

test("long-lived pages retain evidence after the first 64 keyboard observations", t => {
  const f = fixture(t), report = createViewportDiagnostics();
  for (let i = 0; i < 96; i++) { f.advance(1_000); report(); }
  assert.equal(f.reports.length, 96, "Later keyboard cycles must not become permanently invisible");
  const last = f.reports.at(-1)!;
  assert.equal(last.sourceRevision, "a".repeat(40));
  assert.equal(last.cssTop, 294);
  assert.equal(last.clientHeight, 688);
  assert.equal(last.shellTop, 96);
  assert.equal(last.scrollY, 294);
  assert.doesNotMatch(JSON.stringify(last), /text|route|account|userAgent/);
});

test("diagnostics use the focused Composer and preserve independent touch coordinate differences", t => {
  const f = fixture(t), report = createViewportDiagnostics();
  const send = {
    getBoundingClientRect: () => ({ left: 250, top: 106, width: 44, height: 44, bottom: 150 }),
    contains: (element: unknown) => element === send,
  };
  const composer = {
    getBoundingClientRect: () => ({ top: 20, bottom: 160 }),
    querySelector: () => send,
  };
  f.doc.activeElement.closest = selector => selector === ".opencraft-composer-shell" ? composer : { scrollTop: 29 };
  f.doc.activeElement.scrollTop = 7;
  f.doc.elementFromPoint = () => send;
  report({ type: "touchstart", changedTouches: [{ screenY: 700, clientY: 306, pageY: 600 }] } as unknown as Event);
  const result = f.reports.at(-1)!;
  assert.equal(result.sendBottom, 150, "A hidden page's first button is not the focused Composer");
  assert.equal(result.sendHit, 1);
  assert.equal(result.composerTop, 20);
  assert.equal(result.draftScroll, 29);
  assert.equal(result.editorScroll, 7);
  assert.equal(result.touchScreenClientY, 394);
  assert.equal(result.touchPageClientY, 294);
  assert.equal(result.touchSequence, 1);
  assert.doesNotMatch(JSON.stringify(result), /clientY|screenY|pageY|text|route|account|userAgent/);
});

test("a sub-budget frame excursion survives recovery before the next transmission", t => {
  const f = fixture(t), report = createViewportDiagnostics();
  report();
  f.advance(16); f.top(-294); report();
  f.advance(16); f.top(0); report();
  assert.equal(f.reports.length, 1, "Network traffic is still bounded");
  f.advance(80); f.top(0); report();
  const result = f.reports.at(-1)!;
  assert.equal(result.editorTop, 0, "The final frame alone looks recovered");
  assert.equal(result.editorMinTop, -294, "The earlier excursion is retained");
  assert.equal(result.shellMinTop, -294);
  assert.equal(result.observedSamples, 3);
});

test("sustained geometry changes stay rate bounded and observation recovers after idle", t => {
  const f = fixture(t), report = createViewportDiagnostics();
  for (let i = 0; i < 1_000; i++) { f.advance(80); report(); }
  assert.ok(f.reports.length > 64);
  assert.ok(f.reports.length <= 64 + 8 * 80, "At most the burst allowance plus eight reports per second");
  const before = f.reports.length;
  f.advance(10_000); report();
  assert.equal(f.reports.length, before + 1);
  report();
  assert.equal(f.reports.length, before + 1, "Identical observations are not transmitted twice");
});

test("hidden pages and missing client revisions cannot consume later valid observations", t => {
  const f = fixture(t), report = createViewportDiagnostics();
  f.revision("");
  for (let i = 0; i < 80; i++) { f.advance(80); report(); }
  assert.equal(f.reports.length, 0);
  f.revision("a".repeat(40)); f.doc.visibilityState = "hidden"; report();
  assert.equal(f.reports.length, 0);
  f.doc.visibilityState = "visible"; report();
  assert.equal(f.reports.length, 1);
});


test("rate-limited frames retain excursion evidence without detailed geometry or hit testing", t => {
  const f = fixture(t), report = createViewportDiagnostics();
  const send = {
    getBoundingClientRect() { f.reads.rect++; return { left: 250, top: 106, width: 44, height: 44, bottom: 150 }; },
    contains: (element: unknown) => element === send,
  };
  const composer = {
    getBoundingClientRect() { f.reads.rect++; return { top: 20, bottom: 160 }; },
    querySelector: () => send,
  };
  f.doc.activeElement.closest = selector => selector === ".opencraft-composer-shell" ? composer : null;
  report();
  assert.deepEqual(f.reads, { rect: 7, style: 1, hit: 1 });
  const before = { ...f.reads };
  f.advance(16); f.top(-294); report();
  f.advance(16); f.top(0); report();
  assert.deepEqual(f.reads, { rect: before.rect + 4, style: before.style, hit: before.hit },
    "Only Shell and focused editor are measured on ineligible frames");
  f.advance(80); f.top(0); report();
  assert.deepEqual(f.reads, { rect: before.rect + 11, style: before.style + 1, hit: before.hit + 1 });
  assert.equal(f.reports.at(-1)!.editorMinTop, -294);
  assert.equal(f.reports.at(-1)!.shellMinTop, -294);
  assert.equal(f.reports.at(-1)!.observedSamples, 3);
});


test("unchanged reports cannot bypass the detailed measurement interval", t => {
  const f = fixture(t), report = createViewportDiagnostics();
  report();
  for (let i = 0; i < 30; i++) { f.advance(16); f.top(0); report(); }
  assert.equal(f.reports.length, 1, "Identical geometry stays deduplicated");
  assert.equal(f.reads.style, 7, "Detailed reads occur at 0, 80, 160, 240, 320, 400 and 480ms");
});


test("paint and safe content geometry are observed without inferring native status-bar pixels", t => {
  const f = fixture(t), report = createViewportDiagnostics();
  f.doc.activeElement.querySelector = selector => selector === ".app-shell-row"
    ? { getAttribute: () => "top", paddingTop: "47px", getBoundingClientRect: () => ({ top: 0, height: 844 }) }
    : { getBoundingClientRect: () => ({ top: 47, height: 44 }) };
  report();
  const result = f.reports.at(-1)!;
  assert.equal(result.screenHeight, 844); assert.equal(result.screenWidth, 390);
  assert.equal(result.rowTop, 0); assert.equal(result.rowPaddingTop, 47);
  assert.equal(result.headerTop, 47); assert.equal(result.standalone, 0);
  assert.equal(result.shellPaddingTop, 0);
  assert.equal(result.safeLayoutTop, 1);
  assert.ok(!("systemAppearance" in result));
});


test("enabled safe layout is distinguishable from a zero device inset", t => {
  const f = fixture(t), report = createViewportDiagnostics();
  f.doc.activeElement.querySelector = selector => selector === ".app-shell-row"
    ? { getAttribute: () => "top", paddingTop: "0px", getBoundingClientRect: () => ({ top: 0, height: 812 }) }
    : { getBoundingClientRect: () => ({ top: 0, height: 44 }) };
  report();
  assert.equal(f.reports.at(-1)!.safeLayoutTop, 1);
  assert.equal(f.reports.at(-1)!.rowPaddingTop, 0);
});
