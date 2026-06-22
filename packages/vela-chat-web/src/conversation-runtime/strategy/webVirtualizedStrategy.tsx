import {
  memo,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { measureElement, useVirtualizer } from "@tanstack/react-virtual";
import {
  estimateStreamItemHeight,
  recordMeasuredStreamItemHeight,
} from "../model/estimateStreamItemHeight";
import type {
  ConversationRuntimeSegments,
  ConversationStreamItem,
} from "../model";
import styles from "../../styles/desktop.module.css";
import type { ConversationStrategy } from "./strategy";

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;
const OVERSCAN = 8;
const INITIAL_VIRTUAL_RANGE_OVERSCAN = 4;

export const webPartialVirtualizedConversationStrategy: ConversationStrategy = {
  name: "web-partial-virtualized",
  render({ contentRef, segments, scrollRef, renderItem, empty, isLoadingOlderHistory }) {
    if (
      segments.historyVirtualized.length === 0 &&
      segments.historyMounted.length === 0 &&
      segments.liveHead.length === 0 &&
      !isLoadingOlderHistory
    ) {
      return empty;
    }

    return (
      <WebPartialVirtualizedItemList
        contentRef={contentRef}
        isLoadingOlderHistory={isLoadingOlderHistory}
        renderItem={renderItem}
        scrollRef={scrollRef}
        segments={segments}
      />
    );
  },
};

function WebPartialVirtualizedItemList({
  contentRef,
  isLoadingOlderHistory = false,
  renderItem,
  scrollRef,
  segments,
}: {
  contentRef?: RefObject<HTMLDivElement | null>;
  isLoadingOlderHistory?: boolean;
  renderItem: (item: ConversationStreamItem) => ReactNode;
  scrollRef?: RefObject<HTMLElement | null>;
  segments: ConversationRuntimeSegments;
}) {
  const scrollElement = scrollRef?.current ?? null;
  const rowVirtualizer = useVirtualizer({
    count: segments.historyVirtualized.length,
    getScrollElement: () => scrollRef?.current ?? null,
    getItemKey: (index) => segments.historyVirtualized[index]?.key ?? index,
    estimateSize: (index) => {
      const item = segments.historyVirtualized[index];
      return item
        ? estimateStreamItemHeight(item, {
            width: readConversationEstimateWidth(scrollRef?.current, contentRef?.current),
          })
        : 160;
    },
    initialRect: readConversationInitialRect(scrollElement, contentRef?.current),
    measureElement,
    overscan: OVERSCAN,
    useAnimationFrameWithResizeObserver: true,
  });
  const pendingVirtualRowMeasureFramesRef = useRef(new Map<Element, number>());

  const measureVirtualizedRowElement = useCallback(
    (node: HTMLDivElement | null, item: ConversationStreamItem) => {
      if (!node) {
        rowVirtualizer.measureElement(null);
        return;
      }

      const pendingFrames = pendingVirtualRowMeasureFramesRef.current;
      const existingFrame = pendingFrames.get(node);
      if (existingFrame !== undefined) {
        cancelAnimationFrame(existingFrame);
      }

      const frame = requestAnimationFrame(() => {
        pendingFrames.delete(node);
        if (node.isConnected) {
          const bounds = node.getBoundingClientRect();
          recordMeasuredStreamItemHeight(item, bounds.height, {
            width: bounds.width,
          });
          rowVirtualizer.measureElement(node);
        }
      });
      pendingFrames.set(node, frame);
    },
    [rowVirtualizer],
  );

  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (_item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0;
      const scrollOffset = instance.scrollOffset ?? 0;
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight);
      return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);

  useEffect(() => {
    const pendingFrames = pendingVirtualRowMeasureFramesRef.current;
    return () => {
      for (const frame of pendingFrames.values()) {
        cancelAnimationFrame(frame);
      }
      pendingFrames.clear();
    };
  }, []);

  const estimateWidth = readConversationEstimateWidth(
    scrollElement,
    contentRef?.current,
  );
  const virtualItems = rowVirtualizer.getVirtualItems();
  const virtualTotalSize = rowVirtualizer.getTotalSize();
  const renderedVirtualItems =
    virtualItems.length > 0
      ? virtualItems
      : buildInitialVirtualItems({
          items: segments.historyVirtualized,
          viewportHeight:
            scrollElement?.clientHeight ||
            readConversationInitialRect(scrollElement, contentRef?.current).height,
          width: estimateWidth,
        });

  return (
    <div
      className={styles.turnList}
      data-conversation-strategy="web-partial-virtualized"
      data-virtualized-history-count={segments.historyVirtualized.length}
      data-virtualized-rendered-count={renderedVirtualItems.length}
      data-virtualized-total-size={virtualTotalSize}
      ref={contentRef}
    >
      {isLoadingOlderHistory ? <div className={styles.historyLoader}>加载中</div> : null}
      {segments.historyVirtualized.length > 0 ? (
        <div
          className={styles.virtualizedHistoryBand}
          data-virtualized-history-count={segments.historyVirtualized.length}
          data-virtualized-rendered-count={renderedVirtualItems.length}
          data-virtualized-total-size={virtualTotalSize}
          style={{ height: virtualTotalSize }}
        >
          {renderedVirtualItems.map((virtualItem) => {
            const item = segments.historyVirtualized[virtualItem.index];
            if (!item) return null;
            return (
              <VirtualizedHistoryRow
                index={virtualItem.index}
                item={item}
                key={virtualItem.key}
                measureVirtualizedRowElement={measureVirtualizedRowElement}
                renderItem={renderItem}
                start={virtualItem.start}
              />
            );
          })}
        </div>
      ) : null}
      {segments.historyMounted.map((item) => renderItem(item))}
      {segments.liveHead.map((item) => renderItem(item))}
    </div>
  );
}

