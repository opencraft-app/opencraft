// Behavior restored from Codex r1532:
// terminal/initialize-app-shell-drag-module-06089.ts and
// terminal/use-app-shell-layout-motion-04358.ts.

export const SIDEBAR_EDGE_REVEAL_WIDTH = 4;
export const SIDEBAR_TRIGGER_PEEK_DELAY_MS = 100;

export interface SidebarFloatingIntentInput {
  readonly docked: boolean;
  readonly currentlyRequested: boolean;
  readonly pointerX: number | null;
  readonly panelWidth: number;
  readonly triggerPeeked: boolean;
  readonly triggerSuppressed: boolean;
}

export type SidebarPresentation =
  | "docked"
  | "layout-transition"
  | "floating"
  | "hidden";

export interface SidebarPresentationInput {
  readonly docked: boolean;
  readonly layoutMounted: boolean;
  readonly layoutResizing: boolean;
  readonly floatingRequested: boolean;
  readonly floatingResizing: boolean;
}

export interface FloatingSidebarPresenceOwnerInput {
  readonly docked: boolean;
  readonly layoutMounted: boolean;
  readonly layoutResizing: boolean;
}

/**
 * The closed panel has a deliberately narrow acquisition target. Once open,
 * the entire panel width becomes the retention target. This hysteresis is the
 * reason Codex's edge reveal feels intentional instead of twitchy.
 */
export function resolveSidebarFloatingIntent({
  docked,
  currentlyRequested,
  pointerX,
  panelWidth,
  triggerPeeked,
  triggerSuppressed,
}: SidebarFloatingIntentInput): boolean {
  if (docked || triggerSuppressed) return false;
  if (triggerPeeked) return true;
  if (pointerX === null || pointerX < 0) return false;

  const acquisitionWidth = currentlyRequested
    ? Math.max(0, panelWidth)
    : SIDEBAR_EDGE_REVEAL_WIDTH;
  return pointerX <= acquisitionWidth;
}

/** Layout presence owns the transition; the floating panel may mount only
 * after the layout panel is fully gone. */
export function resolveSidebarPresentation({
  docked,
  layoutMounted,
  layoutResizing,
  floatingRequested,
  floatingResizing,
}: SidebarPresentationInput): SidebarPresentation {
  if (docked) return "docked";
  if (layoutMounted || layoutResizing) return "layout-transition";
  if (floatingRequested || floatingResizing) return "floating";
  return "hidden";
}

/**
 * The floating panel owns its own pointer-leave exit animation while the
 * sidebar is undocked. A dock transaction removes that presence owner itself,
 * so an invisible exiting overlay cannot keep the persistent toolbar from
 * receiving hover. This is a different lifetime from floating visibility.
 */
export function shouldMountFloatingSidebarPresenceOwner({
  docked,
  layoutMounted,
  layoutResizing,
}: FloatingSidebarPresenceOwnerInput): boolean {
  return !docked && !layoutMounted && !layoutResizing;
}
