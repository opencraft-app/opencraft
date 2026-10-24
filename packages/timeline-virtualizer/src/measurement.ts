import type {
  TurnLayout,
  TurnVirtualizerConfig,
  VirtualizedTurnEntry,
  VirtualizedTurnViewportState,
} from "./types";
import {
  buildTurnLayout,
  OPENCRAFT_TURN_VIRTUALIZER_CONFIG,
  compensateDistanceFromBottom,
  findMeasuredViewportAnchor,
  updateTurnViewportState,
} from "./virtualizer";
import { distanceExcludingBottomPadding, isAtVirtualizedBottom } from "./scroll";

export interface TurnHeightMeasurement {
  readonly turnKey: string;
  readonly heightPx: number;
}

export interface LatestTurnMeasurementChange {
  readonly turnKey: string;
  readonly heightDeltaPx: number;
  readonly heightPx: number;
}

export interface TurnMeasurementTransaction {
  readonly measuredHeightsByKey: Readonly<Record<string, number>>;
  readonly layout: TurnLayout;
  readonly viewport: VirtualizedTurnViewportState;
  readonly latestTurnHeightChange: LatestTurnMeasurementChange | null;
  readonly restoreScrollDistanceFromBottom: boolean;
  readonly scrollDistanceFromBottomPx: number | null;
  readonly preservePlatformScrollForNextLayout: boolean;
  readonly canUseLatestTurnFastPath: boolean;
  readonly layoutHeightDeltaPx: number;
}

export interface CreateTurnMeasurementTransactionOptions<TEntry extends VirtualizedTurnEntry> {
  readonly entries: readonly TEntry[];
  readonly measurements: readonly TurnHeightMeasurement[];
  readonly measuredHeightsByKey: Readonly<Record<string, number>>;
  readonly layout: TurnLayout;
  readonly viewport: VirtualizedTurnViewportState;
  readonly currentDistanceFromBottomPx: number;
  readonly bottomPaddingPx: number;
  readonly preserveMeasuredTurnViewport: boolean;
  /** Stable delegation to the latest-Turn owner. Presence survives restoration. */
  readonly getPendingRestoreScrollDistanceFromBottomPx: (() => number | null) | null;
  readonly previousPendingTransaction?: TurnMeasurementTransaction | null;
  readonly config?: Readonly<TurnVirtualizerConfig>;
}

export interface ReconcileTurnLayoutViewportOptions {
  readonly previousLayout: TurnLayout;
  readonly nextLayout: TurnLayout;
  readonly measuredHeightsByKey: Readonly<Record<string, number>>;
  readonly currentDistanceFromBottomPx: number;
  readonly viewportHeightPx: number;
  readonly bottomPaddingPx: number;
  /** False while follow/response placement owns the viewport. */
  readonly preserveViewport: boolean;
  /** A measurement transaction already issued the sole correction for this layout. */
  readonly layoutOwnedByMeasurement: boolean;
  /** Restore owns the next platform position and fences normal compensation. */
  readonly restorePending: boolean;
}

/** Transfer known geometry when a stable row acquires a new protocol locator. */
export function rekeyTurnMeasurements<TEntry extends VirtualizedTurnEntry>(
  previousEntries: readonly TEntry[],
  nextEntries: readonly TEntry[],
  measuredHeightsByKey: Readonly<Record<string, number>>,
  stableIdentity: (entry: TEntry) => string,
): Readonly<Record<string, number>> {
  if (previousEntries.length === nextEntries.length
    && previousEntries.every((entry, index) => entry.turnKey === nextEntries[index]?.turnKey))
    return measuredHeightsByKey;
  const previousHeights = new Map<string, number>();
  for (const entry of previousEntries) {
    const height = measuredHeightsByKey[entry.turnKey];
    if (height !== undefined) previousHeights.set(stableIdentity(entry), height);
  }
  let nextHeights = measuredHeightsByKey;
  for (const entry of nextEntries) {
    if (measuredHeightsByKey[entry.turnKey] !== undefined) continue;
    const height = previousHeights.get(stableIdentity(entry));
    if (height === undefined) continue;
    if (nextHeights === measuredHeightsByKey) nextHeights = { ...measuredHeightsByKey };
    (nextHeights as Record<string, number>)[entry.turnKey] = height;
  }
  return nextHeights;
}

/**
 * Reconcile an entry-list layout change that did not originate in a
 * measurement batch. This is the virtualizer's only non-measurement scroll
 * decision; renderers execute its result but do not select anchors themselves.
 */
