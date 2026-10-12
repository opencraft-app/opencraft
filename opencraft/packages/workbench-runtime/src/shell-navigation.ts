import { shellSpaceMetrics, type ShellSpaceProjection } from "./shell-space";
/** Application chrome state. Deliberately independent of Host, Thread and React. */
export type ShellNavigationSurface = "applications" | "account";
export type ShellNavigationVisibleDetent = "expanded" | "compact";
export type ShellNavigationRailDetent = ShellNavigationVisibleDetent | "hidden";
export interface ShellNavigationState {
  readonly pinned: Readonly<Record<ShellNavigationSurface, boolean>>;
  /** The physical rail detent is independent from the surfaces placed in it. */
  readonly railDetent: ShellNavigationRailDetent;
  /** Hiding is reversible and never destroys the user's last visible shelf. */
  readonly lastVisibleRailDetent: ShellNavigationVisibleDetent;
  /** At most one transient surface; pinned surfaces are not transient windows. */
  readonly peek: ShellNavigationSurface | null;
}
export type ShellNavigationAction =
  | { readonly type: "toggle"; readonly surface: ShellNavigationSurface; readonly dockAvailable: boolean }
  | { readonly type: "pin"; readonly surface: ShellNavigationSurface; readonly pinned: boolean }
  | { readonly type: "set-rail-detent"; readonly detent: ShellNavigationRailDetent }
  | { readonly type: "restore-preferences"; readonly preferences: unknown }
  | { readonly type: "dismiss"; readonly surface: ShellNavigationSurface };

export function createShellNavigationState(preferences?: unknown): ShellNavigationState {
  const value = preferences as {
    applications?: unknown;
    account?: unknown;
    railDetent?: unknown;
    lastVisibleRailDetent?: unknown;
  } | null;
  const railDetent: ShellNavigationRailDetent = value?.railDetent === "compact"
    || value?.railDetent === "hidden"
    ? value.railDetent
    : "expanded";
  const lastVisibleRailDetent: ShellNavigationVisibleDetent = railDetent !== "hidden"
    ? railDetent
    : value?.lastVisibleRailDetent === "compact" ? "compact" : "expanded";
  return {
    pinned: {
      applications: typeof value?.applications === "boolean" ? value.applications : false,
      account: typeof value?.account === "boolean" ? value.account : false,
    },
    railDetent,
    lastVisibleRailDetent,
    peek: null,
  };
}

export function reduceShellNavigation(state: ShellNavigationState, action: ShellNavigationAction): ShellNavigationState {
  switch (action.type) {
    case "restore-preferences":
      return createShellNavigationState(action.preferences);
    case "pin":
      return {
        ...state,
        pinned: { ...state.pinned, [action.surface]: action.pinned },
        railDetent: action.pinned && state.railDetent === "hidden"
          ? state.lastVisibleRailDetent
          : state.railDetent,
        peek: null,
      };
    case "set-rail-detent": {
      if (state.railDetent === action.detent) return state;
      return {
        ...state,
        railDetent: action.detent,
        lastVisibleRailDetent: action.detent === "hidden"
          ? state.lastVisibleRailDetent
          : action.detent,
        peek: null,
      };
    }
    case "dismiss":
      return state.peek === action.surface ? { ...state, peek: null } : state;
    case "toggle":
      // Applications are a direct sidebar toggle, not a menu followed by Pin.
      // Compact screens only toggle their drawer and preserve the wide preference.
      if (action.surface === "applications" && action.dockAvailable) {
        if (state.railDetent === "hidden") {
          return {
            ...state,
            pinned: { ...state.pinned, applications: true },
            railDetent: state.lastVisibleRailDetent,
            peek: null,
          };
        }
        return reduceShellNavigation(state, { type: "pin", surface: "applications", pinned: !state.pinned.applications });
      }
      // The pressed docked entrance is also an unpin action. On a small screen,
      // the same entrance opens the pinned content transiently, without erasing
      // the user's preference for its next wide-screen presentation.
      if (state.pinned[action.surface] && action.dockAvailable) {
        return reduceShellNavigation(state, { type: "pin", surface: action.surface, pinned: false });
      }
      return { ...state, peek: state.peek === action.surface ? null : action.surface };
  }
}

