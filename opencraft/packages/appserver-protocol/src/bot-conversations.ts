/** Stable AppServer extension identifier for Bot and group conversations. */
export const OPENCRAFT_BOT_CONVERSATIONS_EXTENSION = "vela/bot-conversations";

export type BotId = string;
export type BotConversationId = string;
export type BotMessageId = string;
export type BotExecutionId = string;
export type BotInteractionId = string;
export type BotParticipantId = string;
export type BotAttachmentId = string;
export type BotOpaqueCursor = string;

export interface BotConversationsCapability {
  readonly version: 1;
  readonly topologies: readonly ("direct" | "group")[];
  readonly features: {
    readonly messageStreaming: boolean;
    readonly executionCancellation: boolean;
    readonly attachments: boolean;
    readonly interactions: boolean;
    readonly botManagement: boolean;
    readonly botAssets: boolean;
    readonly groupMembership: boolean;
    readonly configuration: boolean;
    readonly routines: boolean;
  };
  readonly limits: {
    readonly maxPageSize: number;
    readonly maxInlineAttachmentBytes: number;
    readonly maxParticipants: number;
  };
}

export const OPENCRAFT_BOT_CONVERSATIONS_CAPABILITY: BotConversationsCapability =
  Object.freeze({
    version: 1,
    topologies: Object.freeze(["direct", "group"] as const),
    features: Object.freeze({
      messageStreaming: true,
      executionCancellation: true,
      attachments: true,
      interactions: true,
      botManagement: false,
      botAssets: false,
      groupMembership: false,
      configuration: false,
      routines: false,
    }),
    limits: Object.freeze({
      maxPageSize: 100,
      maxInlineAttachmentBytes: 10 * 1024 * 1024,
      maxParticipants: 32,
    }),
  });

export type AppServerBotAvatar =
  | { readonly type: "generated"; readonly seed: string; readonly palette?: string }
  | { readonly type: "resource"; readonly uri: string };

export interface AppServerBotModelSelection {
  readonly provider: string;
  readonly model: string;
}

export interface AppServerBotModelProviderOption {
  readonly provider: string;
  readonly name: string;
  readonly models: readonly string[];
  readonly authenticated: boolean;
  readonly warning?: string;
}

export interface AppServerBotConfiguration {
  readonly model: AppServerBotModelSelection | null;
}

export interface AppServerBotConfigurationOptions {
  readonly providers: readonly AppServerBotModelProviderOption[];
}

export interface AppServerBotDescriptor {
  readonly botId: BotId;
  readonly revision: number;
  readonly name: string;
  readonly subtitle?: string;
  readonly avatar?: AppServerBotAvatar;
  readonly status: "available" | "unavailable" | "disabled";
  readonly capabilities: readonly string[];
  /** Native runtime Profile identity when this Bot is backed by a Hermes Profile. */
  readonly runtimeProfileId?: string;
  /** Profile-level default used for future direct and Hosted Room executions. */
  readonly model?: AppServerBotModelSelection;
  /** Per-entity operations, constrained further by Host botManagement. */
  readonly management?: { readonly rename: boolean; readonly clone: boolean; readonly delete: boolean };
}

export interface AppServerBotParticipantSnapshot {
  readonly participantId: BotParticipantId;
  readonly kind: "human" | "bot";
  readonly displayName: string;
  readonly avatar?: AppServerBotAvatar;
}

export interface AppServerBotConversationDescriptor {
  readonly conversationId: BotConversationId;
  readonly revision: number;
  readonly topology: "direct" | "group";
  readonly title: string;
  readonly participantIds: readonly BotParticipantId[];
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly archivedAtMs?: number;
  /** Historical room whose roster can no longer execute writes. */
  readonly readOnly?: boolean;
}

export interface AppServerBotAttachment {
  readonly attachmentId: BotAttachmentId;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Optional Host-resolved display/download location. IDs remain authority. */
  readonly downloadUri?: string;
}

export type AppServerBotMessageContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "attachment"; readonly attachment: AppServerBotAttachment }
  | { readonly type: "resource"; readonly uri: string; readonly title: string };

