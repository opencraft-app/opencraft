import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { ActorStore } from "../../packages/access-control/src/actors";
import { ActorAccess } from "../../packages/access-control/src/actor-access";
import { HeadlessConnectors } from "../../packages/connector-host/src/headless";
import { ManagedConnectorService } from "../../packages/connector-host/src/service";
import { SessionCapabilities } from "../../packages/session-capabilities/src/index";
import { SessionCapabilityMcp } from "../../packages/session-capabilities/src/mcp";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CapabilitySession } from "../../packages/session-capabilities/src/index";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "headless-connectors-"));
  const actors = new ActorStore(join(root, "actors.sqlite")), capabilities = new SessionCapabilities();
  const revoked = new Set<string>();
  const principal = (id: string) => ({ provider: "fixture", subject: id, displayName: id, expiresAt: Date.now() + 600000 });
  const access = new ActorAccess(actors, { authenticateHuman: request => {
    const id = request.headers["x-fixture-human"]; return typeof id === "string" ? principal(id) : null;
  }, isHumanCurrent: p => !revoked.has(p.subject), admitted: () => true, administrator: () => false });
  let calls = 0, fail = false;
  const external = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    assert.equal(req.headers.authorization, "synthetic-private-token");
    let raw = ""; for await (const part of req) raw += part;
    const message = JSON.parse(raw);
    if (!Object.hasOwn(message, "id")) { res.writeHead(202); res.end(); return; }
    const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "external-fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: ["read", "write"].map(name => ({ name, description: name, inputSchema: { type: "object", properties: { value: { type: "string" } } }, annotations: { readOnlyHint: name === "read" } })) }
      : { content: [{ type: "text", text: JSON.stringify({ received: message.params.arguments }) }], isError: fail };
    if (message.method === "tools/call") calls++;
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>(resolve => external.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(external.address() as { port: number }).port}/mcp`;
  const hosts = { "host-a": "server:fixture:a", "host-b": "server:fixture:b", "host-c": "server:fixture:c" };
  const open = () => new HeadlessConnectors(join(root, "connectors"), access, hosts, capabilities, () => true, path => new ManagedConnectorService(path, (_input, init) => fetch(url, init)));
  let service = open();
  const http = createServer(async (req, res) => { if (!await service.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const request = async (user: string, method: string, params: unknown = {}, hostId = "host-a", extra: Record<string, string> = {}) => fetch(origin + "/__opencraft_connectors", {
    method: "POST", headers: { "content-type": "application/json", origin, ...(user ? { "x-fixture-human": user } : {}), ...extra }, body: JSON.stringify({ hostId, method, params }),
  });
  const manage = async (user: string, method: string, params: unknown = {}, hostId = "host-a") => {
    const response = await request(user, method, params, hostId); const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const save = (user: string) => manage(user, "connectors/managed/save", { id: "docs", definitionId: "tencent-docs", title: "Documents", expectedRevision: 0, values: {}, secrets: { token: "synthetic-private-token" } });
  const session = (threadId = "one", hostId: keyof typeof hosts = "host-a") => ({ serverId: hosts[hostId], threadId });
  const model = async (session: CapabilitySession, name: string, args: unknown) => {
    const result = await capabilities.call(session, name, args, new AbortController().signal); return JSON.parse(result.contentItems[0].text);
  };
  const handle = async (s: CapabilitySession, name = "read") => {
    const page = await model(s, "connectors_search_tools", { query: name });
    const ref = page.items.find((item: { name: string }) => item.name === name).toolRef;
    return (await model(s, "connectors_get_tool", { toolRefs: [ref] })).items[0].handle;
  };
  const select = async (user = "alice", threadId = "one", hostId: keyof typeof hosts = "host-a") => {
    await manage(user, "connect", { id: "docs" }, hostId); await manage(user, "select", { id: "docs", threadId, enabled: true }, hostId);
  };
  t.after(async () => { await service.close(); actors.close(); for (const server of [http, external]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } await rm(root, { recursive: true, force: true }); });
  return { actors, capabilities, access, request, manage, save, session, model, handle, select, revoked, hosts, calls: () => calls, fail: () => { fail = true; },
    restart: async () => { await service.close(); service = open(); } };
}

test("browser-independent real MCP execution is isolated by Actor, Server and Thread", async t => {
  const f = await fixture(t); await f.save("alice");
  assert.equal((await f.manage("bob", "state")).instances.length, 0);
  await assert.rejects(f.manage("bob", "connect", { id: "docs" }));
  await f.select();
  assert.equal(f.capabilities.tools(f.session()).length, 3);
  assert.equal(f.capabilities.tools(f.session("two")).length, 0);
  assert.equal(f.capabilities.tools(f.session("one", "host-b")).length, 0);
  const handle = await f.handle(f.session());
  // No browser, no browser-owned AppServer dynamic tool handler: the signed session MCP is sufficient.
  const gateway = new SessionCapabilityMcp(f.capabilities, randomBytes(32)); await gateway.listen(); t.after(() => gateway.close());
  const config = gateway.config(f.session()) as { url: string; http_headers: Record<string, string> };
  const client = new Client({ name: "headless-model", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.http_headers } })); t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 3);
  assert.equal((await client.callTool({ name: "connectors_call_tool", arguments: { handle, arguments: { value: "headless" } } })).isError, false);
  assert.equal(f.calls(), 1);
  await f.manage("alice", "select", { id: "docs", threadId: "two", enabled: true });
  await assert.rejects(f.model(f.session("two"), "connectors_call_tool", { handle, arguments: {} }), /stale-handle/);
  for (const host of ["host-b", "host-c"] as const) {
    await f.select("alice", "one", host);
    await f.model(f.session("one", host), "connectors_call_tool", { handle: await f.handle(f.session("one", host)), arguments: {} });
  }
  assert.equal(f.calls(), 3);
  await f.save("bob"); await f.manage("bob", "connect", { id: "docs" });
  assert.equal((await f.request("bob", "select", { id: "docs", threadId: "one", enabled: true })).status, 403);
  f.fail();
  assert.equal((await f.capabilities.call(f.session(), "connectors_call_tool", { handle, arguments: {} }, new AbortController().signal)).success, false);
});

test("writes wait for one exact approval; deselection cancels pending effects and stale approval cannot execute", async t => {
  const f = await fixture(t); await f.save("alice"); await f.select();
  const handle = await f.handle(f.session(), "write");
  const pending = f.model(f.session(), "connectors_call_tool", { handle, arguments: { value: "original" } });
  let approval;
  for (let i = 0; i < 50; i++) { approval = (await f.manage("alice", "state")).approvals[0]; if (approval) break; await delay(5); }
  assert.ok(approval); assert.equal(f.calls(), 0); assert.match(approval.argumentsPreview, /original/);
  assert.equal((await f.request("bob", "approval", { id: approval.id, allow: true })).status, 403);
  await f.manage("alice", "approval", { id: approval.id, allow: true }); await pending; assert.equal(f.calls(), 1);
  assert.equal((await f.request("alice", "approval", { id: approval.id, allow: true })).status, 403);
  const cancelled = f.model(f.session(), "connectors_call_tool", { handle, arguments: { value: "cancel" } });
  const rejected = assert.rejects(cancelled, /cancelled|approval-denied|authorization-required|stale-handle/);
  for (let i = 0; i < 50; i++) { if ((await f.manage("alice", "state")).approvals.length) break; await delay(5); }
  await f.manage("alice", "select", { id: "docs", threadId: "one", enabled: false }); await rejected; assert.equal(f.calls(), 1);
  assert.equal((await f.manage("alice", "state")).approvals.length, 0);
});

test("management rejects raw calls, anonymous/session bearers, cross-origin requests; logout and revision changes revoke handles", async t => {
  const f = await fixture(t); await f.save("alice"); await f.select();
  assert.equal((await f.request("", "state")).status, 401);
  assert.equal((await f.request("alice", "state", {}, "host-a", { origin: "https://foreign.test" })).status, 403);
  assert.equal((await f.request("alice", "connectors/managed/call", {})).status, 400);
  assert.equal((await f.request("alice", "state", {}, "foreign-host")).status, 400);
  const actor = f.actors.createSession("session", "fixture"), token = f.actors.issueCredential(actor.id, Date.now() + 60000, "fixture").token;
  assert.equal((await f.request("", "state", {}, "host-a", { authorization: `Bearer ${token}` })).status, 401);
  const handle = await f.handle(f.session());
  await f.manage("alice", "connectors/managed/setEnabled", { id: "docs", revision: 1, enabled: false });
  assert.equal(f.capabilities.tools(f.session()).length, 0);
  await assert.rejects(f.model(f.session(), "connectors_call_tool", { handle, arguments: {} }));
  await f.manage("alice", "connectors/managed/setEnabled", { id: "docs", revision: 2, enabled: true });
  await f.manage("alice", "connect", { id: "docs" });
  assert.equal(f.capabilities.tools(f.session()).length, 0, "reconnection does not reinstate prior consent");
  await f.manage("alice", "select", { id: "docs", threadId: "one", enabled: true });
  f.revoked.add("alice"); assert.equal(f.capabilities.tools(f.session()).length, 0, "original login authority is rechecked without a browser request");
  assert.equal(f.calls(), 0);
});

test("restart retains configuration but never session consent or temporary handles", async t => {
  const f = await fixture(t); await f.save("alice"); await f.select(); const handle = await f.handle(f.session());
  await f.restart();
  const state = await f.manage("alice", "state");
  assert.equal(state.instances.length, 1); assert.deepEqual(state.selections, []); assert.deepEqual(state.approvals, []);
  assert.ok(!JSON.stringify(state).includes("synthetic-private-token"));
  assert.equal(f.capabilities.tools(f.session()).length, 0);
  await assert.rejects(f.model(f.session(), "connectors_call_tool", { handle, arguments: {} }));
});
