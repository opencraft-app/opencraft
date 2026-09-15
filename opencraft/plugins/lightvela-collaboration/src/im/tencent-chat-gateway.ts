import {
  PlatformError,
  type ConversationSummary,
  type ConversationSummarySnapshot,
  type HumanImSession,
} from "@lightvela/vela-chat-client-core";
import type { ChatSdk, SdkMessage } from "./channel-chat-service";
import {
  defaultTencentMessageTypes,
  type TencentMessageTypes,
} from "./tencent-message-normalizer";

type RawHandler = (event?: unknown) => void;
export type TencentGatewayEvent = "kicked_out" | "not_ready" | "ready";
export interface TencentGatewayEventData {
  cause?: "user_sig_expired";
}

export interface RawTencentSdk extends ChatSdk {
  getTopicList?(options: {
    groupID: string;
    topicIDList: string[] | undefined;
  }): Promise<unknown>;
  login(options: { userID: string; userSig: string }): Promise<unknown>;
  logout(): Promise<unknown>;
  off(event: string, handler: RawHandler): void;
  on(event: string, handler: RawHandler): void;
  registerPlugin?(plugins: Record<string, unknown>): void;
  setLogLevel?(level: number): void;
}

export interface TencentChatNamespace {
  create(options: { SDKAppID: number }): RawTencentSdk;
  EVENT: {
    CONVERSATION_LIST_UPDATED?: string;
    KICKED_OUT: string;
    MESSAGE_MODIFIED?: string;
    MESSAGE_READ_BY_PEER?: string;
    MESSAGE_READ_RECEIPT_RECEIVED?: string;
    MESSAGE_RECEIVED: string;
    SDK_NOT_READY: string;
    SDK_READY: string;
  };
  TYPES: {
    CONV_GROUP: string;
    CONV_TOPIC?: string;
    KICKED_OUT_USERSIG_EXPIRED: string;
    MSG_AUDIO?: string;
    MSG_CUSTOM?: string;
    MSG_FILE?: string;
    MSG_IMAGE?: string;
    MSG_MERGER?: string;
    MSG_TEXT: string;
    MSG_VIDEO?: string;
  };
}

interface TencentChatGatewayOptions {
  uploadPlugin?: unknown;
}

export class TencentChatGateway implements ChatSdk {
  private readonly listeners = new Map<
    TencentGatewayEvent,
    Set<(event: TencentGatewayEventData) => void>
  >();
  private readonly messageListeners = new Set<
    (messages: SdkMessage[]) => void
  >();
  private readonly conversationListeners = new Set<
    (conversations: ConversationSummary[]) => void
  >();
  private sdk: RawTencentSdk | null = null;
  private sdkAppId: number | null = null;
  private generation = 0;
  private readonly registeredUploadSdks = new WeakSet<object>();
  private boundHandlers: Array<{
    event: string;
    handler: RawHandler;
    sdk: RawTencentSdk;
  }> = [];

  public constructor(
    private readonly namespace: TencentChatNamespace,
    private readonly options: TencentChatGatewayOptions = {},
  ) {}

  public get conversationGroup(): string {
    return this.namespace.TYPES.CONV_GROUP;
  }

  public get messageText(): string {
    return this.namespace.TYPES.MSG_TEXT;
  }

  public get messageTypes(): TencentMessageTypes {
    return {
      audio:
        this.namespace.TYPES.MSG_AUDIO ??
        defaultTencentMessageTypes.audio,
      custom:
        this.namespace.TYPES.MSG_CUSTOM ??
        defaultTencentMessageTypes.custom,
      file:
        this.namespace.TYPES.MSG_FILE ??
        defaultTencentMessageTypes.file,
      image:
        this.namespace.TYPES.MSG_IMAGE ??
        defaultTencentMessageTypes.image,
      merged:
        this.namespace.TYPES.MSG_MERGER ??
        defaultTencentMessageTypes.merged,
      text: this.namespace.TYPES.MSG_TEXT,
      video:
        this.namespace.TYPES.MSG_VIDEO ??
        defaultTencentMessageTypes.video,
    };
  }

  public async login(session: HumanImSession): Promise<void> {
    const generation = ++this.generation;
    this.unbindSdkEvents();
    if (!this.sdk || this.sdkAppId !== session.sdkAppId) {
      this.sdk = this.namespace.create({ SDKAppID: session.sdkAppId });
      this.sdk.setLogLevel?.(1);
      this.sdkAppId = session.sdkAppId;
    }
    this.registerUploadPlugin(this.sdk);
    this.bindSdkEvents(this.sdk, generation);
    try {
      await this.sdk.login({
        userID: session.userId,
        userSig: session.userSig,
      });
    } catch (error) {
      if (isExpiredUserSigError(error)) {
        throw new PlatformError("IM_KICKED_OUT", "IM 签名已过期", {
          details: { cause: "user_sig_expired" },
        });
      }
      throw error;
    }
  }

