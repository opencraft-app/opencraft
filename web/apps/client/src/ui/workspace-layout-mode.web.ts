import { createLayoutMode, type LayoutMode } from "./layout-mode.shared";
import { workspaceShellWideBreakpoint } from "./tokens";

export type { LayoutMode };

// At 960px the 72px rail and 312px conversation sidebar still leave a useful
// 576px message canvas. Management collection stacking shares this threshold
// via managementSurfaceLayout.
export const workspaceLayoutMode = createLayoutMode(
  workspaceShellWideBreakpoint,
);
