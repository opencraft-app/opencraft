import type {
  TurnGeometry,
  TurnLayout,
  TurnRange,
  TurnVirtualizerConfig,
  TurnWindowSlice,
  VirtualizedTurnEntry,
  VirtualizedTurnRestoreState,
  VirtualizedTurnViewportState,
} from "./types";

export const OPENCRAFT_TURN_VIRTUALIZER_CONFIG: Readonly<TurnVirtualizerConfig> = Object.freeze({
  estimatedTurnHeightPx: 280,
  gapPx: 12,
  overscanTurnCount: 2,
  fallbackViewportHeightPx: 800,
  topAlignmentInsetPx: 10,
});

function finiteNonNegative(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function positiveHeight(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, value) : fallback;
}

export function buildTurnLayout(
  entries: readonly VirtualizedTurnEntry[],
  measuredHeightsByKey: Readonly<Record<string, number>> = {},
  config: Readonly<TurnVirtualizerConfig> = OPENCRAFT_TURN_VIRTUALIZER_CONFIG,
): TurnLayout {
  const heightsPx: number[] = [];
  const topOffsetsPx: number[] = [];
  const turnIndexByKey = new Map<string, number>();
  const turnKeys: string[] = [];
  let totalHeightPx = 0;

  entries.forEach((entry, index) => {
    const heightPx = positiveHeight(
      measuredHeightsByKey[entry.turnKey] ?? entry.estimatedHeightPx,
      config.estimatedTurnHeightPx,
    );
    turnIndexByKey.set(entry.turnKey, index);
    turnKeys.push(entry.turnKey);
    topOffsetsPx.push(totalHeightPx);
    heightsPx.push(heightPx);
    totalHeightPx += heightPx;
    if (index < entries.length - 1) totalHeightPx += config.gapPx;
  });

  return {
    bottomOffsetsPx: topOffsetsPx.map(
      (topOffsetPx, index) => totalHeightPx - topOffsetPx - (heightsPx[index] ?? 0),
    ),
    heightsPx,
    topOffsetsPx,
    totalHeightPx,
    turnIndexByKey,
    turnKeys,
  };
}

export function reconcileRenderedRangeForEntries(
  current: VirtualizedTurnViewportState,
  layout: TurnLayout,
): TurnRange {
  if (equalKeys(current.turnKeys, layout.turnKeys)) {
    const visibleRange = computeTurnRange(layout, current.distanceFromBottomPx, current.viewportHeightPx);
    // A retained window must still cover the viewport after height changes.
    return rangeContains(current.renderedRange, visibleRange) ? current.renderedRange : visibleRange;
  }
  // This is a mounted-window handoff, not persisted restoration by count.
  // An insertion between existing rows must not evict the old last row for
  // one render before the viewport effect commits the new geometry.
  let startIndex = layout.turnKeys.length;
  let endIndex = 0;
  let anchoredStartIndex: number | null = null;
  for (let index = current.renderedRange.startIndex; index < current.renderedRange.endIndex; index += 1) {
    const key = current.turnKeys[index];
    const position = key === undefined ? undefined : layout.turnIndexByKey.get(key);
    if (position === undefined) continue;
    if (anchoredStartIndex === null) {
      // A replaced edge still owns its previous slot. Anchoring only the
      // surviving identities would drop an acknowledged optimistic Turn.
      anchoredStartIndex = Math.max(0, position - (index - current.renderedRange.startIndex));
    }
    startIndex = Math.min(startIndex, position);
    endIndex = Math.max(endIndex, position + 1);
  }
  if (anchoredStartIndex === null)
    return computeTurnRange(layout, current.distanceFromBottomPx, current.viewportHeightPx);
  return {
    startIndex: Math.min(startIndex, anchoredStartIndex),
    endIndex: Math.max(endIndex, Math.min(layout.turnKeys.length,
      anchoredStartIndex + current.renderedRange.endIndex - current.renderedRange.startIndex)),
  };
}

