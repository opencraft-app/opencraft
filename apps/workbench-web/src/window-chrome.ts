import { useEffect, useState } from "react";

export type WindowChromeKind = "browser" | "electron";
export type WindowPlatform = "darwin" | "win32" | "linux";
export type HeaderNavigationAction =
  | "sidebar-toggle"
  | "new-task"
  | "back"
  | "forward";

export interface WindowChromePolicy {
  /**
   * Actions owned by the renderer's leading titlebar rail, in visual order.
   * Host distributions choose the rail once; leaf components do not branch on
   * Electron, browser, or operating-system identity.
   */
  leadingNavigationActions: readonly HeaderNavigationAction[];
}

export interface WindowChromeSnapshot {
  kind: WindowChromeKind;
  platform: WindowPlatform;
  safeArea: {
    left: number;
    right: number;
  };
}

interface WindowChromeDocumentRoot {
  readonly dataset: DOMStringMap;
}

interface WindowControlsOverlayLike extends EventTarget {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

interface WindowChromeInput {
  userAgent: string;
  navigatorPlatform: string;
  viewportWidth: number;
  kindOverride?: string;
  platformOverride?: string;
  fullscreenOverride?: string | boolean;
  safeAreaOverride?: {
    left?: string | number;
    right?: string | number;
  };
  overlay?: WindowControlsOverlayLike;
}

const MACOS_NATIVE_CONTROLS_SAFE_AREA = 78;
const HEADER_ACTION_SIZE = 28;
const HEADER_ACTION_GAP = 4;
const HEADER_ACTION_HORIZONTAL_PADDING = 16;

const WINDOW_CHROME_POLICIES = {
  browser: {
    leadingNavigationActions: ["sidebar-toggle"],
  },
  electron: {
    leadingNavigationActions: ["sidebar-toggle"],
  },
} as const satisfies Record<WindowChromeKind, WindowChromePolicy>;

function normalizePlatform(value: string): WindowPlatform {
  const normalized = value.toLowerCase();
  if (normalized.includes("mac") || normalized.includes("darwin")) return "darwin";
  if (normalized.includes("win")) return "win32";
  return "linux";
}

function readOverlayInsets(
  overlay: WindowControlsOverlayLike | undefined,
  viewportWidth: number,
): WindowChromeSnapshot["safeArea"] | null {
  if (overlay?.visible !== true) return null;
  const rect = overlay.getTitlebarAreaRect();
  return {
    left: Math.max(0, Math.round(rect.x)),
    right: Math.max(0, Math.round(viewportWidth - (rect.x + rect.width))),
  };
}

function readSafeAreaOverride(
  override: WindowChromeInput["safeAreaOverride"],
): WindowChromeSnapshot["safeArea"] | null {
  if (override === undefined) return null;
  const left = Number(override.left ?? 0);
  const right = Number(override.right ?? 0);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return {
    left: Math.max(0, left),
    right: Math.max(0, right),
  };
}

function readFullscreenOverride(value: WindowChromeInput["fullscreenOverride"]): boolean {
  return value === true || value === "true";
}

/**
 * Resolve renderer chrome separately from the AppServer host platform. A remote
 * macOS AppServer does not make a Windows or browser renderer a macOS window.
 */
export function resolveWindowChrome(input: WindowChromeInput): WindowChromeSnapshot {
  const kind: WindowChromeKind = input.kindOverride === "electron"
    || (input.kindOverride !== "browser" && /\bElectron\//i.test(input.userAgent))
    ? "electron"
    : "browser";
  const platform = normalizePlatform(input.platformOverride ?? input.navigatorPlatform ?? input.userAgent);
  const isFullScreen = kind === "electron" && readFullscreenOverride(input.fullscreenOverride);
  const overlayInsets = readOverlayInsets(input.overlay, input.viewportWidth);
  const hostInsets = kind === "electron" ? readSafeAreaOverride(input.safeAreaOverride) : null;

  // Native fullscreen removes the traffic-light reservation. The Electron
  // Main process owns this state and publishes it atomically; platform alone
  // can never determine the current titlebar geometry.
  if (isFullScreen) return { kind, platform, safeArea: { left: 0, right: 0 } };
  if (hostInsets !== null) return { kind, platform, safeArea: hostInsets };
  if (overlayInsets !== null) return { kind, platform, safeArea: overlayInsets };

  // Electron's macOS traffic lights are native interactive window chrome. The
  // Renderer reserves their hit region but never paints a second copy.
  if (kind === "electron" && platform === "darwin") {
    return {
      kind,
      platform,
      safeArea: { left: MACOS_NATIVE_CONTROLS_SAFE_AREA, right: 0 },
    };
  }

  return { kind, platform, safeArea: { left: 0, right: 0 } };
}

export function applyWindowChromeDocumentAttributes(
  root: WindowChromeDocumentRoot,
  snapshot: Pick<WindowChromeSnapshot, "kind" | "platform">,
): void {
  // This projection runs from a MutationObserver as well as resize events.
  // Rewriting an unchanged observed attribute would schedule itself forever.
  if (root.dataset.opencraftWindowType !== snapshot.kind) {
    root.dataset.opencraftWindowType = snapshot.kind;
  }
  if (root.dataset.opencraftPlatform !== snapshot.platform) {
    root.dataset.opencraftPlatform = snapshot.platform;
  }
}

export function getWindowChromePolicy(
  snapshot: Pick<WindowChromeSnapshot, "kind">,
): WindowChromePolicy {
  return WINDOW_CHROME_POLICIES[snapshot.kind];
}

function readWindowChrome(): WindowChromeSnapshot {
  const root = document.documentElement;
  const navigatorWithOverlay = navigator as Navigator & {
    windowControlsOverlay?: WindowControlsOverlayLike;
    userAgentData?: { platform?: string };
  };
  const snapshot = resolveWindowChrome({
    userAgent: navigator.userAgent,
    navigatorPlatform: navigatorWithOverlay.userAgentData?.platform
      ?? navigator.platform
      ?? navigator.userAgent,
    viewportWidth: window.innerWidth,
    kindOverride: root.dataset.opencraftWindowType,
    platformOverride: root.dataset.opencraftOs,
    fullscreenOverride: root.dataset.opencraftWindowFullscreen,
    safeAreaOverride: root.dataset.opencraftSafeHeaderLeft === undefined
      && root.dataset.opencraftSafeHeaderRight === undefined
      ? undefined
      : {
          left: root.dataset.opencraftSafeHeaderLeft,
          right: root.dataset.opencraftSafeHeaderRight,
        },
    overlay: navigatorWithOverlay.windowControlsOverlay,
  });
  applyWindowChromeDocumentAttributes(root, snapshot);
  return snapshot;
}

export function getHeaderStartMinimumWidth(
  snapshot: WindowChromeSnapshot,
  sidebarOpen = true,
): number {
  const policy = getWindowChromePolicy(snapshot);
  const actionCount = policy.leadingNavigationActions.length
    + Number(!sidebarOpen);
  const actionRailWidth = HEADER_ACTION_HORIZONTAL_PADDING
    + actionCount * HEADER_ACTION_SIZE
    + Math.max(0, actionCount - 1) * HEADER_ACTION_GAP;
  return snapshot.safeArea.left + actionRailWidth;
}

export function useWindowChrome(): WindowChromeSnapshot {
  const [snapshot, setSnapshot] = useState(readWindowChrome);

  useEffect(() => {
    const navigatorWithOverlay = navigator as Navigator & {
      windowControlsOverlay?: WindowControlsOverlayLike;
    };
    const overlay = navigatorWithOverlay.windowControlsOverlay;
    const update = () => setSnapshot(readWindowChrome());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        "data-opencraft-window-type",
        "data-opencraft-os",
        "data-opencraft-window-fullscreen",
        "data-opencraft-safe-header-left",
        "data-opencraft-safe-header-right",
      ],
    });
    window.addEventListener("resize", update);
    overlay?.addEventListener("geometrychange", update);
    return () => {
      window.removeEventListener("resize", update);
      overlay?.removeEventListener("geometrychange", update);
      observer.disconnect();
    };
  }, []);

  return snapshot;
}
