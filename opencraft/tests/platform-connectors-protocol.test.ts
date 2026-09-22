import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";
import { ConnectorRuntime, createAppServerMcpConnectorProvider, installConnectorDynamicToolHandler } from "@opencraft/workbench-runtime";

test("actual AppServer codec/interceptor → MCP adapter → loopback service, revocation and scope fences", async () => {
  let serviceCalls = 0, remoteAuthorized = true, schemaVersion = 1;
  const endpoint = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    serviceCalls++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ content: [{ type: "text", text: JSON.parse(body).text }] }));
  });
  await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}`;
  const pending = new Map<string, (value: any) => void>();
  const requests: any[] = []; let peer!: InMemoryAppServerPeer, sequence = 0;
  const transport = new MemoryTransport({ async receive(frame, connection) {
    peer = connection; const value = JSON.parse(frame);
    if (!value.method) { pending.get(value.id)?.(value); pending.delete(value.id); return; }
    if (!Object.hasOwn(value, "id")) return;
    requests.push(value);
    const send = (result: unknown) => connection.send(JSON.stringify({ jsonrpc: "2.0", id: value.id, result }));
    if (value.method === "initialize") { send({ userAgent: "connector-fixture", codexHome: "/tmp/fixture", platformFamily: "unix", platformOs: "linux" }); return; }
    if (value.method === "mcpServerStatus/list") {
      send({ data: [{ name: "fixture", authStatus: remoteAuthorized ? "bearerToken" : "notLoggedIn", tools: {
        echo: { name: "echo", description: `Echo v${schemaVersion}`, annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { text: { type: "string" } } } },
        write: { name: "write", description: "Not approved", annotations: { readOnlyHint: false }, inputSchema: { type: "object" } },
      } }], nextCursor: null }); return;
    }
    if (value.method === "mcpServer/tool/call") {
      assert.equal(value.params.threadId, "allowed");
      const response = await fetch(url, { method: "POST", body: JSON.stringify(value.params.arguments) }); send(await response.json()); return;
    }
    connection.send(JSON.stringify({ jsonrpc: "2.0", id: value.id, error: { code: -32601, message: "unsupported" } }));
  } });
  const client = new JsonRpcAppServerClient({ hostId: "host", transport });
  const runtime = new ConnectorRuntime({ getSession: () => ({ status: "authenticated", epoch: 1 }), subscribe: () => () => {} });
  const removeHandler = installConnectorDynamicToolHandler(client, runtime, { hostId: "host" });
  async function tool(name: string, args: unknown, threadId = "allowed") {
    const id = `tool-${++sequence}`;
    const result = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("tool timeout")); }, 3000);
      pending.set(id, value => { clearTimeout(timer); resolve(value.result); });
    });
    peer.send(JSON.stringify({ jsonrpc: "2.0", id, method: "item/tool/call", params: { threadId, turnId: "turn", callId: id, namespace: "connectors", tool: name, arguments: args } }));
    return result;
  }
  try {
    await client.connect({ clientInfo: { name: "fixture", version: "1" } });
    runtime.register("owner", createAppServerMcpConnectorProvider({ id: "test.mcp", title: "MCP", server: "fixture", authenticationProviderId: "fixture.auth", resolveClient: async () => client }));
    const c = await runtime.connect("test.mcp", "host", "op");
    assert.equal(c.phase, "ready");
    runtime.select({ hostId: "host", threadId: "allowed" }, [c.connectionId]);
    const searched = await tool("search_tools", {});
    assert.equal(searched.success, true);
    const page = JSON.parse(searched.contentItems[0].text);
    assert.equal(page.items.length, 1, "connection does not authorize write tools");
    assert.equal(page.items[0].inputSchema, undefined, "browse pages do not expand schemas");
    const detail = await tool("get_tool", { toolRefs: [page.items[0].toolRef] });
    assert.equal(detail.success, true);
    const [entry] = JSON.parse(detail.contentItems[0].text).items;
    const called = await tool("call_tool", { handle: entry.handle, arguments: { text: "LOOPBACK_TOOL_RESULT" } });
    assert.equal(called.success, true); assert.match(called.contentItems[0].text, /LOOPBACK_TOOL_RESULT/);
    assert.equal(serviceCalls, 1);
    const foreign = await tool("call_tool", { handle: entry.handle, arguments: {} }, "foreign");
    assert.equal(foreign.success, false); assert.equal(serviceCalls, 1);
    schemaVersion++;
    assert.equal((await tool("call_tool", { handle: entry.handle, arguments: {} })).success, false);
    assert.equal(serviceCalls, 1, "old schema cannot silently call a changed implementation");
    schemaVersion--; remoteAuthorized = false;
    assert.equal((await tool("call_tool", { handle: entry.handle, arguments: {} })).success, false);
    remoteAuthorized = true;
    peer.send(JSON.stringify({ jsonrpc: "2.0", method: "mcpServer/startupStatus/updated", params: { threadId: null, name: "fixture", status: "starting", error: null, failureReason: null } }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(runtime.getSnapshot().connections[0].phase, "refresh-required");
    assert.equal((await tool("call_tool", { handle: entry.handle, arguments: {} })).success, false);
    assert.equal(serviceCalls, 1);
    assert.ok(requests.filter(r => r.method === "mcpServerStatus/list").some(r => r.params.threadId === "allowed"));
  } finally { removeHandler(); await runtime.dispose(); await client.close(); endpoint.closeAllConnections(); await new Promise<void>(resolve => endpoint.close(() => resolve())); }
});