const VirtualizedHistoryRow = memo(function VirtualizedHistoryRow({
  index,
  item,
  measureVirtualizedRowElement,
  renderItem,
  start,
}: {
  index: number;
  item: ConversationStreamItem;
  measureVirtualizedRowElement: (
    node: HTMLDivElement | null,
    item: ConversationStreamItem,
  ) => void;
  renderItem: (item: ConversationStreamItem) => ReactNode;
  start: number;
}) {
  const handleMeasureRef = useCallback(
    (node: HTMLDivElement | null) => {
      measureVirtualizedRowElement(node, item);
    },
    [item, measureVirtualizedRowElement],
  );

  return (
    <div
      className={styles.virtualizedHistoryItem}
      data-index={index}
      ref={handleMeasureRef}
      style={{ transform: `translateY(${start}px)` }}
    >
      {renderItem(item)}
    </div>
  );
});

function readConversationEstimateWidth(
  scrollElement: HTMLElement | null | undefined,
  contentElement: HTMLElement | null | undefined,
) {
  return scrollElement?.clientWidth || contentElement?.clientWidth || null;
}

function readConversationInitialRect(
  scrollElement: HTMLElement | null | undefined,
  contentElement: HTMLElement | null | undefined,
) {
  const width = scrollElement?.clientWidth || contentElement?.clientWidth || 760;
  const height = scrollElement?.clientHeight || 600;
  return { width, height };
}

function buildInitialVirtualItems({
  items,
  viewportHeight,
  width,
}: {
  items: readonly ConversationStreamItem[];
  viewportHeight: number;
  width: number | null;
}) {
  if (items.length === 0 || viewportHeight <= 0) return [];
  const rendered = [];
  let start = 0;
  const targetHeight = viewportHeight + INITIAL_VIRTUAL_RANGE_OVERSCAN * 160;
  for (let index = 0; index < items.length && start < targetHeight; index += 1) {
    const item = items[index];
    if (!item) break;
    rendered.push({
      index,
      key: item.key,
      start,
    });
    start += estimateStreamItemHeight(item, { width });
  }
  return rendered;
}
