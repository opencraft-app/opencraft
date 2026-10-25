import type { MessageSender } from "@opencraft/appserver-protocol";

/** Trusted in-process context. Never decoded from a Renderer frame. */
export interface TransportSubmissionContext {
  readonly sender: MessageSender | null;
  /** Trusted ingress role lookup, rechecked before delivering statistics. Never wire decoded. */
  readonly tokenUsageAuthority?: () => { readonly actorId: string; readonly administrator: boolean } | null;
  /** Verified at ingress; never deserialize from a wire frame. */
  readonly actorContext?: import("@opencraft/identity-core/actors").ActorContext;
  /** Trusted gateway resource authority; never decoded from a frame or sent to an engine. */
  readonly resourceOwner?: { readonly id: string; readonly assertCurrent: () => void };
  readonly validUntil?: number;
  /** Headless-owned collaboration admission. Never decoded from a wire frame. */
  readonly collaborationRequestId?: string;
}

export type TransportState =
  | "idle"
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | "failed";

/**
 * The transport owns failure classification because only it understands the
 * remote resource and physical link. Runtime owners consume this disposition
 * when deciding whether an automatic reconnect is meaningful.
 */
/** Local metadata only: no remote payloads, URLs, credentials or error text. */
export interface TransportFailureDiagnostic {
  readonly attemptId: string;
  readonly occurredAt: string;
  readonly phase: "connecting" | "socket-open" | "ready";
  readonly failure: "socket-error" | "socket-close" | "handshake-timeout" | "probe-timeout" | "invalid-response";
  readonly closeCode?: number;
}

export interface TransportFailureDisposition {
  readonly code: string;
  readonly recovery: "automatic" | "manual";
  readonly diagnostic?: TransportFailureDiagnostic;
}

export interface TransportStatus {
  /** Locally generated physical connection correlation; no remote identity. */
  readonly attemptId?: string;
  /** Local connect boundary, never a claim of Host or Thread readiness. */
  readonly connectionStage?: "admission" | "release" | "bridge" | "host";
  state: TransportState;
  reason?: string;
  /** Omitted by legacy transports, which remain automatically recoverable. */
  failure?: TransportFailureDisposition;
}

export interface DuplexTransport {
  readonly status: TransportStatus;
  connect(signal?: AbortSignal): Promise<void>;
  /** Signal ends local request work, not an already-admitted remote Turn. */
  send(frame: string, signal?: AbortSignal): Promise<void>;
  sendWithContext?(frame: string, context: TransportSubmissionContext, signal?: AbortSignal): Promise<void>;
  subscribeMessage(listener: (frame: string) => void): () => void;
  subscribeStatus(listener: (status: TransportStatus) => void): () => void;
  /** Platform hint (foreground/network return); connection owner decides whether to retry. */
  subscribeRecoveryHint?(listener: () => void): () => void;
  close(): Promise<void>;
}

function connectionAbort(signal?: AbortSignal, message = "Connection cancelled"): Error {
  const reason = (signal as (AbortSignal & { readonly reason?: unknown }) | undefined)?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(message); error.name = "AbortError"; return error;
}

/**
 * Combine existing cancellation owners without AbortSignal.any. The returned
 * signal aborts with the first observed reason; dispose detaches every input
 * listener and never aborts either side. Callers own the returned lifetime and
 * must dispose it when the operation or resource it protects is released.
 */
export function combineAbortSignals(signals: readonly AbortSignal[]): {
  readonly signal: AbortSignal; dispose(): void;
} {
  const controller = new AbortController();
  const attached: Array<{ readonly signal: AbortSignal; readonly listener: () => void }> = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const { signal, listener } of attached) signal.removeEventListener("abort", listener);
    attached.length = 0;
  };
  const cancel = (source: AbortSignal) => {
    if (disposed || controller.signal.aborted) return;
    // React Native exposes the legacy no-argument signature in its global types.
    // Optional reason support remains a runtime capability of the same controller.
    const reason = (source as AbortSignal & { readonly reason?: unknown }).reason;
    (controller as { abort(reason?: unknown): void }).abort(reason);
    dispose();
  };
  for (const source of signals) {
    if (source.aborted) { cancel(source); break; }
    const listener = () => cancel(source);
    source.addEventListener("abort", listener, { once: true });
    attached.push({ signal: source, listener });
  }
  return { signal: controller.signal, dispose };
}

/** A cheap provider registration; physical protocol code is acquired on connect.
 * Each instance has one connection attempt and terminal close. An import cannot
 * be cancelled, but a retired attempt can never attach its resulting transport.
 */
