import assert from "node:assert/strict";
import test from "node:test";
import { WebHostProxyBroker } from "../apps/workbench-web/src/browser/web-host-proxy-broker";
import { WebBrowserPageRuntime } from "../apps/workbench-web/src/browser/web-browser-runtime";
import { parseBrowserUrl } from "@opencraft/browser-core";

function installGlobals(values: Record<string, unknown>) {
  const descriptors = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  return () => {
    for (const key of Object.keys(values)) {
      const old = descriptors[key];
      if (old) Object.defineProperty(globalThis, key, old);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

test("proxy waits for its own activation, never document.ready or an unrelated controller", async () => {
  const worker = Object.assign(new EventTarget(), { state: "installing", postMessage: () => { binds += 1; } });
  let binds = 0, registers = 0;
  const registration = Object.assign(new EventTarget(), {
    active: null as typeof worker | null, installing: worker, waiting: null,
    update: async () => {},
  });
  const container = Object.assign(new EventTarget(), {
    register: async () => { registers += 1; return registration; },
    controller: { postMessage: () => { throw new Error("Foreign controller must not bind"); } },
  });
  Object.defineProperty(container, "ready", { get: () => { throw new Error("Document ready must not be read"); } });
  const restore = installGlobals({ navigator: { serviceWorker: container }, isSecureContext: true,
    window: { location: { origin: "https://lightvela.com" } } });
  const broker = new WebHostProxyBroker(async () => new Response("ok"));
  try {
    const started = broker.start();
    assert.equal(broker.start(), started);
    await Promise.resolve();
    assert.equal(binds, 0);
    assert.throws(() => broker.toPhysicalUrl(parseBrowserUrl("http://localhost:3000"), "host"));
    registration.active = worker;
    worker.state = "activated";
    worker.dispatchEvent(new Event("statechange"));
    assert.equal(await started, true);
    assert.equal(registers, 1);
    assert.equal(binds, 1);
    assert.match(broker.toPhysicalUrl(parseBrowserUrl("http://localhost:3000"), "host"), /host-proxy/);
    container.dispatchEvent(new Event("controllerchange"));
    assert.equal(binds, 2);
  } finally { broker.dispose(); restore(); }
});

test("disposing during registration cannot revive the proxy", async () => {
  let release!: (value: unknown) => void;
  let binds = 0;
  const registration = Object.assign(new EventTarget(), {
    active: { state: "activated", postMessage: () => { binds += 1; } }, installing: null, waiting: null,
  });
  const restore = installGlobals({ navigator: { serviceWorker: {
    register: () => new Promise(resolve => { release = resolve; }),
  } }, isSecureContext: true });
  const broker = new WebHostProxyBroker(async () => new Response("ok"));
  try {
    const started = broker.start();
    broker.dispose();
    release(registration);
    assert.equal(await started, false);
    assert.equal(binds, 0);
  } finally { broker.dispose(); restore(); }
});

test("unsupported proxy blocks remote loopback but does not gate public navigation", async () => {
  const restore = installGlobals({ navigator: {}, isSecureContext: true });
  const broker = new WebHostProxyBroker(async () => new Response("ok"));
  try {
    assert.equal(await broker.start(), false);
    const publicUrl = parseBrowserUrl("https://example.com");
    assert.equal(broker.prepareNavigation(publicUrl), null);
    assert.equal(broker.toPhysicalUrl(publicUrl, "host"), publicUrl);
    await assert.rejects(broker.prepareNavigation(parseBrowserUrl("http://localhost:3000"))!, /unavailable/);
  } finally { broker.dispose(); restore(); }
});

test("activation timeout cleans listeners and allows a later retry", async () => {
  let binds = 0;
  const worker = Object.assign(new EventTarget(), { state: "installing", postMessage: () => { binds += 1; } });
  const registration = Object.assign(new EventTarget(), {
    active: null as typeof worker | null, installing: worker, waiting: null, update: async () => {},
  });
  const container = Object.assign(new EventTarget(), { register: async () => registration });
  const restore = installGlobals({ navigator: { serviceWorker: container }, isSecureContext: true });
  const broker = new WebHostProxyBroker(async () => new Response("ok"));
  try {
    assert.equal(await broker.start(), false);
    registration.active = worker;
    worker.state = "activated";
    worker.dispatchEvent(new Event("statechange"));
    assert.equal(binds, 0, "timed-out activation listener must be removed");
    assert.equal(await broker.start(), true);
    assert.equal(binds, 1);
  } finally { broker.dispose(); restore(); }
});

test("pending previews never navigate raw loopback; stop/close/new URL fence late readiness", async () => {
  let ready!: () => void;
  const readiness = new Promise<void>(resolve => { ready = resolve; });
  const urls: Array<string | null> = [];
  const runtime = new WebBrowserPageRuntime({
    navigate: (_id: unknown, _title: unknown, url: string | null) => { urls.push(url); return true; },
    stop: () => {}, close: () => {},
  } as never, {
    prepareNavigation: url => url.includes("localhost") ? readiness : null,
    toPhysicalUrl: url => url.includes("localhost") ? parseBrowserUrl("https://app.test/proxied") : url,
    toLogicalUrl: url => url, isPhysicalProxyUrl: url => url.includes("proxied"),
  }, () => "host", { getItem: () => null, setItem: () => {} });
  try {
    const live = runtime.create({ ownerId: "owner", initialUrl: "http://localhost:3000" });
    runtime.prepareSurface(live);
    runtime.prepareSurface(live);
    assert.equal(runtime.getSnapshot(live)?.navigation.isLoading, true);
    const stopped = runtime.create({ ownerId: "owner" });
    runtime.navigate(stopped, "http://localhost:3000");
    runtime.stop(stopped);
    const closed = runtime.create({ ownerId: "owner" });
    runtime.navigate(closed, "http://localhost:3000");
    runtime.close(closed);
    const changed = runtime.create({ ownerId: "owner" });
    runtime.navigate(changed, "http://localhost:3000");
    runtime.navigate(changed, "https://example.com");
    assert.equal(urls.some(url => url?.includes("localhost")), false);
    ready();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(urls.filter(url => url === "https://app.test/proxied").length, 1);
    assert.equal(runtime.getSnapshot(stopped)?.navigation.isLoading, false);
    assert.equal(runtime.getSnapshot(changed)?.navigation.currentUrl, "https://example.com/");
  } finally { runtime.dispose(); }
});

test("proxy failure settles only the preview with a retryable error", async () => {
  const urls: Array<string | null> = [];
  const runtime = new WebBrowserPageRuntime({
    navigate: (_id: unknown, _title: unknown, url: string | null) => { urls.push(url); return true; },
  } as never, {
    prepareNavigation: () => Promise.reject(new Error("proxy unavailable")),
    toPhysicalUrl: url => url, toLogicalUrl: url => url, isPhysicalProxyUrl: () => false,
  }, () => "host", { getItem: () => null, setItem: () => {} });
  try {
    const page = runtime.create({ ownerId: "owner", initialUrl: "http://localhost:3000" });
    runtime.prepareSurface(page);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.getSnapshot(page)?.error, "proxy unavailable");
    assert.equal(runtime.getSnapshot(page)?.navigation.isLoading, false);
    assert.deepEqual(urls, [null]);
  } finally { runtime.dispose(); }
});
