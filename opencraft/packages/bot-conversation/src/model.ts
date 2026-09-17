import type { ConversationKey } from "@opencraft/chat-core";

export type ConversationExperience = "task" | "bot";
export type ConversationTopology = "direct" | "group";

export type BotParticipantKind = "human" | "bot";

export type BotAvatarSnapshot =
  | {
      readonly kind: "image-url";
      readonly url: string;
      readonly alt: string;
    }
  | {
      readonly kind: "monogram";
      readonly text: string;
      readonly background: string;
      readonly foreground: string;
    };

/**
 * Historical identity embedded in a message. A live roster may enrich it,
 * but deleting or renaming a member must never rewrite old attribution.
 */
export interface BotParticipantSnapshot {
  readonly participantId: string;
  readonly kind: BotParticipantKind;
  readonly displayName: string;
  readonly avatar: BotAvatarSnapshot | null;
}

export interface BotConversationDescriptor {
  readonly key: ConversationKey;
  readonly experience: "bot";
  readonly topology: ConversationTopology;
  readonly title: string | null;
  readonly rosterRevision: number;
  readonly participants: readonly BotParticipantSnapshot[];
  /** Historical room whose roster can no longer execute writes. */
  readonly readOnly?: boolean;
}

export type BotMessageContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly uri: string;
      readonly alt: string | null;
    }
  | {
      readonly type: "resource";
      readonly uri: string;
      readonly title: string;
    };

export type BotMessageDelivery = "sending" | "sent" | "failed";

export interface BotConversationMessage {
  readonly id: string;
  readonly clientMessageId: string | null;
  /**
   * The execution that produced this message. Human messages and imported
   * transcript entries may be unscoped. Renderers must never infer execution
   * ownership from author adjacency or array position.
   */
  readonly executionId: string | null;
  /** Stable message key that causally triggered the execution, when known. */
  readonly causalMessageKey: string | null;
  readonly conversationKey: ConversationKey;
  readonly author: BotParticipantSnapshot;
  readonly content: readonly BotMessageContentPart[];
  readonly sentAtMs: number;
  readonly delivery: BotMessageDelivery;
  readonly streaming: boolean;
}

export type BotPresencePhase =
  | "idle"
  | "thinking"
  | "working"
  | "typing"
  | "waiting"
  | "blocked";

export interface BotActivity {
  readonly verb:
    | "thinking"
    | "searching"
    | "reading"
    | "writing"
    | "coding"
    | "running"
    | "messaging"
    | "waiting"
    | "spawning";
  readonly detail: string | null;
  readonly targetParticipantId: string | null;
}

/** Transient projection fact. It is never persisted as a chat message. */
export interface BotPresenceFact {
  readonly conversationKey: ConversationKey;
  readonly participantId: string;
  readonly executionId: string;
  readonly seq: number;
  readonly phase: BotPresencePhase;
  readonly activity: BotActivity | null;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
}

export type BotExecutionStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * A Bot execution is not a conversational Turn. One user message can fan out
 * to several executions, and an automation can create an execution without a
 * user message. It only owns work lifecycle and causal identity.
 */
export interface BotExecutionSnapshot {
  readonly executionId: string;
  readonly conversationKey: ConversationKey;
  readonly participantId: string;
  readonly causalMessageKey: string | null;
  readonly status: BotExecutionStatus;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  /** Stable failure category only; raw provider diagnostics stay at the Host. */
  readonly error?: {
    readonly code: string;
    readonly retryable: boolean;
  };
}

export type BotInteractionSnapshot =
  | {
      readonly interactionId: string;
      readonly executionId: string;
      readonly participantId: string;
      readonly kind: "approval";
      readonly status: "pending" | "resolved" | "expired";
      readonly title: string;
      readonly description: string | null;
      readonly choices: readonly {
        readonly choiceId: string;
        readonly label: string;
        readonly destructive: boolean;
      }[];
    }
  | {
      readonly interactionId: string;
      readonly executionId: string;
      readonly participantId: string;
      readonly kind: "clarification";
      readonly status: "pending" | "resolved" | "expired";
      readonly title: string;
      readonly questions: readonly {
        readonly questionId: string;
        readonly prompt: string;
        readonly multiple: boolean;
        readonly choices: readonly {
          readonly value: string;
          readonly label: string;
        }[];
      }[];
    };

