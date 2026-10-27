import {
  createTurnMeasurementTransaction,
  type TurnHeightMeasurement,
  type TurnMeasurementTransaction,
} from "./measurement";
import type {
  TurnLayout,
  TurnVirtualizerConfig,
  VirtualizedTurnEntry,
  VirtualizedTurnViewportState,
} from "./types";
import {
  buildTurnLayout,
  OPENCRAFT_TURN_VIRTUALIZER_CONFIG,
  createTurnViewportState,
  createTurnWindowSlice,
  updateTurnViewportState,
} from "./virtualizer";

/**
 * Domain-neutral viewport API. A Timeline entry is only a stable measurable
 * layout unit; callers must not infer conversation semantics from it.
 */
export interface VirtualizedTimelineEntry {
  readonly timelineKey: string;
  readonly estimatedHeightPx?: number;
}

export interface TimelineLayout {
  readonly entryKeys: readonly string[];
  readonly totalHeightPx: number;
}

export interface TimelineRange {
  /** Inclusive. */
  readonly startIndex: number;
  /** Exclusive. */
  readonly endIndex: number;
}

export interface TimelineVirtualizerConfig {
  readonly estimatedEntryHeightPx: number;
  readonly gapPx: number;
  readonly overscanEntryCount: number;
  readonly fallbackViewportHeightPx: number;
  readonly topAlignmentInsetPx: number;
}

export interface TimelineViewportState {
  readonly distanceFromBottomPx: number;
  readonly viewportHeightPx: number;
  readonly renderedRange: TimelineRange;
  readonly entryKeys: readonly string[];
}

export interface TimelineHeightMeasurement {
  readonly timelineKey: string;
  readonly heightPx: number;
}

export interface TimelineMeasurementTransaction {
  readonly measuredHeightsByKey: Readonly<Record<string, number>>;
  readonly layout: TimelineLayout;
  readonly viewport: TimelineViewportState;
  readonly restoreScrollDistanceFromBottom: boolean;
  readonly scrollDistanceFromBottomPx: number | null;
  readonly preservePlatformScrollForNextLayout: boolean;
  readonly layoutHeightDeltaPx: number;
}

export interface TimelineWindowSlice<TEntry extends VirtualizedTimelineEntry> {
  readonly entries: readonly TEntry[];
  readonly range: TimelineRange;
  readonly marginTopPx: number;
  readonly totalHeightPx: number;
  readonly gapPx: number;
}

export const TIMELINE_VIRTUALIZER_CONFIG: Readonly<TimelineVirtualizerConfig> =
  Object.freeze({
    estimatedEntryHeightPx:
      OPENCRAFT_TURN_VIRTUALIZER_CONFIG.estimatedTurnHeightPx,
    gapPx: OPENCRAFT_TURN_VIRTUALIZER_CONFIG.gapPx,
    overscanEntryCount: OPENCRAFT_TURN_VIRTUALIZER_CONFIG.overscanTurnCount,
    fallbackViewportHeightPx:
      OPENCRAFT_TURN_VIRTUALIZER_CONFIG.fallbackViewportHeightPx,
    topAlignmentInsetPx:
      OPENCRAFT_TURN_VIRTUALIZER_CONFIG.topAlignmentInsetPx,
  });

const nativeLayouts = new WeakMap<TimelineLayout, TurnLayout>();
const nativeViewports = new WeakMap<TimelineViewportState, VirtualizedTurnViewportState>();

function toTurnEntries<TEntry extends VirtualizedTimelineEntry>(
  entries: readonly TEntry[],
): readonly (VirtualizedTurnEntry & { readonly entry: TEntry })[] {
  return entries.map((entry) => ({
    turnKey: entry.timelineKey,
    estimatedHeightPx: entry.estimatedHeightPx,
    entry,
  }));
}

function toTurnConfig(
  config: Readonly<TimelineVirtualizerConfig>,
): Readonly<TurnVirtualizerConfig> {
  return {
    estimatedTurnHeightPx: config.estimatedEntryHeightPx,
    gapPx: config.gapPx,
    overscanTurnCount: config.overscanEntryCount,
    fallbackViewportHeightPx: config.fallbackViewportHeightPx,
    topAlignmentInsetPx: config.topAlignmentInsetPx,
  };
}

function wrapLayout(native: TurnLayout): TimelineLayout {
  const layout: TimelineLayout = Object.freeze({
    entryKeys: native.turnKeys,
    totalHeightPx: native.totalHeightPx,
  });
  nativeLayouts.set(layout, native);
  return layout;
}

function unwrapLayout(layout: TimelineLayout): TurnLayout {
  const native = nativeLayouts.get(layout);
  if (native === undefined) throw new Error("Timeline layout belongs to another viewport lifetime");
  return native;
}

function wrapViewport(native: VirtualizedTurnViewportState): TimelineViewportState {
  const viewport: TimelineViewportState = Object.freeze({
    distanceFromBottomPx: native.distanceFromBottomPx,
    viewportHeightPx: native.viewportHeightPx,
    renderedRange: native.renderedRange,
    entryKeys: native.turnKeys,
  });
  nativeViewports.set(viewport, native);
  return viewport;
}

