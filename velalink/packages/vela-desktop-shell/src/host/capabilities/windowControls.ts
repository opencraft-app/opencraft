export interface WindowControlsHost {
  leaveFullscreen?: () => Promise<void> | void;
}
