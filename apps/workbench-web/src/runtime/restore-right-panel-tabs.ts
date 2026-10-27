import type { WorkbenchPanelService } from "@opencraft/workbench-panels";

/** Compatibility only: the product no longer exposes a bottom outlet. */
export function restoreRightPanelTabs(panels: WorkbenchPanelService, ownerId: string): void {
  for (const tab of panels.getOwnerSnapshot(ownerId).bottom.tabs) {
    panels.dispatch(ownerId, { type: "transfer-tab", region: "bottom", targetRegion: "right", tabId: tab.id });
  }
}
