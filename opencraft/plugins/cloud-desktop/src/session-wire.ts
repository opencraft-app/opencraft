import type { DesktopControlLease } from "./contract";
import type { DesktopRfbSession } from "./rfb";

export interface DesktopWireOptions {
  /** A new dedicated socket; never the Chat connection. */
  openSocket(): WebSocket;
  /** Product-owned scoped credential exchange, never a general VM credential. */
  authenticate(send: (message: unknown) => void): void;
  readonly attachmentId: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly controlTimeoutMs?: number;
  /** Both discovery and wire ready must explicitly permit renewal. */
  readonly renewal?: { readonly expiresAt: number; confirmed(expiresAt: number): void };
}

function cleanup(action: () => void): void { try { action(); } catch { /* Retire every owner. */ } }

/** A binary-only noVNC channel. JSON control messages never reach its decoder.
 * Public WebSocket shape used by noVNC's documented raw-channel API. */
class MediaChannel extends EventTarget {
  readonly protocol = "";
  binaryType: BinaryType = "arraybuffer";
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(private readonly socket: WebSocket, private readonly retire: () => void) { super(); }
  get bufferedAmount(): number { return this.socket.bufferedAmount; }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.readyState !== 1 || typeof data === "string" || this.socket.bufferedAmount > 1 << 20) {
      this.retire(); throw new Error("Desktop channel unavailable");
    }
    this.socket.send(data);
  }
  close(): void { this.retire(); }
  emit(name: "open" | "close" | "error" | "message", event: Event): void {
    if (name === "message") this.onmessage?.(event as MessageEvent);
    else if (name === "open") this.onopen?.(event);
    else if (name === "close") this.onclose?.(event);
    else this.onerror?.(event);
    this.dispatchEvent(event);
  }
}

/** Observe/control share one authorized attachment. The server's executor is
 * the input authority; no local state can grant control. */
