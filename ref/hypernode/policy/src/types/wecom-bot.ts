import type { HostTickPort } from "./host-policy.ts";

export interface WeComBotConfiguration {
  key: string;
  botId: string;
  handler: string;
  threadId: string | null;
  enabled: boolean;
}

export interface WeComInboundMessage {
  botKey: string;
  requestId: string;
  messageId: string;
  chatId: string | null;
  chatType: "single" | "group" | string;
  senderUserId: string;
  content: string;
  messageType: string;
}

export interface WeComBotStatus {
  key: string;
  botIdSuffix: string;
  handler: string;
  threadId: string | null;
  enabled: boolean;
  phase: "disabled" | "disconnected" | "connecting" | "authenticating" | "ready";
  authenticatedAtMs: number | null;
  lastMessageAtMs: number | null;
  reconnectAttempts: number;
  lastError: string | null;
}

export type WeComMessageListener = (message: WeComInboundMessage) => void;

export interface WeComOutboundSendResult {
  requestId: string;
  chatId: string;
  deliveredAtMs: number;
}

export interface WeComOutboundSend {
  poll(): WeComOutboundSendResult | null;
  cancel(): void;
}

export interface WeComBotPort extends HostTickPort {
  onMessage(listener: WeComMessageListener): () => boolean;
  replyStream(message: WeComInboundMessage, streamId: string, content: string, finish: boolean): boolean;
  sendMarkdown(botKey: string, chatId: string | null, content: string): WeComOutboundSend;
  configuration(key: string): WeComBotConfiguration | null;
  setThreadId(key: string, threadId: string | null): void;
  statuses(): WeComBotStatus[];
}

export interface CodeReviewBotStatus {
  botKey: string;
  model: string;
  threadId: string | null;
  pendingMessages: number;
  activeTurnId: string | null;
  lastError: string | null;
}

export interface CodeReviewBotPort extends HostTickPort {
  status(): CodeReviewBotStatus;
}
