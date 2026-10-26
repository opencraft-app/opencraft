// Real native engines with synthetic identities/models, isolated from live services.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";
import WebSocket from "ws";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiEngine } from "../../plugins/pi-engine/src/index.js";
import { AcpEngine, dshAcpCommand } from "../../plugins/acp-engine/src/index.js";
import { startEngineHost } from "../../apps/local-agent-host/src/engine-host.js";
import { RemoteEngineProvider } from "../../apps/local-agent-host/src/remote-engine-provider.js";
import { AgentDriverTransport } from "../../apps/opencraft-daemon/src/agent-driver-transport.js";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { AppHostServer } from "../../packages/app-host-server/src/index.js";
import { MessagePortAppHostClient } from "../../packages/app-host-client/src/index.js";
import { JsonRpcAppServerClient } from "../../packages/appserver-client/src/index.js";
import { WebSocketTransport, type AppServerWebSocket } from "../../packages/appserver-transport-websocket/src/index.js";
import { ActorStore } from "../../packages/access-control/src/actors.js";
import { Collaboration, CollaborationError } from "../../packages/access-control/src/collaboration.js";
import { ThreadOrchestrationBroker } from "../../packages/access-control/src/thread-orchestration-broker.js";
import { createThreadOrchestrationExecution } from "../../scripts/thread-orchestration-execution.mjs";
import { createRoutedConversationExecution } from "../../scripts/conversation-execution.mjs";
import { THREAD_ORCHESTRATION_TOOLS } from "../../packages/appserver-protocol/src/collaboration.js";
import { SessionCapabilities } from "../../packages/session-capabilities/src/index.js";
import { RemoteSessionCapabilities } from "../../packages/session-capabilities/src/remote.js";
import { capabilitySigningKey, SessionCapabilityMcp } from "../../packages/session-capabilities/src/mcp.js";

