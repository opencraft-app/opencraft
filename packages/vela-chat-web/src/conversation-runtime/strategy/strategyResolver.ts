import type {
  ConversationRuntimeHostKind,
  ConversationRuntimeSegments,
} from "../model";
import type { ConversationStrategyName } from "./strategy";

export interface ResolveConversationStrategyInput {
  hostKind: ConversationRuntimeHostKind;
  segments: ConversationRuntimeSegments;
}

export function resolveConversationStrategyName({
  segments,
}: ResolveConversationStrategyInput): ConversationStrategyName {
  if (segments.boundary.hasVirtualizedHistory) {
    return "web-partial-virtualized";
  }
  return "web-plain";
}
