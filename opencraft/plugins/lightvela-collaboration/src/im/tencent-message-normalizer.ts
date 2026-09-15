import type {
  AudioMessageContent,
  CustomMessageContent,
  FileMessageContent,
  ImageMessageContent,
  MergedMessageContent,
  Message,
  MessageContent,
  MessageDelivery,
  MessageQuote,
  MessageReaction,
  MessageReference,
  MessageSubmissionReference,
  MessageThreadLink,
  TaskMessageContent,
  VideoMessageContent,
} from "@lightvela/vela-chat-client-core";

export interface SdkMessage {
  ID: string;
  atUserList?: string[];
  avatar?: string;
  cloudCustomData?: string;
  conversationID: string;
  flow: string;
  from: string;
  isPeerRead?: boolean;
  nameCard?: string;
  needReadReceipt?: boolean;
  nick?: string;
  payload?: Record<string, unknown>;
  reactionList?: unknown[];
  readReceiptInfo?: unknown;
  sequence?: number;
  status: string;
  time: number;
  type: string;
}

export interface TencentMessageTypes {
  audio: string;
  custom: string;
  file: string;
  image: string;
  merged: string;
  text: string;
  video: string;
}

export const defaultTencentMessageTypes: TencentMessageTypes = {
  audio: "TIMSoundElem",
  custom: "TIMCustomElem",
  file: "TIMFileElem",
  image: "TIMImageElem",
  merged: "TIMRelayElem",
  text: "TIMTextElem",
  video: "TIMVideoFileElem",
};

interface MessageMetadata {
  clientRequestId?: string;
  quote?: MessageQuote;
  schema?: string;
  task?: Record<string, unknown>;
  thread?: MessageThreadLink;
  submission?: MessageSubmissionReference;
}

export function normalizeTencentMessage(
  message: SdkMessage,
  types: TencentMessageTypes = defaultTencentMessageTypes,
): Message {
  const metadata = parseMetadata(message.cloudCustomData);
  const content = normalizeContent(message, types, metadata);

  return {
    clientRequestId: metadata.clientRequestId,
    content,
    conversationId: message.conversationID,
    createdAt: new Date(message.time * 1_000).toISOString(),
    delivery: deliveryState(message.status),
    direction: message.flow === "out" ? "outgoing" : "incoming",
    id: message.ID,
    kind: content.kind,
    mentions: stringList(message.atUserList),
    quote: metadata.quote,
    rawType: message.type,
    reactions: normalizeReactions(message.reactionList),
    read:
      message.isPeerRead === true
        ? readState(message.readReceiptInfo)
        : message.isPeerRead === false
          ? {state: "unread"}
          : {state: "unknown"},
    senderAvatar: nonEmptyString(message.avatar),
    senderId: message.from,
    senderName:
      nonEmptyString(message.nameCard) ??
      nonEmptyString(message.nick) ??
      message.from,
    ...(metadata.submission ? {submission: metadata.submission} : {}),
    text: contentPreview(content),
    ...(metadata.thread ? {thread: metadata.thread} : {}),
  };
}

function normalizeContent(
  message: SdkMessage,
  types: TencentMessageTypes,
  metadata: MessageMetadata,
): MessageContent {
  const payload = message.payload ?? {};
  if (message.type === types.text) {
    return {
      kind: "text",
      text: stringValue(payload.text) ?? "",
    };
  }
  if (message.type === types.image) {
    return imageContent(payload);
  }
  if (message.type === types.file) {
    return fileContent(payload);
  }
  if (message.type === types.audio) {
    return audioContent(payload);
  }
  if (message.type === types.video) {
    return videoContent(payload);
  }
  if (message.type === types.custom) {
    return customContent(payload, metadata);
  }
  if (message.type === types.merged) {
    return mergedContent(payload);
  }
  return {
    kind: "unsupported",
    rawType: message.type,
  };
}

function imageContent(payload: Record<string, unknown>): ImageMessageContent {
  const images = Array.isArray(payload.imageInfoArray)
    ? payload.imageInfoArray.filter(isRecord)
    : [];
  const original =
    images.find((image) => numberValue(image.imageType) === 0) ?? images[0];
  const thumbnail =
    images.find((image) => numberValue(image.imageType) === 3) ??
    images.find((image) => image !== original);

  return {
    kind: "image",
    ...(numberValue(original?.height) !== undefined
      ? {height: numberValue(original?.height)}
      : {}),
    ...(numberValue(original?.size) !== undefined
      ? {size: numberValue(original?.size)}
      : {}),
    ...(stringValue(thumbnail?.url)
      ? {thumbnailUrl: stringValue(thumbnail?.url)}
      : {}),
    ...(stringValue(original?.url) ? {url: stringValue(original?.url)} : {}),
    ...(numberValue(original?.width) !== undefined
      ? {width: numberValue(original?.width)}
      : {}),
  };
}

