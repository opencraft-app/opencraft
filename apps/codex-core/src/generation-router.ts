import { randomUUID } from "node:crypto";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { CodexAppServerHealth, CodexGenerationFenceState } from "@opencraft/account-pool-host";
import { CodexGenerationRegistry, type GenerationRecord, type GenerationTicket } from "./generation-registry.js";
import { GenerationPeer, NativeGenerationError, rpcRecord, type RpcRecord } from "./generation-peer.js";
import { generationThreadPath } from "./generation-thread-path.js";
import { removeStaleSocket } from "./native-process.js";

const text = (value: unknown) => typeof value === "string" ? value : "";
const error = (message: string, retryable = false) => new NativeGenerationError({ code: -32080, message, data: { retryable } });
const threadId = (message: RpcRecord) => text(rpcRecord(message.params).threadId) || text(rpcRecord(rpcRecord(message.params).thread).id);
const epochSensitiveRead = (method: string) => /(?:\/(?:read|list|get)|^(?:getAuthStatus|getConversationSummary|gitDiffToRemote|fuzzyFileSearch))$/u.test(method);
const missingThread = (reason: unknown) => reason instanceof NativeGenerationError && /(?:thread|rollout).*(?:not found|does not exist)|no rollout|unknown thread/iu.test(reason.message);

export interface GenerationRuntimeDirectory {
  readonly registry: CodexGenerationRegistry;
  ensure(id: string): Promise<CodexAppServerHealth>;
  /** Synchronous admission fence; returned release covers the full native RPC. */
  admit(ticket: GenerationTicket): () => void;
  fences?(includeRoutes?: boolean): CodexGenerationFenceState;
  observe(generation: GenerationRecord, message: RpcRecord): void;
}

/** Native JSON-RPC facade; every live connection has its own native subscriptions. */
export class CodexGenerationRouter {
  private readonly sessions = new Set<RoutingSession>();
  constructor(readonly runtime: GenerationRuntimeDirectory) {}
  attach(socket: WebSocket, callbackLaneId?: string): void {
    const session = new RoutingSession(this, socket, callbackLaneId);
    this.sessions.add(session); socket.once("close", () => { this.sessions.delete(session); session.close(); });
  }
  routesUpdated(): void { for (const session of this.sessions) session.flushStarts(); }
  serverRequestCount(id: string): number { return [...this.sessions].reduce((n, s) => n + s.serverRequestCount(id), 0); }
  close(): void { for (const s of this.sessions) s.close(); this.sessions.clear(); }
}

