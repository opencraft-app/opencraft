import assert from "node:assert/strict";
import test from "node:test";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const config = (revision = "one") => ({ url: "http://fixture/mcp/" + revision, http_headers: { Authorization: "synthetic" } });
function fixture() {
  const adapter: any = Object.create(CodexEngineAdapter.prototype);
  let configuration: any = config(), status = "idle";
  const calls: Array<{ method: string; params: any }> = [];
  Object.assign(adapter, { options: { sessionMcp: async () => configuration }, sessionMcpConfigurations: new Map(),
    sessionMcpRefreshes: new Map(), sessionMcpGeneration: 0, statusListeners: new Set(), cancelNativeRelease() {},
    async requestPhysical(method: string, params: any) {
      calls.push({ method, params });
      if (method === "thread/read") { assert.equal(params.includeTurns, false); return { thread: { status: { type: status } } }; }
      if (method === "thread/resume") {
        assert.equal(params.excludeTurns, true);
        return { model: "preserved", cwd: "/original", approvalPolicy: "on-request", activePermissionProfile: { id: "profile" }, reasoningEffort: "high" };
      }
      return {};
    } });
  return { adapter, calls, setConfig(value: any) { configuration = value; }, setStatus(value: string) { status = value; } };
}
const applied = (f: ReturnType<typeof fixture>) => f.calls.filter(c => c.method === "thread/resume" && c.params.config);

test("concurrent preparation shares one refresh; unchanged configurations issue no native RPC", async () => {
  const f = fixture(), gate = deferred(), request = f.adapter.requestPhysical;
  f.adapter.requestPhysical = async (method: string, params: any) => { if (method === "thread/read") await gate.promise; return request(method, params); };
  const first = f.adapter.prepareSessionMcp("one"), second = f.adapter.prepareSessionMcp("one");
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(applied(f).length, 1); assert.equal(f.calls.filter(c => c.method === "thread/unsubscribe").length, 1);
  assert.deepEqual(f.calls.at(-1), { method: "thread/settings/update", params: { threadId: "one", permissions: "profile", approvalPolicy: "on-request", model: "preserved", effort: "high" } });
  const count = f.calls.length;
  f.setConfig({ http_headers: { Authorization: "synthetic" }, url: "http://fixture/mcp/one" });
  await f.adapter.prepareSessionMcp("one"); assert.equal(f.calls.length, count);
});

test("a waiting preparation resolves the latest configuration instead of restoring an older snapshot", async () => {
  const f = fixture(), gate = deferred(), entered = deferred(), request = f.adapter.requestPhysical;
  f.adapter.requestPhysical = async (method: string, params: any) => { if (method === "thread/read") { entered.resolve(); await gate.promise; } return request(method, params); };
  const first = f.adapter.prepareSessionMcp("one"); await entered.promise;
  const waiting = f.adapter.prepareSessionMcp("one"); f.setConfig(config("two")); gate.resolve();
  await Promise.all([first, waiting]);
  assert.deepEqual(applied(f).map(c => c.params.config["mcp_servers.opencraft_session"].url), ["http://fixture/mcp/one", "http://fixture/mcp/two"]);
});

test("a mutable provider value cannot change a preparation already in flight", async () => {
  const f = fixture(), value = config(), gate = deferred(), entered = deferred(), request = f.adapter.requestPhysical;
  f.setConfig(value);
  f.adapter.requestPhysical = async (method: string, params: any) => { if (method === "thread/read") { entered.resolve(); await gate.promise; } return request(method, params); };
  const first = f.adapter.prepareSessionMcp("one"); await entered.promise; value.url = "http://fixture/mcp/two"; gate.resolve(); await first;
  assert.equal(applied(f)[0]!.params.config["mcp_servers.opencraft_session"].url, "http://fixture/mcp/one");
  await f.adapter.prepareSessionMcp("one"); assert.equal(applied(f).length, 2);
});

