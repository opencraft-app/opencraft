import type {
  ConversationAddress,
  Message,
  MessagePage,
  MessageReference,
  MessageSearchPage,
  ReconcileMessageInput,
  ReconcileMessageResult,
  SearchMessagesInput,
  SendAttachmentInput,
  SendTaskInput,
  SendTextInput,
} from "@vela/client-core";
import {mergeMessages, MessagingSendError} from "@vela/client-core";
import {
  defaultTencentMessageTypes,
  normalizeTencentMessage,
  type SdkMessage,
  type TencentMessageTypes,
} from "./tencent-message-normalizer";

export type {SdkMessage} from "./tencent-message-normalizer";

export interface ChatSdk {
  addMessageReaction?(
    message: SdkMessage,
    reactionId: string,
  ): Promise<unknown>;
  createCustomMessage?(options: Record<string, unknown>): SdkMessage;
  createFileMessage?(options: Record<string, unknown>): SdkMessage;
  createImageMessage?(options: Record<string, unknown>): SdkMessage;
  createTextAtMessage(options: Record<string, unknown>): SdkMessage;
  createTextMessage(options: Record<string, unknown>): SdkMessage;
  findMessage?(messageId: string): SdkMessage | null;
  getMessageList(options: {
    conversationID: string;
    nextReqMessageID?: string;
  }): Promise<unknown>;
  getMessageListHopping?(options: {
    conversationID: string;
    count: number;
    direction: 0 | 1;
    sequence?: number;
    time?: number;
  }): Promise<unknown>;
  removeMessageReaction?(
    message: SdkMessage,
    reactionId: string,
  ): Promise<unknown>;
  revokeMessage?(message: SdkMessage): Promise<unknown>;
  resendMessage?(message: SdkMessage): Promise<unknown>;
  searchCloudMessages?(
    options: Record<string, unknown>,
  ): Promise<unknown>;
  sendMessageReadReceipt?(messages: SdkMessage[]): Promise<unknown>;
  sendMessage(message: SdkMessage): Promise<unknown>;
  setMessageRead?(options: {conversationID: string}): Promise<unknown>;
}

interface ChannelChatServiceOptions {
  conversationGroup: string;
  messageText?: string;
  messageTypes?: Partial<TencentMessageTypes>;
  sdk: ChatSdk;
}

export class ChannelChatService {
  private readonly conversationGroup: string;
  private readonly messageTypes: TencentMessageTypes;
  private readonly sdk: ChatSdk;
  private readonly drafts = new Map<string, SdkMessage>();
  private readonly rawMessages = new Map<string, SdkMessage>();
  private readonly sentReadReceipts = new Set<string>();

  public constructor(options: ChannelChatServiceOptions) {
    this.conversationGroup = options.conversationGroup;
    this.messageTypes = {
      ...defaultTencentMessageTypes,
      ...(options.messageText ? {text: options.messageText} : {}),
      ...options.messageTypes,
    };
    this.sdk = options.sdk;
  }

  public async loadHistory(
    channel: ConversationAddress,
    cursor?: string,
  ): Promise<MessagePage> {
    const result = await this.sdk.getMessageList({
      conversationID: this.conversationId(channel),
      ...(cursor ? { nextReqMessageID: cursor } : {}),
    });
    const data = resultData(result);
    const messageList = Array.isArray(data.messageList)
      ? data.messageList.filter(isSdkMessage)
      : [];

    return {
      completed: data.isCompleted === true,
      messages: this.normalizeMessages(messageList),
      ...(typeof data.nextReqMessageID === "string" &&
      data.nextReqMessageID.length > 0
        ? { nextCursor: data.nextReqMessageID }
        : {}),
    };
  }

  public async sendText(input: SendTextInput): Promise<Message> {
    const mentionedUserIds = isDirectConversation(input.channel)
      ? []
      : input.mentions.map((mention) => mention.imUserId);
    const options = {
      cloudCustomData: messageMetadata(input),
      conversationType: this.conversationType(input.channel),
      ...(supportsReadReceipt(input.channel)
        ? {needReadReceipt: true}
        : {}),
      payload:
        mentionedUserIds.length > 0
          ? {
              atUserList: mentionedUserIds,
              text: input.text,
            }
          : { text: input.text },
      to: targetId(input.channel),
    };
    const draft =
      mentionedUserIds.length > 0
        ? this.sdk.createTextAtMessage(options)
        : this.sdk.createTextMessage(options);
    this.drafts.set(input.clientRequestId, draft);
    const result = await this.sendDraft(draft);
    const data = resultData(result);
    const confirmed = isSdkMessage(data.message) ? data.message : draft;
    this.drafts.delete(input.clientRequestId);
    return this.normalizeSentMessage(
      confirmed,
      input.clientRequestId,
      input.thread,
    );
  }

