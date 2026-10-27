import assert from "node:assert/strict";
import test from "node:test";
import { SshConnectionsController, type SshDiscoveryLifecycle } from "../../plugins/builtin-agents/src/ssh-connections/controller.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const row = { serverId: "ssh:fixture", revision: 1, displayName: "Fixture", hostname: "fixture.invalid", port: 22, username: "fixture", enabled: true, workspaceBrowseRoots: ["/remote"], fingerprint: `SHA256:${"a".repeat(43)}`, state: "idle" } as const;

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("shared discovery bootstraps and renews one backend session, never an SSH command", async () => {
  const methods: string[] = []; let authenticated = false;
  const controller = new SshConnectionsController(async (input, init) => {
    methods.push(`${init?.method ?? "GET"} ${input}`);
    if (init?.method === "POST") {
      assert.equal(String(input), "/__opencraft_ssh/session"); assert.equal(init.body, "{}");
      authenticated = true; return json({ authenticated: true });
    }
    if (String(input).endsWith("/session")) return json({ available: true, authenticated, accessMode: "shared" });
    return json(String(input).endsWith("/legacy-connections") ? [] : [row]);
  });
  try {
    const first = controller.refresh(); assert.equal(controller.refresh(), first); await first;
    assert.equal(controller.getSnapshot().accessMode, "shared");
    assert.equal(controller.getSnapshot().authenticated, true);
    const incarnation = controller.getAuthorizationEpoch();
    await controller.refresh(); assert.equal(controller.getAuthorizationEpoch(), incarnation);
    authenticated = false; await controller.refresh();
    assert.ok(controller.getAuthorizationEpoch() > incarnation);
    assert.equal(controller.getSnapshot().authenticated, true);
    await controller.lock(); assert.equal(controller.getSnapshot().authenticated, true);
    assert.deepEqual(methods.filter(method => !method.startsWith("GET ")), ["POST /__opencraft_ssh/session", "POST /__opencraft_ssh/session"]);
  } finally { controller.dispose(); }
});

test("failed shared renewal revokes stale catalog and uses discovery backoff", async () => {
  const clock = discoveryClock(); let authenticated = true, grants = 0;
  const controller = new SshConnectionsController(async (input, init) => {
    if (init?.method === "POST") { grants++; throw new Error("lost bootstrap reply"); }
    if (String(input).endsWith("/session")) return json({ available: true, authenticated, accessMode: "shared" });
    return json(String(input).endsWith("/legacy-connections") ? [] : [row]);
  });
  try {
    await controller.startDiscovery(clock.lifecycle); authenticated = false; await clock.tick();
    assert.equal(grants, 1); assert.equal(controller.getSnapshot().authenticated, false);
    assert.deepEqual(controller.getSnapshot().items, []); assert.ok(controller.getSnapshot().error);
    assert.equal([...clock.timers.values()][0]?.delay, 10000);
  } finally { controller.dispose(); }
});

test("legacy and malformed policies never enable shared admission", async () => {
  for (const session of [{ available: true, authenticated: false }, { available: true, authenticated: false, accessMode: "unknown" }]) {
    let grants = 0;
    const controller = new SshConnectionsController(async (_input, init) => {
      if (init?.method === "POST") grants++;
      return json(session);
    });
    try {
      await controller.refresh(); assert.equal(grants, 0); assert.equal(controller.getSnapshot().authenticated, false);
      assert.equal(Boolean(controller.getSnapshot().error), "accessMode" in session);
    } finally { controller.dispose(); }
  }
});

test("disposed shared admission fences a late bootstrap and cannot read private rows", async () => {
  const gate = deferred<Response>(); const methods: string[] = [];
  const controller = new SshConnectionsController(async (input, init) => {
    methods.push(`${init?.method ?? "GET"} ${input}`);
    if (init?.method === "POST") return gate.promise;
    return json({ available: true, authenticated: false, accessMode: "shared" });
  });
  const pending = controller.refresh(); await flush(); controller.dispose();
  gate.resolve(json({ authenticated: true })); await pending;
  assert.equal(controller.getSnapshot().authenticated, false);
  assert.deepEqual(methods, ["GET /__opencraft_ssh/session", "POST /__opencraft_ssh/session"]);
});