export interface AppServerBotDomainErrorData {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AppServerBotMessage {
  readonly messageId: BotMessageId;
  readonly conversationId: BotConversationId;
  readonly clientMessageId?: string;
  readonly author: AppServerBotParticipantSnapshot;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly state: "streaming" | "complete" | "failed";
  readonly content: readonly AppServerBotMessageContentPart[];
  readonly causalMessageId?: BotMessageId;
  readonly executionId?: BotExecutionId;
  readonly error?: AppServerBotDomainErrorData;
}

export interface AppServerBotExecution {
  readonly executionId: BotExecutionId;
  readonly conversationId: BotConversationId;
  readonly participantId: BotParticipantId;
  readonly causalMessageId: BotMessageId;
  readonly status: "queued" | "running" | "completed" | "failed" | "cancelled";
  readonly startedAtMs?: number;
  readonly completedAtMs?: number;
  readonly error?: AppServerBotDomainErrorData;
}

export interface AppServerBotPresenceFact {
  readonly conversationId: BotConversationId;
  readonly participantId: BotParticipantId;
  readonly executionId: BotExecutionId;
  readonly phase: "queued" | "thinking" | "working" | "responding";
  readonly activity?: string;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
}

export interface AppServerBotEventStamp {
  readonly epoch: string;
  readonly seq: number;
}

export interface AppServerBotLiveCursor {
  readonly epoch: string;
  readonly nextSeq: number;
}

export type AppServerBotInteraction =
  | {
      readonly interactionId: BotInteractionId;
      readonly conversationId: BotConversationId;
      readonly executionId: BotExecutionId;
      readonly participantId: BotParticipantId;
      readonly kind: "approval";
      readonly status: "pending" | "resolved" | "expired";
      readonly title: string;
      readonly description?: string;
      readonly choices: readonly {
        readonly choiceId: string;
        readonly label: string;
        readonly destructive?: boolean;
      }[];
    }
  | {
      readonly interactionId: BotInteractionId;
      readonly conversationId: BotConversationId;
      readonly executionId: BotExecutionId;
      readonly participantId: BotParticipantId;
      readonly kind: "clarification";
      readonly status: "pending" | "resolved" | "expired";
      readonly title: string;
      readonly questions: readonly {
        readonly questionId: string;
        readonly prompt: string;
        readonly multiple?: boolean;
        readonly choices?: readonly { readonly value: string; readonly label: string }[];
      }[];
    };

export type AppServerBotInputPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "mention"; readonly participantId: BotParticipantId; readonly label: string }
  | { readonly type: "attachment"; readonly attachmentId: BotAttachmentId }
  | { readonly type: "resource"; readonly uri: string; readonly title: string };

export type AppServerBotInteractionResponse =
  | { readonly type: "approval"; readonly choiceId: string }
  | {
      readonly type: "clarification";
      readonly answers: Readonly<Record<string, string | readonly string[]>>;
    };

export interface AppServerBotMethodMap {
  "bot/list": {
    params: { readonly cursor?: BotOpaqueCursor; readonly limit?: number };
    result: { readonly data: readonly AppServerBotDescriptor[]; readonly nextCursor?: BotOpaqueCursor };
  };
  "bot/read": {
    params: { readonly botId: BotId };
    result: { readonly bot: AppServerBotDescriptor };
  };
  "bot/configuration/read": {
    params: { readonly botId: BotId };
    result: { readonly configuration: AppServerBotConfiguration };
  };
  "bot/configuration/options": {
    params: { readonly botId: BotId };
    result: AppServerBotConfigurationOptions;
  };
  "bot/configuration/update": {
    params: {
      readonly botId: BotId;
      readonly expectedRevision: number;
      readonly model: AppServerBotModelSelection;
      readonly confirmExpensiveModel?: boolean;
    };
    result: {
      readonly bot: AppServerBotDescriptor;
      readonly configuration: AppServerBotConfiguration;
      readonly applied: boolean;
      readonly confirmationRequired?: { readonly message: string };
    };
  };
  "bot/create": {
    params: {
      readonly clientRequestId: string;
      readonly name: string;
      readonly templateId?: string;
    };
    result: { readonly bot: AppServerBotDescriptor; readonly replayed: boolean };
  };
  "bot/update": {
    params: {
      readonly botId: BotId;
      readonly expectedRevision: number;
      readonly patch: {
        readonly name?: string;
        readonly subtitle?: string;
        readonly status?: "available" | "disabled";
      };
    };
    result: { readonly bot: AppServerBotDescriptor };
  };
  "bot/delete": {
    params: { readonly botId: BotId; readonly expectedRevision: number };
    result: { readonly botId: BotId; readonly revision: number };
  };
  "bot/conversation/list": {
    params: {
      readonly cursor?: BotOpaqueCursor;
      readonly limit?: number;
      readonly archived?: boolean;
      readonly botId?: BotId;
    };
    result: {
      readonly data: readonly AppServerBotConversationDescriptor[];
      readonly nextCursor?: BotOpaqueCursor;
    };
  };
  "bot/conversation/create": {
    params: {
      readonly clientRequestId: string;
      readonly topology: "direct" | "group";
      readonly title?: string;
      readonly participantIds: readonly BotParticipantId[];
    };
    result: { readonly conversation: AppServerBotConversationDescriptor; readonly replayed: boolean };
  };
  "bot/conversation/read": {
    params: {
      readonly conversationId: BotConversationId;
      readonly initialMessagesPage?: { readonly limit: number };
    };
    result: {
      readonly conversation: AppServerBotConversationDescriptor;
      readonly participants: readonly AppServerBotParticipantSnapshot[];
      readonly initialMessagesPage: {
        readonly data: readonly AppServerBotMessage[];
        readonly nextCursor?: BotOpaqueCursor;
      };
      readonly executions: readonly AppServerBotExecution[];
      readonly interactions: readonly AppServerBotInteraction[];
      readonly presence: readonly AppServerBotPresenceFact[];
      readonly liveCursor: AppServerBotLiveCursor;
    };
  };
  "bot/conversation/update": {
    params: {
      readonly conversationId: BotConversationId;
      readonly expectedRevision: number;
      readonly patch: { readonly title?: string; readonly participantIds?: readonly BotParticipantId[] };
    };
    result: { readonly conversation: AppServerBotConversationDescriptor };
  };
  "bot/conversation/archive": {
    params: { readonly conversationId: BotConversationId; readonly expectedRevision: number };
    result: { readonly conversation: AppServerBotConversationDescriptor };
  };
  "bot/conversation/unarchive": {
    params: { readonly conversationId: BotConversationId; readonly expectedRevision: number };
    result: { readonly conversation: AppServerBotConversationDescriptor };
  };
  "bot/conversation/delete": {
    params: { readonly conversationId: BotConversationId; readonly expectedRevision: number };
    result: { readonly conversationId: BotConversationId; readonly revision: number };
  };
  "bot/messages/list": {
    params: {
      readonly conversationId: BotConversationId;
      readonly cursor?: BotOpaqueCursor;
      readonly limit: number;
      readonly direction: "backwards" | "forwards";
    };
    result: { readonly data: readonly AppServerBotMessage[]; readonly nextCursor?: BotOpaqueCursor };
  };
  "bot/message/send": {
    params: {
      readonly conversationId: BotConversationId;
      readonly clientMessageId: string;
      readonly content: readonly AppServerBotInputPart[];
      readonly replyToMessageId?: BotMessageId;
    };
    result: {
      readonly message: AppServerBotMessage;
      readonly executions: readonly AppServerBotExecution[];
      readonly replayed: boolean;
    };
  };
  "bot/execution/cancel": {
    params: {
      readonly conversationId: BotConversationId;
      readonly executionId: BotExecutionId;
      readonly commandId: string;
    };
    result: { readonly execution: AppServerBotExecution; readonly replayed: boolean };
  };
  "bot/interaction/respond": {
    params: {
      readonly conversationId: BotConversationId;
      readonly executionId: BotExecutionId;
      readonly interactionId: BotInteractionId;
      readonly commandId: string;
      readonly response: AppServerBotInteractionResponse;
    };
    result: { readonly interaction: AppServerBotInteraction; readonly replayed: boolean };
  };
  "bot/attachment/upload": {
    params: {
      readonly clientAttachmentId: string;
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
      readonly bytesBase64: string;
    };
    result: { readonly attachment: AppServerBotAttachment; readonly replayed: boolean };
  };
}

