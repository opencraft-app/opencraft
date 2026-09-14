import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile, mkdtemp, rm, access } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { WebSocket, WebSocketServer } from "ws";

import { DshAppServerAdapter } from "./dsh-appserver-adapter.js";
import { DshClient, DshClientError } from "./dsh-client.js";
import { DshSupervisor } from "./dsh-supervisor.js";
import { DshRestartBudget } from "./dsh-restart-budget.js";
import { DshExecutionAuthority } from "./dsh-execution-authority.js";
import { DshCapabilityBroker } from "./dsh-capability-broker.js";
import { DshCapabilityLink } from "./dsh-capability-link.js";
import { requestLoopback } from "./loopback-http.js";
import { DshSessionRouting } from "./dsh-session-routing.js";
import { DshRoutedClient } from "./dsh-routed-client.js";
import { DshHistoryIndex } from "./dsh-history-index.js";
import { HostProcessService } from "./process-service.js";

type JsonRpcMessage = Record<string, unknown>;

function rpcError(error: unknown): { code: number; message: string; data?: unknown } {
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
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
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
  readonly dataDirectory?: string;
  readonly modelStorageDirectory?: string;
} = {}) {
  let closing = false;
  let onEngineExit: ((error: Error) => void) | undefined;
  let engineStatus: "ready" | "restarting" | "failed" = "ready";
  const bridgeToken = randomBytes(32).toString("hex");
  let bridgeUrl: string | undefined;
  let capabilityLink: DshCapabilityLink | undefined;
  let bridgeDirectory: string | undefined;
  const patches: string[] = [];
  if (!options.dshUrl && !process.env.OPENCRAFT_DSH_URL?.trim()) {
    const executable = resolve(options.dshExecutable ?? process.env.OPENCRAFT_DSH_EXECUTABLE ?? "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js");
    const bundled = resolve(dirname(executable), "../../../../opencraft-capability-plugin.mjs");
    let plugin = bundled;
    try { await access(plugin); } catch { plugin = resolve("apps/local-agent-host/src/dsh-capability-plugin.mjs"); await access(plugin); }
    bridgeDirectory = await mkdtemp(join(tmpdir(), "opencraft-engine-plugin-"));
    const patch = join(bridgeDirectory, "patch.json");
    await writeFile(patch, JSON.stringify([{ insert: [{ id: "opencraft-capability", name: plugin, config: {
      token: bridgeToken, skillsRoot: join(bridgeDirectory, "skills"),
      checkpointRoot: resolve(options.dataDirectory ?? bridgeDirectory, "surface-checkpoints"),
      toolsModuleUrl: pathToFileURL(resolve(dirname(executable), "../../dsh-tools/lib/index.js")).href,
    } }] }]), { mode: 0o600 });
    patches.push(patch);
  }
  const supervisor = new DshSupervisor({
    executable: options.dshExecutable,
    repository: options.dshRepository,
    dataDirectory: options.dataDirectory,
    onUnexpectedExit: error => onEngineExit?.(error),
    patches,
    onCapabilityBridge: url => { bridgeUrl = url; capabilityLink?.attach(url); },
  });
  let dshUrl: string;
  try { dshUrl = options.dshUrl ?? await supervisor.start(); }
  catch (error) { if (bridgeDirectory) await rm(bridgeDirectory, { recursive: true, force: true }); throw error; }
  const routing = new DshSessionRouting(options.dataDirectory ? resolve(options.dataDirectory, "opencraft-session-routing.sqlite") : ":memory:");
  const client = new DshRoutedClient(dshUrl, routing, new DshHistoryIndex(options.dataDirectory ? resolve(options.dataDirectory, "opencraft-history-index.sqlite") : ":memory:"));
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
  } } catch(error) { client.closeIndex(); routing.close(); await supervisor.stop(); if (bridgeDirectory) await rm(bridgeDirectory, { recursive: true, force: true }); throw error; }
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
    capabilityLink = new DshCapabilityLink(bridgeToken, capabilities, authority, routing);
    if (bridgeUrl) capabilityLink.attach(bridgeUrl);
    for (const pending of routing.pending()) routing.reconcile(pending.logicalId, await capabilityLink.resolveGeneration(pending.logicalId));
  } } catch (error) {
    await capabilityLink?.close();
    capabilities.close(); adapter.close(); authority.close(); client.closeIndex(); routing.close();
    await supervisor.stop();
    if (bridgeDirectory) await rm(bridgeDirectory, { recursive: true, force: true });
    throw error;
  }
  const restartBudget = new DshRestartBudget();
  restartBudget.ready();
  let restartOperation: Promise<void> | null = null;
  const restartEngine = (automatic = false): Promise<void> => {
    if (closing) return Promise.reject(new Error("Local host is closing"));
    if (options.dshUrl || process.env.OPENCRAFT_DSH_URL?.trim()) return Promise.reject(new Error("Externally managed DSH must be restarted by its owner"));
    if (restartOperation) return restartOperation;
    if (automatic) restartBudget.begin(); else restartBudget.reset();
    engineStatus = "restarting";
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
            await client.call("session.models", { sessionId: threadId });
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
    const owner = { connectionId: randomUUID(), identity: { id: "local-user", username: "local" } };
    const offered = new Set<string>();
    const openedThreads = new Set<string>();
    let unsubscribeInteractions: (() => void) | undefined;
    const unsubscribe = adapter.subscribe((method, params) => {
      if (method === "serverRequest/resolved") offered.delete(String((params as { requestId: unknown }).requestId));
      send(socket, { jsonrpc: "2.0", method, params });
    });
    const unsubscribeProcesses = processes.subscribe((method, params) => send(socket, { jsonrpc: "2.0", method, params }));
    socket.on("message", async (data, isBinary) => {
      if (isBinary) { socket.close(1003, "Text frames only"); return; }
      let request: JsonRpcMessage;
      try { request = JSON.parse(data.toString("utf8")) as JsonRpcMessage; }
      catch { send(socket, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); return; }
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
            send(socket, { jsonrpc: "2.0", id: request.id, result: { registered: capabilities.list(params.threadId).length } });
            return;
          }
          const registered = capabilities.register(params.threadId, owner, params.dynamicTools, frame => send(socket, { jsonrpc: "2.0", ...frame }));
          await capabilityLink.unregister(params.threadId);
          await capabilityLink.register(params.threadId);
          send(socket, { jsonrpc: "2.0", id: request.id, result: { registered: registered.length } });
          return;
        }
        const readSkills = async () => {
          if (!capabilityLink) throw new Error("This DSH host does not expose complete Skill metadata");
          const threadId = [...openedThreads].at(-1);
          const cwd = threadId
            ? (await adapter.dispatch("thread/read", { threadId, includeTurns: false }) as { thread: { cwd: string } }).thread.cwd
            : (await client.call<{cwd:string}>("host.describe")).cwd;
          const params = request.params as { cwds?: string[]; forceReload?: boolean } | undefined;
          const cwds = params?.cwds?.length ? params.cwds : [cwd];
          return { data: await Promise.all(cwds.map(cwd => capabilityLink!.skills(threadId, cwd, params?.forceReload === true))) };
        };
        const result = request.method === "skills/list"
          ? await readSkills()
          : request.method.startsWith("process/")
          ? processes.dispatch(request.method, request.params)
          : request.method.startsWith("fs/")
          ? await fileRequest(request.method, request.params)
          : await adapter.dispatchOwned(request.method, request.params, owner, request.id as string | number);
        const capabilityThreadId = (result as { thread?: { id?: string } } | null)?.thread?.id
          ?? (request.params as { threadId?: string } | undefined)?.threadId;
        const toolSpecs = (request.params as { dynamicTools?: unknown } | undefined)?.dynamicTools;
        if (["thread/start", "thread/resume"].includes(request.method) && typeof capabilityThreadId === "string" && toolSpecs !== undefined) {
          capabilities.register(capabilityThreadId, owner, toolSpecs, frame => send(socket, { jsonrpc: "2.0", ...frame }));
          if (capabilityLink) {
            await capabilityLink.unregister(capabilityThreadId);
            await capabilityLink.register(capabilityThreadId);
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
          unsubscribeInteractions?.();
          unsubscribeInteractions = adapter.interactions.subscribe(interaction => {
            if (!openedThreads.has(interaction.params.threadId) || offered.has(interaction.id)) return;
            offered.add(interaction.id);
            send(socket, { jsonrpc: "2.0", ...interaction });
          });
        }
      } catch (error) {
        send(socket, { jsonrpc: "2.0", id: request.id, error: rpcError(error) });
      }
    });
    socket.once("close", () => {
      for (const pending of httpRequests.values()) pending.abort();
      for (const threadId of capabilities.threads(owner)) void capabilityLink?.unregister(threadId);
      capabilities.disconnect(owner); authority.disconnect(owner); unsubscribe(); unsubscribeProcesses(); unsubscribeInteractions?.(); offered.clear(); openedThreads.clear();
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
    adapter.close();
    capabilities.close();
    await capabilityLink?.close();
    authority.close();
    routing.close();
    client.closeIndex();
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
      client.closeIndex();
      if (bridgeDirectory) await rm(bridgeDirectory, { recursive: true, force: true });
    },
  };
}