test("a shared command rejected after expiry asks for refresh, never a key or automatic replay", async () => {
  let writes = 0;
  const controller = new SshConnectionsController(async (input, init) => {
    if (init?.method === "POST") { writes++; return json({ error: "locked" }, 401); }
    if (String(input).endsWith("/session")) return json({ available: true, authenticated: true, accessMode: "shared" });
    return json(String(input).endsWith("/legacy-connections") ? [] : [row]);
  });
  try {
    await controller.refresh();
    await assert.rejects(controller.probe("fixture.invalid", 22), /连接已失效，请刷新后重试/);
    assert.equal(controller.getSnapshot().authenticated, false);
    assert.deepEqual(controller.getSnapshot().items, []); assert.equal(writes, 1);
  } finally { controller.dispose(); }
});
function discoveryClock() {
  let active = true;
  const wakes = new Set<() => void>();
  const timers = new Map<number, { run: () => void; delay: number }>();
  let sequence = 0;
  const lifecycle: SshDiscoveryLifecycle = {
    isActive: () => active,
    subscribeWake(listener) { wakes.add(listener); return () => { wakes.delete(listener); }; },
    schedule(run, delay) { const id = ++sequence; timers.set(id, { run, delay }); return () => { timers.delete(id); }; },
  };
  return { lifecycle, timers, wakes,
    setActive(value: boolean) { active = value; },
    async wake() { for (const listener of wakes) listener(); await flush(); },
    async tick() { const entry = [...timers.entries()][0]; assert.ok(entry, "one read-completion timer must be pending"); timers.delete(entry[0]); entry[1].run(); await flush(); },
  };
}

test("Application discovery recovers a failed startup without mounting Settings or dialing a Server", async () => {
  const clock = discoveryClock(), methods: string[] = []; let unavailable = true;
  const controller = new SshConnectionsController(async (input, init) => {
    methods.push(`${init?.method ?? "GET"} ${input}`);
    if (unavailable) throw new Error("synthetic offline startup");
    if (String(input).endsWith("/session")) return json({ available: true, authenticated: true });
    return json(String(input).endsWith("/legacy-connections") ? [] : [row]);
  });
  try {
    await controller.startDiscovery(clock.lifecycle);
    assert.equal(controller.getSnapshot().available, null); assert.ok(controller.getSnapshot().error);
    assert.equal([...clock.timers.values()][0]?.delay, 10000);
    unavailable = false; await clock.tick();
    assert.equal(controller.getSnapshot().error, null);
    assert.equal(controller.getSnapshot().items[0]?.state, "idle");
    assert.equal(clock.timers.size, 1); assert.equal([...clock.timers.values()][0]?.delay, 5000);
    await controller.startDiscovery(clock.lifecycle);
    assert.equal(clock.wakes.size, 1, "starting the owner twice cannot create another poller");
    assert.ok(methods.every(method => method.startsWith("GET ")), "discovery never connects/reconnects or replays mutations");
  } finally { controller.dispose(); }
  assert.equal(clock.wakes.size, 0); assert.equal(clock.timers.size, 0);
});

test("wake events and manual retry join one slow read instead of cancelling each other", async () => {
  const clock = discoveryClock(), gate = deferred<Response>(); let reads = 0;
  const controller = new SshConnectionsController(async input => {
    if (String(input).endsWith("/session")) { reads++; return gate.promise; }
    return json([]);
  });
  try {
    const start = controller.startDiscovery(clock.lifecycle);
    await flush();
    const first = controller.refresh(), second = controller.refresh();
    assert.equal(first, second);
    await clock.wake(); await clock.wake();
    assert.equal(reads, 1); assert.equal(clock.timers.size, 0);
    gate.resolve(json({ available: true, authenticated: false })); await start;
    assert.equal(clock.timers.size, 1); assert.equal(controller.getSnapshot().error, null);
  } finally { controller.dispose(); }
});

test("discovery pauses in inactive pages and refreshes immediately on return", async () => {
  const clock = discoveryClock(); let reads = 0;
  const controller = new SshConnectionsController(async () => { reads++; return json({ available: true, authenticated: false }); });
  try {
    await controller.startDiscovery(clock.lifecycle);
    clock.setActive(false); await clock.wake();
    assert.equal(clock.timers.size, 0); assert.equal(reads, 1);
    clock.setActive(true); await clock.wake();
    assert.equal(reads, 2); assert.equal(clock.timers.size, 1);
  } finally { controller.dispose(); }
});