  public async sendAttachment(
    input: SendAttachmentInput,
  ): Promise<Message> {
    const onProgress = (value: unknown) => {
      const progress = uploadProgress(value);
      if (progress !== undefined) {
        input.onProgress?.(progress);
      }
    };
    const options = {
      cloudCustomData: messageMetadata(input),
      conversationType: this.conversationType(input.channel),
      ...(supportsReadReceipt(input.channel)
        ? {needReadReceipt: true}
        : {}),
      onProgress,
      payload: {
        file: attachmentFile(input.source),
      },
      to: targetId(input.channel),
    };
    let draft: SdkMessage;
    if (input.kind === "image") {
      if (!this.sdk.createImageMessage) {
        throw new Error("当前腾讯云 IM SDK 不支持图片消息");
      }
      draft = this.sdk.createImageMessage(options);
    } else {
      if (!this.sdk.createFileMessage) {
        throw new Error("当前腾讯云 IM SDK 不支持文件消息");
      }
      draft = this.sdk.createFileMessage(options);
    }
    this.drafts.set(input.clientRequestId, draft);
    const result = await this.sendDraft(draft);
    const data = resultData(result);
    const confirmed = isSdkMessage(data.message) ? data.message : draft;
    this.drafts.delete(input.clientRequestId);
    return this.normalizeSentMessage(confirmed, input.clientRequestId);
  }

  public async retryMessage(clientRequestId: string): Promise<Message> {
    const draft = this.drafts.get(clientRequestId);
    if (!draft) {
      throw new Error("原始消息草稿已不可用，请重新发送");
    }
    const result = this.sdk.resendMessage
      ? await this.sdk.resendMessage(draft)
      : await this.sdk.sendMessage(draft);
    const data = resultData(result);
    const confirmed = isSdkMessage(data.message) ? data.message : draft;
    this.drafts.delete(clientRequestId);
    return this.normalizeSentMessage(confirmed, clientRequestId);
  }

  public async reconcileMessage(
    input: ReconcileMessageInput,
  ): Promise<ReconcileMessageResult> {
    const cached = this.findByClientRequestId(
      input.channel.conversationId,
      input.clientRequestId,
    );
    if (cached) {
      return {message: this.normalizeMessage(cached), state: "sent"};
    }

    const result = await this.sdk.getMessageList({
      conversationID: this.conversationId(input.channel),
    });
    const data = resultData(result);
    const history = Array.isArray(data.messageList)
      ? data.messageList.filter(isSdkMessage)
      : [];
    this.normalizeMessages(history);
    const confirmed = this.findByClientRequestId(
      input.channel.conversationId,
      input.clientRequestId,
    );
    if (confirmed) {
      return {message: this.normalizeMessage(confirmed), state: "sent"};
    }

    const draft = this.drafts.get(input.clientRequestId);
    if (draft?.status === "fail") {
      return {
        error: "腾讯云 IM 已确认消息发送失败",
        retryable: Boolean(this.sdk.resendMessage),
        state: "failed",
      };
    }
    return {state: "pending"};
  }

  public async revokeMessage(messageId: string): Promise<Message> {
    const raw =
      this.rawMessages.get(messageId) ?? this.sdk.findMessage?.(messageId);
    if (!raw) {
      throw new Error("只能撤回当前会话中已经加载的消息");
    }
    if (!this.sdk.revokeMessage) {
      throw new Error("当前腾讯云 IM SDK 不支持撤回消息");
    }
    const result = await this.sdk.revokeMessage(raw);
    const data = resultData(result);
    const recalled = isSdkMessage(data.message)
      ? data.message
      : {...raw, isRevoked: true};
    this.rawMessages.set(recalled.ID, recalled);
    return {
      ...this.normalizeMessage(recalled),
      content: {kind: "system", text: "[消息已撤回]"},
      kind: "system",
      rawType: "TIMRevokedElem",
      text: "[消息已撤回]",
    };
  }

