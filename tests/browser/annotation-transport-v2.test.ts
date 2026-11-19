import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import {
  createAgentAnnotator,
  sanitizeFramePick,
  sanitizeFrameStyles,
} from "../../apps/workbench-web/src/browser-annotation/frame/frame-annotator";
import { RemoteBrowserSurfaceHost } from "../../apps/workbench-web/src/browser/remote-browser-surface-host";

const point = (x = 10, y = 20) => ({ x, y, frameWidth: 800, frameHeight: 600 });
const flush = async () => {
  for (let i = 0; i < 15; ++i) await Promise.resolve();
};

test("V2 untrusted evidence is bounded, redacted and cannot supply tool refs or host frame IDs", () => {
  const raw = {
    anchor: {
      kind: "text",
      ref: "trusted-tool-ref",
      selectedText: "x".repeat(3000),
      frame: "child",
      documentGeneration: "g".repeat(150),
      framePath: [{ selector: "#frame", documentGeneration: "doc", frameId: "forged", extra: true }],
      textLocator: { startPath: [0, 1], endPath: [0, 1], startOffset: 0, endOffset: 42 },
      elementMetadata: { good: "x", constructor: "forged", nonfinite: Infinity },
      rect: { x: Infinity, width: 1e100 },
    },
  };
  const pick = sanitizeFramePick(raw, { url: "/owned", title: "Owned" });
  assert.equal(pick.anchor.kind, "text");
  assert.equal(pick.anchor.selectedText?.length, 2000);
  assert.equal(pick.anchor.ref, "");
  assert.equal(pick.anchor.url, "/owned");
  assert.equal(pick.anchor.documentGeneration?.length, 100);
  assert.equal(pick.anchor.framePath?.[0]?.frameId, undefined);
  assert.equal(pick.anchor.rect.width, 10_000_000);
  assert.deepEqual(pick.anchor.elementMetadata, { good: "x" });
  const sensitive = sanitizeFramePick({ anchor: { ...raw.anchor, sensitive: true } }, { url: "/", title: "" });
  assert.equal(sensitive.anchor.selectedText, undefined);
  assert.equal(sensitive.anchor.textLocator, undefined);
  assert.equal(sensitive.anchor.elementMetadata, undefined);
  assert.deepEqual(
    sanitizeFrameStyles({
      color: "rgb(1,2,3)",
      width: "url(https://bad)",
      "background-image": "secret",
      constructor: "bad",
    }),
    { color: "rgb(1,2,3)" },
  );
});

test("channel routes V2 operations, rejects same-URL document replacement and restores current mode", async () => {
  const sent: Record<string, unknown>[] = [];
  let receive!: (data: Record<string, unknown>) => void, navigation!: () => void;
  const annotator = createAgentAnnotator({
    send: (message) => {
      sent.push(message);
    },
    subscribe: (listener) => {
      receive = listener;
      return () => {};
    },
    subscribeNavigation: (listener) => {
      navigation = listener;
      return () => {};
    },
    document: () => ({ url: "/same", title: "Page" }),
    capture: async () => "",
    captureSupported: false,
  });
  receive({ type: "ready" });
  assert.equal(annotator.capabilities?.preview, false);
  assert.equal(annotator.capabilities?.capture, false);
  await assert.rejects(annotator.preview!({ changes: [] }), /not allowed/);
  const region = annotator.pickRegion!({ start: point(), end: point(90, 90) });
  await flush();
  assert.equal(sent.at(-1)?.type, "region");
  receive({ type: "reply", id: sent.at(-1)?.id, ok: true, result: { anchor: { kind: "region" } } });
  assert.equal((await region).anchor.kind, "region");
  const pending = annotator.pickText!({ start: point(), end: point(90, 90) });
  const rejected = assert.rejects(pending, /navigated/);
  await flush();
  const id = sent.at(-1)?.id;
  navigation();
  receive({ type: "reply", id, ok: true, result: { anchor: { kind: "text" } } });
  await rejected;
  let drags = 0,
    taps = 0;
  const release = annotator.intercept({ mode: "text", tap: () => taps++, drag: () => drags++ });
  await flush();
  assert.equal(sent.at(-1)?.mode, "text");
  receive({ type: "drag", start: point(), end: point(40, 40) });
  receive({ type: "drag", start: point(), end: { ...point(), x: -1 } });
  receive({ type: "tap", point: point() });
  assert.equal(drags, 1);
  assert.equal(taps, 0);
  release();
  annotator.dispose();
});

