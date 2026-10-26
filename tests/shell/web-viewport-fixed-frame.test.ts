import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createWebTimelineViewportPort } from "../../packages/timeline-host-web/src/viewport";

function fixture(onGeometryObserved?: (event?: Event) => void) {
  const dom = new JSDOM("<input value='preserve draft'>", { pretendToBeVisual: true });
  const win = dom.window;
  const oldHTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement;
  Object.defineProperty(win.navigator, "userAgent", { value: "iPhone" });
  Object.defineProperty(win.document.documentElement, "clientHeight", { value: 688 });
  Object.defineProperty(win.document.documentElement, "clientWidth", { value: 402 });
  Object.defineProperty(win, "innerHeight", { value: 394 });
  Object.defineProperty(win, "innerWidth", { value: 402 });
  const visual = Object.assign(new win.EventTarget(), {
    width: 402, height: 394, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1,
  });
  Object.defineProperty(win, "visualViewport", { value: visual });
  const native = { top: 0, left: 0 };
  const getRect = win.HTMLElement.prototype.getBoundingClientRect;
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute("data-timeline-fixed-reference")) {
      return { top: native.top, left: native.left, x: native.left, y: native.top,
        width: 0, height: 0, right: native.left, bottom: native.top, toJSON: () => ({}) };
    }
    return getRect.call(this);
  };
  let now = 0, id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  win.performance.now = () => now;
  win.requestAnimationFrame = fn => { frames.set(++id, fn); return id; };
  win.cancelAnimationFrame = key => { frames.delete(key); };
  const port = createWebTimelineViewportPort(win as unknown as Window, win.document, { kind: "browser", platform: "linux", onGeometryObserved });
  const input = win.document.querySelector("input")!;
  const css = (axis: "top" | "left") => Number.parseFloat(win.document.documentElement.style.getPropertyValue(`--timeline-available-viewport-${axis}`));
  return { win, visual, native, port, input, frames, css,
    frame(at: number) { now = at; const work = [...frames.values()]; frames.clear(); work.forEach(fn => fn(now)); },
    scroll(top: number, left = 0) {
      Object.defineProperty(win, "scrollY", { configurable: true, value: top });
      Object.defineProperty(win, "scrollX", { configurable: true, value: left });
    },
    close() { port.dispose(); dom.window.close();
      if (oldHTMLElement === undefined) Reflect.deleteProperty(globalThis, "HTMLElement"); else globalThis.HTMLElement = oldHTMLElement; },
  };
}

test("viewport contraction stays distinct from editable keyboard inference", () => {
  const f = fixture();
  try {
    const root = f.win.document.documentElement;
    assert.equal(root.dataset.timelineViewportOccluded, "true");
    assert.equal(root.dataset.timelineKeyboardOpen, "false");
    f.visual.height = 688;
    f.visual.dispatchEvent(new f.win.Event("resize"));
    assert.equal(root.dataset.timelineViewportOccluded, "false");
    f.input.focus();
    f.visual.height = 394;
    f.visual.dispatchEvent(new f.win.Event("resize"));
    f.input.blur(); f.frame(10);
    assert.equal(root.dataset.timelineKeyboardOpen, "false");
    assert.equal(root.dataset.timelineViewportOccluded, "true");
    assert.equal(root.style.getPropertyValue("--timeline-available-viewport-height"), "394px");
  } finally { f.close(); }
});