test("failed settings restoration never marks configuration applied or starts a turn", async () => {
  const f = fixture(), request = f.adapter.requestPhysical;
  let fail = true;
  f.adapter.requestPhysical = async (method: string, params: any) => { if (method === "thread/settings/update" && fail) throw new Error("settings unavailable"); return request(method, params); };
  await assert.rejects(f.adapter.writePhysical({ method: "turn/start", params: { threadId: "one" } }), /settings unavailable/);
  assert.equal(f.adapter.sessionMcpConfigurations.has("one"), false); assert.equal(f.adapter.sessionMcpRefreshes.size, 0);
  assert(!f.calls.some(c => c.method === "turn/start")); fail = false;
  await f.adapter.prepareSessionMcp("one"); assert.equal(applied(f).length, 2);
});

test("connection retirement fences late native responses and old cleanup cannot erase a new refresh", async () => {
  const f = fixture(), gate = deferred(), entered = deferred(), request = f.adapter.requestPhysical;
  let blocked = true;
  f.adapter.requestPhysical = async (method: string, params: any) => { const result = await request(method, params); if (method === "thread/read" && blocked) { entered.resolve(); await gate.promise; } return result; };
  const first = f.adapter.prepareSessionMcp("one"); const failed = assert.rejects(first, /expired connection/); await entered.promise;
  f.adapter.publishStatus({ state: "failed" }); blocked = false;
  await f.adapter.prepareSessionMcp("one"); assert.equal(applied(f).length, 1);
  gate.resolve(); await failed;
  assert.equal(applied(f).length, 1); assert.equal(f.adapter.sessionMcpConfigurations.size, 1);
});

test("an active thread rejects configuration refresh before unsubscribe or resume", async () => {
  const f = fixture(); f.setStatus("active");
  await assert.rejects(f.adapter.prepareSessionMcp("one"), /idle/);
  assert.deepEqual(f.calls.map(c => c.method), ["thread/read"]);
});

test("partial refresh invalidates the old confirmation before a provider rollback", async () => {
  const f = fixture(), request = f.adapter.requestPhysical;
  await f.adapter.prepareSessionMcp("one"); f.setConfig(config("two"));
  f.adapter.requestPhysical = async (method: string, params: any) => {
    if (method === "thread/settings/update") throw new Error("restoration failed");
    return request(method, params);
  };
  await assert.rejects(f.adapter.prepareSessionMcp("one"), /restoration failed/);
  assert.equal(f.adapter.sessionMcpConfigurations.has("one"), false);
  f.adapter.requestPhysical = request; f.setConfig(config());
  await f.adapter.prepareSessionMcp("one");
  assert.deepEqual(applied(f).map(c => c.params.config["mcp_servers.opencraft_session"].url),
    ["http://fixture/mcp/one", "http://fixture/mcp/two", "http://fixture/mcp/one"]);
});

test("a blocked thread does not serialize another thread; withdrawal is applied once", async () => {
  const f = fixture(), gate = deferred(), entered = deferred(), request = f.adapter.requestPhysical;
  f.adapter.requestPhysical = async (method: string, params: any) => { if (method === "thread/read" && params.threadId === "blocked") { entered.resolve(); await gate.promise; } return request(method, params); };
  const blocked = f.adapter.prepareSessionMcp("blocked"); await entered.promise;
  await f.adapter.prepareSessionMcp("peer"); assert.equal(applied(f).length, 1); assert.equal(applied(f)[0]!.params.threadId, "peer");
  gate.resolve(); await blocked; f.setConfig(null);
  await f.adapter.prepareSessionMcp("peer"); assert.equal(applied(f).at(-1)!.params.config["mcp_servers.opencraft_session"].enabled, false);
  const count = f.calls.length; await f.adapter.prepareSessionMcp("peer"); await f.adapter.prepareSessionMcp("new"); assert.equal(f.calls.length, count);
});

test("configuration installed at creation is reused without resuming a new empty thread", async () => {
  const f = fixture();
  f.adapter.observeMetadataResult("thread/start", { config: { "mcp_servers.opencraft_session": config() } }, { thread: { id: "new" } });
  await f.adapter.prepareSessionMcp("new"); assert.equal(f.calls.length, 0);
});
