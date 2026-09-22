import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { MemoryTransport, type InMemoryAppServerPeer } from "@opencraft/appserver-transport-memory";

/** Protocol authority fixture only; no real account, token or browser is used. */
export async function connectorHost() {
  let peer!: InMemoryAppServerPeer;
  let authStatus = "notLoggedIn", writes = 0, logins = 0;
  const calls: Array<{ method: string; params: any }> = [];
  const client = new JsonRpcAppServerClient({ hostId: "host", transport: new MemoryTransport({ receive(frame, connection) {
    peer = connection; const message = JSON.parse(frame);
    if (!message.method || !Object.hasOwn(message, "id")) return;
    calls.push(message);
    let result: unknown;
    if (message.method === "initialize") result = { userAgent: "connector-fixture", codexHome: "/tmp/fixture", platformFamily: "unix", platformOs: "linux" };
    if (message.method === "mcpServerStatus/list") result = { data: [{ name: "fixture", authStatus, tools: {
      read: { name: "read", description: "Read fixture", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      write: { name: "write", description: "Write fixture", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
    } }], nextCursor: null };
    if (message.method === "mcpServer/oauth/login") { logins++; result = { authorizationUrl: "https://auth.example.test/authorize?state=fixture" }; }
    if (message.method === "config/mcpServer/reload") result = {};
    if (message.method === "mcpServer/tool/call") { if (message.params.tool === "write") writes++; result = { content: [{ type: "text", text: "fixture result" }] }; }
    connection.send(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } } : { jsonrpc: "2.0", id: message.id, result }));
  } }) });
  await client.connect({ clientInfo: { name: "fixture", version: "1" } });
  return { client, calls, writes: () => writes, logins: () => logins,
    authorize(value: boolean) { authStatus = value ? "oAuth" : "notLoggedIn"; },
    complete(success: boolean, name = "fixture") { if (name === "fixture" && success) authStatus = "oAuth"; peer.send(JSON.stringify({ jsonrpc: "2.0", method: "mcpServer/oauthLogin/completed", params: { name, threadId: null, success } })); },
    changed() { peer.send(JSON.stringify({ jsonrpc: "2.0", method: "mcpServer/startupStatus/updated", params: { name: "fixture", threadId: null, status: "starting", error: null, failureReason: null } })); },
  };
}

export async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Fixture deadline exceeded"); await new Promise(resolve => setTimeout(resolve, 1)); }
}