const [kind, path] = process.argv.slice(2), config = JSON.parse(await readFile(path!, "utf8"));
const root = config.root, shared = join(root, "shared"), machineId = "synthetic-mixed-drivers";
await mkdir(shared, { recursive: true, mode: 0o700 });
if (kind === "pi" || kind === "dsh-acp") {
  let engine: PiEngine | AcpEngine, faux: ReturnType<typeof fauxProvider> | undefined;
  if (kind === "pi") {
    faux = fauxProvider({ tokensPerSecond: 1000 }); faux.setResponses(Array.from({ length: 100 }, () => fauxAssistantMessage("Synthetic Pi done.")));
    const models = createModels(); models.setProvider(faux.provider);
    engine = new PiEngine({ directory: join(root, "pi"), dataDirectory: join(root, "pi-data"), cwd: root,
      models: Object.assign(models, { getAvailableSnapshot: () => faux!.models }) as unknown as ModelRuntime });
  } else engine = new AcpEngine({ id: "dsh-acp", ...dshAcpCommand(config.dshEntry, [config.dshPatch]),
    dataDirectory: join(root, "dsh-routing"), cwd: root, permission: "allow-once",
    env: { ...process.env, DSH_HOME: join(root, "dsh-native"), DEEPSEEK_API_KEY: "synthetic-only", DSH_PERMISSION_MODE: "danger-full-access" } });
  const remote = new RemoteSessionCapabilities(shared, `server:${machineId}:${kind}`);
  engine.setOrchestration({ tools: THREAD_ORCHESTRATION_TOOLS, call: (threadId, turnId, callId, name, args, signal, inputId) =>
    remote.orchestration(threadId, { turnId, callId, name, arguments: args, inputId,
      incarnation: engine instanceof PiEngine ? engine.orchestrationIncarnation : engine.incarnation }, signal) });
  const host = await startEngineHost({ providers: [engine], defaultEngine: kind }), token = randomUUID();
  if (!host.ready) throw new Error("Independent native Host unavailable");
  const control = createServer((request, response) => { void (async () => {
    if (request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403); response.end(); return; }
    let body = ""; for await (const part of request) body += part;
    const { command, params = {} } = JSON.parse(body); let result: unknown;
    if (command === "receipt") result = await engine.inputs.receipt(params.threadId, params.inputId);
    else if (command === "submit") result = await engine.inputs.submit(params.threadId, params.inputId, params.text, () => true);
    else if (command === "identity") result = { hostPid: process.pid,
      ...(engine instanceof PiEngine ? { nativePid: process.pid, incarnation: engine.orchestrationIncarnation } : { nativePid: engine.processId, incarnation: engine.incarnation }) };
    else if (command === "hold" && faux) { faux.setResponses([fauxAssistantMessage("Pi held native execution. ".repeat(2000)), ...Array.from({ length: 20 }, () => fauxAssistantMessage("Synthetic Pi done."))]); result = true; }
    else throw new Error("Unknown isolated native control operation");
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ result }));
  })().catch(error => { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }); });
  await new Promise<void>(resolve => control.listen(0, "127.0.0.1", resolve));
  await writeFile(join(root, `${kind}-host.json`), JSON.stringify({ websocketUrl: host.websocketUrl,
    controlUrl: `http://127.0.0.1:${(control.address() as any).port}`, token }), { mode: 0o600 });
  process.once("SIGTERM", () => void (async () => { control.closeAllConnections(); await new Promise<void>(resolve => control.close(() => resolve())); await host.close(); process.exit(0); })());
  process.send?.({ ready: true });
} else if (kind === "gateway") {
  const attachments = new Map<string, any>();
  for (const id of ["pi", "dsh-acp"]) attachments.set(id, JSON.parse(await readFile(join(root, `${id}-host.json`), "utf8")));
  const control = async (id: string, command: string, params: unknown) => {
    const descriptor = attachments.get(id), response = await fetch(descriptor.controlUrl, { method: "POST", headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" }, body: JSON.stringify({ command, params }) });
    const body = await response.json() as any; if (!response.ok) throw new Error(body.error); return body.result;
  };
  const providers = [...attachments].map(([id, descriptor]) => new RemoteEngineProvider(id, id, id === "pi" ? "pi_" : "dsh_acp_", `${id}:`, {
    async resolveWebsocketUrl() { return descriptor.websocketUrl; }, async close() {},
  }));
  const aggregate = await startEngineHost({ providers, defaultEngine: "pi" }); if (!aggregate.ready) throw new Error("Remote engine facade unavailable");
  const actors = new ActorStore(join(shared, "actors.sqlite")), human = actors.resolveHuman({ provider: "local", subject: "synthetic-mixed-user", displayName: "Synthetic mixed user", expiresAt: Date.now() + 3_600_000 })!;
  let service!: Collaboration, broker!: ThreadOrchestrationBroker;
  const appHost = new AppHostServer({ logicalClientRouting: true, physicalHostLifetime: "server", createTransport(hostId) {
    if (hostId === "opencraft-server") return new AgentDriverTransport(new WebSocketTransport({ url: aggregate.websocketUrl,
      createSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as AppServerWebSocket }), service, threadId => native.serverForThread(threadId));
    if (hostId !== "local-codex") throw new Error("Unknown mixed Host");
    const adapter = new CodexEngineAdapter({ executable: config.executable, runtimeDirectory: root, dataDirectory: join(root, "gateway-codex"),
      nativeCodexHomeDirectory: join(root, "unused-native"), coreEndpoint: config.coreEndpoint, coreAuthToken: config.authToken, coreHostOverlays: true,
      collaboration: {
        queuedContext: (thread, id, input) => service.queuedReferenceContext(thread, id, input), continuing: (thread, prior, input) => service.executionContinuing(thread, prior, input),
        continued: (thread, prior, turn) => service.executionContinued(thread, prior, turn), inputDelegation: (thread, input, expected) => service.inputDelegation(thread, input, expected),
        prepare: (context, input) => service.referenceContext(context, input), command: (context, body) => service.command(context, body),
        authorize: (context, thread, input, parts) => service.authorizeExecution(context, thread, input, parts), started: (thread, input, turn) => service.executionStarted(thread, input, turn),
        tool: (thread, turn, name, args) => service.tool(thread, turn, name, args), orchestration: { available: () => broker.available,
          observed: snapshot => broker.observe(snapshot), tool: (thread, turn, key, name, args, delegation, incarnation) => broker.invoke(thread, turn, key, name, args, delegation, incarnation) },
      }, collaborationInput: { available: () => service.available, mode: id => service.inputMode(id), authorize: (thread, id, mode, turn) => service.authorizeInput(thread, id, mode, turn) } });
    adapter.subscribeMessage(frame => { const message = JSON.parse(frame); if (message.error) process.stderr.write(JSON.stringify({ codexError: message.error }) + "\n"); });
    return adapter;
  } });
  const native = createRoutedConversationExecution(() => appHost, { machineId, engines: ["pi", "dsh-acp"], getInputs: async (id: string) => ({
    receipt: (threadId: string, inputId: string) => control(id, "receipt", { threadId, inputId }),
    submit: (threadId: string, inputId: string, text: string, admit: () => boolean) => admit() ? control(id, "submit", { threadId, inputId, text }) : Promise.resolve(null),
  }) });
  service = new Collaboration(join(shared, "collaboration.sqlite"), actors, native);
  const execution = createThreadOrchestrationExecution(() => appHost, { enabled: ["codex", "pi", "dsh-acp"], prepared: (id: string) => service.spawnPreparation(id) });
  broker = new ThreadOrchestrationBroker(service, execution); service.start();
  const mcp = new SessionCapabilityMcp(new SessionCapabilities(), capabilitySigningKey(join(shared, "session-capabilities.key")), undefined, { descriptorPath: join(shared, "session-capabilities.json"),
    async orchestration(session, request) {
      // Same envelope validation/binding as headless-application.mjs. The real
      // production MCP server authenticates this synthetic native session.
      const body = request as any, fields = ["turnId", "callId", "name", "arguments", "inputId", "incarnation", "toolCallKey"];
      if (Object.keys(body).some(key => !fields.includes(key))
        || !["turnId", "callId", "name", "incarnation"].every(key => typeof body[key] === "string" && body[key].length > 0 && body[key].length <= 512)
        || !body.arguments || typeof body.arguments !== "object" || Array.isArray(body.arguments)
        || body.inputId !== undefined && (typeof body.inputId !== "string" || body.inputId.length > 512)
        || session.serverId !== native.serverForThread(session.threadId)) throw new CollaborationError(400, "invalid_orchestration_source");
      await appendFile(join(root, "native-callbacks.ndjson"), JSON.stringify({ event: "received", serverId: session.serverId, threadId: session.threadId,
        turnId: body.turnId, callId: body.callId, inputId: body.inputId, incarnation: body.incarnation, name: body.name }) + "\n");
      if (body.inputId) service.executionStarted(session.threadId, body.inputId, body.turnId);
      const result = await broker.invoke(session.threadId, body.turnId, JSON.stringify([session.serverId, body.incarnation, session.threadId, body.turnId, body.callId]), body.name, body.arguments, undefined, body.incarnation);
      await appendFile(join(root, "native-callbacks.ndjson"), JSON.stringify({ event: "committed", threadId: session.threadId, turnId: body.turnId, name: body.name, result }) + "\n");
      return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
    } }); await mcp.listen();
  const channel = new MessageChannel();
  appHost.accept({ postMessage: message => channel.port2.postMessage(message), subscribe(listener) { channel.port2.on("message", listener); return () => { channel.port2.off("message", listener); }; }, start() { channel.port2.start(); }, close() { channel.port2.close(); } }, "mixed-renderer", { sender: null, actorContext: human });
  const client = new MessagePortAppHostClient(channel.port1 as any, "mixed-renderer"), clients = new Map<string, JsonRpcAppServerClient>();
  for (const hostId of ["local-codex", "opencraft-server"]) {
    const rpc = new JsonRpcAppServerClient({ hostId, transport: client.createTransport(hostId) });
    await rpc.connect({ clientInfo: { name: "synthetic-mixed-driver-drill", version: "1" }, capabilities: { experimentalApi: true } }); clients.set(hostId, rpc);
  }
  process.on("message", (message: any) => { void (async () => {
    const { id, command, params = {} } = message; let result: unknown;
    if (command === "rpc") result = await clients.get(params.driver === "codex" ? "local-codex" : "opencraft-server")!.request(params.method, params.arguments ?? {});
    else if (command === "invoke") {
      service.executionStarted(params.threadId, params.inputId, params.turnId);
      result = await broker.invoke(params.threadId, params.turnId, params.key, params.name, params.arguments);
    } else if (command === "status") result = await execution.snapshot(params.threadId);
    else if (command === "state") result = { threads: service.orchestration.threads(),
      operations: service.database.prepare("SELECT operation_id,tool_call_key,kind,client_message_id,target_thread_id,result_json FROM opencraft_orchestration_operations").all(),
      requests: service.database.prepare("SELECT id,state,thread_id,turn_id FROM actor_execution_requests").all(),
      origins: service.database.prepare("SELECT thread_id,input_id,origin_json FROM opencraft_input_origins").all(),
      authorities: service.database.prepare("SELECT t.thread_id,t.turn_id,a.input_id FROM conversation_turn_authorities t JOIN conversation_authorities a ON a.id=t.authority_id").all() };
    else throw new Error("Unknown mixed Gateway command");
    process.send?.({ id, result });
  })().catch(error => process.send?.({ id: message.id, error: String(error), stack: (error as Error).stack })); });
  process.once("SIGTERM", () => void (async () => { await mcp.close(); for (const rpc of clients.values()) await rpc.close(); client.close(); await appHost.close(); await aggregate.close(); await broker.close(); await service.close(); actors.close(); process.exit(0); })());
  process.send?.({ ready: true });
} else throw new Error("Unknown isolated mixed process role");