test("production-minified injection executes real picker and selection factories with no bundler closure", async () => {
  const output = await build({
    entryPoints: ["apps/workbench-web/src/browser-annotation/frame/frame-source.ts"],
    bundle: true,
    write: false,
    minify: true,
    format: "iife",
    globalName: "FrameSource",
    platform: "browser",
  });
  const host = new JSDOM("", { runScripts: "outside-only", url: "https://host.test" });
  const factory = host.window.eval(output.outputFiles[0]!.text + ";FrameSource");
  const source = factory.annotationAgentSource({ token: "test", transport: { kind: "console" } });
  const dom = new JSDOM('<p id="target">Hello world</p>', {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "https://page.test",
  });
  const win = dom.window as any,
    messages: any[] = [];
  win.console.debug = (line: string) => messages.push(JSON.parse(line.slice("[opencraft-annotation] ".length)));
  win.document.elementsFromPoint = () => [win.document.querySelector("p")];
  win.document.querySelector("p").getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 200,
    bottom: 30,
    width: 200,
    height: 30,
  });
  win.eval(source);
  const send = (type: string, rest = {}) =>
    win[Symbol.for("opencraft.annotation.test")]({ channel: "opencraft-annotation", token: "test", type, ...rest });
  send("pick", { id: 1, point: { x: 10, y: 10, frameWidth: win.innerWidth, frameHeight: win.innerHeight } });
  assert.equal(messages.at(-1).ok, true);
  const anchor = messages.at(-1).result.anchor;
  send("styles", { id: 2, anchor });
  assert.equal(messages.at(-1).ok, true);
  send("region", {
    id: 3,
    start: { x: 10, y: 10, frameWidth: win.innerWidth, frameHeight: win.innerHeight },
    end: { x: 100, y: 100, frameWidth: win.innerWidth, frameHeight: win.innerHeight },
  });
  assert.equal(messages.at(-1).result.anchor.kind, "region");
  send("preview", { id: 4, input: { changes: [{ anchor, property: "color", value: "red" }] } });
  assert.equal(messages.at(-1).ok, false);
  assert.equal(win.document.querySelector("p").style.color, "");
  // A controlled preview host must grant policy when installing the runtime.
  win.eval(factory.annotationAgentSource({ token: "test", previewAllowed: true, transport: { kind: "console" } }));
  send("pick", { id: 5, point: { x: 10, y: 10, frameWidth: win.innerWidth, frameHeight: win.innerHeight } });
  const controlledAnchor = messages.at(-1).result.anchor;
  send("preview", { id: 6, input: { changes: [{ anchor: controlledAnchor, text: "Changed preview" }] } });
  assert.equal(messages.at(-1).ok, true);
  assert.equal(win.document.querySelector("p").textContent, "Changed preview");
  send("clearPreview", { id: 7 });
  assert.equal(messages.at(-1).ok, true);
  assert.equal(win.document.querySelector("p").textContent, "Hello world");
  const pointer = (type: string, x: number, y: number) => {
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y });
    win.document.querySelector("p").dispatchEvent(event);
    return event;
  };
  send("start", { mode: "region" });
  assert.equal(win.document.documentElement.style.touchAction, "none");
  pointer("pointerdown", 10, 10);
  pointer("pointercancel", 30, 30);
  pointer("pointerup", 30, 30);
  assert.equal(messages.filter((x) => x.type === "drag").length, 0);
  pointer("pointerdown", 10, 10);
  pointer("pointerup", 90, 90);
  assert.equal(messages.filter((x) => x.type === "drag").length, 1);
  send("start", { mode: "browse" });
  assert.equal(pointer("pointerdown", 10, 10).defaultPrevented, false);
  send("start", { mode: "element" });
  pointer("pointerdown", 10, 10);
  pointer("pointerup", 90, 90);
  assert.equal(messages.filter((x) => x.type === "tap").length, 0, "release distance also guards a lost move event");
  send("dispose");
  dom.window.close();
  host.window.close();
});

