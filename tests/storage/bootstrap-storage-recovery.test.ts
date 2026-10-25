import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../../apps/workbench-web/index.html", import.meta.url), "utf8");
const bootstrap = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).find(script => script.includes("isResizeObserverDeliveryWarning"))!;

function fixture({ recoverySupported = false, recovered = false, latestBuildId = "same-build",
  stored = new Map<string, string>() } = {}) {
  const listeners = new Map<string, (event: any) => void>();
  const reports: { url: string; body?: any }[] = [];
  const elements = new Map<string, any>();
  const field = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, { textContent: "", hidden: false, addEventListener() {} });
    return elements.get(selector);
  };
  let surface: any = null;
  let reloads = 0;
  const navigations: string[] = [];
  const context = vm.createContext({
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
    document: {
      getElementById: () => surface,
      querySelector: (selector: string) => ({ getAttribute: () => selector.includes("resource-recovery") ? (recoverySupported ? "supported" : null) : "same-build", setAttribute() {} }),
      createElement: () => ({ style: {}, setAttribute() {}, querySelector: field }),
      body: { append: (element: any) => { surface = element; } },
      documentElement: { dataset: {}, classList: { add() {} }, style: {} },
    },
    fetch: async (url: string, options?: { body?: string }) => {
      reports.push({ url, body: options?.body ? JSON.parse(options.body) : undefined });
      return { ok: true, json: async () => ({ buildId: latestBuildId }) };
    },
    URL,
    navigator: { userAgent: "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 Version/16.6 Mobile/15E148 Safari/604.1" },
    innerWidth: 1024,
    innerHeight: 768,
    location: { origin: "https://example.test", pathname: "/local/thread", href: `https://example.test/local/thread?keep=1${recovered ? "&opencraft-resource-recovery=prior" : ""}`, reload: () => { ++reloads; }, replace: (url: string) => { navigations.push(url); } },
    localStorage: { getItem: () => null },
    sessionStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
    setTimeout() {},
  });
  vm.runInContext(bootstrap, context);
  return { context, listeners, reports, field, navigations, reloads: () => reloads };
}

