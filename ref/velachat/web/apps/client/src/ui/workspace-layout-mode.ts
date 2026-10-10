import { createLayoutMode, type LayoutMode } from "./layout-mode.shared";
import { workspaceShellWideBreakpoint } from "./tokens";

export type { LayoutMode };

// Non-platform-aware tools exercise the Web workspace contract. Management
// collection stacking uses this same 960px chrome threshold via
// managementSurfaceLayout — do not reintroduce a parallel 1180 cutover.
export const workspaceLayoutMode = createLayoutMode(
  workspaceShellWideBreakpoint,
);