test("fixed frame separates native fixed basis from reported visual offset in either update order", () => {
  const f = fixture();
  try {
    f.input.focus(); f.input.setSelectionRange(2, 2);
    const stages = [
      // Ordinary layout-relative client rectangles.
      { page: 294, scroll: 0, native: 0, offset: 294 },
      // WKWebView tuple seen on device, before and after native plane movement.
      { page: 294, scroll: 294, native: 0, offset: 294 },
      { page: 294, scroll: 294, native: -294, offset: 294 },
      // Native plane recovery may precede the final VisualViewport offset event.
      { page: 0, scroll: 0, native: 0, offset: 294 },
      { page: 0, scroll: 0, native: 0, offset: 0 },
      // The reverse ordering must also keep one coordinate conversion.
      { page: 0, scroll: 0, native: -294, offset: 0 },
      { page: 294, scroll: 294, native: -294, offset: 294 },
    ];
    stages.forEach((stage, i) => {
      Object.assign(f.visual, { pageTop: stage.page, offsetTop: stage.offset });
      f.scroll(stage.scroll); f.native.top = stage.native; f.frame(20 + i * 20);
      const visibleClientOrigin = stage.page - stage.scroll;
      assert.equal(f.css("top") + stage.native - visibleClientOrigin, 0, JSON.stringify(stage));
      assert.equal(f.win.document.documentElement.style.getPropertyValue("--timeline-available-viewport-height"), "394px");
    });
    assert.equal(f.port.getSnapshot().layoutViewport.heightPx, 688, "CSS layout extent is not innerHeight's visual reduction");
    assert.equal(f.port.getSnapshot().visualOffset.topPx, 294, "raw report remains raw");
    assert.equal(f.win.document.activeElement, f.input); assert.equal(f.input.selectionStart, 2);
    assert.equal(f.input.value, "preserve draft");
  } finally { f.close(); }
});

test("late native plane changes publish even when all raw viewport metrics are unchanged", () => {
  const f = fixture();
  try {
    f.frame(20); const before = f.port.getSnapshot();
    f.native.top = -294; f.frame(40);
    assert.equal(f.css("top"), 294);
    assert.equal(f.port.getSnapshot().revision, before.revision + 1);
    assert.deepEqual(f.port.getSnapshot().visualOffset, before.visualOffset);
    f.frame(60); assert.equal(f.port.getSnapshot().revision, before.revision + 1);
    f.native.top = 20; f.native.left = -25; f.scroll(0, 25); f.visual.pageLeft = 25; f.frame(80);
    assert.equal(f.css("top"), -20, "basis changes are signed, not clamped native pan");
    assert.equal(f.css("left"), 25);
    f.frame(1100); assert.equal(f.frames.size, 0, "no perpetual layout polling");
    f.port.dispose(); assert.equal(f.win.document.querySelector("[data-timeline-fixed-reference]"), null);
  } finally { f.close(); }
});

test("pinch magnification retains layout capacity and does not apply fixed-frame compensation", () => {
  const f = fixture();
  try {
    f.visual.scale = 2; f.visual.height = 197; f.native.top = -100; f.frame(20);
    assert.equal(f.css("top"), 0);
    assert.equal(f.win.document.documentElement.style.getPropertyValue("--timeline-available-viewport-height"), "688px");
  } finally { f.close(); }
});

test("a capacity commit measures the fixed basis after layout-induced native focus pan", () => {
  const f = fixture();
  try {
    f.visual.height = 688; f.frame(20);
    f.input.focus(); f.input.setSelectionRange(2, 2);
    const style = f.win.document.documentElement.style;
    const setProperty = style.setProperty.bind(style);
    style.setProperty = (name, value, priority) => {
      setProperty(name, value, priority);
      if (name === "--timeline-available-viewport-height" && value === "394px") {
        // On-device observation: capacity changes first, native focus pan then
        // changes the zero-inset fixed plane before subscribers/browser paint.
        f.native.top = -294; f.scroll(294);
        f.visual.pageTop = 294; f.visual.offsetTop = 294;
      }
    };
    const samples: number[] = [];
    f.port.subscribe(() => samples.push(f.css("top") + f.native.top - (f.visual.pageTop - f.win.scrollY)));
    f.visual.height = 394; f.frame(40);
    assert.deepEqual(samples, [0], "Subscribers must see the committed capacity and its current coordinate basis together");
    assert.equal(f.css("top"), 294);
    assert.equal(f.win.document.activeElement, f.input);
    assert.equal(f.input.selectionStart, 2); assert.equal(f.input.value, "preserve draft");
  } finally { f.close(); }
});