export type BotInteractionResponse =
  | { readonly type: "approval"; readonly choiceId: string }
  | {
      readonly type: "clarification";
      readonly answers: Readonly<Record<string, string | readonly string[]>>;
    };

export interface BotConversationSnapshot {
  readonly revision: number;
  readonly phase: "idle" | "loading" | "ready" | "offline" | "error";
  readonly descriptor: BotConversationDescriptor;
  /** Durable, append-oriented semantic history. */
  readonly transcript: readonly BotConversationMessage[];
  /** Execution lifecycle, independent from transcript rows. */
  readonly executions: readonly BotExecutionSnapshot[];
  /** Ephemeral live facts, independent from durable history. */
  readonly presence: readonly BotPresenceFact[];
  /** Durable request state. Only pending interactions are actionable. */
  readonly interactions: readonly BotInteractionSnapshot[];
  readonly history: {
    readonly hasOlder: boolean;
    readonly loadingOlder: boolean;
  };
  readonly error: string | null;
}

export interface BotMessageBubbleProjection {
  readonly message: BotConversationMessage;
  readonly stableKey: string;
  readonly continuedFromPrevious: boolean;
  readonly continuedToNext: boolean;
  readonly groupStart: boolean;
  readonly runStart: boolean;
  readonly groupEnd: boolean;
}

export interface BotMessageRunProjection {
  readonly author: BotParticipantSnapshot;
  readonly stableKey: string;
  readonly messages: readonly BotMessageBubbleProjection[];
}

/** A durable unscoped message represented as one stable layout unit. */
export interface BotMessageTimelineUnit {
  readonly kind: "message";
  readonly unitKey: string;
  readonly occurredAtMs: number;
  readonly messageRuns: readonly BotMessageRunProjection[];
}

export interface BotExecutionTimelineUnit {
  readonly kind: "execution";
  readonly unitKey: string;
  readonly occurredAtMs: number;
  readonly execution: BotExecutionSnapshot;
  readonly presence: readonly BotPresenceFact[];
}

export type BotTimelineUnit =
  | BotMessageTimelineUnit
  | BotExecutionTimelineUnit;

/** Read-only layout projection. It is never the Bot conversation authority. */
export interface BotTimelineProjection {
  readonly revision: number;
  readonly units: readonly BotTimelineUnit[];
}

export interface BotSendReceipt {
  readonly commandId: string;
  readonly clientMessageId: string;
  readonly messageId: string;
  readonly acceptedAtMs: number;
}

/** Stable React key shared by optimistic and acknowledged projections. */
export function botMessageStableKey(message: BotConversationMessage): string {
  return message.clientMessageId ?? message.id;
}

export function botMessageText(message: BotConversationMessage): string {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/**
 * Collapses an append-oriented Presence feed into one fact per participant.
 *
 * A transport may interleave facts from several Bots and may replay an older
 * fact after reconnect.  Array position therefore is not authority.  Sequence
 * number is authoritative within an execution; observation time is the
 * deterministic tie-breaker across executions.
 */
export function latestBotPresenceFacts(
  facts: readonly BotPresenceFact[],
): readonly BotPresenceFact[] {
  const latest = new Map<string, BotPresenceFact>();
  for (const fact of facts) {
    const key = `${fact.executionId}\u0000${fact.participantId}`;
    const current = latest.get(key);
    const isNewer = current === undefined || (
      fact.seq > current.seq || (
        fact.seq === current.seq && fact.observedAtMs > current.observedAtMs
      )
    );
    if (isNewer) {
      latest.set(key, fact);
    }
  }
  return [...latest.values()].sort((left, right) =>
    left.observedAtMs - right.observedAtMs ||
    left.participantId.localeCompare(right.participantId)
  );
}