function remoteFixture() {
  const dom = new JSDOM("<div><canvas></canvas></div>", { pretendToBeVisual: true });
  const container = dom.window.document.querySelector("div")!,
    canvas = dom.window.document.querySelector("canvas")!;
  const bounds = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) };
  canvas.getBoundingClientRect = () => ({ ...bounds });
  let releases = 0;
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {
    releases++;
  };
  const p: any = {
    container,
    canvas,
    width: 800,
    height: 600,
    document: "doc-1",
    connection: 1,
    control: { token: "human" },
    ready: Promise.resolve(),
  };
  const host: any = Object.create(RemoteBrowserSurfaceHost.prototype),
    calls: any[] = [];
  Object.assign(host, {
    pages: new Map([["page", p]]),
    acceptsPointer: () => true,
    acquireControl: async () => "human",
    call: async (...args: any[]) => {
      calls.push(args);
      return {};
    },
  });
  const pointer = (name: string, x: number, y: number) => {
    const event = new dom.window.Event(name, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y });
    canvas.dispatchEvent(event);
    return event;
  };
  return { dom, host, p, calls, pointer, bounds, releases: () => releases };
}

test("remote region/text drag never scrolls, cancels cleanly and validates release geometry", async () => {
  const previousRaf = globalThis.requestAnimationFrame,
    previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  try {
    for (const mode of ["region", "text"]) {
      const f = remoteFixture();
      let drags = 0,
        taps = 0;
      const release = f.host.interceptAnnotation(f.p, { mode, tap: () => taps++, drag: () => drags++ });
      f.pointer("pointerdown", 10, 10);
      f.pointer("pointermove", 40, 40);
      f.pointer("pointerup", 50, 50);
      await flush();
      assert.equal(drags, 1);
      assert.equal(taps, 0);
      assert.equal(f.calls.length, 0);
      assert.equal(f.releases(), 1);
      f.pointer("pointerdown", 10, 10);
      f.pointer("pointercancel", 40, 40);
      f.pointer("pointerup", 50, 50);
      assert.equal(drags, 1);
      assert.equal(f.releases(), 2);
      f.pointer("pointerdown", 10, 10);
      f.bounds.width = 700;
      f.pointer("pointerup", 50, 50);
      assert.equal(drags, 1);
      release();
      f.dom.window.close();
    }
    const f = remoteFixture();
    const release = f.host.interceptAnnotation(f.p, { mode: "browse", tap: () => assert.fail("browse picked") });
    assert.equal(f.pointer("pointerdown", 10, 10).defaultPrevented, false);
    release();
    f.dom.window.close();
  } finally {
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.cancelAnimationFrame = previousCancel;
  }
});

test("remote annotations route all V2 commands and discard replies across same-URL reloads", async () => {
  const f = remoteFixture(),
    annotator = f.host.annotate("page");
  assert.equal(annotator.capabilities.preview, false);
  await annotator.pickRegion({ start: point(), end: point(50, 50) });
  assert.equal(f.calls.at(-1)[2].method, "annotateRegion");
  await annotator.pickText({ start: point(), end: point(50, 50) });
  assert.equal(f.calls.at(-1)[2].method, "annotateText");
  await annotator.readStyles({ bindingKey: "key" });
  assert.equal(f.calls.at(-1)[2].method, "annotateStyles");
  await annotator.clearPreview();
  assert.equal(f.calls.at(-1)[2].method, "annotateClearPreview");
  let resolve!: (value: unknown) => void;
  f.host.call = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = annotator.pick({ point: point() }),
    rejected = assert.rejects(pending, /document changed/);
  await flush();
  f.p.document = "doc-2";
  resolve({ anchor: {} });
  await rejected;
  f.dom.window.close();
});