  public async logout(): Promise<void> {
    this.generation += 1;
    this.unbindSdkEvents();
    if (this.sdk) {
      await this.sdk.logout();
    }
  }

  public on(
    event: TencentGatewayEvent,
    listener: (event: TencentGatewayEventData) => void,
  ): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  public onMessages(
    listener: (messages: SdkMessage[]) => void,
  ): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  public onConversations(
    listener: (conversations: ConversationSummary[]) => void,
  ): () => void {
    this.conversationListeners.add(listener);
    return () => this.conversationListeners.delete(listener);
  }

  public async listConversations(
    groupIds: string[],
  ): Promise<ConversationSummarySnapshot> {
    const sdk = this.requireSdk();
    if (!sdk.getTopicList) {
      throw new Error("当前腾讯云 IM SDK 不支持 Topic 列表");
    }
    const uniqueGroupIds = [...new Set(groupIds.filter(Boolean))];
    if (uniqueGroupIds.length === 0) {
      return {isSyncCompleted: true, items: []};
    }
    const results = await Promise.all(
      uniqueGroupIds.map(async (groupID) => {
        let result: unknown;
        try {
          result = await sdk.getTopicList?.({
            groupID,
            topicIDList: undefined,
          });
        } catch (error) {
          if (isInvalidGroupError(error)) {
            return {failed: true, items: []};
          }
          throw error;
        }
        const data = resultData(result);
        if (!Array.isArray(data.successTopicList)) {
          throw new Error("腾讯云 IM Topic 列表响应结构不合法");
        }
        return {
          failed:
            Array.isArray(data.failureTopicList) &&
            data.failureTopicList.length > 0,
          items: topicConversations(data.successTopicList),
        };
      }),
    );
    return {
      isSyncCompleted: results.every((result) => !result.failed),
      items: results.flatMap((result) => result.items),
    };
  }

  public createTextAtMessage(
    options: Record<string, unknown>,
  ): SdkMessage {
    return this.requireSdk().createTextAtMessage(options);
  }

  public createTextMessage(options: Record<string, unknown>): SdkMessage {
    return this.requireSdk().createTextMessage(options);
  }

  public createImageMessage(
    options: Record<string, unknown>,
  ): SdkMessage {
    const sdk = this.requireSdk();
    if (!sdk.createImageMessage) {
      throw new Error("当前腾讯云 IM SDK 不支持图片消息");
    }
    return sdk.createImageMessage(options);
  }

  public createFileMessage(options: Record<string, unknown>): SdkMessage {
    const sdk = this.requireSdk();
    if (!sdk.createFileMessage) {
      throw new Error("当前腾讯云 IM SDK 不支持文件消息");
    }
    return sdk.createFileMessage(options);
  }

  public createCustomMessage(
    options: Record<string, unknown>,
  ): SdkMessage {
    const sdk = this.requireSdk();
    if (!sdk.createCustomMessage) {
      throw new Error("当前腾讯云 IM SDK 不支持自定义消息");
    }
    return sdk.createCustomMessage(options);
  }

  public async getMessageList(options: {
    conversationID: string;
    nextReqMessageID?: string;
  }): Promise<unknown> {
    return this.requireSdk().getMessageList(options);
  }

  public findMessage(messageId: string): SdkMessage | null {
    return this.requireSdk().findMessage?.(messageId) ?? null;
  }

  public async getMessageListHopping(options: {
    conversationID: string;
    count: number;
    direction: 0 | 1;
    sequence?: number;
    time?: number;
  }): Promise<unknown> {
    const sdk = this.requireSdk();
    if (!sdk.getMessageListHopping) {
      throw new Error("当前腾讯云 IM SDK 不支持消息定位拉取");
    }
    return sdk.getMessageListHopping(options);
  }

  public async sendMessage(message: SdkMessage): Promise<unknown> {
    return this.requireSdk().sendMessage(message);
  }

  public async resendMessage(message: SdkMessage): Promise<unknown> {
    const sdk = this.requireSdk();
    if (!sdk.resendMessage) {
      return sdk.sendMessage(message);
    }
    return sdk.resendMessage(message);
  }

