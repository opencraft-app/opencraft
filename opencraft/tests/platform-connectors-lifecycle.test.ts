import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { asHostId, createConversationKey } from "@opencraft/chat-core";
import { AuthenticationService, ConnectorApprovalQueue, ConnectorManager, ConnectorRuntime, MemoryConnectorConfigurationStore, McpOAuthAuthenticationProvider,
  asConversationScopeId, createConversationBindingStore, emptyConnectorConfiguration, parseConnectorConfiguration } from "@opencraft/workbench-runtime";
import { DesktopConnectorConfigurationStore } from "../apps/workbench-electron/src/connector-configuration-store";
import { connectorHost, waitFor } from "./fixtures/connector-host";

test("write approval is exact, one-shot, redacted in presentation and cancelled by revocation", async () => {
  const approvals = new ConnectorApprovalQueue(), runtime = new ConnectorRuntime({ getSession: () => null, subscribe: () => () => {} }, 30000, { approvals });
  let executed: unknown[] = [];
  runtime.register("fixture", { id: "fixture.write", title: "Write", contributions: [{ id: "write", kind: "tools", prepare: async () => ({
    tools: [{ name: "write", description: "Controlled write", readOnly: false, inputSchema: { type: "object" } }], checkAccess: async () => true,
    call: async (_name, input) => { executed.push(input); return "ok"; }, dispose() {},
  }) }] });
  const scope = { hostId: "host", threadId: "thread" };
  try {
    const c = await runtime.connect("fixture.write", "host", "connect"); runtime.select(scope, [c.connectionId]);
    const [tool] = await runtime.discover(scope, new AbortController().signal);
    const input = { target: "original", token: "synthetic-secret" };
    const pending = runtime.invoke(scope, tool.handle, input, new AbortController().signal);
    input.target = "mutated";
    await waitFor(() => approvals.getSnapshot().length === 1);
    assert.equal(executed.length, 0);
    const request = approvals.getSnapshot()[0];
    assert.match(request.argumentsPreview, /original/); assert.ok(!request.argumentsPreview.includes("synthetic-secret"));
    approvals.respond(request.id, true); assert.equal(await pending, "ok");
    assert.deepEqual(executed, [{ target: "original", token: "synthetic-secret" }]);
    approvals.respond(request.id, true); assert.equal(executed.length, 1);
    const denied = runtime.invoke(scope, tool.handle, {}, new AbortController().signal);
    const rejected = assert.rejects(denied, /cancelled|approval-denied|stale-handle/);
    await waitFor(() => approvals.getSnapshot().length === 1);
    const old = approvals.getSnapshot()[0].id;
    await runtime.disconnect(c.connectionId); approvals.respond(old, true);
    await rejected; assert.equal(executed.length, 1); assert.equal(approvals.getSnapshot().length, 0);
  } finally { approvals.dispose(); await runtime.dispose(); }
});

test("native OAuth is subscribed before request, rejects foreign completion and quarantines cancellation", async () => {
  const host = await connectorHost(); const urls: Array<string | null> = [];
  const provider = new McpOAuthAuthenticationProvider("fixture.auth", host.client, "fixture", url => urls.push(url));
  try {
    const pending = provider.signIn(); await waitFor(() => urls.some(Boolean));
    host.complete(true, "foreign"); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(provider.getSession().status, "anonymous");
    await provider.cancelSignIn(); assert.deepEqual(await pending, { status: "cancelled" });
    await assert.rejects(provider.signIn(), /authorization-pending/);
    assert.equal(host.logins(), 1);
    host.complete(true); host.complete(true); await waitFor(() => provider.getSession().status === "authenticated");
    assert.equal(host.calls.filter(c => c.method === "config/mcpServer/reload").length, 1, "duplicate completion is consumed once");
    const next = provider.signIn(); await waitFor(() => host.logins() === 2); host.complete(false);
    assert.deepEqual(await next, { status: "cancelled" });
    assert.ok(host.calls.some(c => c.method === "config/mcpServer/reload"));
  } finally { provider.dispose(); await host.client.close(); }
});