  public async loadMessagesByReferences(
    channel: ConversationAddress,
    references: MessageReference[],
  ): Promise<Message[]> {
    const resolved: Array<Message | null> = [];
    for (let offset = 0; offset < references.length; offset += 15) {
      const batch = await Promise.all(
        references.slice(offset, offset + 15).map(async (reference) => {
        const cached =
          this.rawMessages.get(reference.messageId) ??
          this.sdk.findMessage?.(reference.messageId);
        if (cached) {
          this.rawMessages.set(cached.ID, cached);
          return this.normalizeMessage(cached);
        }
        if (
          reference.sequence === undefined ||
          !this.sdk.getMessageListHopping
        ) {
          return null;
        }
        const result = await this.sdk.getMessageListHopping({
          conversationID: this.conversationId(channel),
          count: 1,
          direction: 0,
          sequence: reference.sequence,
        });
        const data = resultData(result);
        const raw = Array.isArray(data.messageList)
          ? data.messageList
              .filter(isSdkMessage)
              .find((message) => message.ID === reference.messageId)
          : undefined;
        if (!raw) return null;
        this.rawMessages.set(raw.ID, raw);
        return this.normalizeMessage(raw);
        }),
      );
      resolved.push(...batch);
    }
    return resolved.filter(
      (message): message is Message => message !== null,
    );
  }

  public async loadMessageContext(
    channel: ConversationAddress,
    reference: MessageReference,
  ): Promise<Message[]> {
    const cached =
      this.rawMessages.get(reference.messageId) ??
      this.sdk.findMessage?.(reference.messageId) ??
      undefined;
    if (cached) {
      this.rawMessages.set(cached.ID, cached);
    }
    if (!this.sdk.getMessageListHopping) {
      if (cached) return [this.normalizeMessage(cached)];
      throw new Error("当前腾讯云 IM SDK 不支持消息定位");
    }

    const position = isDirectConversation(channel)
      ? reference.timestamp ?? cached?.time
      : reference.sequence ?? cached?.sequence;
    if (!Number.isSafeInteger(position) || (position as number) <= 0) {
      throw new Error("这条消息缺少可用于定位的位置");
    }
    const base = {
      conversationID: this.conversationId(channel),
      count: 15,
      ...(isDirectConversation(channel)
        ? {time: position as number}
        : {sequence: position as number}),
    };
    const [olderResult, newerResult] = await Promise.all([
      this.sdk.getMessageListHopping({...base, direction: 0}),
      this.sdk.getMessageListHopping({...base, direction: 1}),
    ]);
    const rawMessages = [
      ...hoppingMessages(olderResult),
      ...hoppingMessages(newerResult),
      ...(cached ? [cached] : []),
    ];
    const messages = mergeMessages([], this.normalizeMessages(rawMessages));
    if (!messages.some((message) => message.id === reference.messageId)) {
      throw new Error("腾讯云 IM 未返回目标消息，它可能已被撤回或删除");
    }
    return messages;
  }

  public async sendTask(input: SendTaskInput): Promise<Message> {
    if (isDirectConversation(input.channel)) {
      throw new Error("私信不支持 Task 消息");
    }
    if (!this.sdk.createCustomMessage) {
      throw new Error("当前腾讯云 IM SDK 不支持自定义消息");
    }
    const task = input.task;
    const draft = this.sdk.createCustomMessage({
      cloudCustomData: JSON.stringify({
        clientRequestId: input.clientRequestId,
        schema: "vela.task-message/v1",
        task,
      }),
      conversationType: this.conversationType(input.channel),
      ...(supportsReadReceipt(input.channel)
        ? {needReadReceipt: true}
        : {}),
      payload: {
        data: JSON.stringify(task),
        description: "Task",
        extension: "vela.task-message/v1",
      },
      to: targetId(input.channel),
    });
    this.drafts.set(input.clientRequestId, draft);
    const result = await this.sdk.sendMessage(draft);
    const data = resultData(result);
    const confirmed = isSdkMessage(data.message) ? data.message : draft;
    this.drafts.delete(input.clientRequestId);
    return this.normalizeSentMessage(confirmed, input.clientRequestId);
  }

  public async setReaction(
    messageId: string,
    reactionId: string,
    active: boolean,
  ): Promise<void> {
    const raw = this.rawMessages.get(messageId);
    if (!raw) {
      throw new Error("腾讯云 IM 原始消息已不可用");
    }
    if (active) {
      if (!this.sdk.addMessageReaction) {
        throw new Error("当前腾讯云 IM SDK 不支持 Reaction");
      }
      await this.sdk.addMessageReaction(raw, reactionId);
      return;
    }
    if (!this.sdk.removeMessageReaction) {
      throw new Error("当前腾讯云 IM SDK 不支持 Reaction");
    }
    await this.sdk.removeMessageReaction(raw, reactionId);
  }

