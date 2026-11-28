export interface LifecycleWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible?(): boolean;
  hide(): void;
  show(): void;
  focus(): void;
  restore(): void;
  on(event: "close", listener: (event: { preventDefault(): void }) => void): unknown;
}

export type DesktopDockMode = "keep" | "menu-bar-only";
export type DesktopQuitSource = "app" | "tray";
export type DesktopQuitDecision = "quit" | "hide" | "cancel";

/** One owner for window residence and explicit application shutdown. */
export class DesktopLifecycle {
  private phase: "running" | "quitting" | "stopped" = "running";
  private opening: Promise<void> | null = null;
  private confirming: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private visibilityRevision = 0;

  constructor(private readonly ports: {
    getWindow(): LifecycleWindow | null;
    createWindow(): Promise<void>;
    showDock(): Promise<void>;
    hideDock(): void;
    dockMode?: () => DesktopDockMode;
    confirmQuit?: (source: DesktopQuitSource) => Promise<DesktopQuitDecision>;
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
    if (this.ports.dockMode?.() === "menu-bar-only") {
      this.ports.hideDock();
    }
  }

  async syncDock(): Promise<void> {
    if (this.quitting) return;
    if (this.ports.dockMode?.() === "menu-bar-only") {
      const window = this.ports.getWindow();
      const visible = window !== null && !window.isDestroyed() && (window.isVisible ? window.isVisible() : true);
      if (!visible) this.ports.hideDock();
      return;
    }
    await this.ports.showDock();
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

  requestQuit(source: DesktopQuitSource = "app"): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.confirming) return this.confirming;
    if (!this.ports.confirmQuit) return this.quit();
    const confirming = Promise.resolve()
      .then(async () => {
        const decision = await this.ports.confirmQuit!(source);
        if (this.quitting) return;
        if (decision === "quit") {
          await this.quit();
        } else if (decision === "hide") {
          this.hide();
        }
      })
      .catch(error => {
        this.ports.reportError(error);
      })
      .finally(() => {
        if (this.confirming === confirming) this.confirming = null;
      });
    this.confirming = confirming;
    return confirming;
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
