import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import type WebSocket from "ws";
import type { RawData } from "ws";
import type { HostDesktopCredential, HostDesktopCapability } from "@opencraft/appserver-protocol/desktop";
import type { NativeObserver } from "./native-observer.js";
import type { NativeDesktopControl, NativeControlLease } from "./native-control.js";
import { RfbInputDecoder } from "./rfb-input-decoder.js";

export interface LocalDesktopThread {
  readonly id: string;
  readonly path: string;
  readonly createdAt: number;
}
export interface LocalDesktopOwner {
  /** Server-created logical Client epoch; never a request parameter. */
  readonly key: string;
  isCurrent(): boolean;
  /** The actual engine's metadata-only Thread read, not a renderer catalog. */
  readThread(threadId: string): Promise<LocalDesktopThread>;
}
interface Attachment {
  readonly credential: Omit<HostDesktopCredential, "ticket">;
  readonly owner: LocalDesktopOwner;
  readonly threadRevision: string;
  readonly ticketHash: Buffer;
  readonly abort: AbortController;
  readonly claimBefore: number;
  timer: ReturnType<typeof setTimeout>;
  claimed: boolean;
  expiresAt: number;
  renewing?: boolean;
  socket?: Socket;
  viewer?: WebSocket;
  control?: { readonly id: string; readonly abort: AbortController; confirmed: boolean; lease?: NativeControlLease };
  readonly requests?: Set<string>;
}
const unavailable = () => new Error("Desktop is unavailable");
const hash = (value: string) => createHash("sha256").update(value).digest();
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const bytes = (data: RawData): Buffer => Array.isArray(data) ? Buffer.concat(data)
  : data instanceof ArrayBuffer ? Buffer.from(data) : data;

/** One backend owner for local bindings and viewers. Registration is backend
 * configuration, not browser IDs. This service is exposed only on an explicitly
 * loopback or trusted-internal Host; it is not downstream auth or a public multi-tenant authority. */
export class LocalDesktopService {
  private readonly attachments = new Map<string, Attachment>();
  private readonly preparing = new Map<string, number>();
  private readonly pending = new Set<WebSocket>();
  private readonly generation = randomUUID();
  private closed = false;
  private controller?: Attachment;
  constructor(private readonly registration: {
    readonly serverId: string;
    readonly environmentId: string;
    readonly principalId: string;
    readonly observer: NativeObserver;
    readonly control?: NativeDesktopControl;
    readonly transport?: HostDesktopCapability["transport"];
  }) {
    if (![registration.serverId, registration.environmentId, registration.principalId].every(validId)) throw unavailable();
    if (registration.transport !== undefined && registration.transport !== "same-origin-loopback"
      && registration.transport !== "same-origin-trusted-internal") throw unavailable();
    this.registration = Object.freeze({ ...registration });
  }

  /** Discovery identifies the backend namespace; it is not a Thread grant. */
  capability(): HostDesktopCapability {
    return Object.freeze({ version: 1, observe: true, control: !!this.registration.control, transport: this.registration.transport ?? "same-origin-loopback",
      serverId: this.registration.serverId, environmentId: this.registration.environmentId, principalId: this.registration.principalId,
      renewable: true });
  }

