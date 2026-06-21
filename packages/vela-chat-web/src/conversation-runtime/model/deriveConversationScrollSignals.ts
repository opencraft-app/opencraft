import type { ConversationStreamItem } from "./buildConversationStreamItems";

export interface ConversationScrollSignals {
  followSignal: string;
  layoutSignal: string;
}

export function deriveConversationScrollSignals(
  items: readonly ConversationStreamItem[],
): ConversationScrollSignals {
  const followParts: string[] = [];
  const layoutParts: string[] = [];

  for (const item of items) {
    const part = `${item.key}:${item.live}:${item.fingerprint}`;
    if (isFollowItem(item)) {
      followParts.push(part);
      continue;
    }
    layoutParts.push(part);
  }

  return {
    followSignal: followParts.join("|"),
    layoutSignal: layoutParts.join("|"),
  };
}

function isFollowItem(item: ConversationStreamItem) {
  return item.kind === "user_message" || item.kind === "assistant_markdown";
}
