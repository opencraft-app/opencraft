import {
  belongsInOrdinaryConversationCatalog,
  createConversationKey,
  type ConversationKey,
  type ConversationOwnership,
} from "@opencraft/chat-core";

/** Only the ordinary catalog is filtered. Native history, route lookup and
 * resource identity remain intact; this projection is not access control. */
export function ordinaryConversationCatalog<T extends { readonly connectionHostId: string; readonly id: string }>(
  threads: readonly T[],
  ownershipOf: (key: ConversationKey) => ConversationOwnership,
): T[] {
  return threads.filter((thread) =>
    belongsInOrdinaryConversationCatalog(ownershipOf(createConversationKey(thread.connectionHostId, thread.id))),
  );
}
