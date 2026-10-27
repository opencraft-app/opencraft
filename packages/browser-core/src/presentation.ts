import { browserViewportDeviceProfile, type BrowserDeviceProfile, type BrowserViewportMode } from "./model";
import type { BrowserPageId, BrowserTabId } from "./model";

export interface BrowserPresentationRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserViewportLayout {
  /** The clipped panel area available to the browser presentation. */
  readonly stageBounds: BrowserPresentationRect;
  /** The on-screen rectangle after contain scaling and centering. */
  readonly visualBounds: BrowserPresentationRect;
  /** The iframe's unscaled layout viewport. */
  readonly viewportSize: { readonly width: number; readonly height: number };
  readonly scale: number;
  readonly deviceProfile?: BrowserDeviceProfile;
}

export type BrowserPresentationSurface =
  | "right-panel"
  | "bottom-panel"
  | "fullscreen"
  | "background";

export type BrowserPresentationPhase = "parked" | "staged" | "visible";

/**
 * A Presentation is a revocable claim to paint one Page into one View slot.
 * Generation is the stale-work fence: only the current generation may move,
 * reveal or park the native/iframe surface.
 */
export interface BrowserPresentationSnapshot {
  readonly id: string;
  readonly pageId: BrowserPageId;
  readonly tabId: BrowserTabId;
  readonly viewId: string;
  readonly surface: BrowserPresentationSurface;
  readonly phase: BrowserPresentationPhase;
  readonly generation: number;
  readonly bounds: BrowserPresentationRect | null;
}

export function createBrowserPresentation(input: {
  readonly id: string;
  readonly pageId: BrowserPageId;
  readonly tabId: BrowserTabId;
  readonly viewId: string;
  readonly surface: BrowserPresentationSurface;
}): BrowserPresentationSnapshot {
  return {
    ...input,
    phase: "parked",
    generation: 0,
    bounds: null,
  };
}

export function claimBrowserPresentation(
  current: BrowserPresentationSnapshot,
): BrowserPresentationSnapshot {
  return {
    ...current,
    generation: current.generation + 1,
    phase: "staged",
  };
}

export function commitBrowserPresentation(
  current: BrowserPresentationSnapshot,
  generation: number,
  bounds: BrowserPresentationRect,
): BrowserPresentationSnapshot {
  if (current.generation !== generation) return current;
  return { ...current, phase: "visible", bounds };
}

export function parkBrowserPresentation(
  current: BrowserPresentationSnapshot,
  generation: number,
): BrowserPresentationSnapshot {
  if (current.generation !== generation) return current;
  return { ...current, phase: "parked", bounds: null };
}

const VIEWPORT_STAGE_HORIZONTAL_PADDING = 20;
const VIEWPORT_STAGE_BOTTOM_PADDING = 20;

export function computeBrowserViewportLayout(
  stageBounds: BrowserPresentationRect,
  mode: BrowserViewportMode,
): BrowserViewportLayout {
  if (mode.type === "responsive") {
    return {
      stageBounds,
      visualBounds: stageBounds,
      viewportSize: { width: stageBounds.width, height: stageBounds.height },
      scale: 1,
    };
  }

  const fitWidth = Math.max(
    0,
    stageBounds.width - VIEWPORT_STAGE_HORIZONTAL_PADDING * 2,
  );
  const fitHeight = Math.max(
    0,
    stageBounds.height - VIEWPORT_STAGE_BOTTOM_PADDING,
  );
  const scale = Math.max(
    0,
    Math.min(1, fitWidth / mode.width, fitHeight / mode.height),
  );
  const width = Math.round(mode.width * scale);
  const height = Math.round(mode.height * scale);
  return {
    stageBounds,
    visualBounds: {
      x: Math.round(
        stageBounds.x
          + Math.max(
            VIEWPORT_STAGE_HORIZONTAL_PADDING,
            (stageBounds.width - width) / 2,
          ),
      ),
      y: stageBounds.y,
      width,
      height,
    },
    viewportSize: { width: mode.width, height: mode.height },
    deviceProfile: browserViewportDeviceProfile(mode),
    scale,
  };
}

const right = (rect: BrowserPresentationRect) => rect.x + rect.width;
const bottom = (rect: BrowserPresentationRect) => rect.y + rect.height;

/**
 * A browser backing is hosted outside React's panel subtree, so its physical
 * bounds must be clipped to both the logical slot and the AppShell aperture.
 * This prevents a stale/min-width surface from painting through a narrowing
 * panel while preserving the backing across panel unmounts.
 */
export function intersectBrowserPresentationBounds(
  ...rects: readonly BrowserPresentationRect[]
): BrowserPresentationRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.max(...rects.map((rect) => rect.x));
  const y = Math.max(...rects.map((rect) => rect.y));
  const farX = Math.min(...rects.map(right));
  const farY = Math.min(...rects.map(bottom));
  return {
    x,
    y,
    width: Math.max(0, farX - x),
    height: Math.max(0, farY - y),
  };
}
