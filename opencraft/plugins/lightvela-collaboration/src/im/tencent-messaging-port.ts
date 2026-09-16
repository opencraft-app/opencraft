import {
  PlatformError,
  type ConversationAddress,
  type ConversationSummary,
  type ConversationSummarySnapshot,
  type HumanImSession,
  type Message,
  type MessagePage,
  type MessageReference,
  type MessageSearchPage,
  type MessagingLifecycleEvent,
  type MessagingPort,
  type MessagingScope,
  type SearchMessagesInput,
  type SendAttachmentInput,
  type SendTaskInput,
  type SendTextInput,
  type Unsubscribe,
} from "@lightvela/vela-chat-client-core";
import type {
  ChannelChatService,
  SdkMessage,
} from "./channel-chat-service";
import type { TencentGatewayEventData } from "./tencent-chat-gateway";

type GatewayEvent = "kicked_out" | "not_ready" | "ready";

interface GatewayPort {
  listConversations?(
    groupIds: string[],
  ): Promise<ConversationSummarySnapshot>;
  login(session: HumanImSession): Promise<void>;
  logout(): Promise<void>;
  on(
    event: GatewayEvent,
    listener: (data: TencentGatewayEventData) => void,
  ): Unsubscribe;
  onConversations?(
    listener: (conversations: ConversationSummary[]) => void,
  ): Unsubscribe;
  onMessages(listener: (messages: SdkMessage[]) => void): Unsubscribe;
}

type ChatPort = Pick<
  ChannelChatService,
  | "loadHistory"
  | "loadMessageContext"
  | "loadMessagesByReferences"
  | "markRead"
  | "normalizeMessages"
  | "reconcileMessage"
  | "retryMessage"
  | "searchMessages"
  | "sendAttachment"
  | "sendTask"
  | "sendText"
  | "setReaction"
> & {
  revokeMessage?(messageId: string): Promise<Message>;
};

interface TencentMessagingPortOptions {
  chat: ChatPort;
  gateway: GatewayPort;
}

export class TencentMessagingPort implements MessagingPort {
  private readonly chat: ChatPort;
  private readonly gateway: GatewayPort;
  private readonly lifecycleListeners = new Set<
    (event: MessagingLifecycleEvent) => void
  >();
  private readonly messageListeners = new Set<
    (messages: Message[]) => void
  >();
  private readonly conversationListeners = new Set<
    (conversations: ConversationSummary[]) => void
  >();
  private readonly readyWaiters = new Set<() => void>();
  private allowedConversationIds: Set<string> | null = null;
  private ready = false;
  private scopeGeneration = 0;

  public constructor(options: TencentMessagingPortOptions) {
    this.chat = options.chat;
    this.gateway = options.gateway;
    this.gateway.on("ready", () => {
      this.ready = true;
      this.emitLifecycle({ type: "ready" });
      this.readyWaiters.forEach((resolve) => resolve());
      this.readyWaiters.clear();
    });
    this.gateway.on("not_ready", () => {
      this.ready = false;
      this.emitLifecycle({ type: "not_ready" });
    });
    this.gateway.on("kicked_out", (event) => {
      this.ready = false;
      this.emitLifecycle({
        ...(event.cause
          ? {cause: event.cause}
          : {reason: "账号已在另一个浏览器中登录"}),
        type: "kicked_out",
      });
    });
    this.gateway.onMessages((messages) => {
      const normalized = this.chat
        .normalizeMessages(messages)
        .filter((message) => this.isConversationAllowed(message.conversationId));
      if (normalized.length > 0) {
        this.messageListeners.forEach((listener) => listener(normalized));
      }
    });
    this.gateway.onConversations?.((conversations) => {
      const allowed = conversations.filter((conversation) =>
        this.isConversationAllowed(conversation.conversationId),
      );
      this.conversationListeners.forEach((listener) =>
        listener(allowed),
      );
    });
  }

  public async close(): Promise<void> {
    this.ready = false;
    await this.gateway.logout();
  }

  public async connect(session: HumanImSession): Promise<void> {
    this.ready = false;
    await this.gateway.login(session);
  }

  public loadHistory(
    channel: ConversationAddress,
    cursor?: string,
  ): Promise<MessagePage> {
    this.assertConversationAllowed(channel);
    return this.chat.loadHistory(channel, cursor);
  }

