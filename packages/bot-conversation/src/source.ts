import type { ConversationKey } from "@opencraft/chat-core";
import type { SubmitIntent } from "@opencraft/composer-core";

import type {
  BotInteractionResponse,
  BotConversationSnapshot,
  BotSendReceipt,
} from "./model";

export type BotConversationListener = () => void;

export interface BotConversationSelection {
  readonly hostId: string;
  readonly botId: string | null;
}

/** Resolves a user-facing Bot selection to one exact AppServer conversation. */
export interface BotConversationResolver {
  resolve(
    selection: BotConversationSelection,
    signal?: AbortSignal,
  ): Promise<ConversationKey>;
}

/**
 * UI-facing port for a Bot conversation. AppServer, Hermes and deterministic
 * fixtures are peer implementations; React never knows which one is active.
 */
export interface BotConversationSource {
  getSnapshot(key: ConversationKey): BotConversationSnapshot;
  subscribe(key: ConversationKey, listener: BotConversationListener): () => void;
  load(key: ConversationKey): Promise<void>;
  loadOlder(key: ConversationKey): Promise<void>;
  send(key: ConversationKey, intent: SubmitIntent): Promise<BotSendReceipt>;
  cancel(key: ConversationKey, executionId: string): Promise<void>;
  respondToInteraction(
    key: ConversationKey,
    interactionId: string,
    executionId: string,
    response: BotInteractionResponse,
  ): Promise<void>;
  dispose(): void;
}

export class BotConversationSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "BotConversationSourceError";
  }
}
