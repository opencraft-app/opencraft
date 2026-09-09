import type { ReplicaClientSnapshot } from "@opencraft/appserver-replica";
import type { ReplicaJsonValue } from "@opencraft/appserver-protocol";
import type {
  QueuedSubmission,
  UserInput,
} from "@opencraft/appserver-protocol/generated/v2";
import type { ConversationKey, TurnId } from "@opencraft/chat-core";
import type { SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";

import type { InteractionResponse } from "./models";

/** Transport adapters distinguish rejection from a lost acknowledgement. */
export class SubmissionOutcomeUnknownError extends Error {
  constructor(options?: ErrorOptions) {
    super("Could not confirm whether the host accepted this message. Reconnect to reconcile before sending again.", options);
    this.name = "SubmissionOutcomeUnknownError";
  }
}

export class ContinuationCommandError extends Error {
  constructor(
    readonly outcome: "rejected" | "unknown",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ContinuationCommandError";
  }
}

export interface ConversationReplicaReader {
  getSnapshot(): ReplicaClientSnapshot<ReplicaJsonValue>;
  subscribe(listener: () => void): () => void;
}

export interface ConversationHistoryPort {
  loadOlder(key: ConversationKey): Promise<void>;
}

export interface ConversationCommandPort {
  /** Creates the authoritative Thread without starting its first Turn. */
  createThread(intent: SubmitIntent): Promise<SubmissionReceipt>;
  submit(intent: SubmitIntent): Promise<SubmissionReceipt>;
  interrupt(key: ConversationKey, turnId: TurnId): Promise<void>;
  continueTurn(key: ConversationKey, turnId: TurnId): Promise<SubmissionReceipt>;
  respond(key: ConversationKey, response: InteractionResponse): Promise<void>;
  updateQueuedSubmission(
    key: ConversationKey,
    queuedSubmissionId: string,
    input: readonly UserInput[],
  ): Promise<QueuedSubmission>;
  deleteQueuedSubmission(
    key: ConversationKey,
    queuedSubmissionId: string,
  ): Promise<boolean>;
  reorderQueuedSubmissions(
    key: ConversationKey,
    queuedSubmissionIds: readonly string[],
  ): Promise<void>;
  startQueuedSubmission(
    key: ConversationKey,
    queuedSubmissionId?: string,
  ): Promise<TurnId>;
  steerQueuedSubmission(
    key: ConversationKey,
    queuedSubmission: QueuedSubmission,
    activeTurnId: TurnId,
  ): Promise<TurnId>;
}
