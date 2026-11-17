import { combineAbortSignals, type TransportSendProgressObserver, type TransportSendProgressOptions } from "@opencraft/appserver-client/transport";

interface SocketSender {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(frame: string): void;
}
interface Watch {
  readonly start: number;
  readonly size: number;
  readonly report: TransportSendProgressObserver;
  readonly signal?: AbortSignal;
  readonly abort: () => void;
  readonly disposeSignals: () => void;
  loaded: number;
}

/** One ledger per physical socket; ALL writes must pass through this owner.
 * Counts UTF-8 application bytes leaving the local queue, never peer receipt.
 * No polling without observers, and no timers/observers survive socket retirement. */
export class WebSocketSendProgress {
  private tail = 0;
  private readonly watches = new Set<Watch>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly socket: SocketSender) {}

  /** Whether a caller is still observing upload progress on this socket. */
  get watching(): boolean { return this.watches.size > 0; }

  send(frame: string, signal?: AbortSignal, progress?: TransportSendProgressOptions): void {
    signal?.throwIfAborted();
    if (this.disposed) throw new Error("Socket send owner is closed");
    const report = progress?.signal?.aborted ? undefined : progress?.onProgress;
    if (!report && !this.watches.size) { this.socket.send(frame); return; }
    const buffered = this.socket.bufferedAmount;
    // Virtual/native bridges without a byte counter keep acknowledgement-only progress.
    if (typeof buffered !== "number" || !Number.isFinite(buffered) || buffered < 0) {
      this.socket.send(frame); return;
    }
    if (!this.watches.size) this.tail = buffered;
    const start = this.tail;
    // WebSocket bufferedAmount is UTF-8 application bytes, including JSON envelopes.
    const size = new TextEncoder().encode(frame).byteLength;
    this.socket.send(frame); // A throwing admission never adds bytes to the ledger.
    this.tail += size;
    if (report && !this.disposed && !signal?.aborted && !progress?.signal?.aborted) {
      const signals = combineAbortSignals([signal, progress?.signal].filter((s): s is AbortSignal => s !== undefined));
      const watch: Watch = { start, size, report, signal: signals.signal, disposeSignals: signals.dispose, loaded: -1, abort: () => this.remove(watch) };
      this.watches.add(watch);
      watch.signal?.addEventListener("abort", watch.abort, { once: true });
    }
    this.sample();
  }

  private remove(watch: Watch): void {
    this.watches.delete(watch);
    watch.signal?.removeEventListener("abort", watch.abort);
    watch.disposeSignals();
    if (!this.watches.size && this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
  }

  private sample(): void {
    if (this.disposed) return;
    if (this.socket.readyState !== 1) { this.dispose(); return; }
    const buffered = this.socket.bufferedAmount;
    if (typeof buffered !== "number" || !Number.isFinite(buffered) || buffered < 0) { this.dispose(); return; }
    const drained = this.tail - buffered;
    for (const watch of [...this.watches]) {
      if (this.disposed) return;
      if (!this.watches.has(watch)) continue;
      if (watch.signal?.aborted) { this.remove(watch); continue; }
      const loaded = Math.max(watch.loaded, Math.max(0, Math.min(watch.size, drained - watch.start)));
      if (loaded === watch.loaded) continue;
      watch.loaded = loaded;
      if (loaded === watch.size) this.remove(watch);
      try { watch.report({ loaded, total: watch.size }); } catch { /* Feedback cannot fail a send. */ }
    }
    if (this.watches.size && this.timer === undefined) this.timer = setTimeout(() => {
      this.timer = undefined; this.sample();
    }, 50);
  }

  dispose(): void {
    this.disposed = true;
    for (const watch of this.watches) this.remove(watch);
  }
}
