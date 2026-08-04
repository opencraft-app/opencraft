import { createLayoutMode, type LayoutMode } from "./layout-mode.shared";

export type { LayoutMode };

// Tablet split views follow the same content-driven threshold as Web. Below
// 1180px the interface reflows instead of preserving a rail that competes with
// the active management or conversation surface.
export const layoutMode = createLayoutMode(1_180);
