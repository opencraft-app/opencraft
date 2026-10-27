import { DesktopFailure, desktopTargetKey, type DesktopAttachment, type DesktopBackend, type DesktopConnection,
  type DesktopControlLease, type DesktopTarget, type DesktopFailureReason } from "./contract";
import type { DesktopSurface, DesktopSurfaceFactory } from "./viewer";
import type { DesktopFramePreview } from "./contract";
import { validFramePreview } from "./frame-preview";

const recoveryDelaysMs = [1_000, 2_000, 4_000] as const;
const stableViewingMs = 30_000;
export type DesktopStage = "preparing" | "connecting" | "video" | "input" | "connected";
export interface DesktopDiagnostic {
  readonly generation: number;
  readonly stage: DesktopStage;
  readonly reason: DesktopFailureReason;
  readonly elapsedMs: number;
  readonly operation: "view" | "control" | "clipboard";
}

export interface DesktopViewSnapshot {
  readonly preview?: DesktopFramePreview;
  readonly mediaAspectRatio?: number;
  readonly phase: "unavailable" | "connecting" | "ready" | "failed";
  readonly control: "observing" | "requesting" | "controlling";
  readonly canControl: boolean;
  readonly controlFailed: boolean;
  readonly stage?: DesktopStage;
  readonly failure?: DesktopFailureReason;
  readonly canPaste?: boolean;
  /** Physical capability, independent of the current exclusive input grant. */
  readonly pasteAvailable?: boolean;
  readonly textInputAvailable?: boolean;
  readonly trackpadAvailable?: boolean;
  readonly clipboardBusy?: boolean;
  readonly clipboardFailed?: boolean;
}

/** One viewing incarnation, not an owner of the remote desktop or Chat turn. */
export class DesktopViewController {
  private snapshot: DesktopViewSnapshot = {
    phase: "unavailable", control: "observing", canControl: false, controlFailed: false,
  };
  private readonly listeners = new Set<() => void>();
  private target: DesktopTarget | null = null;
  private generation = 0;
  private started = false;
  private active = true;
  private disposed = false;
  private abort: AbortController | null = null;
  private controlAbort: AbortController | null = null;
  private controlEpoch = 0;
  private attachment: DesktopAttachment | null = null;
  private connection: DesktopConnection | null = null;
  private surface: DesktopSurface | null = null;
  private lease: DesktopControlLease | null = null;
  private unwatchBackend: (() => void) | null = null;
  private unwatchConnection: (() => void) | null = null;
  private unwatchControl: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryAttempts = 0;
  private startedAt = 0;
  private clipboardEpoch = 0;
  private readinessDeadline = 0;
  private preview: { targetKey: string; resourceId: string; incarnation: string; frame: DesktopFramePreview } | null = null;

  constructor(
    private readonly backend: DesktopBackend,
    private readonly surfaces: DesktopSurfaceFactory,
    private readonly conversationId: string,
    private readonly element: HTMLElement,
    private readonly timeoutMs = 120_000,
    private readonly onDiagnostic: (record: DesktopDiagnostic) => void = record => console.info("[desktop]", record),
    /** Platform-derived focus ownership, never a substitute for the backend grant. */
    private readonly ownsInteractionFocus: () => boolean = () => true,
  ) {}

