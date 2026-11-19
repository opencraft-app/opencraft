import { historyPresentationAttributes } from "./history-presentation";
import type { ConversationRecoveryPresentation } from "@opencraft/chat-core";
import { ScrollToBottomButton } from "./scroll-to-bottom-button";
import { shouldShowScrollToBottomAction } from "@opencraft/timeline-virtualizer";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { hasTimelineInteraction } from "@opencraft/timeline-host-web";
import {
  createWebTimelineViewportOwner,
  type WebTimelineViewportOwner,
  type WebTimelineMeasurement,
} from "@opencraft/timeline-host-web/timeline";
import {
  buildTimelineLayout,
  createTimelineViewportState,
  createTimelineWindowSlice,
  createTimelineMeasurementTransaction,
  reconcileTimelineLayoutViewport,
  TIMELINE_VIRTUALIZER_CONFIG,
  type TimelineLayout,
  type VirtualizedTimelineEntry,
} from "@opencraft/timeline-virtualizer/timeline";

export interface MessageTimelineCheckpoint {
  readonly layout: TimelineLayout;
  readonly heights: Readonly<Record<string, number>>;
  readonly distance: number;
  readonly viewportHeight: number;
}

const config = { ...TIMELINE_VIRTUALIZER_CONFIG, gapPx: 0, estimatedEntryHeightPx: 96, overscanEntryCount: 4 };
function MeasuredEntry({ owner, id, children }: { owner: WebTimelineViewportOwner; id: string; children: ReactNode }) {
  const attach = useCallback((element: HTMLDivElement | null) => owner.observeEntry(id, element), [owner, id]);
  return (
    <div ref={attach} data-timeline-entry={id}>
      {children}
    </div>
  );
}

/** A Web adapter of the same measurement/window/scroll owners as ordinary Chat.
 * Rows are stable layout identities, never execution Turns. No channel state lives here. */
