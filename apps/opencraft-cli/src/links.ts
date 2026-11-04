import { conversationLink, type ConversationRef } from '@opencraft/appserver-protocol/collaboration';

export function conversationUiLink(webUrl: string | undefined, ref: ConversationRef | null, title?: string): string | null {
  return webUrl && ref ? conversationLink(webUrl, ref, title) : null;
}
