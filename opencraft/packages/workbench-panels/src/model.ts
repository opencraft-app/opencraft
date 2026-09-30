export const RIGHT_PANEL_MINIMUM_WIDTH = 320;
// Codex deliberately separates the visible minimum from the magnetic close
// shelf. app-shell-right-panel-06052 compares against
// scalePanelDimension(320), whose recovered AppShell scale is 0.5. Width
// normalization still clamps to 320, so the pointer can travel through the
// 320–160px corridor without moving panel chrome before visibility flips.
const RIGHT_PANEL_MAGNETIC_SHELF_SCALE = 0.5;
export const RIGHT_PANEL_COLLAPSE_SHELF =
  RIGHT_PANEL_MINIMUM_WIDTH * RIGHT_PANEL_MAGNETIC_SHELF_SCALE;
export const RIGHT_PANEL_MAIN_CONTENT_RESERVE = 352;
export const RIGHT_PANEL_DEFAULT_MAIN_CONTENT_RESERVE = 500;
export const RIGHT_PANEL_MAXIMUM_PREFERRED_WIDTH = 640;
export const RIGHT_PANEL_ASPECT_RATIO = 16 / 10;
export const RIGHT_PANEL_TABLET_BREAKPOINT = 960;
export const RIGHT_PANEL_SMALL_BREAKPOINT = 720;

export type PanelRegionId = "right" | "bottom";

export interface DurablePanelRoute {
  readonly kind: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly payloadVersion: number;
}

/** Serializable tab identity. React components and callbacks never enter this model. */
export interface PanelTabDescriptor {
  readonly id: string;
  readonly kind: string;
  readonly region: PanelRegionId;
  readonly title: string;
  readonly icon?: string;
  /** Explicitly opt in to showing the icon in the panel tab strip. */
  readonly showTabIcon?: boolean;
  readonly resource?: string;
  readonly closable: boolean;
  readonly preview: boolean;
  readonly durableRoute?: DurablePanelRoute;
}

export interface PanelRegionState {
  readonly open: boolean;
  readonly tabs: readonly PanelTabDescriptor[];
  readonly activeTabId: string | null;
  readonly recentTabIds: readonly string[];
  readonly scrollOffset: number;
}

export interface ConversationPanelState {
  readonly revision: number;
  readonly ownerId: string;
  readonly right: PanelRegionState;
  readonly bottom: PanelRegionState;
  readonly rightPanelFullWidth: boolean;
}

export type PanelAction =
  | {
      /** Placement transfer, never a logical resource close. */
      readonly type: "transfer-tab";
      readonly region: PanelRegionId;
      readonly targetRegion: PanelRegionId;
      readonly tabId: string;
      readonly beforeTabId?: string | null;
    }
  | {
      readonly type: "open-tab";
      readonly tab: PanelTabDescriptor;
      readonly activate?: boolean;
    }
  | {
      readonly type: "activate-tab";
      readonly region: PanelRegionId;
      readonly tabId: string;
    }
  | {
      readonly type: "close-tab";
      readonly region: PanelRegionId;
      readonly tabId: string;
    }
  | {
      /** Owner-only teardown; plugin removal must not be blocked by UX closability. */
      readonly type: "force-close-tab";
      readonly region: PanelRegionId;
      readonly tabId: string;
    }
  | {
      readonly type: "update-tab";
      readonly region: PanelRegionId;
      readonly tabId: string;
      readonly patch: Partial<
        Pick<PanelTabDescriptor, "title" | "icon">
      >;
    }
  | {
      readonly type: "move-tab";
      readonly region: PanelRegionId;
      readonly tabId: string;
      readonly beforeTabId: string | null;
    }
  | {
      readonly type: "set-region-open";
      readonly region: PanelRegionId;
      readonly open: boolean;
      readonly reason?: "manual" | "resize";
      /** Codex may reveal the side-panel outlet before a concrete tab exists. */
      readonly allowEmpty?: boolean;
    }
  | {
      readonly type: "set-scroll-offset";
      readonly region: PanelRegionId;
      readonly offset: number;
    }
  | { readonly type: "toggle-right-full-width" };

export interface RightPanelWidthBounds {
  readonly minimum: number;
  readonly maximum: number;
}

const emptyRegion = (): PanelRegionState => ({
  open: false,
  tabs: [],
  activeTabId: null,
  recentTabIds: [],
  scrollOffset: 0,
});

const promoteRecentTab = (recentTabIds: readonly string[], tabId: string) => [
  tabId,
  ...recentTabIds.filter((candidate) => candidate !== tabId),
];

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

function updateRegion(
  state: ConversationPanelState,
  region: PanelRegionId,
  updater: (current: PanelRegionState) => PanelRegionState,
): ConversationPanelState {
  return { ...state, [region]: updater(state[region]) };
}