test("mobile viewport events commit before returning even after the current animation frame", () => {
  const f = fixture();
  try {
    f.frame(20);
    f.native.top = -294; f.scroll(294);
    Object.assign(f.visual, { height: 394, pageTop: 294, offsetTop: 294 });
    f.visual.dispatchEvent(new f.win.Event("resize"));
    assert.equal(f.css("top"), 294, "No stale origin while waiting for a later rAF");
    const revision = f.port.getSnapshot().revision;
    f.frame(40);
    assert.equal(f.port.getSnapshot().revision, revision, "Settling does not duplicate a committed observation");
    f.native.top = 0; f.scroll(0);
    Object.assign(f.visual, { height: 688, pageTop: 0, offsetTop: 0 });
    f.win.dispatchEvent(new f.win.Event("scroll"));
    assert.equal(f.css("top"), 0);
  } finally { f.close(); }
});


test("keyboard pan reported as pageTop=scrollY=offsetTop keeps the frame above the keyboard", () => {
  const f = fixture();
  try {
    f.input.focus(); f.input.setSelectionRange(2, 2);
    f.native.top = -294; f.scroll(294);
    Object.assign(f.visual, { height: 394, offsetTop: 294, pageTop: 294 });
    f.visual.dispatchEvent(new f.win.Event("resize"));
    // Physical 09:04 capture: a client top of 294 is displayed at y=294,
    // not at zero. No extra crop/offset subtraction is permitted for this tuple.
    const clientTop = f.css("top") + f.native.top;
    assert.equal(clientTop, 0);
    const sendBottom = clientTop + 371;
    assert.ok(sendBottom <= 394, "The send action must fit above the keyboard");
    assert.equal(f.port.getSnapshot().visualOffset.topPx, 294, "Keep raw native observations");
    assert.equal(f.win.document.activeElement, f.input);
    assert.equal(f.input.selectionStart, 2); assert.equal(f.input.value, "preserve draft");
    f.native.left = -30; f.visual.pageLeft = 30; f.visual.offsetLeft = 30;
    f.scroll(294, 30); f.visual.dispatchEvent(new f.win.Event("scroll"));
    assert.equal(f.css("left") + f.native.left, 0);
  } finally { f.close(); }
});


test("one viewport frame owner samples unchanged geometry and nested scroll evidence", () => {
  const observed: (string | undefined)[] = [];
  const f = fixture(event => observed.push(event?.type));
  try {
    f.frame(20);
    const revision = f.port.getSnapshot().revision;
    f.frame(40);
    assert.equal(f.port.getSnapshot().revision, revision);
    assert.equal(observed.length, 2, "Evidence must not depend on snapshot publication");
    f.input.dispatchEvent(new f.win.Event("touchstart", { bubbles: true }));
    f.visual.dispatchEvent(new f.win.Event("resize"));
    assert.equal(observed.at(-1), "touchstart", "A viewport event cannot erase the contact observation");
    f.input.dispatchEvent(new f.win.Event("scroll", { bubbles: false }));
    assert.equal(f.frames.size, 1, "Nested scroll shares the existing pending frame");
    f.frame(60);
    assert.equal(observed.at(-1), "scroll", "Capture-phase observation includes local focus-reveal scroll");
    f.frame(900);
    f.native.top = -294;
    f.frame(950);
    assert.equal(f.css("top"), 294, "Early stable frames cannot end the late-native compatibility grace");
    f.frame(1100);
    assert.equal(f.frames.size, 0, "Observation does not renew its own deadline");
    f.input.dispatchEvent(new f.win.Event("touchstart", { bubbles: true }));
    assert.equal(f.frames.size, 1);
    f.port.dispose();
    assert.equal(f.frames.size, 0);
    const count = observed.length;
    f.input.dispatchEvent(new f.win.Event("scroll", { bubbles: false }));
    f.visual.dispatchEvent(new f.win.Event("resize"));
    f.frame(1200);
    assert.equal(observed.length, count, "Disposal releases both observation and projection");
  } finally { f.close(); }
});