  public async setMessageRead(options: {
    conversationID: string;
  }): Promise<unknown> {
    const sdk = this.requireSdk();
    if (!sdk.setMessageRead) {
      throw new Error("当前腾讯云 IM SDK 不支持消息已读");
    }
    return sdk.setMessageRead(options);
  }

  public async sendMessageReadReceipt(
    messages: SdkMessage[],
  ): Promise<unknown> {
    const sdk = this.requireSdk();
    if (!sdk.sendMessageReadReceipt) {
      throw new Error("当前腾讯云 IM SDK 不支持消息读回执");
    }
    return sdk.sendMessageReadReceipt(messages);
  }

  public async searchCloudMessages(
    options: Record<string, unknown>,
  ): Promise<unknown> {
    const sdk = this.requireSdk();
    if (!sdk.searchCloudMessages) {
      throw new Error("当前腾讯云 IM SDK 不支持云端消息搜索");
    }
    return sdk.searchCloudMessages(options);
  }

  public async addMessageReaction(
    message: SdkMessage,
    reactionId: string,
  ): Promise<unknown> {
    const sdk = this.requireSdk();
    if (!sdk.addMessageReaction) {
      throw new Error("当前腾讯云 IM SDK 不支持 Reaction");
    }
    return sdk.addMessageReaction(message, reactionId);
  }

  public async removeMessageReaction(
    message: SdkMessage,
    reactionId: string,
  ): Promise<unknown> {
    const sdk = this.requireSdk();
    if (!sdk.removeMessageReaction) {
      throw new Error("当前腾讯云 IM SDK 不支持 Reaction");
    }
    return sdk.removeMessageReaction(message, reactionId);
  }

  public async revokeMessage(message: SdkMessage): Promise<unknown> {
    const sdk = this.requireSdk();
    if (!sdk.revokeMessage) {
      throw new Error("当前腾讯云 IM SDK 不支持撤回消息");
    }
    return sdk.revokeMessage(message);
  }

  private bindSdkEvents(sdk: RawTencentSdk, generation: number): void {
    this.bind(sdk, this.namespace.EVENT.SDK_READY, generation, () =>
      this.emit("ready"),
    );
    this.bind(sdk, this.namespace.EVENT.SDK_NOT_READY, generation, () =>
      this.emit("not_ready"),
    );
    this.bind(sdk, this.namespace.EVENT.KICKED_OUT, generation, (event) =>
      this.emit("kicked_out", kickedOutData(event, this.namespace)),
    );
    this.bind(sdk, this.namespace.EVENT.MESSAGE_RECEIVED, generation, (event) => {
      const messages = messagesFromEvent(event);
      if (messages.length > 0) {
        this.messageListeners.forEach((listener) => listener(messages));
      }
    });
    const conversationEvent =
      this.namespace.EVENT.CONVERSATION_LIST_UPDATED;
    if (conversationEvent) {
      this.bind(sdk, conversationEvent, generation, (event) => {
        const data = eventData(event);
        const groupUpdates = groupConversations(
          data,
          [
            this.namespace.TYPES.CONV_GROUP,
            ...(this.namespace.TYPES.CONV_TOPIC
              ? [this.namespace.TYPES.CONV_TOPIC]
              : []),
          ],
        );
        if (groupUpdates.length > 0) {
          this.conversationListeners.forEach((listener) =>
            listener(groupUpdates),
          );
        }
      });
    }
    [
      this.namespace.EVENT.MESSAGE_MODIFIED,
      this.namespace.EVENT.MESSAGE_READ_BY_PEER,
      this.namespace.EVENT.MESSAGE_READ_RECEIPT_RECEIVED,
    ].forEach((event) => {
      if (!event) return;
      this.bind(sdk, event, generation, (value) => {
        const messages = messagesFromEvent(value);
        if (messages.length > 0) {
          this.messageListeners.forEach((listener) => listener(messages));
        }
      });
    });
  }

  private registerUploadPlugin(sdk: RawTencentSdk): void {
    if (
      this.options.uploadPlugin === undefined ||
      this.registeredUploadSdks.has(sdk)
    ) {
      return;
    }
    if (!sdk.registerPlugin) {
      throw new Error("腾讯云 IM 上传插件无法注册");
    }
    sdk.registerPlugin({
      "tim-upload-plugin": this.options.uploadPlugin,
    });
    this.registeredUploadSdks.add(sdk);
  }

