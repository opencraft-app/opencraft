import type { ConversationStreamItem } from "./buildConversationStreamItems";
import {
  DEFAULT_CONVERSATION_RUNTIME_POLICY,
  normalizeConversationRuntimePolicy,
  type ConversationRuntimePolicy,
} from "./virtualizationPolicy";

export { DEFAULT_CONVERSATION_RUNTIME_POLICY };

export interface ConversationRuntimeSegments {
  historyVirtualized: ConversationStreamItem[];
  historyMounted: ConversationStreamItem[];
  liveHead: ConversationStreamItem[];
  boundary: {
    hasVirtualizedHistory: boolean;
    hasMountedHistory: boolean;
    hasLiveHead: boolean;
  };
}

export interface ConversationRuntimeSummary {
  strategy: "web-plain" | "web-partial-virtualized";
  itemCount: number;
  historyVirtualizedCount: number;
  historyMountedCount: number;
  liveHeadCount: number;
  mountedItemCount: number;
}

const runtimeSegmentsByItems = new WeakMap<
  readonly ConversationStreamItem[],
  Map<string, ConversationRuntimeSegments>
>();

export function buildConversationRuntimeSegments(
  items: readonly ConversationStreamItem[],
  policy?: Partial<ConversationRuntimePolicy>,
): ConversationRuntimeSegments {
  const normalizedPolicy = normalizeConversationRuntimePolicy(policy);
  const cacheKey = [
    normalizedPolicy.partialVirtualizationEnabled,
    normalizedPolicy.virtualizeAfterItemCount,
    normalizedPolicy.mountedRecentItemCount,
    normalizedPolicy.maxLiveHeadItemCount,
  ].join(":");
  let cachedByPolicy = runtimeSegmentsByItems.get(items);
  if (!cachedByPolicy) {
    cachedByPolicy = new Map();
    runtimeSegmentsByItems.set(items, cachedByPolicy);
  }
  const cached = cachedByPolicy.get(cacheKey);
  if (cached) return cached;

  const firstLiveIndex = items.findIndex((item) => item.live);
  const liveItems = firstLiveIndex === -1 ? [] : items.slice(firstLiveIndex);
  const liveHeadStart = Math.max(
    0,
    liveItems.length - normalizedPolicy.maxLiveHeadItemCount,
  );
  const stableItems =
    firstLiveIndex === -1
      ? [...items]
      : [...items.slice(0, firstLiveIndex), ...liveItems.slice(0, liveHeadStart)];
  const liveHead = liveItems.slice(liveHeadStart);

  const shouldVirtualize =
    normalizedPolicy.partialVirtualizationEnabled &&
    stableItems.length > normalizedPolicy.virtualizeAfterItemCount;
  const mountedWindowStart = shouldVirtualize
    ? findMountedWindowStart({
        items: stableItems,
        minMountedItemCount: normalizedPolicy.mountedRecentItemCount,
      })
    : 0;
  const historyVirtualized = shouldVirtualize
    ? stableItems.slice(0, mountedWindowStart)
    : [];
  const historyMounted = shouldVirtualize
    ? stableItems.slice(mountedWindowStart)
    : stableItems;

  const segments = {
    historyVirtualized,
    historyMounted,
    liveHead,
    boundary: {
      hasVirtualizedHistory: historyVirtualized.length > 0,
      hasMountedHistory: historyMounted.length > 0,
      hasLiveHead: liveHead.length > 0,
    },
  };
  cachedByPolicy.set(cacheKey, segments);
  return segments;
}

export function summarizeConversationRuntime(
  items: readonly ConversationStreamItem[],
  segments: ConversationRuntimeSegments,
): ConversationRuntimeSummary {
  return {
    strategy: segments.boundary.hasVirtualizedHistory
      ? "web-partial-virtualized"
      : "web-plain",
    itemCount: items.length,
    historyVirtualizedCount: segments.historyVirtualized.length,
    historyMountedCount: segments.historyMounted.length,
    liveHeadCount: segments.liveHead.length,
    mountedItemCount: segments.historyMounted.length + segments.liveHead.length,
  };
}

function findMountedWindowStart({
  items,
  minMountedItemCount,
}: {
  items: readonly ConversationStreamItem[];
  minMountedItemCount: number;
}) {
  const fallbackStart = Math.max(0, items.length - minMountedItemCount);
  let start = fallbackStart;

  while (
    start > 0 &&
    items[start]?.kind !== "user_message" &&
    !items[start]?.continuation
  ) {
    start -= 1;
  }

  if (items[start]?.kind === "user_message" || items[start]?.continuation) {
    return start;
  }
  return fallbackStart;
}
