import { nodeObserver } from "../../../packages/observability-contract/node.mjs";
import { LocalHostResources } from "./host-resources.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { AppServerRpcError, serializeHistoryReply, type ExecutionEngineClient, type ExecutionEngineProvider } from "@opencraft/appserver-client";
import { SCOPED_SKILL_CATALOG_EXTENSION, SCOPED_SKILL_CATALOG_METHOD, OPENCRAFT_METHOD_ACCESS_EXTENSION, parseAppServerMethodAccess } from "@opencraft/appserver-protocol";

type Value = Record<string, any>;
interface LegacyHost { websocketUrl: string; resolveWebsocketUrl?: () => Promise<string>; close(): Promise<void>; storageOutcomes?: readonly unknown[] }

/** A single Host endpoint, with an immutable engine namespace per native thread.
 * Providers own agent execution; this owner only routes and aggregates catalogs.
 */
export async function startEngineHost(options: {
  providers: readonly ExecutionEngineProvider[];
  defaultEngine: string;
  legacy?: { id: string; label: string; start(): Promise<LegacyHost> };
  machine?: unknown;
  admitRequest?: <T>(method: string, operation: () => Promise<T>) => Promise<T>;
  strictClose?: boolean;
  resources?: { projectDirectory?: string; attachmentDirectory?: string };
}) {
  const resources = options.resources || !options.legacy ? new LocalHostResources(options.resources) : undefined;
  const registry = new Map(options.providers.map(provider => [provider.id, provider]));
  if (registry.size !== options.providers.length || options.legacy && registry.has(options.legacy.id)) throw new Error("Duplicate execution engine");
  if (!registry.has(options.defaultEngine) && options.defaultEngine !== options.legacy?.id) throw new Error("Default execution engine is not enabled");
  const readiness = new Map<string, string>();
  await Promise.all(options.providers.map(async provider => {
    try { await provider.start?.(); readiness.set(provider.id, "ready"); }
    catch { readiness.set(provider.id, "unavailable"); }
  }));
  let legacy: Promise<LegacyHost> | undefined, closing = false;
  const legacyHost = () => {
    if (!options.legacy) throw new Error("DSH is disabled; this operation requires an enabled provider");
    return legacy ??= options.legacy.start().catch(error => { legacy = undefined; throw error; });
  };
  let unknownConsumer = false, callbacks = 0;
  const consumerTurns = new Map<string, string>();
  const completedConsumerTurns = new Map<string, Set<string>>();
  const pendingConsumerAdmissions = new Map<string, number>();
  const consumerEvent = (method: string, params: Value) => {
    const id = params?.threadId, turn = params?.turn;
    if (!id) return;
    if (method === "turn/started" && typeof turn?.id === "string" && !completedConsumerTurns.get(id)?.has(turn.id)) consumerTurns.set(id, turn.id);
    if (method === "turn/completed") {
      if (["completed", "failed", "interrupted"].includes(turn?.status) && typeof turn?.id === "string") {
        if (pendingConsumerAdmissions.has(id)) {
          const completed = completedConsumerTurns.get(id) ?? new Set<string>();
          completed.add(turn.id); completedConsumerTurns.set(id, completed);
        }
        if (consumerTurns.get(id) === turn.id || consumerTurns.get(id) === "unknown") consumerTurns.delete(id);
      }
      else unknownConsumer = true;
    }
  };
  const token = randomUUID();
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (closing || url.pathname !== "/rpc" || url.searchParams.get("token") !== token) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, client => sockets.emit("connection", client));
  });
  const connectionObservations = new Set<() => number>();
  sockets.on("connection", socket => {
    // A backend read is canceled with its frontend connection. Only logical
    // clients sharing that lifetime may share an in-flight request.
    const flights = new Map<string, Promise<unknown>>();
    const singleflight = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
      const existing = flights.get(key) as Promise<T> | undefined;
      if (existing !== undefined) return existing;
      const started = Promise.resolve().then(operation);
      flights.set(key, started);
      // Callers observe rejection; the cleanup promise must also handle it.
      void started.finally(() => { if (flights.get(key) === started) flights.delete(key); }).catch(() => undefined);
      return started;
    };
    let stopped = false, backend: WebSocket | undefined, backendStarting: Promise<WebSocket> | undefined;
    const internal = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    const platform = new Map<string, { clientId: string; resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    const observation = () => internal.size + platform.size;
    connectionObservations.add(observation);
    const clients = new Map<string, { owner: ExecutionEngineClient; opened: Set<string>; reading: Set<string> }>();
    const send = (value: Value) => { if (!stopped && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
    const client = (clientId: string) => {
      let state = clients.get(clientId); if (state) return state;
      const opened = new Set<string>();
      const owner: ExecutionEngineClient = {
        notify(method, params) { consumerEvent(method, params); send({ jsonrpc: "2.0", method, params, [LOGICAL_CLIENT_FIELD]: clientId }); },
        request(method, params) {
          if (stopped || !opened.has(String(params.threadId))) return Promise.reject(new Error("Platform tool owner expired"));
          const id = `engine-tool:${randomUUID()}`;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { unknownConsumer = true; platform.delete(id); reject(new Error("Platform tool timed out")); }, 120_000);
            platform.set(id, { clientId, resolve, reject, timer }); send({ jsonrpc: "2.0", id, method, params, [LOGICAL_CLIENT_FIELD]: clientId });
          });
        },
      };
      state = { owner, opened, reading: new Set() }; clients.set(clientId, state); return state;
    };
    const subscriptions = options.providers.map(provider => provider.subscribe((method, params) => {
      consumerEvent(method, params);
      const threadId = params.threadId ?? params.thread?.id;
      for (const state of clients.values()) if (method === "opencraft/schedules/changed" || method === "skills/changed" || threadId && (state.opened.has(threadId) || state.reading.has(threadId))) state.owner.notify(method, params);
    }));
    // A frontend connection owns one backend incarnation. Replacing only the
    // backend would lose its connection-scoped Thread attachments while the
    // frontend still considers their history authoritative. Let the existing
    // client reconnect/Resume owner establish the entire successor instead.
    const stop = () => {
      if (stopped) return;
      stopped = true;
      const connection = backend;
      backend = undefined; backendStarting = undefined;
      subscriptions.forEach(unsubscribe => unsubscribe());
      for (const state of clients.values()) for (const provider of options.providers) provider.disconnect(state.owner);
      clients.clear(); connectionObservations.delete(observation);
      if (internal.size || platform.size) unknownConsumer = true;
      for (const call of internal.values()) { clearTimeout(call.timer); call.reject(new Error("Host connection closed")); } internal.clear();
      for (const call of platform.values()) { clearTimeout(call.timer); call.reject(new Error("Platform tool owner disconnected")); } platform.clear();
      if (connection?.readyState === WebSocket.CONNECTING) connection.terminate();
      else connection?.close();
    };
    const failBackend = (connection: WebSocket) => {
      if (stopped || backend !== connection) return;
      stop();
      socket.close(1012, "Execution connection lost; reconnect to restore");
    };
    const connectBackend = () => backendStarting ??= (async () => {
      const host = await legacyHost();
      const target = host.resolveWebsocketUrl ? await host.resolveWebsocketUrl() : host.websocketUrl;
      if (stopped || closing) throw new Error("Host connection closed");
      const connection = new WebSocket(target); backend = connection;
      connection.on("message", data => {
        if (stopped || backend !== connection) return;
        let message: Value; try { message = JSON.parse(data.toString()); } catch { connection.close(); return; }
        if (typeof message.method === 'string') consumerEvent(message.method, message.params ?? {});
        if (typeof message.method === 'string') nodeObserver('gateway').execution('dsh',message.method,message.params);
        const pending = internal.get(String(message.id));
        if (pending && !message.method) {
          internal.delete(String(message.id)); clearTimeout(pending.timer);
          message.error ? pending.reject(new AppServerRpcError(message.error)) : pending.resolve(message.result);
        } else send(message);
      });
      connection.on("close", () => failBackend(connection)); connection.on("error", () => failBackend(connection));
      await new Promise<void>((resolve, reject) => {
        connection.once("open", resolve); connection.once("error", reject);
        connection.once("close", () => reject(new Error("DSH connection closed before opening")));
      });
      if (stopped) { connection.close(); throw new Error("Host connection closed"); } return connection;
    })().catch(error => { backendStarting = undefined; throw error; });
    const callLegacy = async (method: string, params: Value, clientId: string) => {
      const connection = await connectBackend(), id = `engine-host:${randomUUID()}`;
      if (stopped || backend !== connection || connection.readyState !== WebSocket.OPEN) throw new Error("Host connection closed");
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { unknownConsumer = true; internal.delete(id); reject(new Error(`DSH ${method} timed out`)); }, 30_000);
        internal.set(id, { resolve, reject, timer }); connection.send(JSON.stringify({ jsonrpc: "2.0", id, method, params, [LOGICAL_CLIENT_FIELD]: clientId }));
      });
    };
    const allLegacy = async (method: string, params: Value, clientId: string) => {
      const data: Value[] = []; let cursor = null; const seen = new Set<string>();
      do {
        const page = await callLegacy(method, { ...params, cursor, limit: 200 }, clientId); data.push(...page.data);
        cursor = page.nextCursor;
        if (cursor != null && seen.has(cursor)) throw new Error("Engine returned a repeated catalog cursor");
        if (cursor != null) seen.add(cursor);
      } while (cursor != null);
      return data;
    };
    socket.on("message", data => {
      if (stopped) return;
      void (async () => {
        let frame: Value;
        try { frame = JSON.parse(data.toString()); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); return; }
        const clientId = typeof frame[LOGICAL_CLIENT_FIELD] === "string" ? frame[LOGICAL_CLIENT_FIELD] : "";
        if (clientId.length > 4096) { socket.close(1008); return; }
        const state = client(clientId);
        const reply = (result: unknown) => {
          if (!stopped && socket.readyState === WebSocket.OPEN) socket.send(serializeHistoryReply(
            { jsonrpc: "2.0", id: frame.id, result, [LOGICAL_CLIENT_FIELD]: clientId }, frame.method));
        };
        try {
          if (!frame.method) {
            const request = platform.get(String(frame.id));
            if (request) {
              if (request.clientId !== clientId) throw new Error("Platform tool response owner mismatch");
              platform.delete(String(frame.id)); clearTimeout(request.timer);
              frame.error ? request.reject(new Error("Platform tool failed")) : request.resolve(frame.result); return;
            }
            if (backend?.readyState === WebSocket.OPEN) backend.send(JSON.stringify(frame)); return;
          }
          const dispatchInner = async () => {
          const method = frame.method, params = frame.params ?? {};
          if (typeof method === "string" && method.startsWith("opencraft/orchestration/")) {
            const driver = params.driver ?? params.settings?.driver;
            const provider = typeof driver === "string" ? registry.get(driver)
              : options.providers.find(provider => provider.ownsThread(params.threadId ?? ""));
            if (!provider || !(provider.extensions?.["opencraft/thread-orchestration"] as Value)?.version)
              throw new Error("Orchestration driver is unavailable");
            reply(await provider.request(method, params, state.owner)); return;
          }
          if (method === "runtime/client/disconnect") {
            for (const provider of options.providers) provider.disconnect(state.owner);
            clients.delete(clientId);
            for (const [id, request] of platform) if (request.clientId === clientId) { platform.delete(id); clearTimeout(request.timer); request.reject(new Error("Platform tool owner disconnected")); }
            backend?.send(JSON.stringify(frame)); return;
          }
          if (method === "runtime/engines/list") { reply({ defaultEngine: options.defaultEngine, data: [
            ...(options.legacy ? [{ id: options.legacy.id, label: options.legacy.label }] : []),
            ...options.providers.map(provider => ({ id: provider.id, label: provider.label, state: readiness.get(provider.id) })),
          ] }); return; }
          if (resources?.handles(method)) { reply(await resources.request(method, params)); return; }
          if (method === "runtime/machine/read") { reply({ machine: options.machine }); return; }
          if (method === "initialize") {
            const piInitialization = {
              userAgent: "opencraft-pi-durable/1.3.0", platformFamily: "unix", platformOs: process.platform,
              capabilities: { extensions: registry.get(options.defaultEngine)?.extensions ?? {} },
            };
            // A configured legacy backend supplies this Host's negotiated
            // capabilities. Failure must reject initialization, not silently
            // manufacture a successful Pi handshake for a DSH conversation.
            const initialized = options.legacy
              ? await singleflight(`initialize:${JSON.stringify(params)}`, () => callLegacy(method, params, clientId))
              : piInitialization;
            const access = parseAppServerMethodAccess(initialized.capabilities?.extensions?.[OPENCRAFT_METHOD_ACCESS_EXTENSION]);
            reply({ ...initialized, capabilities: { ...initialized.capabilities, extensions: { ...initialized.capabilities?.extensions, ...resources?.extensions,
              ...(access ? { [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { ...access, methods: [...new Set([...access.methods, SCOPED_SKILL_CATALOG_METHOD])] } } : {}),
              [SCOPED_SKILL_CATALOG_EXTENSION]: { version: 1 },
              "opencraft/execution-engines": { version: 1, defaultEngine: options.defaultEngine, providers: options.providers.map(provider => ({ id: provider.id, threadPrefix: provider.threadPrefix, modelPrefix: provider.modelPrefix, extensions: provider.extensions })) },
              "opencraft/thread-pins": { version: 1 },
              "opencraft/scoped-model-catalog": { version: 1 } } } }); return;
          }
          if (method === "opencraft/schedules/list") {
            const providers = options.providers.filter(provider => (provider.extensions?.["opencraft/conversation-schedules"] as Value)?.summary === true);
            const outcomes = await Promise.allSettled([
              ...(options.legacy ? [callLegacy(method, params, clientId)] : []),
              ...providers.map(provider => provider.request(method, params, state.owner)),
            ]);
            const pages = outcomes.flatMap(outcome => outcome.status === "fulfilled" ? [outcome.value] : []);
            if (!pages.length) throw new Error("No scheduling engine catalog is available");
            const ids = [...(options.legacy ? [options.legacy.id] : []), ...providers.map(provider => provider.id)];
            reply({ schedules: pages.flatMap(page => page.schedules), unavailableEngines: outcomes.flatMap((value, i) => value.status === "rejected" ? [ids[i]] : []) }); return;
          }
          if (method === "opencraft/thread-pins/list") {
            const outcomes = await Promise.allSettled([
              ...(options.legacy ? [callLegacy(method, params, clientId)] : []),
              ...options.providers.map(provider => provider.request(method, params, state.owner)),
            ]);
            const pages = outcomes.flatMap(outcome => outcome.status === "fulfilled" ? [outcome.value] : [])
              .filter(page => page?.supported === true && Array.isArray(page.data));
            // Only an engine that answered can prove support. A rejected engine
            // is either unsupported or temporarily unavailable; never turn that
            // into an authoritative empty pin catalog.
            if (pages.length === 0) {
              const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
              if (failure) throw failure.reason;
              reply({ supported: false, data: [] }); return;
            }
            const seen = new Set<string>(), data: Value[] = [];
            for (const page of pages) for (const row of page.data) {
              if (typeof row?.id !== "string" || seen.has(row.id)) continue;
              seen.add(row.id); data.push(row);
            }
            reply({ supported: true, data }); return;
          }
          if (method === "opencraft/thread-pins/set") {
            const threadId = params.threadId, pinned = params.pinned;
            if (typeof threadId !== "string" || threadId.length === 0) throw new Error("Invalid thread pin target");
            if (typeof pinned !== "boolean") throw new Error("Invalid thread pin state");
            const provider = options.providers.find(provider => provider.ownsThread(threadId));
            if (provider) { reply(await provider.request(method, params, state.owner)); return; }
            reply(await callLegacy(method, params, clientId)); return;
          }
          if (method === "config/read" && options.defaultEngine !== options.legacy?.id) {
            reply(await registry.get(options.defaultEngine)!.request(method, params, state.owner)); return;
          }
          if (method === "config/batchWrite") {
            const model = params.edits?.find((edit: Value) => edit.keyPath === "model")?.value;
            const target = options.providers.find(provider => provider.ownsModel(model ?? ""))
              ?? (options.defaultEngine !== options.legacy?.id ? registry.get(options.defaultEngine) : undefined);
            if (target) { reply(await target.request(method, params, state.owner)); return; }
          }
          if (method === "permissionProfile/list" && !options.legacy) { reply(await registry.get(options.defaultEngine)!.request(method, params, state.owner)); return; }
          if (method === "skills/list" || method === SCOPED_SKILL_CATALOG_METHOD) {
            const scoped = method === SCOPED_SKILL_CATALOG_METHOD;
            if (scoped && ((params.threadId !== undefined && (typeof params.threadId !== "string" || !params.threadId))
              || (params.model !== undefined && (typeof params.model !== "string" || !params.model)))) throw new Error("Invalid Skill catalog target");
            const provider = scoped && params.threadId !== undefined
              ? options.providers.find(provider => provider.ownsThread(params.threadId))
              : scoped && params.model !== undefined
                ? options.providers.find(provider => provider.ownsModel(params.model))
                : registry.get(options.defaultEngine);
            // Only the envelope owns routing fields. Native Hosts keep their wire contract.
            const native = { cwds: params.cwds, forceReload: params.forceReload };
            if (provider) { reply(await provider.request("skills/list", {
              ...native, ...(scoped && params.threadId ? { threadId: params.threadId } : {}),
            }, state.owner)); return; }
            if (!options.legacy) throw new Error("Skill catalog execution engine is unavailable");
            reply(await callLegacy("skills/list", native, clientId)); return;
          }
          const provider = typeof params.threadId === "string" ? options.providers.find(provider => provider.ownsThread(params.threadId))
            : typeof params.model === "string" ? options.providers.find(provider => provider.ownsModel(params.model))
            : method === "thread/start" ? registry.get(options.defaultEngine) : undefined;
          if ((method === "model/list" || method === "thread/list") && !params.threadId) {
            const catalog = await singleflight(`${method}:${JSON.stringify(params)}`, async () => {
            const outcomes = await Promise.allSettled([
              ...(options.legacy ? [allLegacy(method, params, clientId).then(data => ({ data: method === "model/list" ? data.map(model => ({ ...model,
                groupKey: `dsh:${model.groupKey ?? "models"}`, groupLabel: `DSH · ${model.groupLabel ?? "Models"}`,
                isDefault: options.defaultEngine === options.legacy?.id && model.isDefault })) : data }))] : []),
              ...options.providers.map(provider => provider.request(method, params, state.owner).then(page => ({ ...page, data: method === "model/list"
                ? page.data.map((model: Value) => ({ ...model, isDefault: provider.id === options.defaultEngine && model.isDefault })) : page.data }))),
            ]);
            const pages = outcomes.flatMap(outcome => outcome.status === "fulfilled" ? [outcome.value] : []);
            if (!pages.length) throw new Error("No execution engine catalog is available");
            const unavailableEngines = outcomes.flatMap((outcome, index) => outcome.status === "rejected" ? [[...(options.legacy ? [options.legacy.id] : []), ...options.providers.map(provider => provider.id)][index]] : []);
            let entries = pages.flatMap(page => page.data);
            if (method === "thread/list") {
              const key = params.sortKey === "updated_at" ? "updatedAt" : "createdAt";
              const direction = params.sortDirection === "asc" ? 1 : -1;
              entries.sort((a,b) => direction * (a[key] - b[key]) || String(a.id).localeCompare(String(b.id)));
            }
            const offset = params.cursor == null ? 0 : /^engines:\d+$/u.test(params.cursor) ? Number(params.cursor.slice(8)) : NaN;
            if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid engine catalog cursor");
            const limit = Math.max(1, Math.min(200, Number(params.limit) || 100));
            return { data: entries.slice(offset, offset + limit), nextCursor: offset + limit < entries.length ? `engines:${offset + limit}` : null, unavailableEngines };
            });
            reply(catalog); return;
          }
          if (provider) {
            if (params.threadId && !["thread/read", "thread/turns/list", "thread/items/list", "thread/goal/get", "thread/queue/list", "thread/unsubscribe", "thread/resume", "opencraft/thread-pins/set", "thread/name/set", "thread/archive", "thread/unarchive", "thread/delete"].includes(method) && !method.startsWith("opencraft/schedules/") && !state.opened.has(params.threadId)) throw new Error("Open the thread before mutating it");
            const watching = method === "thread/read" && params.watch === true && typeof params.threadId === "string";
            const wasReading = state.reading.has(params.threadId);
            if (watching) state.reading.add(params.threadId);
            let result;
            try { result = await provider.request(method, params, state.owner); }
            catch (error) { if (watching && !wasReading) state.reading.delete(params.threadId); throw error; }
            if (["thread/start", "thread/resume", "thread/fork"].includes(method) && result.thread?.id) state.opened.add(result.thread.id);
            if (method === "thread/unsubscribe") { state.opened.delete(params.threadId); state.reading.delete(params.threadId); }
            if (["thread/resume", "thread/start"].includes(method) && result.thread?.status?.type === "active") consumerTurns.set(result.thread.id, "unknown");
            reply(result); return;
          }
          if (params.threadId && options.providers.some(provider => provider.ownsModel(params.model ?? ""))) throw new Error("Create a new conversation to change execution engines");
          if (frame.id === undefined) {
            const connection = await connectBackend();
            if (!stopped && backend === connection && connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(frame));
            return;
          }
          const result = await callLegacy(method, params, clientId);
          if (["thread/resume", "thread/start"].includes(method) && result.thread?.status?.type === "active") consumerTurns.set(result.thread.id, "unknown");
          if (method === "turn/start" && result.turn?.status === "inProgress" && params.threadId) consumerEvent("turn/started", { threadId: params.threadId, turn: result.turn });
          reply(result);
          };
          const dispatch = async () => {
            callbacks++;
            const threadId = typeof frame.params?.threadId === "string" && ["turn/start", "thread/resume"].includes(frame.method) ? frame.params.threadId : undefined;
            if (threadId) pendingConsumerAdmissions.set(threadId, (pendingConsumerAdmissions.get(threadId) ?? 0) + 1);
            try { return await dispatchInner(); }
            finally {
              callbacks--;
              if (threadId) {
                const remaining = pendingConsumerAdmissions.get(threadId)! - 1;
                if (remaining) pendingConsumerAdmissions.set(threadId, remaining);
                else { pendingConsumerAdmissions.delete(threadId); completedConsumerTurns.delete(threadId); }
              }
            }
          };
          await (options.admitRequest ? options.admitRequest(frame.method, dispatch) : dispatch());
        } catch (error) {
          if (frame.id !== undefined) send({ jsonrpc: "2.0", id: frame.id, [LOGICAL_CLIENT_FIELD]: clientId,
            error: error instanceof AppServerRpcError ? { code: error.code, message: error.message, data: error.data }
              : { code: typeof (error as Value)?.code === "number" ? (error as Value).code : -32000, message: error instanceof Error ? error.message : "Engine request failed" } });
        }
      })();
    });
    socket.on("close", stop);
    socket.on("error", () => { stop(); socket.terminate(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    websocketUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/rpc?token=${token}`,
    async coldReadResources() { await resources?.request("project/list", {}); },
    consumerObservation() { return { coverage: unknownConsumer ? "unknown" : "complete", activeCount: callbacks + consumerTurns.size + [...connectionObservations].reduce((n, read) => n + read(), 0) }; },
    get ready() { return [...readiness.values()].every(state => state === "ready"); },
    get storageOutcomes() { return options.providers.flatMap(provider => [...provider.storageOutcomes ?? []]); },
    async close() {
      closing = true;
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      const outcomes = await Promise.allSettled(options.providers.map(provider => provider.close()));
      await resources?.close();
      await (await legacy?.catch(() => undefined))?.close();
      if (options.strictClose) { const failure = outcomes.find(outcome => outcome.status === "rejected"); if (failure?.status === "rejected") throw failure.reason; }
    },
  };
}
