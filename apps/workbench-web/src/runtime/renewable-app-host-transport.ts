import type { TransportSendProgressOptions } from "@opencraft/appserver-client/transport";
import { captureTransportMessageScope, ClientObserverList, TransportStatusObservers } from "@opencraft/appserver-client/transport";
import type { DuplexTransport, TransportStatus, TransportFailureDiagnostic } from "@opencraft/appserver-client/transport";
import { AppHostAdmissionError } from "./app-host-admission";

// Workbench keeps one transport object for its lifetime. A closed WebSocket
// invalidates its AppHost client and lease, so reconnect must replace the
// lease *inside* that object rather than ask Workbench to create another one.
export class RenewableAppHostTransport implements DuplexTransport {
  private lease: DuplexTransport | null = null;
  private removeMessageListener: (() => void) | null = null;
  private removeStatusListener: (() => void) | null = null;
  private readonly messageListeners = new ClientObserverList<string>();
  private readonly statusListeners = new TransportStatusObservers();
  private readonly recoveryListeners = new Set<() => void>();
  private currentStatus: TransportStatus = { state: "idle" };
  private attempt: { readonly controller: AbortController; readonly promise: Promise<void>;
    cancel(reason: unknown, retirement?: TransportStatus): void } | null = null;
  // Physical lease release is serialized independently of local attempt cancellation.
  private closeBarrier: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly createLease: (assertCurrent: () => void, waiting: (delayMs: number) => void) => Promise<{ transport: DuplexTransport; attemptId: string; diagnostic: () => TransportFailureDiagnostic | undefined; subscribeStage(listener: (stage: "bridge" | "host") => void): () => void }>, private readonly onClose: () => void, private readonly beforeConnect?: () => Promise<void>) {}

  get status(): TransportStatus { return this.currentStatus; }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error("App Host transport is closed"));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Connection cancelled"));
    if (this.currentStatus.state === "open" && this.lease && !this.captureMessageScope()()) {
      const native = this.lease.status;
      const retirement: TransportStatus = { ...(native.state === "open" ? { state: "closed" as const } : native),
        attemptId: this.currentStatus.attemptId };
      if (this.attempt) this.attempt.cancel(new Error(retirement.reason ?? "App Host connection retired"), retirement);
      else this.setStatus(retirement);
    }
    if (this.attempt !== null) return this.attempt.promise;
    if (this.currentStatus.state === "open") return Promise.resolve();
    let resolve!: () => void, reject!: (cause: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    void promise.catch(() => undefined);
    const controller = new AbortController();
    let removeStage: (() => void) | undefined;
    const cleanup = () => { signal?.removeEventListener("abort", abort); removeStage?.(); };
    const attempt = { controller, promise, cancel: (cause: unknown, retirement?: TransportStatus) => {
      if (this.attempt !== attempt) return;
      this.attempt = null;
      cleanup();
      // Detach callbacks and install the physical barrier before abort/status reentry.
      this.retireLease();
      controller.abort(cause);
      reject(cause);
      if (!this.closed && this.currentStatus.state !== "failed")
        this.setStatus(retirement ?? { state: "failed", reason: cause instanceof Error ? cause.message : String(cause),
          ...(cause instanceof AppHostAdmissionError ? { failure: cause.failure } : {}) });
    } };
    const abort = () => attempt.cancel(signal?.reason ?? new Error("Connection cancelled"));
    this.attempt = attempt;
    signal?.addEventListener("abort", abort, { once: true });
    const assertCurrent = () => {
      if (this.closed || this.attempt !== attempt || controller.signal.aborted)
        throw controller.signal.reason ?? new Error("Connection was superseded");
    };
    // One cancellable local wait per operation. Old external work can finish later,
    // but every continuation checks its owner before allocating or publishing.
    const revoked = new Promise<never>((_, fail) => {
      controller.signal.addEventListener("abort", () => fail(controller.signal.reason), { once: true });
    });
    void revoked.catch(() => undefined);
    const wait = async <T>(operation: Promise<T>): Promise<T> => {
      const result = await Promise.race([operation, revoked]);
      assertCurrent();
      return result;
    };
    const run = async () => {
      assertCurrent();
      this.setStatus({ state: "connecting", connectionStage: "admission" });
      assertCurrent();
      await wait(Promise.resolve(this.beforeConnect?.()));
      this.setStatus({ state: "connecting", connectionStage: "release" });
      assertCurrent();
      // Cancellation cannot bypass a physical close already started by an old lease.
      this.retireLease();
      await wait(this.closeBarrier);
      const acquired = await this.createLease(assertCurrent, retryAfterMs => {
        assertCurrent();
        this.setStatus({ state: "connecting", connectionStage: "retry", retryAfterMs });
      });
      try { assertCurrent(); }
      catch (cause) {
        // Acquisition may finish in the microtask after local cancellation.
        // Release only this lease; healthy peers keep their physical socket.
        this.closeBarrier = this.closeBarrier.then(() => acquired.transport.close()).catch(() => undefined);
        throw cause;
      }
      const next = acquired.transport;
      this.lease = next;
      this.removeMessageListener = next.subscribeMessage(frame => {
        if (this.lease !== next) return;
        this.messageListeners.emit(frame, this.captureMessageScope());
      });
      this.removeStatusListener = next.subscribeStatus(status => {
        if (this.lease !== next) return;
        const diagnostic = acquired.diagnostic();
        this.setStatus({ ...status, attemptId: acquired.attemptId, ...(status.failure && diagnostic
          ? { failure: { ...status.failure, diagnostic } } : {}) });
      });
      // Install observers before I/O. Stage notifications grant no readiness.
      removeStage = acquired.subscribeStage(stage => {
        if (this.attempt === attempt) this.setStatus({ state: "connecting", connectionStage: stage, attemptId: acquired.attemptId });
      });
      assertCurrent();
      await wait(next.connect(controller.signal));
      assertCurrent();
    };
    void run().then(() => {
      if (this.attempt !== attempt) return;
      this.attempt = null;
      cleanup();
      resolve();
    }, cause => { cleanup(); attempt.cancel(cause); });
    return promise;
  }

  private retireLease(): void {
    const previous = this.lease;
    this.lease = null;
    this.detachLease();
    if (previous) this.closeBarrier = this.closeBarrier.then(() => previous.close()).catch(() => undefined);
  }

  send(frame: string, signal?: AbortSignal, progress?: TransportSendProgressOptions): Promise<void> {
    if (this.closed || this.lease === null) return Promise.reject(new Error("App Host transport is not open"));
    return this.lease.send(frame, signal, progress);
  }

  captureMessageScope(): () => boolean {
    const lease = this.lease;
    const native = lease ? captureTransportMessageScope(lease) : () => false;
    return () => !this.closed && this.lease === lease && native();
  }
  subscribeMessage(listener: (frame: string) => void): () => void {
    return this.messageListeners.subscribe(listener);
  }

  subscribeStatus(listener: (status: TransportStatus) => void): () => void {
    return this.statusListeners.subscribe(listener);
  }

  subscribeRecoveryHint(listener: () => void): () => void {
    this.recoveryListeners.add(listener);
    return () => this.recoveryListeners.delete(listener);
  }

  notifyRecoveryHint(): void {
    for (const listener of this.recoveryListeners) listener();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    this.recoveryListeners.clear();
    this.attempt?.cancel(new Error("App Host transport is closed"));
    this.retireLease();
    this.setStatus({ state: "closing" });
    await this.closeBarrier;
    this.setStatus({ state: "closed" });
    this.messageListeners.clear();
    this.statusListeners.clear();
  }

  private detachLease(): void {
    this.removeMessageListener?.();
    this.removeStatusListener?.();
    this.removeMessageListener = null;
    this.removeStatusListener = null;
  }

  private setStatus(status: TransportStatus): void {
    this.currentStatus = status;
    this.statusListeners.emit(status, () => this.currentStatus === status);
  }
}
