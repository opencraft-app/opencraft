export interface LifecycleWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  hide(): void;
  show(): void;
  focus(): void;
  restore(): void;
  on(event: "close", listener: (event: { preventDefault(): void }) => void): unknown;
}

/** One owner for window residence and explicit application shutdown. */
export class DesktopLifecycle {
  private phase: "running" | "quitting" | "stopped" = "running";
  private opening: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private visibilityRevision = 0;
  constructor(private readonly ports: {
    getWindow(): LifecycleWindow | null;
    createWindow(): Promise<void>;
    showDock(): Promise<void>;
    hideDock(): void;
    stopRuntime(): Promise<void>;
    destroyTray(): void;
    exit(code: number): void;
    reportError(error: unknown): void;
  }) {}
  get quitting() { return this.phase !== "running"; }
  bindWindow(window: LifecycleWindow) {
    window.on("close", event => {
      if (this.quitting) return;
      event.preventDefault();
      this.hide();
    });
  }
  hide() {
    if (this.quitting) return;
    this.visibilityRevision++;
    const window = this.ports.getWindow();
    if (window && !window.isDestroyed()) window.hide();
    this.ports.hideDock();
  }
  show(): Promise<void> {
    if (this.quitting) return Promise.resolve();
    if (this.opening) return this.opening;
    const revision = ++this.visibilityRevision;
    const opening = Promise.resolve().then(async () => {
      await this.ports.showDock();
      if (this.quitting || revision !== this.visibilityRevision) return;
      const current = this.ports.getWindow();
      if (!current || current.isDestroyed()) await this.ports.createWindow();
      if (this.quitting || revision !== this.visibilityRevision) return;
      const window = this.ports.getWindow();
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }).finally(() => { if (this.opening === opening) this.opening = null; });
    this.opening = opening;
    return opening;
  }
  quit(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.phase = "quitting";
    this.visibilityRevision++;
    this.stopping = Promise.resolve().then(async () => {
      // Let an in-flight window bootstrap finish before releasing its resources.
      await this.opening?.catch(error => this.ports.reportError(error));
      let code = 0;
      try { await this.ports.stopRuntime(); }
      catch (error) { code = 1; this.ports.reportError(error); }
      finally {
        this.ports.destroyTray();
        this.phase = "stopped";
        this.ports.exit(code);
      }
    });
    return this.stopping;
  }
}
