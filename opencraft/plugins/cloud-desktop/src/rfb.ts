import type { DesktopConnection, DesktopConnectionSnapshot, DesktopControlLease } from "./contract";
import type { DesktopSurface, DesktopSurfaceFactory } from "./viewer";
import { loadRfbClient, type RfbClient, type RfbClientConstructor } from "./rfb-client";

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
  getTermination?(): "transport-lost" | "retired" | null;
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
  private pasteHandler: ((readText: () => Promise<string>) => void) | null = null;
  private cancelPaste: (() => void) | null = null;

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
      const ready = () => {
        if (this.closed) return;
        try { this.publish({ ...this.snapshot, inputReady: true,
          controlAvailable: this.session.control?.isAvailable() ?? false, ended: false }); }
        catch { this.close(); }
      };
      const firstFrame = () => {
        if (!this.closed && this.snapshot.inputReady) this.publish({ ...this.snapshot, videoReady: true });
      };
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
      const focus = () => { if (!this.closed && this.snapshot.videoReady) client.focus({ preventScroll: true }); };
      let pasteKey = false;
      const keyDown = (event: KeyboardEvent) => {
        if (this.session.control?.canPaste?.() === false || !this.activeInput?.isValid() || !this.pasteHandler || event.key.toLowerCase() !== "v"
          || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
        event.preventDefault(); event.stopImmediatePropagation(); pasteKey = true;
        if (event.repeat) return;
        // Read only on this focused surface's explicit user gesture. No polling
        // or unsolicited peer-to-local clipboard writes.
        this.pasteHandler(() => element.ownerDocument.defaultView!.navigator.clipboard.readText());
      };
      const keyUp = (event: KeyboardEvent) => {
        if (pasteKey && event.key.toLowerCase() === "v") {
          pasteKey = false; event.preventDefault(); event.stopImmediatePropagation();
        }
      };
      const paste = (event: ClipboardEvent) => {
        if (this.session.control?.canPaste?.() === false || !this.activeInput?.isValid() || !this.pasteHandler || !event.clipboardData) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const text = event.clipboardData.getData("text/plain");
        this.pasteHandler(async () => text);
      };
      element.addEventListener("pointerdown", focus, true);
      element.addEventListener("keydown", keyDown, true);
      element.addEventListener("keyup", keyUp, true);
      element.addEventListener("paste", paste, true);
      this.disposers.push(() => {
        element.removeEventListener("pointerdown", focus, true);
        element.removeEventListener("keydown", keyDown, true);
        element.removeEventListener("keyup", keyUp, true);
        element.removeEventListener("paste", paste, true);
      });
      const connection = this;
      return { enableInput: lease => this.enableInput(lease), disableInput: () => this.disableInput(),
        focus, setPasteHandler: handler => { this.pasteHandler = handler; },
        get pasteText() { return connection.session.control?.canPaste?.() === false ? undefined
          : (text: string, lease: DesktopControlLease, signal: AbortSignal) => connection.pasteText(text, lease, signal); },
        dispose: () => this.close() };
    } catch (error) { this.close(); throw error; }
  }

  async requestControl(signal: AbortSignal): Promise<DesktopControlLease> {
    if (this.closed || !this.snapshot.videoReady || !this.snapshot.controlAvailable
      || !this.session.control || this.leases.size || this.requesting) throw new Error("Desktop control is unavailable");
    const requestSignal = AbortSignal.any([signal, this.abort.signal]);
    requestSignal.throwIfAborted();
    this.requesting = true;
    let remote: DesktopControlLease;
    try { remote = await this.session.control.request(requestSignal); }
    finally { this.requesting = false; }
    if (this.closed || requestSignal.aborted || !this.snapshot.controlAvailable) {
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
  }

  private enableInput(lease: DesktopControlLease): void {
    if (!this.client || !this.snapshot.videoReady || !this.snapshot.controlAvailable
      || !this.leases.has(lease) || !lease.isValid()) throw new Error("Desktop control grant is unavailable");
    this.activeInput = lease;
    this.client.viewOnly = false;
    this.client.focusOnClick = true;
    // The controller focuses only after this exact lease has been confirmed.
  }

  private pasteText(text: string, lease: DesktopControlLease, signal: AbortSignal): Promise<void> {
    const client = this.client;
    const allowed = () => !this.closed && this.activeInput === lease && lease.isValid() && !signal.aborted;
    if (!client || !allowed() || this.cancelPaste || typeof text !== "string" || text.length > 16_384) {
      return Promise.reject(new Error("Desktop paste unavailable"));
    }
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer); client.removeEventListener("clipboardready", ready);
        signal.removeEventListener("abort", cancel); this.cancelPaste = null;
      };
      const cancel = () => { finish(); cleanup(() => client.clearClipboard()); reject(new Error("Desktop paste retired")); };
      const ready = () => {
        if (!allowed()) { cancel(); return; }
        finish();
        try {
          // Both basic ClientCutText and extended Provide are now SENT, not
          // merely requested. Paste keys follow on the same ordered RFB stream.
          client.sendKey(0xffe3, "ControlLeft", true);
          if (!allowed()) throw new Error("Desktop paste retired");
          client.sendKey(0x76, "KeyV");
          if (!allowed()) throw new Error("Desktop paste retired");
          client.sendKey(0xffe3, "ControlLeft", false);
          resolve();
        } catch (error) { reject(error); }
      };
      const timer = setTimeout(cancel, 5_000);
      this.cancelPaste = cancel;
      client.addEventListener("clipboardready", ready);
      signal.addEventListener("abort", cancel, { once: true });
      try { client.clipboardPasteFrom(text); } catch { cancel(); }
    });
  }

  private disableInput(): void {
    this.activeInput = null;
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
    this.closed = true;
    this.snapshot = { videoReady: false, inputReady: false, controlAvailable: false, ended: true,
      failure, ...(retryable ? { retryable: true } : {}) };
    this.abort.abort();
    this.releaseLeases();
    for (const dispose of this.disposers.splice(0).reverse()) cleanup(dispose);
    const client = this.client, channel = this.channel;
    this.client = null; this.channel = null;
    this.pasteHandler = null;
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
 * authorized viewer sessions; no TAT, Account, Bot, resource or Shell routing. */
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
