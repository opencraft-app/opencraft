import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { JsonRpcAppServerClient, type AppServerClient, type TransportSubmissionContext } from "@opencraft/appserver-client";
import { WebSocketTransport, type AppServerWebSocket } from "@opencraft/appserver-transport-websocket";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { OPENCRAFT_METHOD_ACCESS_EXTENSION } from "@opencraft/appserver-protocol";
import { ThreadIdentityDatabase } from "./thread-identity-database.js";
import { ThreadIdentity, assertSubmissionIdentity, identityRecord as record, readThreadMessageIds, type IdentityRecord, type ThreadMetadataFactory } from "./thread-identity.js";

const clientId = (message: IdentityRecord): string => typeof message[LOGICAL_CLIENT_FIELD] === "string" ? message[LOGICAL_CLIENT_FIELD] as string : "";
const requestKey = (message: IdentityRecord): string => JSON.stringify([clientId(message), typeof message.id, message.id]);
const mutations = new Set(["thread/start", "thread/fork", "turn/start", "turn/steer", "thread/queue/add"]);
const submissions = new Set(["turn/start", "turn/steer", "thread/queue/add"]);

/** Hub-side overlay for a native AppServer socket. Does not open or restart engine stores. */
export class AppServerIdentityOverlay {
  readonly store: ThreadIdentityDatabase;
  readonly identity: ThreadIdentity;
  private readonly sessions = new Set<IdentitySocketSession>();
  private reader: AppServerClient | null = null;
  private readerTarget: string | null = null;
  private reading: Promise<AppServerClient> | null = null;
  private closed = false;
  constructor(readonly options: { directory: string; resolveTarget(): Promise<string>; createMetadata: ThreadMetadataFactory }) {
    this.store = new ThreadIdentityDatabase(options.directory);
    try {
      this.identity = new ThreadIdentity(this.store.database, {
        createMetadata: options.createMetadata,
        readMessageIds: (threadId, turnId, signal) => readThreadMessageIds(async (method, params, signal) => {
          const reader = await this.historyReader();
          return reader.requestRaw(method, params, { signal });
        }, threadId, turnId, signal),
        notify: (method, params) => {
          if (!this.closed) for (const session of this.sessions) session.notify(method, params);
        },
      });
    } catch (error) { this.store.close(); throw error; }
  }
  private historyReader(): Promise<AppServerClient> {
    if (this.closed) return Promise.reject(new Error("Thread identity overlay closed"));
    if (this.reading) return this.reading;
    const job = (async () => {
      const target = await this.options.resolveTarget();
      if (this.closed) throw new Error("Thread identity overlay closed");
      if (!this.reader || target !== this.readerTarget) {
        await this.reader?.close();
        const transport = new WebSocketTransport({ url: target, createSocket: url => new WebSocket(url) as unknown as AppServerWebSocket });
        this.reader = new JsonRpcAppServerClient({ hostId: "hub-thread-identity", transport, requestTimeoutMs: 5000 });
        this.readerTarget = target;
      }
      const reader = this.reader;
      await reader.connect({ clientInfo: { name: "opencraft-thread-identity", title: null, version: "1" }, capabilities: { experimentalApi: true } });
      if (this.closed) throw new Error("Thread identity overlay closed");
      return reader;
    })();
    this.reading = job;
    void job.finally(() => { if (this.reading === job) this.reading = null; }).catch(() => {});
    return job;
  }
  open(emit: (frame: string) => void): IdentitySocketSession {
    if (this.closed) throw new Error("Thread identity overlay closed");
    const session = new IdentitySocketSession(this.identity, emit, () => this.sessions.delete(session));
    this.sessions.add(session); return session;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const session of [...this.sessions]) session.close();
    this.identity.close();
    await this.reader?.close();
    await this.reading?.catch(() => {});
    this.store.close();
  }
}

