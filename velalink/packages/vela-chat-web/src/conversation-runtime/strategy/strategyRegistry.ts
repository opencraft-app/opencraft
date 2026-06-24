import type { ConversationStrategy } from "./strategy";
import { resolveConversationStrategyName } from "./strategyResolver";
import type { ResolveConversationStrategyInput } from "./strategyResolver";
import { webPlainConversationStrategy } from "./webPlainStrategy";
import { webPartialVirtualizedConversationStrategy } from "./webVirtualizedStrategy";

export function resolveConversationStrategy(
  input: ResolveConversationStrategyInput,
): ConversationStrategy {
  const strategyName = resolveConversationStrategyName(input);
  return strategyName === "web-partial-virtualized"
    ? webPartialVirtualizedConversationStrategy
    : webPlainConversationStrategy;
}
