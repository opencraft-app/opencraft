export function shouldPresentMainComposerOverlay(fullWidth: boolean, activeTabId: string | null): boolean {
  return fullWidth && !activeTabId?.startsWith("sidechat:") && !activeTabId?.startsWith("background-agent:");
}