export function MessageTimeline<T extends VirtualizedTimelineEntry>({
  entries: items,
  renderEntry,
  checkpoint,
  onCheckpoint,
  onViewport,
  onReadLatest,
  onLoadEarlier,
  className,
  label,
  revealKey,
  retainedKeys = [],
  footer,
  latestLabel,
  historyPresentation = "none",
}: {
  historyPresentation?: ConversationRecoveryPresentation;
  entries: readonly T[];
  renderEntry(entry: T): ReactNode;
  checkpoint?: MessageTimelineCheckpoint;
  onCheckpoint(value: MessageTimelineCheckpoint): void;
  onViewport?(element: HTMLDivElement | null): void;
  onReadLatest?(): void;
  onLoadEarlier?(): void;
  revealKey?: string;
  className?: string;
  label: string;
  retainedKeys?: readonly string[];
  footer?: ReactNode;
  latestLabel?: string;
}) {
  const [owner] = useState(() => createWebTimelineViewportOwner(checkpoint?.distance ?? 0));
  const footerHeight = useSyncExternalStore(owner.subscribeFooterHeight, owner.getFooterHeight, () => 0);
  const dockKey = "\0message-timeline-dock";
  const entries = useMemo(
    () => (footer ? [...items, { timelineKey: dockKey, estimatedHeightPx: footerHeight } as T] : items),
    [items, !!footer, footerHeight],
  );
  const [initial] = useState(() => {
    const heights = checkpoint?.heights ?? {};
    const layout = buildTimelineLayout(entries, heights, config);
    const distance = checkpoint
      ? (reconcileTimelineLayoutViewport({
          previousLayout: checkpoint.layout,
          nextLayout: layout,
          measuredHeightsByKey: heights,
          currentDistanceFromBottomPx: checkpoint.distance,
          viewportHeightPx: checkpoint.viewportHeight,
        }) ?? checkpoint.distance)
      : 0;
    return { heights, layout, distance };
  });
  const [model, setModel] = useState(() => ({
    heights: initial.heights,
    layout: initial.layout,
    viewport: createTimelineViewportState(initial.layout, initial.distance, checkpoint?.viewportHeight ?? 800, config),
    entries,
  }));
  const live = useRef(model),
    props = useRef({ entries, onCheckpoint, onViewport, onReadLatest, onLoadEarlier });
  props.current = { entries, onCheckpoint, onViewport, onReadLatest, onLoadEarlier };
  const scroll = owner.scrollController;
  const [showLatest, setShowLatest] = useState(false);
  const [interactionKeys, setInteractionKeys] = useState<readonly string[]>([]);
  const retainInteractions = () => {
    const keys = Array.from(
      owner.scrollElementRef.current?.querySelectorAll<HTMLElement>("[data-timeline-entry]") ?? [],
    )
      .filter(hasTimelineInteraction)
      .map((element) => element.dataset.timelineEntry!);
    setInteractionKeys((current) =>
      current.length === keys.length && current.every((key, index) => key === keys[index]) ? current : keys,
    );
  };
  const publish = (next: typeof model) => {
    live.current = next;
    setModel(next);
  };
  const capture = () =>
    props.current.onCheckpoint({
      layout: live.current.layout,
      heights: live.current.heights,
      distance: scroll.getLastScrollDistanceFromBottomPx(),
      viewportHeight: owner.scrollElementRef.current?.clientHeight ?? 800,
    });
  const read = () => {
    const element = owner.scrollElementRef.current;
    if (
      element?.clientHeight &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      !element.closest('[inert],[hidden],[aria-hidden="true"]') &&
      scroll.getLastScrollDistanceFromBottomPx() <= 24
    )
      props.current.onReadLatest?.();
  };
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      owner.attachScrollElement(element);
      props.current.onViewport?.(element);
    },
    [owner],
  );

  // `base` is the confirmed distance a layout transaction was computed from.
  const pendingPosition = useRef<{ model: typeof model; distance: number; base: number } | null>(null);
  // A layout commit owns only its correction relative to `base`. The platform can
  // move before its scroll event confirms the distance (iOS touch-to-stop, momentum);
  // writing the absolute confirmed distance would rewind those unreported frames.
  // A zero correction is not a scroll command, so native momentum is never interrupted.
  const applyDistance = (distance: number, base: number) => {
    if (!owner.scrollElementRef.current) return;
    if (!scroll.compensateLayoutToDistanceFromBottomPx(distance, base)) scroll.reportPlatformScroll("system");
  };
  const commitMeasurements = (measurements: readonly WebTimelineMeasurement[], synchronous: boolean) => {
    const current = live.current;
    const base = pendingPosition.current?.base ?? scroll.getLastScrollDistanceFromBottomPx();
    const distance = pendingPosition.current?.distance ?? base;
    const transaction = createTimelineMeasurementTransaction({
      entries: current.entries,
      measurements,
      measuredHeightsByKey: current.heights,
      layout: current.layout,
      viewport: current.viewport,
      currentDistanceFromBottomPx: distance,
      bottomPaddingPx: 0,
      preserveMeasuredViewport: true,
      measuredContentFlowsNaturally: true,
      getPendingRestoreScrollDistanceFromBottomPx: null,
      config,
    });
    if (!transaction) return;
    const next = {
      heights: transaction.measuredHeightsByKey,
      layout: transaction.layout,
      viewport: transaction.viewport,
      entries: current.entries,
    };
    pendingPosition.current = { model: next, distance: transaction.scrollDistanceFromBottomPx ?? distance, base };
    if (synchronous) flushSync(() => publish(next));
    else publish(next);
  };

  useLayoutEffect(() => {
    const unbind = owner.bindScrollBehavior({ onUserScrollToTop: () => props.current.onLoadEarlier?.() });
    const unsubscribe = scroll.subscribe((snapshot) => {
      if (!snapshot.viewportHeightPx) return;
      setShowLatest(
        shouldShowScrollToBottomAction({
          isScrolledFromBottom: snapshot.isScrolledFromBottom,
          scrollDistanceFromBottomPx: snapshot.distanceFromBottomPx,
          responseSpacerHeightPx: null,
        }),
      );
      retainInteractions();
      const current = live.current;
      publish({
        ...current,
        viewport: createTimelineViewportState(
          current.layout,
          snapshot.distanceFromBottomPx,
          snapshot.viewportHeightPx,
          config,
        ),
      });
      capture();
      read();
    });
    // The viewport owner already batches ResizeObserver records before paint.
    owner.setMeasurementListener((batch) => commitMeasurements(batch.measurements, true));
    // The inverted scroller keeps its distance from the bottom across viewport
    // resizes; geometry changes only confirm the current position.
    const unobserve = owner.observeViewportGeometry(() => {
      if (owner.scrollElementRef.current) scroll.reportPlatformScroll("system");
    });
    scroll.scrollToDistanceFromBottomPx(initial.distance, "instant");
    document.addEventListener("selectionchange", retainInteractions);
    document.addEventListener("focusin", retainInteractions);
    document.addEventListener("focusout", retainInteractions);
    document.addEventListener("visibilitychange", read);
    window.addEventListener("focus", read);
    return () => {
      document.removeEventListener("selectionchange", retainInteractions);
      document.removeEventListener("focusin", retainInteractions);
      document.removeEventListener("focusout", retainInteractions);
      capture();
      document.removeEventListener("visibilitychange", read);
      window.removeEventListener("focus", read);
      unobserve();
      unsubscribe();
      unbind();
      owner.setMeasurementListener(null);
      owner.dispose();
    };
  }, [owner]);

  useLayoutEffect(() => {
    const current = live.current;
    const nextLayout = buildTimelineLayout(entries, current.heights, config);
    const base = scroll.getLastScrollDistanceFromBottomPx();
    const distance =
      reconcileTimelineLayoutViewport({
        previousLayout: current.layout,
        nextLayout,
        measuredHeightsByKey: current.heights,
        currentDistanceFromBottomPx: base,
        viewportHeightPx: owner.scrollElementRef.current?.clientHeight ?? current.viewport.viewportHeightPx,
      }) ?? base;
    const next = {
      ...current,
      entries,
      layout: nextLayout,
      viewport: createTimelineViewportState(
        nextLayout,
        distance,
        owner.scrollElementRef.current?.clientHeight ?? 800,
        config,
      ),
    };
    pendingPosition.current = { model: next, distance, base };
    publish(next);
  }, [entries, owner]);
  useLayoutEffect(() => {
    const pending = pendingPosition.current;
    if (!pending || pending.model !== model) return;
    pendingPosition.current = null;
    applyDistance(pending.distance, pending.base);
    capture();
    read();
  }, [model]);
  useLayoutEffect(() => {
    const measurements = owner.measureNewlyMountedEntries();
    if (measurements.length) commitMeasurements(measurements, false);
  });

  const revealed = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!revealKey || revealed.current === revealKey) return;
    const element = owner.scrollElementRef.current?.querySelector<HTMLElement>(
      '[data-timeline-entry="' + CSS.escape(revealKey) + '"]',
    );
    if (element) {
      element.scrollIntoView({ block: "center", behavior: "instant" });
      revealed.current = revealKey;
    }
  }, [revealKey, model, owner]);
  const range = { ...model.viewport.renderedRange };
  for (const key of [
    ...interactionKeys,
    ...retainedKeys,
    ...(revealKey && revealed.current !== revealKey ? [revealKey] : []),
  ]) {
    const index = model.layout.entryKeys.indexOf(key);
    if (index < 0) continue;
    range.startIndex = Math.min(range.startIndex, index);
    range.endIndex = Math.max(range.endIndex, index + 1);
  }
  const slice = createTimelineWindowSlice(model.entries, model.layout, range, 0);
  const content = (
    <div
      ref={attach}
      className={className}
      data-message-timeline=""
      role="region"
      aria-label={label}
      style={{ display: "flex", flexDirection: "column-reverse", overflowAnchor: "none" }}
    >
      <div style={{ flex: "none", minHeight: `max(100%, ${slice.totalHeightPx}px)`, boxSizing: "border-box" }}>
        <div
          role="list"
          {...historyPresentationAttributes(historyPresentation)}
          inert={historyPresentation.startsWith("warm-") || undefined}
          style={{ paddingTop: slice.marginTopPx, paddingBottom: slice.paddingBottomPx }}
        >
          {slice.entries.map((entry) =>
            entry.timelineKey === dockKey ? (
              <div key={dockKey} aria-hidden="true" style={{ height: footerHeight }} />
            ) : (
              <MeasuredEntry key={entry.timelineKey} owner={owner} id={entry.timelineKey}>
                {renderEntry(entry)}
              </MeasuredEntry>
            ),
          )}
        </div>
      </div>
    </div>
  );
  if (!footer) return content;
  return (
    <div className="message-timeline-plane">
      {content}
      <div
        ref={owner.attachFooterElement}
        className="thread-scroll-footer message-timeline-dock"
        data-thread-scroll-footer="true"
      >
        <div className="thread-scroll-to-bottom-anchor">
          <ScrollToBottomButton
            label={latestLabel ?? label}
            show={showLatest}
            onClick={() => scroll.scrollToBottom()}
          />
        </div>
        {footer}
      </div>
    </div>
  );
}
