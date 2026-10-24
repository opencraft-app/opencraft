import type { ReplicaClientSnapshot } from "@opencraft/appserver-replica";
import type {
  QueuedSubmission,
  ReplicaJsonValue,
} from "@opencraft/appserver-protocol";
import type { UserInput } from "@opencraft/appserver-protocol/generated/v2";
import type { ConversationKey, TurnId } from "@opencraft/chat-core";
import type { SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";

import type { InteractionResponse } from "./models";

/** No request crossed the transport boundary; reconnect may safely retry it. */
export class SubmissionNotDispatchedError extends Error {
  constructor() { super("Waiting for the current connection before sending"); this.name = "SubmissionNotDispatchedError"; }
}

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

export interface TurnInterruptProvenance {
  readonly source:
    | "composer-stop"
    | "side-chat-stop"
    | "side-chat-close"
    | "unknown";
  readonly trigger: "pointer" | "keyboard" | "programmatic";
  readonly isTrusted: boolean | null;
  readonly occurredAt: number;
}

export interface ConversationCommandPort {
  /** Creates the authoritative Thread without starting its first Turn. */
  createThread(intent: SubmitIntent): Promise<SubmissionReceipt>;
  submit(intent: SubmitIntent, options?: { readonly canDispatch: () => boolean }): Promise<SubmissionReceipt>;
  interrupt(
    key: ConversationKey,
    turnId: TurnId,
    provenance?: TurnInterruptProvenance,
  ): Promise<void>;
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
  discardUnconfirmedSteer(
    key: ConversationKey,
    queuedSubmissionId: string,
    expectedTurnId: TurnId,
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