  public async searchMessages(
    input: SearchMessagesInput,
  ): Promise<MessageSearchPage> {
    if (
      input.channel &&
      "imTopicId" in input.channel &&
      input.channel.imTopicId
    ) {
      return this.searchTopicHistory(input);
    }
    if (!this.sdk.searchCloudMessages) {
      throw new Error("当前腾讯云 IM SDK 不支持云端消息搜索");
    }
    const result = await this.sdk.searchCloudMessages({
      ...(input.channel
        ? {conversationID: input.channel.conversationId}
        : {}),
      count: input.limit ?? 20,
      ...(input.cursor ? {cursor: input.cursor} : {}),
      keywordList: [input.query],
      keywordListMatchType: "and",
    });
    const data = resultData(result);
    const rawMessages = cloudSearchMessages(data);
    const cursor =
      nonEmptyString(data.nextCursor) ?? nonEmptyString(data.cursor);
    return {
      completed:
        data.isCompleted === true ||
        (data.isCompleted !== false && !cursor),
      messages: this.normalizeMessages(rawMessages),
      ...(cursor ? {nextCursor: cursor} : {}),
      totalCount:
        typeof data.totalCount === "number"
          ? data.totalCount
          : rawMessages.length,
    };
  }

  private async searchTopicHistory(
    input: SearchMessagesInput,
  ): Promise<MessageSearchPage> {
    if (!input.channel) {
      throw new Error("Topic 搜索缺少 Channel");
    }
    const result = await this.sdk.getMessageList({
      conversationID: input.channel.conversationId,
      ...(input.cursor ? {nextReqMessageID: input.cursor} : {}),
    });
    const data = resultData(result);
    const rawMessages = Array.isArray(data.messageList)
      ? data.messageList.filter(isSdkMessage)
      : [];
    const query = input.query.trim().toLocaleLowerCase("zh-CN");
    const messages = this.normalizeMessages(rawMessages).filter((message) =>
      message.text.toLocaleLowerCase("zh-CN").includes(query),
    );
    const cursor = nonEmptyString(data.nextReqMessageID);
    return {
      completed: data.isCompleted === true || !cursor,
      messages,
      ...(cursor ? {nextCursor: cursor} : {}),
      totalCount: messages.length,
    };
  }

  public normalizeIncoming(
    channel: ConversationAddress,
    messages: SdkMessage[],
  ): Message[] {
    const conversationID = this.conversationId(channel);
    return this.normalizeMessages(
      messages.filter((message) => message.conversationID === conversationID),
    );
  }

  public normalizeMessages(messages: SdkMessage[]): Message[] {
    return messages.map((message) => {
      this.rawMessages.set(message.ID, message);
      return this.normalizeMessage(message);
    });
  }

  public async markRead(channel: ConversationAddress): Promise<void> {
    if (!this.sdk.setMessageRead) {
      throw new Error("当前腾讯云 IM SDK 不支持消息已读");
    }
    await this.sdk.setMessageRead({
      conversationID: this.conversationId(channel),
    });
    if (!supportsReadReceipt(channel)) return;
    const receiptMessages = [...this.rawMessages.values()].filter(
      (message) =>
        message.conversationID === this.conversationId(channel) &&
        message.flow === "in" &&
        message.needReadReceipt === true &&
        !this.sentReadReceipts.has(message.ID),
    );
    if (receiptMessages.length === 0) return;
    if (!this.sdk.sendMessageReadReceipt) {
      throw new Error("当前腾讯云 IM SDK 不支持消息读回执");
    }
    await this.sdk.sendMessageReadReceipt(receiptMessages);
    receiptMessages.forEach((message) =>
      this.sentReadReceipts.add(message.ID),
    );
  }

  private conversationId(channel: ConversationAddress): string {
    return channel.conversationId;
  }

  private conversationType(_channel: ConversationAddress): string {
    return this.conversationGroup;
  }

  private normalizeMessage(message: SdkMessage): Message {
    const normalized = normalizeTencentMessage(message, this.messageTypes);
    return {
      ...normalized,
      reference: {
        kind: "group",
        ...(message.conversationID.startsWith("GROUP")
          ? {groupId: message.conversationID.slice("GROUP".length)}
          : {}),
        messageId: message.ID,
        ...(message.sequence !== undefined
          ? {sequence: message.sequence}
          : {}),
        senderUserId: message.from,
        timestamp: message.time,
      },
    };
  }

