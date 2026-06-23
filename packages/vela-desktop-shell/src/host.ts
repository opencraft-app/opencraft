export interface DesktopHostBridge {
  platform: "macos" | "windows" | "linux" | "browser";
  chrome: {
    showTrafficLights: boolean;
    canStartWindowDrag: boolean;
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
  },
  shouldStartDrag: () => false,
  startWindowDrag: () => undefined,
};
