export type RuntimePlatform = "macos" | "windows" | "linux" | "ios" | "android" | "web" | "unknown";

export interface RuntimeChromeSafeArea {
  isFullscreen: boolean;
  isMaximized: boolean;
  reserveTrafficLightGutter: boolean;
  toolbarCenterY: number;
  toolbarIconSize: number;
  leadingToolbarInset: number;
  toolbarSize: number;
}

export interface RuntimeChromeHost {
  showTrafficLights: boolean;
  canStartWindowDrag: boolean;
  safeArea: RuntimeChromeSafeArea;
}

/** @deprecated Use RuntimeChromeSafeArea. */
export type HostChromeSafeArea = RuntimeChromeSafeArea;