function fileContent(payload: Record<string, unknown>): FileMessageContent {
  return {
    kind: "file",
    name: stringValue(payload.fileName) ?? "未命名文件",
    ...(numberValue(payload.fileSize) !== undefined
      ? {size: numberValue(payload.fileSize)}
      : {}),
    ...(stringValue(payload.fileUrl)
      ? {url: stringValue(payload.fileUrl)}
      : {}),
  };
}

function audioContent(payload: Record<string, unknown>): AudioMessageContent {
  return {
    kind: "audio",
    ...(numberValue(payload.second) !== undefined
      ? {durationSeconds: numberValue(payload.second)}
      : {}),
    ...(numberValue(payload.size) !== undefined
      ? {size: numberValue(payload.size)}
      : {}),
    ...(stringValue(payload.url) ? {url: stringValue(payload.url)} : {}),
  };
}

function videoContent(payload: Record<string, unknown>): VideoMessageContent {
  return {
    kind: "video",
    ...(stringValue(payload.snapshotUrl)
      ? {coverUrl: stringValue(payload.snapshotUrl)}
      : {}),
    ...(numberValue(payload.videoSecond) !== undefined
      ? {durationSeconds: numberValue(payload.videoSecond)}
      : {}),
    ...(numberValue(payload.snapshotHeight) !== undefined
      ? {height: numberValue(payload.snapshotHeight)}
      : {}),
    ...(numberValue(payload.videoSize) !== undefined
      ? {size: numberValue(payload.videoSize)}
      : {}),
    ...(stringValue(payload.videoUrl)
      ? {url: stringValue(payload.videoUrl)}
      : {}),
    ...(numberValue(payload.snapshotWidth) !== undefined
      ? {width: numberValue(payload.snapshotWidth)}
      : {}),
  };
}

function customContent(
  payload: Record<string, unknown>,
  metadata: MessageMetadata,
): CustomMessageContent | TaskMessageContent {
  const extension = stringValue(payload.extension);
  const data = stringValue(payload.data);
  const taskData =
    metadata.schema === "vela.task-message/v1" ||
    extension === "vela.task-message/v1"
      ? metadata.task ?? parseRecord(data)
      : undefined;
  const task = taskData ? taskContent(taskData) : undefined;
  if (task) return task;

  return {
    kind: "custom",
    ...(data ? {data} : {}),
    ...(stringValue(payload.description)
      ? {description: stringValue(payload.description)}
      : {}),
    ...(extension ? {extension} : {}),
    ...(metadata.schema ? {schema: metadata.schema} : {}),
  };
}

function taskContent(value: Record<string, unknown>): TaskMessageContent | null {
  const taskId = nonEmptyString(value.taskId);
  const title = nonEmptyString(value.title);
  const status = nonEmptyString(value.status);
  if (!taskId || !title || !status) return null;
  return {
    assigneeId: nonEmptyString(value.assigneeId),
    kind: "task",
    ...(messageReference(value.sourceMessageRef)
      ? {sourceMessageRef: messageReference(value.sourceMessageRef)}
      : nonEmptyString(value.sourceMessageRef)
        ? {sourceMessageRef: nonEmptyString(value.sourceMessageRef)}
        : {}),
    status,
    taskId,
    title,
  };
}

function messageReference(value: unknown): MessageReference | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  const messageId = nonEmptyString(value.messageId);
  if ((kind !== "c2c" && kind !== "group") || !messageId) {
    return undefined;
  }
  return {
    ...(value.groupId === null
      ? {groupId: null}
      : nonEmptyString(value.groupId)
        ? {groupId: nonEmptyString(value.groupId)}
        : {}),
    kind,
    messageId,
    ...(value.senderUserId === null
      ? {senderUserId: null}
      : nonEmptyString(value.senderUserId)
        ? {senderUserId: nonEmptyString(value.senderUserId)}
        : {}),
    ...(numberValue(value.sequence) !== undefined
      ? {sequence: numberValue(value.sequence)}
      : {}),
    ...(numberValue(value.timestamp) !== undefined
      ? {timestamp: numberValue(value.timestamp)}
      : {}),
    ...(value.topicId === null
      ? {topicId: null}
      : nonEmptyString(value.topicId)
        ? {topicId: nonEmptyString(value.topicId)}
        : {}),
  };
}

