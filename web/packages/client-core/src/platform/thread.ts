import type {MessageReference} from "../messaging/model.js";

export interface MessageThread {
  channelId: string;
  createdAt: string;
  id: string;
  lastReplyAt?: string | null;
  replyCount: number;
  rootMessageRef: MessageReference;
  serverId: string;
  unreadCount: number;
}

export interface ThreadReplyReference {
  createdAt: string;
  id: string;
  messageRef: MessageReference;
  threadId: string;
}

export interface ThreadReplyReferencePage {
  items: ThreadReplyReference[];
  nextCursor?: string;
}

export interface EnsureThreadInput {
  rootMessageRef: MessageReference;
}

export interface RegisterThreadReplyInput {
  messageRef: MessageReference;
}
