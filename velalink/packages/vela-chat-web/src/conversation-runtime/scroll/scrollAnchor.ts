export const STREAM_ITEM_ID_ATTRIBUTE = "data-stream-item-id";

export interface ConversationScrollAnchorSnapshot {
  itemId: string;
  offsetTop: number;
}

export interface ConversationScrollAnchorCandidate {
  bottom: number;
  itemId: string;
  top: number;
}

export function deriveConversationScrollAnchorSnapshot({
  containerTop,
  items,
  viewportHeight,
}: {
  containerTop: number;
  items: readonly ConversationScrollAnchorCandidate[];
  viewportHeight: number;
}): ConversationScrollAnchorSnapshot | null {
  if (!Number.isFinite(containerTop)) return null;
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return null;
  const containerBottom = containerTop + viewportHeight;
  const item = items.find(
    (candidate) =>
      candidate.itemId.length > 0 &&
      Number.isFinite(candidate.top) &&
      Number.isFinite(candidate.bottom) &&
      candidate.bottom > containerTop &&
      candidate.top < containerBottom,
  );
  if (!item) return null;
  return {
    itemId: item.itemId,
    offsetTop: item.top - containerTop,
  };
}

export function deriveConversationScrollAnchorRestoreTarget({
  anchorOffsetTop,
  containerTop,
  currentAnchorTop,
  currentScrollTop,
  maxScrollTop,
}: {
  anchorOffsetTop: number;
  containerTop: number;
  currentAnchorTop: number;
  currentScrollTop: number;
  maxScrollTop: number;
}): number | null {
  if (
    ![
      anchorOffsetTop,
      containerTop,
      currentAnchorTop,
      currentScrollTop,
      maxScrollTop,
    ].every(Number.isFinite)
  ) {
    return null;
  }

  const nextScrollTop =
    currentScrollTop + (currentAnchorTop - containerTop - anchorOffsetTop);
  return Math.min(Math.max(0, nextScrollTop), Math.max(0, maxScrollTop));
}

export function readConversationScrollAnchorSnapshot({
  container,
  content,
}: {
  container: HTMLElement;
  content: HTMLElement | null;
}): ConversationScrollAnchorSnapshot | null {
  if (!content) return null;
  const containerRect = container.getBoundingClientRect();
  return deriveConversationScrollAnchorSnapshot({
    containerTop: containerRect.top,
    viewportHeight: container.clientHeight || containerRect.height,
    items: Array.from(
      content.querySelectorAll<HTMLElement>(`[${STREAM_ITEM_ID_ATTRIBUTE}]`),
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        itemId: element.getAttribute(STREAM_ITEM_ID_ATTRIBUTE) ?? "",
        top: rect.top,
      };
    }),
  });
}

export function getConversationScrollAnchorRestoreTarget({
  anchor,
  container,
  content,
}: {
  anchor: ConversationScrollAnchorSnapshot | null | undefined;
  container: HTMLElement;
  content: HTMLElement | null;
}): number | null {
  if (!anchor || !content) return null;
  const element = Array.from(
    content.querySelectorAll<HTMLElement>(`[${STREAM_ITEM_ID_ATTRIBUTE}]`),
  ).find(
    (candidate) =>
      candidate.getAttribute(STREAM_ITEM_ID_ATTRIBUTE) === anchor.itemId,
  );
  if (!element) return null;

  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  return deriveConversationScrollAnchorRestoreTarget({
    anchorOffsetTop: anchor.offsetTop,
    containerTop: containerRect.top,
    currentAnchorTop: elementRect.top,
    currentScrollTop: container.scrollTop,
    maxScrollTop: container.scrollHeight - container.clientHeight,
  });
}
