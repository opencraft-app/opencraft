import { ThreadCatalogPublisher } from "@opencraft/app-host-server/thread-catalog";
import { HostInteractions, InteractionFault } from "@opencraft/app-host-server/interactions";
import { SHARED_INTERACTIONS_EXTENSION, SHARED_INTERACTIONS_CHANGED, SHARED_INTERACTIONS_READ, SHARED_INTERACTIONS_RESPOND, isHumanInteraction, type InteractionSourceRequest } from "@opencraft/appserver-protocol";
import { CodexCoreSocket } from "./codex-core-socket";
import { CODEX_MAINTENANCE_READ, CODEX_MAINTENANCE_EXTENSION, CODEX_MAINTENANCE_CAPABILITY, codexAdmissionKey, codexMaintenanceError, isCodexAdmission } from "./codex-maintenance.js";
import { CodexCoreControlClient } from "@opencraft/account-pool-host";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import {
  OPENCRAFT_FIRST_TURN_DURABILITY_CAPABILITY,
  OPENCRAFT_THREAD_START_DURABILITY_EXTENSION,
} from "@opencraft/appserver-protocol";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";

type RpcRecord = Record<string, unknown>;
interface Pending {
  readonly clientId: string;
  readonly originalId: string | number;
  readonly method: string;
  readonly params: RpcRecord;
  readonly subscriptionRevision?: number;
  readonly wasSubscribed?: boolean;
}
const record = (value: unknown): RpcRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RpcRecord : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const idOf = (value: unknown): string | number | null => typeof value === "string" || typeof value === "number" ? value : null;

/** Optional native-core connection. The core, not this bridge, owns accounts and execution lifetime. */
export class CodexCoreBridge implements DuplexTransport {
  private readonly control: CodexCoreControlClient;
  private readonly connection: CodexCoreSocket;
  private readonly messages = new Set<(frame: string) => void>();
  private readonly statuses = new Set<(status: TransportStatus) => void>();
  private readonly catalogChanges = new ThreadCatalogPublisher((method, params) => {
    for (const clientId of this.initialized) this.emit({ method, params }, clientId);
  }, true);
  private readonly pending = new Map<string, Pending>();
  private readonly waiters: Pending[] = [];
  private readonly initialized = new Set<string>();
  private readonly disconnected = new Set<string>();
  private readonly threads = new Map<string, Set<string>>();
  private readonly readers = new Map<string, Set<string>>();
  private readonly confirmedReaders = new Map<string, Set<string>>();
  private readonly confirmedThreads = new Set<string>();
  private canObserve(threadId: string, clientId: string): boolean {
    return this.initialized.has(clientId) && (this.confirmedThreads.has(JSON.stringify([threadId, clientId])) || this.confirmedReaders.get(threadId)?.has(clientId) === true);
  }
  private readonly revisions = new Map<string, number>();
  private readonly serverRequests = new Map<string, string>();
  private readonly human = new HostInteractions();
  private readonly sharedClients = new Set<string>();
  private readonly clientEpochs = new Map<string, number>();
  private readonly removeHuman = this.human.subscribe(threadId => {
    for (const client of new Set([...this.targets(threadId), ...(this.readers.get(threadId) ?? [])])) this.publishHuman(threadId, client);
  });
  private publishHuman(threadId: string, clientId: string): void {
    if (this.sharedClients.has(clientId) && this.canObserve(threadId, clientId)) this.emit({ method: SHARED_INTERACTIONS_CHANGED,
      params: this.human.snapshot(threadId, this.canObserve(threadId, clientId)) }, clientId);
  }

  private sequence = 0;
  private initializeResult: unknown | null = null;
  private initializing = false;

