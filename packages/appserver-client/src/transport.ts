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
  private attempt: { readonly promise: Promise<void>; cancel(cause: unknown): void } | null = null;
  private closeBarrier: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private releases: (() => void)[] = [];
  constructor(private readonly create: (signal: AbortSignal) => Promise<DuplexTransport>) {}
  get status(): TransportStatus { return this.current; }
  private publish(status: TransportStatus): void {
    if (this.current === status) return;
    this.current = status;
    for (const listener of this.statuses) listener(status);
  }
  private retireDelegate(): void {
    this.releases.splice(0).forEach(release => release());
    const previous = this.delegate;
    this.delegate = null;
    if (previous) this.closeBarrier = this.closeBarrier.then(() => previous.close()).catch(() => undefined);
  }
  connect(signal?: AbortSignal): Promise<void> {
    if (this.owner.signal.aborted) return Promise.reject(connectionAbort(undefined, "Transport closed"));
    if (signal?.aborted) return Promise.reject(connectionAbort(signal));
    if (this.attempt) return this.attempt.promise;
    if (this.current.state === "open") return Promise.resolve();
    let resolve!: () => void, reject!: (cause: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    void promise.catch(() => undefined);
    const controller = new AbortController();
    const cleanup = () => {
      signal?.removeEventListener("abort", abort);
      this.owner.signal.removeEventListener("abort", abort);
    };
    const attempt = { promise, cancel: (cause: unknown) => {
      if (this.attempt !== attempt) return;
      const failure = this.delegate?.status.failure;
      this.attempt = null;
      cleanup();
      // Retired local operations settle independently of physical close. Install
      // the barrier and detach old callbacks before abort observers can reenter.
      this.retireDelegate();
      reject(cause);
      controller.abort(cause);
      if (!this.owner.signal.aborted && this.attempt === null)
        this.publish({ state: "failed", reason: cause instanceof Error ? cause.message : "Connection unavailable", ...(failure ? { failure } : {}) });
    } };
    const abort = () => attempt.cancel(this.owner.signal.aborted
      ? connectionAbort(undefined, "Transport closed") : connectionAbort(signal));
    this.attempt = attempt;
    signal?.addEventListener("abort", abort, { once: true });
    this.owner.signal.addEventListener("abort", abort, { once: true });
    const current = () => this.attempt === attempt && !controller.signal.aborted && !this.owner.signal.aborted;
    const check = () => { if (!current()) throw controller.signal.reason ?? connectionAbort(signal); };
    const revoked = new Promise<never>((_, fail) => controller.signal.addEventListener("abort", () => fail(controller.signal.reason), { once: true }));
    void revoked.catch(() => undefined);
    const wait = async <T>(operation: Promise<T>): Promise<T> => {
      const result = await Promise.race([operation, revoked]); check(); return result;
    };
    void Promise.resolve().then(async () => {
      check();
      await wait(this.closeBarrier);
      const acquired = this.delegate ? Promise.resolve(this.delegate) : this.create(controller.signal);
      const transport = await wait(acquired.then(value => {
        // A late import only owns its dormant result, never the new delegate.
        if (!current() && value !== this.delegate) void value.close().catch(() => undefined);
        return value;
      }));
      check();
      if (this.delegate !== transport) {
        this.delegate = transport;
        this.releases = [
          transport.subscribeMessage(frame => { if (this.delegate === transport) for (const listener of this.messages) listener(frame); }),
          transport.subscribeStatus(status => { if (this.delegate === transport && !this.owner.signal.aborted) this.publish(status); }),
          ...(transport.subscribeRecoveryHint ? [transport.subscribeRecoveryHint(() => { if (this.delegate === transport) for (const listener of this.recovery) listener(); })] : []),
        ];
      }
      check();
      await wait(transport.connect(controller.signal));
      this.publish(transport.status);
      check();
      this.attempt = null;
      cleanup();
      resolve();
    }).catch(cause => attempt.cancel(cause));
    this.publish({ state: "connecting" });
    return promise;
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
    this.retireDelegate();
    this.closing = this.closeBarrier;
    this.publish({ state: "closed" });
    this.messages.clear(); this.statuses.clear(); this.recovery.clear();
    return this.closing;
  }
}