  private normalizeSentMessage(
    message: SdkMessage,
    clientRequestId: string,
    thread?: SendTextInput["thread"],
  ): Message {
    const normalized = this.normalizeMessage(message);
    return {
      ...normalized,
      ...(!normalized.clientRequestId ? {clientRequestId} : {}),
      ...(thread && !normalized.thread
        ? {
            thread: {
              role: "reply" as const,
              rootMessageRef: thread.rootMessageRef,
              threadId: thread.threadId,
            },
          }
        : {}),
    };
  }

  private async sendDraft(draft: SdkMessage): Promise<unknown> {
    try {
      return await this.sdk.sendMessage(draft);
    } catch (error) {
      const definitive = draft.status === "fail";
      throw new MessagingSendError(
        error instanceof Error ? error.message : "腾讯云 IM 消息发送失败",
        {
          cause: error,
          outcome: definitive ? "definitive" : "uncertain",
          retryable: definitive && Boolean(this.sdk.resendMessage),
        },
      );
    }
  }

  private findByClientRequestId(
    conversationId: string,
    clientRequestId: string,
  ): SdkMessage | undefined {
    return [...this.rawMessages.values()].find(
      (message) =>
        message.conversationID === conversationId &&
        normalizeTencentMessage(message, this.messageTypes).clientRequestId ===
          clientRequestId &&
        message.status === "success",
    );
  }
}

function messageMetadata(
  input: SendTextInput | SendAttachmentInput,
): string {
  if ("thread" in input && input.thread) {
    return JSON.stringify({
      clientRequestId: input.clientRequestId,
      schema: "vela.thread-reply/v1",
      thread: {
        role: "reply",
        rootMessageRef: input.thread.rootMessageRef,
        threadId: input.thread.threadId,
      },
    });
  }
  if (input.submission) {
    return JSON.stringify({
      clientRequestId: input.clientRequestId,
      ...(input.quote ? {quote: input.quote} : {}),
      schema: "vela.composer-submission/v1",
      submission: input.submission,
    });
  }
  return JSON.stringify({
    clientRequestId: input.clientRequestId,
    ...(input.quote ? {quote: input.quote} : {}),
    schema: "vela.client-message/v2",
  });
}

function attachmentFile(
  source: SendAttachmentInput["source"],
): unknown {
  if (source.kind === "platform-file") {
    return source.file;
  }
  return {
    name: source.name,
    ...(source.size !== undefined ? {size: source.size} : {}),
    ...(source.mimeType ? {type: source.mimeType} : {}),
    uri: source.uri,
  };
}

function uploadProgress(value: unknown): number | undefined {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "object" &&
          value !== null &&
          "percent" in value &&
          typeof value.percent === "number"
        ? value.percent
        : undefined;
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  return Math.min(1, Math.max(0, raw > 1 ? raw / 100 : raw));
}

function targetId(channel: ConversationAddress): string {
  return channel.targetId;
}

function supportsReadReceipt(channel: ConversationAddress): boolean {
  return !("imTopicId" in channel) || !channel.imTopicId;
}

function isDirectConversation(
  channel: ConversationAddress,
): boolean {
  return "directConversationId" in channel;
}

function resultData(value: unknown): Record<string, unknown> {
  if (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    typeof value.data === "object" &&
    value.data !== null
  ) {
    return value.data as Record<string, unknown>;
  }
  throw new Error("腾讯云 IM 返回了无法识别的数据");
}

function hoppingMessages(value: unknown): SdkMessage[] {
  const data = resultData(value);
  return Array.isArray(data.messageList)
    ? data.messageList.filter(isSdkMessage)
    : [];
}

function isSdkMessage(value: unknown): value is SdkMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value as Partial<SdkMessage>;
  return (
    typeof message.ID === "string" &&
    typeof message.conversationID === "string" &&
    typeof message.flow === "string" &&
    typeof message.from === "string" &&
    typeof message.status === "string" &&
    typeof message.time === "number" &&
    typeof message.type === "string"
  );
}

function cloudSearchMessages(
  data: Record<string, unknown>,
): SdkMessage[] {
  if (Array.isArray(data.messageList)) {
    return data.messageList.filter(isSdkMessage);
  }
  if (!Array.isArray(data.searchResultList)) {
    return [];
  }
  return data.searchResultList.flatMap((result) => {
    if (
      typeof result !== "object" ||
      result === null ||
      !("messageList" in result) ||
      !Array.isArray(result.messageList)
    ) {
      return [];
    }
    return result.messageList.filter(isSdkMessage);
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
