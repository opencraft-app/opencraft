import type { DesktopConnection, DesktopConnectionSnapshot, DesktopControlLease } from "./contract";
import type { DesktopSurface, DesktopSurfaceFactory } from "./viewer";
import { loadRfbClient, type RfbClient, type RfbClientConstructor } from "./rfb-client";
import { bindDesktopPointerInput } from "./pointer-input";
import { createDesktopTextInput } from "./text-input";
import { bindDesktopClipboard } from "./clipboard-input";
import { captureFramePreview } from "./frame-preview";
import type { DesktopFramePreview } from "./contract";
import { combineAbortSignals } from "@opencraft/appserver-client/transport";

/** Supplied by an authorized backend adapter, never inferred from a Host URL.
 * The server must reject input without a grant; viewOnly is only local UX.
 * A missing control port means an observe-only server attachment. */
export interface DesktopRfbControlPort {
  isAvailable(): boolean;
  /** Absent retains legacy RFB clipboard support. Explicit false disables paste. */
  canPaste?(): boolean;
  subscribe(listener: () => void): () => void;
  request(signal: AbortSignal): Promise<DesktopControlLease>;
}

export interface DesktopRfbSession {
  /** Fresh CONNECTING channel. Opening only when the surface mounts prevents
   * losing the server greeting while the client module is still loading. */
  openChannel(): WebSocket;
  readonly control?: DesktopRfbControlPort;
  /** Adapter-owned classification; absent/retired failures are not retried. */
  getTermination?(): "transport-lost" | "control-released" | "retired" | null;
  /** Retire this viewer's transport only, never a shared Chat connection. */
  close(): void;
}

export interface RfbDesktopAdapter {
  connect(session: DesktopRfbSession, signal: AbortSignal): Promise<DesktopConnection>;
  readonly surfaces: DesktopSurfaceFactory;
}

function cleanup(action: (() => void) | undefined): void {
  try { action?.(); } catch { /* Continue cleanup; do not expose raw peer data. */ }
}

class RfbConnection implements DesktopConnection {
  private snapshot: DesktopConnectionSnapshot = {
    videoReady: false, inputReady: false, controlAvailable: false, ended: false,
  };
  private readonly listeners = new Set<() => void>();
  private readonly leases = new Set<DesktopControlLease>();
  private readonly abort = new AbortController();
  private readonly disposers: (() => void)[] = [];
  private client: RfbClient | null = null;
  private channel: WebSocket | null = null;
  private closed = false;
  private mounted = false;
  private requesting = false;
  private activeInput: DesktopControlLease | null = null;
  private surfaceActive = true;
  private pasteHandler: ((readText: () => Promise<string>) => void) | null = null;
  private cancelPaste: (() => void) | null = null;
  private pointerInput: ReturnType<typeof bindDesktopPointerInput> | null = null;
  private textInput: ReturnType<typeof createDesktopTextInput> | null = null;
  private clipboardInput: ReturnType<typeof bindDesktopClipboard> | null = null;
  private preview: DesktopFramePreview | null = null;

  capturePreview = (): DesktopFramePreview | null => {
    if (!this.closed && this.snapshot.videoReady && this.client) {
      this.preview = captureFramePreview(this.client.getInputCanvas());
    }
    return this.preview;
  };

  constructor(private readonly session: DesktopRfbSession, private readonly Client: RfbClientConstructor) {}

  watch(signal: AbortSignal): void {
    const close = () => this.close();
    signal.addEventListener("abort", close, { once: true });
    this.disposers.push(() => signal.removeEventListener("abort", close));
    if (this.session.control) {
      const unsubscribe = this.session.control.subscribe(() => {
        if (this.closed) return;
        try {
          const available = this.session.control!.isAvailable();
          if (!available) this.releaseLeases();
          if (!this.closed) this.publish({ ...this.snapshot, controlAvailable: available });
        } catch { this.close(); }
      });
      if (this.closed) cleanup(unsubscribe); else this.disposers.push(unsubscribe);
    }
    if (signal.aborted) this.close();
  }