function mergedContent(payload: Record<string, unknown>): MergedMessageContent {
  const abstractList = Array.isArray(payload.abstractList)
    ? payload.abstractList.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const messageCount = Array.isArray(payload.messageList)
    ? payload.messageList.length
    : undefined;
  return {
    abstractList,
    kind: "merged",
    ...(messageCount !== undefined ? {messageCount} : {}),
    title: stringValue(payload.title) ?? "聊天记录",
  };
}

function contentPreview(content: MessageContent): string {
  switch (content.kind) {
    case "text":
    case "system":
      return content.text;
    case "image":
      return "[图片]";
    case "file":
      return content.name;
    case "audio":
      return "[语音]";
    case "video":
      return "[视频]";
    case "task":
      return content.title;
    case "custom":
      return content.description ?? "[自定义消息]";
    case "merged":
      return content.title;
    case "unsupported":
      return "[暂不支持的消息]";
  }
}

function parseMetadata(value: string | undefined): MessageMetadata {
  const parsed = parseRecord(value);
  if (!parsed) return {};
  const quote = parseQuote(parsed.quote);
  const thread = parseThread(parsed.thread);
  const submission = parseSubmission(parsed.submission);
  return {
    ...(nonEmptyString(parsed.clientRequestId)
      ? {clientRequestId: nonEmptyString(parsed.clientRequestId)}
      : {}),
    ...(quote ? {quote} : {}),
    ...(nonEmptyString(parsed.schema) ? {schema: nonEmptyString(parsed.schema)} : {}),
    ...(isRecord(parsed.task) ? {task: parsed.task} : {}),
    ...(thread ? {thread} : {}),
    ...(submission ? {submission} : {}),
  };
}

function parseSubmission(value: unknown): MessageSubmissionReference | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const count = value.count;
  const index = value.index;
  const final = value.final;
  const role = value.role;
  if (
    !id ||
    !Number.isInteger(count) ||
    (count as number) < 1 ||
    (count as number) > 10 ||
    !Number.isInteger(index) ||
    (index as number) < 0 ||
    (index as number) >= (count as number) ||
    typeof final !== "boolean" ||
    final !== ((index as number) === (count as number) - 1) ||
    (role !== "attachment" && role !== "commit") ||
    (role === "commit" && final !== true)
  ) {
    return undefined;
  }
  return {
    count: count as number,
    final,
    id,
    index: index as number,
    role,
  };
}

function parseThread(value: unknown): MessageThreadLink | undefined {
  if (!isRecord(value) || value.role !== "reply") return undefined;
  const threadId = nonEmptyString(value.threadId);
  const rootMessageRef = messageReference(value.rootMessageRef);
  if (!threadId || !rootMessageRef) return undefined;
  return {
    role: "reply",
    rootMessageRef,
    threadId,
  };
}

function parseQuote(value: unknown): MessageQuote | undefined {
  if (!isRecord(value)) return undefined;
  const messageId = nonEmptyString(value.messageId);
  const preview = nonEmptyString(value.preview);
  const senderId = nonEmptyString(value.senderId);
  const senderName = nonEmptyString(value.senderName);
  if (!messageId || !preview || !senderId || !senderName) return undefined;
  return {messageId, preview, senderId, senderName};
}

function normalizeReactions(value: unknown[] | undefined): MessageReaction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const reactionId =
      nonEmptyString(item.reactionID) ?? nonEmptyString(item.reactionId);
    if (!reactionId) return [];
    const users = Array.isArray(item.userList)
      ? item.userList.flatMap((user) => {
          if (typeof user === "string") return [user];
          if (isRecord(user) && nonEmptyString(user.userID)) {
            return [nonEmptyString(user.userID) as string];
          }
          return [];
        })
      : [];
    return [
      {
        count: numberValue(item.totalUserCount) ?? users.length,
        reactedByMe: item.reactedByMyself === true,
        reactionId,
        ...(users.length > 0 ? {userIds: users} : {}),
      },
    ];
  });
}

function readState(value: unknown): Message["read"] {
  if (!isRecord(value)) return {state: "read"};
  const readCount = numberValue(value.readCount);
  const unreadCount = numberValue(value.unreadCount);
  return {
    ...(readCount !== undefined ? {readCount} : {}),
    state: "read",
    ...(unreadCount !== undefined ? {unreadCount} : {}),
  };
}

function deliveryState(status: string): MessageDelivery {
  if (status === "success") return {state: "sent"};
  if (status === "fail") {
    return {
      error: "消息发送失败",
      retryable: true,
      state: "failed",
    };
  }
  return {state: "sending"};
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