test("manager persists intent, promotes a Draft binding, but restart and OAuth callbacks never restore grants automatically", async () => {
  const host = await connectorHost(); const ctx = new Context(), fiber = ctx.plugin(AuthenticationService); await fiber;
  const store = new MemoryConnectorConfigurationStore(), bindings = createConversationBindingStore();
  const scopeId = asConversationScopeId("draft-scope"), hostId = asHostId("host"); bindings.register(scopeId, hostId);
  const runtime = new ConnectorRuntime(ctx.authentication), manager = await ConnectorManager.open(runtime, ctx.authentication, bindings, store, async () => host.client);
  let second: ConnectorManager | undefined, secondRuntime: ConnectorRuntime | undefined;
  try {
    await manager.add("host", "fixture"); const id = manager.getSnapshot().configuration.connectors[0].id;
    const opening = manager.connect(id, "view"); await waitFor(() => !!manager.getSnapshot().states[id]?.authorizationUrl);
    host.complete(true); await opening;
    assert.equal(manager.getSnapshot().states[id].phase, "authorization-ready");
    assert.equal(runtime.getSnapshot().connections.length, 0, "completion alone is not a connection grant");
    await manager.connect(id, "view"); await manager.select("host", scopeId, id, true);
    bindings.bind(scopeId, createConversationKey(hostId, "thread"));
    const [oldTool] = await runtime.discover({ hostId, threadId: "thread" }, new AbortController().signal); assert.ok(oldTool);
    const saved = JSON.stringify(await store.load()); assert.ok(!saved.includes("authorizationUrl")); assert.ok(!saved.includes(oldTool.handle));
    await manager.dispose(); await runtime.dispose();
    const calls = host.calls.length;
    secondRuntime = new ConnectorRuntime(ctx.authentication);
    second = await ConnectorManager.open(secondRuntime, ctx.authentication, bindings, store, async () => host.client);
    assert.equal(host.calls.length, calls, "opening persisted configuration does not contact or authorize Hosts");
    assert.equal(second.savedSelection("host", scopeId, id), true);
    await second.connect(id, "new-view");
    assert.deepEqual(await secondRuntime.discover({ hostId, threadId: "thread" }, new AbortController().signal), []);
    await second.select("host", scopeId, id, true);
    assert.ok((await secondRuntime.discover({ hostId, threadId: "thread" }, new AbortController().signal)).length > 0);
    await assert.rejects(secondRuntime.invoke({ hostId, threadId: "thread" }, oldTool.handle, {}, new AbortController().signal), /stale-handle/);
    host.changed(); await waitFor(() => !second!.selectionConfirmed("host", scopeId, id));
    assert.deepEqual(await secondRuntime.discover({ hostId, threadId: "thread" }, new AbortController().signal), []);
  } finally { await second?.dispose(); await secondRuntime?.dispose(); await manager.dispose(); await runtime.dispose(); bindings.dispose(); await fiber.dispose(); await host.client.close(); }
});

test("closing OAuth owner cannot reconnect from a late completion", async () => {
  const host = await connectorHost(), ctx = new Context(), fiber = ctx.plugin(AuthenticationService); await fiber;
  const bindings = createConversationBindingStore(), runtime = new ConnectorRuntime(ctx.authentication);
  const manager = await ConnectorManager.open(runtime, ctx.authentication, bindings, new MemoryConnectorConfigurationStore(), async () => host.client);
  try {
    await manager.add("host", "fixture"); const id = manager.getSnapshot().configuration.connectors[0].id;
    const opening = manager.connect(id, "owner"); await waitFor(() => !!manager.getSnapshot().states[id]?.authorizationUrl);
    manager.cancelOwner("owner"); host.complete(true); await opening;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(runtime.getSnapshot().connections.length, 0);
    assert.equal(manager.getSnapshot().states[id].phase, "cancelled");
  } finally { await manager.dispose(); await runtime.dispose(); bindings.dispose(); await fiber.dispose(); await host.client.close(); }
});

test("desktop store survives reopen, rejects secrets and uses CAS instead of overwriting another writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "connector-store-")), path = join(root, "configuration.sqlite");
  let store = new DesktopConnectorConfigurationStore(path);
  const value = { ...emptyConnectorConfiguration(), connectors: [{ id: "c", hostId: "host", server: "fixture", title: "Fixture" }] };
  try {
    assert.equal(store.compareAndSet(0, value).updated, true);
    assert.equal(store.compareAndSet(0, emptyConnectorConfiguration()).updated, false);
    assert.throws(() => parseConnectorConfiguration({ ...value, token: "must-not-persist" }));
    assert.throws(() => store.compareAndSet(1, { ...value, connectors: [{ ...value.connectors[0], authorizationUrl: "https://example.test" }] }));
    store.close(); store = new DesktopConnectorConfigurationStore(path);
    assert.deepEqual(store.load(), { revision: 1, value });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("late selection persistence cannot regrant a connection revoked while saving", async () => {
  const host = await connectorHost(); host.authorize(true);
  const ctx = new Context(), fiber = ctx.plugin(AuthenticationService); await fiber;
  const store = new MemoryConnectorConfigurationStore(), bindings = createConversationBindingStore();
  const scopeId = asConversationScopeId("saving-scope"), hostId = asHostId("host");
  bindings.register(scopeId, hostId); bindings.bind(scopeId, createConversationKey(hostId, "thread"));
  let hold = false, release!: () => void, saving = false;
  const runtime = new ConnectorRuntime(ctx.authentication), manager = await ConnectorManager.open(runtime, ctx.authentication, bindings, {
    load: () => store.load(),
    async compareAndSet(revision, value) { if (hold) { saving = true; await new Promise<void>(resolve => { release = resolve; }); } return store.compareAndSet(revision, value); },
  }, async () => host.client);
  try {
    await manager.add("host", "fixture"); const id = manager.getSnapshot().configuration.connectors[0].id;
    await manager.connect(id, "owner"); hold = true;
    const pending = manager.select("host", scopeId, id, true), rejected = assert.rejects(pending, /连接已变化/);
    await waitFor(() => saving);
    await manager.disconnect(id); await manager.connect(id, "owner");
    release(); await rejected;
    assert.equal(manager.selectionConfirmed("host", scopeId, id), false);
    assert.deepEqual(await runtime.discover({ hostId, threadId: "thread" }, new AbortController().signal), []);
  } finally { release?.(); await manager.dispose(); await runtime.dispose(); bindings.dispose(); await fiber.dispose(); await host.client.close(); }
});
