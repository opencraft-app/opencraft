import type { ConversationNavigationAnchor } from "./types";

export interface ActiveNavigationAnchorStore {
  getSnapshot(): string | null;
  subscribe(listener: () => void): () => void;
  publish(anchorId: string | null): void;
}

export function createActiveNavigationAnchorStore(): ActiveNavigationAnchorStore {
  const listeners = new Set<() => void>();
  let current: string | null = null;
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(anchorId) {
      if (anchorId === current) return;
      current = anchorId;
      for (const listener of listeners) listener();
    },
  };
}

/** Last prompt whose ordered position is at or before the viewport position. */
export function findAnchorAtOrBefore(
  anchors: readonly ConversationNavigationAnchor[],
  order: number | null,
): ConversationNavigationAnchor | null {
  if (order === null || anchors.length === 0) return null;
  let low = 0;
  let high = anchors.length - 1;
  let match: ConversationNavigationAnchor | null = null;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = anchors[middle];
    if (candidate === undefined) break;
    if (candidate.order <= order) {
      match = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return match;
}

export function findFirstVisibleAnchor(
  anchors: readonly ConversationNavigationAnchor[],
  visibleItemIds: ReadonlySet<string>,
): ConversationNavigationAnchor | null {
  for (const anchor of anchors) {
    if (anchor.itemId !== null && visibleItemIds.has(anchor.itemId)) return anchor;
  }
  return anchors.at(-1) ?? null;
}
