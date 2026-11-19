import { setLocalDiagnosticsEnabled } from "../../apps/workbench-web/src/runtime/local-diagnostics";
import assert from "node:assert/strict";
import test from "node:test";
test.beforeEach(() => {
  setLocalDiagnosticsEnabled(false);
  setLocalDiagnosticsEnabled(true);
});
import { JSDOM } from "jsdom";
import {
  captureViewportHistory,
  recordViewportDiagnostic,
  VIEWPORT_HISTORY_LIMIT,
} from "../../apps/workbench-web/src/runtime/viewport-history";
import {
  createBrowserDiagnosticReport,
  downloadBrowserDiagnostics,
} from "../../apps/workbench-web/src/browser-diagnostics";
import {
  clearRuntimeDiagnostics,
  recordRuntimeDiagnosticConsole,
  recordRuntimeDiagnosticNetwork,
} from "../../apps/workbench-web/src/runtime-diagnostics";

test("bounded viewport history retains the editing sample after the menu closes the keyboard", () => {
  recordViewportDiagnostic({ editing: 1, visualHeight: 394, composerBottom: 378 }, "resize");
  for (let i = 0; i < VIEWPORT_HISTORY_LIMIT + 5; i++) recordViewportDiagnostic({ editing: 0, visualHeight: 688 });
  const report = captureViewportHistory();
  assert.equal(report.samples.length, VIEWPORT_HISTORY_LIMIT);
  assert.equal(report.lastEditing?.geometry.composerBottom, 378);
  (report.samples[0]!.geometry as Record<string, number>).visualHeight = 0;
  assert.equal(
    captureViewportHistory().samples[0]!.geometry.visualHeight,
    688,
    "export cannot mutate retained evidence",
  );
});

test("download preserves editing geometry, exports known probes and excludes page content and storage", (t) => {
  const dom = new JSDOM(
    `<meta name="opencraft-source-revision" content="${"a".repeat(40)}"><div class="app-shell-root"><div class="opencraft-composer-shell"><textarea>private draft</textarea><button class="opencraft-composer-submit">private transcript</button></div></div>`,
    { url: "https://local.test/chat?token=secret-query#secret-hash" },
  );
  const win = dom.window;
  const values = {
    window: win,
    document: win.document,
    HTMLElement: win.HTMLElement,
    navigator: win.navigator,
    screen: win.screen,
    getComputedStyle: win.getComputedStyle.bind(win),
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  t.after(() => {
    clearRuntimeDiagnostics();
    dom.window.close();
  });
  win.localStorage.setItem("private", "secret-storage");
  win.document.cookie = "private=secret-cookie";
  const input = win.document.querySelector("textarea")!;
  input.focus();
  recordViewportDiagnostic({ editing: 1, composerBottom: 378 });
  input.blur();
  recordRuntimeDiagnosticConsole("console.warn", [
    "failed https://local.test/path?token=secret-url#secret-fragment Bearer secret-bearer api_key=secret-key",
  ]);
  recordRuntimeDiagnosticConsole("console.warn", [{ apiKey: "secret-json" }]);
  recordRuntimeDiagnosticNetwork({ channel: "fetch", event: "network-error", path: "/apphost", durationMs: 20 });
  const report = createBrowserDiagnosticReport();
  assert.equal(report.viewport.lastEditing?.geometry.editing, 1);
  assert.equal(report.current.layout.focusedEditable, false);
  assert.ok(report.current.layout.elements.shell);
  assert.ok(report.css.length > 0);
  assert.equal(report.runtime.network.at(-1)?.path, "/apphost");
  const json = JSON.stringify(report);
  for (const secret of [
    "private draft",
    "private transcript",
    "secret-storage",
    "secret-cookie",
    "secret-query",
    "secret-hash",
    "secret-url",
    "secret-fragment",
    "secret-bearer",
    "secret-key",
    "secret-json",
  ])
    assert.ok(!json.includes(secret), secret);

  let blob: Blob | null = null,
    filename = "",
    revoked = "";
  const oldCreate = URL.createObjectURL,
    oldRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (value) => {
    blob = value as Blob;
    return "blob:diagnostic";
  };
  URL.revokeObjectURL = (value) => {
    revoked = value;
  };
  t.after(() => {
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
  });
  win.HTMLAnchorElement.prototype.click = function () {
    filename = this.download;
  };
  let cleanup: (() => void) | undefined;
  win.setTimeout = ((callback: () => void) => {
    cleanup = callback;
    return 1;
  }) as typeof win.setTimeout;
  downloadBrowserDiagnostics();
  assert.match(filename, /^opencraft-diagnostics-.*\.json$/);
  assert.equal((blob as Blob | null)?.type, "application/json");
  assert.equal(win.document.querySelector("a[download]"), null);
  assert.equal(revoked, "", "download navigation consumes the Blob before cleanup");
  cleanup!();
  assert.equal(revoked, "blob:diagnostic");
});

test("reduced editing evidence survives a later focused sample after native keyboard dismissal", () => {
  recordViewportDiagnostic({
    editing: 1,
    scale: 1,
    clientHeight: 776,
    visualHeight: 379,
    composerBottom: 329,
    safeBottom: 34,
  });
  recordViewportDiagnostic({ editing: 1, scale: 1, clientHeight: 776, visualHeight: 776, composerBottom: 726 });
  assert.equal(captureViewportHistory().lastReducedEditing?.geometry.composerBottom, 329);
  assert.equal(captureViewportHistory().lastEditing?.geometry.composerBottom, 726);
});
