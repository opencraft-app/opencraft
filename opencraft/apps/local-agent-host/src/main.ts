import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile, mkdtemp, rm, access } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { WebSocket, WebSocketServer } from "ws";

import { DshAppServerAdapter, decodeModel } from "./dsh-appserver-adapter.js";
import { DshClient, DshClientError } from "./dsh-client.js";
import { DshSupervisor } from "./dsh-supervisor.js";
import { DshRestartBudget } from "./dsh-restart-budget.js";
import { DshExecutionAuthority } from "./dsh-execution-authority.js";
import { DshCapabilityBroker, normalizeCapabilities } from "./dsh-capability-broker.js";
import { ManagedConnectorService } from "@opencraft/connector-host";
import { HostDocumentService, HostDocumentFault } from "./storage/host-document-service.js";
import { HOST_STORAGE } from "@opencraft/appserver-protocol/host-storage";
import {
  DshCapabilityLink,
  verifyDshCapabilityRegistration,
} from "./dsh-capability-link.js";
import { requestLoopback } from "./loopback-http.js";
import { DshSessionRouting } from "./dsh-session-routing.js";
import { DshRoutedClient } from "./dsh-routed-client.js";
import { HostProcessService } from "./process-service.js";
import { ProjectRepository } from "./project-repository.js";
import { ThreadCatalog } from "./thread-catalog.js";
import { ThreadLifecycle } from "./thread-lifecycle.js";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ProfileSkillsMethod } from "@opencraft/appserver-protocol";
import { DshProfileSkillsHandler } from "./dsh-profile-skills.js";
import { SkillCatalogRefresh } from "./skills/catalog-refresh.js";
import { OPENCRAFT_ATTACHMENT_STAGING_EXTENSION } from "@opencraft/appserver-protocol";
import { LocalAttachmentStagingService } from "./attachments/local-attachment-staging.js";

type JsonRpcMessage = Record<string, unknown>;
const PROFILE_SKILLS_METHODS = new Set<ProfileSkillsMethod>([
  "skills/installed/list",
  "skills/installed/content/read",
  "skills/enabled/set",
  "skills/catalog/sources/list",
  "skills/catalog/official/list",
  "skills/catalog/search",
  "skills/catalog/preview",
  "skills/catalog/scan",
  "skills/install",
  "skills/uninstall",
  "skills/update",
  "skills/action/read",
]);
const replyClient = new AsyncLocalStorage<string>();
interface LogicalClient {
  readonly key: string;
  readonly clientId: string;
  readonly owner: import("./dsh-execution-authority.js").DshExecutionOwner;
  readonly offered: Set<string>;
  readonly openedThreads: Set<string>;
  unsubscribeInteractions?: () => void;
}

function rpcError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof HostDocumentFault) return { code: error.code, message: error.message };
  if (error instanceof DshClientError) return { code: -32001, message: error.message, data: { code: error.code, retryable: error.retryable } };
  if (typeof error === "object" && error !== null) {
    const candidate = error as { rpcCode?: unknown; domainData?: unknown; message?: unknown };
    if (typeof candidate.rpcCode === "number") {
      return {
        code: candidate.rpcCode,
        message: typeof candidate.message === "string" ? candidate.message : "AppServer request failed",
        ...(candidate.domainData === undefined ? {} : { data: candidate.domainData }),
      };
    }
  }
  return { code: -32603, message: error instanceof Error ? error.message : String(error) };
}

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const packet = value as Record<string, unknown>, client = replyClient.getStore();
  socket.send(JSON.stringify(client && packet && "id" in packet && !(LOGICAL_CLIENT_FIELD in packet)
    ? { ...packet, [LOGICAL_CLIENT_FIELD]: client } : value));
}
function sendClient(socket: WebSocket, clientId: string, packet: Record<string, unknown>): void {
  send(socket, { ...packet, [LOGICAL_CLIENT_FIELD]: clientId || undefined });
}