export function createDesktopWireSession(options: DesktopWireOptions): DesktopRfbSession {
  let socket: WebSocket | null = null, media: MediaChannel | null = null;
  let closed = false, available = false, clipboardAvailable = true, sequence = 0;
  let termination: "transport-lost" | "retired" | null = null;
  let openingTimer: ReturnType<typeof setTimeout> | undefined;
  let renewalTimer: ReturnType<typeof setTimeout> | undefined;
  let renewalDeadline: ReturnType<typeof setTimeout> | undefined;
  let renewalId: string | null = null;
  const listeners = new Set<() => void>();
  const removers: (() => void)[] = [];
  let pending: { id: string; cancel(): void; resolve(lease: DesktopControlLease): void } | null = null;
  let grant: { id: string; lease: DesktopControlLease } | null = null;
  const notify = () => { for (const listener of [...listeners]) cleanup(listener); };
  const send = (message: unknown) => {
    if (closed || !socket || socket.readyState !== 1 || socket.bufferedAmount > 1 << 20) {
      throw new Error("Desktop control channel unavailable");
    }
    socket.send(JSON.stringify(message));
  };
  const releaseRemote = (id: string) => {
    try { send({ event: "control/release", requestId: id }); }
    catch { close(); } // Unknown release result: retire the entire attachment.
  };
  const close = (cause: "transport-lost" | "retired" = "retired") => {
    if (closed) return;
    closed = true; termination = cause; available = false;
    clearTimeout(openingTimer);
    clearTimeout(renewalTimer); clearTimeout(renewalDeadline); renewalId = null;
    const request = pending; pending = null; request?.cancel();
    const current = grant; grant = null; current?.lease.release();
    for (const remove of removers.splice(0).reverse()) cleanup(remove);
    cleanup(() => socket?.close());
    if (media) {
      media.readyState = 3;
      // Do not expose peer-supplied close reasons or authentication details.
      cleanup(() => media!.emit("close", new Event("close")));
    }
    notify(); listeners.clear();
  };
  const abort = () => close();
  options.signal.addEventListener("abort", abort, { once: true });
  removers.push(() => options.signal.removeEventListener("abort", abort));
  if (options.signal.aborted) close();

  const scheduleRenewal = (expiresAt: number) => {
    clearTimeout(renewalTimer);
    renewalTimer = setTimeout(() => {
      if (closed || media?.readyState !== 1) return;
      renewalId = String(++sequence);
      // A peer that no longer answers is a liveness failure, not an input grant.
      renewalDeadline = setTimeout(() => close("transport-lost"), 10_000);
      try { send({ event: "desktop/renew", requestId: renewalId }); }
      catch { close("transport-lost"); }
    }, Math.max(0, expiresAt - Date.now() - 30_000));
  };

  const receive = (event: MessageEvent) => {
    if (closed || !media) return;
    try {
      if (typeof event.data !== "string") {
        if (media.readyState !== 1 || !(event.data instanceof ArrayBuffer) || event.data.byteLength > 1 << 20) {
          throw new Error("Invalid desktop media");
        }
        media.emit("message", new MessageEvent("message", { data: event.data })); return;
      }
      if (event.data.length > 4096) throw new Error("Invalid desktop control");
      const value: unknown = JSON.parse(event.data);
      if (!value || typeof value !== "object") throw new Error("Invalid desktop control");
      const message = value as Record<string, unknown>;
      if (message.event === "desktop/ready") {
        if (media.readyState !== 0 || message.version !== 1 || message.attachmentId !== options.attachmentId
          || typeof message.controlAvailable !== "boolean") throw new Error("Desktop attachment changed");
        if (message.clipboardAvailable !== undefined && typeof message.clipboardAvailable !== "boolean") throw new Error("Invalid desktop capability");
        if (message.renewable !== undefined && typeof message.renewable !== "boolean") throw new Error("Invalid desktop capability");
        clearTimeout(openingTimer); available = message.controlAvailable; clipboardAvailable = message.clipboardAvailable !== false;
        media.readyState = 1; media.emit("open", new Event("open")); notify();
        if (!closed && options.renewal && message.renewable === true) scheduleRenewal(options.renewal.expiresAt);
        return;
      }
      if (media.readyState !== 1 || typeof message.requestId !== "string") throw new Error("Invalid desktop control");
      const id = message.requestId;
      if (message.event === "desktop/renewed") {
        if (!options.renewal || renewalId !== id || typeof message.expiresAt !== "number"
          || !Number.isSafeInteger(message.expiresAt) || message.expiresAt <= Date.now() + 30_000
          || message.expiresAt > Date.now() + 600_000) throw new Error("Invalid viewer renewal");
        clearTimeout(renewalDeadline); renewalId = null;
        options.renewal.confirmed(message.expiresAt);
        if (!closed) scheduleRenewal(message.expiresAt);
      } else if (message.event === "control/locked") {
        if (grant?.id === id) return; // Duplicate confirmation does not replace a valid grant.
        if (!pending || pending.id !== id) { releaseRemote(id); return; }
        const request = pending; pending = null;
        let valid = true;
        const revoked = new Set<() => void>();
        const lease: DesktopControlLease = {
          isValid: () => valid && !closed && grant?.lease === lease,
          subscribeRevoked: listener => {
            if (!lease.isValid()) { listener(); return () => {}; }
            revoked.add(listener); return () => { revoked.delete(listener); };
          },
          release: () => {
            if (!valid) return;
            valid = false;
            if (grant?.lease === lease) grant = null;
            for (const listener of [...revoked]) cleanup(listener);
            revoked.clear();
            if (!closed) releaseRemote(id);
          },
        };
        grant = { id, lease }; request.resolve(lease);
      } else if (message.event === "control/release" || message.event === "control/denied") {
        if (pending?.id === id) { const request = pending; pending = null; request.cancel(); }
        if (grant?.id === id) grant.lease.release();
      } else throw new Error("Unsupported desktop control");
    } catch { close(); }
  };

  return {
    openChannel() {
      if (closed || socket) throw new Error("Desktop attachment retired");
      try {
        socket = options.openSocket();
        if (socket.readyState !== 0) throw new Error("Desktop requires a fresh channel");
        socket.binaryType = "arraybuffer";
        media = new MediaChannel(socket, close);
        const authenticate = () => { try { options.authenticate(send); } catch { close(); } };
        const ended = (event: Event) => close(media?.readyState === 1
          && (event.type === "error" || (event as CloseEvent).code === 1006) ? "transport-lost" : "retired");
        for (const [name, listener] of [["open", authenticate], ["message", receive], ["close", ended], ["error", ended]] as const) {
          socket.addEventListener(name, listener as EventListener);
          const owned = socket;
          removers.push(() => owned.removeEventListener(name, listener as EventListener));
        }
        openingTimer = setTimeout(() => close(), options.timeoutMs ?? 15_000);
        return media as unknown as WebSocket;
      } catch (error) { close(); throw error; }
    },
    control: {
      isAvailable: () => !closed && available && media?.readyState === 1,
      canPaste: () => clipboardAvailable,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      request(signal) {
        if (closed || !available || media?.readyState !== 1 || pending || grant || signal.aborted) {
          return Promise.reject(new Error("Desktop control unavailable"));
        }
        const id = String(++sequence);
        return new Promise<DesktopControlLease>((resolve, reject) => {
          let settled = false;
          const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); };
          const cancel = () => {
            if (settled) return;
            settled = true; finish();
            if (pending?.id === id) pending = null;
            if (!closed) releaseRemote(id);
            reject(new Error("Desktop control request retired"));
          };
          const timer = setTimeout(cancel, options.controlTimeoutMs ?? 10_000);
          pending = { id, cancel, resolve: lease => {
            if (settled || closed || signal.aborted) { lease.release(); cancel(); return; }
            settled = true; finish(); resolve(lease);
          } };
          signal.addEventListener("abort", cancel, { once: true });
          try { send({ event: "control/request", requestId: id }); }
          catch { close(); }
        });
      },
    },
    getTermination: () => termination,
    close: () => close(),
  };
}