export class DeferredDuplexTransport implements DuplexTransport {
  private current: TransportStatus = { state: "idle" };
  private readonly owner = new AbortController();
  private readonly messages = new Set<(frame: string) => void>();
  private readonly statuses = new Set<(status: TransportStatus) => void>();
  private readonly recovery = new Set<() => void>();
  private delegate: DuplexTransport | null = null;
  private pending: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private releases: (() => void)[] = [];
  constructor(private readonly create: (signal: AbortSignal) => Promise<DuplexTransport>) {}
  get status(): TransportStatus { return this.current; }
  private publish(status: TransportStatus): void {
    if (this.current === status) return;
    this.current = status;
    for (const listener of this.statuses) listener(status);
  }
  connect(signal?: AbortSignal): Promise<void> {
    if (this.owner.signal.aborted) return Promise.reject(connectionAbort(undefined, "Transport closed"));
    if (signal?.aborted) return Promise.reject(connectionAbort(signal));
    if (this.pending) return this.pending;
    if (this.current.state === "open") return Promise.resolve();
    const attempt = new AbortController();
    const cancelled = () => this.owner.signal.aborted ? connectionAbort(undefined, "Transport closed") : connectionAbort(signal);
    const abort = () => attempt.abort();
    signal?.addEventListener("abort", abort, { once: true });
    this.owner.signal.addEventListener("abort", abort, { once: true });
    const operation = new Promise<void>((resolve, reject) => {
      const stop = () => reject(cancelled());
      attempt.signal.addEventListener("abort", stop, { once: true });
      void Promise.resolve().then(() => {
        if (attempt.signal.aborted) throw cancelled();
        return this.delegate ?? this.create(attempt.signal);
      }).then(async transport => {
        if (attempt.signal.aborted) { await transport.close(); throw cancelled(); }
        if (this.delegate !== transport) {
          this.delegate = transport;
          this.releases = [
          transport.subscribeMessage(frame => { for (const listener of this.messages) listener(frame); }),
          transport.subscribeStatus(status => { if (!this.owner.signal.aborted) this.publish(status); }),
          ...(transport.subscribeRecoveryHint ? [transport.subscribeRecoveryHint(() => { for (const listener of this.recovery) listener(); })] : []),
          ];
        }
        await transport.connect(attempt.signal);
        if (attempt.signal.aborted) throw cancelled();
        this.publish(transport.status);
      }).then(resolve, reject).finally(() => attempt.signal.removeEventListener("abort", stop));
    }).catch(async error => {
      if (!this.owner.signal.aborted) {
        const failure = this.delegate?.status.failure;
        this.publish({ state: "failed", reason: error instanceof Error ? error.message : "Connection unavailable", ...(failure ? { failure } : {}) });
      }
      this.releases.splice(0).forEach(release => release());
      const transport = this.delegate;
      this.delegate = null;
      await transport?.close();
      throw error;
    }).finally(() => {
      signal?.removeEventListener("abort", abort);
      this.owner.signal.removeEventListener("abort", abort);
      if (this.pending === operation) this.pending = null;
    });
    this.pending = operation;
    this.publish({ state: "connecting" });
    return operation;
  }
  async send(frame: string, signal?: AbortSignal): Promise<void> {
    if (!this.delegate || this.current.state !== "open") throw new Error("Transport is not connected");
    await this.delegate.send(frame, signal);
  }
  async sendWithContext(frame: string, context: TransportSubmissionContext, signal?: AbortSignal): Promise<void> {
    if (!this.delegate || this.current.state !== "open") throw new Error("Transport is not connected");
    if (this.delegate.sendWithContext) await this.delegate.sendWithContext(frame, context, signal);
    else await this.delegate.send(frame, signal);
  }
  subscribeMessage(listener: (frame: string) => void): () => void { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  subscribeStatus(listener: (status: TransportStatus) => void): () => void { this.statuses.add(listener); return () => { this.statuses.delete(listener); }; }
  subscribeRecoveryHint(listener: () => void): () => void { this.recovery.add(listener); return () => { this.recovery.delete(listener); }; }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.owner.abort();
    this.releases.splice(0).forEach(release => release());
    const transport = this.delegate;
    this.delegate = null;
    this.closing = Promise.resolve().then(() => transport?.close());
    this.publish({ state: "closed" });
    this.messages.clear(); this.statuses.clear(); this.recovery.clear();
    return this.closing;
  }
}
