export interface VirtualizedTurnEntry {
  /** Stable across streaming updates, history hydration, and route restoration. */
  readonly turnKey: string;
  /** Used until the platform reports a measured height. History gaps must provide it. */
  readonly estimatedHeightPx?: number;
}

export interface TurnRange {
  /** Inclusive. */
  readonly startIndex: number;
  /** Exclusive. */
  readonly endIndex: number;
}

export interface TurnLayout {
  readonly turnKeys: readonly string[];
  readonly turnIndexByKey: ReadonlyMap<string, number>;
  readonly heightsPx: readonly number[];
  readonly topOffsetsPx: readonly number[];
  /** Distance from the bottom edge of the whole list to the bottom edge of each Turn. */
  readonly bottomOffsetsPx: readonly number[];
  readonly totalHeightPx: number;
}

export interface VirtualizedTurnViewportState {
  readonly distanceFromBottomPx: number;
  readonly viewportHeightPx: number;
  readonly renderedRange: TurnRange;
  readonly turnKeys: readonly string[];
}

export interface VirtualizedTurnRenderedWindow {
  readonly anchorKey: string;
  readonly count: number;
}

export interface VirtualizedTurnRestoreState {
  readonly renderedWindow: VirtualizedTurnRenderedWindow;
  readonly turnHeightsByKey: Readonly<Record<string, number>>;
}

export interface TurnVirtualizerConfig {
  readonly estimatedTurnHeightPx: number;
  readonly gapPx: number;
  readonly overscanTurnCount: number;
  readonly fallbackViewportHeightPx: number;
  /** Default top inset for generic Turn positioning. */
  readonly topAlignmentInsetPx: number;
}

export interface TurnGeometry {
  readonly startPx: number;
  readonly endPx: number;
}

export interface TurnWindowSlice<TEntry extends VirtualizedTurnEntry> {
  readonly entries: readonly TEntry[];
  readonly range: TurnRange;
  readonly marginTopPx: number;
  readonly totalHeightPx: number;
  readonly gapPx: number;
}
