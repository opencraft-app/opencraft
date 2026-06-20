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

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div
      className={styles.turnList}
      data-conversation-strategy="web-partial-virtualized"
      ref={contentRef}
    >
      {isLoadingOlderHistory ? <div className={styles.historyLoader}>加载中</div> : null}
      {segments.historyVirtualized.length > 0 ? (
        <div
          className={styles.virtualizedHistoryBand}
          style={{ height: rowVirtualizer.getTotalSize() }}
        >
          {virtualItems.map((virtualItem) => {
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
