import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { HostRuntimeRegistry, type AppServerWorkbenchRuntime, type HostConnectionProfile } from "@opencraft/workbench-runtime";
import type { SshConnectionView } from "@opencraft/app-host-protocol";
import { canDisplayHostThreadCatalog, canReadHostThreadCatalog, HostThreadCatalogUnavailableError, managedHostCatalogSignature, readHostThreadCatalog, type ManagedHostCatalogSnapshot } from "../../apps/workbench-web/src/runtime/host-thread-catalog.js";
import { retryHostThreadCatalogQuery } from "../../apps/workbench-web/src/runtime/use-host-thread-catalog-queries.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const profile: HostConnectionProfile = {
  hostId: "ssh:fixture", displayName: "Fixture", providerId: "fixture", providerConfig: {}, providerConfigVersion: 1,
  hostKind: "remote-ssh", enabled: true, autoConnect: false, includeInSidebar: true, revision: 1,
  credentialRef: null, transportEndpoint: null, executionLocation: "Fixture", workspaceBrowseRoots: ["/remote"],
};
const row: SshConnectionView = { serverId: profile.hostId, displayName: "Fixture", workspaceBrowseRoots: ["/remote"],
  revision: 1, enabled: true, hostname: "fixture.invalid", port: 22, username: "fixture", fingerprint: `SHA256:${"a".repeat(43)}`, state: "open" };

function harness(initialProfile: HostConnectionProfile = profile) {
  let current: HostConnectionProfile | undefined = initialProfile;
  let snapshot: ManagedHostCatalogSnapshot = { available: true, authenticated: true, items: [row], legacyServers: [], refreshing: false, error: null };
  let authorizationEpoch = 0;
  const calls: string[] = [];
  let phase = "idle";
  let connectGate: Promise<void> = Promise.resolve(), listGate: Promise<void> = Promise.resolve();
  type Page = { data: Array<{ id: string; pinned?: boolean }>; nextCursor: string | null };
  let listPage: (params: { cursor: string | null; limit: number }) => Promise<Page> = async params => {
    assert.deepEqual(params, { cursor: null, limit: 50 });
    return { data: [{ id: "same-native-id" }], nextCursor: null };
  };
  let connection: Promise<void> | null = null;
  let connectDemands = 0;
  const runtime = {
    getSnapshot: () => ({ phase }),
    connect() {
      connectDemands++;
      // The runtime owns physical connection single-flight, as in AppServer runtime.
      if (connection) return connection;
      calls.push("connect"); phase = "connecting";
      connection = connectGate.then(() => { phase = "ready"; }).finally(() => { connection = null; });
      return connection;
    },
    async dispose() { calls.push("dispose"); phase = "disposed"; },
    resources: { threads: { async list(params: { cursor: string | null; limit: number }) { calls.push("thread/list");
      await listGate; return listPage(params); } } },
  } as unknown as AppServerWorkbenchRuntime;
  const registry = new HostRuntimeRegistry([{ descriptor: { hostId: profile.hostId, label: "Fixture", kind: "remote-ssh",
    transportEndpoint: null, executionLocation: "Fixture", workspaceBrowseRoots: ["/remote"] }, createRuntime: () => runtime }]);
  const source = { getSnapshot: () => snapshot, getAuthorizationEpoch: () => authorizationEpoch, subscribe: () => () => {}, refresh: async () => {} };
  return { calls, registry, source, getConnectDemands: () => connectDemands, read: (options: { onInitialPage?: (page: { data: readonly { id: string; pinned?: boolean }[] }) => void; signal?: AbortSignal } = {}) => readHostThreadCatalog({ profile: initialProfile, currentProfile: () => current, management: source, registry, ...options }),
    setCurrent: (value: HostConnectionProfile | undefined) => { current = value; },
    setSnapshot: (value: Partial<ManagedHostCatalogSnapshot>) => { snapshot = { ...snapshot, ...value }; },
    nextAuthorization: () => { authorizationEpoch++; },
    setListPage: (read: typeof listPage) => { listPage = read; },
    holdConnect: (gate: Promise<void>) => { connectGate = gate; }, holdList: (gate: Promise<void>) => { listGate = gate; } };
}

test("Chat catalog ignores healthy poll progress and fresh copies of unchanged responses", () => {
  const h = harness();
  const before = managedHostCatalogSignature(h.source);
  h.setSnapshot({ refreshing: true });
  assert.equal(managedHostCatalogSignature(h.source), before);
  h.setSnapshot({ refreshing: false, items: [structuredClone(row)], legacyServers: [] });
  assert.equal(managedHostCatalogSignature(h.source), before);
  assert.equal(managedHostCatalogSignature(null), null);
});

