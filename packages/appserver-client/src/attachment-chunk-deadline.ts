/** Minimum uplink rate assumed before a transport reports send progress. */
const ATTACHMENT_FALLBACK_BYTES_PER_MS = 16;
/** Ceiling for draining one chunk once the transport reports progress. */
const ATTACHMENT_SEND_CEILING_MS = 10 * 60_000;

/**
 * Bounds one attachment chunk by observed transport progress instead of a fixed
 * RPC budget. Socket liveness belongs to the transport's reachability probe; this
 * deadline only bounds a slow drain and the Host acknowledgement after it.
 */
export class AttachmentChunkDeadline {
  private readonly controller = new AbortController();
  private timer: unknown;
  private reported = false;
  private sent = false;
  expired = false;
  message = "Attachment upload timed out";

  constructor(frameBytes: number, private readonly final: boolean,
    private readonly clock: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(id: unknown): void } = globalThis as never) {
    // Without progress reports, allow a conservative weak-uplink transfer time.
    this.arm(30_000 + Math.ceil(frameBytes / ATTACHMENT_FALLBACK_BYTES_PER_MS) + this.acknowledgementMs,
      "Attachment upload timed out on a slow connection");
  }

  get signal(): AbortSignal { return this.controller.signal; }
  private get acknowledgementMs(): number { return this.final ? 120_000 : 30_000; }

  observe(progress: { readonly loaded: number; readonly total: number }): void {
    if (this.sent || this.expired) return;
    if (progress.total > 0 && progress.loaded >= progress.total) {
      this.sent = true;
      this.arm(this.acknowledgementMs, "The Host did not acknowledge the attachment chunk in time");
    } else if (!this.reported) {
      this.reported = true;
      this.arm(ATTACHMENT_SEND_CEILING_MS, "Attachment upload made too little network progress");
    }
  }

  dispose(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(delayMs: number, message: string): void {
    this.dispose();
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.expired = true;
      this.message = message;
      this.controller.abort(new Error(message));
    }, delayMs);
  }
}

