import { createConversationKey, type ConversationKey } from "@opencraft/chat-core";

const RESOURCE_PROTOCOL = "vela-bot:";

export type BotConversationViewResource =
  | {
      readonly kind: "conversation";
      readonly key: ConversationKey;
    }
  | {
      readonly kind: "selection";
      readonly hostId: string;
      readonly botId: string | null;
    };

function requiredParameter(url: URL, name: string): string | null {
  const value = url.searchParams.get(name)?.trim() ?? "";
  return value.length === 0 ? null : value;
}

/**
 * View resources are opaque to the Workbench and serializable in History.
 * Bot code alone owns their schema and converts them to domain identity.
 */
export function parseBotConversationViewResource(
  resourceUri: string | null,
): BotConversationViewResource | null {
  if (resourceUri === null) return null;
  try {
    const url = new URL(resourceUri);
    if (url.protocol !== RESOURCE_PROTOCOL) return null;
    const hostId = requiredParameter(url, "hostId");
    if (hostId === null) return null;
    if (url.pathname === "conversation") {
      const conversationId = requiredParameter(url, "conversationId");
      return conversationId === null
        ? null
        : Object.freeze({
            kind: "conversation" as const,
            key: createConversationKey(hostId, conversationId),
          });
    }
    if (url.pathname === "selection") {
      return Object.freeze({
        kind: "selection" as const,
        hostId,
        botId: requiredParameter(url, "botId"),
      });
    }
    return null;
  } catch {
    return null;
  }
}

export function botConversationResourceUri(key: ConversationKey): string {
  const parameters = new URLSearchParams({
    hostId: key.hostId,
    conversationId: key.threadId,
  });
  return `${RESOURCE_PROTOCOL}conversation?${parameters}`;
}

export function botSelectionResourceUri(
  hostId: string,
  botId?: string | null,
): string {
  const parameters = new URLSearchParams({ hostId });
  if (botId !== undefined && botId !== null && botId.trim().length > 0)
    parameters.set("botId", botId.trim());
  return `${RESOURCE_PROTOCOL}selection?${parameters}`;
}
