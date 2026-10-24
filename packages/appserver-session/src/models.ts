import type {
  AppServerNotification,
  AppServerServerMethod,
  AppServerServerRequestParams,
  AppServerThread,
  AppServerTurn,
} from "@opencraft/appserver-protocol";
import type {
  AutoReviewDecisionSource,
  GuardianApprovalReviewAction,
  GuardianApprovalReviewStatus,
  GuardianRiskLevel,
  GuardianUserAuthorization,
} from "@opencraft/appserver-protocol/generated/v2";

export type ThreadPendingInteraction = {
  [TMethod in AppServerServerMethod]: {
    readonly requestId: string;
    readonly method: TMethod;
    readonly threadId: string;
    readonly turnId: string | null;
    readonly itemId: string | null;
    readonly receivedAtMs: number;
    readonly params: AppServerServerRequestParams<TMethod>;
  }
}[AppServerServerMethod];

export type ThreadResumeState = "needs_resume" | "resuming" | "resumed";
export type ThreadStreamRole =
  | { role: "owner" }
  | { role: "follower"; ownerClientId: string };
export type ThreadHistorySource = "legacy" | "tail" | "paginated" | "durable" | "thread-read-fallback" | "message-window" | "fork";

export interface ThreadItemsPagination {
  olderCursor: string | null;
  hasLoadedOldest: boolean;
}

export interface ThreadTurnsPagination {
  olderCursor: string | null;
  oldestLoadedTurnId: string | null;
  isLoadingOlder: boolean;
  hasLoadedOldest: boolean;
}

export interface ThreadExecutionProjection {
  model: string | null;
  modelProvider: string | null;
  serviceTier: string | null;
  reasoningEffort: unknown;
  cwd: string | null;
  runtimeWorkspaceRoots: readonly string[];
  instructionSources: readonly string[];
  approvalPolicy: unknown;
  approvalsReviewer: unknown;
  sandbox: unknown;
  activePermissionProfile: unknown;
}

/**
 * AppServer emits Guardian reviews beside Thread Items rather than as Items.
 * Keep that transport fact intact until the Chat projection can attach the
 * review to its target command, patch, or MCP call.
 */
export interface ThreadGuardianApprovalReview {
  readonly reviewId: string;
  readonly turnId: string;
  readonly targetItemId: string | null;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly status: GuardianApprovalReviewStatus;
  readonly riskLevel: GuardianRiskLevel | null;
  readonly userAuthorization: GuardianUserAuthorization | null;
  readonly rationale: string | null;
  readonly action: GuardianApprovalReviewAction;
  readonly decisionSource: AutoReviewDecisionSource | null;
}

export interface ThreadView {
  readonly hostId: string;
  readonly threadId: string;
  readonly revision: number;
  readonly connectionGeneration: number;
  readonly resumeState: ThreadResumeState;
  readonly streamRole: ThreadStreamRole | null;
  readonly thread: AppServerThread | null;
  readonly turns: readonly AppServerTurn[];
  readonly historySource: ThreadHistorySource | null;
  readonly historyMode: string;
  readonly historyCheckpoint?: import("@opencraft/appserver-protocol").ThreadHistoryCheckpoint;
  readonly tailHydrationComplete: boolean;
  readonly turnsPagination: ThreadTurnsPagination;
  readonly itemsPaginationByTurnId: Readonly<Record<string, ThreadItemsPagination>>;
  readonly execution: ThreadExecutionProjection;
  readonly notificationRevision: number;
  readonly lastNotification: AppServerNotification | null;
  readonly resumeError: Error | null;
  readonly historyError: Error | null;
  readonly pendingInteractions: readonly ThreadPendingInteraction[];
  readonly guardianApprovalReviews: readonly ThreadGuardianApprovalReview[];
}

export interface ThreadViewStoreSnapshot {
  readonly revision: number;
  readonly threadIds: readonly string[];
}

export function createEmptyThreadView(hostId: string, threadId: string): ThreadView {
  return {
    hostId,
    threadId,
    revision: 0,
    connectionGeneration: 0,
    resumeState: "needs_resume",
    streamRole: null,
    thread: null,
    turns: [],
    historySource: null,
    historyMode: "legacy",
    tailHydrationComplete: false,
    turnsPagination: {
      olderCursor: null,
      oldestLoadedTurnId: null,
      isLoadingOlder: false,
      hasLoadedOldest: false,
    },
    itemsPaginationByTurnId: {},
    execution: {
      model: null,
      modelProvider: null,
      serviceTier: null,
      reasoningEffort: null,
      cwd: null,
      runtimeWorkspaceRoots: [],
      instructionSources: [],
      approvalPolicy: null,
      approvalsReviewer: null,
      sandbox: null,
      activePermissionProfile: null,
    },
    notificationRevision: 0,
    lastNotification: null,
    resumeError: null,
    historyError: null,
    pendingInteractions: [],
    guardianApprovalReviews: [],
  };
}
