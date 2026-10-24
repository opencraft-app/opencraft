

export const SIDEBAR_EDGE_REVEAL_WIDTH = 4;
export const SIDEBAR_TRIGGER_PEEK_DELAY_MS = 100;

/** Only a real mouse movement may acquire the transient hover presentation. */
export function canHoverRevealSidebar(pointerType: string): boolean {
  return pointerType === "mouse";
}

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

/** Project pointer acquisition and retention; the caller owns trigger state. */
export function resolveSidebarFloatingIntent(input: SidebarFloatingIntentInput): boolean {
  if (input.docked || input.triggerSuppressed) return false;
  if (input.triggerPeeked) return true;

  const limit = input.currentlyRequested
    ? Math.max(0, input.panelWidth)
    : SIDEBAR_EDGE_REVEAL_WIDTH;
  const x = input.pointerX;
  return x !== null && x >= 0 && x <= limit;
}

/** Resolve the surface after honoring existing layout ownership. */
export function resolveSidebarPresentation(input: SidebarPresentationInput): SidebarPresentation {
  if (input.docked) return "docked";

  const layoutOwnsSurface = input.layoutMounted || input.layoutResizing;
  const floatingOwnsSurface = input.floatingRequested || input.floatingResizing;
  return layoutOwnsSurface
    ? "layout-transition"
    : floatingOwnsSurface ? "floating" : "hidden";
}

/** Visibility may exit independently once no docked layout owner remains. */
export function shouldMountFloatingSidebarPresenceOwner(input: FloatingSidebarPresenceOwnerInput): boolean {
  return input.docked === false
    && input.layoutMounted === false
    && input.layoutResizing === false;
}

/** Unified Shell has explicit dock/drawer commands; hover never owns its visibility. */
export function resolveSidebarToggleAction(input: {
  readonly docked: boolean; readonly drawerOpen: boolean; readonly canDock: boolean;
}): "collapse" | "expand" | "open-drawer" | "close-drawer" {
  if (input.drawerOpen) return "close-drawer";
  if (input.docked) return "collapse";
  return input.canDock ? "expand" : "open-drawer";
}