test("Chat catalog observes authorization epochs, configuration, physical state and legacy changes", () => {
  const changes: Array<(h: ReturnType<typeof harness>) => void> = [
    h => h.nextAuthorization(), // Same rows after reauthentication must still invalidate query keys.
    h => h.setSnapshot({ authenticated: false }),
    h => h.setSnapshot({ available: false }),
    h => h.setSnapshot({ items: [] }),
    h => h.setSnapshot({ items: [{ ...row, enabled: false }] }),
    h => h.setSnapshot({ items: [{ ...row, revision: 2 }] }),
    h => h.setSnapshot({ items: [{ ...row, state: "failed" }] }),
    h => h.setSnapshot({ items: [{ ...row, displayName: "Renamed" }] }),
    h => h.setSnapshot({ items: [{ ...row, workspaceBrowseRoots: ["/new-root"] }] }),
    h => h.setSnapshot({ legacyServers: [{ serverId: "legacy", displayName: "Legacy", workspaceBrowseRoots: [] }] }),
  ];
  for (const change of changes) {
    const h = harness();
    const before = managedHostCatalogSignature(h.source);
    change(h);
    assert.notEqual(managedHostCatalogSignature(h.source), before);
  }
});

test("Chat catalog retains cold discovery, error, retry and recovery updates", () => {
  const h = harness();
  const healthy = managedHostCatalogSignature(h.source);
  h.setSnapshot({ available: null });
  const cold = managedHostCatalogSignature(h.source);
  h.setSnapshot({ refreshing: true });
  assert.notEqual(managedHostCatalogSignature(h.source), cold);
  h.setSnapshot({ refreshing: false, error: "offline" });
  const failed = managedHostCatalogSignature(h.source);
  h.setSnapshot({ refreshing: true });
  assert.notEqual(managedHostCatalogSignature(h.source), failed);
  h.setSnapshot({ available: true, refreshing: false, error: null });
  assert.equal(managedHostCatalogSignature(h.source), healthy);
});

test("shared Sidebar and search catalog includes older pages and preserves authoritative native pins", async () => {
  for (const initialProfile of [profile, { ...profile, hostKind: "local" as const, autoConnect: true }]) {
    const h = harness(initialProfile), cursors: Array<string | null> = [];
    h.setListPage(async ({ cursor, limit }) => {
      cursors.push(cursor); assert.equal(limit, 50);
      if (cursor === null) return { data: [{ id: "old-pin", pinned: true }, ...Array.from({ length: 50 }, (_, n) => ({ id: `recent-${n}` }))], nextCursor: "page-2" };
      if (cursor === "page-2") return { data: [], nextCursor: "page-3" };
      assert.equal(cursor, "page-3");
      return { data: [{ id: "old-pin", pinned: false }, { id: "yesterday-cloud-desktop" }], nextCursor: null };
    });
    try {
      const result = await h.read();
      assert.deepEqual(cursors, [null, "page-2", "page-3"]);
      assert.equal(result.nextCursor, null);
      assert.equal(result.data.length, 52);
      assert.equal(result.data.at(-1)?.id, "yesterday-cloud-desktop");
      assert.equal(result.data.filter(row => row.id === "old-pin").length, 1);
      assert.equal(result.data[0]?.pinned, true);
      assert.deepEqual(h.calls, ["connect", "thread/list", "thread/list", "thread/list"]);
    } finally { await h.registry.dispose(); }
  }
});

test("failed or repeating later pages cannot publish a misleading complete catalog", async () => {
  for (const failure of ["request", "cursor"] as const) {
    const h = harness();
    h.setListPage(async ({ cursor }) => {
      if (cursor === null) return { data: [{ id: "recent" }], nextCursor: "next" };
      if (failure === "request") throw new Error("later page unavailable");
      return { data: [], nextCursor: "next" };
    });
    try {
      await assert.rejects(h.read(), failure === "request" ? /later page unavailable/ : /Repeated thread catalog cursor/);
      assert.deepEqual(h.calls, ["connect", "thread/list", "thread/list"]);
    } finally { await h.registry.dispose(); }
  }
});

