import type { BotTimelineUnit } from "@opencraft/bot-conversation";
import { createWebTimelineViewportOwner } from "@opencraft/timeline-host-web";
import {
  buildTimelineLayout,
  createTimelineMeasurementTransaction,
  createTimelineViewportState,
  createTimelineWindowSlice,
  TIMELINE_VIRTUALIZER_CONFIG,
  updateTimelineViewportState,
} from "@opencraft/timeline-virtualizer";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefCallback,
} from "react";

interface VirtualizedBotUnit {
  readonly timelineKey: string;
  readonly estimatedHeightPx: number;
  readonly unit: BotTimelineUnit;
}

export interface BotConversationViewport {
  readonly following: boolean;
  readonly historyLoading: boolean;
  readonly historyError: string | null;
  requestOlderHistory(): void;
  readonly transcriptRef: RefCallback<HTMLDivElement>;
  readonly totalHeightPx: number;
  readonly marginTopPx: number;
  readonly gapPx: number;
  readonly units: readonly BotTimelineUnit[];
  observeUnit(unitKey: string, element: HTMLDivElement | null): void;
  followLatest(options?: { readonly smooth?: boolean }): void;
}

export interface BotConversationHistoryDemand {
  readonly enabled: boolean;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  readonly loadOlder: () => Promise<void>;
}

const EMPTY_HISTORY_PAGE_BUDGET = 3;

/**
 * Bot-specific adapter around the shared Codex-derived viewport machinery.
 * Its entries are geometry units only; Bot semantics remain owned by
 * Transcript/Execution/Presence.
 */
