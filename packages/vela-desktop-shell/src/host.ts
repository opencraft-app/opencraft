export interface HostChromeSafeArea {
  isFullscreen: boolean;
  isMaximized: boolean;
  reserveTrafficLightGutter: boolean;
  toolbarCenterY: number;
  toolbarIconSize: number;
  leadingToolbarInset: number;
  toolbarSize: number;
}

export interface DesktopHostBridge {
  platform: "macos" | "windows" | "linux" | "browser";
  chrome: {
    showTrafficLights: boolean;
    canStartWindowDrag: boolean;
    safeArea: HostChromeSafeArea;
  };
  windowControls?: {
    leaveFullscreen?: () => Promise<void> | void;
  };
  shouldStartDrag(button: number, target: EventTarget | null): boolean;
  startWindowDrag(): Promise<void> | void;
  openWorkingDirectoryPicker?(): Promise<string | null>;
}

export const browserDesktopHostBridge: DesktopHostBridge = {
  platform: "browser",
  chrome: {
    showTrafficLights: true,
    canStartWindowDrag: false,
    safeArea: {
      isFullscreen: false,
      isMaximized: false,
      reserveTrafficLightGutter: true,
      toolbarCenterY: 28,
      toolbarIconSize: 24,
      leadingToolbarInset: 84,
      toolbarSize: 28,
    },
  },
  shouldStartDrag: () => false,
  startWindowDrag: () => undefined,
};