test("authorization and recipe changes during pagination reject late history before another page", async () => {
  for (const change of ["authorization", "recipe", "remove"] as const) {
    const h = harness();
    h.setListPage(async ({ cursor }) => {
      if (cursor === null) return { data: [{ id: "recent" }], nextCursor: "next" };
      if (change === "authorization") h.nextAuthorization();
      if (change === "recipe") h.setCurrent({ ...profile, revision: 2 });
      if (change === "remove") h.setCurrent(undefined);
      return { data: [{ id: "private-old-history" }], nextCursor: "never-request" };
    });
    try {
      await assert.rejects(h.read(), /不可读取会话/);
      assert.deepEqual(h.calls, ["connect", "thread/list", "thread/list"]);
    } finally { await h.registry.dispose(); }
  }
});

test("an enabled but idle SSH recipe does not dial merely to discover history", async () => {
  const h = harness(); h.setSnapshot({ items: [{ ...row, state: "idle" }] });
  await assert.rejects(h.read(), /不可读取会话/);
  assert.deepEqual(h.calls, []); assert.equal(h.registry.peekRuntime(profile.hostId), null);
  await h.registry.dispose();
});

test("an explicitly open backend admits a logical catalog reader with no Thread activation", async () => {
  const h = harness(), gate = deferred(); h.holdConnect(gate.promise);
  const first = h.read(), second = h.read();
  assert.equal(h.getConnectDemands(), 2);
  assert.deepEqual(h.calls, ["connect"]); gate.resolve();
  const pages = await Promise.all([first, second]);
  assert.equal(pages[0].data[0]?.id, "same-native-id");
  assert.deepEqual(h.calls, ["connect", "thread/list", "thread/list"]);
  await h.registry.dispose();
});

test("lock or delete during logical attachment prevents the subsequent Thread read", async () => {
  for (const change of ["lock", "delete"] as const) {
    const h = harness(), gate = deferred(); h.holdConnect(gate.promise);
    const pending = h.read();
    h.setSnapshot(change === "lock" ? { authenticated: false } : { items: [] });
    gate.resolve(); await assert.rejects(pending, /不可读取会话/);
    assert.deepEqual(h.calls, ["connect"]); await h.registry.dispose();
  }
});

test("revocation, disablement and recipe replacement fence late catalog replies", async () => {
  for (const change of ["lock", "disable", "revision", "remove"] as const) {
    const h = harness(), gate = deferred(); h.holdList(gate.promise);
    const pending = h.read(); await new Promise(resolve => setImmediate(resolve));
    assert.ok(h.calls.includes("thread/list"));
    if (change === "lock") h.setSnapshot({ authenticated: false });
    if (change === "disable") h.setCurrent({ ...profile, enabled: false });
    if (change === "revision") h.setCurrent({ ...profile, revision: 2 });
    if (change === "remove") h.setCurrent(undefined);
    gate.resolve(); await assert.rejects(pending, /不可读取会话/); await h.registry.dispose();
  }
});

test("logout followed by unlock cannot publish an old authorization's late history", async () => {
  const h = harness(), gate = deferred(); h.holdList(gate.promise);
  const pending = h.read(); await new Promise(resolve => setImmediate(resolve));
  h.nextAuthorization(); // The new session can be authenticated with the same public config.
  gate.resolve(); await assert.rejects(pending, /不可读取会话/); await h.registry.dispose();
});

test("local discovery, explicit logical selection and static SSH compatibility retain their admission rules", () => {
  const management = { available: true, authenticated: true, items: [{ ...row, state: "idle" as const }], legacyServers: [], refreshing: false, error: null };
  assert.equal(canReadHostThreadCatalog(profile, "ready", management), true);
  assert.equal(canReadHostThreadCatalog(profile, "idle", management), false);
  assert.equal(canReadHostThreadCatalog(profile, "ready", { ...management, authenticated: false }), false);
  assert.equal(canReadHostThreadCatalog(profile, "ready", { ...management, items: [] }), false);
  assert.equal(canReadHostThreadCatalog(profile, "ready", { ...management, items: [], legacyServers: [row] }), true);
  assert.equal(canReadHostThreadCatalog(profile, "idle", null), false);
  assert.equal(canReadHostThreadCatalog({ ...profile, hostKind: "local", autoConnect: true }, "idle", null), true);
  assert.equal(canReadHostThreadCatalog({ ...profile, hostKind: "local", autoConnect: true }, "reconnecting", null), false);
  assert.equal(canReadHostThreadCatalog({ ...profile, autoConnect: true }, "error", null), false);
});

test("one Server's open state cannot admit another Server's history", () => {
  const management = { available: true, authenticated: true, items: [row], legacyServers: [], refreshing: false, error: null };
  assert.equal(canReadHostThreadCatalog({ ...profile, hostId: "ssh:second" }, "idle", management), false);
  assert.equal(canReadHostThreadCatalog(profile, "idle", management), true);
});

