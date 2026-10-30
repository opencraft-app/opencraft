import type {
  AppServerServerMethod,
  AppServerServerRequestParams,
  ReplicaJsonValue,
  MessageSender,
} from "@opencraft/appserver-protocol";
import type {
  ConversationKey,
  ConversationPhase,
  TimelineSnapshot,
  TurnId,
} from "@opencraft/chat-core";
import type {
  CommandExecutionApprovalDecision,
  FileChangeApprovalDecision,
  GrantedPermissionProfile,
  PermissionGrantScope,
  UserInput,
} from "@opencraft/appserver-protocol/generated/v2";

export type PendingInteraction = {
  [TMethod in AppServerServerMethod]: {
    readonly requestId: string;
    readonly method: TMethod;
    readonly turnId: TurnId | null;
    readonly itemId: string | null;
    readonly receivedAtMs: number;
    readonly responseState?: "pending" | "responding" | "unconfirmed";
    readonly canRespond?: boolean;
    readonly params: AppServerServerRequestParams<TMethod>;
  };
}[AppServerServerMethod];

export interface QueuedSubmission {
  /** Browser-owned, never accepted by the Host yet. */
  readonly local?: boolean;
  /** Runtime can accept a promotion while normal queue admission is in flight. */
  readonly steerable?: boolean;
  readonly sender?: MessageSender | null;
  readonly commandId: string;
  readonly clientMessageId: string;
  readonly serverSubmissionId: string | null;
  readonly input: readonly UserInput[];
  readonly preview: string;
  readonly state: "submitting" | "queued" | "failed" | "unknown";
  readonly operation: "idle" | "updating" | "deleting" | "starting";
  readonly createdAt: number;
  readonly pausedReason: string | null;
  readonly error: Error | null;
}

/**
 * Short-lived client command state. This is deliberately not a queued
 * follow-up: normal sends and steers live here until the Replica acknowledges
 * their client message identity.
 */
export interface PendingSubmission {
  readonly commandId: string;
  readonly clientMessageId: string;
  readonly turnId: TurnId | null;
  readonly preview: string;
  readonly state: "submitting" | "accepted" | "failed" | "unknown";
  readonly createdAt: number;
  readonly error: Error | null;
}

export interface ConversationExecutionSnapshot {
  readonly model: string | null;
  readonly effort: string | null;
  readonly serviceTier?: string | null;
  readonly permissionProfile: string | null;
  readonly cwd: string | null;
  readonly runtimeWorkspaceRoots: readonly string[];
}

export interface ConversationRuntimeSnapshot {
  readonly key: ConversationKey;
  readonly revision: number;
  readonly phase: ConversationPhase;
  readonly authoritative: boolean;
  readonly title: string | null;
  readonly threadStatus: unknown;
  /** Effective AppServer execution settings restored for the active thread. */
  readonly execution: ConversationExecutionSnapshot;
  readonly timeline: TimelineSnapshot;
  readonly continuation: {
    readonly turnId: TurnId | null;
    readonly pending: boolean;
    readonly error: Error | null;
  };
  readonly activeTurn: {
    readonly turnId: TurnId;
    readonly status: "pending" | "streaming" | "interrupting";
  } | null;
  readonly pendingInteractions: readonly PendingInteraction[];
  readonly pendingSubmissions: readonly PendingSubmission[];
  readonly queuedSubmissions: readonly QueuedSubmission[];
  /** Native claims whose delivery could not be established after recovery. */
  readonly unconfirmedSteers: readonly import("@opencraft/appserver-protocol").SteeringSubmission[];
  readonly history: {
    readonly hasOlder: boolean;
    readonly loading: boolean;
    readonly cursor: string | null;
    readonly error: Error | null;
  };
  readonly error: Error | null;
}

export type InteractionResponse =
  | {
      readonly type: "command-approval";
      readonly requestId: string;
      readonly decision: CommandExecutionApprovalDecision;
      readonly _meta?: { readonly persist: "always" };
    }
  | {
      readonly type: "file-change-approval";
      readonly requestId: string;
      readonly decision: FileChangeApprovalDecision;
    }
  | {
      readonly type: "permissions-approval";
      readonly requestId: string;
      readonly permissions: GrantedPermissionProfile;
      readonly scope: PermissionGrantScope;
      readonly strictAutoReview?: boolean;
    }
  | {
      readonly type: "question";
      readonly requestId: string;
      readonly answers: Readonly<Record<string, readonly string[]>>;
    }
  | {
      readonly type: "option-picker";
      readonly requestId: string;
      readonly action: "submit" | "skip" | "dismiss";
      readonly selectedOptions: readonly string[];
      readonly freeformAnswer: string | null;
    }
  | {
      readonly type: "setup-step";
      readonly requestId: string;
      readonly step: "role";
      readonly action: "submit" | "skip" | "dismiss";
      readonly selectedRoles: readonly string[];
    }
  | {
      readonly type: "setup-step";
      readonly requestId: string;
      readonly step: "task";
      readonly action: "submit" | "skip" | "dismiss";
      readonly answers: Readonly<
        Record<string, { readonly answers: readonly string[] }>
      >;
    }
  | {
      readonly type: "setup-step";
      readonly requestId: string;
      readonly step: "context";
      readonly action: "continue" | "skip" | "dismiss";
      readonly selectedSources: readonly string[];
    }
  | {
      readonly type: "setup-context-picker";
      readonly requestId: string;
      readonly action: "continue" | "dismiss";
      readonly selectedSources: readonly string[];
    }
  | {
      readonly type: "elicitation";
      readonly requestId: string;
      readonly action: "accept" | "decline" | "cancel";
      readonly content?: ReplicaJsonValue;
      readonly _meta?: ReplicaJsonValue;
    };
