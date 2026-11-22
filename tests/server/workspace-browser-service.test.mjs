import { installWorkspaceBrowserRouting } from "../../apps/headless-server/src/workspaces/workspace-browser-composition.mjs";
import { createWorkspaceBrowserRouting } from "../../apps/headless-server/src/workspaces/workspace-browser-routing.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteBrowserService } from "../../apps/headless-server/src/remote-browser-service.mjs";
import { activateRemotePage } from "../../apps/headless-server/src/remote-browser/page-lifecycle.mjs";
import { createWorkspaceBrowserRouter } from "../../apps/headless-server/src/workspaces/workspace-browser-router.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "workspace-browser-service-"));
  const peers = [],
    commands = [];
  let absent = false;
  function connect() {
    const peer = Object.assign(new EventEmitter(), {
      connected: true,
      inventory: [],
      automationCancellation: 1,
      automationNavigation: 1,
      kill() {
        this.connected = false;
      },
      send(m, callback) {
        commands.push(m);
        callback?.();
        queueMicrotask(() => {
          const missing = absent && m.method === "snapshot";
          if (m.method === "create") absent = false;
          peer.emit("message", {
            type: "result",
            id: m.id,
            ...(missing
              ? { error: { message: "Browser page closed" } }
              : {
                  value: {
                    id: m.page,
                    document: "kept-document",
                    width: 800,
                    height: 600,
                    deviceProfile: "desktop",
                    navigation: { url: "https://example.test/", isLoading: false },
                  },
                }),
          });
        });
      },
    });
    peers.push(peer);
    return peer;
  }
  const lease = { assertCurrent() {}, connect: async () => connect() };
  let attaches = 0;
  const service = new RemoteBrowserService({
    root: directory,
    dataDirectory: directory,
    ownerAvailable: async () => true,
    ownerConnector: async () => {
      attaches++;
      return createWorkspaceBrowserRouter({
        resolve: async (id) => {
          if (!service.store.current.pages.some((p) => p.id === id)) throw Error("not a durable page");
          return lease;
        },
      });
    },
    spawnImpl() {
      throw Error("local fallback forbidden");
    },
  });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  await service.load();
  const key = JSON.stringify(["owner", "browser-service-integration"]),
    id = createHash("sha256").update(key).digest("hex");
  await service.commit((draft) =>
    draft.pages.push({
      key,
      id,
      ownerId: "owner",
      lifecycle: "open",
      zoom: 100,
      runtime: { kind: "unknown", generation: 1 },
    }),
  );
  service.pages.set(key, {
    key,
    id,
    ownerId: "owner",
    live: false,
    zoom: 100,
    runtime: { kind: "unknown", generation: 1 },
  });
  return {
    service,
    key,
    id,
    peers,
    commands,
    lease,
    missing() {
      absent = true;
    },
    get attaches() {
      return attaches;
    },
  };
}
test("central browser activation recovers through private workspace router without native recreation", async (t) => {
  const f = await fixture(t);
  // isolate reserve's separate metadata admission; durable runtime publication
  // and native lifecycle recovery use the actual service/SQLite Worker.
  f.service.reserve = async () => f.service.store.current.pages[0];
  await activateRemotePage(f.service, { ownerId: "owner", key: f.key, authorize() {} });
  assert.equal(f.service.store.current.pages[0].runtime.kind, "live");
  assert.equal(f.service.pages.get(f.key).document, "kept-document");
  assert.deepEqual(
    f.commands.map((c) => c.method),
    ["snapshot", "snapshot"],
  );
  assert.equal(f.attaches, 1);
  assert.equal(f.peers.length, 1);
});
test("positive native absence is required before creating a recovered workspace page", async (t) => {
  const f = await fixture(t);
  f.missing();
  f.service.reserve = async () => f.service.store.current.pages[0];
  await activateRemotePage(f.service, { ownerId: "owner", key: f.key, authorize() {} });
  assert.deepEqual(
    f.commands.map((c) => c.method),
    ["snapshot", "close", "create", "snapshot"],
  );
  assert.equal(f.service.store.current.pages[0].runtime.kind, "live");
});
test("workspace transport loss leaves durable capacity unknown and next attachment reconciles it", async (t) => {
  const f = await fixture(t);
  f.service.reserve = async () => f.service.store.current.pages[0];
  await activateRemotePage(f.service, { ownerId: "owner", key: f.key, authorize() {} });
  f.peers[0].emit("exit");
  await f.service.store.tail;
  assert.equal(f.service.child, null);
  assert.equal(f.service.store.current.pages[0].runtime.kind, "unknown");
  assert.equal((await f.service.catalog("owner", () => {})).capacity.accountUsed, 1);
  await activateRemotePage(f.service, { ownerId: "owner", key: f.key, authorize() {} });
  assert.equal(f.attaches, 2);
  assert.equal(f.peers.length, 2);
  assert.equal(f.commands.filter((c) => c.method === "create").length, 0);
  assert.equal(f.service.store.current.pages[0].runtime.kind, "live");
});

