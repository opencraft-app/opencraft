import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceInternalDeveloperModeTitleTaps,
  consumeInternalDeveloperModeQuery,
  EMPTY_TITLE_TAP_SEQUENCE,
  getInternalDeveloperMode,
  INTERNAL_DEVELOPER_MODE_TITLE_TAP_COUNT,
  INTERNAL_DEVELOPER_MODE_TITLE_TAP_WINDOW_MS,
  pageUrlWithoutSearchAndHash,
  readInternalDeveloperModeQuery,
  setInternalDeveloperMode,
  stripInternalDeveloperModeQuery,
} from "../../apps/workbench-web/src/internal-developer-mode.ts";
import {
  clearRuntimeDiagnostics,
  getRuntimeDiagnosticErrors,
  getRuntimeDiagnosticNetwork,
  parseAppleVersions,
  probeCssSupports,
  recordRuntimeDiagnosticConsole,
  recordRuntimeDiagnosticError,
  recordRuntimeDiagnosticNetwork,
  RUNTIME_DIAGNOSTIC_ERROR_LIMIT,
  RUNTIME_DIAGNOSTIC_NETWORK_LIMIT,
} from "../../apps/workbench-web/src/runtime-diagnostics.ts";
import {
  bindSidebarLayoutPersistReporting,
  reportRuntimeError,
} from "../../apps/workbench-web/src/runtime-error-reporting.ts";

test("developer-mode query 1 enables and 0 disables, then the parameter is stripped", () => {
  setInternalDeveloperMode(false);
  assert.equal(readInternalDeveloperModeQuery("?opencraft-dev=1&keep=1"), true);
  assert.equal(readInternalDeveloperModeQuery("opencraft-dev=0"), false);
  assert.equal(readInternalDeveloperModeQuery("?other=1"), null);
  const stripped = stripInternalDeveloperModeQuery("https://join.example/app?opencraft-dev=1&keep=1#x");
  assert.equal(stripped.changed, true);
  assert.equal(stripped.nextHref, "/app?keep=1#x");
  const replacements: string[] = [];
  consumeInternalDeveloperModeQuery({
    href: "https://join.example/settings?opencraft-dev=1",
    search: "?opencraft-dev=1",
    replaceState(_data, _title, url) {
      if (typeof url === "string") replacements.push(url);
    },
  });
  assert.deepEqual(replacements, ["/settings"]);
  assert.equal(getInternalDeveloperMode(), true);
  consumeInternalDeveloperModeQuery({
    href: "https://join.example/settings?opencraft-dev=0",
    search: "?opencraft-dev=0",
    replaceState() {},
  });
  assert.equal(getInternalDeveloperMode(), false);
});

test("seven title taps inside three seconds toggle, a late tap restarts", () => {
  let state = EMPTY_TITLE_TAP_SEQUENCE;
  for (let index = 0; index < INTERNAL_DEVELOPER_MODE_TITLE_TAP_COUNT - 1; index += 1) {
    const result = advanceInternalDeveloperModeTitleTaps(state, index * 200);
    assert.equal(result.toggled, false);
    state = result.state;
  }
  const unlocked = advanceInternalDeveloperModeTitleTaps(state, 1_200);
  assert.equal(unlocked.toggled, true);

  const first = advanceInternalDeveloperModeTitleTaps(EMPTY_TITLE_TAP_SEQUENCE, 0);
  const stale = advanceInternalDeveloperModeTitleTaps(
    first.state,
    INTERNAL_DEVELOPER_MODE_TITLE_TAP_WINDOW_MS + 1,
  );
  assert.equal(stale.toggled, false);
  assert.equal(stale.state.count, 1);
});

test("page URLs drop query strings and hashes", () => {
  assert.equal(
    pageUrlWithoutSearchAndHash("https://join.example/servers/abc/chat?token=secret#frag"),
    "https://join.example/servers/abc/chat",
  );
  assert.equal(pageUrlWithoutSearchAndHash("/relative/path?x=1"), "/relative/path");
});