test("hidden hosts cancel the shared observation window and resume from actual geometry", () => {
  let observations = 0;
  const f = fixture(() => observations++);
  try {
    f.frame(20);
    Object.defineProperty(f.win.document, "visibilityState", { configurable: true, value: "hidden" });
    f.win.document.dispatchEvent(new f.win.Event("visibilitychange"));
    assert.equal(f.frames.size, 0);
    f.native.top = -294;
    f.visual.dispatchEvent(new f.win.Event("scroll"));
    assert.equal(observations, 1);
    Object.defineProperty(f.win.document, "visibilityState", { configurable: true, value: "visible" });
    f.win.document.dispatchEvent(new f.win.Event("visibilitychange"));
    f.frame(40);
    assert.equal(f.css("top"), 294);
    assert.equal(observations, 2);
  } finally { f.close(); }
});


test("document and fixed frames map the same visible origin through independent bases", () => {
  const f = fixture();
  try {
    for (const [page, scroll, native] of [[294, 0, 0], [294, 294, -294], [310, 294, 0], [0, 0, 0]]) {
      f.scroll(scroll);f.native.top = native;f.visual.pageTop = page;f.visual.offsetTop = page-scroll;
      f.visual.dispatchEvent(new f.win.Event("scroll"));
      const documentTop = Number.parseFloat(f.win.document.documentElement.style.getPropertyValue("--timeline-document-viewport-top"));
      const visibleClientTop = page-scroll;
      assert.equal(documentTop-scroll,visibleClientTop,"flow frame is positioned in document coordinates");
      assert.equal(f.css("top")+native,visibleClientTop,"fixed frame retains the independent native reference");
    }
  } finally { f.close(); }
});

test("document-origin changes publish even when fixed-client geometry stays unchanged", () => {
  const f = fixture();
  try {
    f.frame(20);const revision=f.port.getSnapshot().revision;
    f.scroll(100);f.visual.pageTop=100;f.visual.dispatchEvent(new f.win.Event("scroll"));
    assert.equal(f.css("top"),0);
    assert.equal(f.win.document.documentElement.style.getPropertyValue("--timeline-document-viewport-top"),"100px");
    assert.equal(f.port.getSnapshot().revision,revision+1);
  } finally { f.close(); }
});

test("resting overlay canvas stays CSS-owned while the existing port projects contraction", () => {
  const f = fixture();
  try {
    const root = f.win.document.documentElement;
    Object.assign(root.dataset, { windowHost: "browser", windowDisplayMode: "standalone", windowEdgeStrategy: "legacy-overlay-requested" });
    for (const height of [688, 750, 688]) {
      Object.defineProperty(f.win, "innerHeight", { configurable: true, value: height });
      f.visual.height = height; f.visual.dispatchEvent(new f.win.Event("resize"));
      assert.equal(root.dataset.timelineViewportOccluded, "false");
      assert.equal(root.dataset.timelineKeyboardOpen, "false");
      assert.equal(root.style.getPropertyValue("--timeline-visible-viewport-height"), "", "no measurement may replace the resting CSS canvas");
    }
    f.input.focus(); f.input.setSelectionRange(2, 2);
    f.visual.height = 394; f.visual.dispatchEvent(new f.win.Event("resize"));
    assert.equal(root.dataset.timelineViewportOccluded, "true");
    assert.equal(root.dataset.timelineKeyboardOpen, "true");
    assert.equal(root.style.getPropertyValue("--timeline-available-viewport-height"), "394px");
    f.input.blur(); f.frame(20);
    assert.equal(root.dataset.timelineKeyboardOpen, "false");
    assert.equal(root.dataset.timelineViewportOccluded, "true", "blur must not restore CSS capacity before the native frame recovers");
    f.visual.height = 688; f.visual.dispatchEvent(new f.win.Event("resize"));
    assert.equal(root.dataset.timelineViewportOccluded, "false");
    f.visual.scale = 2; f.visual.height = 344; f.visual.dispatchEvent(new f.win.Event("resize"));
    assert.equal(root.dataset.timelineViewportOccluded, "false", "pinch alone is not keyboard contraction");
    assert.equal(root.style.getPropertyValue("--timeline-visible-viewport-height"), "");
    assert.equal(f.input.value, "preserve draft"); assert.equal(f.input.selectionStart, 2);
  } finally { f.close(); }
});
