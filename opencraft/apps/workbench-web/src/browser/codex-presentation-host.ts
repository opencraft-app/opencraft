import type { BrowserViewportLayout } from "@opencraft/browser-core";
type Value = Record<string, any>;
export interface PresentationHostPort {
  readonly container: HTMLElement;
  readonly guest: HTMLElement;
  readonly ready: Promise<void>;
  commit(layout: BrowserViewportLayout, visible: boolean): void;
  park(): void;
  close(): void;
  clearCover(): void;
  cover(layout: BrowserViewportLayout): void;
}

/** Standard DOM/guest port for the unmodified Codex transition state machine. */
export class CodexPresentationHost {
  private state: Value = { isVisible: false, mountGeneration: 0 };
  private reference: any = null;
  private registered = false;
  private disposed = false;
  private blocked = false;
  private automationBlocked = false;
  private staged = false;
  private listeners = new Set<() => void>();
  private layout: BrowserViewportLayout | null = null;
  private browserUseActive = false;
  private captureActive = false;
  private browserViewport: { width: number; height: number } | null = null;
  private captureViewport: { width: number; height: number } | null = null;
  constructor(private options: Value, private readonly port: PresentationHostPort) { port.container.style.zIndex = "1"; }
  getConversationId() { return this.options.conversationId; }
  getBrowserTabId() { return this.options.browserTabId; }
  getPartition() { return this.options.partition; }
  getHostGeneration() { return this.options.hostGeneration; }
  getMountGeneration() { return this.state.mountGeneration; }
  getCursorOverlayHost() { return null; }
  setBrowserUseActive(active: boolean) { this.browserUseActive = active; this.resync(); }
  setTabCaptureActive(active: boolean) { this.captureActive = active; this.resync(); }
  setBrowserUseViewportSize(size: { width: number; height: number } | null) { this.browserViewport = size; this.resync(); }
  setBrowserUseCaptureSurfaceSize(size: { width: number; height: number } | null) { this.captureViewport = size; this.resync(); }
  releaseBrowserUse() { this.browserUseActive = false; this.browserViewport = null; this.captureViewport = null; this.resync(); }
  whenReady() { return this.port.ready; }
  isConnected() { return !this.disposed && this.port.container.isConnected; }
  isPainted() { return this.isConnected() && this.registered && this.state.isVisible; }
  setHostKind(value: string) { this.options.hostKind = value; }
  setPagePersistence(value: Value) {
    const changed = JSON.stringify(value) !== JSON.stringify(this.options.pagePersistence);
    this.options.pagePersistence = value;
    return changed;
  }
  setAdoptionAttributes(lease: unknown, id: unknown) {
    if (lease != null || id != null) throw new Error("Owl WebContents adoption is not supported");
  }
  markRegistered() {
    if (this.disposed || this.registered) return false;
    this.registered = true;
    this.resync();
    for (const listener of this.listeners) listener();
    return true;
  }
  listenForDidRegister(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  sync(state: Value, reference: any) {
    if (this.disposed || state.mountGeneration < this.state.mountGeneration) return;
    this.state = state; this.reference = reference; this.layout = state.layout;
    this.blocked = false; this.staged = false; this.port.clearCover(); this.resync();
  }
  stage(state: Value, reference: any) {
    if (this.disposed || state.mountGeneration < this.state.mountGeneration) return;
    this.state = state; this.reference = reference; this.layout = state.layout;
    this.blocked = true; this.staged = true; this.port.clearCover(); this.resync();
  }
  reveal(reference: any, blocked = false) { this.reference = reference; this.staged = false; this.blocked = blocked; this.resync(); }
  finishReveal() {
    this.blocked = false; this.staged = false; this.port.container.style.zIndex = "1";
    this.port.clearCover(); this.resync(); this.focus();
  }
  releaseRef(reference: any, generation: number) {
    if (generation === this.state.mountGeneration && reference === this.reference) this.reference = null;
  }
  detach(reference: any, generation: number) {
    if (this.disposed || generation !== this.state.mountGeneration) return;
    if (this.reference && this.reference !== reference) return;
    this.state = { ...this.state, isVisible: false };
    this.reference = null; this.blocked = false; this.port.clearCover(); this.port.park();
  }
  blockInteraction() { this.blocked = true; this.port.container.style.pointerEvents = "none"; }
  setAutomationActive(active: boolean) { this.automationBlocked = active; this.resync(); }
  restoreInteraction() { this.blocked = false; this.resync(); }
  expandToCoverStagedBounds(bounds: Value) {
    if (!this.layout || !bounds) return;
    const old = this.layout.visualBounds;
    const x = Math.min(old.x, bounds.x), y = Math.min(old.y, bounds.y);
    this.port.cover({ ...this.layout, visualBounds: { x, y,
      width: Math.max(old.x + old.width, bounds.x + bounds.width) - x,
      height: Math.max(old.y + old.height, bounds.y + bounds.height) - y } });
  }
  clearStagedCoverBounds() { this.port.clearCover(); }
  placeImmediatelyBehind(other: CodexPresentationHost) {
    // CSS stacking changes do not detach/reparent the guest WebContents.
    const layer = Number(other.port.container.style.zIndex || "1");
    this.port.container.style.zIndex = String(layer - 1);
  }
  focus(allowed: () => boolean = () => true) {
    const active = document.activeElement;
    if (allowed() && this.isPainted() && !this.blocked && !this.automationBlocked
      && (!active || active === document.body || active === document.documentElement
        || active.tagName === "WEBVIEW" && active !== this.port.guest)) this.port.guest.focus();
  }
  hasFocus() { return document.activeElement === this.port.guest; }
  resync() {
    if (this.disposed || !this.registered) return;
    if (!this.layout && (this.browserUseActive || this.captureActive)) {
      const size = this.captureViewport ?? this.browserViewport;
      if (size) this.layout = { visualBounds: {x:0,y:0,...size}, stageBounds: {x:0,y:0,...size}, viewportSize:size, scale:1 };
    }
    if (!this.layout) return;
    if (!this.state.isVisible) {
      const viewport = this.captureViewport ?? this.browserViewport;
      if ((this.browserUseActive || this.captureActive) && viewport) {
        this.port.commit({ ...this.layout, viewportSize: viewport }, false);
      } else this.port.park();
      return;
    }
    this.port.commit(this.layout, !this.staged);
    if (this.blocked || this.automationBlocked) this.port.container.style.pointerEvents = "none";
    else this.focus();
  }
  transfer(options: Value) { this.options = { ...this.options, ...options }; }
  dispose() { if (this.disposed) return; this.disposed = true; this.port.clearCover(); this.port.close(); this.listeners.clear(); }
}