export function reconcileTurnLayoutViewport({
  previousLayout,
  nextLayout,
  measuredHeightsByKey,
  currentDistanceFromBottomPx,
  viewportHeightPx,
  bottomPaddingPx,
  preserveViewport,
  layoutOwnedByMeasurement,
  restorePending,
}: ReconcileTurnLayoutViewportOptions): number | null {
  if (!preserveViewport || layoutOwnedByMeasurement || restorePending) return null;
  if (isAtVirtualizedBottom(currentDistanceFromBottomPx, bottomPaddingPx)) return null;
  const virtualDistance = distanceExcludingBottomPadding(
    currentDistanceFromBottomPx,
    bottomPaddingPx,
  );
  const anchorKey = findMeasuredViewportAnchor(
    previousLayout,
    nextLayout,
    measuredHeightsByKey,
    virtualDistance,
    viewportHeightPx,
  );
  if (anchorKey === null) return null;
  const compensated = compensateDistanceFromBottom(
    anchorKey,
    virtualDistance,
    previousLayout,
    nextLayout,
  );
  if (compensated === null) return null;
  // A prepend can leave the bottom-relative distance unchanged while moving
  // the native ScrollView's physical top offset. Reapply that same distance
  // after the new content height commits so the measured anchor stays put.
  if (
    compensated === virtualDistance
    && previousLayout.totalHeightPx === nextLayout.totalHeightPx
  ) return null;
  return compensated + Math.max(0, bottomPaddingPx);
}

function positiveHeight(value: number): number {
  return Number.isFinite(value) ? Math.max(1, value) : 1;
}

/** Commits one measurement batch through the shared layout and viewport ports. */
export function createTurnMeasurementTransaction<TEntry extends VirtualizedTurnEntry>(
  options: CreateTurnMeasurementTransactionOptions<TEntry>,
): TurnMeasurementTransaction | null {
  const {
    entries, measurements, measuredHeightsByKey, layout, viewport,
    currentDistanceFromBottomPx, bottomPaddingPx, preserveMeasuredTurnViewport,
    getPendingRestoreScrollDistanceFromBottomPx,
    previousPendingTransaction: pending = null,
    config = OPENCRAFT_TURN_VIRTUALIZER_CONFIG,
  } = options;
  const restoreTarget = preserveMeasuredTurnViewport
    ? null : getPendingRestoreScrollDistanceFromBottomPx?.() ?? null;
  const position = pending?.scrollDistanceFromBottomPx ?? currentDistanceFromBottomPx;
  const distance = distanceExcludingBottomPadding(position, bottomPaddingPx);
  const latestKey = entries.at(-1)?.turnKey;
  let table: Record<string, number> | null = null;
  let layoutDelta = 0;
  let positionDelta = 0;
  let affectsPosition = false;
  let latestChange = pending?.latestTurnHeightChange ?? null;

  for (const measurement of measurements) {
    const index = layout.turnIndexByKey.get(measurement.turnKey);
    if (index === undefined) continue;
    const height = positiveHeight(measurement.heightPx);
    const knownHeight = measuredHeightsByKey[measurement.turnKey];
    if (height === knownHeight) continue;
    table ??= { ...measuredHeightsByKey };
    table[measurement.turnKey] = height;
    const delta = height - layout.heightsPx[index]!;
    layoutDelta += delta;
    if (layout.bottomOffsetsPx[index]! <= distance
      && (preserveMeasuredTurnViewport || (getPendingRestoreScrollDistanceFromBottomPx !== null
        && measurement.turnKey !== latestKey))) {
      positionDelta += delta;
      affectsPosition = true;
    }
    if (measurement.turnKey === latestKey) {
      latestChange = {
        turnKey: measurement.turnKey,
        heightDeltaPx: (latestChange?.heightDeltaPx ?? 0)
          + (knownHeight === undefined ? 0 : height - knownHeight),
        heightPx: height,
      };
    }
  }
  if (table === null) return null;

  const nextLayout = buildTurnLayout(entries, table, config);
  const restore = (pending?.restoreScrollDistanceFromBottom ?? false) || restoreTarget !== null;
  let scroll = pending?.scrollDistanceFromBottomPx ?? null;
  let preservePlatform = pending?.preservePlatformScrollForNextLayout ?? false;
  if (restore) {
    scroll = null;
    preservePlatform = false;
  } else if (preserveMeasuredTurnViewport && isAtVirtualizedBottom(position, bottomPaddingPx)) {
    scroll = 0;
    preservePlatform = false;
  } else if (affectsPosition) {
    if (positionDelta !== 0) scroll = position + positionDelta;
    preservePlatform = false;
  } else if (preserveMeasuredTurnViewport && layoutDelta !== 0) {
    preservePlatform = true;
  }

  const nextDistance = restoreTarget ?? (scroll === null
    ? viewport.distanceFromBottomPx : distanceExcludingBottomPadding(scroll, bottomPaddingPx));
  const nextViewport = updateTurnViewportState(viewport, nextLayout, nextDistance, viewport.viewportHeightPx, config);
  return {
    measuredHeightsByKey: table,
    layout: nextLayout,
    viewport: nextViewport,
    latestTurnHeightChange: latestChange,
    restoreScrollDistanceFromBottom: restore,
    scrollDistanceFromBottomPx: scroll,
    preservePlatformScrollForNextLayout: preservePlatform,
    canUseLatestTurnFastPath: pending === null && measurements.length === 1
      && measurements[0]!.turnKey === latestKey && nextViewport === viewport,
    layoutHeightDeltaPx: layoutDelta,
  };
}
