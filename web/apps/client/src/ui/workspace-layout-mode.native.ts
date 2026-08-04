import { createLayoutMode, type LayoutMode } from "./layout-mode.shared";
import { workspaceShellWideBreakpoint } from "./tokens";

export type { LayoutMode };

// Tablet widths can keep persistent workspace navigation while management
// content independently remains stacked until its 1180px density threshold.
export const workspaceLayoutMode = createLayoutMode(
  workspaceShellWideBreakpoint,
);
