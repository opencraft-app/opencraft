import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { WebSocketTransport, type AppServerWebSocket } from "@opencraft/appserver-transport-websocket";
import { ExtensionSupervisor } from "@opencraft/extension-runtime";
import { ConnectorApprovalQueue, ConnectorRuntime, installConnectorDynamicToolHandler, OPENCRAFT_CONNECTOR_DYNAMIC_TOOLS } from "@opencraft/workbench-runtime";
import { connectorProviderAdapter } from "../apps/workbench-web/src/runtime/connector-contributions.js";
import { startLocalAgentHost } from "../apps/local-agent-host/src/main.js";

const root = await mkdtemp(join(tmpdir(), "oc-platform-connectors-"));
const previousAgentsHome = process.env.DSH_AGENTS_HOME;
process.env.DSH_AGENTS_HOME = join(root, "agents");
let remoteCalls = 0, stage = 0, handle = "";
let toolRef = "";
const modelRequests: any[] = [], notifications: any[] = [];
const remote = createServer(async (req, res) => {
  let text = ""; for await (const chunk of req) text += chunk;
  remoteCalls++;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ result: "CONNECTOR_REAL_HTTP_RESULT", input: JSON.parse(text) }));
});
function findHandle(value: unknown): string | undefined {
  if (typeof value === "string") return /"handle"\s*:\s*"([^"]+)"/.exec(value)?.[1];
  if (value && typeof value === "object") for (const child of Object.values(value)) { const found = findHandle(child); if (found) return found; }
  return undefined;
}
function findToolRef(value: unknown): string | undefined {
  if (typeof value === "string") return /"toolRef"\s*:\s*"([^"]+)"/.exec(value)?.[1];
  if (value && typeof value === "object") for (const child of Object.values(value)) { const found = findToolRef(child); if (found) return found; }
  return undefined;
}
const model = createServer(async (req, res) => {
  let text = ""; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text), base = { id: "fixture", created: 1, model: "fixture" };
  const isAgent = body.stream && body.tools?.some((t: any) => t.function?.name === "connectors__search_tools");
  let message: unknown = { role: "assistant", content: "Connector fixture complete" }, finish = "stop";
  if (isAgent) {
    modelRequests.push(body);
    let name: string | undefined, args: unknown = {};
    if (stage === 0) name = "connectors__search_tools";
    if (stage === 1) {
      toolRef = body.messages.filter((m: any) => m.role === "tool").map((m: any) => findToolRef(m.content)).find(Boolean) ?? "";
      name = "connectors__get_tool"; args = { toolRefs: [toolRef] };
    }
    if (stage === 2) {
      handle = body.messages.filter((m: any) => m.role === "tool").map((m: any) => findHandle(m.content)).find(Boolean) ?? "";
      name = "connectors__call_tool"; args = { handle, arguments: { text: "actual-call" } };
    }
    if (stage === 4) { name = "connectors__call_tool"; args = { handle, arguments: { text: "must-not-run" } }; }
    if (name) { message = { role: "assistant", tool_calls: [{ index: 0, id: `fixture-${stage}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }; finish = "tool_calls"; }
    stage++;
  }
  if (!body.stream) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ...base, choices: [{ index: 0, message, finish_reason: "stop" }] })); return; }
  const chunk = (delta: unknown, reason: string | null) => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  res.setHeader("content-type", "text/event-stream"); res.end(chunk(message, null) + chunk({}, finish) + "data: [DONE]\n\n");
});
let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined, client: JsonRpcAppServerClient | undefined;
const approvals = new ConnectorApprovalQueue();
const connectors = new ConnectorRuntime({ getSession: () => ({ status: "authenticated", epoch: 1 }), subscribe: () => () => {} }, 30000, { approvals });
let approvalCount = 0, approvalTimer: ReturnType<typeof setTimeout> | undefined;
const removeApproval = approvals.subscribe(() => {
  const pending = approvals.getSnapshot()[0]; if (!pending) return;
  approvalCount++;
  // Regression: both bridge and native tool previously timed out at 10/12s.
  approvalTimer = setTimeout(() => { assert.equal(remoteCalls, 0); approvals.respond(pending.id, true); }, 13000);
});
const extensions = new ExtensionSupervisor({ platform: "web", internalContributions: { connectorProvider: connectorProviderAdapter(connectors) } });
let removeTools: (() => void) | undefined;
try {
  await Promise.all([remote, model].map(server => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))));
  const remoteUrl = `http://127.0.0.1:${(remote.address() as { port: number }).port}`;
  await extensions.activate({ manifest: { manifestVersion: 1, id: "test.http", name: "HTTP fixture", version: "1.0.0", apiVersion: 1, trust: "trusted", platforms: ["web"], activationEvents: ["*"] },
    activate(api) { api.internal.register("connectorProvider", { id: "test.http", title: "HTTP fixture", authenticationProviderId: "fixture.auth", contributions: [{ id: "tools", kind: "tools", prepare: async () => ({
      tools: [{ name: "echo", description: "Call the isolated HTTP service", readOnly: false, inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
      checkAccess: async () => true,
      call: async (_name: string, input: unknown, context: { signal: AbortSignal }) => (await fetch(remoteUrl, { method: "POST", body: JSON.stringify(input), signal: context.signal })).json(),
      dispose() {},
    }) }] }); } });
  host = await startLocalAgentHost({ dshExecutable: resolve("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"), dataDirectory: join(root, "runtime"), modelStorageDirectory: join(root, "models"), skillsDirectory: join(root, "skills") });
  client = new JsonRpcAppServerClient({ hostId: "local", transport: new WebSocketTransport({ url: host.websocketUrl, createSocket: url => new WebSocket(url) as unknown as AppServerWebSocket }) });
  removeTools = installConnectorDynamicToolHandler(client, connectors, { hostId: "local" });
  client.subscribeNotification(n => notifications.push(n));
  await client.connect({ clientInfo: { name: "connector-smoke", version: "1" } });
  const request = (method: string, params: unknown = {}) => client!.requestRaw<any>(method, params);
  const config = await request("runtime/providers/list");
  const saved = await request("runtime/providers/apply", { target: { kind: "create", id: "fixture" }, expectedRevision: config.creation.revision,
    displayName: "Fixture", baseURL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, api: "openai-completions", models: [{ id: "fixture", input: ["text"], contextWindow: 16384, maxTokens: 1024 }], credential: { kind: "replace", value: "synthetic-only" } });
  await request("runtime/providers/setEnabled", { provider: "fixture", enabled: true, expectedRevision: saved.revision });
  const modelId = (await request("model/list")).data.find((m: any) => m.model.includes("fixture")).model;
  const threadId = (await request("thread/start", { cwd: root, model: modelId, dynamicTools: OPENCRAFT_CONNECTOR_DYNAMIC_TOOLS })).thread.id;
  const connection = await connectors.connect("test.http", "local", "explicit-connect");
  connectors.select({ hostId: "local", threadId }, [connection.connectionId]);
  async function turn() {
    const start = notifications.length;
    await request("turn/start", { threadId, input: [{ type: "text", text: "Use the selected Connector fixture" }] });
    const deadline = Date.now() + 30000;
    while (!notifications.slice(start).some(n => n.method === "turn/completed")) {
      if (Date.now() > deadline) throw new Error("Native turn timed out");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(notifications.slice(start).find(n => n.method === "turn/completed").params.turn.status, "completed");
  }
  await turn();
  assert.ok(handle, "the model obtained the handle from its actual discovery tool result");
  assert.equal(remoteCalls, 1);
  assert.equal(approvalCount, 1, "real DSH waited for the delayed one-shot approval");
  assert.ok(modelRequests.some(r => JSON.stringify(r.messages).includes("CONNECTOR_REAL_HTTP_RESULT")));
  await connectors.disconnect(connection.connectionId);
  await turn();
  assert.equal(remoteCalls, 1, "revoked handle must not reach the HTTP service");
  assert.ok(modelRequests.some(r => JSON.stringify(r.messages).includes("stale-handle")));
  console.log("PASS: extension → discovery → real DSH waits 13 seconds for approval → real HTTP → model result; disconnect rejects old handle in the same Thread");
} finally {
  clearTimeout(approvalTimer); removeApproval(); approvals.dispose();
  removeTools?.(); await extensions.dispose(); await connectors.dispose(); await client?.close(); await host?.close();
  for (const server of [remote, model]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME; else process.env.DSH_AGENTS_HOME = previousAgentsHome;
  await rm(root, { recursive: true, force: true });
}
