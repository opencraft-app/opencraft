import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";

export interface FaultInjectingTransportOptions {
  transport: DuplexTransport;
  inboundLatencyMs?: number;
  outboundLatencyMs?: number;
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

/** Test-only transport decorator. It carries no AppServer domain knowledge. */
export class FaultInjectingTransport implements DuplexTransport {
  private readonly transport: DuplexTransport;
  private readonly messageListeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private readonly inboundTimers = new Set<ReturnType<typeof globalThis.setTimeout>>();
  private inboundLatencyMs: number;
  private outboundLatencyMs: number;
  private inboundBlackhole = false;
  private generation = 0;

  constructor(options: FaultInjectingTransportOptions) {
    this.transport = options.transport;
    this.inboundLatencyMs = options.inboundLatencyMs ?? 0;
    this.outboundLatencyMs = options.outboundLatencyMs ?? 0;
    this.transport.subscribeMessage((frame) => this.deliverInbound(frame));
    this.transport.subscribeStatus((status) => {
      for (const listener of this.statusListeners) listener(status);
    });
  }

  get status(): TransportStatus {
    return this.transport.status;
  }

  setInboundLatency(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError("latency must be non-negative");
    this.inboundLatencyMs = milliseconds;
  }

  setInboundBlackhole(enabled: boolean): void {
    this.inboundBlackhole = enabled;
    if (enabled) this.clearInboundTimers();
  }

  async connect(signal?: AbortSignal): Promise<void> {
    this.generation += 1;
    await this.transport.connect(signal);
  }

  async send(frame: string): Promise<void> {
    const generation = this.generation;
    await delay(this.outboundLatencyMs);
    if (generation !== this.generation || this.status.state !== "open") {
      throw new Error("Fault-injection generation changed before send");
    }
    await this.transport.send(frame);
  }

  subscribeMessage(listener: (frame: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    this.generation += 1;
    this.clearInboundTimers();
    await this.transport.close();
  }

  close(): Promise<void> {
    return this.disconnect();
  }

  private deliverInbound(frame: string): void {
    if (this.inboundBlackhole) return;
    const generation = this.generation;
    if (this.inboundLatencyMs === 0) {
      if (this.status.state === "open") {
        for (const listener of this.messageListeners) listener(frame);
      }
      return;
    }
    const timer = globalThis.setTimeout(() => {
      this.inboundTimers.delete(timer);
      if (generation !== this.generation || this.status.state !== "open") return;
      for (const listener of this.messageListeners) listener(frame);
    }, this.inboundLatencyMs);
    this.inboundTimers.add(timer);
  }

  private clearInboundTimers(): void {
    for (const timer of this.inboundTimers) globalThis.clearTimeout(timer);
    this.inboundTimers.clear();
  }
}
