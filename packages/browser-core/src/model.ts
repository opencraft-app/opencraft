import type { BrowserUrl } from "./url-policy";

export type BrowserPageId = string & {
  readonly __brand: "BrowserPageId";
};

export type BrowserTabId = string & {
  readonly __brand: "BrowserTabId";
};

export type BrowserDeviceProfile = "desktop" | "iphone" | "ipad" | "android-phone" | "android-tablet" | "desktop-touch";

export type BrowserViewportMode =
  | { readonly type: "responsive" }
  | { readonly type: "fit"; readonly width: number; readonly height: number }
  | {
      readonly type: "device";
      readonly presetId: string;
      /** Retain device semantics when a preset is resized into custom dimensions. */
      readonly deviceProfile?: BrowserDeviceProfile;
      readonly width: number;
      readonly height: number;
    };

export function browserViewportDeviceProfile(mode: BrowserViewportMode): BrowserDeviceProfile {
  if (mode.type !== "device") return "desktop";
  if (mode.deviceProfile) return mode.deviceProfile;
  if (mode.presetId.startsWith("iphone-")) return "iphone";
  if (mode.presetId.startsWith("ipad-")) return "ipad";
  if (["pixel-8", "samsung-galaxy-s24-ultra", "surface-duo"].includes(mode.presetId)) return "android-phone";
  if (mode.presetId === "surface-pro-7") return "desktop-touch";
  return "desktop";
}

export const DEFAULT_BROWSER_VIEWPORT_MODE: BrowserViewportMode = {
  type: "responsive",
};

export const BROWSER_DEVICE_PRESETS = [
  { id: "laptop-large", label: "Laptop Large", width: 1440, height: 900 },
  { id: "laptop", label: "Laptop", width: 1024, height: 768 },
  { id: "ipad-air", label: "iPad Air", width: 820, height: 1180 },
  { id: "ipad-mini", label: "iPad Mini", width: 768, height: 1024 },
  { id: "iphone-15-pro", label: "iPhone 15 Pro", width: 393, height: 852 },
] as const;

const normalizeViewportDimension = (value: number, minimum: number) =>
  Math.min(4096, Math.max(minimum, Math.round(value)));

export function normalizeBrowserViewportMode(
  value: unknown,
): BrowserViewportMode {
  if (typeof value !== "object" || value === null)
    return DEFAULT_BROWSER_VIEWPORT_MODE;
  const candidate = value as {
    readonly type?: unknown;
    readonly presetId?: unknown;
    readonly deviceProfile?: unknown;
    readonly width?: unknown;
    readonly height?: unknown;
  };
  if (candidate.type === "responsive") return DEFAULT_BROWSER_VIEWPORT_MODE;
  if (
    (candidate.type === "fit" || candidate.type === "device")
    && typeof candidate.width === "number"
    && Number.isFinite(candidate.width)
    && typeof candidate.height === "number"
    && Number.isFinite(candidate.height)
  ) {
    const dimensions = {
      width: normalizeViewportDimension(candidate.width, 240),
      height: normalizeViewportDimension(candidate.height, 160),
    };
    if (candidate.type === "fit") return { type: "fit", ...dimensions };
    if (typeof candidate.presetId === "string" && candidate.presetId !== "") {
      const deviceProfile = ["desktop", "iphone", "ipad", "android-phone", "android-tablet", "desktop-touch"].includes(candidate.deviceProfile as string)
        ? candidate.deviceProfile as BrowserDeviceProfile : undefined;
      return { type: "device", presetId: candidate.presetId, ...dimensions, ...(deviceProfile ? { deviceProfile } : {}) };
    }
  }
  return DEFAULT_BROWSER_VIEWPORT_MODE;
}

export function rotateBrowserViewportMode(
  mode: BrowserViewportMode,
): BrowserViewportMode {
  if (mode.type === "responsive") return mode;
  return {
    ...mode,
    width: mode.height,
    height: mode.width,
  };
}

export interface BrowserHistoryEntry {
  readonly url: BrowserUrl;
  readonly title: string;
}

export interface BrowserHistoryState {
  readonly entries: readonly BrowserHistoryEntry[];
  readonly index: number;
}

export interface BrowserNavigationSnapshot {
  readonly currentUrl: BrowserUrl | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly isLoading: boolean;
}

/**
 * Authoritative logical page state. A Page survives React panel mounts and is
 * the only owner of navigation, loading and automation state.
 */
export interface BrowserPageSnapshot {
  readonly revision: number;
  readonly id: BrowserPageId;
  readonly ownerId: string;
  readonly createdAt: number;
  readonly navigation: BrowserNavigationSnapshot;
  readonly title: string;
  readonly error: string | null;
}

/**
 * Workbench identity for a Page. Viewport preferences belong to the Tab, not
 * the physical Page and not a transient panel component.
 */
export interface BrowserTabSnapshot {
  readonly id: BrowserTabId;
  readonly pageId: BrowserPageId;
  readonly ownerId: string;
  readonly createdAt: number;
  readonly viewportMode: BrowserViewportMode;
}

export type BrowserHistoryAction =
  | { readonly type: "navigate"; readonly entry: BrowserHistoryEntry }
  | { readonly type: "back" }
  | { readonly type: "forward" };

export function createBrowserHistory(
  initial?: BrowserHistoryEntry,
): BrowserHistoryState {
  return initial === undefined
    ? { entries: [], index: -1 }
    : { entries: [initial], index: 0 };
}

export function reduceBrowserHistory(
  state: BrowserHistoryState,
  action: BrowserHistoryAction,
): BrowserHistoryState {
  if (action.type === "navigate") {
    const current = state.entries[state.index];
    if (current?.url === action.entry.url) {
      const entries = [...state.entries];
      entries[state.index] = action.entry;
      return { entries, index: state.index };
    }
    return {
      entries: [...state.entries.slice(0, state.index + 1), action.entry],
      index: state.index + 1,
    };
  }
  if (action.type === "back") {
    return state.index > 0 ? { ...state, index: state.index - 1 } : state;
  }
  return state.index + 1 < state.entries.length
    ? { ...state, index: state.index + 1 }
    : state;
}

export function currentBrowserHistoryEntry(
  state: BrowserHistoryState,
): BrowserHistoryEntry | null {
  return state.entries[state.index] ?? null;
}