export function createConversationPanelState(input: {
  readonly ownerId: string;
  readonly initialTabs?: readonly PanelTabDescriptor[];
  readonly rightPanelOpen?: boolean;
}): ConversationPanelState {
  let state: ConversationPanelState = {
    revision: 0,
    ownerId: input.ownerId,
    right: emptyRegion(),
    bottom: emptyRegion(),
    rightPanelFullWidth: false,
  };
  for (const tab of input.initialTabs ?? []) {
    state = reduceConversationPanelState(state, {
      type: "open-tab",
      tab,
      activate: false,
    });
  }
  if (input.rightPanelOpen === true && state.right.tabs.length > 0) {
    state = reduceConversationPanelState(state, {
      type: "set-region-open",
      region: "right",
      open: true,
    });
  }
  return { ...state, revision: 0 };
}

function reduceRegionAction(
  region: PanelRegionState,
  action: Exclude<Extract<PanelAction, { readonly region: PanelRegionId }>, { readonly type: "transfer-tab" }>,
): PanelRegionState {
  switch (action.type) {
    case "activate-tab": {
      if (!region.tabs.some((tab) => tab.id === action.tabId)) return region;
      return {
        ...region,
        open: true,
        activeTabId: action.tabId,
        recentTabIds: promoteRecentTab(region.recentTabIds, action.tabId),
      };
    }
    case "close-tab":
    case "force-close-tab": {
      const closingIndex = region.tabs.findIndex(
        (tab) => tab.id === action.tabId,
      );
      if (
        closingIndex === -1
        || (action.type === "close-tab" && region.tabs[closingIndex]?.closable !== true)
      )
        return region;
      const tabs = region.tabs.filter((tab) => tab.id !== action.tabId);
      const recentTabIds = region.recentTabIds.filter(
        (tabId) => tabId !== action.tabId,
      );
      const activeTabId =
        region.activeTabId === action.tabId
          ? (recentTabIds.find((tabId) =>
              tabs.some((tab) => tab.id === tabId),
            ) ??
            tabs[Math.min(closingIndex, Math.max(0, tabs.length - 1))]?.id ??
            null)
          : region.activeTabId;
      return {
        ...region,
        tabs,
        recentTabIds,
        activeTabId,
        // The right outlet owns its visibility independently of its content.
        open: action.region === "right" ? region.open : tabs.length > 0 && region.open,
      };
    }
    case "update-tab": {
      const current = region.tabs.find((tab) => tab.id === action.tabId);
      if (current === undefined) return region;
      const updated = { ...current, ...action.patch };
      if (
        updated.title === current.title &&
        updated.icon === current.icon &&
        updated.resource === current.resource &&
        updated.durableRoute === current.durableRoute
      ) return region;
      return {
        ...region,
        tabs: region.tabs.map((tab) =>
          tab.id === action.tabId ? updated : tab,
        ),
      };
    }
    case "move-tab": {
      const movingTab = region.tabs.find((tab) => tab.id === action.tabId);
      if (movingTab === undefined || action.beforeTabId === action.tabId)
        return region;
      const remainingTabs = region.tabs.filter(
        (tab) => tab.id !== action.tabId,
      );
      const targetIndex =
        action.beforeTabId === null
          ? remainingTabs.length
          : remainingTabs.findIndex((tab) => tab.id === action.beforeTabId);
      if (targetIndex === -1) return region;
      return {
        ...region,
        tabs: [
          ...remainingTabs.slice(0, targetIndex),
          movingTab,
          ...remainingTabs.slice(targetIndex),
        ],
      };
    }
    case "set-region-open":
      return {
        ...region,
        open:
          action.open &&
          (region.tabs.length > 0 || action.allowEmpty === true),
      };
    case "set-scroll-offset":
      return { ...region, scrollOffset: Math.max(0, action.offset) };
  }
}