test("Vite must propagate storage evaluation failures to the application boundary", () => {
  const f = fixture();
  let prevented = false;
  f.listeners.get("vite:preloadError")!({
    payload: { name: "BrowserStorageError", message: "Browser storage timeout" },
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, false, "preventDefault would turn a rejected import into undefined");
  assert.equal(f.reports.length, 0, "the owning application boundary reports the failure");
});

test("pre-React storage recovery preserves data and never tries release reload", async () => {
  const f = fixture();
  await vm.runInContext(`__opencraftRecoverRelease(Object.assign(new Error('Browser storage timeout'), {
    name: 'BrowserStorageError', storageDiagnostics: { storage: 'host-profiles', stage: 'opening', elapsedMs: 10000 }
  }))`, f.context);
  assert.equal(f.field("[data-recovery-title]").textContent, "暂时无法读取本地配置");
  assert.match(f.field("[data-recovery-summary]").textContent, /已保存的配置会保留/);
  assert.equal(f.field("[data-release-error]").hidden, true);
  assert.equal(f.field("[data-release-error]").textContent, "");
  assert.equal(f.reloads(), 0);
  assert.deepEqual(f.reports.map(report => report.url), ["/__opencraft_runtime_error"]);
  assert.equal(f.reports[0].body.source, "browser-storage-bootstrap");
  assert.equal(f.reports[0].body.storageDiagnostics.stage, "opening");
  assert.equal(f.reports[0].body.url, "https://example.test/local/thread");
  assert.match(f.reports[0].body.userAgent, /iPad/);
  assert.deepEqual(f.reports[0].body.viewport, { width: 1024, height: 768 });
});

test("actual resource failures still use the existing release recovery", async () => {
  const f = fixture();
  let prevented = false;
  f.listeners.get("vite:preloadError")!({ payload: new Error("chunk unavailable"), preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, "the original import rejection must reach its caller");
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.reports[0].url, /^\/version.json\?recovery=/);
  assert.equal(f.field("[data-recovery-title]").textContent, "界面资源未能加载");
  assert.equal(f.field("[data-release-error]").hidden, false);
});


test("same-build module failure retries the graph once without changing app identity", async () => {
  const f = fixture({ recoverySupported: true });
  await vm.runInContext(`__opencraftRecoverRelease(new Error('Importing a module script failed.'))`, f.context);
  assert.equal(f.navigations.length, 1);
  const target = new URL(f.navigations[0]);
  assert.equal(target.origin, "https://example.test");
  assert.equal(target.pathname, "/local/thread");
  assert.equal(target.searchParams.get("keep"), "1");
  assert.match(target.searchParams.get("opencraft-resource-recovery")!, /^[a-z0-9-]+$/);
  await vm.runInContext(`__opencraftRecoverRelease(new Error('Importing a module script failed.'))`, f.context);
  assert.equal(f.navigations.length, 1, "nested preload failures cannot race retries");
  const retry = fixture({ recoverySupported: true, recovered: true });
  await vm.runInContext(`__opencraftRecoverRelease(new Error('Importing a module script failed.'))`, retry.context);
  assert.equal(retry.navigations.length, 0, "persistent failures must not loop");
  assert.equal(retry.field("[data-recovery-title]").textContent, "界面资源未能加载");
});

test("evaluation errors and storage failures never trigger cache recovery", async () => {
  for (const expression of ["new Error('broken module evaluation')", "Object.assign(new Error('blocked'), { name: 'BrowserStorageError' })"]) {
    const f = fixture({ recoverySupported: true });
    await vm.runInContext(`__opencraftRecoverRelease(${expression})`, f.context);
    assert.equal(f.navigations.length, 0);
  }
});

test("CSS preload failures recover the graph once and preserve persistent-failure retry", async () => {
  const expression = "new Error('Unable to preload CSS for https://example.test/assets/style-AAAA1111.css')";
  const first = fixture({ recoverySupported: true });
  await vm.runInContext(`__opencraftRecoverRelease(${expression})`, first.context);
  assert.equal(first.navigations.length, 1);
  assert.equal(new URL(first.navigations[0]).pathname, "/local/thread");
  assert.equal(new URL(first.navigations[0]).searchParams.get("keep"), "1");
  const retry = fixture({ recoverySupported: true, recovered: true });
  await vm.runInContext(`__opencraftRecoverRelease(${expression})`, retry.context);
  assert.equal(retry.navigations.length, 0, "persistent CSS failures must not loop");
  assert.equal(retry.field("[data-recovery-title]").textContent, "界面资源未能加载");
  retry.field("button").onclick();
  assert.equal(retry.navigations.length, 1, "explicit retry gets a fresh graph");
});


test("a newer release marks only the current session identity and reloads once", async () => {
  const stored = new Map<string, string>();
  const first = fixture({ latestBuildId: "next-build", stored });
  await vm.runInContext(`__opencraftRecoverRelease(new Error('chunk unavailable'))`, first.context);
  assert.equal(first.reloads(), 1);
  assert.deepEqual([...stored], [["opencraft.release-recovery:same-build->next-build", "attempted"]]);
  const retry = fixture({ latestBuildId: "next-build", stored });
  await vm.runInContext(`__opencraftRecoverRelease(new Error('chunk unavailable'))`, retry.context);
  assert.equal(retry.reloads(), 0);
  assert.equal(retry.field("[data-recovery-title]").textContent, "界面资源未能加载");
});


test("identity migration timeout stays in storage recovery even when a new release exists", async () => {
  const f = fixture({ recoverySupported: true, latestBuildId: "next-build" });
  await vm.runInContext(`__opencraftRecoverRelease(Object.assign(new Error('Database identity migration timeout'), {
    name: 'IndexedDbIdentityError', reason: 'timeout', stage: 'opening'
  }))`, f.context);
  assert.equal(f.field("[data-recovery-title]").textContent, "暂时无法读取本地配置");
  assert.match(f.field("[data-recovery-summary]").textContent, /完全退出浏览器/);
  assert.equal(f.field("[data-release-error]").hidden, true);
  assert.equal(f.reloads(), 0);
  assert.deepEqual(f.navigations, []);
  assert.deepEqual(f.reports.map(report => report.url), ["/__opencraft_runtime_error"]);
  f.field("button").onclick();
  assert.equal(f.reloads(), 1);
  assert.deepEqual(f.navigations, []);
});