test("discovery backoff is capped, and unsupported backends stop periodic reads", async () => {
  const clock = discoveryClock(); let unsupported = false;
  const controller = new SshConnectionsController(async () => {
    if (unsupported) return json({}, 404);
    throw new Error("synthetic prolonged outage");
  });
  try {
    await controller.startDiscovery(clock.lifecycle);
    for (const expected of [10000, 20000, 30000, 30000]) {
      assert.equal([...clock.timers.values()][0]?.delay, expected); await clock.tick();
    }
    unsupported = true; await clock.wake();
    assert.equal(controller.getSnapshot().available, false); assert.equal(clock.timers.size, 0);
  } finally { controller.dispose(); }
});

test("dispose aborts the in-flight discovery and fences a signal-ignoring late reply", async () => {
  const clock = discoveryClock(), gate = deferred<Response>(); let signal: AbortSignal | null = null, reads = 0;
  const controller = new SshConnectionsController(async (_input, init) => { reads++; signal = init?.signal ?? null; return gate.promise; });
  const start = controller.startDiscovery(clock.lifecycle); await flush();
  controller.dispose(); assert.equal((signal as AbortSignal | null)?.aborted, true);
  gate.resolve(json({ available: true, authenticated: true })); await start;
  await clock.wake(); await controller.refresh();
  assert.equal(reads, 1); assert.equal(controller.getSnapshot().available, null);
  assert.equal(clock.timers.size, 0); assert.equal(clock.wakes.size, 0);
});

test("background reads cannot race an unresolved authorization change", async () => {
  const clock = discoveryClock(), gate = deferred<Response>(); let authenticated = true, reads = 0;
  const controller = new SshConnectionsController(async (input, init) => {
    if (init?.method === "DELETE") return gate.promise;
    reads++;
    if (String(input).endsWith("/session")) return json({ available: true, authenticated });
    return json(String(input).endsWith("/legacy-connections") ? [] : [row]);
  });
  try {
    await controller.startDiscovery(clock.lifecycle); const before = reads;
    const lock = controller.lock(); await clock.wake(); await controller.refresh();
    assert.equal(reads, before, "no background GET while logout acknowledgement is outstanding");
    authenticated = false; gate.resolve(json({})); await lock; await clock.wake();
    assert.equal(controller.getSnapshot().authenticated, false); assert.deepEqual(controller.getSnapshot().items, []);
    assert.equal(reads, before + 1, "a locked page may read session status, never private rows");
  } finally { controller.dispose(); }
});

test("periodic session expiry advances authorization incarnation and clears private history", async () => {
  const clock = discoveryClock(); let authenticated = true;
  const controller = new SshConnectionsController(async input => {
    if (String(input).endsWith("/session")) return json({ available: true, authenticated });
    return json(String(input).endsWith("/legacy-connections") ? [] : [row]);
  });
  try {
    await controller.startDiscovery(clock.lifecycle); const incarnation = controller.getAuthorizationEpoch();
    authenticated = false; await clock.tick();
    assert.equal(controller.getSnapshot().authenticated, false); assert.deepEqual(controller.getSnapshot().items, []);
    assert.ok(controller.getAuthorizationEpoch() > incarnation);
  } finally { controller.dispose(); }
});

test("post-command status refresh supersedes an earlier held poll, without replaying the command", async () => {
  const gate = deferred<Response>(); let hold = false, connected = false, writes = 0;
  const controller = new SshConnectionsController(async (input, init) => {
    if (init?.method === "POST") { connected = true; writes++; return json({}); }
    if (String(input).endsWith("/session")) return json({ available: true, authenticated: true });
    if (String(input).endsWith("/legacy-connections")) return json([]);
    if (hold && !connected) return gate.promise; // Old server response deliberately ignores cancellation.
    return json([{ ...row, state: connected ? "open" : "idle" }]);
  });
  try {
    await controller.refresh(); hold = true;
    const earlierPoll = controller.refresh(); await flush();
    await controller.connect(row);
    assert.equal(controller.getSnapshot().items[0]?.state, "open");
    gate.resolve(json([row])); await earlierPoll;
    assert.equal(controller.getSnapshot().items[0]?.state, "open"); assert.equal(writes, 1);
  } finally { controller.dispose(); }
});

