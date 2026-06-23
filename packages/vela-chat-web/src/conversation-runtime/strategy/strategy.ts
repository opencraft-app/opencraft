import type { ReactNode, RefObject } from "react";
import type {
  ConversationRuntimeSegments,
  ConversationStreamItem,
} from "../model";

export interface ConversationStrategyInput {
  segments: ConversationRuntimeSegments;
  contentRef?: RefObject<HTMLDivElement | null>;
  initialScrollTop?: number | null;
  scrollRef?: RefObject<HTMLElement | null>;
  isLoadingOlderHistory?: boolean;
  renderItem: (item: ConversationStreamItem) => ReactNode;
  empty: ReactNode;
}

export interface ConversationStrategy {
  name: ConversationStrategyName;
  render: (input: ConversationStrategyInput) => ReactNode;
}

export type ConversationStrategyName = "web-plain" | "web-partial-virtualized";