  getSnapshot = (): DesktopConnectionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    if (this.closed) { listener(); return () => {}; }
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  mount(element: HTMLElement): DesktopSurface {
    if (this.closed || this.mounted) throw new Error("Desktop surface is unavailable");
    this.mounted = true;
    try {
      const channel = this.session.openChannel();
      this.channel = channel;
      // An already-open channel may have discarded RFB bytes before attachment.
      if (this.closed || channel.readyState !== 0) throw new Error("Desktop channel is unavailable");
      const client = new this.Client(element, channel, { shared: true });
      if (this.closed) { cleanup(() => client.disconnect()); throw new Error("Desktop connection retired"); }
      this.client = client;
      // noVNC connects asynchronously. Set before any RFB handshake/input event.
      client.viewOnly = true;
      client.focusOnClick = false;
      client.scaleViewport = true;
      client.resizeSession = false; // Observing must not resize the shared desktop.
      client.background = "transparent";
      client.setSurfaceActive(this.surfaceActive);
      this.pointerInput = bindDesktopPointerInput(element, client,
        () => !this.closed && this.surfaceActive && this.activeInput?.isValid() === true,
        () => this.textInput?.finish(() => client.focus({ preventScroll: true })));
      this.disposers.push(() => { this.pointerInput?.dispose(); this.pointerInput = null; });
      this.textInput = createDesktopTextInput(element, () => !this.closed && this.surfaceActive && this.activeInput?.isValid() === true,
        keysym => { if (!this.closed && this.activeInput?.isValid()) client.sendKey(keysym); });
      this.disposers.push(() => { this.textInput?.reset(); this.textInput = null; });
      const ready = () => {
        if (this.closed) return;
        try { this.publish({ ...this.snapshot, inputReady: true,
          controlAvailable: this.session.control?.isAvailable() ?? false, ended: false }); }
        catch { this.close(); }
      };
      const firstFrame = () => {
        if (!this.closed && this.snapshot.inputReady) {
          syncGeometry();
          this.publish({ ...this.snapshot, videoReady: true });
        }
      };
      // Decoder-owned backing dimensions are authoritative. Never infer aspect
      // from the scaled viewport or resize the shared desktop to fit a card.
      const canvas = client.getInputCanvas();
      const syncGeometry = () => {
        if (this.closed || !(canvas.width > 0 && canvas.height > 0)) return;
        const ratio = canvas.width / canvas.height;
        if (Number.isFinite(ratio) && ratio !== this.snapshot.mediaAspectRatio) {
          this.publish({ ...this.snapshot, mediaAspectRatio: ratio });
        }
      };
      const Observer = canvas.ownerDocument?.defaultView?.MutationObserver;
      if (Observer) {
        const observer = new Observer(syncGeometry);
        observer.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
        this.disposers.push(() => observer.disconnect());
      }
      // noVNC 1.5 does not rescale across a container A→0→A round trip: while
      // the host tab is hidden (display:none) the surface measures 0×0 and the
      // cached scale is computed against zero; restoring the size never reruns
      // _updateScale, and incremental RFB delivers no full-frame repaint, so
      // the canvas stays blank. Watch the mount element and reassign
      // scaleViewport (its public setter always reruns _updateScale) once the
      // size recovers from zero. Zero-size frames are skipped so the scale
      // factor can never collapse to 0.
      const Resize = element.ownerDocument?.defaultView?.ResizeObserver;
      if (Resize) {
        let collapsed = true;
        const observer = new Resize(entries => {
          if (this.closed) return;
          const [entry] = entries;
          if (!entry || !(entry.contentRect.width > 0 && entry.contentRect.height > 0)) { collapsed = true; return; }
          if (!collapsed) return;
          collapsed = false;
          client.scaleViewport = true;
        });
        observer.observe(element);
        this.disposers.push(() => observer.disconnect());
      }
      const fail = () => this.close(false, "authorization");
      const disconnected = () => this.close(this.snapshot.videoReady
        && this.session.getTermination?.() === "transport-lost");
      // The broker supplies a complete authorized RFB stream. Unexpected auth
      // prompts and trust challenges fail closed, never solicit raw credentials.
      for (const [name, listener] of [["connect", ready], ["firstframe", firstFrame], ["disconnect", disconnected],
        ["securityfailure", fail], ["credentialsrequired", fail], ["serververification", fail]] as const) {
        client.addEventListener(name, listener);
        this.disposers.push(() => client.removeEventListener(name, listener));
      }
      channel.addEventListener("close", disconnected);
      const channelError = () => this.close(false, "transport");
      channel.addEventListener("error", channelError);
      this.disposers.push(() => {
        channel.removeEventListener("close", disconnected); channel.removeEventListener("error", channelError);
      });
      const focus = () => { if (!this.closed && this.surfaceActive && this.snapshot.videoReady) client.focus({ preventScroll: true }); };
      this.clipboardInput = bindDesktopClipboard(element, client,
        () => !this.closed && this.surfaceActive && this.session.control?.canPaste?.() !== false
          && this.activeInput?.isValid() === true && !!this.pasteHandler,
        read => this.pasteHandler?.(read));
      this.disposers.push(() => { this.clipboardInput?.dispose(); this.clipboardInput = null; });
      element.addEventListener("pointerdown", focus, true);
      this.disposers.push(() => {
        element.removeEventListener("pointerdown", focus, true);
      });
      const connection = this;
      return { setActive: active => this.setActive(active),
        enableInput: lease => this.enableInput(lease), disableInput: () => this.disableInput(),
        attachTrackpad: pad => this.pointerInput?.attachTrackpad(pad) ?? (() => {}),
        focus, focusTextInput: label => this.textInput?.focus(label),
        setPasteHandler: handler => { this.pasteHandler = handler; },
        get pasteText() { return connection.session.control?.canPaste?.() === false ? undefined
          : (text: string, lease: DesktopControlLease, signal: AbortSignal) => connection.pasteText(text, lease, signal); },
        dispose: () => this.close() };
    } catch (error) { this.close(); throw error; }
  }