class RoutingSession {
  private readonly epoch = randomUUID();
  private readonly peers = new Map<string, { incarnation: number; operation: Promise<{ peer: GenerationPeer; result: RpcRecord; supportsOrchestration?:boolean }> }>();
  private readonly serverRequests = new Map<string, { operation: Promise<{ peer: GenerationPeer; result: RpcRecord; supportsOrchestration?:boolean }>; nativeId: unknown; ticket: GenerationTicket; answered: boolean }>();
  private readonly pendingStarts = new Map<string, () => void>();
  private readonly commands = new Map<string, { ticket: GenerationTicket; active: boolean }>();
  private readonly processes = new Map<string, { ticket: GenerationTicket; active: boolean; pending: boolean }>();
  private initializeParams: RpcRecord | null = null;
  private initialized = false;
  private closed = false;
  constructor(private readonly router: CodexGenerationRouter, private readonly socket: WebSocket, private readonly callbackLaneId?: string) {
    socket.on("error", () => this.close());
    socket.on("message", frame => {
      let message: RpcRecord;
      try { message = rpcRecord(JSON.parse(String(frame))); } catch { socket.close(1002); return; }
      void this.receive(message).catch(reason => {
        if (message.id !== undefined) this.emit({ id: message.id, error: reason instanceof NativeGenerationError ? reason.rpcError
          : { code: -32081, message: "Generation routing unavailable; delivery is unconfirmed", data: { resultUnknown: true } } });
      });
    });
  }
  private get registry() { return this.router.runtime.registry; }
  private emit(message: RpcRecord): void { if (!this.closed && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  private async peer(id: string): Promise<{ peer: GenerationPeer; result: RpcRecord; supportsOrchestration?:boolean }> {
    const health = await this.router.runtime.ensure(id), generation = this.registry.get(id)!;
    const existing = this.peers.get(id);
    if (existing?.incarnation === generation.incarnation) return existing.operation;
    if (existing) {
      this.releaseIncarnation(id, existing.incarnation);
      this.generationLost(id, existing.incarnation, `replaced:${existing.incarnation}`, generation.incarnation);
      void existing.operation.then(value => value.peer.close()).catch(() => {});
    }
    const incarnation = generation.incarnation;
    let connectionEpoch = "starting";
    const forward = (message: RpcRecord) => {
        const live = this.registry.get(id);
        if (this.closed || !live || live.incarnation !== incarnation || live.state === "retired") return;
        const nativeParams = rpcRecord(message.params), processHandle = text(nativeParams.processHandle), processId = text(nativeParams.processId);
        if (message.method === "command/exec/outputDelta") {
          const command = this.commands.get(processId);
          if (!command?.active || command.ticket.generationId !== id || command.ticket.incarnation !== incarnation) return;
        }
        if (message.method === "serverRequest/resolved") {
          const entry = [...this.serverRequests].find(([, request]) => request.operation === operation && request.nativeId === nativeParams.requestId);
          if (!entry) return;
          this.serverRequests.delete(entry[0]); message = { ...message, params: { ...nativeParams, requestId: entry[0] } };
        }
        const process = processHandle ? this.processes.get(processHandle) : undefined;
        if (processHandle && (!process || process.ticket.generationId !== id || process.ticket.incarnation !== incarnation)) return;
        if (message.method === "process/exited" && process) process.active = false;
        const tid = threadId(message);
        if (tid && !this.registry.route(tid) && message.method === "thread/started" && this.registry.unresolvedCreations(id)) {
          this.pendingStarts.set(tid, () => forward(message)); return;
        }
        let ticket: GenerationTicket;
        try {
          ticket = tid ? this.registry.discover(tid, id) : { ownerEpoch: this.registry.ownerEpoch, generationId: id, incarnation, admissionEpoch: this.registry.epoch() };
        } catch { this.socket.close(1011); return; }
        if (!this.registry.valid(ticket)) return;
        if (tid && rpcRecord(nativeParams.thread).ephemeral === true) this.registry.markNonpersistent(tid, "ephemeral");
        if (tid && message.method === "thread/deleted") this.registry.markNonpersistent(tid, "deleted");
        this.router.routesUpdated();
        this.router.runtime.observe(live, message);
        if (message.id !== undefined && typeof message.method === "string") {
          // A producer may replay a still-live request during Resume. Keep one
          // mapping until its native resolution; ID reuse after resolution gets
          // a fresh public identity, so stale responses cannot answer it.
          const liveRequest = [...this.serverRequests].find(([, request]) => request.operation === operation && request.nativeId === message.id);
          const key = liveRequest?.[0] ?? `ocg:${this.epoch}:${randomUUID()}`;
          if (!liveRequest) this.serverRequests.set(key, { operation, nativeId: message.id, ticket, answered: false });
          this.emit({ ...message, id: key });
        } else this.emit({ ...message, __opencraftGeneration: { routingEpoch: this.registry.ownerEpoch, generationId: id,
          incarnation, admissionEpoch: ticket.admissionEpoch, threadId: tid } });
    };
    const operation = GenerationPeer.open(health.nativeSocket, this.initializeParams!, {
      message: forward,
      disconnected: () => {
        if (this.closed) return;
        if (this.peers.get(id)?.operation !== operation) return;
        this.peers.delete(id);
        const live = this.registry.get(id);
        if (live && live.incarnation !== incarnation) { this.releaseIncarnation(id, incarnation); this.generationLost(id, incarnation, connectionEpoch, live.incarnation); return; }
        if (live && ["retiring", "retired"].includes(live.state)) return;
        // Process handles are leases of this native connection, not durable tasks.
        for (const command of this.commands.values()) if (command.ticket.generationId === id && command.ticket.incarnation === incarnation) command.active = false;
        for (const process of this.processes.values()) if (process.ticket.generationId === id && process.ticket.incarnation === incarnation) { process.active = false; process.pending = false; }
        for (const [key, request] of this.serverRequests) if (request.ticket.generationId === id) {
          this.serverRequests.delete(key);
          this.emit({ method: "serverRequest/resolved", params: { threadId: request.ticket.threadId ?? "", requestId: key } });
        }
        this.generationLost(id, incarnation, connectionEpoch, incarnation);
      },
    }, health.callbackProtocolVersion === 1 ? this.callbackLaneId : undefined).then(value=>({...value,supportsOrchestration:health.callbackProtocolVersion===1}));
    void operation.then(value => { connectionEpoch = value.peer.connectionEpoch; }).catch(() => {});
    this.peers.set(id, { incarnation, operation });
    try { return await operation; }
    catch (reason) { if (this.peers.get(id)?.operation === operation) this.peers.delete(id); throw reason; }
  }
  private async findThread(id: string): Promise<GenerationTicket> {
    const known = this.registry.route(id);
    if (known) {
      if (this.registry.isNonpersistent(id) && this.registry.get(known.generationId)?.state === "retired") throw error("Nonpersistent Thread is no longer available");
      await this.router.runtime.ensure(known.generationId); return this.registry.route(id)!;
    }
    const matches: string[] = [];
    for (const generation of this.registry.list()) {
      if (["candidate", "discarded", "retiring"].includes(generation.state)) continue;
      const { peer } = await this.peer(generation.id);
      try { await peer.call("thread/read", { threadId: id, includeTurns: false }); matches.push(generation.id); }
      catch (reason) { if (!missingThread(reason)) throw reason; }
    }
    if (matches.length !== 1) throw error(matches.length ? "Thread identity is ambiguous across generations" : "Thread was not found in any generation");
    const route = this.registry.discover(id, matches[0]!); this.router.routesUpdated(); return route;
  }
  private async receive(message: RpcRecord): Promise<void> {
    const received = performance.now();
    const method = text(message.method), params = rpcRecord(message.params), id = message.id;
    if (method === "initialize") {
      if (id === undefined || this.initializeParams !== null) throw error("Routing connection is already initialized");
      this.initializeParams = params;
      const epoch = this.registry.epoch(), current = this.registry.current();
      const { result } = await this.peer(current.generation.id);
      if (epoch !== this.registry.epoch()) throw error("Generation admission changed during initialization; reconnect", true);
      this.initialized = true;
      this.emit({ id, result: { ...result, capabilities: { ...rpcRecord(result.capabilities), extensions: {
        ...rpcRecord(rpcRecord(result.capabilities).extensions), "opencraft.codex-generations": { version: 1 },
      } } }, __opencraftGeneration: { routingEpoch: this.registry.ownerEpoch, fences: this.router.runtime.fences?.(true) } }); return;
    }
    if (!this.initialized) throw error("Routing connection is not initialized");
    if (method === "initialized") return;
    if (!method && id !== undefined) {
      const pending = this.serverRequests.get(String(id));
      if (!pending || pending.answered) return;
      if (this.registry.valid(pending.ticket)) { pending.answered = true; (await pending.operation).peer.notify({ ...message, id: pending.nativeId }); }
      return;
    }
    if (method === "opencraft/orchestration/ack") {
      const operationId = text(params.operationId), creationId = text(params.creationOperationId) || operationId;
      if (operationId !== creationId && operationId !== `${creationId}:title`) throw error("Invalid orchestration acknowledgement");
      let ticket:GenerationTicket|null;try{ticket = this.registry.creationTicket(creationId,true);}catch{this.emit({id,result:{acknowledged:true}});return;}
      if (!ticket || !this.registry.valid(ticket)) { this.emit({ id, result: { acknowledged: true } }); return; }
      const { peer } = await this.peer(ticket.generationId);
      this.emit({ id, result: await peer.call(method, params) }); return;
    }
    if (method === "thread/list") { this.emit({ id, result: await this.listThreads(params) }); return; }
    if (method === "thread/loaded/list") {
      const data = new Set<string>();
      for (const generation of this.registry.list().filter(value => !["retired", "retiring", "candidate", "discarded"].includes(value.state))) {
        const { peer } = await this.peer(generation.id), result = rpcRecord(await peer.call(method, params));
        if (!Array.isArray(result.data) || !result.data.every(v => typeof v === "string")) throw error("Invalid native loaded Thread list");
        for (const tid of result.data as string[]) { this.registry.discover(tid, generation.id); data.add(tid); }
      }
      this.emit({ id, result: { data: [...data] } }); return;
    }
    const processId = text(params.processId), executing = method === "command/exec";
    let command = processId ? this.commands.get(processId) : undefined;
    if (executing && command?.active) throw error("Command process ID is already active on this connection");
    if (!executing && method.startsWith("command/exec/") && !command?.active) throw error("Command process ID is not active on this connection");
    const processHandle = text(params.processHandle), spawning = method === "process/spawn";
    let process = processHandle ? this.processes.get(processHandle) : undefined;
    if (spawning && (!processHandle || process?.active)) throw error("Process handle is missing or already active on this connection");
    if (!spawning && method.startsWith("process/") && (!process || process.pending || !process.active)) throw error("Process handle is not ready on this connection", true);
    let tid = text(params.threadId);
    if (method === "thread/resume" || method === "thread/fork") {
      if (params.history !== null && params.history !== undefined) throw error("History-based Thread import is unavailable through generation routing");
      if (text(params.path)) {
        try { tid = await generationThreadPath(this.registry, text(params.path), tid); }
        catch { throw error("Thread path and identity disagree, or the path is outside a registered HOME"); }
        params.threadId = tid; this.router.routesUpdated();
      }
    }
    const existing = tid ? await this.findThread(tid) : null;
    const creation = method === "thread/start" || method === "thread/fork";
    const delegatedSource=text(params.__opencraftOrchestrationSourceThreadId);
    if(delegatedSource&&(!text(params.__opencraftOrchestrationOperation)||method!=='thread/start'||!text(params.__opencraftOrchestrationIncarnation)))throw error('Trusted source callback identity is required');
    const source=delegatedSource?await this.findThread(delegatedSource):null;
    const ticket = creation ? this.registry.acceptCreation(source?.generationId??existing?.generationId, text(params.__opencraftOrchestrationOperation) || undefined)
      : existing ?? (command && !executing ? command.ticket : null) ?? (process && !spawning ? process.ticket : null) ?? { ownerEpoch: this.registry.ownerEpoch, generationId: this.registry.current().generation.id,
        incarnation: this.registry.current().generation.incarnation, admissionEpoch: this.registry.epoch() };
    if (executing && processId) { command = { ticket, active: true }; this.commands.set(processId, command); }
    if (spawning) { process = { ticket, active: true, pending: true }; this.processes.set(processHandle, process); }
    let release: (() => void) | undefined, sent = false;
    try {
      const { peer, supportsOrchestration } = await this.peer(ticket.generationId);
      if(!supportsOrchestration){
        if(params.__opencraftOrchestrationOperation)throw error('This Engine Host does not support orchestration replay');
        delete params.__opencraftDelegationId;
        if(Array.isArray(params.dynamicTools))params.dynamicTools=params.dynamicTools.filter(tool=>!['thread_spawn','thread_tell','thread_inspect','thread_wait'].includes(text(rpcRecord(tool).name)));
      }
      release = this.router.runtime.admit(ticket);
      if (id === undefined) { peer.notify(message); return; }
      const nativeStarted = performance.now();
      let result: unknown;
      try { result = await peer.call(method, params, () => { sent = true; if (creation) this.registry.markSent(ticket); }, null); }
      finally {
        if (["thread/read", "thread/turns/list", "thread/items/list"].includes(method)
          && typeof id === "string" && /^opencraft:host:\d{1,16}$/u.test(id)) {
          console.info("[history-route-stages]", JSON.stringify({ requestId: id, method,
            routeReadyMs: nativeStarted - received, nativeRpcMs: performance.now() - nativeStarted }));
        }
      }
      if (executing && command) command.active = false;
      if (spawning && process) process.pending = false;
      if (!this.registry.valid(ticket)) throw error("Stale generation response discarded");
      if (!creation && !tid && !processHandle && !processId && epochSensitiveRead(method) && ticket.admissionEpoch !== this.registry.epoch()) throw error("Generation admission changed; response discarded", true);
      const value = rpcRecord(result), thread = rpcRecord(value.thread), returnedThreadId = text(thread.id);
      if (tid && returnedThreadId && returnedThreadId !== tid && !creation) throw error("Native response returned a different Thread identity");
      const returnedTurnId = text(rpcRecord(value.turn).id);
      if (params.turnId && returnedTurnId && params.turnId !== returnedTurnId) throw error("Native response returned a different Turn identity");
      if (creation) {
        if (!returnedThreadId) throw error("Native creation did not return a Thread identity");
        this.registry.resolveCreation(ticket, returnedThreadId, thread.ephemeral === true || params.ephemeral === true); this.router.routesUpdated();
      }
      if (method === "thread/delete" && tid) this.registry.markNonpersistent(tid, "deleted");
      this.router.runtime.observe(this.registry.get(ticket.generationId)!, { method, params, result });
      this.emit({ id, result, __opencraftGeneration: { routingEpoch: this.registry.ownerEpoch, generationId: ticket.generationId,
        incarnation: ticket.incarnation, admissionEpoch: ticket.admissionEpoch, threadId: returnedThreadId || tid } });
    } catch (reason) {
      if (executing && command && (!sent || (reason instanceof NativeGenerationError && reason.nativeRejection))) command.active = false;
      if (spawning && (!sent || (reason instanceof NativeGenerationError && reason.nativeRejection))) this.processes.delete(processHandle);
      if (creation) {
        if (reason instanceof NativeGenerationError && reason.nativeRejection && !rpcRecord(reason.rpcError.data).resultUnknown) this.registry.resolveRejectedCreation(ticket);
        else this.registry.rejectUnsent(ticket);
      }
      throw reason;
    } finally { release?.(); }
  }
  private readonly cursors = new Map<string, { epoch: number; params: RpcRecord; queues: Map<string, { data: RpcRecord[]; next: string | null; fetched: boolean }>; seen: Set<string>; touched: number }>();
  private async listThreads(params: RpcRecord): Promise<RpcRecord> {
    const cursor = text(params.cursor);
    let state = cursor ? this.cursors.get(cursor) : undefined;
    if (cursor && (!state || state.epoch !== this.registry.epoch())) throw error("Directory cursor expired; restart the list", true);
    for (const [key, value] of this.cursors) if (Date.now() - value.touched > 300_000) this.cursors.delete(key);
    if (!state) {
      const { cursor: _cursor, ...filters } = params;
      state = { epoch: this.registry.epoch(), params: filters, seen: new Set(), touched: Date.now(),
        queues: new Map(this.registry.list().filter(g => !["candidate", "discarded", "retiring"].includes(g.state)).map(g => [g.id, { data: [], next: null, fetched: false }])) };
    }
    const limit = params.limit === undefined ? 100 : Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1) throw error("Invalid directory page size");
    const data: RpcRecord[] = [], descending = params.sortDirection !== "asc";
    const sortKey = params.sortKey === "created_at" ? "createdAt" : "updatedAt";
    while (data.length < limit) {
      for (const [generationId, queue] of state.queues) {
        while (!queue.data.length && (!queue.fetched || queue.next !== null)) {
          const { peer } = await this.peer(generationId);
          const page = rpcRecord(await peer.call("thread/list", { ...state.params, limit, ...(queue.next ? { cursor: queue.next } : {}) }));
          if (!Array.isArray(page.data)) throw error("Invalid native Thread directory");
          const before = queue.next; queue.data = page.data.map(rpcRecord); queue.next = typeof page.nextCursor === "string" ? page.nextCursor : null;
          if (queue.fetched && queue.next !== null && before === queue.next) throw error("Native directory cursor did not advance");
          queue.fetched = true;
          for (const row of queue.data) this.registry.discover(text(row.id), generationId);
          this.router.routesUpdated();
        }
      }
      const heads = [...state.queues.entries()].filter(([, q]) => q.data.length);
      if (!heads.length) break;
      heads.sort((a, b) => {
        const delta = Number(a[1].data[0]![sortKey] ?? 0) - Number(b[1].data[0]![sortKey] ?? 0);
        return (descending ? -delta : delta) || text(a[1].data[0]!.id).localeCompare(text(b[1].data[0]!.id));
      });
      const row = heads[0]![1].data.shift()!, tid = text(row.id);
      if (!state.seen.has(tid)) { state.seen.add(tid); data.push(row); }
    }
    if (state.epoch !== this.registry.epoch()) throw error("Generation admission changed during directory read", true);
    if (cursor) this.cursors.delete(cursor);
    const more = [...state.queues.values()].some(q => q.data.length || q.next !== null || !q.fetched), nextCursor = more ? `ocg-directory:${randomUUID()}` : null;
    if (nextCursor) { state.touched = Date.now(); this.cursors.set(nextCursor, state); }
    return { data, nextCursor };
  }
  private generationLost(id: string, incarnation: number, connectionEpoch: string, currentIncarnation: number): void {
    this.emit({ method: "opencraft/codex/generation/lost", params: { generationId: id, incarnation, connectionEpoch, threadIds: this.registry.threadIds(id) },
      __opencraftGeneration: { routingEpoch: this.registry.ownerEpoch, generationId: id, incarnation: currentIncarnation } });
  }
  private releaseIncarnation(id: string, incarnation: number): void {
    for (const process of this.processes.values()) if (process.ticket.generationId === id && process.ticket.incarnation === incarnation) { process.active = false; process.pending = false; }
    for (const command of this.commands.values()) if (command.ticket.generationId === id && command.ticket.incarnation === incarnation) command.active = false;
    for (const [key, request] of this.serverRequests) if (request.ticket.generationId === id && request.ticket.incarnation === incarnation) {
      this.serverRequests.delete(key); this.emit({ method: "serverRequest/resolved", params: { threadId: request.ticket.threadId ?? "", requestId: key } });
    }
  }
  flushStarts(): void {
    for (const [id, forward] of this.pendingStarts) if (this.registry.route(id)) { this.pendingStarts.delete(id); forward(); }
  }
  serverRequestCount(generationId: string): number { return [...this.serverRequests.values()].filter(value => value.ticket.generationId === generationId).length + [...this.commands.values()].filter(value => value.active && value.ticket.generationId === generationId).length + [...this.processes.values()].filter(value => value.active && value.ticket.generationId === generationId).length; }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const pending of this.peers.values()) void pending.operation.then(value => value.peer.close()).catch(() => {});
    this.peers.clear(); this.serverRequests.clear(); this.pendingStarts.clear(); this.processes.clear(); this.commands.clear(); this.cursors.clear(); this.socket.terminate();
  }
}

export async function startGenerationSocket(path: string, router: CodexGenerationRouter) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (((await stat(dirname(path))).mode & 0o077) !== 0) throw new Error("Routing socket directory must be private");
  await removeStaleSocket(path);
  const server = createServer(), sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, request) => {
    const lane = new URL(request.url ?? "/", "http://local.invalid").searchParams.get("opencraftLane");
    if (lane !== null && !/^[a-zA-Z0-9:_-]{1,256}$/u.test(lane)) { socket.close(1008); return; }
    router.attach(socket, lane ?? undefined);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { server.off("error", reject); resolve(); }); });
  await chmod(path, 0o600);
  return { async close() { router.close(); sockets.close(); await new Promise<void>(resolve => server.close(() => resolve())); await unlink(path).catch(() => {}); } };
}