test("SSH logout does not invalidate an unrelated local Host's in-flight catalog", async () => {
  const h = harness({ ...profile, hostKind: "local", autoConnect: true }), gate = deferred(); h.holdList(gate.promise);
  const pending = h.read(); await new Promise(resolve => setImmediate(resolve));
  h.nextAuthorization(); h.setSnapshot({ authenticated: false, items: [] });
  gate.resolve(); assert.equal((await pending).data[0]?.id, "same-native-id"); await h.registry.dispose();
});


test("cached remote rows survive transport transitions without admitting offline reads", () => {
  for (const state of ["open", "connecting", "idle", "error"] as const) {
    const management: ManagedHostCatalogSnapshot = { available: true, authenticated: true,
      items: [{ ...row, state }], legacyServers: [], refreshing: false, error: null };
    assert.equal(canDisplayHostThreadCatalog(profile, management), true);
    assert.equal(canReadHostThreadCatalog(profile, "reconnecting", management), false);
    assert.equal(canReadHostThreadCatalog(profile, "error", management), false);
    assert.equal(canDisplayHostThreadCatalog(profile, { ...management, refreshing: true, error: "temporary" }), true);
    assert.equal(canDisplayHostThreadCatalog(profile, { ...management, authenticated: false }), false);
    assert.equal(canDisplayHostThreadCatalog(profile, { ...management, items: [] }), false);
    assert.equal(canDisplayHostThreadCatalog(profile, { ...management, items: [{ ...row, enabled: false }] }), false);
    assert.equal(canDisplayHostThreadCatalog(profile, { ...management, items: [{ ...row, revision: 2 }] }), false);
  }
  assert.equal(canDisplayHostThreadCatalog({ ...profile, enabled: false }, null), false);
  assert.equal(canDisplayHostThreadCatalog({ ...profile, includeInSidebar: false }, null), false);
});

test("stale open management observation cannot redial a reconnecting runtime", async () => {
  const h = harness();
  await h.registry.ensureConnected(profile.hostId);
  const runtime = h.registry.peekRuntime(profile.hostId)!;
  const originalSnapshot = runtime.getSnapshot;
  runtime.getSnapshot = () => ({ ...originalSnapshot(), phase: "reconnecting" });
  h.calls.length = 0;
  await assert.rejects(h.read(), /不可读取会话/);
  assert.deepEqual(h.calls, []);
  await h.registry.dispose();
});


