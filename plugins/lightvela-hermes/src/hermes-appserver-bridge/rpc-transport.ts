type JsonObject = Record<string, unknown>;
import type { HermesSessionPayload } from "./types";

export interface HermesSocket extends EventTarget {
  readonly readyState: number;
  send(data: string): void;
  close?(): void;
}

export interface HermesRpcClient {
  call<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
  onEvent(listener: (event: JsonObject) => void): () => void;
  catchUpSession?(sessionId: string): Promise<{ complete: boolean }>;
  discardReplay?(sessionId: string): void;
  snapshotSession?(sessionId: string): Promise<HermesSessionPayload>;
  releaseSnapshot?(sessionId: string): void;
}

/** Survives replacement WebSocket instances owned by one Host connection. */
export class HermesReplayCheckpoint {
  readonly lastSeenSeq = new Map<string, number>();
  epoch: string | null = null;

  reset(): void {
    this.lastSeenSeq.clear();
    this.epoch = null;
  }
}

export interface HermesRpcTransportOptions {
  timeoutMs?: number;
  replayCheckpoint?: HermesReplayCheckpoint;
  heartbeatIntervalMs?: number;
  heartbeatDeadlineMs?: number;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export class HermesRpcError extends Error {
  constructor(
    readonly code: number | string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HermesRpcError";
  }
}

const frameText = async (data: unknown): Promise<string | null> => {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return null;
};

/** JSON-RPC transport over an already-authenticated Hermes WebSocket. */
export class HermesRpcWebSocketTransport implements HermesRpcClient {
  private nextId = 1;
  private disposed = false;
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Set<(event: JsonObject) => void>();
  private readonly timeoutMs: number;
  private readonly replayCheckpoint: HermesReplayCheckpoint;
  private readonly replayPending: Set<string>;
  private readonly replayHolds = new Map<string, JsonObject[]>();
  private readonly snapshotRequests = new Map<number, string>();
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatDeadlineMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatSequence = 0;
  private lastInboundAt = 0;

  constructor(
    private readonly socket: HermesSocket,
    options: HermesRpcTransportOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    // Keep this identical to Hermes Desktop's advertised `gateway.ping`
    // contract. TAT owns its own transport liveness; the application layer
    // must not invent a second, more aggressive lifecycle policy.
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.heartbeatDeadlineMs = options.heartbeatDeadlineMs ?? 45_000;
    this.replayCheckpoint = options.replayCheckpoint ?? new HermesReplayCheckpoint();
    this.replayPending = new Set(this.replayCheckpoint.lastSeenSeq.keys());
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleClose);
  }

  async catchUpSession(sessionId: string): Promise<{ complete: boolean }> {
    const lastSeen = this.replayCheckpoint.lastSeenSeq.get(sessionId);
    if (lastSeen === undefined) {
      this.replayPending.delete(sessionId);
      this.flushHeld(sessionId);
      return { complete: true };
    }

    this.replayPending.add(sessionId);
    type ReplayResult = {
      events?: JsonObject[];
      epoch?: string;
      truncated?: boolean;
    };
    try {
      const result = await this.call<ReplayResult>("session.events.since", {
        session_id: sessionId,
        last_seen: lastSeen,
      });
      if (typeof result.epoch === "string" && result.epoch !== "") {
        if (this.replayCheckpoint.epoch !== null && this.replayCheckpoint.epoch !== result.epoch) {
          this.discardReplay(sessionId);
          this.replayCheckpoint.reset();
          this.replayCheckpoint.epoch = result.epoch;
          return { complete: false };
        }
        this.replayCheckpoint.epoch = result.epoch;
      }
      const complete = result.truncated !== true;
      if (!complete) {
        this.discardReplay(sessionId);
        return { complete: false };
      }
      for (const event of result.events ?? []) this.dispatchIfNewer(event);
      return { complete };
    } catch {
      this.discardReplay(sessionId);
      return { complete: false };
    } finally {
      this.replayPending.delete(sessionId);
      this.flushHeld(sessionId);
    }
  }