function unwrapViewport(viewport: TimelineViewportState): VirtualizedTurnViewportState {
  const native = nativeViewports.get(viewport);
  if (native === undefined) throw new Error("Timeline viewport belongs to another viewport lifetime");
  return native;
}

export function buildTimelineLayout(
  entries: readonly VirtualizedTimelineEntry[],
  measuredHeightsByKey: Readonly<Record<string, number>> = {},
  config: Readonly<TimelineVirtualizerConfig> = TIMELINE_VIRTUALIZER_CONFIG,
): TimelineLayout {
  return wrapLayout(
    buildTurnLayout(
      toTurnEntries(entries),
      measuredHeightsByKey,
      toTurnConfig(config),
    ),
  );
}

export function createTimelineViewportState(
  layout: TimelineLayout,
  distanceFromBottomPx: number,
  viewportHeightPx: number,
  config: Readonly<TimelineVirtualizerConfig> = TIMELINE_VIRTUALIZER_CONFIG,
): TimelineViewportState {
  return wrapViewport(createTurnViewportState(
    unwrapLayout(layout),
    distanceFromBottomPx,
    viewportHeightPx,
    null,
    toTurnConfig(config),
  ));
}

export function updateTimelineViewportState(
  current: TimelineViewportState,
  layout: TimelineLayout,
  distanceFromBottomPx: number,
  viewportHeightPx: number,
  config: Readonly<TimelineVirtualizerConfig> = TIMELINE_VIRTUALIZER_CONFIG,
): TimelineViewportState {
  const currentNative = unwrapViewport(current);
  const nextNative = updateTurnViewportState(
    currentNative,
    unwrapLayout(layout),
    distanceFromBottomPx,
    viewportHeightPx,
    toTurnConfig(config),
  );
  return nextNative === currentNative ? current : wrapViewport(nextNative);
}

export function createTimelineMeasurementTransaction<
  TEntry extends VirtualizedTimelineEntry,
>({
  entries,
  measurements,
  measuredHeightsByKey,
  layout,
  viewport,
  currentDistanceFromBottomPx,
  bottomPaddingPx,
  preserveMeasuredViewport,
  getPendingRestoreScrollDistanceFromBottomPx,
  config = TIMELINE_VIRTUALIZER_CONFIG,
}: {
  readonly entries: readonly TEntry[];
  readonly measurements: readonly TimelineHeightMeasurement[];
  readonly measuredHeightsByKey: Readonly<Record<string, number>>;
  readonly layout: TimelineLayout;
  readonly viewport: TimelineViewportState;
  readonly currentDistanceFromBottomPx: number;
  readonly bottomPaddingPx: number;
  readonly preserveMeasuredViewport: boolean;
  readonly getPendingRestoreScrollDistanceFromBottomPx: (() => number | null) | null;
  readonly config?: Readonly<TimelineVirtualizerConfig>;
}): TimelineMeasurementTransaction | null {
  const transaction: TurnMeasurementTransaction | null = createTurnMeasurementTransaction({
    entries: toTurnEntries(entries),
    measurements: measurements.map<TurnHeightMeasurement>((measurement) => ({
      turnKey: measurement.timelineKey,
      heightPx: measurement.heightPx,
    })),
    measuredHeightsByKey,
    layout: unwrapLayout(layout),
    viewport: unwrapViewport(viewport),
    currentDistanceFromBottomPx,
    bottomPaddingPx,
    preserveMeasuredTurnViewport: preserveMeasuredViewport,
    getPendingRestoreScrollDistanceFromBottomPx,
    config: toTurnConfig(config),
  });
  if (transaction === null) return null;
  return Object.freeze({
    measuredHeightsByKey: transaction.measuredHeightsByKey,
    layout: wrapLayout(transaction.layout),
    viewport: wrapViewport(transaction.viewport),
    restoreScrollDistanceFromBottom: transaction.restoreScrollDistanceFromBottom,
    scrollDistanceFromBottomPx: transaction.scrollDistanceFromBottomPx,
    preservePlatformScrollForNextLayout:
      transaction.preservePlatformScrollForNextLayout,
    layoutHeightDeltaPx: transaction.layoutHeightDeltaPx,
  });
}

export function createTimelineWindowSlice<TEntry extends VirtualizedTimelineEntry>(
  entries: readonly TEntry[],
  layout: TimelineLayout,
  range: TimelineRange,
  gapPx = TIMELINE_VIRTUALIZER_CONFIG.gapPx,
): TimelineWindowSlice<TEntry> {
  const native = createTurnWindowSlice(
    toTurnEntries(entries),
    unwrapLayout(layout),
    range,
    gapPx,
  );
  return {
    entries: native.entries.map(({ entry }) => entry),
    range: native.range,
    marginTopPx: native.marginTopPx,
    totalHeightPx: native.totalHeightPx,
    gapPx: native.gapPx,
  };
}
