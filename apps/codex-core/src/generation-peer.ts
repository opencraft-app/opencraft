import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export type RpcRecord = Record<string, unknown>;
export const rpcRecord = (value: unknown): RpcRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RpcRecord : {};
export class NativeGenerationError extends Error {
  constructor(readonly rpcError: RpcRecord, readonly nativeRejection = false) { super(typeof rpcError.message === "string" ? rpcError.message : "Native generation request failed"); }
}

/** One native connection, initialized once; it never retries a submitted mutation. */
export class GenerationPeer {
  readonly connectionEpoch = randomUUID();
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> | undefined }>();
  private constructor(private readonly socket: WebSocket, private readonly input: {
    message(message: RpcRecord): void;
    disconnected(): void;
  }) {
    socket.on("message", frame => {
      let message: RpcRecord;
      try { message = rpcRecord(JSON.parse(String(frame))); } catch { socket.terminate(); return; }
      if (message.id !== undefined && typeof message.method !== "string") {
        const pending = this.pending.get(String(message.id));
        if (!pending) return;
        this.pending.delete(String(message.id)); clearTimeout(pending.timer);
        if (message.error) pending.reject(new NativeGenerationError(rpcRecord(message.error), true));
        else pending.resolve(message.result);
      } else if (!this.closed) input.message(message);
    });
    const failed = () => {
      if (this.closed) return;
      this.close(); input.disconnected();
    };
    socket.on("error", failed); socket.on("close", failed);
  }
  static async open(path: string, initialize: RpcRecord, input: { message(message: RpcRecord): void; disconnected(): void }, callbackLaneId?: string): Promise<{ peer: GenerationPeer; result: RpcRecord }> {
    const query = callbackLaneId ? `?opencraftLane=${encodeURIComponent(callbackLaneId)}` : "";
    const socket = new WebSocket(`ws+unix://${path}:/${query}`, { handshakeTimeout: 5_000 });
    try {
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); socket.once("close", () => reject(new Error("Native generation closed during connection"))); });
      const peer = new GenerationPeer(socket, input);
      try {
        const result = rpcRecord(await peer.call("initialize", initialize));
        peer.notify({ method: "initialized" });
        return { peer, result };
      } catch (error) { peer.close(); throw error; }
    } catch (error) { socket.terminate(); throw error; }
  }
  call(method: string, params: RpcRecord, sent?: () => void, timeoutMs: number | null = 120_000): Promise<unknown> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Native generation is unavailable before submission"));
    const id = `${this.connectionEpoch}:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new NativeGenerationError({ code: -32082, message: "Native generation request timed out; delivery is unconfirmed", data: { resultUnknown: true } }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { sent?.(); this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error instanceof Error ? error : new Error("Native generation send failed")); }
    });
  }
  notify(message: RpcRecord): void { if (!this.closed && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  get pendingCount(): number { return this.pending.size; }
  close(): void {
    if (this.closed) return; this.closed = true; this.socket.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new NativeGenerationError({ code: -32082, message: "Native generation connection closed; delivery is unconfirmed", data: { resultUnknown: true } }));
    }
    this.pending.clear();
  }
}
