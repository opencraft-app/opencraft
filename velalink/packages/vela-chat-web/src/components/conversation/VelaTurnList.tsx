import { memo, useCallback, type RefObject } from "react";
import type {
  ConversationRuntimeHostKind,
  ConversationRuntimeSegments,
  ConversationStreamItem,
} from "../../conversation-runtime/model";
import { resolveConversationStrategy } from "../../conversation-runtime/strategy/strategyRegistry";
import { VelaTurnGroup } from "./VelaTurnGroup";

export const VelaTurnList = memo(function VelaTurnList({
  contentRef,
  initialScrollTop,
  isLoadingOlderHistory = false,
  scrollRef,
  segments,
  hostKind,
}: {
  contentRef?: RefObject<HTMLDivElement | null>;
  hostKind: ConversationRuntimeHostKind;
  initialScrollTop?: number | null;
  isLoadingOlderHistory?: boolean;
  scrollRef?: RefObject<HTMLElement | null>;
  segments: ConversationRuntimeSegments;
}) {
  const strategy = resolveConversationStrategy({ hostKind, segments });
  const renderConversationItem = useCallback(
    (item: ConversationStreamItem) => (
      <VelaTurnGroup item={item} key={item.key} />
    ),
    [],
  );

  return strategy.render({
    contentRef,
    initialScrollTop,
    isLoadingOlderHistory,
    segments,
    scrollRef,
    empty: <></>,
    renderItem: renderConversationItem,
  });
});