/** Request receipts and handshake state belong to one socket and logical-client epoch. */
class IdentitySocketSession {
  private readonly pending = new Map<string, { method: string; params: IdentityRecord; sender: TransportSubmissionContext["sender"]; created: number;
    original: IdentityRecord; key: string; client: string; epoch: number }>();
  private readonly originals = new Map<string, string>();
  private readonly epochs = new Map<string, number>();
  private readonly prefix = `hub-identity:${randomUUID()}:`;
  private sequence = 0;
  private readonly initialized = new Set<string>();
  private closed = false;
  constructor(readonly identity: ThreadIdentity, readonly emit: (frame: string) => void, readonly dispose: () => void) {}
  private reply(message: IdentityRecord, packet: IdentityRecord): void {
    if (!this.closed) this.emit(JSON.stringify({ ...packet, ...(clientId(message) ? { [LOGICAL_CLIENT_FIELD]: clientId(message) } : {}) }));
  }
  toNative(frame: string, context: TransportSubmissionContext): string | null {
    if (this.closed) return null;
    let message: IdentityRecord;
    try { message = record(JSON.parse(frame)); } catch { return frame; }
    if (message.method === "runtime/client/disconnect") {
      const client = clientId(message);
      this.initialized.delete(client);
      this.epochs.set(client, (this.epochs.get(client) ?? 0) + 1);
      for (const receipt of this.pending.values()) if (receipt.client === client) this.originals.delete(receipt.key);
      return frame;
    }
    if (typeof message.method !== "string" || !(typeof message.id === "string" || typeof message.id === "number")) return frame;
    const method = message.method, params = record(message.params), key = requestKey(message);
    const error = (reason: string, code = -32602) => { this.reply(message, { id: message.id, error: { code, message: reason } }); return null; };
    if (this.identity.metadata?.supports(method)) {
      if (!this.initialized.has(clientId(message))) return error("Initialize before reading thread metadata", -32002);
      const epoch = this.epochs.get(clientId(message)) ?? 0;
      void this.identity.metadata.request(method, params).then(result => {
        if (epoch === (this.epochs.get(clientId(message)) ?? 0)) this.reply(message, { id: message.id, result });
      }, () => {
        if (epoch === (this.epochs.get(clientId(message)) ?? 0)) error("Thread metadata request failed", -32603);
      });
      return null;
    }
    if (mutations.has(method) && !this.initialized.has(clientId(message))) return error("Initialize before submitting", -32002);
    try {
      if (mutations.has(method)) assertSubmissionIdentity(context);
      for (const [id, request] of this.pending) if (Date.now() - request.created > 300_000) {
        this.pending.delete(id);
        if (this.originals.get(request.key) === id) this.originals.delete(request.key);
      }
      if (this.originals.has(key) || this.pending.size >= 256) return error("Too many pending or duplicate AppServer requests");
      if (submissions.has(method)) this.identity.recordSubmission(params, context);
      const id = this.prefix + ++this.sequence;
      this.pending.set(id, { method, params, sender: context.sender, created: Date.now(), original: message,
        key, client: clientId(message), epoch: this.epochs.get(clientId(message)) ?? 0 });
      this.originals.set(key, id);
      if (mutations.has(method)) {
        const { sender: _sender, creator: _creator, participants: _participants, ...native } = params;
        return JSON.stringify({ ...message, id, params: native });
      }
      return JSON.stringify({ ...message, id });
    } catch (failure) { return error(failure instanceof Error ? failure.message : "Invalid submission identity"); }
  }
  fromNative(frame: string): string | null {
    if (this.closed) return null;
    let message: IdentityRecord;
    try { message = record(JSON.parse(frame)); } catch { return frame; }
    if (typeof message.method === "string") {
      this.identity.observeNotification(message);
      return JSON.stringify(this.identity.projectNotification(message));
    }
    const id = String(message.id), pending = this.pending.get(id);
    if (!pending) return id.startsWith(this.prefix) ? null : frame;
    this.pending.delete(id);
    if (this.originals.get(pending.key) === id) this.originals.delete(pending.key);
    const current = pending.epoch === (this.epochs.get(pending.client) ?? 0);
    const reply = { ...message, id: pending.original.id,
      ...(pending.client ? { [LOGICAL_CLIENT_FIELD]: pending.client } : {}) };
    if (!("result" in message)) return current ? JSON.stringify(reply) : null;
    if (pending.method === "initialize") {
      if (!current) return null;
      this.initialized.add(pending.client);
      const value = record(message.result), capabilities = record(value.capabilities), extensions = record(capabilities.extensions);
      const access = record(extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION]);
      return JSON.stringify({ ...reply, result: { ...value, capabilities: { ...capabilities,
        extensions: { ...extensions, ...this.identity.metadata?.capabilities,
          ...(Array.isArray(access.methods) ? { [OPENCRAFT_METHOD_ACCESS_EXTENSION]: { ...access,
            methods: [...new Set([...access.methods, ...(this.identity.metadata?.methods ?? [])])] } } : {}) } } } });
    }
    this.identity.observeResult(pending.method, pending.params, message.result,
      ["thread/start", "thread/fork"].includes(pending.method) ? pending.sender : undefined);
    return current ? JSON.stringify({ ...reply, result: this.identity.projectResult(pending.method, pending.params, message.result) }) : null;
  }
  notify(method: string, params: IdentityRecord): void {
    for (const id of this.initialized) this.reply({ [LOGICAL_CLIENT_FIELD]: id }, { method, params });
  }
  close(): void { this.closed = true; this.pending.clear(); this.originals.clear(); this.initialized.clear(); this.dispose(); }
}
