import { BrowserWindow, screen, type Rectangle } from "electron";

export interface SessionDragPreviewWindowManagerOptions {
  loadRenderer: (
    window: BrowserWindow,
    query: Record<string, string>,
  ) => Promise<void>;
  preloadPath: string;
}

export interface SessionDragPreviewPoint {
  screenX: number;
  screenY: number;
}

const sessionDragPreviewSize = {
  width: 292,
  height: 184,
};

const sessionDragPreviewOffset = {
  x: 18,
  y: 16,
};

const screenInsetPx = 8;

export class SessionDragPreviewWindowManager {
  private currentSessionId: string | null = null;
  private loadRequestId = 0;
  private loadingPromise: Promise<void> | null = null;
  private loadingSessionId: string | null = null;
  private window: BrowserWindow | null = null;

  constructor(private readonly options: SessionDragPreviewWindowManagerOptions) {}

  async start(sessionId: string, point: SessionDragPreviewPoint) {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId || !isFinitePoint(point)) return false;
    const window = this.ensureWindow();
    this.move(point);

    if (this.currentSessionId === normalizedSessionId && !this.loadingPromise) {
      this.showWindow(window);
      return true;
    }
    if (this.loadingPromise && this.loadingSessionId === normalizedSessionId) {
      await this.loadingPromise;
      if (!window.isDestroyed()) this.showWindow(window);
      return true;
    }

    const requestId = ++this.loadRequestId;
    this.loadingSessionId = normalizedSessionId;
    const loadingPromise = this.options.loadRenderer(window, {
      window: "session-drag-preview",
      session_id: normalizedSessionId,
    });
    this.loadingPromise = loadingPromise;
    try {
      await loadingPromise;
    } catch (err) {
      if (requestId !== this.loadRequestId && isNavigationAbort(err)) return true;
      throw err;
    } finally {
      if (this.loadRequestId === requestId) {
        this.loadingPromise = null;
        this.loadingSessionId = null;
      }
    }
    if (requestId !== this.loadRequestId || window.isDestroyed()) return true;
    this.currentSessionId = normalizedSessionId;
    this.showWindow(window);
    return true;
  }

  move(point: SessionDragPreviewPoint) {
    const window = this.window;
    if (!window || window.isDestroyed() || !isFinitePoint(point)) return false;
    const position = sessionDragPreviewPosition(point);
    window.setBounds(
      {
        ...position,
        width: sessionDragPreviewSize.width,
        height: sessionDragPreviewSize.height,
      },
      false,
    );
    return true;
  }

  end() {
    const window = this.window;
    this.loadRequestId += 1;
    this.loadingPromise = null;
    this.loadingSessionId = null;
    if (!window || window.isDestroyed()) return;
    window.hide();
  }

  close() {
    const window = this.window;
    this.window = null;
    this.currentSessionId = null;
    this.loadRequestId += 1;
    this.loadingPromise = null;
    this.loadingSessionId = null;
    if (!window || window.isDestroyed()) return;
    window.close();
  }

  private ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = new BrowserWindow({
      width: sessionDragPreviewSize.width,
      height: sessionDragPreviewSize.height,
      minWidth: sessionDragPreviewSize.width,
      minHeight: sessionDragPreviewSize.height,
      frame: false,
      hasShadow: false,
      resizable: false,
      transparent: true,
      backgroundColor: "#00000000",
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      title: "Vela Session Drag Preview",
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.setHasShadow(false);
    window.setAlwaysOnTop(true, "floating");
    window.setIgnoreMouseEvents(true);
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
    window.showInactive();
  }
}

function sessionDragPreviewPosition(point: SessionDragPreviewPoint): Pick<Rectangle, "x" | "y"> {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(point.screenX),
    y: Math.round(point.screenY),
  });
  const workArea = display.workArea;
  const maxX = workArea.x + Math.max(0, workArea.width - sessionDragPreviewSize.width);
  const maxY = workArea.y + Math.max(0, workArea.height - sessionDragPreviewSize.height);
  return {
    x: clamp(Math.round(point.screenX + sessionDragPreviewOffset.x), workArea.x + screenInsetPx, maxX - screenInsetPx),
    y: clamp(Math.round(point.screenY + sessionDragPreviewOffset.y), workArea.y + screenInsetPx, maxY - screenInsetPx),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function isFinitePoint(point: SessionDragPreviewPoint) {
  return Number.isFinite(point.screenX) && Number.isFinite(point.screenY);
}

function isNavigationAbort(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const entry = err as { code?: unknown; errno?: unknown };
  return entry.code === "ERR_ABORTED" || entry.errno === -3;
}
