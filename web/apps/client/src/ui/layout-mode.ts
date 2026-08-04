import { createLayoutMode, type LayoutMode } from "./layout-mode.shared";
import { breakpoints } from "./tokens";

export type { LayoutMode };

// Non-platform-aware tools (including Jest) use the same content breakpoint as
// the Web and native builds so tests cannot validate the removed compressed
// middle band by accident.
export const layoutMode = createLayoutMode(breakpoints.wide);
