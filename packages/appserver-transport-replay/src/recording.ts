import type {
  DuplexTransport,
  TransportStatus,
} from "@opencraft/appserver-client/transport";

export type RecordedFrameDirection = "client-to-server" | "server-to-client";

export interface RecordedFrame {
  sequence: number;
  direction: RecordedFrameDirection;
  timestampMs: number;
  payload: string;
}

export interface RecordingClock {
  now(): number;
}

export interface RecordingTransportOptions {
  transport: DuplexTransport;
  clock?: RecordingClock;
  sink?: (frame: RecordedFrame) => void;
}

const systemClock: RecordingClock = { now: () => Date.now() };

/** Records both directions while preserving the wrapped transport contract. */
export class RecordingTransport implements DuplexTransport {
  private readonly transport: DuplexTransport;
  private readonly clock: RecordingClock;
  private readonly sink?: (frame: RecordedFrame) => void;
  private readonly frames: RecordedFrame[] = [];
  private readonly messageListeners = new Set<(frame: string) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private removeMessageListener: (() => void) | null = null;
  private removeStatusListener: (() => void) | null = null;
  private sequence = 0;

  constructor(options: RecordingTransportOptions) {
    this.transport = options.transport;
    this.clock = options.clock ?? systemClock;
    this.sink = options.sink;
  }

  get status(): TransportStatus {
    return this.transport.status;
  }

  get recording(): readonly RecordedFrame[] {
    return this.frames;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    this.attach();
    await this.transport.connect(signal);
  }

  async send(frame: string, signal?: AbortSignal): Promise<void> {
    this.record("client-to-server", frame);
    await this.transport.send(frame, signal);
  }

  subscribeMessage(listener: (frame: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.transport.status);
    return () => this.statusListeners.delete(listener);
  }

  async close(): Promise<void> {
    await this.transport.close();
    this.removeMessageListener?.();
    this.removeStatusListener?.();
    this.removeMessageListener = null;
    this.removeStatusListener = null;
  }

  private attach(): void {
    if (this.removeMessageListener !== null) return;
    this.removeMessageListener = this.transport.subscribeMessage((frame) => {
      this.record("server-to-client", frame);
      for (const listener of this.messageListeners) listener(frame);
    });
    this.removeStatusListener = this.transport.subscribeStatus((status) => {
      for (const listener of this.statusListeners) listener(status);
    });
  }

  private record(direction: RecordedFrameDirection, payload: string): void {
    const frame: RecordedFrame = {
      sequence: this.sequence++,
      direction,
      timestampMs: this.clock.now(),
      payload,
    };
    this.frames.push(frame);
    this.sink?.(frame);
  }
}
