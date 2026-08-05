export type MessageKind =
  | "text"
  | "image"
  | "file"
  | "audio"
  | "video"
  | "task"
  | "custom"
  | "merged"
  | "system"
  | "unsupported";

export interface TextMessageContent {
  kind: "text";
  text: string;
}

export interface ImageMessageContent {
  height?: number;
  kind: "image";
  name?: string;
  size?: number;
  thumbnailUrl?: string;
  url?: string;
  width?: number;
}

export interface FileMessageContent {
  kind: "file";
  mimeType?: string;
  name: string;
  size?: number;
  url?: string;
}

export interface AudioMessageContent {
  durationSeconds?: number;
  kind: "audio";
  size?: number;
  url?: string;
}

export interface VideoMessageContent {
  coverUrl?: string;
  durationSeconds?: number;
  height?: number;
  kind: "video";
  size?: number;
  url?: string;
  width?: number;
}

export interface MessageReference {
  groupId?: string | null;
  kind: "c2c" | "group";
  messageId: string;
  sequence?: number;
  senderUserId?: string | null;
  timestamp?: number;
  topicId?: string | null;
}

export interface MessageThreadLink {
  role: "reply";
  rootMessageRef: MessageReference;
  threadId: string;
}

export interface TaskMessageContent {
  assigneeId?: string | undefined;
  kind: "task";
  sourceMessageRef?: MessageReference | string;
  status: string;
  taskId: string;
  title: string;
}

export interface CustomMessageContent {
  data?: string;
  description?: string;
  extension?: string;
  kind: "custom";
  schema?: string;
}

export interface MergedMessageContent {
  abstractList: string[];
  kind: "merged";
  messageCount?: number;
  title: string;
}

export interface SystemMessageContent {
  kind: "system";
  text: string;
}

export interface UnsupportedMessageContent {
  kind: "unsupported";
  rawType: string;
}

export type MessageContent =
  | TextMessageContent
  | ImageMessageContent
  | FileMessageContent
  | AudioMessageContent
  | VideoMessageContent
  | TaskMessageContent
  | CustomMessageContent
  | MergedMessageContent
  | SystemMessageContent
  | UnsupportedMessageContent;

export interface MessageQuote {
  messageId: string;
  preview: string;
  senderId: string;
  senderName: string;
}

export interface MessageReaction {
  count: number;
  reactedByMe: boolean;
  reactionId: string;
  userIds?: string[];
}

export type MessageReadState =
  | {state: "unknown"}
  | {state: "unread"}
  | {readCount?: number; state: "read"; unreadCount?: number};

export type MessageDelivery =
  | {progress: number; state: "uploading"}
  | {state: "sending"}
  | {state: "sent"}
  | {error: string; retryable: boolean; state: "failed"};

export interface MessageSubmissionReference {
  count: number;
  final: boolean;
  id: string;
  index: number;
  role: "attachment" | "commit";
}

export interface Message {
  clientRequestId?: string | undefined;
  content: MessageContent;
  conversationId: string;
  createdAt: string;
  delivery: MessageDelivery;
  direction: "incoming" | "outgoing";
  id: string;
  kind: MessageKind;
  mentions: string[];
  quote?: MessageQuote | undefined;
  rawType: string;
  reactions: MessageReaction[];
  reference?: MessageReference | undefined;
  read: MessageReadState;
  senderAvatar?: string | undefined;
  senderId: string;
  senderName: string;
  submission?: MessageSubmissionReference | undefined;
  text: string;
  thread?: MessageThreadLink | undefined;
}

export interface MessageGroup {
  complete: boolean;
  id: string;
  messages: Message[];
  submissionId?: string;
}

export function isValidMessageSubmissionReference(
  value: unknown,
): value is MessageSubmissionReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reference = value as Partial<MessageSubmissionReference>;
  return (
    typeof reference.id === "string" &&
    reference.id.length > 0 &&
    Number.isInteger(reference.count) &&
    (reference.count as number) >= 1 &&
    (reference.count as number) <= 10 &&
    Number.isInteger(reference.index) &&
    (reference.index as number) >= 0 &&
    (reference.index as number) < (reference.count as number) &&
    typeof reference.final === "boolean" &&
    reference.final ===
      ((reference.index as number) === (reference.count as number) - 1) &&
    (reference.role === "attachment" || reference.role === "commit") &&
    (reference.role !== "commit" || reference.final === true)
  );
}

export function groupSubmissionMessages(messages: Message[]): MessageGroup[] {
  const ordered = [...messages].sort(compareMessages);
  const buckets = new Map<
    string,
    {
      conflict: boolean;
      count: number;
      indexes: Map<number, Message>;
      messages: Message[];
    }
  >();

  for (const message of ordered) {
    if (!isValidMessageSubmissionReference(message.submission)) continue;
    const key = submissionGroupKey(message);
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        conflict: false,
        count: message.submission.count,
        indexes: new Map([[message.submission.index, message]]),
        messages: [message],
      });
      continue;
    }
    existing.messages.push(message);
    if (
      existing.count !== message.submission.count ||
      existing.indexes.has(message.submission.index)
    ) {
      existing.conflict = true;
      continue;
    }
    existing.indexes.set(message.submission.index, message);
    const commits = existing.messages.filter(
      (item) => item.submission?.role === "commit",
    );
    if (commits.length > 1) existing.conflict = true;
  }

  const emitted = new Set<string>();
  const groups: MessageGroup[] = [];
  for (const message of ordered) {
    if (!isValidMessageSubmissionReference(message.submission)) {
      groups.push(singleMessageGroup(message));
      continue;
    }
    const key = submissionGroupKey(message);
    const bucket = buckets.get(key);
    if (!bucket || bucket.conflict) {
      groups.push(singleMessageGroup(message));
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    const parts = [...bucket.indexes.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, part]) => part);
    const complete =
      parts.length === bucket.count &&
      parts.at(-1)?.submission?.final === true;
    groups.push({
      complete,
      id: key,
      messages: parts,
      submissionId: message.submission.id,
    });
  }
  return groups;
}

export function mergeMessages(
  existing: Message[],
  incoming: Message[],
): Message[] {
  const byId = new Map<string, Message>();
  const byClientRequest = new Map<string, string>();

  for (const message of [...existing, ...incoming]) {
    if (message.clientRequestId) {
      const previousId = byClientRequest.get(message.clientRequestId);
      if (previousId && previousId !== message.id) {
        const previous = byId.get(previousId);
        if (previous && messagePriority(previous) > messagePriority(message)) {
          continue;
        }
        byId.delete(previousId);
      }
      byClientRequest.set(message.clientRequestId, message.id);
    }
    byId.set(message.id, message);
  }

  return [...byId.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

function compareMessages(left: Message, right: Message): number {
  return (
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
}

function submissionGroupKey(message: Message): string {
  return `${message.conversationId}\u0000${message.senderId}\u0000${message.submission?.id ?? ""}`;
}

function singleMessageGroup(message: Message): MessageGroup {
  return {complete: true, id: message.id, messages: [message]};
}

function messagePriority(message: Message): number {
  if (!message.id.startsWith("local:")) return 3;
  if (message.delivery?.state === "failed") return 2;
  return 1;
}