  public async listConversations(
    groupIds: string[],
  ): Promise<ConversationSummarySnapshot> {
    if (!this.gateway.listConversations) {
      throw unsupported("会话目录");
    }
    const snapshot = await this.gateway.listConversations(groupIds);
    return {
      ...snapshot,
      items: snapshot.items.filter((conversation) =>
        this.isConversationAllowed(conversation.conversationId),
      ),
    };
  }

  public loadMessagesByReferences(
    channel: ConversationAddress,
    references: MessageReference[],
  ): Promise<Message[]> {
    this.assertConversationAllowed(channel);
    return this.chat.loadMessagesByReferences(channel, references);
  }

  public loadMessageContext(
    channel: ConversationAddress,
    reference: MessageReference,
  ): Promise<Message[]> {
    this.assertConversationAllowed(channel);
    return this.chat.loadMessageContext(channel, reference);
  }

  public markRead(channel: ConversationAddress): Promise<void> {
    this.assertConversationAllowed(channel);
    return this.chat.markRead(channel);
  }

  public revokeMessage(messageId: string): Promise<Message> {
    if (!this.chat.revokeMessage) {
      throw unsupported("撤回消息");
    }
    return this.chat.revokeMessage(messageId);
  }

  public async setScope(scope: MessagingScope): Promise<void> {
    if (!Number.isSafeInteger(scope.generation) || scope.generation <= 0) {
      throw new PlatformError("USAGE", "消息 Server scope generation 无效");
    }
    if (scope.generation < this.scopeGeneration) return;
    const allowed = new Set<string>();
    for (const address of scope.allowedConversations) {
      const conversationId = address.conversationId.trim();
      if (conversationId) allowed.add(conversationId);
    }
    this.scopeGeneration = scope.generation;
    this.allowedConversationIds = allowed;
  }

  public retryMessage(clientRequestId: string): Promise<Message> {
    return this.chat.retryMessage(clientRequestId);
  }

  public reconcileMessage(
    input: Parameters<MessagingPort["reconcileMessage"]>[0],
  ) {
    return this.chat.reconcileMessage(input);
  }

  public async searchMessages(
    input: SearchMessagesInput,
  ): Promise<MessageSearchPage> {
    if (input.channel) this.assertConversationAllowed(input.channel);
    return this.chat.searchMessages(input);
  }

  public sendAttachment(input: SendAttachmentInput): Promise<Message> {
    this.assertConversationAllowed(input.channel);
    return this.chat.sendAttachment(input);
  }

  public sendTask(input: SendTaskInput): Promise<Message> {
    this.assertConversationAllowed(input.channel);
    return this.chat.sendTask(input);
  }

  public sendText(input: SendTextInput): Promise<Message> {
    this.assertConversationAllowed(input.channel);
    return this.chat.sendText(input);
  }

  public setReaction(
    messageId: string,
    reactionId: string,
    active: boolean,
  ): Promise<void> {
    return this.chat.setReaction(messageId, reactionId, active);
  }

  public subscribeConversations(
    listener: (conversations: ConversationSummary[]) => void,
  ): Unsubscribe {
    this.conversationListeners.add(listener);
    return () => this.conversationListeners.delete(listener);
  }

  public subscribeLifecycle(
    listener: (event: MessagingLifecycleEvent) => void,
  ): Unsubscribe {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  public subscribeMessages(
    listener: (messages: Message[]) => void,
  ): Unsubscribe {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  public async waitUntilReady(timeoutMs: number): Promise<void> {
    if (this.ready) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onReady = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.readyWaiters.delete(onReady);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.readyWaiters.delete(onReady);
        reject(new PlatformError("IM_NOT_READY", "腾讯云 IM 连接超时"));
      }, timeoutMs);
      this.readyWaiters.add(onReady);
    });
  }

  private emitLifecycle(event: MessagingLifecycleEvent): void {
    this.lifecycleListeners.forEach((listener) => listener(event));
  }

  private assertConversationAllowed(channel: ConversationAddress): void {
    if (!this.isConversationAllowed(channel.conversationId)) {
      throw new PlatformError("IM_REJECTED", "会话不属于当前 Server scope");
    }
  }

  private isConversationAllowed(conversationId: string): boolean {
    return (
      this.allowedConversationIds === null ||
      this.allowedConversationIds.has(conversationId)
    );
  }
}

function unsupported(capability: string): PlatformError {
  return new PlatformError(
    "USAGE",
    `${capability}尚未进入 Expo Web 第一阶段`,
  );
}
