import WebSocket from "ws";
import type { TransportStatus } from "@opencraft/appserver-client/transport";

/** Shared ownership discipline for the raw and logical-client Core adapters. */
export class CodexCoreSocket {
  private socket: WebSocket | null = null;
  private operation: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private closed = false;
  private value: TransportStatus = { state: "idle" };
  constructor(private readonly input: {
    health(signal: AbortSignal): Promise<{ nativeSocket: string }>;
    message(frame: string): void;
    status(value: TransportStatus): void;
  }) {}
  get status(): TransportStatus { return this.value; }
  private publish(value: TransportStatus) { this.value = value; this.input.status(value); }
  connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Codex core connection is closed"));
    if (this.value.state === "open") return Promise.resolve();
    if (this.operation) return this.operation;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const current = () => !this.closed && this.generation === generation && !controller.signal.aborted;
    const ensure = () => { if (!current()) throw controller.signal.reason ?? new Error("Codex core connection was superseded"); };
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    let cancel!: () => void;
    const canceled = new Promise<never>((_, reject) => {
      cancel = () => reject(controller.signal.reason ?? new Error("Codex core connection was cancelled"));
      controller.signal.addEventListener("abort", cancel, { once: true });
    });
    const runner = Promise.resolve().then(async () => {
      ensure();
      const health = await this.input.health(controller.signal);
      ensure(); // In particular, close during health must allocate no socket.
      const socket = new WebSocket(`ws+unix://${health.nativeSocket}:/`, { handshakeTimeout: 5_000 });
      this.socket = socket;
      socket.on("message", data => { if (current() && this.socket === socket) this.input.message(String(data)); });
      const failed = () => {
        if (!current() || this.socket !== socket || this.value.state !== "open") return;
        this.socket = null;
        socket.terminate();
        this.publish({ state: "failed", reason: "Codex core connection closed", failure: { code: "codex-core-connection-failed", recovery: "automatic" } });
      };
      socket.on("error", failed);
      socket.on("close", failed);
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          socket.off("open", opened); socket.off("error", error); socket.off("close", closed);
          controller.signal.removeEventListener("abort", aborted);
        };
        const opened = () => { cleanup(); resolve(); };
        const error = () => { cleanup(); reject(new Error("Codex core native connection failed")); };
        const closed = () => { cleanup(); reject(new Error("Codex core closed during connection")); };
        const aborted = () => { cleanup(); socket.terminate(); reject(controller.signal.reason); };
        socket.once("open", opened); socket.once("error", error); socket.once("close", closed);
        controller.signal.addEventListener("abort", aborted, { once: true });
        if (controller.signal.aborted) aborted();
      });
      ensure();
      this.publish({ state: "open" });
    });
    const operation = Promise.race([runner, canceled]).catch(error => {
      if (this.generation === generation && !this.closed) {
        const socket = this.socket; this.socket = null; socket?.terminate();
        this.publish({ state: "failed", reason: "Codex core is unavailable", failure: { code: "codex-core-connection-failed", recovery: "automatic" } });
      }
      throw error;
    }).finally(() => {
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", cancel);
      if (this.operation === operation) this.operation = null;
    });
    this.operation = operation;
    // Observer reentry shares the operation registered above.
    this.publish({ state: "connecting" });
    return operation;
  }
  send(frame: string): void {
    if (this.value.state !== "open" || this.socket?.readyState !== WebSocket.OPEN) throw new Error("Codex core native connection is closed");
    this.socket.send(frame);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    ++this.generation;
    const socket = this.socket; this.socket = null;
    this.controller?.abort(new Error("Codex core connection is closed"));
    this.publish({ state: "closing" });
    socket?.terminate();
    this.publish({ state: "closed" });
  }
}
