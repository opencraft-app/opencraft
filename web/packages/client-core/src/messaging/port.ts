import type {HumanImSession} from "../platform/api.js";
import type {ConversationAddress} from "./conversation.js";
import type {
  Message,
  MessageQuote,
  MessageReference,
  MessageSubmissionReference,
} from "./model.js";

export type Unsubscribe = () => void;

export interface MessagePage {
  completed: boolean;
  messages: Message[];
  nextCursor?: string;
}

export interface MessageMention {
  displayName: string;
  imUserId: string;
  memberId: string;
  memberKind: "human" | "agent";
}

export interface SendTextInput {
  channel: ConversationAddress;
  clientRequestId: string;
  mentions: MessageMention[];
  quote?: MessageQuote;
  text: string;
  submission?: MessageSubmissionReference;
  thread?: {
    rootMessageRef: MessageReference;
    threadId: string;
  };
}

export type AttachmentSource =
  | {
      height?: number;
      kind: "uri";
      mimeType?: string;
      name: string;
      size?: number;
      uri: string;
      width?: number;
    }
  | {
      file: unknown;
      height?: number;
      kind: "platform-file";
      mimeType?: string;
      name: string;
      previewUri?: string;
      size?: number;
      width?: number;
    };

export interface SendAttachmentInput {
  channel: ConversationAddress;
  clientRequestId: string;
  kind: "file" | "image";
  onProgress?: (progress: number) => void;
  quote?: MessageQuote;
  source: AttachmentSource;
  submission?: MessageSubmissionReference;
}

export class MessagingSendError extends Error {
  public readonly outcome: "definitive" | "uncertain";
  public readonly retryable: boolean;

  public constructor(
    message: string,
    options: {
      cause?: unknown;
      outcome: "definitive" | "uncertain";
      retryable: boolean;
    },
  ) {
    super(message, options.cause === undefined ? undefined : {cause: options.cause});
    this.name = "MessagingSendError";
    this.outcome = options.outcome;
    this.retryable = options.retryable;
  }
}

export interface ReconcileMessageInput {
  channel: ConversationAddress;
  clientRequestId: string;
}

export type ReconcileMessageResult =
  | {message: Message; state: "sent"}
  | {error: string; retryable: boolean; state: "failed"}
  | {state: "pending"};

export interface TaskMessageProjection {
  assigneeId?: string;
  sourceMessageRef?: MessageReference;
  status: string;
  taskId: string;
  title: string;
}

export interface SendTaskInput {
  channel: ConversationAddress;
  clientRequestId: string;
  task: TaskMessageProjection;
}

export interface ConversationSummary {
  conversationId: string;
  kind: "direct" | "group";
  lastMessageAt?: string;
  lastMessage?: Message;
  lastMessagePreview: string;
  title: string;
  unreadCount: number;
}

export interface ConversationSummarySnapshot {
  isSyncCompleted: boolean;
  items: ConversationSummary[];
}

export interface MessagingScope {
  allowedConversations: ConversationAddress[];
  generation: number;
}

export interface MessageSearchPage {
  completed: boolean;
  messages: Message[];
  nextCursor?: string;
  totalCount: number;
}

export interface SearchMessagesInput {
  channel?: ConversationAddress;
  cursor?: string;
  limit?: number;
  query: string;
}

export type MessagingLifecycleEvent =
  | {type: "ready"}
  | {reason?: string; type: "not_ready"}
  | {
      state: "connecting" | "connected" | "disconnected";
      type: "network";
    }
  | {
      cause?: "user_sig_expired";
      reason?: string;
      type: "kicked_out";
    }
  | {code?: number; message: string; type: "error"};

export interface MessagingPort {
  close(): Promise<void>;
  connect(session: HumanImSession): Promise<void>;
  loadHistory(
    channel: ConversationAddress,
    cursor?: string,
  ): Promise<MessagePage>;
  loadMessageContext(
    channel: ConversationAddress,
    reference: MessageReference,
  ): Promise<Message[]>;
  listConversations(
    groupIds: string[],
  ): Promise<ConversationSummarySnapshot>;
  loadMessagesByReferences(
    channel: ConversationAddress,
    references: MessageReference[],
  ): Promise<Message[]>;
  markRead(channel: ConversationAddress): Promise<void>;
  reconcileMessage(input: ReconcileMessageInput): Promise<ReconcileMessageResult>;
  setScope(scope: MessagingScope): Promise<void>;
  retryMessage(clientRequestId: string): Promise<Message>;
  revokeMessage(messageId: string): Promise<Message>;
  searchMessages(input: SearchMessagesInput): Promise<MessageSearchPage>;
  sendTask(input: SendTaskInput): Promise<Message>;
  sendAttachment(input: SendAttachmentInput): Promise<Message>;
  sendText(input: SendTextInput): Promise<Message>;
  setReaction(
    messageId: string,
    reactionId: string,
    active: boolean,
  ): Promise<void>;
  subscribeConversations(
    listener: (conversations: ConversationSummary[]) => void,
  ): Unsubscribe;
  subscribeLifecycle(
    listener: (event: MessagingLifecycleEvent) => void,
  ): Unsubscribe;
  subscribeMessages(listener: (messages: Message[]) => void): Unsubscribe;
  waitUntilReady(timeoutMs: number): Promise<void>;
}
