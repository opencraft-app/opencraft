import type { ReactNode } from "react";
import type { AssistantTimelineFrame } from "@opencraft/chat-core";
import type { ConversationRecoveryDiagnostic } from "./conversation-recovery-diagnostic";

export interface AssistantFramePresentationContext {
  readonly frame: AssistantTimelineFrame;
  readonly inputText: string;
  readonly children: ReactNode;
}

export interface AssistantActionsPresentationContext {
  readonly turnId: string;
  readonly itemIds: readonly string[];
}

export interface ConversationRecoveryContext {
  readonly hasVisibleHistory: boolean;
  readonly failed: boolean;
  readonly reconnecting: boolean;
  readonly requiresUpdate: boolean;
  readonly diagnostic?: ConversationRecoveryDiagnostic;
  readonly onRetry?: () => void;
}

export type ConversationRecoveryRenderer = (context: ConversationRecoveryContext) => ReactNode;

/** Current conversation facts and scoped actions; no product metadata interpretation. */
export interface ConversationPresentationContext {
  readonly hostId: string;
  readonly threadId: string;
  readonly extra: unknown;
  readonly ready: boolean;
  readonly authoritative: boolean;
  readonly activeTurnId?: string | null;
  readonly canFork: boolean;
  readExtra(): Promise<unknown>;
  fork(): Promise<void>;
}

export interface ConversationPresentation {
  /** Wraps one assistant frame, including its actions. Display only. */
  readonly renderAssistantFrame?: (context: AssistantFramePresentationContext) => ReactNode;
  /** Adds actions to settled, authoritative assistant turns. */
  readonly renderAssistantActions?: (context: AssistantActionsPresentationContext) => ReactNode;
  /** Replaces ordinary conversation recovery presentation. */
  readonly renderRecovery?: ConversationRecoveryRenderer;
  readonly subtitle?: ReactNode;
  readonly beforeComposer?: ReactNode;
  readonly afterComposer?: ReactNode;
  /** Opt into visible, serial history reads; never Resume or reclaim execution. */
  readonly refreshHistory?: boolean;
}

/** Trusted local composition, shared by standalone and embedded roots. */
export type ConversationPresentationProvider = (context: ConversationPresentationContext) => ConversationPresentation | null;