test("production guest console transport retires pending work at navigation start, including same-URL reloads", async () => {
  const bundle = await build({
    entryPoints: ["apps/workbench-web/src/browser-annotation/frame/guest-annotator.ts"],
    bundle: true,
    write: false,
    minify: true,
    format: "iife",
    globalName: "Guest",
    platform: "browser",
  });
  const host = new JSDOM("", { runScripts: "outside-only", url: "https://host.test" });
  const factory = host.window.eval(bundle.outputFiles[0]!.text + ";Guest");
  const listeners = new Map<string, Set<(event: any) => void>>();
  let delayed = false;
  const queued: string[] = [];
  const makePage = () => {
    const dom = new JSDOM("<p>Target</p>", {
      runScripts: "outside-only",
      pretendToBeVisual: true,
      url: "https://page.test",
    });
    dom.window.console.debug = (message: string) => {
      if (delayed) queued.push(message);
      else for (const listener of listeners.get("console-message") ?? []) listener({ message });
    };
    return dom;
  };
  let current = makePage();
  const annotator = factory.createGuestAnnotator({
    getURL: () => "https://page.test",
    getTitle: () => "Page",
    capturePage: async () => ({ toDataURL: () => "data:image/png;base64," }),
    executeJavaScript: async (code: string) => current.window.eval(code),
    addEventListener: (type: string, listener: (event: any) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (event: any) => void) => listeners.get(type)?.delete(listener),
  });
  const start = { x: 10, y: 20, frameWidth: 1024, frameHeight: 768 },
    end = { ...start, x: 100, y: 100 };
  assert.equal((await annotator.pickRegion({ start, end })).anchor.kind, "region");
  delayed = true;
  const pending = annotator.pickRegion({ start, end });
  const rejected = assert.rejects(pending, /navigated/);
  await flush();
  for (const listener of listeners.get("did-start-navigation") ?? []) listener({ isMainFrame: true, isInPlace: false });
  for (const message of queued.splice(0))
    for (const listener of listeners.get("console-message") ?? []) listener({ message });
  await rejected;
  current.window.close();
  current = makePage();
  delayed = false;
  annotator.refresh();
  assert.equal((await annotator.pickRegion({ start, end })).anchor.kind, "region");
  annotator.dispose();
  await flush();
  current.window.close();
  host.window.close();
  assert.equal(listeners.get("did-start-navigation")?.size, 0);
});

test("a retired document send failure cannot reject replacement-document work", async () => {
  let receive!: (data: Record<string, unknown>) => void, navigate!: () => void, rejectOld!: (error: Error) => void;
  const sent: Record<string, unknown>[] = [];
  const annotator = createAgentAnnotator({
    document: () => ({ url: "/same", title: "" }),
    capture: async () => "",
    subscribe: (listener) => {
      receive = listener;
      return () => {};
    },
    subscribeNavigation: (listener) => {
      navigate = listener;
      return () => {};
    },
    send: (message) => {
      sent.push(message);
      if (sent.length === 1)
        return new Promise<void>((_resolve, reject) => {
          rejectOld = reject;
        });
    },
  });
  const first = annotator.pick({ point: point() });
  const rejected = assert.rejects(first, /navigated/);
  await flush();
  navigate();
  await rejected;
  const second = annotator.pick({ point: point() });
  await flush();
  rejectOld(new Error("Old guest went away"));
  await flush();
  receive({ type: "reply", id: sent.at(-1)?.id, ok: true, result: { anchor: { kind: "element" } } });
  assert.equal((await second).anchor.kind, "element");
  annotator.dispose();
});

test("late frame and remote captures cannot become evidence for a replacement document", async () => {
  let navigation!: () => void, finishFrame!: (value: string) => void;
  const frame = createAgentAnnotator({
    document: () => ({ url: "/same", title: "" }),
    subscribe: () => () => {},
    send: () => {},
    subscribeNavigation: (listener) => {
      navigation = listener;
      return () => {};
    },
    capture: () =>
      new Promise((resolve) => {
        finishFrame = resolve;
      }),
  });
  const first = frame.capture(),
    firstRejected = assert.rejects(first, /navigated/);
  navigation();
  finishFrame("data:image/png;base64,old");
  await firstRejected;
  frame.dispose();
  const f = remoteFixture();
  let finishRemote!: (value: string) => void;
  f.host.capture = () =>
    new Promise((resolve) => {
      finishRemote = resolve;
    });
  const second = f.host.annotate("page").capture(),
    secondRejected = assert.rejects(second, /document changed/);
  f.p.document = "doc-2";
  finishRemote("data:image/png;base64,old");
  await secondRejected;
  f.dom.window.close();
});
