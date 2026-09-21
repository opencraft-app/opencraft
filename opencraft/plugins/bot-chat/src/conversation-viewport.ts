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
  readonly transcriptRef: RefCallback<HTMLDivElement>;
  readonly totalHeightPx: number;
  readonly marginTopPx: number;
  readonly gapPx: number;
  readonly units: readonly BotTimelineUnit[];
  observeUnit(unitKey: string, element: HTMLDivElement | null): void;
  followLatest(options?: { readonly smooth?: boolean }): void;
}

/**
 * Bot-specific adapter around the shared Codex-derived viewport machinery.
 * Its entries are geometry units only; Bot semantics remain owned by
 * Transcript/Execution/Presence.
 */
export function useBotConversationViewport(
  identity: string,
  units: readonly BotTimelineUnit[],
  onUserScrollToTop?: () => void,
): BotConversationViewport {
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
  const onUserScrollToTopRef = useRef(onUserScrollToTop);
  entriesRef.current = entries;
  layoutRef.current = layout;
  viewportRef.current = viewport;
  measuredRef.current = measuredHeights;
  onUserScrollToTopRef.current = onUserScrollToTop;

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
    transcriptRef: owner.attachScrollElement,
    totalHeightPx: windowSlice.totalHeightPx,
    marginTopPx: windowSlice.marginTopPx,
    gapPx: windowSlice.gapPx,
    units: windowSlice.entries.map((entry) => entry.unit),
    observeUnit,
    followLatest,
  };
}
