import {
  BrowserWindow,
  screen,
  type Display,
  type Rectangle,
  type WebContents,
} from "electron";
import { sessionPreviewWindowSize } from "../session-preview";

export interface WorkMonitorWindowManagerOptions {
  getAnchorWindow?: () => BrowserWindow | null;
  loadRenderer: (
    window: BrowserWindow,
    query: Record<string, string>,
  ) => Promise<void>;
  preloadPath: string;
}

export interface WorkMonitorPoint {
  screenX: number;
  screenY: number;
}

interface WorkMonitorWindowRecord {
  loaded: boolean;
  loadingPromise: Promise<void> | null;
  loadRequestId: number;
  window: BrowserWindow;
}

const workMonitorScreenMargin = 24;
const workMonitorStackGap = 12;
const workMonitorPointerOffset = {
  x: 18,
  y: 16,
};
const workMonitorPointerScreenInsetPx = 8;

export class WorkMonitorWindowManager {
  private readonly windowsBySessionId = new Map<string, WorkMonitorWindowRecord>();
  private activeDragPreviewSessionId: string | null = null;

  constructor(private readonly options: WorkMonitorWindowManagerOptions) {}

  async open(sessionId: string) {
    return this.openWithPlacement(sessionId, null);
  }

  async openAtPoint(sessionId: string, point: WorkMonitorPoint) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId || !isFinitePoint(point)) return false;
    const accepted = await this.openWithPlacement(normalizedSessionId, point);
    if (accepted) this.activeDragPreviewSessionId = normalizedSessionId;
    return accepted;
  }

  moveToPoint(point: WorkMonitorPoint) {
    const activeSessionId = this.activeDragPreviewSessionId;
    if (!activeSessionId) return false;
    const window = this.windowsBySessionId.get(activeSessionId)?.window;
    return Boolean(window && this.moveWindowToPoint(window, point));
  }

  endSessionDragPreview() {
    this.activeDragPreviewSessionId = null;
  }

  private async openWithPlacement(sessionId: string, point: WorkMonitorPoint | null) {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) return false;
    const record = this.ensureRecord(normalizedSessionId);
    const window = record.window;
    if (point) this.moveWindowToPoint(window, point);
    if (record.loaded && !record.loadingPromise) {
      this.showWindow(window);
      return true;
    }
    if (record.loadingPromise) {
      await record.loadingPromise;
      if (!window.isDestroyed()) this.showWindow(window);
      return !window.isDestroyed();
    }

    const requestId = ++record.loadRequestId;
    record.loaded = false;
    const loadingPromise = this.options.loadRenderer(window, {
      window: "work-monitor",
      session_id: normalizedSessionId,
    });
    record.loadingPromise = loadingPromise;
    try {
      await loadingPromise;
    } catch (err) {
      if (requestId !== record.loadRequestId && isNavigationAbort(err)) return false;
      throw err;
    } finally {
      if (record.loadRequestId === requestId) {
        record.loadingPromise = null;
      }
    }
    if (requestId !== record.loadRequestId) return false;
    record.loaded = true;
    if (window.isDestroyed()) return false;
    if (point) this.moveWindowToPoint(window, point);
    this.showWindow(window);
    return true;
  }

  private moveWindowToPoint(window: BrowserWindow, point: WorkMonitorPoint) {
    if (window.isDestroyed() || !isFinitePoint(point)) return false;
    const position = workMonitorPositionNearPoint(point);
    window.setBounds(
      {
        ...position,
        width: sessionPreviewWindowSize.width,
        height: sessionPreviewWindowSize.height,
      },
      false,
    );
    return true;
  }

  hide() {
    for (const { window } of this.windowsBySessionId.values()) {
      if (!window.isDestroyed()) window.hide();
    }
  }

  moveBySender(sender: WebContents, deltaX: number, deltaY: number) {
    const window = this.findWindowBySender(sender);
    if (!window) return false;
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
    const records = [...this.windowsBySessionId.values()];
    this.windowsBySessionId.clear();
    this.activeDragPreviewSessionId = null;
    for (const record of records) {
      record.loadRequestId += 1;
      record.loadingPromise = null;
      record.loaded = false;
      if (!record.window.isDestroyed()) record.window.close();
    }
  }

  private ensureRecord(sessionId: string) {
    const existingRecord = this.windowsBySessionId.get(sessionId);
    if (existingRecord && !existingRecord.window.isDestroyed()) return existingRecord;
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
    const record: WorkMonitorWindowRecord = {
      loaded: false,
      loadingPromise: null,
      loadRequestId: 0,
      window,
    };
    window.setHasShadow(false);
    window.setAlwaysOnTop(true, "floating");
    if (process.platform === "darwin") {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    window.on("closed", () => {
      const currentRecord = this.windowsBySessionId.get(sessionId);
      if (currentRecord?.window === window) this.windowsBySessionId.delete(sessionId);
      if (this.activeDragPreviewSessionId === sessionId) {
        this.activeDragPreviewSessionId = null;
      }
    });
    this.windowsBySessionId.set(sessionId, record);
    return record;
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
    const stackSlotIndex = this.visibleWindowCountForDisplay(display, window);
    const position = workMonitorPositionInWorkArea(display.workArea, stackSlotIndex);
    window.setBounds(
      {
        ...position,
        width: sessionPreviewWindowSize.width,
        height: sessionPreviewWindowSize.height,
      },
      false,
    );
  }

  private visibleWindowCountForDisplay(display: Display, exceptWindow: BrowserWindow) {
    let count = 0;
    for (const { window } of this.windowsBySessionId.values()) {
      if (window === exceptWindow || window.isDestroyed() || !window.isVisible()) continue;
      const windowDisplay = screen.getDisplayMatching(window.getBounds());
      if (windowDisplay.id === display.id) count += 1;
    }
    return count;
  }

  private findWindowBySender(sender: WebContents) {
    for (const { window } of this.windowsBySessionId.values()) {
      if (!window.isDestroyed() && window.webContents === sender) return window;
    }
    return null;
  }
}

