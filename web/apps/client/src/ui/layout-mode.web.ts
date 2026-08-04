import { createLayoutMode, type LayoutMode } from "./layout-mode.shared";

export type { LayoutMode };

// The complete desktop frame needs the product rail, the conversation column
// and a useful content canvas at the same time. The old 1100–1179px "medium"
// band kept the rail while shrinking the content, which looked compressed in
// browser zoom and split-screen windows. Treat that whole range as adaptive;
// only a genuinely wide canvas gets the persistent desktop frame.
export const layoutMode = createLayoutMode(1_180);
