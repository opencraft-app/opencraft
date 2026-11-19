/** Identity-scoped current-state synchronization, not a message event log. */
export interface ActorInboxMessage { id: string; sequence: string; authorId: string; text: string; at: number }
export type ActorInboxItem = {
  channelId: string;
  unreadCount: number;
  mentionUnreadCount?: number;
  firstUnreadMentionSequence?: number;
} & ({ kind: 'direct'; peerActorId: string; latestMessage: ActorInboxMessage | null }
  | { kind: 'group'; title: string; latestMessage: ActorInboxMessage | null });
export interface ActorInboxChange {
  channelId: string;
  revision: string;
  /** Null removes the row. Older responses must never resurrect it. */
  item: ActorInboxItem | null;
}
export interface ActorInboxPage {
  actorId: string;
  /** True starts/replaces the local replica. Continue with cursor while hasMore. */
  reset: boolean;
  changes: ActorInboxChange[];
  cursor: string;
  hasMore: boolean;
}
