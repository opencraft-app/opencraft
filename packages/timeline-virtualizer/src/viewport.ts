export type TimelineRenderHostKind = "browser" | "electron" | "native";

export type TimelineRenderPlatform =
  | "darwin"
  | "win32"
  | "linux"
  | "ios"
  | "android";

export type TimelineThreadOverscroll = "auto" | "contain" | "none";

export interface TimelineViewportSize {
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface TimelineViewportOffset {
  readonly leftPx: number;
  readonly topPx: number;
}

export interface TimelineViewportSnapshot {
  /** Monotonic adapter revision; useful for useSyncExternalStore consumers. */
  readonly revision: number;
  readonly layoutViewport: TimelineViewportSize;
  readonly visualViewport: TimelineViewportSize;
  readonly visualOffset: TimelineViewportOffset;
  readonly scale: number;
  /** Occlusion produced by a software keyboard, excluding pinch zoom. */
  readonly keyboardInsetBottomPx: number;
  readonly editableFocused: boolean;
}

/** Layout capacity, not a transform between browser coordinate spaces. */
export interface TimelineViewportLayout {
  readonly availableViewport: TimelineViewportSize;
  readonly occludedBottomPx: number;
}

export function projectTimelineViewportLayout(snapshot: TimelineViewportSnapshot): TimelineViewportLayout {
  const layout = snapshot.layoutViewport;
  // Pinch zoom is native magnification, not a request to reflow the application.
  const visual = Math.abs(snapshot.scale - 1) <= 0.01 ? snapshot.visualViewport : layout;
  const availableViewport = {
    widthPx: Math.min(layout.widthPx, visual.widthPx),
    heightPx: Math.min(layout.heightPx, visual.heightPx),
  };
  return {
    availableViewport,
    occludedBottomPx: layout.heightPx - availableViewport.heightPx,
  };
}

export interface TimelineViewportPort {
  getSnapshot(): TimelineViewportSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface TimelineViewportPolicy {
  /** The document is an application viewport and must never become a page scroller. */
  readonly lockRootScroll: true;
  /** Applied only to the timeline scrollport. */
  readonly threadOverscroll: TimelineThreadOverscroll;
  /** Whether the host can visibly render local rubber-band displacement. */
  readonly localElasticEffect: boolean;
  /** Whether the adapter publishes available layout capacity from VisualViewport. */
  readonly tracksVisualViewport: boolean;
}

export interface TimelineSurfaceCapabilities {
  /** Prevent content-visibility from freezing a live embedded surface. */
  readonly hasLiveEmbeddedSurface: boolean;
  /** Portal target used by MCP/extension content rendered inside the thread. */
  readonly embeddedPortalTarget: boolean;
  /** Remote PIP/voice presentation host attached to this timeline. */
  readonly pipAnchorHostId: string | null;
  /** Horizontal layout motion used by a shift-mode side panel. */
  readonly wideContentOffsetPx: number;
}

export const DEFAULT_TIMELINE_SURFACE_CAPABILITIES: TimelineSurfaceCapabilities = Object.freeze({
  hasLiveEmbeddedSurface: false,
  embeddedPortalTarget: true,
  pipAnchorHostId: null,
  wideContentOffsetPx: 0,
});

export function resolveTimelineViewportPolicy({
  kind,
  platform,
}: {
  readonly kind: TimelineRenderHostKind;
  readonly platform: TimelineRenderPlatform;
}): TimelineViewportPolicy {
  if (kind === "native") {
    return {
      lockRootScroll: true,
      threadOverscroll: "auto",
      localElasticEffect: platform === "ios",
      tracksVisualViewport: false,
    };
  }

  if (kind === "electron") {
    return {
      lockRootScroll: true,
      // Keep the nested scrollport at auto; lock only the application viewport.
      threadOverscroll: "auto",
      localElasticEffect: platform === "darwin",
      tracksVisualViewport: false,
    };
  }

  return {
    lockRootScroll: true,
    // Browsers need containment to preserve local elastic feedback without
    // handing the gesture to the page or Safari navigation.
    threadOverscroll: "contain",
    localElasticEffect: platform === "darwin" || platform === "ios",
    tracksVisualViewport: platform === "ios" || platform === "android",
  };
}

export function calculateSoftwareKeyboardInset({
  editableFocused,
  layoutViewportHeightPx,
  scale,
  visualOffsetTopPx,
  visualViewportHeightPx,
}: {
  readonly editableFocused: boolean;
  readonly layoutViewportHeightPx: number;
  readonly scale: number;
  readonly visualOffsetTopPx: number;
  readonly visualViewportHeightPx: number;
}): number {
  if (!editableFocused || Math.abs(scale - 1) > 0.01) return 0;
  const layoutHeight = Number.isFinite(layoutViewportHeightPx)
    ? Math.max(0, layoutViewportHeightPx)
    : 0;
  const visualHeight = Number.isFinite(visualViewportHeightPx)
    ? Math.max(0, visualViewportHeightPx)
    : layoutHeight;
  const visualTop = Number.isFinite(visualOffsetTopPx)
    ? Math.max(0, visualOffsetTopPx)
    : 0;
  return Math.max(0, layoutHeight - visualHeight - visualTop);
}

/** Shift mode moves content by half the panel. */
export function timelineWideContentOffset({
  displayMode,
  panelWidthPx,
  pinned,
}: {
  readonly displayMode: "overlay" | "shift" | "gutter";
  readonly panelWidthPx: number;
  readonly pinned: boolean;
}): number {
  return pinned && displayMode === "shift"
    ? -Math.max(0, panelWidthPx) / 2
    : 0;
}