function workMonitorPositionInWorkArea(
  workArea: Rectangle,
  stackSlotIndex = 0,
): Pick<Rectangle, "x" | "y"> {
  const slotIndex = Math.max(0, Math.floor(stackSlotIndex));
  const rowCapacity = Math.max(
    1,
    Math.floor(
      (workArea.height - workMonitorScreenMargin * 2 + workMonitorStackGap) /
        (sessionPreviewWindowSize.height + workMonitorStackGap),
    ),
  );
  const column = Math.floor(slotIndex / rowCapacity);
  const row = slotIndex % rowCapacity;
  const maxX = workArea.x + Math.max(0, workArea.width - sessionPreviewWindowSize.width);
  const maxY = workArea.y + Math.max(0, workArea.height - sessionPreviewWindowSize.height);
  const preferredX =
    workArea.x +
    workArea.width -
    sessionPreviewWindowSize.width -
    workMonitorScreenMargin -
    column * (sessionPreviewWindowSize.width + workMonitorStackGap);
  const preferredY =
    workArea.y +
    workArea.height -
    sessionPreviewWindowSize.height -
    workMonitorScreenMargin -
    row * (sessionPreviewWindowSize.height + workMonitorStackGap);
  return {
    x: Math.max(workArea.x, Math.min(maxX, preferredX)),
    y: Math.max(workArea.y, Math.min(maxY, preferredY)),
  };
}

function workMonitorPositionNearPoint(point: WorkMonitorPoint): Pick<Rectangle, "x" | "y"> {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(point.screenX),
    y: Math.round(point.screenY),
  });
  const workArea = display.workArea;
  const maxX = workArea.x + Math.max(0, workArea.width - sessionPreviewWindowSize.width);
  const maxY = workArea.y + Math.max(0, workArea.height - sessionPreviewWindowSize.height);
  return {
    x: clamp(
      Math.round(point.screenX + workMonitorPointerOffset.x),
      workArea.x + workMonitorPointerScreenInsetPx,
      maxX - workMonitorPointerScreenInsetPx,
    ),
    y: clamp(
      Math.round(point.screenY + workMonitorPointerOffset.y),
      workArea.y + workMonitorPointerScreenInsetPx,
      maxY - workMonitorPointerScreenInsetPx,
    ),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function isFinitePoint(point: WorkMonitorPoint) {
  return Number.isFinite(point.screenX) && Number.isFinite(point.screenY);
}

function normalizeSessionId(sessionId: string) {
  const normalizedSessionId = sessionId.trim();
  return normalizedSessionId.length > 0 ? normalizedSessionId : null;
}

function isNavigationAbort(err: unknown) {
  if (!err || typeof err !== "object") return false;
  const entry = err as { code?: unknown; errno?: unknown };
  return entry.code === "ERR_ABORTED" || entry.errno === -3;
}