/** First Turn whose bottom edge is inside or above the viewport's top edge. */
function findRangeStart(bottomOffsetsPx: readonly number[], viewportEndFromBottomPx: number): number {
  let low = 0;
  let high = bottomOffsetsPx.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((bottomOffsetsPx[middle] ?? 0) < viewportEndFromBottomPx) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** First Turn whose top edge is below the viewport's bottom edge. */
function findRangeEnd(
  bottomOffsetsPx: readonly number[],
  heightsPx: readonly number[],
  viewportStartFromBottomPx: number,
): number {
  let low = 0;
  let high = bottomOffsetsPx.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((bottomOffsetsPx[middle] ?? 0) + (heightsPx[middle] ?? 0) <= viewportStartFromBottomPx) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

export function computeTurnRange(
  layout: TurnLayout,
  distanceFromBottomPx: number,
  viewportHeightPx: number,
  overscanTurnCount = OPENCRAFT_TURN_VIRTUALIZER_CONFIG.overscanTurnCount,
): TurnRange {
  if (layout.turnKeys.length === 0) return { startIndex: 0, endIndex: 0 };
  const viewportStart = Math.min(finiteNonNegative(distanceFromBottomPx), layout.totalHeightPx);
  const viewportEnd = Math.min(
    viewportStart + finiteNonNegative(viewportHeightPx),
    layout.totalHeightPx,
  );
  const visibleStart = findRangeStart(layout.bottomOffsetsPx, viewportEnd);
  const visibleEnd = findRangeEnd(layout.bottomOffsetsPx, layout.heightsPx, viewportStart);
  const overscan = Math.max(0, Math.floor(overscanTurnCount));
  return {
    startIndex: Math.max(0, visibleStart - overscan),
    endIndex: Math.min(
      layout.turnKeys.length,
      Math.max(visibleEnd, visibleStart + 1) + overscan,
    ),
  };
}

export function anchorRange(
  layout: TurnLayout,
  anchorKey: string,
  previousRange: TurnRange,
): TurnRange | null {
  const anchorIndex = layout.turnIndexByKey.get(anchorKey);
  if (anchorIndex === undefined) return null;
  return {
    startIndex: anchorIndex,
    endIndex: Math.min(
      layout.turnKeys.length,
      anchorIndex + previousRange.endIndex - previousRange.startIndex,
    ),
  };
}

export function compensateDistanceFromBottom(
  anchorKey: string,
  distanceFromBottomPx: number,
  previousLayout: TurnLayout,
  nextLayout: TurnLayout,
): number | null {
  const previousIndex = previousLayout.turnIndexByKey.get(anchorKey);
  const nextIndex = nextLayout.turnIndexByKey.get(anchorKey);
  if (previousIndex === undefined || nextIndex === undefined) return null;
  const previousAnchorTopFromBottom =
    (previousLayout.bottomOffsetsPx[previousIndex] ?? 0) + (previousLayout.heightsPx[previousIndex] ?? 0);
  const nextAnchorTopFromBottom =
    (nextLayout.bottomOffsetsPx[nextIndex] ?? 0) + (nextLayout.heightsPx[nextIndex] ?? 0);
  return Math.max(0, distanceFromBottomPx + nextAnchorTopFromBottom - previousAnchorTopFromBottom);
}

export function distanceFromBottomToCenterTurn(
  layout: TurnLayout,
  turnKey: string,
  viewportHeightPx: number,
): number | null {
  const index = layout.turnIndexByKey.get(turnKey);
  if (index === undefined) return null;
  return Math.max(
    0,
    (layout.bottomOffsetsPx[index] ?? 0)
      - finiteNonNegative(viewportHeightPx) / 2
      + (layout.heightsPx[index] ?? 0) / 2,
  );
}

export function distanceFromBottomToTopTurn({
  layout,
  topAlignmentInsetPx = OPENCRAFT_TURN_VIRTUALIZER_CONFIG.topAlignmentInsetPx,
  turnKey,
  viewportHeightPx,
}: {
  readonly layout: TurnLayout;
  readonly topAlignmentInsetPx?: number;
  readonly turnKey: string;
  readonly viewportHeightPx: number;
}): number | null {
  const index = layout.turnIndexByKey.get(turnKey);
  if (index === undefined) return null;
  const turnTopFromBottom = (layout.bottomOffsetsPx[index] ?? 0) + (layout.heightsPx[index] ?? 0);
  return Math.max(
    0,
    turnTopFromBottom
      - finiteNonNegative(viewportHeightPx)
      + Math.max(0, topAlignmentInsetPx),
  );
}

export function distanceFromBottomToTargetWithinTurn({
  align,
  layout,
  targetHeightPx,
  targetTopOffsetWithinTurnPx,
  topAlignmentInsetPx = OPENCRAFT_TURN_VIRTUALIZER_CONFIG.topAlignmentInsetPx,
  turnKey,
  viewportHeightPx,
}: {
  readonly align: "center" | "top";
  readonly layout: TurnLayout;
  readonly targetHeightPx: number;
  readonly targetTopOffsetWithinTurnPx: number;
  readonly topAlignmentInsetPx?: number;
  readonly turnKey: string;
  readonly viewportHeightPx: number;
}): number | null {
  const index = layout.turnIndexByKey.get(turnKey);
  if (index === undefined) return null;
  const targetTopFromBottom = (layout.bottomOffsetsPx[index] ?? 0)
    + (layout.heightsPx[index] ?? 0)
    - targetTopOffsetWithinTurnPx;
  return align === "top"
    ? Math.max(
        0,
        targetTopFromBottom
          - finiteNonNegative(viewportHeightPx)
          + Math.max(0, topAlignmentInsetPx),
      )
    : Math.max(0, targetTopFromBottom - targetHeightPx / 2 - viewportHeightPx / 2);
}

export function computeTurnViewportBounds(
  layout: TurnLayout,
  distanceFromBottomPx: number,
  viewportHeightPx: number,
): { readonly viewportStartPx: number; readonly viewportEndPx: number } {
  const viewportEndPx = Math.max(
    0,
    Math.min(layout.totalHeightPx, layout.totalHeightPx - distanceFromBottomPx),
  );
  return {
    viewportEndPx,
    viewportStartPx: Math.max(0, viewportEndPx - viewportHeightPx),
  };
}

export function getTurnGeometry(layout: TurnLayout, turnKey: string): TurnGeometry | null {
  const index = layout.turnIndexByKey.get(turnKey);
  if (index === undefined) return null;
  const startPx = layout.topOffsetsPx[index];
  const heightPx = layout.heightsPx[index];
  return startPx === undefined || heightPx === undefined
    ? null
    : { startPx, endPx: startPx + heightPx };
}

function rangeContains(outer: TurnRange, inner: TurnRange): boolean {
  return outer.startIndex <= inner.startIndex && outer.endIndex >= inner.endIndex;
}

function equalKeys(left: readonly string[], right: readonly string[]): boolean {
  return left === right || (left.length === right.length && left.every((key, index) => key === right[index]));
}

export function createTurnViewportState(
  layout: TurnLayout,
  distanceFromBottomPx: number,
  viewportHeightPx: number,
  restoreState: VirtualizedTurnRestoreState | null = null,
  config: Readonly<TurnVirtualizerConfig> = OPENCRAFT_TURN_VIRTUALIZER_CONFIG,
): VirtualizedTurnViewportState {
  const distance = Math.min(finiteNonNegative(distanceFromBottomPx), layout.totalHeightPx);
  const height = finiteNonNegative(viewportHeightPx, config.fallbackViewportHeightPx)
    || config.fallbackViewportHeightPx;
  const computedRange = computeTurnRange(layout, distance, height, config.overscanTurnCount);
  const restoredRange = restoreState === null
    ? null
    : anchorRange(layout, restoreState.renderedWindow.anchorKey, {
        startIndex: 0,
        endIndex: Math.min(
          restoreState.renderedWindow.count,
          computedRange.endIndex - computedRange.startIndex,
        ),
      });
  const renderedRange = restoredRange !== null && rangeContains(restoredRange, computedRange)
    ? restoredRange
    : computedRange;
  return {
    distanceFromBottomPx: distance,
    viewportHeightPx: height,
    renderedRange,
    turnKeys: layout.turnKeys,
  };
}

export function updateTurnViewportState(
  current: VirtualizedTurnViewportState,
  layout: TurnLayout,
  distanceFromBottomPx: number,
  viewportHeightPx: number,
  config: Readonly<TurnVirtualizerConfig> = OPENCRAFT_TURN_VIRTUALIZER_CONFIG,
): VirtualizedTurnViewportState {
  const distance = Math.min(finiteNonNegative(distanceFromBottomPx), layout.totalHeightPx);
  const height = finiteNonNegative(viewportHeightPx, config.fallbackViewportHeightPx)
    || config.fallbackViewportHeightPx;
  const computedRange = computeTurnRange(layout, distance, height, config.overscanTurnCount);
  const renderedRange = rangeContains(current.renderedRange, computedRange)
    ? current.renderedRange
    : computedRange;
  if (
    current.distanceFromBottomPx === distance
    && current.viewportHeightPx === height
    && current.renderedRange.startIndex === renderedRange.startIndex
    && current.renderedRange.endIndex === renderedRange.endIndex
    && equalKeys(current.turnKeys, layout.turnKeys)
  ) return current;
  return {
    distanceFromBottomPx: distance,
    viewportHeightPx: height,
    renderedRange,
    turnKeys: layout.turnKeys,
  };
}

export function findMeasuredViewportAnchor(
  layout: TurnLayout,
  nextLayout: TurnLayout,
  measuredHeightsByKey: Readonly<Record<string, number>>,
  distanceFromBottomPx: number,
  viewportHeightPx: number,
): string | null {
  const visibleRange = computeTurnRange(layout, distanceFromBottomPx, viewportHeightPx, 0);
  for (let index = visibleRange.startIndex; index < visibleRange.endIndex; index += 1) {
    const key = layout.turnKeys[index];
    if (key !== undefined && measuredHeightsByKey[key] !== undefined && nextLayout.turnIndexByKey.has(key)) {
      return key;
    }
  }
  return null;
}

export function serializeTurnRestoreState(
  measuredHeightsByKey: Readonly<Record<string, number>>,
  turnKeys: readonly string[],
  renderedRange: TurnRange,
): VirtualizedTurnRestoreState | null {
  const retainedHeights: Record<string, number> = {};
  for (const key of turnKeys) {
    const height = measuredHeightsByKey[key];
    if (height !== undefined) retainedHeights[key] = height;
  }
  const anchorKey = turnKeys[renderedRange.startIndex];
  if (anchorKey === undefined || Object.keys(retainedHeights).length === 0) return null;
  return {
    renderedWindow: {
      anchorKey,
      count: renderedRange.endIndex - renderedRange.startIndex,
    },
    turnHeightsByKey: retainedHeights,
  };
}

export function createTurnWindowSlice<TEntry extends VirtualizedTurnEntry>(
  entries: readonly TEntry[],
  layout: TurnLayout,
  range: TurnRange,
  gapPx = OPENCRAFT_TURN_VIRTUALIZER_CONFIG.gapPx,
): TurnWindowSlice<TEntry> {
  return {
    entries: entries.slice(range.startIndex, range.endIndex),
    range,
    marginTopPx: layout.topOffsetsPx[range.startIndex] ?? 0,
    totalHeightPx: layout.totalHeightPx,
    gapPx,
  };
}