test("error and network rings drop the oldest entries past their limits", () => {
  clearRuntimeDiagnostics();
  for (let index = 0; index < RUNTIME_DIAGNOSTIC_ERROR_LIMIT + 5; index += 1) {
    recordRuntimeDiagnosticError({ source: "window-error", message: `err-${index}` });
  }
  const errors = getRuntimeDiagnosticErrors();
  assert.equal(errors.length, RUNTIME_DIAGNOSTIC_ERROR_LIMIT);
  assert.equal(errors[0]?.message, "err-5");
  assert.equal(errors.at(-1)?.message, "err-104");

  recordRuntimeDiagnosticConsole("console.warn", ["warn-only"]);
  assert.equal(getRuntimeDiagnosticErrors().at(-1)?.source, "console.warn");

  for (let index = 0; index < RUNTIME_DIAGNOSTIC_NETWORK_LIMIT + 3; index += 1) {
    recordRuntimeDiagnosticNetwork({
      channel: "fetch",
      event: "http-error",
      path: `/api/${index}`,
      status: 500,
      durationMs: 12,
    });
  }
  const network = getRuntimeDiagnosticNetwork();
  assert.equal(network.length, RUNTIME_DIAGNOSTIC_NETWORK_LIMIT);
  assert.equal(network[0]?.path, "/api/3");
  clearRuntimeDiagnostics();
  assert.equal(getRuntimeDiagnosticErrors().length, 0);
  assert.equal(getRuntimeDiagnosticNetwork().length, 0);
});

test("runtime error reports add device fields, strip the page URL, and accept new sources", async () => {
  const posts: unknown[] = [];
  const previousFetch = globalThis.fetch;
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousNavigator = (globalThis as { navigator?: unknown }).navigator;
  const previousDocument = (globalThis as { document?: unknown }).document;
  const previousInnerWidth = (globalThis as { innerWidth?: number }).innerWidth;
  const previousInnerHeight = (globalThis as { innerHeight?: number }).innerHeight;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { href: "https://join.example/app?secret=1#x", origin: "https://join.example", pathname: "/app" },
      innerWidth: 1024,
      innerHeight: 768,
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 Version/16.6 Mobile/15E148 Safari/604.1" },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector: (selector: string) => selector.includes("source-revision")
        ? { content: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
        : null,
    },
  });
  Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(globalThis, "innerHeight", { configurable: true, value: 768 });
  try {
    reportRuntimeError(new Error("catalog down"), "thread-catalog-load");
    await new Promise((resolve) => setImmediate(resolve));
    const body = (posts[0] as { body: Record<string, unknown> }).body;
    assert.equal(body.source, "thread-catalog-load");
    assert.equal(body.url, "https://join.example/app");
    assert.match(String(body.userAgent), /iPad/);
    assert.deepEqual(body.viewport, { width: 1024, height: 768 });
    assert.equal(body.sourceRevision, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(JSON.stringify(body).includes("secret=1"), false);

    const listeners = new Set<() => void>();
    let snapshot = { phase: "ready", error: null as string | null };
    bindSidebarLayoutPersistReporting({
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => snapshot,
    });
    snapshot = { phase: "error", error: "disk full" };
    for (const listener of listeners) listener();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((posts.at(-1) as { body: { source: string } }).body.source, "sidebar-layout-persist");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    if (previousNavigator === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else Object.defineProperty(globalThis, "navigator", { configurable: true, value: previousNavigator });
    if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: previousInnerWidth });
    Object.defineProperty(globalThis, "innerHeight", { configurable: true, value: previousInnerHeight });
    clearRuntimeDiagnostics();
  }
});

test("Apple version parsing and CSS probes stay bounded", () => {
  const versions = parseAppleVersions(
    "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  );
  assert.equal(versions.iosVersion, "16.7.10");
  assert.equal(versions.safariVersion, "16.6");
  const css = probeCssSupports((property, value) => property === "color" && Boolean(value?.includes("color-mix")));
  assert.equal(css.find((probe) => probe.id === "color-mix")?.supported, true);
  assert.equal(css.find((probe) => probe.id === "has")?.supported, false);
});