test("temporary polling failure keeps the last valid source projection until successful recovery", async () => {
  const clock = discoveryClock(); let unavailable = false;
  const controller = new SshConnectionsController(async input => {
    if (unavailable) throw new Error("synthetic network loss");
    if (String(input).endsWith("/session")) return json({ available: true, authenticated: true });
    return json(String(input).endsWith("/legacy-connections") ? [] : [row]);
  });
  try {
    await controller.startDiscovery(clock.lifecycle); const incarnation = controller.getAuthorizationEpoch();
    unavailable = true; await clock.tick();
    assert.equal(controller.getSnapshot().authenticated, true); assert.ok(controller.getSnapshot().error);
    assert.deepEqual(controller.getSnapshot().items, [row]); assert.equal(controller.getAuthorizationEpoch(), incarnation);
    unavailable = false; await clock.wake(); assert.equal(controller.getSnapshot().error, null);
  } finally { controller.dispose(); }
});

test("SSH controller uses a browser-compatible fetch call and never retains credentials", async () => {
  const previous = globalThis.fetch; const bodies: string[] = [];
  globalThis.fetch = function (input, init) {
    assert.equal(this, globalThis);
    if (init?.body) bodies.push(String(init.body));
    if (String(input).endsWith("/session")) return Promise.resolve(json({ available: true, authenticated: true }));
    return Promise.resolve(json(String(input).endsWith("/legacy-connections") ? [] : [row]));
  } as typeof fetch;
  const controller = new SshConnectionsController();
  try {
    await controller.unlock("synthetic-access-only");
    await controller.save(controller.getSnapshot().items[0]!, { ...row, password: "synthetic-password-only" });
    assert.equal(controller.getSnapshot().authenticated, true);
    assert.equal(controller.getSnapshot().items.length, 1);
    assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /synthetic-access|synthetic-password|password/);
    assert.equal(bodies.length, 2);
  } finally { controller.dispose(); globalThis.fetch = previous; }
});

test("late refresh cannot repopulate catalog after lock; mutations are not replayed", async () => {
  const gate = deferred<Response>(); let hold = false; const requests: string[] = [];
  const controller = new SshConnectionsController(async (input, init) => {
    const path = String(input); requests.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/session")) return json({ available: true, authenticated: true });
    if (init?.method === "POST") throw new Error("synthetic lost acknowledgement");
    if (hold && path.endsWith("/connections")) return gate.promise; // ignores AbortSignal deliberately
    return json(path.endsWith("/legacy-connections") ? [] : [row]);
  });
  try {
    await controller.refresh(); hold = true;
    const pending = controller.refresh(); await new Promise(resolve => setImmediate(resolve));
    await controller.lock(); gate.resolve(json([row])); await pending;
    assert.equal(controller.getSnapshot().authenticated, false); assert.deepEqual(controller.getSnapshot().items, []);
    await assert.rejects(controller.probe("fixture.invalid", 22), /结果尚未确认/);
    assert.equal(requests.filter(request => request.startsWith("POST ")).length, 1);
  } finally { controller.dispose(); }
});

test("expired authorization clears both database and legacy projections", async () => {
  let expired = false;
  const controller = new SshConnectionsController(async input => {
    const path = String(input);
    if (path.endsWith("/session")) return json({ available: true, authenticated: true });
    if (expired) return json({ error: "locked" }, 401);
    return json(path.endsWith("/legacy-connections") ? [{ serverId: "ssh:legacy", displayName: "Legacy", workspaceBrowseRoots: ["/"] }] : [row]);
  });
  try {
    await controller.refresh(); assert.equal(controller.getSnapshot().legacyServers.length, 1);
    expired = true; await controller.refresh();
    assert.equal(controller.getSnapshot().authenticated, false); assert.deepEqual(controller.getSnapshot().items, []); assert.deepEqual(controller.getSnapshot().legacyServers, []);
  } finally { controller.dispose(); }
});

test("a temporary discovery failure is not unsupported and can recover without reloading", async () => {
  let unavailable = true;
  const controller = new SshConnectionsController(async () => {
    if (unavailable) throw new Error("synthetic network loss");
    return json({ available: true, authenticated: false });
  });
  try {
    await controller.refresh(); assert.equal(controller.getSnapshot().available, null);
    unavailable = false; await controller.refresh(); assert.equal(controller.getSnapshot().available, true);
    assert.equal(controller.getSnapshot().error, null);
  } finally { controller.dispose(); }
});

