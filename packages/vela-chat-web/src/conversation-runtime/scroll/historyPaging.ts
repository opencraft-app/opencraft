export const DEFAULT_HISTORY_START_THRESHOLD_PX = 96;

export interface HistoryPagingState {
  hasOlderHistory: boolean;
  isHistoryStartReady?: boolean;
  isLoadingOlderHistory: boolean;
  scrollTop: number;
  thresholdPx?: number;
}

export interface HistoryPrependScrollAnchor {
  previousScrollHeight: number;
  previousScrollTop: number;
  scrollHeight: number;
}

export interface ActiveHistoryPrependAnchor {
  previousScrollHeight: number;
  previousScrollTop: number;
}

export interface HistoryPrependAnchorResizeState {
  anchor: ActiveHistoryPrependAnchor | null;
  isLoadingOlderHistory: boolean;
  scrollHeight: number;
}

export interface HistoryPrependAnchorResizeResult {
  nextAnchor: ActiveHistoryPrependAnchor | null;
  scrollTop: number | null;
}

export function shouldRequestOlderHistory({
  hasOlderHistory,
  isHistoryStartReady = true,
  isLoadingOlderHistory,
  scrollTop,
  thresholdPx = DEFAULT_HISTORY_START_THRESHOLD_PX,
}: HistoryPagingState): boolean {
  if (!isHistoryStartReady) return false;
  if (!hasOlderHistory || isLoadingOlderHistory) return false;
  if (!Number.isFinite(scrollTop)) return false;
  return scrollTop <= Math.max(0, thresholdPx);
}

export function deriveScrollTopAfterHistoryPrepend({
  previousScrollHeight,
  previousScrollTop,
  scrollHeight,
}: HistoryPrependScrollAnchor): number {
  const safePreviousScrollTop = Number.isFinite(previousScrollTop)
    ? Math.max(0, previousScrollTop)
    : 0;
  if (!Number.isFinite(previousScrollHeight) || !Number.isFinite(scrollHeight)) {
    return safePreviousScrollTop;
  }

  const heightDelta = Math.max(0, scrollHeight - previousScrollHeight);
  return safePreviousScrollTop + heightDelta;
}

export function deriveHistoryPrependAnchorAfterResize({
  anchor,
  isLoadingOlderHistory,
  scrollHeight,
}: HistoryPrependAnchorResizeState): HistoryPrependAnchorResizeResult {
  if (!anchor || !Number.isFinite(scrollHeight)) {
    return { nextAnchor: anchor, scrollTop: null };
  }
  if (scrollHeight <= anchor.previousScrollHeight) {
    return { nextAnchor: anchor, scrollTop: null };
  }

  const scrollTop = deriveScrollTopAfterHistoryPrepend({
    previousScrollHeight: anchor.previousScrollHeight,
    previousScrollTop: anchor.previousScrollTop,
    scrollHeight,
  });

  if (isLoadingOlderHistory) {
    return {
      scrollTop,
      nextAnchor: {
        previousScrollHeight: scrollHeight,
        previousScrollTop: scrollTop,
      },
    };
  }

  return { nextAnchor: null, scrollTop };
}
