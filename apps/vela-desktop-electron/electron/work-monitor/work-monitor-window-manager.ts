import { BrowserWindow, screen, type Rectangle, type WebContents } from "electron";
import { sessionPreviewWindowSize } from "../session-preview";

export interface WorkMonitorWindowManagerOptions {
  getAnchorWindow?: () => BrowserWindow | null;
  loadRenderer: (
    window: BrowserWindow,
    query: Record<string, string>,
  ) => Promise<void>;
  preloadPath: string;
}

const workMonitorScreenMargin = 24;

export class WorkMonitorWindowManager {
  private window: BrowserWindow | null = null;
  private currentSessionId: string | null = null;
  private loadRequestId = 0;
  private loadingSessionId: string | null = null;
  private loadingPromise: Promise<void> | null = null;

  constructor(private readonly options: WorkMonitorWindowManagerOptions) {}

  async open(sessionId: string) {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return;
    const window = this.ensureWindow();
    if (this.currentSessionId === normalizedSessionId && !this.loadingPromise) {
      this.showWindow(window);
      return;
    }
    if (this.loadingPromise && this.loadingSessionId === normalizedSessionId) {
      await this.loadingPromise;
      if (!window.isDestroyed()) this.showWindow(window);
      return;
    }

    const requestId = ++this.loadRequestId;
    this.loadingSessionId = normalizedSessionId;
    const loadingPromise = this.options.loadRenderer(window, {
      window: "work-monitor",
      session_id: normalizedSessionId,
    });
    this.loadingPromise = loadingPromise;
    try {
      await loadingPromise;
    } catch (err) {
      if (requestId !== this.loadRequestId && isNavigationAbort(err)) return;
      throw err;
    } finally {
      if (this.loadRequestId === requestId) {
        this.loadingPromise = null;
        this.loadingSessionId = null;
      }
    }
    if (requestId !== this.loadRequestId) return;
    this.currentSessionId = normalizedSessionId;
    if (window.isDestroyed()) return;
    this.showWindow(window);
  }

  hide() {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    window.hide();
  }

  moveBySender(sender: WebContents, deltaX: number, deltaY: number) {
    const window = this.window;
    if (!window || window.isDestroyed() || window.webContents !== sender) {
      return false;
    }
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
      return false;
    }
    const bounds = window.getBounds();
    window.setPosition(
      Math.round(bounds.x + deltaX),
      Math.round(bounds.y + deltaY),
      false,
    );
    return true;
  }

  close() {
    const window = this.window;
    this.window = null;
    this.loadRequestId += 1;
    this.currentSessionId = null;
    this.loadingSessionId = null;
    this.loadingPromise = null;
    if (!window || window.isDestroyed()) return;
    window.close();
  }

  private ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = new BrowserWindow({
      width: sessionPreviewWindowSize.width,
      height: sessionPreviewWindowSize.height,
      minWidth: sessionPreviewWindowSize.width,
      minHeight: sessionPreviewWindowSize.height,
      frame: false,
      hasShadow: false,
      resizable: false,
      transparent: true,
      backgroundColor: "#00000000",
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      title: "Vela Work Monitor",
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.setHasShadow(false);
    window.setAlwaysOnTop(true, "floating");
    if (process.platform === "darwin") {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });
    this.window = window;
    return window;
  }

  private showWindow(window: BrowserWindow) {
    if (!window.isVisible()) {
      this.repositionNearAnchorWindow(window);
    }
    window.showInactive();
  }

  private repositionNearAnchorWindow(window: BrowserWindow) {
    const anchorWindow = this.options.getAnchorWindow?.();
    const anchorBounds = anchorWindow && !anchorWindow.isDestroyed()
      ? anchorWindow.getBounds()
      : null;
    const display = anchorBounds
      ? screen.getDisplayMatching(anchorBounds)
      : screen.getPrimaryDisplay();
    const position = workMonitorPositionInWorkArea(display.workArea);
    window.setBounds(
      {
        ...position,
        width: sessionPreviewWindowSize.width,
        height: sessionPreviewWindowSize.height,
      },
      false,
    );
  }
}

function workMonitorPositionInWorkArea(workArea: Rectangle): Pick<Rectangle, "x" | "y"> {
  const maxX = workArea.x + Math.max(0, workArea.width - sessionPreviewWindowSize.width);
  const maxY = workArea.y + Math.max(0, workArea.height - sessionPreviewWindowSize.height);
  const preferredX =
    workArea.x + workArea.width - sessionPreviewWindowSize.width - workMonitorScreenMargin;
  const preferredY =
    workArea.y + workArea.height - sessionPreviewWindowSize.height - workMonitorScreenMargin;
  return {
    x: Math.max(workArea.x, Math.min(maxX, preferredX)),
    y: Math.max(workArea.y, Math.min(maxY, preferredY)),
  };
}

function isNavigationAbort(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const entry = err as { code?: unknown; errno?: unknown };
  return entry.code === "ERR_ABORTED" || entry.errno === -3;
}