test("cold reader exposes authoritative first-page pins while complete directory remains pending", async () => {
  const h = harness(), gate = deferred();
  const first = [{ id: "old-pin", pinned: true }, { id: "recent" }];
  h.setListPage(async ({ cursor }) => {
    if (cursor === null) return { data: first, nextCursor: "older" };
    await gate.promise;
    return { data: [{ id: "old-pin", pinned: false }, { id: "old-search-match" }], nextCursor: null };
  });
  const progress: string[][] = [];
  let complete = false;
  const pending = h.read({ onInitialPage: page => progress.push(page.data.map(row => row.id)) }).then(value => { complete = true; return value; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(progress, [["old-pin", "recent"]]);
    assert.equal(complete, false, "first rows are presentation progress, never complete success");
    gate.resolve(); const result = await pending;
    assert.deepEqual(result.data.map(row => row.id), ["old-pin", "recent", "old-search-match"]);
    assert.equal(result.data[0]?.pinned, true);
    assert.equal(progress.length, 1, "later pages do not repeatedly rebuild the visible directory");
  } finally { gate.resolve(); await pending.catch(() => {}); await h.registry.dispose(); }
});

test("empty or single-page catalogs do not publish unnecessary partial presentation", async () => {
  for (const empty of [true, false]) {
    const h = harness(); const progress: unknown[] = [];
    h.setListPage(async () => ({ data: empty ? [] : [{ id: "only" }], nextCursor: null }));
    try { const result = await h.read({ onInitialPage: page => progress.push(page) });
      assert.deepEqual(progress, []); assert.equal(result.data.length, empty ? 0 : 1);
    } finally { await h.registry.dispose(); }
  }
});

test("cancelled or revoked first replies never expose private first-page rows", async () => {
  for (const cancelled of [true, false]) {
    const h = harness(), controller = new AbortController(); const progress: unknown[] = [];
    h.setListPage(async () => { if (cancelled) controller.abort(); else h.nextAuthorization();
      return { data: [{ id: "private" }], nextCursor: "older" }; });
    try {
      await assert.rejects(h.read({ signal: controller.signal, onInitialPage: page => progress.push(page) }));
      assert.deepEqual(progress, []); assert.deepEqual(h.calls, ["connect", "thread/list"]);
    } finally { await h.registry.dispose(); }
  }
});

test("connection preconditions do not enter the query retry backoff", () => {
  const unavailable = new HostThreadCatalogUnavailableError();
  assert.equal(retryHostThreadCatalogQuery(0, unavailable), false);
  assert.equal(retryHostThreadCatalogQuery(0, Object.assign(new Error("cross-realm"), { code: unavailable.code })), false);
  assert.equal(retryHostThreadCatalogQuery(0, new Error("transient")), true);
  assert.equal(retryHostThreadCatalogQuery(3, new Error("transient")), false);
});

test("unreadable preconditions emit no catalog operation and a later-page failure preserves first-page success", async () => {
  const catalogUrl = new URL("../../apps/workbench-web/src/runtime/host-thread-catalog.ts", import.meta.url).href;
  const observabilityUrl = new URL("../../apps/workbench-web/src/runtime/observability.ts", import.meta.url).href;
  const source = `
    const document = Object.assign(new EventTarget(), { visibilityState: "visible", querySelector: () => null });
    const window = new EventTarget();
    Object.assign(globalThis, { document, window, PerformanceObserver: class { static supportedEntryTypes = []; } });
    Object.defineProperty(globalThis, "performance", { configurable: true, value: {
      now: () => 10, timeOrigin: Date.now() - 10, getEntriesByType: () => [{ startTime: 0, type: "navigate" }],
    } });
    const events = [];
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith("/capabilities")) return { ok: true, json: async () => ({ telemetry: true, available: false }) };
      for (const event of JSON.parse(options.body).events) events.push(event);
      return { ok: true };
    };
    const observation = await import(${JSON.stringify(observabilityUrl)});
    const controller = new AbortController();
    await observation.createObservabilityExtension().activate({ signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 25));
    events.length = 0;
    const catalog = await import(${JSON.stringify(catalogUrl)});
    const profile = { hostId: "fixture", displayName: "Fixture", providerId: "fixture", providerConfig: {}, providerConfigVersion: 1,
      hostKind: "local", enabled: true, autoConnect: true, includeInSidebar: true, revision: 1, credentialRef: null,
      transportEndpoint: null, executionLocation: "Fixture", workspaceBrowseRoots: [] };
    await catalog.readHostThreadCatalog({ profile, currentProfile: () => undefined, management: null,
      registry: { peekRuntime: () => null, ensureConnected: async () => { throw new Error("must not connect"); } } })
      .then(() => { throw new Error("expected a precondition failure"); }, () => {});
    await new Promise(resolve => setTimeout(resolve, 25));
    const precondition = events.filter(event => event.kind === "operation" && String(event.operationType).startsWith("catalog_"));
    if (precondition.length !== 0) throw new Error("precondition emitted catalog operations: " + JSON.stringify(precondition));
    let page = 0;
    const runtime = { getSnapshot: () => ({ phase: "ready" }), resources: { threads: { list: async () => {
      if (++page === 1) return { data: [{ id: "first" }], nextCursor: "next" };
      throw new Error("later page unavailable");
    } } } };
    await catalog.readHostThreadCatalog({ profile, currentProfile: () => profile, management: null,
      registry: { peekRuntime: () => runtime, ensureConnected: async () => runtime } })
      .then(() => { throw new Error("expected a later page failure"); }, () => {});
    await new Promise(resolve => setTimeout(resolve, 100));
    const first = events.filter(event => event.operationType === "catalog_first").map(event => event.outcome);
    const complete = events.filter(event => event.operationType === "catalog_complete").map(event => event.outcome);
    if (JSON.stringify(first) !== JSON.stringify(["started", "ok"])) throw new Error("catalog_first outcomes: " + JSON.stringify(first));
    if (JSON.stringify(complete) !== JSON.stringify(["started", "failed"])) throw new Error("catalog_complete outcomes: " + JSON.stringify(complete));
    controller.abort();
    console.log("catalog observation policy passed");
  `;
  const stdout = await new Promise<string>((resolve, reject) => execFile(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    (error, output, stderr) => error ? reject(Object.assign(error, { stdout: output, stderr })) : resolve(output)));
  assert.match(stdout, /catalog observation policy passed/);
});
