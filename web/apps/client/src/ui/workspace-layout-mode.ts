import { createLayoutMode, type LayoutMode } from "./layout-mode.shared";
import { workspaceShellWideBreakpoint } from "./tokens";

export type { LayoutMode };

// Non-platform-aware tools exercise the Web workspace contract. Content
// screens continue to use layoutMode and its wider 1180px density threshold.
export const workspaceLayoutMode = createLayoutMode(
  workspaceShellWideBreakpoint,
);
