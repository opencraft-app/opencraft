import { createContext, useContext, useLayoutEffect, useRef } from "react";
import type { TimelineBlock } from "@opencraft/chat-core";
import type { ConversationSearchTarget } from "../conversation-search";

export const ConversationSearchTargetContext = createContext<ConversationSearchTarget | null>(null);

/** Reveal once per explicit selection; later disclosure choices remain the reader's. */
export function useRevealSearchItem(itemIds: readonly string[], reveal: (itemId: string) => void): boolean {
  const target = useContext(ConversationSearchTargetContext);
  const revealed = useRef<string | null>(null);
  const matches = target?.itemId != null && itemIds.includes(target.itemId);
  useLayoutEffect(() => {
    if (matches && target && revealed.current !== target.requestId) {
      revealed.current = target.requestId;
      reveal(target.itemId!);
    }
  }, [matches, target, reveal]);
  return matches;
}
export const blockItemIds = (blocks: readonly TimelineBlock[]): string[] => blocks.flatMap(block => block.sourceItemIds);

export function findConversationItemElement(root: Element, itemId: string): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>("[data-content-search-unit-key], [data-content-search-unit-keys]")) {
    if (element.dataset.contentSearchUnitKey === itemId) return element;
    if (element.dataset.contentSearchUnitKeys && (JSON.parse(element.dataset.contentSearchUnitKeys) as string[]).includes(itemId)) return element;
  }
  return null;
}
