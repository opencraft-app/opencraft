import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import { AuthenticationService, ConnectorCapabilityRuntime, ConnectorRuntime, type ConnectorProvider, type ConnectorToolResource } from "@opencraft/workbench-runtime";
import { connectorProviderAdapter } from "../apps/workbench-web/src/runtime/connector-contributions";

const scope = { hostId: "local", threadId: "thread-one" };
const signal = () => new AbortController().signal;
function authFixture() {
  let session: { status: "anonymous" | "authenticated"; epoch: number } = { status: "authenticated", epoch: 1 };
  const listeners = new Set<() => void>();
  return {
    getSession: () => session,
    subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; },
    update(status: "anonymous" | "authenticated") { session = { status, epoch: session.epoch + 1 }; for (const f of listeners) f(); },
  };
}
function fixture(overrides: Partial<ConnectorToolResource> = {}) {
  let calls = 0, closed = 0;
  const resource: ConnectorToolResource = { tools: [{ name: "echo", description: "Echo fixture", readOnly: true, inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
    checkAccess: async () => true, call: async (_name, value) => { calls++; return value; }, dispose: () => { closed++; }, ...overrides };
  const provider: ConnectorProvider = { id: "test.connector", title: "Fixture", authenticationProviderId: "test.auth", contributions: [{ id: "echo", kind: "tools", prepare: async () => resource }] };
  return { resource, provider, calls: () => calls, closed: () => closed };
}

test("authorization, explicit selection and scoped handles gate every invocation", async () => {
  const auth = authFixture(), runtime = new ConnectorRuntime(auth), f = fixture();
  runtime.register("owner", f.provider);
  try {
    auth.update("anonymous");
    const denied = await runtime.connect(f.provider.id, "local", "denied");
    assert.equal(denied.phase, "authorization-required");
    assert.equal(f.calls(), 0);
    auth.update("authenticated");
    const connected = await runtime.connect(f.provider.id, "local", "connect");
    assert.equal(connected.phase, "ready");
    assert.equal((await runtime.discover(scope, signal())).length, 0, "connection alone does not grant a conversation access");
    runtime.select(scope, [connected.connectionId]);
    const [tool] = await runtime.discover(scope, signal());
    assert.deepEqual(await runtime.invoke(scope, tool.handle, { text: "yes" }, signal()), { text: "yes" });
    await assert.rejects(runtime.invoke({ ...scope, threadId: "foreign" }, tool.handle, {}, signal()), /stale-handle/);
    await assert.rejects(runtime.invoke({ ...scope, hostId: "foreign" }, tool.handle, {}, signal()), /stale-handle/);
    assert.equal(f.calls(), 1);
    auth.update("anonymous");
    await assert.rejects(runtime.invoke(scope, tool.handle, {}, signal()), /stale-handle/);
    assert.equal(f.calls(), 1);
    assert.equal(runtime.getSnapshot().connections.at(-1)?.phase, "authorization-required");
  } finally { await runtime.dispose(); }
});

test("disconnect fences late preparation and disposes its resource without resurrection", async () => {
  const auth = authFixture(), runtime = new ConnectorRuntime(auth), f = fixture();
  let release!: (value: ConnectorToolResource) => void;
  runtime.register("owner", { ...f.provider, contributions: [{ id: "late", kind: "tools", prepare: () => new Promise(resolve => { release = resolve; }) }] });
  try {
    const pending = runtime.connect(f.provider.id, "local", "op");
    await Promise.resolve();
    const id = runtime.getSnapshot().connections[0].connectionId;
    await runtime.disconnect(id);
    assert.equal((await pending).phase, "disconnected");
    release(f.resource); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.closed(), 1);
    assert.equal((await runtime.connect(f.provider.id, "local", "op")).phase, "disconnected", "retrying a cancelled operation is not a new connect intent");
  } finally { await runtime.dispose(); }
});

test("Skill-only connectors do not create tool connections and partial failures are explicit", async () => {
  const runtime = new ConnectorRuntime(authFixture()), f = fixture();
  runtime.register("owner", { ...f.provider, contributions: [
    { id: "tools", kind: "tools", prepare: async () => f.resource },
    { id: "skill", kind: "skills", prepare: async () => ({ receipt: { installationId: "install-1", refresh: "pending" }, dispose() {} }) },
    { id: "broken", kind: "tools", prepare: async () => { throw new Error("secret-token-must-not-leak"); } },
  ] });
  runtime.register("owner", { id: "test.skillonly", title: "Only Skill", contributions: [{ id: "skill", kind: "skills", prepare: async () => ({ receipt: { installationId: "install-2", refresh: "applied" }, dispose() {} }) }] });
  try {
    const result = await runtime.connect(f.provider.id, "local", "mixed");
    assert.equal(result.phase, "partial");
    assert.deepEqual(result.contributions.map(c => c.phase), ["ready", "pending", "failed"]);
    assert.ok(!JSON.stringify(result).includes("secret-token"));
    const skill = await runtime.connect("test.skillonly", "local", "skill-only");
    runtime.select(scope, [skill.connectionId]);
    assert.equal(skill.phase, "ready");
    assert.deepEqual(await runtime.discover(scope, signal()), []);
  } finally { await runtime.dispose(); }
});

test("revocation cancels in-flight calls and late results cannot reach the consumer", async () => {
  const auth = authFixture(), runtime = new ConnectorRuntime(auth);
  let resolveResult!: (value: unknown) => void;
  let invocationSignal: AbortSignal | undefined;
  const f = fixture({ call: (_name, _input, context) => { invocationSignal = context.signal; return new Promise(resolve => { resolveResult = resolve; }); } });
  runtime.register("owner", f.provider);
  try {
    const connection = await runtime.connect(f.provider.id, "local", "first");
    runtime.select(scope, [connection.connectionId]);
    const [tool] = await runtime.discover(scope, signal());
    const invocation = runtime.invoke(scope, tool.handle, {}, signal());
    const rejection = assert.rejects(invocation, /cancelled|stale-handle/);
    await new Promise(resolve => setTimeout(resolve, 0));
    await runtime.disconnect(connection.connectionId);
    assert.equal(invocationSignal?.aborted, true);
    resolveResult({ secret: "late-private-output" });
    await rejection;
    const next = await runtime.connect(f.provider.id, "local", "second");
    assert.notEqual(next.connectionId, connection.connectionId);
    await assert.rejects(runtime.invoke(scope, tool.handle, {}, signal()), /stale-handle/);
    assert.deepEqual(await runtime.discover(scope, signal()), [], "reconnection does not silently reselect a different account generation");
  } finally { await runtime.dispose(); }
});

test("service access is rechecked at invocation and scope deselection revokes handles", async () => {
  const runtime = new ConnectorRuntime(authFixture());
  let allow = true;
  const f = fixture({ checkAccess: async () => allow }); runtime.register("owner", f.provider);
  try {
    const c = await runtime.connect(f.provider.id, "local", "op"); runtime.select(scope, [c.connectionId]);
    const [tool] = await runtime.discover(scope, signal());
    allow = false;
    await assert.rejects(runtime.invoke(scope, tool.handle, {}, signal()), /unavailable/);
    assert.equal(f.calls(), 0);
    allow = true; runtime.select(scope, []);
    await assert.rejects(runtime.invoke(scope, tool.handle, {}, signal()), /stale-handle/);
  } finally { await runtime.dispose(); }
});

test("real extension transaction owns Connector registration and borrowed Authentication epoch", async () => {
  const ctx = new Context(); const authFiber = ctx.plugin(AuthenticationService); await authFiber;
  const auth = authFixture();
  const removeAuth = ctx.authentication.register("fixture", { id: "test.auth", getSession: auth.getSession, subscribe: auth.subscribe,
    signIn: async () => ({ status: "authenticated", epoch: auth.getSession().epoch }), cancelSignIn: async () => {} });
  const runtime = new ConnectorRuntime(ctx.authentication), f = fixture();
  const extensions = new ExtensionSupervisor({ platform: "web", internalContributions: { connectorProvider: connectorProviderAdapter(runtime) } });
  try {
    await extensions.activate({ manifest: { manifestVersion: 1, id: "test.connector", name: "Fixture", version: "1.0.0", apiVersion: 1, trust: "trusted", platforms: ["web"], activationEvents: ["*"] },
      activate(api) { api.internal.register("connectorProvider", f.provider); } });
    assert.equal(runtime.listProviders().length, 1);
    const c = await runtime.connect(f.provider.id, "local", "ext-connect"); runtime.select(scope, [c.connectionId]);
    const [tool] = await runtime.discover(scope, signal());
    await extensions.deactivate("test.connector");
    assert.equal(runtime.listProviders().length, 0);
    await assert.rejects(runtime.invoke(scope, tool.handle, {}, signal()), /stale-handle/);
    assert.equal(f.closed(), 1);
    assert.equal(ctx.authentication.getSession("test.auth")?.status, "authenticated", "unloading a Connector does not log out its shared account");
  } finally { await extensions.dispose(); await runtime.dispose(); removeAuth(); await authFiber.dispose(); }
});

test("timeouts are bounded and abandoned providers cannot publish late success", async () => {
  const runtime = new ConnectorRuntime(authFixture(), 10), f = fixture();
  let complete!: (r: ConnectorToolResource) => void;
  runtime.register("owner", { ...f.provider, contributions: [{ id: "late", kind: "tools", prepare: () => new Promise(resolve => { complete = resolve; }) }] });
  try {
    const result = await runtime.connect(f.provider.id, "local", "timeout");
    assert.equal(result.phase, "failed");
    complete(f.resource); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(f.closed(), 1);
    assert.equal(runtime.getSnapshot().connections[0].phase, "failed");
  } finally { await runtime.dispose(); }
});

test("snapshots are stable between changes and declaration mutation cannot rewrite a live registration", async () => {
  const runtime = new ConnectorRuntime(authFixture()), f = fixture();
  const stop = runtime.register("owner", f.provider);
  const before = runtime.getSnapshot();
  assert.equal(runtime.getSnapshot(), before);
  try {
    const connection = await runtime.connect(f.provider.id, "local", "op");
    assert.notEqual(runtime.getSnapshot(), before);
    assert.ok(Object.isFrozen(runtime.getSnapshot().connections));
    runtime.select(scope, [connection.connectionId]);
    const [tool] = await runtime.discover(scope, signal());
    (f.resource.tools[0] as { name: string }).name = "changed-after-publication";
    f.resource.call = async () => ({ replacedImplementation: true });
    assert.deepEqual(await runtime.invoke(scope, tool.handle, {}, signal()), {});
    await stop();
    await assert.rejects(runtime.invoke(scope, tool.handle, {}, signal()), /stale-handle/);
  } finally { await runtime.dispose(); }
});

test("an already-cancelled call never reaches the provider", async () => {
  const runtime = new ConnectorRuntime(authFixture()), f = fixture();
  runtime.register("owner", f.provider);
  try {
    const c = await runtime.connect(f.provider.id, "local", "op"); runtime.select(scope, [c.connectionId]);
    const [tool] = await runtime.discover(scope, signal());
    const abort = new AbortController(); abort.abort();
    await assert.rejects(runtime.invoke(scope, tool.handle, {}, abort.signal), /cancelled/);
    assert.equal(f.calls(), 0);
  } finally { await runtime.dispose(); }
});

test("synchronous provider errors do not leak transport or credential details", async () => {
  const runtime = new ConnectorRuntime(authFixture());
  const f = fixture({ call() { throw new Error("secret-value-in-provider-error"); } });
  runtime.register("owner", f.provider);
  try {
    const c = await runtime.connect(f.provider.id, "local", "op"); runtime.select(scope, [c.connectionId]);
    const [tool] = await runtime.discover(scope, signal());
    await assert.rejects(runtime.invoke(scope, tool.handle, {}, signal()), error => error instanceof Error && error.message === "Connector failed");
  } finally { await runtime.dispose(); }
});

test("capability runtime paginates a 224-tool catalog without expanding schemas and opens only exact details", async () => {
  const runtime = new ConnectorRuntime(authFixture());
  let calls = 0;
  const tools = Array.from({ length: 224 }, (_, index) => ({
    name: `docs_tool_${String(index).padStart(3, "0")}`,
    description: `Tencent Docs fixture tool ${index} ${"description ".repeat(80)}`,
    readOnly: true,
    inputSchema: { type: "object", properties: { content: { type: "string", description: "schema ".repeat(1200) } } },
  }));
  const resource: ConnectorToolResource = {
    tools,
    checkAccess: async () => true,
    call: async name => { calls++; return { name }; },
    dispose() {},
  };
  runtime.register("owner", { id: "tencent.docs", title: "Tencent Docs", contributions: [{ id: "mcp-tools", kind: "tools", prepare: async () => resource }] });
  const capabilities = new ConnectorCapabilityRuntime(runtime);
  try {
    const connected = await runtime.connect("tencent.docs", "local", "connect");
    runtime.select(scope, [connected.connectionId]);
    let cursor: string | undefined;
    const found: string[] = [];
    do {
      const page = await capabilities.search(scope, cursor ? { cursor, limit: 20 } : { connectorId: "tencent.docs", limit: 20 }, signal());
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 64 * 1024);
      assert.ok(page.items.every(item => !("inputSchema" in item) && !("handle" in item)));
      found.push(...page.items.map(item => item.name));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(found.length, 224);
    assert.equal(new Set(found).size, 224);

    const search = await capabilities.search(scope, { query: "docs_tool_137" }, signal());
    assert.deepEqual(search.items.map(item => item.name), ["docs_tool_137"]);
    const detail = await capabilities.detail(scope, [search.items[0]!.toolRef], signal());
    assert.equal(detail.items[0]!.inputSchema.type, "object");
    assert.deepEqual(await runtime.invoke(scope, detail.items[0]!.handle, {}, signal()), { name: "docs_tool_137" });
    assert.equal(calls, 1);
  } finally { capabilities.dispose(); await runtime.dispose(); }
});

test("capability cursors and tool references are fenced by selection generation and schema budgets", async () => {
  const runtime = new ConnectorRuntime(authFixture());
  const f = fixture({ tools: [
    { name: "small", description: "Small", readOnly: true, inputSchema: { type: "object" } },
    { name: "oversized", description: "Oversized", readOnly: true, inputSchema: { type: "object", description: "x".repeat(60 * 1024) } },
  ] });
  runtime.register("owner", f.provider);
  const capabilities = new ConnectorCapabilityRuntime(runtime);
  try {
    const connected = await runtime.connect(f.provider.id, "local", "connect");
    runtime.select(scope, [connected.connectionId]);
    const first = await capabilities.search(scope, { limit: 1 }, signal());
    assert.ok(first.nextCursor);
    runtime.select(scope, [connected.connectionId]);
    await assert.rejects(capabilities.search(scope, { cursor: first.nextCursor! }, signal()), /stale-cursor/);
    await assert.rejects(capabilities.detail(scope, [first.items[0]!.toolRef], signal()), /stale-handle/);

    const oversized = await capabilities.search(scope, { query: "oversized" }, signal());
    await assert.rejects(capabilities.detail(scope, [oversized.items[0]!.toolRef], signal()), /tool-schema-too-large/);
  } finally { capabilities.dispose(); await runtime.dispose(); }
});
