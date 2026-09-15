import type {Channel} from "../platform/api.js";

export interface ChannelAddress {
  channelId: string;
  conversationId: string;
  imGroupId?: string;
  imTopicId?: string | null;
  targetId: string;
}

export interface DirectAddress {
  conversationId: string;
  directConversationId: string;
  imGroupId: string;
  targetId: string;
}

export type ConversationAddress = ChannelAddress | DirectAddress;

export interface ConversationCapabilities {
  historyCursor: "sequence" | "timestamp";
  mentions: boolean;
  readReceipts: boolean;
  tasks: boolean;
  threads: boolean;
  topic: boolean;
}

export function conversationCapabilities(
  address: ConversationAddress,
): ConversationCapabilities {
  if (isDirectAddress(address)) {
    return {
      historyCursor: "timestamp",
      mentions: false,
      readReceipts: true,
      tasks: false,
      threads: false,
      topic: false,
    };
  }
  const topic = address.imTopicId !== null && address.imTopicId !== undefined;
  return {
    historyCursor: "sequence",
    mentions: true,
    readReceipts: !topic,
    tasks: true,
    threads: true,
    topic,
  };
}

export function channelAddress(channel: Channel): ChannelAddress | null {
  if (!channel.joined) return null;
  if (channel.imState !== "ready") return null;
  const targetId = channel.imTopicId?.trim();
  if (!targetId || !channel.imGroupId) return null;
  return {
    channelId: channel.id,
    conversationId: `GROUP${targetId}`,
    ...(channel.imGroupId ? {imGroupId: channel.imGroupId} : {}),
    ...(channel.imTopicId === undefined
      ? {}
      : {imTopicId: channel.imTopicId}),
    targetId,
  };
}

export function directAddress(
  conversation: {
    directConversationId: string;
    imGroupId: string;
    imState: string;
  },
): DirectAddress | null {
  const targetId = conversation.imGroupId.trim();
  if (
    conversation.imState !== "ready" ||
    !targetId ||
    !conversation.directConversationId.trim()
  ) {
    return null;
  }
  return {
    conversationId: `GROUP${targetId}`,
    directConversationId: conversation.directConversationId,
    imGroupId: targetId,
    targetId,
  };
}

export function isDirectAddress(
  address: ConversationAddress,
): address is DirectAddress {
  return "directConversationId" in address;
}
