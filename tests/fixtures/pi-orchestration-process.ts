// Isolated continuity drill: real Pi durable execution, synthetic model/user.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiEngine } from "../../plugins/pi-engine/src/index.js";
import { startEngineHost } from "../../apps/local-agent-host/src/engine-host.js";
import { RemoteSessionCapabilities } from "../../packages/session-capabilities/src/remote.js";
import { SessionCapabilities } from "../../packages/session-capabilities/src/index.js";
import { SessionCapabilityMcp, capabilitySigningKey } from "../../packages/session-capabilities/src/mcp.js";
import { THREAD_ORCHESTRATION_TOOLS } from "../../packages/appserver-protocol/src/collaboration.js";
import { ActorStore } from "../../packages/access-control/src/actors.js";
import { Collaboration, type ConversationExecutionPort } from "../../packages/access-control/src/collaboration.js";
import { ThreadOrchestrationBroker, type OrchestrationExecutionPort } from "../../packages/access-control/src/thread-orchestration-broker.js";
import { AppHostServer } from "../../packages/app-host-server/src/index.js";
import { AgentDriverTransport } from "../../apps/opencraft-daemon/src/agent-driver-transport.js";
import { WebSocketTransport, type AppServerWebSocket } from "../../packages/appserver-transport-websocket/src/index.js";
import WebSocket from "ws";
import { MessageChannel } from "node:worker_threads";
import { MessagePortAppHostClient } from "../../packages/app-host-client/src/index.js";
import { JsonRpcAppServerClient } from "../../packages/appserver-client/src/index.js";
import { createThreadOrchestrationExecution } from "../../scripts/thread-orchestration-execution.mjs";

