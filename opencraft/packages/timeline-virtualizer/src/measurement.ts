import type {
  TurnLayout,
  TurnVirtualizerConfig,
  VirtualizedTurnEntry,
  VirtualizedTurnViewportState,
} from "./types";
import {
  buildTurnLayout,
  CODEX_TURN_VIRTUALIZER_CONFIG,
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

/**
 * Recovered Codex measurement transaction (the virtualizer's `nt` path) in a
 * platform-neutral form. Every ResizeObserver batch produces one coherent
 * height table, layout, render window and scroll decision.
 */
export function createTurnMeasurementTransaction<TEntry extends VirtualizedTurnEntry>({
  entries,
  measurements,
  measuredHeightsByKey,
  layout,
  viewport,
  currentDistanceFromBottomPx,
  bottomPaddingPx,
  preserveMeasuredTurnViewport,
  getPendingRestoreScrollDistanceFromBottomPx,
  previousPendingTransaction = null,
  config = CODEX_TURN_VIRTUALIZER_CONFIG,
}: CreateTurnMeasurementTransactionOptions<TEntry>): TurnMeasurementTransaction | null {
  let nextHeights = measuredHeightsByKey;
  let latestTurnHeightDeltaPx = 0;
  let latestTurnHeightPx: number | null = null;
  let latestTurnChanged = false;
  let layoutHeightDeltaPx = 0;
  let heightDeltaBelowViewportPx = 0;
  let changedCount = 0;
  const virtualDistance = distanceExcludingBottomPadding(currentDistanceFromBottomPx, bottomPaddingPx);
  const pendingRestoreScrollDistanceFromBottomPx = preserveMeasuredTurnViewport
    ? null
    : getPendingRestoreScrollDistanceFromBottomPx?.() ?? null;
  const compensationDistance = previousPendingTransaction === null
    ? virtualDistance
    : viewport.distanceFromBottomPx;

  for (const measurement of measurements) {
    const index = layout.turnIndexByKey.get(measurement.turnKey);
    if (index === undefined) continue;
    const heightPx = positiveHeight(measurement.heightPx);
    const previousMeasuredHeight = measuredHeightsByKey[measurement.turnKey];
    if (previousMeasuredHeight === heightPx) continue;
    if (nextHeights === measuredHeightsByKey) nextHeights = { ...measuredHeightsByKey };
    (nextHeights as Record<string, number>)[measurement.turnKey] = heightPx;
    changedCount += 1;

    const isLatestTurn = index === layout.turnKeys.length - 1;
    // r3562: learning a height is not content growth. Estimate correction is
    // computed separately below, against the previous virtual layout.
    const measuredDelta = previousMeasuredHeight === undefined ? 0 : heightPx - previousMeasuredHeight;
    if (isLatestTurn) {
      latestTurnChanged = true;
      latestTurnHeightDeltaPx += measuredDelta;
      latestTurnHeightPx = heightPx;
    }

    const layoutDelta = heightPx - (layout.heightsPx[index] ?? heightPx);
    layoutHeightDeltaPx += layoutDelta;
    const bottomOffsetPx = layout.bottomOffsetsPx[index] ?? 0;
    if (
      layoutDelta !== 0
      && bottomOffsetPx <= compensationDistance
      && (preserveMeasuredTurnViewport || (getPendingRestoreScrollDistanceFromBottomPx !== null && !isLatestTurn))
    ) {
      heightDeltaBelowViewportPx += layoutDelta;
    }
  }

  if (nextHeights === measuredHeightsByKey) return null;

  const atBottom = preserveMeasuredTurnViewport
    && isAtVirtualizedBottom(currentDistanceFromBottomPx, bottomPaddingPx);
  const restoreScrollDistanceFromBottom = previousPendingTransaction?.restoreScrollDistanceFromBottom === true
    || pendingRestoreScrollDistanceFromBottomPx !== null;
  let scrollDistanceFromBottomPx: number | null = null;
  if (!restoreScrollDistanceFromBottom) {
    scrollDistanceFromBottomPx = atBottom
      ? 0
      : heightDeltaBelowViewportPx === 0
        ? previousPendingTransaction?.scrollDistanceFromBottomPx ?? null
        : (previousPendingTransaction?.scrollDistanceFromBottomPx ?? currentDistanceFromBottomPx)
          + heightDeltaBelowViewportPx;
  }

  const nextLayout = buildTurnLayout(entries, nextHeights, config);
  const targetVirtualDistance = restoreScrollDistanceFromBottom
    ? pendingRestoreScrollDistanceFromBottomPx ?? viewport.distanceFromBottomPx
    : scrollDistanceFromBottomPx === null
      ? viewport.distanceFromBottomPx
      : distanceExcludingBottomPadding(scrollDistanceFromBottomPx, bottomPaddingPx);
  const nextViewport = updateTurnViewportState(
    viewport,
    nextLayout,
    targetVirtualDistance,
    viewport.viewportHeightPx,
    config,
  );

  return {
    measuredHeightsByKey: nextHeights,
    layout: nextLayout,
    viewport: nextViewport,
    latestTurnHeightChange: latestTurnChanged && latestTurnHeightPx !== null
      ? {
          turnKey: layout.turnKeys.at(-1)!,
          heightDeltaPx: (previousPendingTransaction?.latestTurnHeightChange?.heightDeltaPx ?? 0) + latestTurnHeightDeltaPx,
          heightPx: latestTurnHeightPx,
        }
      : previousPendingTransaction?.latestTurnHeightChange ?? null,
    restoreScrollDistanceFromBottom,
    scrollDistanceFromBottomPx,
    preservePlatformScrollForNextLayout:
      preserveMeasuredTurnViewport
      && layoutHeightDeltaPx !== 0
      && heightDeltaBelowViewportPx === 0
      && !atBottom
      && !restoreScrollDistanceFromBottom,
    canUseLatestTurnFastPath:
      latestTurnChanged
      && changedCount === 1
      && previousPendingTransaction === null
      && nextViewport === viewport,
    layoutHeightDeltaPx,
  };
}
