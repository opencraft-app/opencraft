export interface DirectConversation {
  conversationId: string;
  directConversationId: string;
  imGroupId: string;
  imState: "deleted" | "error" | "provisioning" | "ready";
  lastMessageAt?: string;
  lastMessagePreview: string;
  peerAvatar?: string;
  peerDisplayName: string;
  peerMemberId: string;
  peerUserId: string;
  unreadCount: number;
}

export type ActiveConversation =
  | {channelId: string; kind: "channel"}
  | {
      directConversationId?: string;
      kind: "direct";
      peerMemberId: string;
      peerUserId: string;
    };