export function reduceConversationPanelState(
  state: ConversationPanelState,
  action: PanelAction,
): ConversationPanelState {
  let next = state;
  switch (action.type) {
    case "transfer-tab": {
      if (action.region === action.targetRegion) return state;
      const source = state[action.region];
      const target = state[action.targetRegion];
      const tab = source.tabs.find((entry) => entry.id === action.tabId);
      if (!tab || target.tabs.some((entry) => entry.id === tab.id)) return state;
      const insertion = action.beforeTabId == null ? target.tabs.length
        : target.tabs.findIndex((entry) => entry.id === action.beforeTabId);
      if (insertion < 0) return state;
      const remaining = source.tabs.filter((entry) => entry.id !== tab.id);
      const recent = source.recentTabIds.filter((id) => id !== tab.id);
      next = {
        ...state,
        [action.region]: {
          ...source, tabs: remaining, recentTabIds: recent,
          open: remaining.length > 0 && source.open,
          activeTabId: source.activeTabId === tab.id ? recent[0] ?? remaining[0]?.id ?? null : source.activeTabId,
        },
        [action.targetRegion]: {
          ...target, open: true, activeTabId: tab.id,
          recentTabIds: promoteRecentTab(target.recentTabIds, tab.id),
          tabs: [...target.tabs.slice(0, insertion), { ...tab, region: action.targetRegion }, ...target.tabs.slice(insertion)],
        },
        rightPanelFullWidth: action.region === "right" && remaining.length === 0 ? false : state.rightPanelFullWidth,
      };
      break;
    }
    case "open-tab": {
      const region = state[action.tab.region];
      const sameId = region.tabs.find((tab) => tab.id === action.tab.id);
      const withoutReplacedPreview = region.tabs.filter(
        (tab) =>
          tab.id !== action.tab.id && !(action.tab.preview && tab.preview),
      );
      const tabs =
        sameId === undefined
          ? [...withoutReplacedPreview, action.tab]
          : region.tabs.map((tab) =>
              tab.id === action.tab.id ? action.tab : tab,
            );
      const activate = action.activate !== false;
      next = updateRegion(state, action.tab.region, (current) => {
        const retainedRecent = current.recentTabIds.filter((id) =>
          tabs.some((tab) => tab.id === id),
        );
        const retainedActive =
          current.activeTabId !== null &&
          tabs.some((tab) => tab.id === current.activeTabId)
            ? current.activeTabId
            : action.tab.id;
        const activeTabId = activate ? action.tab.id : retainedActive;
        return {
          ...current,
          tabs,
          open: activate || current.open,
          activeTabId,
          recentTabIds:
            activate || retainedRecent.length === 0
              ? promoteRecentTab(retainedRecent, activeTabId)
              : retainedRecent,
        };
      });
      break;
    }
    case "activate-tab":
    case "close-tab":
    case "force-close-tab":
    case "update-tab":
    case "move-tab":
    case "set-scroll-offset":
      next = updateRegion(state, action.region, (region) =>
        reduceRegionAction(region, action),
      );
      break;
    case "set-region-open": {
      next = updateRegion(state, action.region, (region) =>
        reduceRegionAction(region, action),
      );
      if (action.region === "right" && !action.open) {
        next = {
          ...next,
          rightPanelFullWidth: false,
        };
      }
      break;
    }
    case "toggle-right-full-width":
      // Width belongs to the open outlet, not to the presence of a content tab.
      if (state.right.open || state.right.tabs.length > 0) {
        next = {
          ...state,
          right: { ...state.right, open: true },
          rightPanelFullWidth: !state.rightPanelFullWidth,
        };
      }
      break;
  }
  return next === state ? state : { ...next, revision: state.revision + 1 };
}

export function isRightPanelResponsiveBlocked(input: {
  readonly viewportWidth: number;
  readonly sidebarOpen: boolean;
}) {
  return (
    input.viewportWidth <= RIGHT_PANEL_SMALL_BREAKPOINT ||
    (input.sidebarOpen && input.viewportWidth <= RIGHT_PANEL_TABLET_BREAKPOINT)
  );
}

export function getRightPanelWidthBounds(
  mainContentWidth: number,
  mode: "regular" | "full" = "regular",
  mainContentReserve = RIGHT_PANEL_MAIN_CONTENT_RESERVE,
): RightPanelWidthBounds {
  const availableWidth = Math.max(0, mainContentWidth);
  const maximum =
    mode === "full"
      ? availableWidth
      : Math.max(
          Math.min(RIGHT_PANEL_MINIMUM_WIDTH, availableWidth),
          availableWidth - mainContentReserve,
        );
  return {
    minimum: Math.min(RIGHT_PANEL_MINIMUM_WIDTH, maximum),
    maximum,
  };
}

export function computeRightPanelDefaultWidth(input: {
  readonly mainContentWidth: number;
  readonly shellHeight: number;
  readonly size?: "standard" | "compact";
  readonly mainContentReserve?: number;
}) {
  const bounds = getRightPanelWidthBounds(input.mainContentWidth, "regular", input.mainContentReserve);
  const recoveredDefault = Math.max(
    RIGHT_PANEL_MINIMUM_WIDTH,
    Math.min(
      input.shellHeight * RIGHT_PANEL_ASPECT_RATIO,
      input.mainContentWidth - RIGHT_PANEL_DEFAULT_MAIN_CONTENT_RESERVE,
    ),
    Math.min(
      RIGHT_PANEL_MAXIMUM_PREFERRED_WIDTH,
      input.mainContentWidth - RIGHT_PANEL_MAIN_CONTENT_RESERVE,
    ),
  );
  const preferred = input.size === "compact" ? recoveredDefault * 2 / 3 : recoveredDefault;
  return clamp(preferred, bounds.minimum, bounds.maximum);
}

export function normalizeRightPanelWidth(
  width: number,
  mainContentWidth: number,
  mainContentReserve?: number,
) {
  const bounds = getRightPanelWidthBounds(mainContentWidth, "regular", mainContentReserve);
  const span = bounds.maximum - bounds.minimum;
  if (span <= 0) return 0;
  return (clamp(width, bounds.minimum, bounds.maximum) - bounds.minimum) / span;
}

export function interpolateRightPanelWidth(
  ratio: number,
  mainContentWidth: number,
  mainContentReserve?: number,
) {
  const bounds = getRightPanelWidthBounds(mainContentWidth, "regular", mainContentReserve);
  return (
    bounds.minimum + clamp(ratio, 0, 1) * (bounds.maximum - bounds.minimum)
  );
}