export type AppServerBotMethod = keyof AppServerBotMethodMap & string;
export type AppServerBotMethodParams<TMethod extends AppServerBotMethod> =
  AppServerBotMethodMap[TMethod]["params"];
export type AppServerBotMethodResult<TMethod extends AppServerBotMethod> =
  AppServerBotMethodMap[TMethod]["result"];

export type AppServerBotConversationEvent =
  | { readonly method: "bot/updated"; readonly params: { readonly bot: AppServerBotDescriptor } }
  | { readonly method: "bot/deleted"; readonly params: { readonly botId: BotId; readonly revision: number } }
  | {
      readonly method: "bot/conversation/updated";
      readonly params: AppServerBotConversationEventBase & {
        readonly conversation: AppServerBotConversationDescriptor;
      };
    }
  | {
      readonly method: "bot/conversation/deleted";
      readonly params: AppServerBotConversationEventBase & { readonly revision: number };
    }
  | {
      readonly method: "bot/message/started" | "bot/message/completed";
      readonly params: AppServerBotConversationEventBase & { readonly message: AppServerBotMessage };
    }
  | {
      readonly method: "bot/message/delta";
      readonly params: AppServerBotConversationEventBase & {
        readonly messageId: BotMessageId;
        readonly executionId: BotExecutionId;
        readonly deltaSeq: number;
        readonly partIndex: number;
        readonly delta: string;
      };
    }
  | {
      readonly method: "bot/execution/updated";
      readonly params: AppServerBotConversationEventBase & { readonly execution: AppServerBotExecution };
    }
  | {
      readonly method: "bot/presence/updated";
      readonly params: AppServerBotConversationEventBase & {
        readonly participantId: BotParticipantId;
        readonly executionId: BotExecutionId;
        readonly presence: AppServerBotPresenceFact | null;
      };
    }
  | {
      readonly method: "bot/interaction/requested" | "bot/interaction/resolved";
      readonly params: AppServerBotConversationEventBase & { readonly interaction: AppServerBotInteraction };
    };

export interface AppServerBotConversationEventBase {
  readonly stamp: AppServerBotEventStamp;
  readonly conversationId: BotConversationId;
}

const BOT_EVENT_METHODS: ReadonlySet<string> = new Set([
  "bot/updated",
  "bot/deleted",
  "bot/conversation/updated",
  "bot/conversation/deleted",
  "bot/message/started",
  "bot/message/delta",
  "bot/message/completed",
  "bot/execution/updated",
  "bot/presence/updated",
  "bot/interaction/requested",
  "bot/interaction/resolved",
]);

export function isAppServerBotConversationEvent(
  value: { readonly method: string; readonly params?: unknown },
): value is AppServerBotConversationEvent {
  return BOT_EVENT_METHODS.has(value.method);
}
