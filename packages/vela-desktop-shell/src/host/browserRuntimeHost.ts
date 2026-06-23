import type { RuntimeHostBridge } from "./runtimeHost";

export const browserRuntimeHostBridge: RuntimeHostBridge = {
  platform: "web",
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

/** @deprecated Use browserRuntimeHostBridge. */
export const browserDesktopHostBridge = browserRuntimeHostBridge;