test("central service shutdown waits for remote proxy drain before releasing its writer", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "browser-owner-drain-"));
  let release, entered;
  const began = new Promise((resolve) => (entered = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  const peer = Object.assign(new EventEmitter(), {
    connected: true,
    inventory: [],
    kill() {
      this.connected = false;
    },
    async close() {
      entered();
      await gate;
    },
  });
  const service = new RemoteBrowserService({
    root: directory,
    dataDirectory: directory,
    ownerAvailable: async () => true,
    ownerConnector: async () => peer,
  });
  t.after(async () => {
    release?.();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  await service.start();
  let drained = false;
  const closing = service.close().then(() => (drained = true));
  await began;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  assert.strictEqual(service.close(), service.persistence);
  release();
  await closing;
  assert.equal(drained, true);
});

test("remote cleanup failure is reported after the durable writer is released", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-owner-drain-failure-"));
  const peer = Object.assign(new EventEmitter(), {
    connected: true,
    inventory: [],
    kill() {},
    async close() {
      throw Error("transport cleanup");
    },
  });
  const service = new RemoteBrowserService({
    root: directory,
    dataDirectory: directory,
    ownerAvailable: async () => true,
    ownerConnector: async () => peer,
  });
  try {
    await service.start();
    await assert.rejects(service.close(), /cleanup unconfirmed/);
    const successor = new RemoteBrowserService({ root: directory, dataDirectory: directory });
    try {
      await successor.load();
    } finally {
      await successor.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("formal tab creation and retirement route through committed conversation metadata", async (t) => {
  const f = await fixture(t),
    descriptors = [];
  const routing = createWorkspaceBrowserRouting({
    service: f.service,
    resolveConversation: async (descriptor) => {
      assert.equal(descriptor.ownerId, "owner");
      assert.equal(descriptor.hostId, "host");
      assert.equal(descriptor.threadId, "thread");
      descriptors.push(descriptor);
      return f.lease;
    },
  });
  f.service.ownerConnector = async () => createWorkspaceBrowserRouter(routing);
  const binding = {
    ownerId: "owner",
    hostId: "host",
    threadId: "thread",
    turnId: "turn",
    callId: "call",
    authorize() {},
  };
  const tab = await f.service.createTab(binding, { url: "https://example.test/" });
  assert.equal((await f.service.conversationTabs("owner", "host", "thread", () => {}))[0].tabId, tab.tabId);
  assert.ok(descriptors.some((d) => d.lifecycle === "open"));
  const closed = await f.service.closeTab(binding, { tabId: tab.tabId });
  assert.equal(closed.closed, true);
  assert.ok(descriptors.some((d) => d.lifecycle === "closing"));
  assert.equal((await f.service.conversationTabs("owner", "host", "thread", () => {})).length, 0);
});

test("missing durable conversation links cannot be replaced by client page identity", async (t) => {
  const f = await fixture(t);
  let admissions = 0;
  const routing = createWorkspaceBrowserRouting({
    service: f.service,
    resolveConversation: async () => {
      admissions++;
      return f.lease;
    },
  });
  await assert.rejects(routing.resolve("unknown"), /route unavailable/);
  await assert.rejects(routing.resolve(f.id), /route unavailable/);
  assert.equal(admissions, 0);
});

test("captured durable route guards do not revive after a newer generation is resolved", async (t) => {
  const f = await fixture(t);
  const routing = createWorkspaceBrowserRouting({ service: f.service, resolveConversation: async () => f.lease });
  f.service.ownerConnector = async () => createWorkspaceBrowserRouter(routing);
  const binding = {
    ownerId: "owner",
    hostId: "host",
    threadId: "thread",
    turnId: "turn",
    callId: "generation",
    authorize() {},
  };
  const tab = await f.service.createTab(binding, { url: "https://example.test/" });
  const record = f.service.store.current.pages.find((p) => p.link?.tabId === tab.tabId);
  const lease = await routing.resolve(record.id),
    old = routing.captureRoute(record.id, lease);
  await f.service.commit(
    (draft) => {
      const p = draft.pages.find((p) => p.id === record.id);
      p.runtime = { ...p.runtime, generation: p.runtime.generation + 1 };
    },
    { resourcesOnly: true },
  );
  await routing.resolve(record.id);
  assert.throws(old, /route unavailable/);
  routing.captureRoute(record.id, lease)();
});

test("retired pages release route capacity without reviving captured requests", async () => {
  const pages = [],
    receipts = [];
  const service = {
    loaded: true,
    closed: false,
    async load() {},
    store: {
      tail: Promise.resolve(),
      current: { pages },
      account() {
        return { closedTabs: receipts };
      },
    },
  };
  const lease = {
    assertCurrent() {},
    async connect() {
      throw Error("not needed");
    },
  };
  const routing = createWorkspaceBrowserRouting({ service, resolveConversation: async () => lease });
  function add(i) {
    const key = JSON.stringify(["owner", String(i)]);
    pages.push({
      id: String(i),
      key,
      ownerId: "owner",
      lifecycle: "closing",
      link: { tabId: "tab-" + i, pageId: "page-" + i },
      runtime: { generation: 1 },
    });
    receipts.push({
      key,
      status: "closing",
      ownerId: "owner",
      lease: String(i),
      tabId: "tab-" + i,
      pageId: "page-" + i,
      hostId: "host",
      threadId: "thread",
    });
  }
  for (let i = 0; i < 1024; i++) {
    add(i);
    await routing.resolve(String(i));
  }
  const old = routing.captureRoute("0", lease),
    live = routing.captureRoute("1", lease);
  add(1024);
  // Still-live pages cannot be evicted merely to admit a new one.
  await assert.rejects(routing.resolve("1024"), /route unavailable/);
  pages.shift();
  receipts.shift();
  await routing.resolve("1024");
  assert.throws(old, /route unavailable/);
  live();
  routing.captureRoute("1024", lease)();
  // Repeated retirement is not a lifetime quota.
  for (let i = 1025; i < 1035; i++) {
    pages.shift();
    receipts.shift();
    add(i);
    await routing.resolve(String(i));
  }
  assert.throws(old, /route unavailable/);
});

test("shared physical lease retains a per-page authority guard after resolution", async (t) => {
  const f = await fixture(t);
  let allowed = true;
  const routing = createWorkspaceBrowserRouting({
    service: f.service,
    resolveConversation: async () => ({
      lease: f.lease,
      assertCurrent() {
        if (!allowed) throw Error("actor revoked");
      },
    }),
  });
  f.service.ownerConnector = async () => createWorkspaceBrowserRouter(routing);
  const binding = {
    ownerId: "owner",
    hostId: "host",
    threadId: "thread",
    turnId: "turn",
    callId: "authority",
    authorize() {},
  };
  const tab = await f.service.createTab(binding, { url: "https://example.test/" });
  const record = f.service.store.current.pages.find((p) => p.link?.tabId === tab.tabId);
  const lease = await routing.resolve(record.id),
    guard = routing.captureRoute(record.id, lease);
  guard();
  allowed = false;
  assert.throws(guard, /actor revoked/);
  await assert.rejects(routing.resolve(record.id), /actor revoked/);
  allowed = true;
});

test("committed unbound local tabs stay local until a conversation binding is published", async () => {
  const link = { pageId: "page", tabId: "tab", scopeId: "draft:one", hostId: "local-codex" };
  const record = {
    id: "native",
    key: JSON.stringify(["owner", "browser-one"]),
    ownerId: "owner",
    lifecycle: "open",
    link,
    runtime: { generation: 1 },
  };
  const values = {
    storage: JSON.stringify({ page: "browser:one" }),
    pages: JSON.stringify([{ id: "page", ownerId: link.scopeId, hostId: link.hostId }]),
    tabs: JSON.stringify([{ id: "tab", pageId: "page", ownerId: link.scopeId }]),
    bindings: "[]",
  };
  const state = { values };
  const service = {
    loaded: true,
    closed: false,
    async load() {},
    store: {
      tail: Promise.resolve(),
      current: { pages: [record] },
      account() {
        return { states: [["owner", state]] };
      },
    },
  };
  const seen = [];
  const lease = {
    assertCurrent() {},
    async connect() {
      throw Error("not called");
    },
  };
  const routing = createWorkspaceBrowserRouting({
    service,
    resolveConversation: async (d) => {
      seen.push(d);
      return lease;
    },
  });
  await routing.resolve("native");
  const guard = routing.captureRoute("native", lease);
  assert.equal(seen.at(-1).threadId, null);
  values.bindings = JSON.stringify([{ scopeId: link.scopeId, hostId: link.hostId, threadId: "remote-thread" }]);
  assert.throws(guard, /route unavailable/);
  await routing.resolve("native");
  assert.equal(seen.at(-1).threadId, "remote-thread");
  values.bindings = JSON.stringify([{ scopeId: link.scopeId, hostId: link.hostId }]);
  await assert.rejects(routing.resolve("native"), /route unavailable/);
});

test("installed identity browser composition reuses local owner and routes remote without spawning local", async (t) => {
  const f = await fixture(t);
  let localConnects = 0,
    remoteConnects = 0;
  f.service.ownerConnector = async () => {
    localConnects++;
    return f.lease.connect();
  };
  const remote = {
    assertCurrent() {},
    async connect() {
      remoteConnects++;
      return f.lease.connect();
    },
  };
  installWorkspaceBrowserRouting({
    service: f.service,
    resolveConversation: async (d, local) => ({ lease: d.threadId === "remote" ? remote : local, assertCurrent() {} }),
  });
  const binding = (threadId) => ({
    ownerId: "owner",
    hostId: "host",
    threadId,
    turnId: "turn",
    callId: threadId,
    authorize() {},
  });
  await f.service.createTab(binding("remote"), { url: "https://example.test/" });
  assert.equal(remoteConnects, 1);
  assert.equal(localConnects, 0);
  await f.service.createTab(binding("local-a"), { url: "https://example.test/" });
  await f.service.createTab(binding("local-b"), { url: "https://example.test/" });
  assert.equal(localConnects, 1);
  assert.equal(remoteConnects, 1);
});

test("unbound local close uses its committed receipt, not removed tab metadata", async () => {
  const link = { pageId: "page", tabId: "tab", scopeId: "draft:one", hostId: null };
  const key = JSON.stringify(["owner", "browser-one"]);
  const page = { id: "native", key, ownerId: "owner", lifecycle: "closing", link };
  const receipt = { ...link, key, ownerId: "owner", lease: "browser-one", status: "closing", threadId: null };
  const service = {
    loaded: true,
    closed: false,
    async load() {},
    store: {
      tail: Promise.resolve(),
      current: { pages: [page] },
      account() {
        return { closedTabs: [receipt] };
      },
    },
  };
  const lease = {
    assertCurrent() {},
    async connect() {
      throw Error("not called");
    },
  };
  let seen;
  const routing = createWorkspaceBrowserRouting({
    service,
    resolveConversation: async (d) => {
      seen = d;
      return lease;
    },
  });
  await routing.resolve("native");
  assert.equal(seen.hostId, "local-codex");
  assert.equal(seen.threadId, null);
  receipt.scopeId = "conversation:broken";
  await assert.rejects(routing.resolve("native"), /route unavailable/);
});

test("retirement during an awaited resource lookup proves this preparation was not dispatched", async () => {
  const key = JSON.stringify(["owner", "lease"]),
    pages = [
      {
        id: "native-page",
        key,
        ownerId: "owner",
        lifecycle: "closing",
        link: { tabId: "tab", pageId: "logical-page" },
        runtime: { generation: 1 },
      },
    ];
  const receipt = {
    key,
    status: "closing",
    ownerId: "owner",
    lease: "lease",
    tabId: "tab",
    pageId: "logical-page",
    hostId: "host",
    threadId: "thread",
  };
  const service = {
    loaded: true,
    closed: false,
    async load() {},
    store: {
      tail: Promise.resolve(),
      current: { pages },
      account() {
        return { closedTabs: [receipt] };
      },
    },
  };
  const routing = createWorkspaceBrowserRouting({
    service,
    resolveConversation: async () => {
      pages.length = 0;
      return {
        assertCurrent() {},
        async connect() {
          throw Error("Must not connect a stale preparation");
        },
      };
    },
  });
  await assert.rejects(routing.resolve("native-page"), { code: "BROWSER_ROUTE_STALE", outcome: "not-dispatched" });
});
