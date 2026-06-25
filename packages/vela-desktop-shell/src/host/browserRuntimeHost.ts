import type { RuntimeHostBridge } from "./runtimeHost";
import { createWebSpeechVoiceInputHost } from "./capabilities/webSpeechVoiceInput";

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
      leadingToolbarInset: 86,
      toolbarSize: 28,
    },
  },
  voiceInput: createWebSpeechVoiceInputHost(),
  shouldStartDrag: () => false,
  startWindowDrag: () => undefined,
};

/** @deprecated Use browserRuntimeHostBridge. */
export const browserDesktopHostBridge = browserRuntimeHostBridge;
