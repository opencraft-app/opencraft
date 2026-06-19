import type { RefObject } from "react";
import type {
  ConversationRuntimeHostKind,
  ConversationRuntimeSegments,
  ConversationStreamItem,
} from "../../conversation-runtime/model";
import { resolveConversationStrategy } from "../../conversation-runtime/strategy/strategyRegistry";
import styles from "../../styles/desktop.module.css";
import { VelaTurnGroup } from "./VelaTurnGroup";

export function VelaTurnList({
  contentRef,
  isLoadingOlderHistory = false,
  scrollRef,
  segments,
  hostKind,
}: {
  contentRef?: RefObject<HTMLDivElement | null>;
  hostKind: ConversationRuntimeHostKind;
  isLoadingOlderHistory?: boolean;
  scrollRef?: RefObject<HTMLElement | null>;
  segments: ConversationRuntimeSegments;
}) {
  const strategy = resolveConversationStrategy({ hostKind, segments });

  return strategy.render({
    contentRef,
    isLoadingOlderHistory,
    segments,
    scrollRef,
    empty: <div className={styles.empty}>连接本地 velad 后，这里会显示 transcript。</div>,
    renderItem: (item: ConversationStreamItem) => (
      <VelaTurnGroup item={item} key={item.key} />
    ),
  });
}