  async requestControl(signal: AbortSignal): Promise<DesktopControlLease> {
    if (this.closed || !this.snapshot.videoReady || !this.snapshot.controlAvailable
      || !this.session.control || this.leases.size || this.requesting) throw new Error("Desktop control is unavailable");
    const request = combineAbortSignals([signal, this.abort.signal]);
    try {
      request.signal.throwIfAborted();
      this.requesting = true;
      let remote: DesktopControlLease;
      try { remote = await this.session.control.request(request.signal); }
      finally { this.requesting = false; }
      if (this.closed || request.signal.aborted || !this.snapshot.controlAvailable) {
        cleanup(() => remote.release());
        throw new Error("Desktop control request retired");
      }
      let valid = true;
      let unsubscribe: (() => void) | undefined;
      const listeners = new Set<() => void>();
      const lease: DesktopControlLease = {
        isValid: () => valid && !this.closed && remote.isValid(),
        subscribeRevoked: listener => {
          if (!lease.isValid()) { listener(); return () => {}; }
          listeners.add(listener); return () => { listeners.delete(listener); };
        },
        release: () => {
          if (!valid) return;
          valid = false;
          this.leases.delete(lease);
          if (this.activeInput === lease) this.disableInput();
          cleanup(unsubscribe);
          for (const listener of listeners) cleanup(listener);
          listeners.clear();
          cleanup(() => remote.release());
        },
      };
      this.leases.add(lease);
      try {
        unsubscribe = remote.subscribeRevoked(() => lease.release());
        if (!valid) cleanup(unsubscribe);
        if (!lease.isValid()) throw new Error("Desktop control grant retired");
        return lease;
      } catch (error) { lease.release(); throw error; }
    } finally { request.dispose(); }
  }

  private enableInput(lease: DesktopControlLease): void {
    if (!this.client || !this.surfaceActive || !this.snapshot.videoReady || !this.snapshot.controlAvailable
      || !this.leases.has(lease) || !lease.isValid()) throw new Error("Desktop control grant is unavailable");
    this.pointerInput?.reset(); this.textInput?.reset();
    if (!lease.isValid() || this.closed) throw new Error("Desktop control grant retired");
    this.activeInput = lease;
    this.client.viewOnly = false;
    this.client.focusOnClick = true;
    // Focus was acquired by Take; this confirms input, without stealing focus.
  }