  private bind(
    sdk: RawTencentSdk,
    event: string,
    generation: number,
    handler: RawHandler,
  ): void {
    const fenced: RawHandler = (value) => {
      if (generation !== this.generation) return;
      handler(value);
    };
    sdk.on(event, fenced);
    this.boundHandlers.push({ event, handler: fenced, sdk });
  }

  private unbindSdkEvents(): void {
    this.boundHandlers.forEach(({ event, handler, sdk }) => {
      sdk.off(event, handler);
    });
    this.boundHandlers = [];
  }

  private emit(
    event: TencentGatewayEvent,
    data: TencentGatewayEventData = {},
  ): void {
    this.listeners.get(event)?.forEach((listener) => listener(data));
  }

  private requireSdk(): RawTencentSdk {
    if (!this.sdk) {
      throw new Error("腾讯云 IM 尚未初始化");
    }
    return this.sdk;
  }
}

function kickedOutData(
  event: unknown,
  namespace: TencentChatNamespace,
): TencentGatewayEventData {
  if (
    isRecord(event) &&
    isRecord(event.data) &&
    event.data.type === namespace.TYPES.KICKED_OUT_USERSIG_EXPIRED
  ) {
    return { cause: "user_sig_expired" };
  }
  return {};
}

function isExpiredUserSigError(error: unknown): boolean {
  return isRecord(error) && error.code === 70001;
}

function isInvalidGroupError(error: unknown): boolean {
  return isRecord(error) && error.code === 10015;
}

function messagesFromEvent(event: unknown): SdkMessage[] {
  if (
    typeof event !== "object" ||
    event === null ||
    !("data" in event) ||
    !Array.isArray(event.data)
  ) {
    return [];
  }
  return event.data.filter((value): value is SdkMessage => {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const message = value as Partial<SdkMessage>;
    return (
      typeof message.ID === "string" &&
      typeof message.conversationID === "string" &&
      typeof message.from === "string" &&
      typeof message.time === "number" &&
      typeof message.type === "string"
    );
  });
}

function groupConversations(
  value: unknown,
  conversationTypes: string[],
): ConversationSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => groupConversation(item, conversationTypes))
    .filter((item): item is ConversationSummary => item !== null);
}

function topicConversations(value: unknown): ConversationSummary[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(topicConversation)
    .filter((item): item is ConversationSummary => item !== null);
}

function topicConversation(value: unknown): ConversationSummary | null {
  if (!isRecord(value)) return null;
  const topicId = nonEmptyString(value.topicID);
  if (!topicId) return null;
  const lastMessage = isRecord(value.lastMessage)
    ? value.lastMessage
    : {};
  const lastMessageAt = messageTime(lastMessage);
  return {
    conversationId: `GROUP${topicId}`,
    kind: "group",
    ...(lastMessageAt ? {lastMessageAt} : {}),
    lastMessagePreview:
      nonEmptyString(lastMessage.messageForShow) ?? "",
    title: nonEmptyString(value.topicName) ?? topicId,
    unreadCount: nonNegativeInteger(value.unreadCount),
  };
}

function groupConversation(
  value: unknown,
  conversationTypes: string[],
): ConversationSummary | null {
  if (!isRecord(value)) return null;
  const conversationId = nonEmptyString(value.conversationID);
  if (
    !conversationId ||
    !conversationId.startsWith("GROUP") ||
    typeof value.type !== "string" ||
    !conversationTypes.includes(value.type)
  ) {
    return null;
  }
  const groupProfile = isRecord(value.groupProfile)
    ? value.groupProfile
    : {};
  const topicProfile = isRecord(value.topicProfile)
    ? value.topicProfile
    : {};
  const lastMessage = isRecord(value.lastMessage)
    ? value.lastMessage
    : {};
  const lastMessageAt = messageTime(lastMessage);
  return {
    conversationId,
    kind: "group",
    ...(lastMessageAt ? {lastMessageAt} : {}),
    lastMessagePreview:
      nonEmptyString(lastMessage.messageForShow) ?? "",
    title:
      nonEmptyString(topicProfile.topicName) ??
      nonEmptyString(groupProfile.name) ??
      conversationId.slice(5),
    unreadCount: nonNegativeInteger(value.unreadCount),
  };
}

function eventData(event: unknown): unknown {
  return isRecord(event) ? event.data : undefined;
}

function resultData(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) return {};
  return isRecord(result.data) ? result.data : result;
}

function messageTime(
  message: Record<string, unknown>,
): string | undefined {
  const value =
    typeof message.lastTime === "number"
      ? message.lastTime
      : typeof message.time === "number"
        ? message.time
        : undefined;
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value * 1_000).toISOString();
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
