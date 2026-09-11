export const THREAD_EDGE_SCROLL_MINIMUM_WIDTH_REM = 96;
export const FALLBACK_ROOT_FONT_SIZE_PX = 16;

export type AppShellMainContentLayout = "default" | "thread-edge-scroll";

export interface AppShellMainContentChromeInput {
  readonly layout: AppShellMainContentLayout;
  readonly threadEdgeScrollEligible: boolean;
}

export interface AppShellMainContentChrome {
  readonly headerEdgeScroll: boolean;
  readonly threadEdgeDivider: boolean;
}

/**
 * Route layout owns the shell presentation. Geometry may only choose between
 * the two thread-edge-scroll presentations; it must never promote a default
 * route (settings, extensions, and other application pages) into thread mode.
 */
export function resolveAppShellMainContentChrome({
  layout,
  threadEdgeScrollEligible,
}: AppShellMainContentChromeInput): AppShellMainContentChrome {
  const threadEdgeScroll = layout === "thread-edge-scroll";
  return {
    headerEdgeScroll: threadEdgeScroll && threadEdgeScrollEligible,
    threadEdgeDivider: threadEdgeScroll && !threadEdgeScrollEligible,
  };
}

export interface ThreadEdgeScrollInput {
  readonly shellWidthPx: number;
  readonly rightChromeWidthPx: number;
  readonly rightPanelFullWidth: boolean;
  readonly rootFontSizePx: number;
}

export function resolveThreadEdgeScroll({
  shellWidthPx,
  rightChromeWidthPx,
  rightPanelFullWidth,
  rootFontSizePx,
}: ThreadEdgeScrollInput): boolean {
  if (rightPanelFullWidth) return false;
  const safeRootFontSize =
    Number.isFinite(rootFontSizePx) && rootFontSizePx > 0
      ? rootFontSizePx
      : FALLBACK_ROOT_FONT_SIZE_PX;
  // The left navigation is application chrome, not a competing content
  // surface. Opening or resizing it must not switch the conversation between
  // inset and immersive presentation. Compute from independent Shell/right
  // geometry, never a rounded DOM viewport plus a live left animation value:
  // those measurements can straddle frames and oscillate around the threshold.
  const conversationEnvelopeWidth =
    Math.max(0, shellWidthPx - Math.max(0, rightChromeWidthPx));
  return (
    conversationEnvelopeWidth >=
    THREAD_EDGE_SCROLL_MINIMUM_WIDTH_REM * safeRootFontSize
  );
}

export function readRootFontSizePx(
  root: Element = document.documentElement,
): number {
  const rootFontSize = Number.parseFloat(getComputedStyle(root).fontSize);
  return Number.isFinite(rootFontSize) && rootFontSize > 0
    ? rootFontSize
    : FALLBACK_ROOT_FONT_SIZE_PX;
}