  private pasteText(text: string, lease: DesktopControlLease, signal: AbortSignal): Promise<void> {
    const client = this.client;
    const allowed = () => !this.closed && this.surfaceActive && this.activeInput === lease && lease.isValid() && !signal.aborted;
    if (!client || !allowed() || this.cancelPaste || typeof text !== "string" || text.length > 16_384) {
      return Promise.reject(new Error("Desktop paste unavailable"));
    }
    this.textInput?.finish(() => client.focus({ preventScroll: true }));
    if (!allowed()) return Promise.reject(new Error("Desktop paste retired"));
    return new Promise<void>((resolve, reject) => {
      let provided = false, keysSent = false;
      const finish = () => {
        clearTimeout(timer); client.removeEventListener("clipboardready", ready);
        signal.removeEventListener("abort", cancel); this.cancelPaste = null;
      };
      const cancel = () => { finish(); cleanup(() => client.clearClipboard()); reject(new Error("Desktop paste retired")); };
      const ready = () => {
        if (!allowed()) { cancel(); return; }
        provided = true;
        if (keysSent) { finish(); resolve(); }
      };
      const timer = setTimeout(cancel, 5_000);
      this.cancelPaste = cancel;
      client.addEventListener("clipboardready", ready);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        // Notify/basic text must precede Ctrl+V on the ordered stream. An
        // extended peer can request Provide lazily only AFTER the application
        // receives Ctrl+V; waiting for Provide before keys deadlocks that peer.
        client.clipboardPasteFrom(text);
        if (!allowed()) { cancel(); return; }
        client.sendKey(0xffe3, "ControlLeft", true);
        if (!allowed()) { cancel(); return; }
        client.sendKey(0x76, "KeyV");
        if (!allowed()) { cancel(); return; }
        client.sendKey(0xffe3, "ControlLeft", false);
        keysSent = true;
        if (provided) { finish(); resolve(); }
      } catch { cancel(); }
    });
  }

  private setActive(active: boolean): void {
    if (this.closed || this.surfaceActive === active) return;
    this.surfaceActive = active;
    if (!active) this.disableInput();
    if (!this.closed) this.client?.setSurfaceActive(this.surfaceActive);
  }

  private disableInput(): void {
    this.pointerInput?.reset();
    this.clipboardInput?.reset();
    this.activeInput = null;
    this.textInput?.reset();
    this.cancelPaste?.();
    if (!this.client) return;
    this.client.viewOnly = true;
    this.client.clearClipboard();
    this.client.focusOnClick = false;
    this.client.blur();
  }

  private releaseLeases(): void {
    cleanup(() => this.disableInput());
    for (const lease of [...this.leases]) cleanup(() => lease.release());
  }

  close(retryable = false, failure: DesktopConnectionSnapshot["failure"] = "transport"): void {
    if (this.closed) return;
    if (failure === "transport") this.capturePreview();
    else this.preview = null;
    const resumeObserving = failure === "transport" && this.session.getTermination?.() === "control-released";
    this.closed = true;
    this.snapshot = { videoReady: false, inputReady: false, controlAvailable: false, ended: true,
      ...(resumeObserving ? { resumeObserving: true } : { failure, ...(retryable ? { retryable: true } : {}) }) };
    this.abort.abort();
    this.releaseLeases();
    for (const dispose of this.disposers.splice(0).reverse()) cleanup(dispose);
    const client = this.client, channel = this.channel;
    this.client = null; this.channel = null;
    this.pasteHandler = null;
    cleanup(() => client?.setSurfaceActive(false));
    cleanup(() => client?.disconnect());
    cleanup(() => channel?.close());
    cleanup(() => this.session.close());
    this.publish(this.snapshot);
    this.listeners.clear();
  }

  private publish(snapshot: DesktopConnectionSnapshot): void {
    this.snapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) listener();
  }
}

/** Transport/media implementation is product-free. The provider supplies only
 * authorized viewer sessions; no enterprise service, Account, Bot, resource or Shell routing. */
export function createRfbDesktopAdapter(load: () => Promise<RfbClientConstructor> = loadRfbClient): RfbDesktopAdapter {
  const connections = new WeakSet<RfbConnection>();
  return {
    async connect(session, signal) {
      let connection: RfbConnection | undefined;
      let sessionClosed = false;
      const releaseSession = () => {
        if (sessionClosed) return;
        sessionClosed = true;
        cleanup(() => session.close());
      };
      signal.addEventListener("abort", releaseSession, { once: true });
      try {
        signal.throwIfAborted();
        const Client = await load();
        signal.throwIfAborted();
        connection = new RfbConnection(session, Client);
        signal.removeEventListener("abort", releaseSession);
        connection.watch(signal);
        if (connection.getSnapshot().ended) throw new Error("Desktop connection retired");
        connections.add(connection);
        return connection;
      } catch (error) {
        if (connection) connection.close(); else releaseSession();
        throw error;
      } finally { signal.removeEventListener("abort", releaseSession); }
    },
    surfaces: { mount(element, connection) {
      if (!(connection instanceof RfbConnection) || !connections.has(connection)) {
        throw new Error("Desktop media adapter mismatch");
      }
      return connection.mount(element);
    } },
  };
}
