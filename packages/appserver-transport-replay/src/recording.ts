import type {
  DuplexTransport,
  TransportStatus,
} from "@opencraft/appserver-client/transport";
import { captureTransportMessageScope, ClientObserverList } from "@opencraft/appserver-client/transport";

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
  private readonly messageListeners = new ClientObserverList<string>();
  private attachment: { remove: (() => void) | null } | null = null;
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

  captureMessageScope(): () => boolean {
    const attachment = this.attachment, native = captureTransportMessageScope(this.transport);
    return () => attachment !== null && this.attachment === attachment && native();
  }
  subscribeMessage(listener: (frame: string) => void): () => void {
    return this.messageListeners.subscribe(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    // Preserve the native registration and its own initial sample. Reattaching
    // a recording tap is not another physical status publication.
    return this.transport.subscribeStatus(listener);
  }

  async close(): Promise<void> {
    const attachment = this.attachment;
    // Reentrant connect must acquire its own tap before old close awaits ACK.
    this.attachment = null;
    try { await this.transport.close(); }
    finally { if (attachment) this.release(attachment); }
  }

  private attach(): void {
    if (this.attachment !== null) return;
    const attachment = { remove: null as (() => void) | null };
    this.attachment = attachment;
    attachment.remove = this.transport.subscribeMessage((frame) => {
      if (this.attachment !== attachment) return;
      const isCurrent = this.captureMessageScope();
      this.record("server-to-client", frame);
      this.messageListeners.emit(frame, isCurrent);
    });
    // A provider may synchronously deliver while registering the tap.
    if (this.attachment !== attachment) this.release(attachment);
  }

  private release(attachment: { remove: (() => void) | null }): void {
    const remove = attachment.remove;
    attachment.remove = null;
    remove?.();
  }

  private record(direction: RecordedFrameDirection, payload: string): void {
    const frame: RecordedFrame = {
      sequence: this.sequence++,
      direction,
      timestampMs: this.clock.now(),
      payload,
    };
    this.frames.push(frame);
    const sink = this.sink;
    try { sink?.(frame); }
    catch { /* Recording observations cannot interrupt native protocol progress. */ }
  }
}
