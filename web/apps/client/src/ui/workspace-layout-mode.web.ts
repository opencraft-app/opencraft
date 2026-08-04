import { createLayoutMode, type LayoutMode } from "./layout-mode.shared";
import { workspaceShellWideBreakpoint } from "./tokens";

export type { LayoutMode };

// At 960px the 72px rail and 312px conversation sidebar still leave a useful
// 576px message canvas. The content inside management screens remains compact
// until its independent 1180px breakpoint.
export const workspaceLayoutMode = createLayoutMode(
  workspaceShellWideBreakpoint,
);