const [kind, configPath] = process.argv.slice(2), config = JSON.parse(await readFile(configPath!, "utf8"));
const root = config.root as string, data = join(root, "data"), serverId = "server:synthetic-pi-smoke:pi";
await mkdir(data, { recursive: true, mode: 0o700 });
const noBrowser = { notify() {}, async request() { throw new Error("No browser tools in this drill"); } };
if (kind === "host") {
  const faux = fauxProvider({ tokensPerSecond: 10000 }), model = createModels(); model.setProvider(faux.provider);
  const capabilities = new RemoteSessionCapabilities(data, serverId);
  const engine = new PiEngine({ dataDirectory: data, directory: join(data, "pi"), cwd: root,
    models: Object.assign(model, { getAvailableSnapshot: () => faux.models }) as unknown as ModelRuntime });
  engine.setOrchestration({ tools: THREAD_ORCHESTRATION_TOOLS, call: (threadId, turnId, callId, name, args, signal, inputId) =>
    capabilities.orchestration(threadId, { turnId, callId, name, arguments: args, inputId, incarnation: engine.orchestrationIncarnation }, signal) });
  const host = await startEngineHost({ providers: [engine], defaultEngine: "pi" }), token = randomUUID();
  const control = createServer((request, response) => { void (async () => {
    if (request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403); response.end(); return; }
    let body = ""; for await (const part of request) body += part;
    const { command, params = {} } = JSON.parse(body); let result: unknown;
    if (command === "rpc") result = await engine.request(params.method, params.arguments ?? {}, noBrowser);
    else if (command === "receipt") result = await engine.inputs.receipt(params.threadId, params.inputId);
    else if (command === "submit") result = await engine.inputs.submit(params.threadId, params.inputId, params.text, () => true);
    else if (command === "model") {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall(`opencraft_orchestration_${params.name}`, params.arguments, { id: params.callId })], { stopReason: "toolUse" }),
        ...Array.from({ length: 16 }, () => fauxAssistantMessage("synthetic native execution completed")),
      ]); result = true;
    } else if (command === "identity") result = { pid: process.pid, incarnation: engine.orchestrationIncarnation };
    else throw new Error("Unknown isolated Host command");
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ result }));
  })().catch(error => { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }); });
  await new Promise<void>(resolve => control.listen(0, "127.0.0.1", resolve));
  await writeFile(join(root, "pi-host.json"), JSON.stringify({ controlUrl: `http://127.0.0.1:${(control.address() as any).port}`, token,
    websocketUrl: host.websocketUrl }), { mode: 0o600 });
  process.send?.({ ready: true, pid: process.pid });
  process.once("SIGTERM", () => void (async () => { control.closeAllConnections(); await new Promise<void>(resolve => control.close(() => resolve())); await host.close(); process.exit(0); })());
} else if (kind === "gateway") {
  const descriptor = JSON.parse(await readFile(join(root, "pi-host.json"), "utf8"));
  const call = async (command: string, params: unknown) => {
    const response = await fetch(descriptor.controlUrl, { method: "POST", headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" }, body: JSON.stringify({ command, params }) });
    const result = await response.json() as any; if (!response.ok) throw new Error(result.error); return result.result;
  };
  const directRpc = (method: string, args: unknown = {}) => call("rpc", { method, arguments: args });
  let appHost: AppHostServer | undefined, appHostClient: MessagePortAppHostClient | undefined, renderer: JsonRpcAppServerClient | undefined, service!: Collaboration;
  const actors = new ActorStore(join(data, "actors.sqlite")), human = actors.resolveHuman({ provider: "local", subject: "synthetic-pi-smoke",
    displayName: "Synthetic Pi user", expiresAt: Date.now() + 3_600_000 })!;
  const receipt = async (threadId: string, requestId: string, text?: string) => {
    const inputId = `actor-input:${requestId}`, value = text === undefined ? await call("receipt", { threadId, inputId }) : await call("submit", { threadId, inputId, text });
    return value ? { id: inputId, state: value.state, targetTurnId: value.turnId } : null;
  };
  const native: ConversationExecutionPort = { serverId, hostId: "synthetic-pi-host", async validate(binding) {
    if ((await directRpc("thread/read", { threadId: binding.threadId, includeTurns: false })).thread.id !== binding.threadId) throw new Error("Missing native Thread");
  }, receipt: (binding, id) => receipt(binding.threadId, id), add: (binding, id, text) => receipt(binding.threadId, id, text),
    async steer() { throw new Error("This drill only queues"); }, async cancel() { return false; } };
  service = new Collaboration(join(data, "collaboration.sqlite"), actors, native);
  if (config.productionRoute) appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: "server",
    createTransport: hostId => {
      if (hostId !== "opencraft-server") throw new Error("Unknown isolated production Host");
      const inner = new WebSocketTransport({ url: descriptor.websocketUrl,
        createSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as AppServerWebSocket });
      inner.subscribeMessage(frame => { const message = JSON.parse(frame); if (message.error) process.stderr.write(JSON.stringify({ nativeError: message.error }) + "\n"); });
      return new AgentDriverTransport(inner, service, () => serverId);
    } });
  const rpc = (method: string, args: any = {}) => renderer
    ? renderer.request(method as any, args)
    : directRpc(method, args);
  const execution: OrchestrationExecutionPort = config.productionRoute ? createThreadOrchestrationExecution(() => appHost, {
    enabled: ["pi"], prepared: (id: string) => service.spawnPreparation(id),
  }) : {
    prepare: async (operationId, threadId, args, admit) => { if (!admit()) throw new Error("Delegation revoked"); return rpc("opencraft/orchestration/prepare", { operationId, threadId, arguments: args }); },
    create: async (operationId, _threadId, settings, admit) => { if (!admit()) throw new Error("Delegation revoked"); return rpc("opencraft/orchestration/create", { operationId, settings }); },
    acknowledge: async operationId => (await rpc("opencraft/orchestration/ack", { operationId })).acknowledged,
    snapshot: threadId => rpc("opencraft/orchestration/status", { operationId: `status:${randomUUID()}`, threadId }),
    inspect: (threadId, limit) => rpc("opencraft/orchestration/inspect", { operationId: `inspect:${randomUUID()}`, threadId, limit }),
  };
  const broker = new ThreadOrchestrationBroker(service, execution);
  const key = capabilitySigningKey(join(data, "session-capabilities.key"));
  const mcp = new SessionCapabilityMcp(new SessionCapabilities(), key, undefined, { descriptorPath: join(data, "session-capabilities.json"),
    async orchestration(session, request) {
      if (session.serverId !== serverId) throw new Error("Wrong synthetic scope");
      const { turnId, inputId, incarnation, callId, name, arguments: args } = request as any;
      if (![turnId, incarnation, callId, name].every(value => typeof value === "string" && value.length > 0)
        || !args || typeof args !== "object" || Array.isArray(args)) throw Object.assign(new Error("Invalid callback envelope"), { status: 400 });
      if (typeof inputId === "string") service.executionStarted(session.threadId, inputId, turnId);
      const toolCallKey = `${incarnation}:${session.threadId}:${turnId}:${callId}`;
      const result = await broker.invoke(session.threadId, turnId, toolCallKey, name, args, undefined, incarnation);
      if (config.blockAfterReceipt) {
        await writeFile(join(root, "crash-marker.json"), JSON.stringify({ threadId: session.threadId, turnId, toolCallKey, name, result }));
        await new Promise(() => {});
      }
      return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
    } });
  await mcp.listen(); service.start(); broker.start();
  if (appHost) {
    const channel = new MessageChannel();
    appHost.accept({ postMessage: message => channel.port2.postMessage(message), subscribe(listener) {
      channel.port2.on("message", listener); return () => { channel.port2.off("message", listener); };
    }, start() { channel.port2.start(); }, close() { channel.port2.close(); } }, "synthetic-renderer", { sender: null, actorContext: human });
    appHostClient = new MessagePortAppHostClient(channel.port1 as any, "synthetic-renderer");
    renderer = new JsonRpcAppServerClient({ hostId: "opencraft-server", transport: appHostClient.createTransport("opencraft-server") });
    await renderer.connect({ clientInfo: { name: "synthetic-pi-production-route", version: "1" } });
  }
  process.on("message", (raw: any) => { void (async () => {
    const { id, command, params = {} } = raw; let result: unknown;
    if (command === "authorize") { service.authorizeExecution(human, params.threadId, params.inputId, [{ type: "text", text: "Synthetic authorized Pi tool input" }]); result = true; }
    else if (command === "rpc") result = await rpc(params.method, params.arguments);
    else if (command === "state") result = { operations: service.database.prepare("SELECT operation_id,tool_call_key,kind,target_thread_id,client_message_id,result_json FROM opencraft_orchestration_operations").all(),
      requests: service.database.prepare("SELECT id,state,thread_id FROM actor_execution_requests").all(), threads: service.orchestration.threads(),
      origins: service.database.prepare("SELECT thread_id,input_id,origin_json FROM opencraft_input_origins").all() };
    else throw new Error("Unknown isolated Gateway command");
    process.send?.({ id, result });
  })().catch(error => process.send?.({ id: raw.id, error: String(error) })); });
  process.once("SIGTERM", () => void (async () => { await mcp.close(); await renderer?.close(); appHostClient?.close(); await appHost?.close(); await broker.close(); await service.close(); actors.close(); process.exit(0); })());
  process.send?.({ ready: true, pid: process.pid });
} else throw new Error("Unknown isolated process kind");