  constructor(endpoint: string, token: string, private readonly maintenance?: () => import("./codex-maintenance.js").CodexMaintenanceSnapshot,
    private readonly rejectedAdmission?: (method: string, params: unknown, clientId: string) => void) {
    this.control = new CodexCoreControlClient(endpoint, token);
    this.connection = new CodexCoreSocket({
      health: signal => this.control.health(signal), message: frame => this.receive(frame),
      status: value => { if (["failed", "closing", "closed"].includes(value.state)) this.human.markSourceUnavailable(); for (const listener of this.statuses) listener(value); },
    });
  }
  get status(): TransportStatus { return this.connection.status; }
  get pendingAdmissionKeys(): string[] { return [...this.pending.values()].filter(request => isCodexAdmission(request.method, request.params))
    .map(request => codexAdmissionKey(request.method, request.params, JSON.stringify([request.clientId, request.originalId]))); }
  get pendingApprovals(): number { return this.serverRequests.size + this.human.size; }
  subscribeMessage(listener: (frame: string) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  subscribeStatus(listener: (status: TransportStatus) => void): () => void { this.statuses.add(listener); return () => this.statuses.delete(listener); }
  private emit(message: RpcRecord, clientId?: string): void {
    const frame = JSON.stringify(clientId ? { ...message, [LOGICAL_CLIENT_FIELD]: clientId } : message);
    for (const listener of this.messages) listener(frame);
  }
  connect(signal?: AbortSignal): Promise<void> { return this.connection.connect(signal); }
  private write(message: RpcRecord): void {
    this.connection.send(JSON.stringify(message));
  }
  async send(frame: string): Promise<void> {
    if (this.connection.status.state !== "open") throw new Error("Codex Engine is not connected");
    const message = record(JSON.parse(frame));
    const clientId = string(message[LOGICAL_CLIENT_FIELD]);
    if (!clientId) throw new Error("Codex Engine requires a logical client identity");
    delete message[LOGICAL_CLIENT_FIELD];
    if (message.method === "runtime/client/disconnect") { this.disconnect(clientId); return; }
    const id = idOf(message.id);
    if (id !== null && (message.method === SHARED_INTERACTIONS_READ || message.method === SHARED_INTERACTIONS_RESPOND)) {
      const p = record(message.params), threadId = string(p.threadId);
      const allowed = () => this.canObserve(threadId, clientId);
      if (!allowed()) { this.emit({ id, error: { code: 403, message: "Conversation subscription required" } }, clientId); return; }
      const epoch = this.clientEpochs.get(clientId);
      try {
        if (message.method === SHARED_INTERACTIONS_READ) { this.emit({ id, result: this.human.snapshot(threadId, true) }, clientId); return; }
        if (!string(p.interactionId) || !string(p.submissionId) || !p.result || typeof p.result !== "object" || Array.isArray(p.result)) throw new Error("Invalid interaction response");
        const disposition = await this.human.respond(threadId, string(p.interactionId), string(p.submissionId), record(p.result), async (source, result) => {
          if (!allowed() || epoch !== this.clientEpochs.get(clientId)) throw new Error("Interaction subscription expired");
          this.write({ id: source.id, result });
        });
        if (allowed() && epoch === this.clientEpochs.get(clientId)) this.emit({ id, result: { disposition, snapshot: this.human.snapshot(threadId, true) } }, clientId);
      } catch (cause) { if (epoch === this.clientEpochs.get(clientId)) this.emit({ id, error: { code: cause instanceof InteractionFault ? cause.rpcCode : -32000, message: cause instanceof Error ? cause.message : "Interaction submission failed" } }, clientId); }
      return;
    }
    if (message.method === CODEX_MAINTENANCE_READ && id !== null) {
      if (!this.initialized.has(clientId)) { this.emit({ id, error: { code: -32600, message: "Client is not initialized" } }, clientId); return; }
      this.emit({ id, result: this.maintenance?.() ?? null }, clientId); return;
    }
    if (isCodexAdmission(message.method, message.params) && this.maintenance?.().paused) {
      this.rejectedAdmission?.(String(message.method), message.params, clientId);
      if (id !== null) this.emit({ id, error: codexMaintenanceError() }, clientId);
      return;
    }
    if (typeof message.method === "string" && message.method.startsWith("opencraft/codex/accounts/") && id !== null) {
      try { this.emit({ id, result: await this.control.accountRequest(message.method, record(message.params)) }, clientId); }
      catch (error) { this.emit({ id, error: { code: -32020, message: error instanceof Error ? error.message : "Codex account operation failed" } }, clientId); }
      return;
    }
    if (message.method === "initialize") {
      if (id === null) throw new Error("Initialize requires an id");
      this.disconnected.delete(clientId); this.initialized.add(clientId);
      this.clientEpochs.set(clientId, ++this.sequence);
      this.sharedClients.delete(clientId);
      if (record(record(record(message.params).capabilities).extensions)[SHARED_INTERACTIONS_EXTENSION]) this.sharedClients.add(clientId);
      if (this.initializeResult !== null) { this.emit({ id, result: this.initializeResult }, clientId); return; }
      const pending = { clientId, originalId: id, method: "initialize", params: record(message.params) };
      if (this.initializing) { this.waiters.push(pending); return; }
      this.initializing = true;
      const physicalId = `opencraft:${++this.sequence}`;
      this.pending.set(physicalId, pending); this.write({ ...message, id: physicalId }); return;
    }
    if (message.method === "initialized") return;
    if (id !== null && typeof message.method !== "string") {
      if (this.human.threadForNative(id) !== null) {
        if (this.initialized.has(clientId) && !this.sharedClients.has(clientId) && this.human.wasOffered(id, clientId) && "result" in message)
          await this.human.respondNative(id, `legacy:${clientId}:${JSON.stringify(id)}`, record(message.result), async (source, result) => { this.write({ id: source.id, result }); });
        return;
      }
      if (this.serverRequests.get(JSON.stringify(id)) !== clientId) return;
      this.serverRequests.delete(JSON.stringify(id)); this.write(message); return;
    }
    if (id !== null && typeof message.method === "string") {
      const params = record(message.params), threadId = string(params.threadId);
      const wasSubscribed = this.threads.get(threadId)?.has(clientId) ?? false;
      let subscriptionRevision: number | undefined;
      if (message.method === "thread/read" && params.watch === true && this.initialized.has(clientId)) {
        let readers = this.readers.get(threadId);
        if (!readers) { readers = new Set(); this.readers.set(threadId, readers); }
        readers.add(clientId); this.publishHuman(threadId, clientId);
      }
      if (message.method === "thread/unsubscribe") {
        this.removeReader(threadId, clientId);
        this.remove(threadId, clientId);
        if (!wasSubscribed || this.threads.has(threadId)) {
          this.emit({ id, result: { status: wasSubscribed ? "unsubscribed" : "notSubscribed" } }, clientId); return;
        }
        subscriptionRevision = this.revisions.get(JSON.stringify([threadId, clientId]));
      } else if (message.method === "thread/resume" || message.method === "turn/start") {
        this.subscribe(threadId, clientId);
        subscriptionRevision = this.revisions.get(JSON.stringify([threadId, clientId]));
      }
      const physicalId = `opencraft:${++this.sequence}`;
      this.pending.set(physicalId, { clientId, originalId: id, method: message.method, params, wasSubscribed, subscriptionRevision });
      this.write({ ...message, id: physicalId }); return;
    }
    this.write(message);
  }
  private receive(line: string): void {
    let message: RpcRecord;
    try { message = record(JSON.parse(line)); } catch { return; }
    delete message.__opencraftGeneration;
    if (message.method === "opencraft/codex/generation/lost") {
      const params = record(message.params), ids = Array.isArray(params.threadIds) ? params.threadIds : [];
      for (const id of ids) if (typeof id === "string") this.human.markSourceUnavailable(id);
      for (const clientId of this.initialized) {
        const threadIds = ids.filter(id => typeof id === "string" && this.threads.get(id)?.has(clientId));
        if (threadIds.length) this.emit({ ...message, params: { ...params, threadIds } }, clientId);
      }
      return;
    }
    const id = idOf(message.id);
    if (id !== null) {
      const pending = this.pending.get(String(id));
      if (pending !== undefined && typeof message.method !== "string") {
        this.pending.delete(String(id));
        if (pending.clientId === "") return;
        if (pending.method === "initialize") {
          this.initializing = false;
          if ("result" in message) {
            const result = record(message.result), capabilities = record(result.capabilities);
            this.initializeResult = { ...result, capabilities: { ...capabilities, extensions: {
              ...record(capabilities.extensions), [SHARED_INTERACTIONS_EXTENSION]: { version: 1 }, "opencraft/read-history": { version: 1, initialTurnsPage: false }, [OPENCRAFT_THREAD_START_DURABILITY_EXTENSION]: OPENCRAFT_FIRST_TURN_DURABILITY_CAPABILITY,
              ...(this.maintenance ? { [CODEX_MAINTENANCE_EXTENSION]: CODEX_MAINTENANCE_CAPABILITY } : {}),
            } } };
            message = { ...message, result: this.initializeResult };
            this.write({ method: "initialized", params: {} });
          }
          for (const waiter of [pending, ...this.waiters.splice(0)]) {
            if (!this.disconnected.has(waiter.clientId)) this.emit({ ...message, id: waiter.originalId }, waiter.clientId);
          }
          return;
        }
        if ("result" in message) this.catalogChanges.observeResult(pending.method, pending.params, message.result);
        if ("result" in message && (pending.method === "thread/start" || pending.method === "thread/fork")) {
          const threadId = string(record(record(message.result).thread).id);
          if (!this.disconnected.has(pending.clientId)) this.subscribe(threadId, pending.clientId, true);
          else if (!this.threads.has(threadId)) this.unsubscribeNative(threadId);
        } else if ("error" in message && pending.subscriptionRevision !== undefined && !this.disconnected.has(pending.clientId)) {
          const threadId = string(pending.params.threadId);
          if (this.revisions.get(JSON.stringify([threadId, pending.clientId])) === pending.subscriptionRevision) {
            if (pending.wasSubscribed) this.subscribe(threadId, pending.clientId);
            else { this.remove(threadId, pending.clientId); if (!this.threads.has(threadId)) this.unsubscribeNative(threadId); }
          }
        }
        if ("result" in message && !this.disconnected.has(pending.clientId)) {
          const threadId = string(pending.params.threadId);
          if (pending.method === "thread/resume" || pending.method === "turn/start") this.subscribe(threadId, pending.clientId, true);
          else if (pending.method === "thread/read" && pending.params.watch === true) {
            const readers = this.confirmedReaders.get(threadId) ?? new Set<string>(); readers.add(pending.clientId); this.confirmedReaders.set(threadId, readers);
            this.publishHuman(threadId, pending.clientId);
          }
        }
        if (!this.disconnected.has(pending.clientId)) this.emit({ ...message, id: pending.originalId }, pending.clientId);
        return;
      }
      if (typeof message.method === "string") {
        const threadId = string(record(message.params).threadId);
        if (threadId && isHumanInteraction(message.method, message.params)) {
          this.human.capture(message as unknown as InteractionSourceRequest);
          for (const viewer of this.targets(threadId)) if (this.canObserve(threadId, viewer) && !this.sharedClients.has(viewer)) this.human.offerLegacy(threadId, viewer, source => this.emit(source as unknown as RpcRecord, viewer));
          return;
        }
        const owner = threadId ? this.targets(threadId)[0] : this.initialized.values().next().value;
        if (owner) { this.serverRequests.set(JSON.stringify(id), owner); this.emit(message, owner); }
      }
      return;
    }
    this.catalogChanges.observeNotification(String(message.method), message.params);
    const threadId = string(record(message.params).threadId) || string(record(record(message.params).thread).id);
    if (message.method === "turn/completed") this.human.resolveTurn(threadId, string(record(record(message.params).turn).id));
    if (message.method === "serverRequest/resolved") {
      const raw = idOf(record(message.params).requestId);
      if (raw !== null) this.human.resolveNative(raw, threadId);
    }
    const targets = threadId ? [...new Set([...this.targets(threadId), ...(this.readers.get(threadId) ?? [])])] : [...this.initialized];
    for (const target of targets) this.emit(message, target);
  }
  private targets(threadId: string): string[] { return [...(this.threads.get(threadId) ?? [])]; }
  private subscribe(threadId: string, clientId: string, confirmed = false): void {
    if (!threadId) return;
    if (confirmed) this.confirmedThreads.add(JSON.stringify([threadId, clientId]));
    this.revisions.set(JSON.stringify([threadId, clientId]), ++this.sequence);
    let clients = this.threads.get(threadId);
    if (!clients) { clients = new Set(); this.threads.set(threadId, clients); }
    clients.add(clientId);
    this.publishHuman(threadId, clientId);
    if (this.confirmedThreads.has(JSON.stringify([threadId, clientId])) && !this.sharedClients.has(clientId)) this.human.offerLegacy(threadId, clientId, source => this.emit(source as unknown as RpcRecord, clientId));
  }
  private remove(threadId: string, clientId: string): void {
    this.confirmedThreads.delete(JSON.stringify([threadId, clientId])); this.human.forgetClient(clientId, threadId);
    this.revisions.set(JSON.stringify([threadId, clientId]), ++this.sequence);
    const clients = this.threads.get(threadId); clients?.delete(clientId);
    if (clients?.size === 0) this.threads.delete(threadId);
  }
  private removeReader(threadId: string, clientId: string): void {
    const confirmed = this.confirmedReaders.get(threadId); confirmed?.delete(clientId); if (confirmed?.size === 0) this.confirmedReaders.delete(threadId);
    const readers = this.readers.get(threadId); readers?.delete(clientId);
    if (readers?.size === 0) this.readers.delete(threadId);
  }
  private disconnect(clientId: string): void {
    this.disconnected.add(clientId); this.initialized.delete(clientId);
    this.sharedClients.delete(clientId); this.clientEpochs.delete(clientId); this.human.forgetClient(clientId);
    for (const threadId of this.readers.keys()) this.removeReader(threadId, clientId);
    for (const [threadId, clients] of this.threads) {
      if (!clients.has(clientId)) continue;
      this.remove(threadId, clientId);
      if (!this.threads.has(threadId)) this.unsubscribeNative(threadId);
    }
    for (const [id, owner] of this.serverRequests) if (owner === clientId) this.serverRequests.delete(id);
  }
  private unsubscribeNative(threadId: string): void {
    if (!threadId) return;
    const id = `opencraft:${++this.sequence}`;
    this.pending.set(id, { clientId: "", originalId: id, method: "thread/unsubscribe", params: { threadId } });
    this.write({ id, method: "thread/unsubscribe", params: { threadId } });
  }
  async close(): Promise<void> {
    if (this.connection.status.state === "closed") return;
    this.catalogChanges.clear();
    this.connection.close();
    this.pending.clear(); this.waiters.length = 0; this.initialized.clear(); this.disconnected.clear();
    this.threads.clear(); this.readers.clear(); this.revisions.clear(); this.serverRequests.clear();
    this.human.clear(); this.removeHuman(); this.sharedClients.clear(); this.clientEpochs.clear(); this.confirmedReaders.clear(); this.confirmedThreads.clear();
  }
}
