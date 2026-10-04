import assert from "node:assert/strict";
import test from "node:test";
import { SshConnectionsController } from "../plugins/builtin-agents/src/ssh-connections/controller.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const row = { serverId: "ssh:fixture", revision: 1, displayName: "Fixture", hostname: "fixture.invalid", port: 22, username: "fixture", enabled: true, workspaceBrowseRoots: ["/remote"], fingerprint: `SHA256:${"a".repeat(43)}`, state: "idle" } as const;

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