async function fileRequest(method: string, params: unknown): Promise<unknown> {
  const value = typeof params === "object" && params !== null ? params as Record<string, unknown> : {};
  const path = resolve(String(value.path ?? homedir()));
  if (method === "fs/readDirectory") {
    const entries = await readdir(path, { withFileTypes: true });
    return { entries: entries.map((entry) => ({ name: entry.name, path: resolve(path, entry.name), type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "unknown" })) };
  }
  if (method === "fs/getMetadata") {
    const metadata = await stat(path);
    return { path, type: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "unknown", size: metadata.size, modifiedAt: Math.floor(metadata.mtimeMs / 1_000) };
  }
  if (method === "fs/readFile") return { dataBase64: (await readFile(path)).toString("base64") };
  if (method === "fs/writeFile") {
    await writeFile(path, Buffer.from(String(value.dataBase64 ?? ""), "base64"));
    return {};
  }
  throw new Error(`Unsupported filesystem method ${method}`);
}

export async function startLocalAgentHost(options: {
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  readonly dshUrl?: string;
  readonly dshExecutable?: string;
  readonly dshRepository?: string;
  /** Stable operational cwd for packaged Daemon/DSH processes; never a Thread workspace. */
  readonly runtimeDirectory?: string;
  /** Explicit development/package path; the Agent Host never infers Electron's cwd. */
  readonly dshCapabilityPlugin?: string;
  readonly dataDirectory?: string;
  readonly modelStorageDirectory?: string;
  readonly projectStorageDirectory?: string;
  /** Test/embedding override; desktop defaults to ~/.opencraft/skills. */
  readonly skillsDirectory?: string;
} = {}) {
  let closing = false;
  let onEngineExit: ((error: Error) => void) | undefined;
  let engineStatus: "ready" | "restarting" | "failed" = "ready";
  const bridgeToken = randomBytes(32).toString("hex");
  const persistentSkillsRoot = resolve(options.skillsDirectory ?? join(homedir(), ".opencraft", "skills"));
  const productDataRoot = resolve(options.dataDirectory ?? join(homedir(), ".opencraft"));
  const attachmentStaging = new LocalAttachmentStagingService(
    join(productDataRoot, "attachments"),
  );
  let bridgeUrl: string | undefined;
  let capabilityLink: DshCapabilityLink | undefined;
  let managedConnectors: ManagedConnectorService | undefined;
  const connectorListeners = new Set<(id: string) => void>();
  const connectors = () => {
    if (!managedConnectors) {
      managedConnectors = new ManagedConnectorService(join(options.dataDirectory ?? join(homedir(), ".opencraft"), "opencraft-managed-connectors.sqlite"));
      managedConnectors.subscribe(id => { for (const listener of connectorListeners) listener(id); });
    }
    return managedConnectors;
  };
  let bridgeDirectory: string | undefined;
  const patches: string[] = [];
  if (!options.dshUrl && !process.env.OPENCRAFT_DSH_URL?.trim()) {
    const executable = resolve(options.dshExecutable ?? process.env.OPENCRAFT_DSH_EXECUTABLE ?? "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");
    const bundled = resolve(dirname(executable), "../../../../opencraft-capability-plugin.mjs");
    let plugin = resolve(options.dshCapabilityPlugin ?? bundled);
    try { await access(plugin); } catch {
      if (options.dshCapabilityPlugin !== undefined) throw new Error(`DSH capability plugin is unavailable at ${plugin}`);
      plugin = resolve("apps/local-agent-host/src/dsh-capability-plugin.mjs");
      await access(plugin);
    }
    bridgeDirectory = await mkdtemp(join(tmpdir(), "opencraft-engine-plugin-"));
    const patch = join(bridgeDirectory, "patch.json");
    const engineModule = (name: string) => pathToFileURL(resolve(dirname(executable), `../../${name}/lib/index.js`)).href;
    await writeFile(patch, JSON.stringify([
      { id: "session-persistence-jsonl", name: resolve(dirname(plugin), "dsh-thread-persistence-plugin.mjs"), config: { moduleUrl: engineModule("dsh-session-persistence-jsonl") } },
      { id: "session-projection-cache", name: resolve(dirname(plugin), "dsh-thread-projection-plugin.mjs"), config: { moduleUrl: engineModule("dsh-session-projection-cache") } },
      { insert: [{ id: "opencraft-capability", name: plugin, config: {
      token: bridgeToken,
      skillsRoot: join(bridgeDirectory, "skills"),
      persistentSkillsRoot,
      checkpointRoot: resolve(options.dataDirectory ?? bridgeDirectory, "surface-checkpoints"),
      toolsModuleUrl: pathToFileURL(resolve(dirname(executable), "../../dsh-tools/lib/index.js")).href,
    } }] }]), { mode: 0o600 });
    patches.push(patch);
  }
  // Only the owned, patched engine has a refresh port. An external engine's
  // absence of support is permanent, not a failed refresh to retry on send.
  const skillRefresh = new SkillCatalogRefresh(patches.length ? async () => {
    if (!capabilityLink) throw new Error("The engine Skill catalog refresh bridge is not ready");
    await capabilityLink.invalidateSkills();
  } : null);
  const profileSkills = new DshProfileSkillsHandler(persistentSkillsRoot, () => skillRefresh.changed());
  const supervisor = new DshSupervisor({
    executable: options.dshExecutable,
    repository: options.dshRepository,
    runtimeDirectory: options.runtimeDirectory,
    dataDirectory: options.dataDirectory,
    onUnexpectedExit: error => onEngineExit?.(error),
    patches,
    onCapabilityBridge: url => { bridgeUrl = url; capabilityLink?.attach(url); },
  });
  let dshUrl: string;
  try { dshUrl = options.dshUrl ?? await supervisor.start(); }
  catch (error) { if (bridgeDirectory) await rm(bridgeDirectory, { recursive: true, force: true }); throw error; }
  const routing = new DshSessionRouting(options.dataDirectory ? resolve(options.dataDirectory, "opencraft-session-routing.sqlite") : ":memory:");
  const client = new DshRoutedClient(dshUrl, routing);
  const socketClients = new Map<WebSocket, Map<string, LogicalClient>>();
  const lifecycle = new ThreadLifecycle(new ThreadCatalog(options.dataDirectory ? join(options.dataDirectory, "opencraft-threads.sqlite") : ":memory:"),
    async id => {
      if (!capabilityLink) return { released: false };
      const result = await capabilityLink.thread("release", { sessionId: routing.native(id) });
      if (result.released && lifecycle.catalog.get(id)?.ephemeral) client.forgetVolatile(id);
      return result;
    }, (method, params) => {
      for (const [socket, clients] of socketClients) for (const state of clients.values()) {
        const id = params.threadId ?? params.thread?.id;
        const global = ["thread/name/updated", "thread/archived", "thread/unarchived", "thread/closed"].includes(method);
        if (global || !id || lifecycle.attachments.has(state.key, id)) sendClient(socket, state.clientId, { jsonrpc: "2.0", method, params });
      }
    });
  let modelConfiguration: import('./model-config/dsh-adapter.js').DshModelConfigurationBridge | undefined;
  try { if(options.modelStorageDirectory){
    const {ModelConfigurationRepository,ModelCredentialRepository}=await import('./model-config/repository.js');
    const {ModelConfigurationService}=await import('./model-config/service.js');
    const {DshModelEngineAdapter,DshModelConfigurationBridge}=await import('./model-config/dsh-adapter.js');
    const {migrateDshModels}=await import('./model-config/migrate-dsh.js');
    const repository=new ModelConfigurationRepository(options.modelStorageDirectory),credentials=new ModelCredentialRepository(options.modelStorageDirectory);
    if(options.dataDirectory)await migrateDshModels(repository,credentials,options.dataDirectory,await client.call('settings.describe'));
    modelConfiguration=new DshModelConfigurationBridge(client,new ModelConfigurationService(repository,credentials,new DshModelEngineAdapter(client)));
    await modelConfiguration.initialize();
  } } catch(error) { await lifecycle.close(); routing.close(); await supervisor.stop(); if (bridgeDirectory) await rm(bridgeDirectory, { recursive: true, force: true }); throw error; }
  const authority = new DshExecutionAuthority(options.dataDirectory ? resolve(options.dataDirectory, "opencraft-executions.sqlite") : ":memory:");
  const adapter = new DshAppServerAdapter(client,modelConfiguration,authority,patches.length > 0, patches.length ? {
    read: async threadId => {
      if (!capabilityLink) throw new Error("DSH permission service is not ready");
      return capabilityLink.permissions(threadId);
    },
    set: async (threadId, preset) => {
      if (!capabilityLink) throw new Error("DSH permission service is not ready");
      return capabilityLink.permissions(threadId, preset);
    },
  } : undefined);
  const capabilities = new DshCapabilityBroker();
  try { if (patches.length) {
    capabilityLink = new DshCapabilityLink(bridgeToken, capabilities, authority, routing, () => {
      for (const [socket, clients] of socketClients) for (const state of clients.values()) {
        sendClient(socket, state.clientId, { jsonrpc: "2.0", method: "skills/changed", params: {} });
      }
    });
    if (bridgeUrl) capabilityLink.attach(bridgeUrl);
    for (const pending of routing.pending()) routing.reconcile(pending.logicalId, await capabilityLink.resolveGeneration(pending.logicalId));
  } } catch (error) {
    await lifecycle.close();
    await capabilityLink?.close();
    capabilities.close(); adapter.close(); authority.close(); routing.close();
    await supervisor.stop();
    if (bridgeDirectory) await rm(bridgeDirectory, { recursive: true, force: true });
    throw error;
  }
  if (capabilityLink) adapter.setModelInfoReader((provider, model) => capabilityLink!.modelInfo(provider, model));
  if (capabilityLink) adapter.setThreadEngine({
    describe: params => capabilityLink!.thread("describe", { ...params, sessionId: routing.native(String(params.sessionId)) }),
    create: async params => {
      const created = await capabilityLink!.thread("create", params);
      if (created.ephemeral) client.markVolatile(created.sessionId);
      return created;
    },
    resume: async params => {
      const id = String(params.sessionId);
      const configuration = lifecycle.catalog.configuration(id);
      const agentPreset = lifecycle.catalog.get(id)?.extra?.dsh?.agentPreset;
      const selection = decodeModel(configuration.model);
      const resumed = await capabilityLink!.thread("resume", { ...configuration, ...params, ...selection, agentPreset, sessionId: routing.native(id) });
      // The native Web API's picker is process-local for a never-run session.
      // Restore its product-owned binding before resume/fork reads that picker.
      if (selection) {
        const models = await client.call<{ current?: { provider: string; model: string } }>("session.models", { sessionId: id });
        if (models.current?.provider !== selection.provider || models.current?.model !== selection.model)
          await client.call("session.selectModel", { sessionId: id, ...selection });
      }
      if (capabilities.list(id).length) await capabilityLink!.register(id);
      return resumed;
    },
    fork: async params => {
      const source = String(params.sourceSessionId);
      const coordinates = routing.forkCoordinates(source, params.lastTurn as number | undefined, params.beforeTurn as number | undefined);
      const created = await capabilityLink!.thread("fork", { ...params, sourceSessionId: coordinates.nativeId, lastTurn: coordinates.lastTurn, beforeTurn: coordinates.beforeTurn });
      if (created.ephemeral) client.markVolatile(created.sessionId);
      return created;
    },
    inject: params => capabilityLink!.thread("inject", { ...params, sessionId: routing.native(String(params.sessionId)) }),
    release: params => capabilityLink!.thread("release", { ...params, sessionId: routing.native(String(params.sessionId)) }),
  });
  const restartBudget = new DshRestartBudget();
  restartBudget.ready();
  let restartOperation: Promise<void> | null = null;
  const restartEngine = (automatic = false): Promise<void> => {
    if (closing) return Promise.reject(new Error("Local host is closing"));
    if (options.dshUrl || process.env.OPENCRAFT_DSH_URL?.trim()) return Promise.reject(new Error("Externally managed DSH must be restarted by its owner"));
    if (restartOperation) return restartOperation;
    if (automatic) restartBudget.begin(); else restartBudget.reset();
    engineStatus = "restarting";
    for (const id of lifecycle.catalog.temporaryIds()) client.forgetVolatile(id);
    lifecycle.expireTemporaryThreads();
    adapter.engineUnavailable(new Error("DSH runtime stopped; the interrupted request will not be replayed"));
    restartOperation = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (automatic && !restartBudget.take()) throw new Error("DSH automatic restart budget exhausted");
          await supervisor.stop();
          if (closing) throw new Error("Local host is closing");
          client.baseUrl = await supervisor.start();
          if (closing) { await supervisor.stop(); throw new Error("Local host is closing"); }
          await client.call("host.describe");
          if (modelConfiguration) {
            await modelConfiguration.initialize();
            await modelConfiguration.config.synchronize(true);
          }
          if (capabilityLink) {
            const catalog = await client.call<{items: Array<{sessionId:string;cwd?:string}>}>("session.list");
            for (const session of catalog.items) {
              let current = routing.current(session.sessionId);
              const resolved = await capabilityLink.resolveGeneration(session.sessionId);
              if (routing.reconcile(session.sessionId, resolved)) current = routing.current(session.sessionId);
              if (resolved.sessionId !== current.nativeId) throw new Error("Checkpoint and logical routing disagree; recovery requires reconciliation");
              const models = await client.call<{current?:{provider:string;model:string}}>("session.models", { sessionId: session.sessionId });
              if (!models.current) continue;
              const history = await client.call<{events:Array<{event:{seq:number;data?:{turn?:number}}}>}>("session.history", { sessionId: session.sessionId, maxMessages: Number.MAX_SAFE_INTEGER });
              // A first interrupted request may not yet have a terminal checkpoint.
              // Capture the already-persisted native log before surface recovery.
              await capabilityLink.checkpoint(current.nativeId);
              routing.stage(session.sessionId, session.sessionId + ".g" + (current.generation + 1), {
                expectedNativeId: current.nativeId, generation: current.generation + 1,
                previousLastSeq: Math.max(-1, ...history.events.map(entry => entry.event.seq)),
                previousLastTurn: Math.max(0, ...history.events.map(entry => entry.event.data?.turn ?? 0)),
              });
              const next = await capabilityLink.createGeneration({
                logicalSessionId: session.sessionId, sourceSessionId: current.nativeId,
                cwd: session.cwd ?? homedir(), provider: models.current.provider, model: models.current.model,
              });
              routing.publish(current.nativeId, { logicalId: session.sessionId, nativeId: next.sessionId, generation: next.generation,
                seedThroughSeq: next.seedThroughSeq, seedThroughTurn: next.seedThroughTurn,
                previousLastSeq: Math.max(-1, ...history.events.map(entry => entry.event.seq)),
                previousLastTurn: Math.max(0, ...history.events.map(entry => entry.event.data?.turn ?? 0)),
              });
            }
          }
          await adapter.reconnectStreams();
          if (capabilityLink) for (const threadId of capabilities.threads()) {
            // Register only already-loaded generations. Idle display bindings stay
            // cold; their declarations will mount at the next execution activation.
            await capabilityLink.register(threadId);
          }
          engineStatus = "ready";
          restartBudget.ready();
          adapter.engineRecovered();
          return;
        } catch (error) {
          if (closing || attempt === 2) { engineStatus = "failed"; throw error; }
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
    })().finally(() => { restartOperation = null; });
    return restartOperation;
  };
  onEngineExit = error => {
    if (closing) return;
    adapter.engineUnavailable(error);
    void restartEngine(true).catch(() => { engineStatus = "failed"; });
  };
  const processes = new HostProcessService();
  const hostDocuments = new HostDocumentService(options.dataDirectory ? join(options.dataDirectory, "opencraft-host-documents.sqlite") : null);
  const projects = new ProjectRepository(options.projectStorageDirectory ?? options.modelStorageDirectory ?? options.dataDirectory);
  const token = options.token ?? randomBytes(24).toString("base64url");
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (url.pathname === "/health") {
      response.statusCode = engineStatus === "ready" ? 200 : 503;
      response.end(`${JSON.stringify({ ok: engineStatus === "ready", engine: "dsh", status: engineStatus })}\n`);
      return;
    }
    response.statusCode = 404;
    response.end(`${JSON.stringify({ ok: false, error: "Not found" })}\n`);
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/rpc" || url.searchParams.get("token") !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => websocketServer.emit("connection", client, request));
  });
  websocketServer.on("connection", (socket) => {
    const httpRequests = new Map<string, AbortController>();
    const physicalId = randomUUID(), clients = new Map<string, LogicalClient>();
    socketClients.set(socket, clients);
    const logicalClient = (clientId: string) => {
      let state = clients.get(clientId);
      if (!state) {
        const key = physicalId + ":" + clientId;
        state = { key, clientId, owner: { connectionId: key, identity: { id: "local-user", username: "local" } }, offered: new Set(), openedThreads: new Set() };
        clients.set(clientId, state);
      }
      return state;
    };
    const disconnectClient = async (state: LogicalClient) => {
      clients.delete(state.clientId);
      for (const threadId of capabilities.threads(state.owner)) await capabilityLink?.unregister(threadId);
      capabilities.disconnect(state.owner); authority.disconnect(state.owner);
      state.unsubscribeInteractions?.(); state.offered.clear(); state.openedThreads.clear();
      await lifecycle.disconnect(state.key);
    };
    const unsubscribe = adapter.subscribe((method, params) => {
      const value = params as { threadId?: string; thread?: { id: string }; requestId?: unknown };
      const id = value?.threadId ?? value?.thread?.id;
      if (id) lifecycle.touch(id);
      for (const state of clients.values()) {
        if (method === "serverRequest/resolved") state.offered.delete(String(value.requestId));
        if (!id || lifecycle.attachments.has(state.key, id)) sendClient(socket, state.clientId, { jsonrpc: "2.0", method, params });
      }
    });
    const unsubscribeProcesses = processes.subscribe((method, params) => send(socket, { jsonrpc: "2.0", method, params }));
    const connectorChanged = (id: string) => { for (const state of clients.values()) sendClient(socket, state.clientId, { jsonrpc: "2.0", method: "connectors/managed/changed", params: { id } }); };
    connectorListeners.add(connectorChanged);
    const unsubscribeDocuments = hostDocuments.subscribe(params => {
      for (const state of clients.values()) sendClient(socket, state.clientId, { jsonrpc: "2.0", method: HOST_STORAGE.changed, params });
    });
    socket.on("message", async (data, isBinary) => {
      if (isBinary) { socket.close(1003, "Text frames only"); return; }
      let request: JsonRpcMessage;
      try { request = JSON.parse(data.toString("utf8")) as JsonRpcMessage; }
      catch { send(socket, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); return; }
      const clientId = typeof request?.[LOGICAL_CLIENT_FIELD] === "string" ? request[LOGICAL_CLIENT_FIELD] as string : "";
      if (clientId.length > 4096) { socket.close(1008, "Invalid logical client"); return; }
      const state = logicalClient(clientId), { owner, offered, openedThreads } = state;
      await replyClient.run(clientId, async () => {
      if (request.method === "runtime/client/disconnect" && !("id" in request)) { await disconnectClient(state); return; }
      if (request && typeof request === "object" && typeof request.id === "string" && !("method" in request) && ("result" in request || "error" in request)) {
        if (capabilities.respond(owner, request.id, request.result, request.error)) return;
        if (!offered.has(request.id)) return;
        try { await adapter.interactions.respond(request.id, request); }
        catch (error) {
          console.error("[opencraft local host] interaction response failed", error);
          socket.close(1011, "Interaction response failed; reconnect to recover pending requests");
        }
        return;
      }
      // JSON-RPC notifications (including initialized) have no response.
      if (request && typeof request === "object" && !("id" in request) && typeof request.method === "string") return;
      if (!request || typeof request !== "object" || (typeof request.id !== "string" && typeof request.id !== "number") || typeof request.method !== "string") {
        send(socket, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
        return;
      }
      try {
        if (request.method.startsWith("storage/documents/")) {
          const result = hostDocuments.handle(request.method, request.params);
          send(socket, { jsonrpc: "2.0", id: request.id, result }); return;
        }
        if (request.method.startsWith("connectors/managed/")) {
          const result = await connectors().handle(request.method, request.params);
          send(socket, { jsonrpc: "2.0", id: request.id, result }); return;
        }
        if (request.method.startsWith("attachment/")) {
          const result = await attachmentStaging.handle(request.method, request.params);
          send(socket, { jsonrpc: "2.0", id: request.id, result }); return;
        }
        const targetThread = (request.params as { threadId?: string } | null)?.threadId;
        if (request.method.startsWith("turn/") && typeof targetThread === "string") lifecycle.assertOpen(targetThread);
        if (request.method === "turn/start" && typeof targetThread === "string") {
          // JIT history keeps display-only resume cold. Execution is the point
          // where the native Agent must exist and every declared Host tool must
          // be mounted before the prompt can enter DSH.
          await adapter.activateThread(targetThread);
          await skillRefresh.ensureFresh();
          const expected = capabilities.list(targetThread).length;
          if (expected > 0) {
            if (!capabilityLink) throw new Error("This host cannot register engine capabilities");
            verifyDshCapabilityRegistration(
              expected,
              await capabilityLink.register(targetThread),
            );
          }
        }
        if (request.method === "runtime/http/cancel") {
          const id = (request.params as { requestId: string }).requestId;
          const active = httpRequests.get(id);
          active?.abort();
          send(socket, { jsonrpc: "2.0", id: request.id, result: { cancelled: !!active } }); return;
        }
        if (request.method === "runtime/http/request") {
          const params = request.params as Parameters<typeof requestLoopback>[0] & { requestId: string };
          if (typeof params?.requestId !== "string" || httpRequests.has(params.requestId)) throw new Error("Invalid or duplicate HTTP request identity");
          const abort = new AbortController(); httpRequests.set(params.requestId, abort);
          try {
            const address = server.address();
            const ports = [Number(new URL(client.baseUrl).port), ...(bridgeUrl ? [Number(new URL(bridgeUrl).port)] : []),
              ...(address && typeof address !== "string" ? [address.port] : [])];
            const result = await requestLoopback(params, abort.signal, ports);
            send(socket, { jsonrpc: "2.0", id: request.id, result });
          } finally { httpRequests.delete(params.requestId); }
          return;
        }
        if (request.method === "runtime/capabilities/register") {
          const params = request.params as { threadId: string; dynamicTools: unknown };
          if (!openedThreads.has(params?.threadId)) throw new Error("Open the thread before registering its capabilities");
          if (!capabilityLink) throw new Error("This host cannot register engine capabilities");
          const sameOwner = capabilities.threads(owner).includes(params.threadId);
          const unchanged = sameOwner && capabilities.matches(params.threadId, owner, params.dynamicTools);
          if (authority.table.get(params.threadId) && !unchanged) throw new Error("Cannot replace capabilities of an active execution");
          if (unchanged) {
            const expected = capabilities.list(params.threadId).length;
            const engineRegistration = await capabilityLink.register(params.threadId);
            verifyDshCapabilityRegistration(expected, engineRegistration, { allowDeferred: true });
            send(socket, { jsonrpc: "2.0", id: request.id, result: engineRegistration });
            return;
          }
          await capabilityLink.validate(normalizeCapabilities(params.dynamicTools));
          const registered = capabilities.register(params.threadId, owner, params.dynamicTools, frame => sendClient(socket, clientId, { jsonrpc: "2.0", ...frame }));
          await capabilityLink.unregister(params.threadId);
          const engineRegistration = await capabilityLink.register(params.threadId);
          verifyDshCapabilityRegistration(registered.length, engineRegistration, { allowDeferred: true });
          send(socket, { jsonrpc: "2.0", id: request.id, result: engineRegistration });
          return;
        }
        const readSkills = async () => {
          if (!capabilityLink) throw new Error("This DSH host does not expose complete Skill metadata");
          await skillRefresh.ensureFresh();
          const threadId = [...openedThreads].at(-1);
          const cwd = threadId
            ? (await adapter.dispatch("thread/read", { threadId, includeTurns: false }) as { thread: { cwd: string } }).thread.cwd
            : (await client.call<{cwd:string}>("host.describe")).cwd;
          const params = request.params as { cwds?: string[]; forceReload?: boolean } | undefined;
          const cwds = params?.cwds?.length ? params.cwds : [cwd];
          return { data: await Promise.all(cwds.map(cwd => capabilityLink!.skills(threadId, cwd, params?.forceReload === true))) };
        };
        // Validate and snapshot before creating a native child/catalog entry. A malformed
        // declaration must not leave a successfully created but unacknowledged thread.
        const bindsCapabilities = ["thread/start", "thread/resume", "thread/fork"].includes(request.method);
        const toolSpecs = bindsCapabilities ? structuredClone(
          (request.params as { dynamicTools?: unknown } | undefined)?.dynamicTools
          ?? (request.method === "thread/fork" ? capabilities.specs(String((request.params as { threadId: string }).threadId), owner) : undefined),
        ) : undefined;
        if (toolSpecs !== undefined) {
          const normalized = normalizeCapabilities(toolSpecs);
          if (capabilityLink) await capabilityLink.validate(normalized);
        }
        let result = request.method === "project/list"
          ? await projects.list(request.params as import("@opencraft/appserver-protocol/generated/v2").ProjectListParams)
          : request.method === "project/create"
          ? await projects.create(request.params as import("@opencraft/appserver-protocol/generated/v2").ProjectCreateParams)
          : request.method === "skills/list"
          ? await readSkills()
          : PROFILE_SKILLS_METHODS.has(request.method as ProfileSkillsMethod)
          ? await profileSkills.handle(request.method as ProfileSkillsMethod, request.params)
          : request.method.startsWith("process/")
          ? processes.dispatch(request.method, request.params)
          : request.method.startsWith("fs/")
          ? await fileRequest(request.method, request.params)
          : request.method.startsWith("thread/") || request.method === "turn/start"
          ? await lifecycle.dispatch(request.method, (request.params ?? {}) as Record<string, unknown>, state.key,
            (method, params) => adapter.dispatchOwned(method, params, owner, request.id as string | number))
          : await adapter.dispatchOwned(request.method, request.params, owner, request.id as string | number);
        if (request.method === "initialize") {
          const initialized = result as import("@opencraft/appserver-protocol").AppServerInitializeResponse;
          result = {
            ...initialized,
            capabilities: {
              ...initialized.capabilities,
              extensions: {
                ...initialized.capabilities?.extensions,
                [OPENCRAFT_ATTACHMENT_STAGING_EXTENSION]: attachmentStaging.capability,
              },
            },
          };
        }
        const capabilityThreadId = (result as { thread?: { id?: string } } | null)?.thread?.id
          ?? (request.params as { threadId?: string } | undefined)?.threadId;
        if (request.method === "turn/start" && typeof capabilityThreadId === "string") lifecycle.acceptedTurn(capabilityThreadId, request.params as Record<string, unknown>);
        if (bindsCapabilities && typeof capabilityThreadId === "string" && toolSpecs !== undefined) {
          const registered = capabilities.register(capabilityThreadId, owner, toolSpecs, frame => sendClient(socket, clientId, { jsonrpc: "2.0", ...frame }));
          if (capabilityLink) {
            await capabilityLink.unregister(capabilityThreadId);
            const engineRegistration = await capabilityLink.register(capabilityThreadId);
            verifyDshCapabilityRegistration(
              registered.length,
              engineRegistration,
              { allowDeferred: request.method === "thread/resume" },
            );
          }
        }
        send(socket, { jsonrpc: "2.0", id: request.id, result });
        // Initialization (including preflight) must not claim another client's
        // user interactions. Only a connection opening a thread may answer it.
        if (["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(request.method) && socket.readyState === WebSocket.OPEN) {
          const reply = result as { thread?: { id?: string } } | null;
          const params = request.params as { threadId?: string } | undefined;
          const threadId = reply?.thread?.id ?? params?.threadId;
          if (typeof threadId === "string") openedThreads.add(threadId);
          state.unsubscribeInteractions?.();
          state.unsubscribeInteractions = adapter.interactions.subscribe(interaction => {
            if (!openedThreads.has(interaction.params.threadId) || offered.has(interaction.id)) return;
            offered.add(interaction.id);
            sendClient(socket, clientId, { jsonrpc: "2.0", ...interaction });
          });
        }
      } catch (error) {
        send(socket, { jsonrpc: "2.0", id: request.id, error: rpcError(error) });
      }
      });
    });
    socket.once("close", () => {
      for (const pending of httpRequests.values()) pending.abort();
      socketClients.delete(socket);
      for (const state of [...clients.values()]) void disconnectClient(state).catch(() => undefined);
      unsubscribe(); unsubscribeProcesses(); connectorListeners.delete(connectorChanged); unsubscribeDocuments();
    });
  });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
  } catch (error) {
    closing = true;
    managedConnectors?.close();
    hostDocuments.close();
    await lifecycle.close();
    adapter.close();
    capabilities.close();
    await capabilityLink?.close();
    authority.close();
    routing.close();
    processes.close();
    for (const client of websocketServer.clients) client.terminate();
    websocketServer.close();
    if (server.listening) await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await supervisor.stop();
    if (bridgeDirectory) await rm(bridgeDirectory, { recursive: true, force: true });
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Local Agent Host did not bind a TCP port");
  const websocketUrl = `ws://127.0.0.1:${address.port}/rpc?token=${encodeURIComponent(token)}`;
  return {
    websocketUrl,
    get dshUrl() { return client.baseUrl; },
    get engineProcessId() { return supervisor.processId; },
    get engineState() { return engineStatus; },
    restartEngine,
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      managedConnectors?.close();
      hostDocuments.close();
      await lifecycle.close();
      adapter.close();
      capabilities.close();
      await capabilityLink?.close();
      processes.close();
      for (const client of websocketServer.clients) client.close(1001, "OpenCraft is quitting");
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      await supervisor.stop();
      await restartOperation?.catch(() => undefined);
      authority.close();
      routing.close();
      if (bridgeDirectory) await rm(bridgeDirectory, { recursive: true, force: true });
    },
  };
}
