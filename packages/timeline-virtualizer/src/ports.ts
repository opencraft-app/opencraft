import type { LatestTurnPlacementSnapshot } from "./follow";
import type { TurnGeometry, VirtualizedTurnViewportState } from "./types";

export type TurnScrollBehavior = "instant" | "smooth";
export type TurnScrollOrigin = "system" | "user";

export interface TurnViewportMetrics {
  readonly distanceFromBottomPx: number;
  readonly viewportHeightPx: number;
  readonly scrollHeightPx: number;
}

export interface PlatformTurnViewportMetrics {
  /** Full platform scroll content height. */
  readonly contentHeightPx: number;
  /** Visible platform viewport height. */
  readonly viewportHeightPx: number;
  /** Web scrollTop or React Native contentOffset.y. */
  readonly topOffsetPx: number;
}

export function normalizeTurnViewportMetrics({
  contentHeightPx,
  viewportHeightPx,
  topOffsetPx,
}: PlatformTurnViewportMetrics): TurnViewportMetrics {
  const scrollHeightPx = Number.isFinite(contentHeightPx) ? Math.max(0, contentHeightPx) : 0;
  const viewport = Number.isFinite(viewportHeightPx) ? Math.max(0, viewportHeightPx) : 0;
  const maximumTopOffsetPx = Math.max(0, scrollHeightPx - viewport);
  const topOffset = Number.isFinite(topOffsetPx)
    ? Math.min(maximumTopOffsetPx, Math.max(0, topOffsetPx))
    : 0;
  return {
    distanceFromBottomPx: maximumTopOffsetPx - topOffset,
    viewportHeightPx: viewport,
    scrollHeightPx,
  };
}

/** A flex-column-reverse viewport exposes distance as -scrollTop. */
export function normalizeInvertedWebViewportMetrics({
  contentHeightPx,
  viewportHeightPx,
  scrollTopPx,
}: {
  readonly contentHeightPx: number;
  readonly viewportHeightPx: number;
  readonly scrollTopPx: number;
}): TurnViewportMetrics {
  return {
    distanceFromBottomPx: Number.isFinite(scrollTopPx) ? Math.max(0, -scrollTopPx) : 0,
    viewportHeightPx: Number.isFinite(viewportHeightPx) ? Math.max(0, viewportHeightPx) : 0,
    scrollHeightPx: Number.isFinite(contentHeightPx) ? Math.max(0, contentHeightPx) : 0,
  };
}

export function invertedWebScrollTopForDistance(distanceFromBottomPx: number): number {
  const distance = Number.isFinite(distanceFromBottomPx) ? Math.max(0, distanceFromBottomPx) : 0;
  return distance === 0 ? 0 : -distance;
}

/** Inverse of normalizeTurnViewportMetrics for DOM scrollTop and RN scrollTo({ y }). */
export function topOffsetForDistanceFromBottom(
  contentHeightPx: number,
  viewportHeightPx: number,
  distanceFromBottomPx: number,
): number {
  const maximumTopOffsetPx = Math.max(
    0,
    (Number.isFinite(contentHeightPx) ? Math.max(0, contentHeightPx) : 0)
      - (Number.isFinite(viewportHeightPx) ? Math.max(0, viewportHeightPx) : 0),
  );
  const distance = Number.isFinite(distanceFromBottomPx)
    ? Math.min(maximumTopOffsetPx, Math.max(0, distanceFromBottomPx))
    : 0;
  return maximumTopOffsetPx - distance;
}

/**
 * Implemented with a DOM scroll container on Web and a ScrollView/FlatList adapter
 * on Expo/RN. The port exposes an inverted distance-from-bottom coordinate even
 * when the platform itself exposes a normal top offset.
 */
export interface TurnScrollPort {
  getMetrics(): TurnViewportMetrics;
  scrollToDistanceFromBottomPx(
    distanceFromBottomPx: number,
    behavior: TurnScrollBehavior,
    origin?: TurnScrollOrigin,
  ): void;
  subscribe(listener: (metrics: TurnViewportMetrics, origin: TurnScrollOrigin) => void): () => void;
  preservePositionForNextLayout?(): void;
}

/**
 * Web adapters feed ResizeObserver results; RN adapters feed View.onLayout results.
 * Handles remain platform-owned and never enter restore state.
 */
export interface TurnMeasurementPort<THandle> {
  attach(turnKey: string, handle: THandle, onHeight: (heightPx: number) => void): () => void;
  measureNow?(handle: THandle): number | null;
}

export interface TurnLayoutScheduler {
  afterLayout(callback: () => void): () => void;
}

export interface TurnConversationScrollApi {
  /** Capture geometry at submit; the caller owns it until one Conversation consumes it. */
  captureLatestTurnSubmitPlacement(): LatestTurnPlacementSnapshot | null;
  /** Release platform preservation acquired while capturing, without owning the snapshot. */
  releaseLatestTurnSubmitPlacementCapture(): void;
  scrollToBottom(): void;
}

export type VirtualizedTurnPositionResult = "positioned" | "cancelled" | "unavailable";

export interface VirtualizedTurnPositionRequest {
  readonly turnKey: string;
  /** Renderer may wait below this revision, but must fail closed at or above it. */
  readonly minimumTimelineRevision?: number;
  readonly align?: "center" | "top";
  /** Applied only to the final exact placement; mounting and measuring never scroll provisionally. */
  readonly behavior?: TurnScrollBehavior;
  /** Stable semantic key for a target inside the Turn; never a DOM/native handle. */
  readonly targetKey?: string;
  /** Per-navigation breathing room above a top-aligned target. */
  readonly topAlignmentInsetPx?: number;
  readonly signal?: AbortSignal;
}

export interface VirtualizedTurnListApi {
  getEntryGeometry(turnKey: string): TurnGeometry | null;
  getViewportState(): VirtualizedTurnViewportState;
  positionTarget(request: VirtualizedTurnPositionRequest): Promise<VirtualizedTurnPositionResult>;
}
