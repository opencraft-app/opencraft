/** Application chrome state. Deliberately independent of Host, Thread and React. */
export type ShellNavigationSurface = "applications" | "account";
export interface ShellNavigationState {
  readonly pinned: Readonly<Record<ShellNavigationSurface, boolean>>;
  /** At most one transient surface; pinned surfaces are not transient windows. */
  readonly peek: ShellNavigationSurface | null;
}
export type ShellNavigationAction =
  | { readonly type: "toggle"; readonly surface: ShellNavigationSurface; readonly dockAvailable: boolean }
  | { readonly type: "pin"; readonly surface: ShellNavigationSurface; readonly pinned: boolean }
  | { readonly type: "dismiss"; readonly surface: ShellNavigationSurface };

export function createShellNavigationState(preferences?: unknown): ShellNavigationState {
  const value = preferences as { applications?: unknown; account?: unknown } | null;
  return {
    pinned: {
      applications: typeof value?.applications === "boolean" ? value.applications : false,
      account: typeof value?.account === "boolean" ? value.account : false,
    },
    peek: null,
  };
}

export function reduceShellNavigation(state: ShellNavigationState, action: ShellNavigationAction): ShellNavigationState {
  switch (action.type) {
    case "pin":
      return { pinned: { ...state.pinned, [action.surface]: action.pinned }, peek: null };
    case "dismiss":
      return state.peek === action.surface ? { ...state, peek: null } : state;
    case "toggle":
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
  readonly contentMinimumWidth: number;
  readonly hysteresis: number;
  readonly footerInset: number;
  readonly footerHeight: number;
}
export const shellNavigationMetrics: ShellNavigationMetrics = {
  columnWidth: 260,
  contentMinimumWidth: 420,
  hysteresis: 32,
  footerInset: 12,
  footerHeight: 44,
};

/** Platform adapters supply available width; resizing never changes preferences. */
export function projectShellNavigation(input: {
  readonly state: ShellNavigationState;
  readonly viewportWidth: number;
  readonly conversationWidth: number;
  readonly conversationOpen: boolean;
  readonly allowDock?: boolean;
  readonly previouslyAvailable?: boolean;
  readonly metrics?: ShellNavigationMetrics;
}) {
  const metrics = input.metrics ?? shellNavigationMetrics;
  const required = metrics.columnWidth + metrics.contentMinimumWidth
    + (input.conversationOpen ? input.conversationWidth : 0);
  const dockAvailable = input.allowDock !== false && input.viewportWidth >= required
    + (input.previouslyAvailable === false ? metrics.hysteresis : 0);
  const docked = {
    applications: dockAvailable && input.state.pinned.applications,
    account: dockAvailable && input.state.pinned.account,
  };
  return {
    dockAvailable,
    docked,
    dockOpen: docked.applications || docked.account,
    peek: input.state.peek !== null && !docked[input.state.peek] ? input.state.peek : null,
    // No pin state, column animation or conversation width may enter this value.
    footer: {
      left: metrics.footerInset,
      bottom: metrics.footerInset,
      width: Math.max(0, Math.min(metrics.columnWidth, input.viewportWidth) - 2 * metrics.footerInset),
      height: metrics.footerHeight,
    },
  };
}