  onEvent(listener: (event: JsonObject) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  discardReplay(sessionId: string): void {
    this.replayCheckpoint.lastSeenSeq.delete(sessionId);
    this.replayPending.delete(sessionId);
    this.replayHolds.delete(sessionId);
  }

  async snapshotSession(sessionId: string): Promise<HermesSessionPayload> {
    this.discardReplay(sessionId);
    this.replayPending.add(sessionId);
    const requestId = this.nextId;
    this.snapshotRequests.set(requestId, sessionId);
    try {
      return await this.call("session.activate", { session_id: sessionId, omit_messages: true });
    } catch (error) {
      this.discardReplay(sessionId);
      throw error;
    } finally {
      this.snapshotRequests.delete(requestId);
    }
  }

  releaseSnapshot(sessionId: string): void {
    this.replayPending.delete(sessionId);
    this.flushHeld(sessionId);
  }

  async call<T>(method: string, params: unknown = {}, signal?: AbortSignal): Promise<T> {
    if (this.disposed) throw new HermesRpcError("disposed", "Hermes bridge is detached");
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new HermesRpcError("not-open", "Hermes WebSocket is not open");
    }
    const id = this.nextId++;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HermesRpcError("timeout", `Hermes ${method} timed out`));
      }, this.timeoutMs);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HermesRpcError("aborted", `Hermes ${method} was aborted`));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        timer,
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      try {
        this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.socket.removeEventListener("message", this.handleMessage);
    this.socket.removeEventListener("close", this.handleClose);
    this.stopHeartbeat();
    this.rejectPending(new HermesRpcError("disposed", "Hermes bridge is detached"));
    this.listeners.clear();
  }

  private readonly handleMessage = (event: Event): void => {
    this.lastInboundAt = Date.now();
    const data = (event as MessageEvent).data;
    void frameText(data).then((frame) => {
      if (frame !== null && !this.disposed) this.handleFrame(frame);
    });
  };

  private readonly handleClose = (): void => {
    this.stopHeartbeat();
    this.rejectPending(new HermesRpcError("disconnected", "Hermes WebSocket disconnected"));
  };

  private handleFrame(frame: string): void {
    let value: JsonObject;
    try {
      value = JSON.parse(frame) as JsonObject;
    } catch {
      return;
    }
    if (typeof value.id === "number") {
      const pending = this.pending.get(value.id);
      if (!pending) return;
      const snapshotSession = this.snapshotRequests.get(value.id);
      if (snapshotSession !== undefined) {
        // The response replaces the pre-response projection. Preserve frames
        // after the response until the adapter has installed its stream owner.
        this.replayHolds.delete(snapshotSession);
      }
      this.pending.delete(value.id);
      clearTimeout(pending.timer);
      const error = typeof value.error === "object" && value.error !== null
        ? value.error as JsonObject
        : undefined;
      if (error) {
        pending.reject(new HermesRpcError(
          typeof error.code === "number" || typeof error.code === "string" ? error.code : "rpc",
          typeof error.message === "string" ? error.message : "Hermes RPC failed",
          error.data,
        ));
      } else {
        pending.resolve(value.result);
      }
      return;
    }
    if (value.method === "event" && typeof value.params === "object" && value.params !== null) {
      this.acceptEvent(value.params as JsonObject);
    }
  }

  private acceptEvent(event: JsonObject): void {
    if (event.type === "gateway.ready") {
      const payload = typeof event.payload === "object" && event.payload !== null
        ? event.payload as JsonObject
        : {};
      if (payload.heartbeat === true) this.startHeartbeat();
      const epoch = payload.replay_epoch;
      if (typeof epoch === "string" && epoch !== "") {
        if (this.replayCheckpoint.epoch !== null && this.replayCheckpoint.epoch !== epoch) {
          this.replayCheckpoint.reset();
          this.replayPending.clear();
          this.replayHolds.clear();
        }
        this.replayCheckpoint.epoch = epoch;
      }
    }
    const sessionId = typeof event.session_id === "string" ? event.session_id : "";
    if (sessionId !== "" && this.replayPending.has(sessionId)) {
      const held = this.replayHolds.get(sessionId) ?? [];
      held.push(event);
      this.replayHolds.set(sessionId, held);
      return;
    }
    this.dispatchIfNewer(event);
  }

  private dispatchIfNewer(event: JsonObject): void {
    const sessionId = typeof event.session_id === "string" ? event.session_id : "";
    const seq = typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : null;
    if (sessionId !== "" && seq !== null) {
      const previous = this.replayCheckpoint.lastSeenSeq.get(sessionId) ?? 0;
      if (seq <= previous) return;
      this.replayCheckpoint.lastSeenSeq.set(sessionId, seq);
    }
    for (const listener of this.listeners) listener(event);
  }

  private flushHeld(sessionId: string): void {
    const held = this.replayHolds.get(sessionId) ?? [];
    this.replayHolds.delete(sessionId);
    for (const event of held) this.dispatchIfNewer(event);
  }

  private rejectPending(error: HermesRpcError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    this.lastInboundAt = Date.now();
    if (this.heartbeatIntervalMs <= 0 || this.heartbeatDeadlineMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.disposed || this.socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastInboundAt >= this.heartbeatDeadlineMs) {
        this.stopHeartbeat();
        this.socket.close?.();
        return;
      }
      try {
        this.socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: `heartbeat-${++this.heartbeatSequence}`,
          method: "gateway.ping",
          params: {},
        }));
      } catch {
        this.stopHeartbeat();
        this.socket.close?.();
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