export function useBotConversationViewport(
  identity: string,
  units: readonly BotTimelineUnit[],
  history?: BotConversationHistoryDemand,
): BotConversationViewport {
  const historyOwner = useMemo(() => ({ budget: EMPTY_HISTORY_PAGE_BUDGET, activeGeneration: null as number | null, generation: 0, disposed: false }), [identity]);
  const historyRef = useRef(history);
  const unitsRef = useRef(units);
  historyRef.current = history;
  unitsRef.current = units;
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  useLayoutEffect(() => {
    historyOwner.disposed = false;
    historyOwner.budget = EMPTY_HISTORY_PAGE_BUDGET;
    setHistoryLoading(false);
    setHistoryError(null);
    return () => { historyOwner.disposed = true; historyOwner.generation += 1; historyOwner.activeGeneration = null; };
  }, [historyOwner]);
  const loadHistoryPage = useCallback(() => {
    const demand = historyRef.current;
    if (historyOwner.disposed || historyOwner.activeGeneration !== null || historyOwner.budget <= 0
      || demand?.enabled !== true || !demand.hasOlder || demand.loadingOlder) return;
    const generation = historyOwner.generation;
    historyOwner.activeGeneration = generation;
    historyOwner.budget -= 1;
    setHistoryLoading(true);
    void Promise.resolve().then(() => {
      if (!historyOwner.disposed && generation === historyOwner.generation) return demand.loadOlder();
    }).catch(() => {
      if (!historyOwner.disposed && generation === historyOwner.generation) {
        historyOwner.budget = 0;
        setHistoryError("Could not load earlier messages.");
      }
    }).finally(() => {
      if (historyOwner.activeGeneration === generation) historyOwner.activeGeneration = null;
      if (!historyOwner.disposed && generation === historyOwner.generation) setHistoryLoading(false);
    });
  }, [historyOwner]);
  const requestOlderHistory = useCallback(() => {
    if (historyOwner.activeGeneration !== null) return;
    historyOwner.budget = unitsRef.current.length === 0 ? EMPTY_HISTORY_PAGE_BUDGET : 1;
    setHistoryError(null);
    loadHistoryPage();
  }, [historyOwner, loadHistoryPage]);
  // An empty projection cannot produce a scroll-to-top gesture. Advance one
  // page per committed layout, bounded per recovery intent; failures and a
  // still-empty budget exhaustion remain explicitly recoverable in the View.
  useEffect(() => {
    if (units.length === 0 && historyError === null && !historyLoading) loadHistoryPage();
  }, [units.length, history?.enabled, history?.hasOlder, history?.loadingOlder, historyError, historyLoading, loadHistoryPage]);
  const entries = useMemo<readonly VirtualizedBotUnit[]>(
    () => units.map((unit) => ({
      timelineKey: unit.unitKey,
      estimatedHeightPx: unit.kind === "message"
        ? 72
        : 36,
      unit,
    })),
    [units],
  );
  const owner = useMemo(
    () => createWebTimelineViewportOwner(0),
    [identity],
  );
  const [measuredHeights, setMeasuredHeights] = useState<Readonly<Record<string, number>>>({});
  const layout = useMemo(
    () => buildTimelineLayout(entries, measuredHeights),
    [entries, measuredHeights],
  );
  const [viewport, setViewport] = useState(() =>
    createTimelineViewportState(
      layout,
      0,
      TIMELINE_VIRTUALIZER_CONFIG.fallbackViewportHeightPx,
    )
  );
  const [following, setFollowing] = useState(true);
  const entriesRef = useRef(entries);
  const layoutRef = useRef(layout);
  const viewportRef = useRef(viewport);
  const measuredRef = useRef(measuredHeights);
  const onUserScrollToTopRef = useRef(requestOlderHistory);
  entriesRef.current = entries;
  layoutRef.current = layout;
  viewportRef.current = viewport;
  measuredRef.current = measuredHeights;
  onUserScrollToTopRef.current = requestOlderHistory;

  const updateFromSnapshot = useCallback((snapshot: {
    readonly distanceFromBottomPx: number;
  }) => {
    const element = owner.scrollElementRef.current;
    if (element === null) return;
    setViewport((current) =>
      updateTimelineViewportState(
        current,
        layoutRef.current,
        snapshot.distanceFromBottomPx,
        element.clientHeight,
      )
    );
  }, [owner]);
  const updateFromPlatform = useCallback((origin: "user" | "system") => {
    owner.scrollController.reportPlatformScroll(origin);
  }, [owner]);

  useLayoutEffect(() => {
    setMeasuredHeights({});
    const element = owner.scrollElementRef.current;
    const next = createTimelineViewportState(
      buildTimelineLayout(entries),
      0,
      element?.clientHeight ?? TIMELINE_VIRTUALIZER_CONFIG.fallbackViewportHeightPx,
    );
    viewportRef.current = next;
    setViewport(next);
    owner.scrollController.scrollToDistanceFromBottomPx(0, "instant");
    setFollowing(true);
  }, [identity, owner]);

  useLayoutEffect(() => {
    const element = owner.scrollElementRef.current;
    if (element === null) return;
    setViewport((current) =>
      updateTimelineViewportState(
        current,
        layout,
        owner.scrollController.getLastScrollDistanceFromBottomPx(),
        element.clientHeight,
      )
    );
    if (following) owner.scrollController.scrollToDistanceFromBottomPx(0, "instant");
  }, [following, layout, owner]);

  useLayoutEffect(() => {
    owner.setMeasurementListener(({ measurements }) => {
      const element = owner.scrollElementRef.current;
      if (element === null) return;
      const transaction = createTimelineMeasurementTransaction({
        entries: entriesRef.current,
        measurements,
        measuredHeightsByKey: measuredRef.current,
        layout: layoutRef.current,
        viewport: viewportRef.current,
        currentDistanceFromBottomPx:
          owner.scrollController.getLastScrollDistanceFromBottomPx(),
        bottomPaddingPx: 0,
        // Generic anchor preservation and follow-to-latest are mutually
        // exclusive layout owners. Codex disables virtualizer preservation
        // while the latest surface owns follow; Bot applies the same invariant
        // without importing Turn semantics into its domain model.
        preserveMeasuredViewport: !following,
        getPendingRestoreScrollDistanceFromBottomPx: null,
      });
      if (transaction === null) return;
      measuredRef.current = transaction.measuredHeightsByKey;
      layoutRef.current = transaction.layout;
      viewportRef.current = transaction.viewport;
      if (transaction.preservePlatformScrollForNextLayout) {
        owner.scrollController.preserveScrollPositionForNextLayout();
      }
      setMeasuredHeights(transaction.measuredHeightsByKey);
      setViewport(transaction.viewport);
      if (transaction.scrollDistanceFromBottomPx !== null) {
        owner.scrollController.compensateScrollToDistanceFromBottomPx(
          transaction.scrollDistanceFromBottomPx,
        );
      }
    });
    return () => owner.setMeasurementListener(null);
  }, [following, owner]);

  useLayoutEffect(() => {
    const releaseViewport = owner.scrollController.subscribe(updateFromSnapshot);
    const releaseUserScroll = owner.scrollController.addUserScrollListener((distance) => {
      setFollowing(distance <= 24);
    });
    return () => {
      releaseViewport();
      releaseUserScroll();
    };
  }, [owner, updateFromSnapshot]);

  useEffect(() => {
    const releaseGeometry = owner.observeViewportGeometry(() =>
      updateFromPlatform("system")
    );
    const releaseInput = owner.bindScrollBehavior({
      onUserScrollToTop: () => onUserScrollToTopRef.current?.(),
    });
    updateFromPlatform("system");
    return () => {
      releaseGeometry();
      releaseInput();
    };
  }, [owner, updateFromPlatform]);

  useEffect(() => () => owner.dispose(), [owner]);

  const followLatest = useCallback((options?: { readonly smooth?: boolean }) => {
    setFollowing(true);
    if (options?.smooth === false) {
      owner.scrollController.scrollToDistanceFromBottomPx(0, "instant");
    } else {
      owner.scrollController.scrollToBottom();
    }
  }, [owner]);
  const observeUnit = useCallback(
    (unitKey: string, element: HTMLDivElement | null) =>
      owner.observeEntry(unitKey, element),
    [owner],
  );
  const windowSlice = createTimelineWindowSlice(
    entries,
    layout,
    viewport.renderedRange,
  );

  return {
    following,
    historyLoading: historyLoading || history?.loadingOlder === true,
    historyError,
    requestOlderHistory,
    transcriptRef: owner.attachScrollElement,
    totalHeightPx: windowSlice.totalHeightPx,
    marginTopPx: windowSlice.marginTopPx,
    gapPx: windowSlice.gapPx,
    units: windowSlice.entries.map((entry) => entry.unit),
    observeUnit,
    followLatest,
  };
}
