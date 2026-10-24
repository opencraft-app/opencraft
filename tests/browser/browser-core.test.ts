import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserUrlError,
  browserUrlDisplayValue,
  computeBrowserViewportLayout,
  claimBrowserPresentation,
  commitBrowserPresentation,
  createBrowserPresentation,
  createBrowserHistory,
  currentBrowserHistoryEntry,
  intersectBrowserPresentationBounds,
  normalizeBrowserViewportMode,
  parkBrowserPresentation,
  rotateBrowserViewportMode,
  parseBrowserUrl,
  reduceBrowserHistory,
} from "@opencraft/browser-core";

test("browser presentation generations reject stale reveal and release work", () => {
  const initial = createBrowserPresentation({
    id: "view-a:right:tab-a",
    pageId: "page-a" as never,
    tabId: "tab-a" as never,
    viewId: "view-a",
    surface: "right-panel",
  });
  const first = claimBrowserPresentation(initial);
  const second = claimBrowserPresentation(first);
  const bounds = { x: 10, y: 20, width: 640, height: 480 };

  assert.equal(commitBrowserPresentation(second, first.generation, bounds), second);
  const visible = commitBrowserPresentation(second, second.generation, bounds);
  assert.equal(visible.phase, "visible");
  assert.equal(parkBrowserPresentation(visible, first.generation), visible);
  assert.equal(parkBrowserPresentation(visible, second.generation).phase, "parked");
});

test("browser presentation never paints outside its AppShell aperture", () => {
  assert.deepEqual(
    intersectBrowserPresentationBounds(
      { x: 0, y: 80, width: 1_200, height: 720 },
      { x: 820, y: 44, width: 380, height: 756 },
      { x: 0, y: 0, width: 1_200, height: 800 },
    ),
    { x: 820, y: 80, width: 380, height: 720 },
  );
});

test("responsive browser viewport is identical to its physical aperture", () => {
  assert.deepEqual(
    computeBrowserViewportLayout(
      { x: 320, y: 80, width: 680, height: 720 },
      { type: "responsive" },
    ),
    {
      stageBounds: { x: 320, y: 80, width: 680, height: 720 },
      visualBounds: { x: 320, y: 80, width: 680, height: 720 },
      viewportSize: { width: 680, height: 720 },
      scale: 1,
    },
  );
});

test("fit browser viewport keeps logical size while contain-scaling visual bounds", () => {
  assert.deepEqual(
    computeBrowserViewportLayout(
      { x: 300, y: 80, width: 700, height: 720 },
      { type: "fit", width: 1440, height: 900 },
    ),
    {
      stageBounds: { x: 300, y: 80, width: 700, height: 720 },
      visualBounds: { x: 320, y: 80, width: 660, height: 413 },
      viewportSize: { width: 1440, height: 900 },
      deviceProfile: "desktop",
      scale: 660 / 1440,
    },
  );
});

test("browser viewport input is normalized before persistence", () => {
  assert.deepEqual(
    normalizeBrowserViewportMode({
      type: "device",
      presetId: "tiny",
      width: 10,
      height: 10_000,
    }),
    { type: "device", presetId: "tiny", width: 240, height: 4096 },
  );
  assert.deepEqual(
    normalizeBrowserViewportMode({ type: "unknown" }),
    { type: "responsive" },
  );
});

test("fixed browser viewports rotate without losing their semantic mode", () => {
  assert.deepEqual(
    rotateBrowserViewportMode({
      type: "device",
      presetId: "ipad-air",
      width: 820,
      height: 1180,
    }),
    { type: "device", presetId: "ipad-air", width: 1180, height: 820 },
  );
  assert.deepEqual(
    rotateBrowserViewportMode({ type: "fit", width: 1440, height: 900 }),
    { type: "fit", width: 900, height: 1440 },
  );
  assert.deepEqual(
    rotateBrowserViewportMode({ type: "responsive" }),
    { type: "responsive" },
  );
});

test("browser URL policy normalizes domains and local development hosts", () => {
  assert.equal(parseBrowserUrl("example.com"), "https://example.com/");
  assert.equal(parseBrowserUrl("localhost:5173/demo"), "http://localhost:5173/demo");
  assert.equal(browserUrlDisplayValue(parseBrowserUrl("https://example.com/")), "example.com");
});

test("browser URL policy rejects executable schemes and embedded credentials", () => {
  assert.throws(
    () => parseBrowserUrl("javascript:alert(1)"),
    (error) => error instanceof BrowserUrlError && error.code === "unsupported-scheme",
  );
  assert.throws(
    () => parseBrowserUrl("https://user:secret@example.com"),
    (error) => error instanceof BrowserUrlError && error.code === "credentials",
  );
});

test("browser history truncates forward entries after a new navigation", () => {
  let history = createBrowserHistory({ url: parseBrowserUrl("a.example"), title: "A" });
  history = reduceBrowserHistory(history, {
    type: "navigate",
    entry: { url: parseBrowserUrl("b.example"), title: "B" },
  });
  history = reduceBrowserHistory(history, { type: "back" });
  assert.equal(currentBrowserHistoryEntry(history)?.title, "A");
  history = reduceBrowserHistory(history, {
    type: "navigate",
    entry: { url: parseBrowserUrl("c.example"), title: "C" },
  });
  assert.deepEqual(history.entries.map((entry) => entry.title), ["A", "C"]);
  assert.equal(history.index, 1);
});