export interface ShellNavigationMetrics {
  readonly columnWidth: number;
  readonly compactWidth: number;
  readonly compactActionSize: number;
  readonly expandedMinimumWidth: number;
  readonly expandedMaximumWidth: number;
  readonly footerMinimumWidth: number;
  readonly contentMinimumWidth: number;
  readonly hysteresis: number;
  readonly footerInset: number;
  readonly footerHeight: number;
}
export const shellNavigationMetrics: ShellNavigationMetrics = {
  columnWidth: 137,
  compactWidth: 52,
  compactActionSize: 36,
  expandedMinimumWidth: 126,
  expandedMaximumWidth: 137,
  footerMinimumWidth: 260,
  contentMinimumWidth: 420,
  hysteresis: 32,
  footerInset: 12,
  footerHeight: 34,
};

export function resolveShellNavigationWidth(value: unknown, metrics = shellNavigationMetrics): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(metrics.expandedMinimumWidth, Math.min(metrics.expandedMaximumWidth, value))
    : metrics.columnWidth;
}

/** Platform adapters supply available width; resizing never changes preferences. */
export function projectShellNavigation(input: {
  readonly state: ShellNavigationState;
  readonly viewportWidth: number;
  readonly contextWidth: number;
  readonly contextAvailable: boolean;
  readonly sidecarOpen: boolean;
  readonly navigationWidth?: number;
  readonly allowDock?: boolean;
  readonly previouslyAvailable?: boolean;
  readonly metrics?: ShellNavigationMetrics;
  readonly space?: ShellSpaceProjection;
  /** One sidebar holds global destinations and the current application context. */
  readonly unified?: boolean;
}) {
  if (input.unified) {
    const open = input.space?.contextOpen ?? input.sidecarOpen;
    return {
      dockAvailable: false, railDetent: "hidden" as const,
      lastVisibleRailDetent: input.state.lastVisibleRailDetent,
      railVisible: false, railWidth: 0, contextOpen: open,
      primaryNavigation: false, docked: { applications: false, account: false },
      dockOpen: false, footerVisible: open, peek: input.state.peek === "account" ? "account" : null,
      footer: { left: shellNavigationMetrics.footerInset, bottom: shellNavigationMetrics.footerInset,
        right: shellNavigationMetrics.footerInset, height: shellNavigationMetrics.footerHeight },
    };
  }
  const metrics = input.metrics ?? shellNavigationMetrics;
  const expandedWidth = resolveShellNavigationWidth(input.navigationWidth, metrics);
  const contextOpen = input.space?.contextOpen ?? (input.sidecarOpen && input.contextAvailable);
  const railDetent = input.space?.navigationDetent ?? input.state.railDetent;
  const visibleRailWidth = input.state.lastVisibleRailDetent === "compact"
    ? metrics.compactWidth
    : expandedWidth;
  const railVisible = railDetent !== "hidden";
  const railWidth = railVisible
    ? railDetent === "compact" ? metrics.compactWidth : expandedWidth
    : 0;
  // Without application context, navigation is the single primary sidebar,
  // not an extra pinned column. Its visibility follows the Sidecar toggle.
  const primaryNavigation = !input.contextAvailable && input.allowDock !== false;
  const required = visibleRailWidth + metrics.contentMinimumWidth
    + (contextOpen ? input.contextWidth : 0);
  const dockAvailable = input.space !== undefined ? input.space.navigationOpen
      || (input.allowDock !== false && (!input.state.pinned.applications || input.state.railDetent === "hidden")
        && input.viewportWidth >= visibleRailWidth + (contextOpen ? input.contextWidth : 0)
          + shellSpaceMetrics.mainMinimum + (input.space.rightOpen ? shellSpaceMetrics.rightMinimum : 0)
          + shellSpaceMetrics.hysteresis)
    : input.allowDock !== false && input.viewportWidth >= required
      + (input.previouslyAvailable === false ? metrics.hysteresis : 0);
  const docked = {
    applications: railVisible && input.sidecarOpen && (primaryNavigation || dockAvailable && input.state.pinned.applications),
    account: railVisible && input.sidecarOpen && dockAvailable && input.state.pinned.account,
  };
  return {
    dockAvailable,
    railDetent,
    lastVisibleRailDetent: input.state.lastVisibleRailDetent,
    railVisible,
    railWidth,
    contextOpen,
    primaryNavigation,
    docked,
    dockOpen: docked.applications || docked.account,
    footerVisible: docked.applications || docked.account || contextOpen,
    peek: input.state.peek !== null && !docked[input.state.peek] ? input.state.peek : null,
    // Local frame within the Sidecar, not a window-level fixed anchor.
    // Fixed insets preserve the anchor. The platform owns the live first-rail
    // width, so the account item can fill its remainder even during resizing.
    footer: {
      left: metrics.footerInset,
      bottom: metrics.footerInset,
      right: metrics.footerInset,
      height: metrics.footerHeight,
    },
  };
}
