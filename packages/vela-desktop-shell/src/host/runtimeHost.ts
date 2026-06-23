import type { RuntimeChromeHost } from "./capabilities/chrome";
import type { VoiceInputHost } from "./capabilities/voiceInput";
import type { WindowControlsHost } from "./capabilities/windowControls";
import type { RuntimePlatform } from "./capabilities/chrome";

export interface RuntimeHostBridge {
  platform: RuntimePlatform;
  chrome: RuntimeChromeHost;
  windowControls?: WindowControlsHost;
  voiceInput?: VoiceInputHost;
  shouldStartDrag(button: number, target: EventTarget | null): boolean;
  startWindowDrag(): Promise<void> | void;
  openWorkingDirectoryPicker?(): Promise<string | null>;
}

/** @deprecated Use RuntimeHostBridge. */
export type DesktopHostBridge = RuntimeHostBridge;
