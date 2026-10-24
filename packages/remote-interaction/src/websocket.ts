import { packetId, parseMediaConfig, type MediaConfig, type MediaFeedback } from './protocol.cjs';
import type { AuthorizedAttachment } from './index';
import { bindOrderedTransport } from './transport';

export interface ReliableWebSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(message: string): void;
  close(): void;
}
export function bindWebSocketInput(attachment: AuthorizedAttachment, socket: ReliableWebSocket) {
  return bindOrderedTransport('websocket', attachment, {
    get open() { return socket.readyState === 1; },
    get bufferedAmount() { return socket.bufferedAmount; },
    send: message => socket.send(message),
    close: () => socket.close(),
  });
}

export interface MediaFeedbackOptions {
  send(feedback: MediaFeedback): void;
  reset(): void;
  visible(): boolean;
  now?(): number;
}

/** Per-attachment receiver evidence. DOM, authorization and decoder ownership stay with the host. */
export class WebSocketMediaReceiver {
  private config: MediaConfig | null = null;
  private received: string | null = null;
  private rendered: string | null = null;
  private frames = new Map<string, number>();
  private lastReceive = 0;
  private lastRender = 0;
  private lastSent = -Infinity;
  private dirty = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private decodedCount = 0;
  private queueTotal = 0;
  private queuePeak = 0;
  private queueSamples = 0;
  private measuredAt = 0;
  private behind = 0;
  private stable = 0;
  private fps = 30;
  private resetRequested = false;
  private readonly now: () => number;
  constructor(private readonly options: MediaFeedbackOptions) { this.now = options.now ?? (() => performance.now()); }
  get negotiated() { return this.config !== null; }
  configure(value: unknown): boolean {
    const config = parseMediaConfig(value); if (!config) return false;
    // Repeated configuration is idempotent; it cannot erase a live receiver's work.
    if (this.config?.epoch === config.epoch) return true;
    this.options.reset();
    this.config = config; this.received = this.rendered = null; this.frames.clear();
    this.lastReceive = this.lastRender = this.measuredAt = this.now();
    this.lastSent = -Infinity; this.resetRequested = false; this.stable = 0;
    this.queueSamples = this.queueTotal = this.decodedCount = this.queuePeak = 0; this.dirty = false;
    this.options.send({ version: 1, epoch: config.epoch, received: null, rendered: null, ready: true, fps: this.fps });
    this.lastSent = this.now();
    this.timer ??= setInterval(() => this.tick(), 50);
    return true;
  }
  receive(bytes: ArrayBuffer): string | null {
    if (!this.config) return null;
    if (bytes.byteLength > this.config.maxFrameBytes) { this.requestReset(); return null; }
    const id = packetId(new Uint8Array(bytes)); if (id === null) return null;
    this.received = id; this.lastReceive = this.now(); this.frames.set(id, this.lastReceive);
    // Evidence retention is bounded independently of bytes and decoder resources.
    while (this.frames.size > 64) this.frames.delete(this.frames.keys().next().value!);
    this.dirty = true; return id;
  }
  observeQueue(queueSize: number) { this.queuePeak = Math.max(this.queuePeak, queueSize); }
  decoded(id: string, queueSize: number) {
    if (!this.frames.has(id)) return;
    ++this.decodedCount; this.queueTotal += Math.max(0, queueSize); ++this.queueSamples;
  }
  renderedFrame(id: string) {
    const at = this.frames.get(id); if (at === undefined) return;
    this.rendered = id; this.lastRender = this.now(); this.dirty = true;
    for (const key of this.frames.keys()) { this.frames.delete(key); if (key === id) break; }
  }
  private requestReset() {
    if (!this.config || this.resetRequested) return;
    this.resetRequested = true;
    this.options.send({ version: 1, epoch: this.config.epoch, received: this.received,
      rendered: this.rendered, requestReset: true, fps: this.fps });
  }
  /** Exposed for deterministic host clocks and protocol trace tests. */
  tick() {
    if (!this.config) return;
    const now = this.now(), visible = this.options.visible();
    if (!visible) { this.lastRender = now; this.behind = this.stable = 0; }
    if (now - this.measuredAt >= 1000) {
      const seconds = (now - this.measuredAt) / 1000, output = this.decodedCount / seconds;
      const lagging = this.queueSamples > 0 && this.queueTotal / this.queueSamples > 1 || this.queuePeak >= 2;
      // An idle stream is no capacity measurement. Change capture rate only on sustained evidence.
      if (visible && this.decodedCount > 0) {
        if (lagging) {
          this.stable = 0; this.behind += seconds;
          if (this.behind >= 3) { this.fps = Math.max(5, Math.min(this.fps, Math.floor(output * 0.85))); this.behind = 0; this.dirty = true; }
        } else {
          this.behind = 0; this.stable += seconds;
          if (this.stable >= 20 && this.fps < 30) { this.fps = Math.min(30, this.fps + 2); this.stable = 0; this.dirty = true; }
        }
      }
      this.decodedCount = this.queueTotal = this.queueSamples = this.queuePeak = 0; this.measuredAt = now;
    }
    if (visible && this.config.stage === 'rendered' && this.lastReceive > this.lastRender
      && now - this.lastReceive < 1500 && now - this.lastRender > 4000) this.requestReset();
    if (this.resetRequested || !this.dirty && now - this.lastSent < 1000 || now - this.lastSent < 50) return;
    this.options.send({ version: 1, epoch: this.config.epoch, received: this.received,
      rendered: this.rendered, fps: this.fps });
    this.lastSent = now; this.dirty = false;
  }
  dispose() { if (this.timer) clearInterval(this.timer); this.timer = null; this.config = null; this.frames.clear(); }
}