test("connect and reconnect failures refresh physical state without replaying the operation", async () => {
  for (const action of ["connect", "reconnect"] as const) {
    const requests: string[] = []; let failed = false;
    const controller = new SshConnectionsController(async (input, init) => {
      const path = String(input); requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/session")) return json({ available: true, authenticated: true });
      if (init?.method === "POST") { failed = true; return json({ error: "unavailable" }, 503); }
      return json(path.endsWith("/legacy-connections") ? [] : [{ ...row, state: failed ? "failed" : "idle" }]);
    });
    try {
      await controller.refresh();
      await assert.rejects(controller[action](controller.getSnapshot().items[0]!), /暂时无法连接/);
      assert.equal(controller.getSnapshot().items[0]?.state, "failed");
      assert.deepEqual(requests.filter(request => request.startsWith("POST ")), [`POST /__opencraft_ssh/connections/${row.serverId}/${action}`]);
    } finally { controller.dispose(); }
  }
});

test("authorization incarnation fences reads immediately on lock without changing on status refresh", async () => {
  const gate = deferred<Response>();
  const controller = new SshConnectionsController(async (input, init) => {
    if (String(input).endsWith("/session")) {
      if (init?.method === "DELETE") return gate.promise;
      return json({ available: true, authenticated: true });
    }
    return json(String(input).endsWith("/legacy-connections") ? [] : [row]);
  });
  try {
    await controller.unlock("synthetic-access-only");
    const authorized = controller.getAuthorizationEpoch();
    await controller.refresh();
    assert.equal(controller.getAuthorizationEpoch(), authorized);
    const locked = controller.lock();
    assert.ok(controller.getAuthorizationEpoch() > authorized, "revocation must fence reads before a delayed logout receipt");
    gate.resolve(json({})); await locked;
    await controller.unlock("synthetic-access-only");
    assert.ok(controller.getAuthorizationEpoch() > authorized + 1);
  } finally { controller.dispose(); }
});

for (const accessMode of ["shared", "access-key"] as const) {
  test(`origin mismatch ${accessMode} admission never exposes the old HTTP catalog`, async () => {
    let origin = "http://join.fixture.invalid", grants = 0, reads = 0;
    const expected = "https://join.fixture.invalid";
    const controller = new SshConnectionsController(async (input, init) => {
      if (init?.method === "POST") { grants++; origin = expected; return json({ authenticated: true }); }
      if (String(input).endsWith("/session")) return json({ available: true, authenticated: true, accessMode, authenticatedOrigin: origin });
      reads++; return json([]);
    }, expected);
    try {
      await controller.refresh();
      assert.equal(controller.getSnapshot().authenticated, accessMode === "shared");
      assert.equal(grants, accessMode === "shared" ? 1 : 0);
      assert.equal(reads, accessMode === "shared" ? 2 : 0);
      assert.equal(controller.getSnapshot().error, null);
      const incarnation = controller.getAuthorizationEpoch();
      await controller.refresh();
      assert.equal(controller.getAuthorizationEpoch(), incarnation, "matching grant must not churn the WebSocket lease");
      assert.equal(grants, accessMode === "shared" ? 1 : 0);
    } finally { controller.dispose(); }
  });
}

test("socket preflight renews an expired shared grant without discovery wake and coalesces concurrent recovery", async () => {
  let authenticated = true, grants = 0;
  const methods: string[] = [];
  const controller = new SshConnectionsController(async (input, init) => {
    methods.push(`${init?.method ?? "GET"} ${input}`);
    if (init?.method === "POST") { grants++; authenticated = true; return json({ authenticated: true }); }
    if (String(input).endsWith("/session")) return json({ available: true, authenticated, accessMode: "shared" });
    return json(String(input).endsWith("/legacy-connections") ? [] : [row]);
  });
  try {
    await controller.refresh();
    authenticated = false; methods.length = 0;
    await Promise.all([controller.prepareConnection(), controller.prepareConnection()]);
    assert.equal(grants, 1);
    assert.equal(controller.getSnapshot().authenticated, true);
    assert.deepEqual(methods, ["GET /__opencraft_ssh/session", "POST /__opencraft_ssh/session", "GET /__opencraft_ssh/connections", "GET /__opencraft_ssh/legacy-connections"]);
  } finally { controller.dispose(); }
});

test("socket preflight cannot admit locked access-key or failed shared renewal", async () => {
  for (const accessMode of ["shared", "access-key"] as const) {
    let grants = 0;
    const controller = new SshConnectionsController(async (_input, init) => {
      if (init?.method === "POST") { grants++; return json({ error: "unavailable" }, 503); }
      return json({ available: true, authenticated: false, accessMode });
    });
    try {
      await assert.rejects(controller.prepareConnection(), accessMode === "shared" ? /连接已失效/ : /解锁/);
      assert.equal(grants, accessMode === "shared" ? 1 : 0);
    } finally { controller.dispose(); }
  }
});
