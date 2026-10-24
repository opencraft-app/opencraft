import { CodexCoreSocket } from "./codex-core-socket";
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
  private readonly pending = new Map<string, Pending>();
  private readonly waiters: Pending[] = [];
  private readonly initialized = new Set<string>();
  private readonly disconnected = new Set<string>();
  private readonly threads = new Map<string, Set<string>>();
  private readonly revisions = new Map<string, number>();
  private readonly serverRequests = new Map<string, string>();
  private sequence = 0;
  private initializeResult: unknown | null = null;
  private initializing = false;

  constructor(endpoint: string, token: string) {
    this.control = new CodexCoreControlClient(endpoint, token);
    this.connection = new CodexCoreSocket({
      health: signal => this.control.health(signal), message: frame => this.receive(frame),
      status: value => { for (const listener of this.statuses) listener(value); },
    });
  }
  get status(): TransportStatus { return this.connection.status; }
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
    if (typeof message.method === "string" && message.method.startsWith("opencraft/codex/accounts/") && id !== null) {
      try { this.emit({ id, result: await this.control.accountRequest(message.method, record(message.params)) }, clientId); }
      catch (error) { this.emit({ id, error: { code: -32020, message: error instanceof Error ? error.message : "Codex account operation failed" } }, clientId); }
      return;
    }
    if (message.method === "initialize") {
      if (id === null) throw new Error("Initialize requires an id");
      this.disconnected.delete(clientId); this.initialized.add(clientId);
      if (this.initializeResult !== null) { this.emit({ id, result: this.initializeResult }, clientId); return; }
      const pending = { clientId, originalId: id, method: "initialize", params: record(message.params) };
      if (this.initializing) { this.waiters.push(pending); return; }
      this.initializing = true;
      const physicalId = `opencraft:${++this.sequence}`;
      this.pending.set(physicalId, pending); this.write({ ...message, id: physicalId }); return;
    }
    if (message.method === "initialized") return;
    if (id !== null && typeof message.method !== "string") {
      if (this.serverRequests.get(JSON.stringify(id)) !== clientId) return;
      this.serverRequests.delete(JSON.stringify(id)); this.write(message); return;
    }
    if (id !== null && typeof message.method === "string") {
      const params = record(message.params), threadId = string(params.threadId);
      const wasSubscribed = this.threads.get(threadId)?.has(clientId) ?? false;
      let subscriptionRevision: number | undefined;
      if (message.method === "thread/unsubscribe") {
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
              ...record(capabilities.extensions), [OPENCRAFT_THREAD_START_DURABILITY_EXTENSION]: OPENCRAFT_FIRST_TURN_DURABILITY_CAPABILITY,
            } } };
            message = { ...message, result: this.initializeResult };
            this.write({ method: "initialized", params: {} });
          }
          for (const waiter of [pending, ...this.waiters.splice(0)]) {
            if (!this.disconnected.has(waiter.clientId)) this.emit({ ...message, id: waiter.originalId }, waiter.clientId);
          }
          return;
        }
        if ("result" in message && (pending.method === "thread/start" || pending.method === "thread/fork")) {
          const threadId = string(record(record(message.result).thread).id);
          if (!this.disconnected.has(pending.clientId)) this.subscribe(threadId, pending.clientId);
          else if (!this.threads.has(threadId)) this.unsubscribeNative(threadId);
        } else if ("error" in message && pending.subscriptionRevision !== undefined && !this.disconnected.has(pending.clientId)) {
          const threadId = string(pending.params.threadId);
          if (this.revisions.get(JSON.stringify([threadId, pending.clientId])) === pending.subscriptionRevision) {
            if (pending.wasSubscribed) this.subscribe(threadId, pending.clientId);
            else { this.remove(threadId, pending.clientId); if (!this.threads.has(threadId)) this.unsubscribeNative(threadId); }
          }
        }
        if (!this.disconnected.has(pending.clientId)) this.emit({ ...message, id: pending.originalId }, pending.clientId);
        return;
      }
      if (typeof message.method === "string") {
        const threadId = string(record(message.params).threadId);
        const owner = this.targets(threadId)[0] ?? this.initialized.values().next().value;
        if (owner) { this.serverRequests.set(JSON.stringify(id), owner); this.emit(message, owner); }
      }
      return;
    }
    const threadId = string(record(message.params).threadId) || string(record(record(message.params).thread).id);
    const targets = threadId ? this.targets(threadId) : [...this.initialized];
    for (const target of targets) this.emit(message, target);
  }
  private targets(threadId: string): string[] { return [...(this.threads.get(threadId) ?? [])]; }
  private subscribe(threadId: string, clientId: string): void {
    if (!threadId) return;
    this.revisions.set(JSON.stringify([threadId, clientId]), ++this.sequence);
    let clients = this.threads.get(threadId);
    if (!clients) { clients = new Set(); this.threads.set(threadId, clients); }
    clients.add(clientId);
  }
  private remove(threadId: string, clientId: string): void {
    this.revisions.set(JSON.stringify([threadId, clientId]), ++this.sequence);
    const clients = this.threads.get(threadId); clients?.delete(clientId);
    if (clients?.size === 0) this.threads.delete(threadId);
  }
  private disconnect(clientId: string): void {
    this.disconnected.add(clientId); this.initialized.delete(clientId);
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
    this.connection.close();
    this.pending.clear(); this.waiters.length = 0; this.initialized.clear(); this.disconnected.clear();
    this.threads.clear(); this.revisions.clear(); this.serverRequests.clear();
  }
}
