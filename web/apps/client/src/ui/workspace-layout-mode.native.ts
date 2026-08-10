import { createLayoutMode, type LayoutMode } from "./layout-mode.shared";
import { workspaceShellWideBreakpoint } from "./tokens";

export type { LayoutMode };

// Tablet widths can keep persistent workspace navigation; management
// collection stacking shares this chrome threshold via managementSurfaceLayout.
export const workspaceLayoutMode = createLayoutMode(
  workspaceShellWideBreakpoint,
);