  getSnapshot = (): DesktopViewSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    if (this.watchBackend()) this.refreshTarget();
  }

  /** Hidden is still watching, but cannot retain or reacquire input. */
  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (!active) {
      // Retire even a Take captured while observing, before it created a grant.
      this.controlEpoch++;
      this.releaseControl();
    }
    // Adapter overlays may live outside the media aperture (touch cursors).
    // Cleanup callbacks can reenter; project the latest intent, not a stale arg.
    this.cleanup(() => this.surface?.setActive(this.active));
  }

  retry(): void {
    if (this.disposed || !this.started) return;
    // Repeated gestures share a pending bootstrap/backoff, not concurrent grants.
    if (this.snapshot.phase === "connecting") return;
    this.recoveryAttempts = 0;
    if (this.watchBackend()) this.refreshTarget(true);
  }

  private watchBackend(): boolean {
    if (this.unwatchBackend !== null) return true;
    try {
      const unsubscribe = this.backend.subscribe(() => this.refreshTarget());
      if (this.disposed) { this.cleanup(unsubscribe); return false; }
      this.unwatchBackend = unsubscribe;
      return true;
    } catch {
      this.fail();
      return false;
    }
  }

  private refreshTarget(force = false): void {
    if (this.disposed) return;
    let target: DesktopTarget | null;
    try { target = this.backend.resolveTarget(this.conversationId); }
    catch { target = null; }
    // Do not accept an adapter accidentally resolving another conversation.
    if (target?.conversationId !== this.conversationId) target = null;
    if (!force && (target === null ? this.target === null
      : this.target !== null && desktopTargetKey(target) === desktopTargetKey(this.target))) return;
    if (target === null || this.target === null || desktopTargetKey(target) !== desktopTargetKey(this.target)) {
      this.recoveryAttempts = 0;
      this.preview = null;
    }
    this.target = target === null ? null : Object.freeze({ ...target });
    const generation = this.retireConnection();
    // Cleanup can synchronously invalidate the target again. That newer writer wins.
    if (!this.current(generation)) return;
    if (this.target === null) {
      this.publish({ phase: "unavailable", control: "observing", canControl: false, controlFailed: false });
      return;
    }
    const expected = this.target;
    const abort = new AbortController();
    this.abort = abort;
    this.startedAt = performance.now();
    this.publish({ phase: "connecting", stage: "preparing", control: "observing", canControl: false, controlFailed: false });
    if (!this.current(generation)) return;
    const prepareTimeout = this.backend.prepareTimeoutMs;
    this.timer = setTimeout(() => {
      if (this.current(generation)) this.fail(false, "timeout");
    }, prepareTimeout !== undefined && Number.isFinite(prepareTimeout) && prepareTimeout > 0
      ? prepareTimeout : this.timeoutMs);
    void this.connect(expected, generation, abort.signal);
  }

  private async connect(target: DesktopTarget, generation: number, signal: AbortSignal): Promise<void> {
    try {
      const attachment = await this.backend.prepare(target, signal);
      if (!this.current(generation)) { this.cleanup(() => attachment.release()); return; }
      this.attachment = attachment;
      if (!attachment.resourceId || !attachment.incarnation
        || desktopTargetKey(attachment.target) !== desktopTargetKey(target)) throw new DesktopFailure("identity");
      if (this.preview && (this.preview.targetKey !== desktopTargetKey(target)
        || this.preview.resourceId !== attachment.resourceId || this.preview.incarnation !== attachment.incarnation)) this.preview = null;
      this.publish({ ...this.snapshot, preview: this.preview?.frame,
        mediaAspectRatio: this.preview?.frame.aspectRatio });
      if (!this.current(generation)) return;
      this.setStage("connecting");
      if (!this.current(generation)) return;
      const connection = await attachment.connect(signal);
      if (!this.current(generation)) { this.cleanup(() => connection.close()); return; }
      this.connection = connection;
      const surface = this.surfaces.mount(this.element, connection);
      if (!this.current(generation)) { this.cleanup(() => surface.dispose()); return; }
      this.surface = surface;
      surface.setPasteHandler?.(read => { if (this.current(generation)) void this.pasteClipboard(read); });
      // The surface starts in observe mode even if the transport had old input state.
      this.surface.disableInput();
      if (!this.current(generation)) return;
      this.surface.setActive(this.active);
      if (!this.current(generation)) return;
      const unsubscribe = connection.subscribe(() => this.syncConnection(generation));
      if (!this.current(generation)) { this.cleanup(unsubscribe); return; }
      this.unwatchConnection = unsubscribe;
      this.syncConnection(generation);
    } catch (error) {
      if (this.current(generation)) this.fail(false, error instanceof DesktopFailure ? error.reason : "unknown");
    }
  }

  private syncConnection(generation: number): void {
    if (!this.current(generation) || this.connection === null) return;
    try {
      const state = this.connection.getSnapshot();
      if (state.ended) {
        if (state.resumeObserving === true && this.snapshot.phase === "ready") this.refreshTarget(true);
        else this.fail(state.retryable === true, state.failure ?? "transport");
        return;
      }
      const ready = state.videoReady && state.inputReady;
      const canControl = ready && state.controlAvailable;
      if (!canControl) {
        // Even an observe-mode press cannot survive withdrawn readiness/access.
        if (this.snapshot.canControl) this.controlEpoch++;
        this.releaseControl();
      }
      if (!this.current(generation)) return;
      this.setStage(ready ? "connected" : !state.videoReady && state.inputReady ? "video"
        : state.videoReady ? "input" : "connecting");
      if (!this.current(generation)) return;
      if (ready && this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
      // A brief successful handshake does not erase the flap budget. Only
      // sustained viewing starts a new bounded recovery episode.
      if (ready && this.stableTimer === null && this.recoveryAttempts > 0) {
        this.stableTimer = setTimeout(() => {
          this.stableTimer = null;
          if (this.current(generation)) this.recoveryAttempts = 0;
        }, stableViewingMs);
      }
      if (!ready && this.stableTimer !== null) { clearTimeout(this.stableTimer); this.stableTimer = null; }
      if (!ready && this.timer === null) this.timer = setTimeout(() => {
        if (this.current(generation)) this.fail(false, "timeout");
      }, this.timeoutMs);
      this.publish({ ...this.snapshot, phase: ready ? "ready" : "connecting", canControl,
        mediaAspectRatio: state.mediaAspectRatio ?? this.preview?.frame.aspectRatio,
        pasteAvailable: ready && Boolean(this.surface?.pasteText),
        trackpadAvailable: ready && Boolean(this.surface?.attachTrackpad),
        textInputAvailable: ready && Boolean(this.surface?.focusTextInput) });
    } catch { if (this.current(generation)) this.fail(); }
  }

  /** A press owns a fixed action, not a toggle of the state at click time.
   * Confirmation belongs to the same intent; cancellation/replacement retires it. */
  prepareControlAction(action: "take" | "stop"): () => void {
    const generation = this.generation, epoch = this.controlEpoch;
    let spent = false;
    return () => {
      if (spent) return;
      spent = true;
      if (!this.active || !this.current(generation) || this.controlEpoch !== epoch) return;
      if (action === "stop") this.releaseControl();
      else void this.requestControl();
    };
  }

  async requestControl(): Promise<void> {
    if (this.disposed || !this.active || !this.snapshot.canControl || this.connection === null
      || this.snapshot.control !== "observing") return;
    const generation = this.generation;
    const connection = this.connection;
    const abort = new AbortController();
    this.controlEpoch++;
    this.controlAbort = abort;
    this.publish({ ...this.snapshot, control: "requesting", controlFailed: false });
    if (!this.current(generation) || this.controlAbort !== abort) return;
    try {
      // Acquire focus within the user's Take activation, while still observe-only.
      // A grant confirmation must not later pull focus back from another task.
      this.surface?.focus?.();
      if (!this.current(generation) || abort.signal.aborted || this.controlAbort !== abort) return;
      if (!this.active || !this.hasInteractionFocus()) { this.releaseControl(); return; }
      const lease = await connection.requestControl(abort.signal);
      if (!this.current(generation) || abort.signal.aborted || this.controlAbort !== abort
        || !this.active || !this.snapshot.canControl || !this.hasInteractionFocus()) {
        if (this.current(generation) && this.controlAbort === abort) this.releaseControl();
        this.cleanup(() => lease.release()); return;
      }
      this.lease = lease;
      const unsubscribe = lease.subscribeRevoked(() => {
        if (this.lease === lease) this.releaseControl();
      });
      // A provider may synchronously report revocation during subscription.
      if (this.lease !== lease) { this.cleanup(unsubscribe); return; }
      this.unwatchControl = unsubscribe;
      if (!lease.isValid()) throw new Error("Control grant revoked");
      this.surface?.enableInput(lease);
      if (this.lease === lease) this.publish({ ...this.snapshot, control: "controlling", canPaste: Boolean(this.surface?.pasteText) });
    } catch {
      if (this.current(generation) && this.controlAbort === abort && !abort.signal.aborted) {
        this.releaseControl();
        this.diagnostic("unknown", "control");
        this.publish({ ...this.snapshot, controlFailed: true });
      }
    }
  }

  /** User-gesture read only. Fence BOTH clipboard read and media completion by
   * this exact grant; blur/cancel/reconnect must never paste into a successor. */
  async pasteClipboard(readText: () => Promise<string>): Promise<void> {
    const lease = this.lease, surface = this.surface, abort = this.controlAbort;
    if (this.disposed || this.snapshot.control !== "controlling" || !lease?.isValid()
      || !surface?.pasteText || !abort || this.snapshot.clipboardBusy) return;
    const generation = this.generation, epoch = ++this.clipboardEpoch;
    const current = () => this.current(generation) && this.lease === lease && lease.isValid()
      && this.clipboardEpoch === epoch && !abort.signal.aborted;
    this.publish({ ...this.snapshot, clipboardBusy: true, clipboardFailed: false });
    if (!current()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelRead!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancelRead = () => reject(new DesktopFailure("timeout"));
      timer = setTimeout(cancelRead, 5_000);
      abort.signal.addEventListener("abort", cancelRead, { once: true });
    });
    try {
      const text = await Promise.race([readText(), cancelled]);
      clearTimeout(timer);
      if (!current()) return;
      if (typeof text !== "string" || text.length > 16_384) throw new DesktopFailure("media");
      if (text.length) await surface.pasteText(text, lease, abort.signal);
      if (current()) {
        surface.focus?.();
        if (current()) this.publish({ ...this.snapshot, clipboardBusy: false });
      }
    } catch (error) {
      if (current()) {
        this.diagnostic(error instanceof DesktopFailure ? error.reason : "unknown", "clipboard");
        this.publish({ ...this.snapshot, clipboardBusy: false, clipboardFailed: true });
      }
    } finally {
      clearTimeout(timer); abort.signal.removeEventListener("abort", cancelRead);
    }
  }

  attachTrackpad(element: HTMLElement): () => void {
    return this.surface?.attachTrackpad?.(element) ?? (() => {});
  }

  showKeyboard(label: string): void {
    if (this.disposed || !this.active || this.snapshot.control !== "controlling" || !this.lease?.isValid()) return;
    this.surface?.focusTextInput?.(label);
  }

  private hasInteractionFocus(): boolean {
    try { return this.ownsInteractionFocus(); }
    catch { return false; } // A retired platform reader cannot authorize input or leak a late grant.
  }

  private setStage(stage: DesktopStage): void {
    if (this.snapshot.stage === stage) return;
    if (this.timer !== null) clearTimeout(this.timer);
    if (stage === "connected") this.readinessDeadline = 0;
    else if (!this.readinessDeadline) this.readinessDeadline = performance.now() + Math.min(this.timeoutMs, 20_000);
    const generation = this.generation;
    this.timer = stage === "connected" ? null : setTimeout(() => {
      if (this.current(generation)) this.fail(false, "timeout");
    }, Math.max(0, this.readinessDeadline - performance.now()));
    this.publish({ ...this.snapshot, stage });
  }

  private diagnostic(reason: DesktopFailureReason, operation: DesktopDiagnostic["operation"]): void {
    try { this.onDiagnostic({ generation: this.generation, stage: this.snapshot.stage ?? "preparing",
      reason, operation, elapsedMs: Math.max(0, Math.round(performance.now() - this.startedAt)) }); }
    catch { /* A diagnostic sink cannot alter lifecycle. No raw error payload. */ }
  }

  /** Also cancels an unconfirmed grant. A late grant will be released above. */
  releaseControl(): void {
    const generation = this.generation;
    this.detachControl()();
    if (this.current(generation) && this.snapshot.control !== "observing") {
      this.publish({ ...this.snapshot, control: "observing", canPaste: false, clipboardBusy: false, clipboardFailed: false });
    }
  }

  /** Revoke ownership before any adapter callback can re-enter the controller. */
  private detachControl(): () => void {
    this.clipboardEpoch++;
    const abort = this.controlAbort;
    const lease = this.lease;
    if (abort || lease) this.controlEpoch++;
    const unsubscribe = this.unwatchControl;
    const surface = this.surface;
    this.controlAbort = null;
    this.lease = null;
    this.unwatchControl = null;
    return () => {
      abort?.abort();
      this.cleanup(unsubscribe);
      this.cleanup(() => surface?.disableInput());
      this.cleanup(() => lease?.release());
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanup(this.unwatchBackend);
    this.unwatchBackend = null;
    this.retireConnection();
    this.preview = null;
    this.snapshot = { phase: "unavailable", control: "observing", canControl: false, controlFailed: false };
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }

  private current(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }

  private fail(retryable = false, reason: DesktopFailureReason = "unknown"): void {
    const stage = this.snapshot.stage;
    this.diagnostic(reason, "view");
    const delay = retryable && this.backend.recoverTransport === true && this.target !== null
      ? recoveryDelaysMs[this.recoveryAttempts] : undefined;
    const generation = this.retireConnection();
    if (!this.current(generation)) return;
    if (reason === "identity" || reason === "authorization") this.preview = null;
    if (delay === undefined) {
      this.publish({ phase: "failed", stage, failure: reason, control: "observing", canControl: false, controlFailed: false });
      return;
    }
    this.recoveryAttempts++;
    this.publish({ phase: "connecting", stage: "connecting", control: "observing", canControl: false, controlFailed: false });
    if (!this.current(generation)) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      // Re-resolve binding/capability and ask for a new attachment. Never reuse
      // the consumed ticket, connection, surface or control grant.
      if (this.current(generation)) this.refreshTarget(true);
    }, delay);
  }

  private retireConnection(): number {
    this.readinessDeadline = 0;
    const generation = ++this.generation;
    this.snapshot = { ...this.snapshot, canControl: false };
    const abort = this.abort;
    this.abort = null;
    const timer = this.timer;
    this.timer = null;
    const recoveryTimer = this.recoveryTimer, stableTimer = this.stableTimer;
    this.recoveryTimer = null; this.stableTimer = null;
    const releaseControl = this.detachControl();
    const unsubscribe = this.unwatchConnection;
    const surface = this.surface;
    const connection = this.connection;
    const attachment = this.attachment;
    this.unwatchConnection = null;
    this.surface = null;
    this.connection = null;
    this.attachment = null;
    // Only the current authorized binding can retain pixels. No global cache,
    // localStorage, cross-view reuse or async capture result to race retirement.
    if (!this.disposed && this.target && attachment
      && desktopTargetKey(this.target) === desktopTargetKey(attachment.target)) {
      try {
        const frame = connection?.capturePreview?.();
        if (this.current(generation) && this.target && validFramePreview(frame)
          && desktopTargetKey(this.target) === desktopTargetKey(attachment.target)) this.preview = {
          targetKey: desktopTargetKey(this.target), resourceId: attachment.resourceId,
          incarnation: attachment.incarnation, frame: Object.freeze({ ...frame }),
        };
      } catch { /* Capture is optional, not a viewing failure. */ }
    }
    // All old writable handles are detached before adapters can notify again.
    abort?.abort();
    if (timer !== null) clearTimeout(timer);
    if (recoveryTimer !== null) clearTimeout(recoveryTimer);
    if (stableTimer !== null) clearTimeout(stableTimer);
    releaseControl();
    this.cleanup(unsubscribe);
    this.cleanup(() => surface?.dispose());
    this.cleanup(() => connection?.close());
    this.cleanup(() => attachment?.release());
    return generation;
  }

  private cleanup(dispose: (() => void) | null): void {
    // One broken adapter disposer must not prevent the remaining leases releasing.
    try { dispose?.(); } catch { /* No raw adapter errors or credentials enter UI. */ }
  }

  private publish(snapshot: DesktopViewSnapshot): void {
    if (this.disposed) return;
    this.snapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) listener();
  }
}