  private async revision(owner: LocalDesktopOwner, threadId: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.closed || !owner.isCurrent() || !validId(threadId)) throw unavailable();
    // A bounded logical request can expire without cancelling engine work. A
    // late result is discarded; no mutation or viewer is started by that read.
    let abort = () => {};
    const cancellation = new Promise<never>((_, reject) => {
      abort = () => reject(unavailable());
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    const thread = await Promise.race([owner.readThread(threadId), cancellation])
      .finally(() => signal.removeEventListener("abort", abort));
    signal.throwIfAborted();
    if (this.closed || !owner.isCurrent() || thread.id !== threadId || !validId(thread.path)
      || !Number.isSafeInteger(thread.createdAt) || thread.createdAt < 0) throw unavailable();
    return hash(JSON.stringify([this.generation, this.registration.serverId, this.registration.environmentId,
      this.registration.principalId, thread.id, thread.path, thread.createdAt])).toString("hex");
  }

  async prepare(owner: LocalDesktopOwner, threadId: string, caller?: AbortSignal): Promise<HostDesktopCredential> {
    const count = [...this.attachments.values()].filter(item => item.owner.key === owner.key).length;
    const reserved = this.preparing.get(owner.key) ?? 0;
    if (this.closed || !owner.isCurrent() || count + reserved >= 4
      || this.attachments.size + [...this.preparing.values()].reduce((a, b) => a + b, 0) >= 128) throw unavailable();
    this.preparing.set(owner.key, reserved + 1);
    const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(caller ? [caller] : [])]);
    try {
      const revision = await this.revision(owner, threadId, signal);
      const incarnation = await this.registration.observer.inspect(signal);
      if (!/^[a-f0-9]{64}$/.test(incarnation) || await this.revision(owner, threadId, signal) !== revision) throw unavailable();
      const ticket = randomBytes(32).toString("base64url"), id = randomBytes(16).toString("base64url");
      const credential: HostDesktopCredential = Object.freeze({ version: 1,
        target: Object.freeze({ conversationId: threadId, serverId: this.registration.serverId,
          environmentId: this.registration.environmentId, principalId: this.registration.principalId }),
        instanceId: this.registration.environmentId, resourceId: this.registration.environmentId,
        bindingRevision: revision, preparationGenerationId: this.generation, incarnation,
        attachmentId: id, ticket, expiresAt: Date.now() + 300_000 });
      const { ticket: _ticket, ...metadata } = credential;
      const item: Attachment = { credential: metadata, owner, threadRevision: revision, ticketHash: hash(ticket),
        abort: new AbortController(), claimBefore: Date.now() + 30_000, claimed: false, requests: new Set(),
        expiresAt: credential.expiresAt,
        timer: setTimeout(() => this.release(owner.key, id), 30_000) };
      item.timer.unref(); this.attachments.set(id, item);
      return credential;
    } finally {
      const remaining = (this.preparing.get(owner.key) ?? 1) - 1;
      if (remaining) this.preparing.set(owner.key, remaining); else this.preparing.delete(owner.key);
    }
  }

  release(ownerKey: string, id: string): void {
    const item = this.attachments.get(id);
    if (!item || item.owner.key !== ownerKey) return;
    this.attachments.delete(id); clearTimeout(item.timer); item.abort.abort();
    this.releaseControl(item);
    item.socket?.destroy(); item.viewer?.terminate(); item.ticketHash.fill(0);
  }
  revoke(ownerKey: string): void {
    for (const [id, item] of this.attachments) if (item.owner.key === ownerKey) this.release(ownerKey, id);
  }
  /** Reauthorize THIS claimed viewer; no new resource, ticket or input grant. */
  private async renew(item: Attachment, requestId: string): Promise<void> {
    const id = item.credential.attachmentId;
    if (item.renewing || !item.claimed || Date.now() >= item.expiresAt) throw unavailable();
    item.renewing = true;
    const signal = AbortSignal.any([item.abort.signal, AbortSignal.timeout(5_000)]);
    try {
      if (await this.revision(item.owner, item.credential.target.conversationId, signal) !== item.threadRevision
        || await this.registration.observer.inspect(signal) !== item.credential.incarnation
        || await this.revision(item.owner, item.credential.target.conversationId, signal) !== item.threadRevision) throw unavailable();
      signal.throwIfAborted();
      if (this.attachments.get(id) !== item || item.viewer?.readyState !== 1 || Date.now() >= item.expiresAt) throw unavailable();
      const expiresAt = Date.now() + 300_000;
      clearTimeout(item.timer); item.expiresAt = expiresAt;
      item.timer = setTimeout(() => this.release(item.owner.key, id), expiresAt - Date.now()); item.timer.unref();
      item.viewer.send(JSON.stringify({ event: "desktop/renewed", requestId, expiresAt }));
    } finally { item.renewing = false; }
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const [id, item] of this.attachments) this.release(item.owner.key, id);
    for (const socket of this.pending) socket.terminate(); this.pending.clear();
  }

  private releaseControl(item: Attachment, id?: string): void {
    const control = item.control;
    if (!control || id !== undefined && control.id !== id) return;
    item.control = undefined;
    if (this.controller === item) this.controller = undefined;
    control.abort.abort(); control.lease?.release();
  }

  private async requestControl(item: Attachment, id: string): Promise<void> {
    const send = (event: string) => {
      try {
        if (!item.abort.signal.aborted && item.viewer?.readyState === 1) item.viewer.send(JSON.stringify({ event, requestId: id }));
      } catch { this.release(item.owner.key, item.credential.attachmentId); }
    };
    if (!this.registration.control || this.controller || item.requests!.has(id) || item.requests!.size >= 256) {
      send("control/denied"); return;
    }
    item.requests!.add(id);
    const intent = { id, abort: new AbortController(), confirmed: false, lease: undefined as NativeControlLease | undefined };
    item.control = intent; this.controller = item; // Reserve BEFORE asynchronous preparation.
    const signal = AbortSignal.any([intent.abort.signal, item.abort.signal]);
    const preparationTimeout = setTimeout(() => intent.abort.abort(), 5000); preparationTimeout.unref();
    try {
      if (await this.revision(item.owner, item.credential.target.conversationId, signal) !== item.threadRevision) throw unavailable();
      const lease = await this.registration.control.acquire(item.credential.incarnation, signal);
      // The acquisition timeout only fences preparation, not the lease lifetime.
      intent.lease = lease;
      if (signal.aborted || item.control !== intent || !lease.isValid()
        || await this.revision(item.owner, item.credential.target.conversationId, signal) !== item.threadRevision) throw unavailable();
      lease.subscribeRevoked(() => {
        if (item.control !== intent) return;
        this.releaseControl(item, id); send("control/release");
      });
      if (item.control !== intent || !lease.isValid()) throw unavailable();
      intent.confirmed = true;
      send("control/locked");
    } catch { if (item.control === intent) this.releaseControl(item, id); else intent.lease?.release(); send("control/denied"); }
    finally { clearTimeout(preparationTimeout); }
  }

  /** Caller must enforce exact same Origin and loopback before upgrading. */
  accept(viewer: WebSocket): void {
    if (this.closed || this.pending.size >= 128) { viewer.terminate(); return; }
    this.pending.add(viewer); viewer.setMaxListeners(20);
    const firstDeadline = setTimeout(() => viewer.terminate(), 5_000); firstDeadline.unref();
    viewer.once("close", () => { clearTimeout(firstDeadline); this.pending.delete(viewer); });
    viewer.on("error", () => viewer.terminate());
    viewer.once("message", (data, binary) => {
      clearTimeout(firstDeadline); this.pending.delete(viewer);
      void this.claim(viewer, bytes(data).toString("utf8"), binary).catch(() => viewer.terminate());
    });
  }

  private async claim(viewer: WebSocket, text: string, binary: boolean): Promise<void> {
    if (binary || Buffer.byteLength(text) > 4096) throw unavailable();
    const proof = JSON.parse(text);
    if (!proof || Object.keys(proof).length !== 4 || proof.event !== "desktop/attach" || proof.version !== 1
      || typeof proof.attachmentId !== "string" || typeof proof.ticket !== "string" || proof.ticket.length > 128) throw unavailable();
    const item = this.attachments.get(proof.attachmentId);
    if (!item || item.claimed || Date.now() >= item.claimBefore || Date.now() >= item.expiresAt
      || !item.owner.isCurrent() || !timingSafeEqual(hash(proof.ticket), item.ticketHash)) throw unavailable();
    item.claimed = true; item.ticketHash.fill(0); item.viewer = viewer;
    clearTimeout(item.timer);
    item.timer = setTimeout(() => this.release(item.owner.key, item.credential.attachmentId),
      Math.max(0, item.expiresAt - Date.now())); item.timer.unref();
    viewer.once("close", () => this.release(item.owner.key, item.credential.attachmentId));
    const signal = AbortSignal.any([item.abort.signal, AbortSignal.timeout(10_000)]);
    const premature = () => this.release(item.owner.key, item.credential.attachmentId);
    viewer.on("message", premature);
    try {
      if (await this.revision(item.owner, item.credential.target.conversationId, signal) !== item.threadRevision) throw unavailable();
      const stream = await this.registration.observer.open(item.credential.incarnation, signal);
      item.socket = stream;
      stream.on("error", () => this.release(item.owner.key, item.credential.attachmentId));
      stream.once("close", () => this.release(item.owner.key, item.credential.attachmentId));
      if (await this.revision(item.owner, item.credential.target.conversationId, signal) !== item.threadRevision || viewer.readyState !== 1) throw unavailable();
      viewer.off("message", premature);
      const stall = () => {
        const timeout = setTimeout(() => this.release(item.owner.key, item.credential.attachmentId), 10_000);
        timeout.unref();
        const done = () => { clearTimeout(timeout); item.abort.signal.removeEventListener("abort", done); };
        item.abort.signal.addEventListener("abort", done, { once: true });
        return done;
      };
      const decoder = this.registration.control ? new RfbInputDecoder(() => item.control?.confirmed ? item.control.lease : undefined) : undefined;
      viewer.send(JSON.stringify({ event: "desktop/ready", version: 1, attachmentId: item.credential.attachmentId,
        controlAvailable: !!this.registration.control, clipboardAvailable: false, renewable: true }));
      stream.on("data", (chunk: Buffer) => {
        stream.pause();
        if (chunk.length > 1 << 20 || viewer.bufferedAmount > 1 << 20) { this.release(item.owner.key, item.credential.attachmentId); return; }
        const finish = stall();
        viewer.send(chunk, { binary: true }, error => {
          finish();
          if (error) this.release(item.owner.key, item.credential.attachmentId);
          else if (!item.abort.signal.aborted) stream.resume();
        });
      });
      viewer.on("message", (data, isBinary) => {
        const chunk = bytes(data);
        if (chunk.length > 1 << 20 || item.abort.signal.aborted) { this.release(item.owner.key, item.credential.attachmentId); return; }
        try {
          if (!isBinary) {
            if (chunk.length > 4096) throw unavailable();
            const message = JSON.parse(chunk.toString("utf8"));
            if (!message || Object.keys(message).length !== 2 || typeof message.requestId !== "string"
              || !/^[1-9][0-9]{0,15}$/.test(message.requestId)) throw unavailable();
            if (message.event === "desktop/renew") void this.renew(item, message.requestId)
              .catch(() => this.release(item.owner.key, item.credential.attachmentId));
            else if (message.event === "control/request") void this.requestControl(item, message.requestId);
            else if (message.event === "control/release") this.releaseControl(item, message.requestId);
            else throw unavailable();
            return;
          }
          decoder?.push(chunk);
        } catch { this.release(item.owner.key, item.credential.attachmentId); return; }
        if (!stream.write(chunk)) {
          viewer.pause(); const finish = stall();
          stream.once("drain", () => { finish(); if (!item.abort.signal.aborted) viewer.resume(); });
        }
      });
      stream.resume();
      const check = async () => {
        try {
          if (await this.revision(item.owner, item.credential.target.conversationId,
            AbortSignal.any([item.abort.signal, AbortSignal.timeout(5_000)])) !== item.threadRevision) throw unavailable();
          if (!item.abort.signal.aborted) { timer = setTimeout(() => void check(), 5_000); timer.unref(); }
        } catch { this.release(item.owner.key, item.credential.attachmentId); }
      };
      let timer = setTimeout(() => void check(), 5_000); timer.unref();
      item.abort.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    } catch { viewer.off("message", premature); this.release(item.owner.key, item.credential.attachmentId); throw unavailable(); }
  }
}
