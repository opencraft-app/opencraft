import type { ConversationKey, ItemId, TurnId } from "./identity";
import type { HookStats } from "./hook-stats";
import type { WorkStatusItem } from "./work-status";

export type ConversationPhase = "empty" | "painted" | "syncing" | "live" | "offline" | "error";
export type TimelineStatus = "pending" | "streaming" | "complete" | "failed" | "interrupted";
export type TimelineExecutionStatus = "pending" | "running" | "complete" | "failed" | "interrupted";

export interface TimelineAnchor {
  readonly type: "turn" | "item" | "message" | "request" | "call";
  readonly id: string;
}

export interface TimelineBlockBase<TType extends string> {
  readonly type: TType;
  readonly id: string;
  readonly sourceItemIds: readonly ItemId[];
}

export interface TextTimelineBlock extends TimelineBlockBase<"text"> {
  readonly text: string;
  readonly streaming: boolean;
  readonly asyncQuestions?: readonly AsyncQuestion[];
  /** Delivery semantics survive even when structured questions are absent. */
  readonly delivery?: "async" | null;
  readonly completed?: boolean;
  readonly hasStructuredOutput?: boolean;
  readonly sentAtMs?: number | null;
  /** Keep commentary inside Agent Activity and render final_answer separately. */
  readonly phase?: "commentary" | "final_answer" | null;
}

export interface AsyncQuestion {
  readonly id: string;
  readonly title: string;
  readonly options: readonly string[];
}

/** Renderer-neutral copy of the AppServer text-element ABI. */
export interface UserMessageTextElement {
  readonly byteRange: {
    readonly start: number;
    readonly end: number;
  };
  readonly placeholder: string | null;
}

/**
 * AppServer UserInput is retained as a discriminated union instead of being
 * flattened to a string. This is the common Web/Native boundary: hosts resolve
 * local paths, while ChatUI keeps ordering and semantic identity intact.
 */
export type UserMessageContentPart =
  | {
      readonly type: "text";
      readonly text: string;
      readonly textElements: readonly UserMessageTextElement[];
    }
  | {
      readonly type: "image" | "local-image";
      readonly source: string;
      readonly detail: string | null;
    }
  | {
      readonly type: "audio" | "local-audio";
      readonly source: string;
    }
  | {
      readonly type: "skill" | "mention";
      readonly name: string;
      readonly path: string;
    };

/**
 * Attachments that live beside AppServer `UserInput`. They are deliberately
 * separate from `UserMessageContentPart`: render files as a vertical
 * row and context/comment metadata as chips, while preserving `UserInput`
 * ordering for text, images, audio and mentions.
 */
export type UserMessageAttachment =
  | {
      readonly type: "file";
      readonly id: string;
      readonly name: string;
      readonly target: string | null;
      readonly mimeType: string | null;
      readonly startLine: number | null;
      readonly endLine: number | null;
    }
  | {
      readonly type: "comment";
      readonly id: string;
      readonly label: string;
      readonly target: string | null;
      readonly body: string | null;
      readonly line: number | null;
    }
  | {
      readonly type: "mcp-context";
      readonly id: string;
      readonly label: string;
      readonly target: string | null;
      readonly provider: string | null;
    };

export interface UserMessageTimelineBlock extends TimelineBlockBase<"user-message"> {
  /** Text shown by the dedicated UserMessage renderer. */
  readonly message: string;
  /** Ordered AppServer input, including non-text inputs that generic text lost. */
  readonly content: readonly UserMessageContentPart[];
  /** Typed side-channel attachments; renderer code never reinterprets raw payloads. */
  readonly attachments: readonly UserMessageAttachment[];
  readonly messageKind: "user" | "steering" | "hook-prompt";
  readonly clientId: string | null;
  /** Host-authored hidden provenance, independent of message text and Turn owner. */
  readonly sender?: { readonly kind: "employee"; readonly loginName: string } | null;
  readonly steeringStatus: "pending" | "accepted" | "declined" | "cancelled" | null;
  /** Turn start time for the leading message; steering/hook messages may be timeless. */
  readonly sentAtMs: number | null;
  /** Transport/domain state. Null means the host did not provide a state. */
  readonly deliveryStatus: "sending" | "sent" | "not-sent" | "failed" | "unknown" | null;
  readonly referencesPriorConversation: boolean;
  readonly reviewMode: boolean;
  readonly pullRequestFixMode: boolean;
  readonly autoResolveSync: boolean;
  readonly goal: boolean;
  readonly hookFeedback: boolean;
  readonly commentCount: number;
  readonly hasExternalAttachments: boolean;
}

export interface ReasoningTimelineBlock extends TimelineBlockBase<"reasoning"> {
  readonly summary: string;
  readonly detail: string | null;
  readonly streaming: boolean;
}

export interface RealtimeTranscriptEntry {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/**
 * A voice handoff transcript is a first-class timeline Item. It is not an
 * assistant message: it has independent ownership around the outer
 * Activity disclosure so collapsing tool work cannot hide the handoff.
 */
export interface RealtimeTranscriptTimelineBlock extends TimelineBlockBase<"realtime-transcript"> {
  readonly handoffId: string | null;
  readonly entries: readonly RealtimeTranscriptEntry[];
}

export type AutomaticApprovalReviewStatus = "inProgress" | "approved" | "denied" | "timedOut" | "aborted";
export type AutomaticApprovalReviewRiskLevel = "low" | "medium" | "high" | "critical";
export type AutomaticApprovalReviewUserAuthorization = "unknown" | "low" | "medium" | "high";

export type AutomaticApprovalReviewAction =
  | { readonly type: "command"; readonly command: string; readonly cwd: string | null; readonly source: unknown }
  | { readonly type: "execve"; readonly program: string; readonly argv: readonly string[]; readonly cwd: string | null; readonly source: unknown }
  | { readonly type: "applyPatch"; readonly cwd: string | null; readonly files: readonly string[] }
  | { readonly type: "networkAccess"; readonly target: string; readonly host: string; readonly protocol: unknown; readonly port: number | null }
  | { readonly type: "mcpToolCall"; readonly server: string; readonly toolName: string; readonly connectorId: string | null; readonly connectorName: string | null; readonly toolTitle: string | null }
  | { readonly type: "requestPermissions"; readonly reason: string | null; readonly permissions: unknown };

export interface AutomaticApprovalReview {
  readonly id: string;
  readonly targetItemId: string | null;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly status: AutomaticApprovalReviewStatus;
  readonly riskLevel: AutomaticApprovalReviewRiskLevel | null;
  readonly userAuthorization: AutomaticApprovalReviewUserAuthorization | null;
  readonly rationale: string | null;
  readonly action: AutomaticApprovalReviewAction | null;
  readonly decisionSource: "agent" | null;
}

export interface CommandExecutionTimelineBlock extends TimelineBlockBase<"command-execution"> {
  readonly resultMissing?: boolean;
  readonly callId: string | null;
  readonly command: string;
  readonly cwd: string | null;
  /** AppServer PTY identity; retained for background-terminal semantics. */
  readonly processId: string | null;
  /** Item start clock used by the live elapsed label. */
  readonly startedAtMs: number | null;
  /** Whether the owning Turn is still active, independent from the PTY. */
  readonly turnInProgress: boolean;
  readonly output: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly actions: readonly TimelineCommandAction[];
  readonly automaticApprovalReviews: readonly AutomaticApprovalReview[];
  readonly status: TimelineExecutionStatus;
}

export type TimelineCommandAction =
  | {
      readonly type: "read";
      readonly command: string;
      readonly name: string;
      readonly path: string;
    }
  | {
      readonly type: "list-files";
      readonly command: string;
      readonly path: string | null;
    }
  | {
      readonly type: "search";
      readonly command: string;
      readonly query: string | null;
      readonly path: string | null;
    }
  | {
      readonly type: "unknown";
      readonly command: string;
    };

export interface FileChange {
  readonly path: string;
  readonly kind: "add" | "modify" | "delete" | "unknown";
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly unifiedDiff: string | null;
  readonly movePath: string | null;
}

export interface PatchTimelineBlock extends TimelineBlockBase<"patch"> {
  readonly title: string;
  readonly changes: readonly FileChange[];
  readonly automaticApprovalReviews: readonly AutomaticApprovalReview[];
  readonly status: TimelineExecutionStatus;
}

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Aggregated diff for the complete Turn. This is deliberately separate from a
 * fileChange Item: render live patch activity in the Activity group and
 * the Turn aggregate as a trailing resource card.
 */
export interface TurnDiffTimelineBlock extends TimelineBlockBase<"turn-diff"> {
  readonly unifiedDiff: string;
  readonly files: readonly TurnDiffFileSummary[];
  readonly additions: number;
  readonly deletions: number;
  readonly status: TimelineExecutionStatus;
}

export type ToolSurfaceAppIdentity =
  | { readonly kind: "appId"; readonly appId: string }
  | { readonly kind: "displayName"; readonly displayName: string };

export interface WebMcpToolSurfaceCall {
  readonly kind: "listTools" | "invokeTool";
  readonly name: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly readOnlyHint: boolean | null;
  readonly sourceHostname: string | null;
  readonly inputJson: string | null;
  readonly inputTruncated: boolean;
  readonly outputJson: string | null;
  readonly outputTruncated: boolean;
}

export interface ToolCallTimelineBlock extends TimelineBlockBase<"tool-call"> {
  readonly resultMissing?: boolean;
  readonly activityPresentation?: {
    readonly operation: "read" | "search" | "other";
    readonly grouping: "groupable" | "standalone";
    readonly icon: "read" | "search" | "wrench";
    readonly active: string | null;
    readonly completed: string | null;
    /** The source adapter has projected this event into another owned UI. */
    readonly hidden: boolean;
  } | null;
  /** Optional provider-authored tool display information, never execution authority. */
  readonly toolContext?: string | null;
  readonly toolSummary?: string | null;
  readonly progressText?: string | null;
  readonly inlineDiff?: string | null;
  readonly callId: string | null;
  readonly kind: "mcp" | "dynamic" | "web-search" | "image-view";
  readonly name: string;
  readonly server: string | null;
  readonly namespace: string | null;
  readonly input: unknown;
  readonly output: unknown;
  readonly errorMessage: string | null;
  readonly durationMs: number | null;
  readonly readOnlyHint: boolean | null;
  readonly appResourceUri: string | null;
  /** Original MCP envelope, including private UI metadata; never used as model text. */
  readonly appToolResult?: unknown;
  /** AppServer app context; renderer plugins may use it for logos/widgets. */
  readonly appName?: string | null;
  readonly actionName?: string | null;
  readonly pluginId?: string | null;
  /** Generic tool-surface semantics, independent of product widgets. */
  readonly sourceKind?: "browserUse" | "computerUse" | null;
  readonly sourceBackend?: "chrome" | "iab" | "cdp" | null;
  /** Native-app identity is preserved; platform packages may resolve its icon. */
  readonly sourceApp?: ToolSurfaceAppIdentity | null;
  /** Browser page context used by optional favicon/product integrations. */
  readonly sourcePageUrl?: string | null;
  /** Website-provided nested WebMCP calls reported by browser-use. */
  readonly webMcpCalls?: readonly WebMcpToolSurfaceCall[];
  /**
   * Consecutive AppServer `imageView` Items form one visual Activity.
   * Kept on the protocol-neutral block so Web and Native share the same
   * coalescing identity while resolving local image bytes independently.
   */
  readonly imagePaths?: readonly string[];
  readonly automaticApprovalReviews: readonly AutomaticApprovalReview[];
  readonly status: TimelineExecutionStatus;
}

export type AutomationUpdateMode = "view" | "create" | "update" | "delete" | "suggested-create" | "suggested-update";
export type AutomationKind = "cron" | "heartbeat";

/**
 * A successful `automation_update` call is promoted out of Agent Activity.
 * Render it as a trailing Scheduled task resource, never as a generic
 * dynamic-tool row. The original input stays typed as an opaque record so the
 * host can open its own automation editor without coupling ChatUI to it.
 */
export interface AutomationUpdateTimelineBlock extends TimelineBlockBase<"automation-update"> {
  readonly callId: string;
  readonly automationId: string | null;
  readonly mode: AutomationUpdateMode;
  readonly resultMode: "create" | "update" | "delete" | null;
  readonly deleteStatus: string | null;
  readonly kind: AutomationKind | null;
  readonly name: string | null;
  readonly rrule: string | null;
  readonly snapshot: {
    readonly kind: AutomationKind | null;
    readonly name: string | null;
    readonly rrule: string | null;
  } | null;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface AutomaticApprovalReviewTimelineBlock extends TimelineBlockBase<"automatic-approval-review"> {
  readonly review: AutomaticApprovalReview;
}

export interface AutoReviewInterruptionWarningTimelineBlock extends TimelineBlockBase<"auto-review-interruption-warning"> {
  readonly message: "Turn ended by Auto-review";
  readonly detail: "Auto-review stopped this turn after repeated denials. Add more context or choose a different permission mode to continue.";
}

export interface PlanTimelineBlock extends TimelineBlockBase<"plan"> {
  readonly title: string | null;
  readonly text: string;
  readonly completed: boolean;
}

/** An implementation record is a fact, not a second proposal or a success label. */
export interface PlanImplementationTimelineBlock extends TimelineBlockBase<"plan-implementation"> {
  readonly turnId: string | null;
  readonly planContent: string;
  readonly isCompleted: boolean;
}

export interface TodoEntry {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "in-progress" | "complete";
}

export interface TodoTimelineBlock extends TimelineBlockBase<"todo"> {
  readonly entries: readonly TodoEntry[];
  readonly explanation: string | null;
}

export interface SubagentTimelineBlock extends TimelineBlockBase<"subagent"> {
  readonly toolCallStatus: TimelineExecutionStatus;
  readonly deliveryStatus: import("@opencraft/appserver-protocol/collaboration").OrchestrationDeliveryStatus | null;
  readonly childRuntimeStatus: Readonly<Record<string, import("@opencraft/appserver-protocol/collaboration").OrchestrationChildRuntimeStatus>> | null;
  /** Native identity for an independently refreshed control-ledger projection. */
  readonly controlCall: {readonly turnId:string;readonly itemId:string} | null;
  readonly agentId: string | null;
  readonly label: string;
  readonly action: string;
  readonly tool: "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent" | null;
  readonly senderThreadId: string | null;
  readonly receiverThreadIds: readonly string[];
  readonly prompt: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly agentStates: unknown;
  readonly activityKind: "started" | "interacted" | "interrupted" | null;
  readonly agentPath: string | null;
  readonly status: TimelineExecutionStatus;
}

export interface ApprovalTimelineBlock extends TimelineBlockBase<"approval"> {
  readonly requestId: string;
  readonly targetItemId: string | null;
  readonly method: string | null;
  readonly approvalKind: "command" | "file-change" | "permissions" | "generic";
  readonly title: string;
  readonly detail: string | null;
  readonly reason: string | null;
  readonly command: string | null;
  readonly cwd: string | null;
  readonly grantRoot: string | null;
  readonly permissions: unknown;
  readonly networkApprovalContext: {
    readonly host: string;
    readonly protocol: string;
  } | null;
  readonly proposedExecpolicyAmendment: readonly string[];
  readonly proposedNetworkPolicyAmendments: readonly {
    readonly host: string;
    readonly action: string;
  }[];
  readonly additionalPermissions: unknown;
  readonly availableDecisions: readonly string[];
  readonly approvalScopes?: readonly ("once" | "session" | "always" | "deny")[];
  readonly state: "pending" | "accepted" | "declined" | "cancelled";
}

export interface QuestionOption {
  readonly id: string;
  readonly label: string;
  readonly description: string | null;
}

export interface UserInputQuestion {
  readonly multiSelect?: boolean;
  readonly detail?: string;
  readonly intent?: { readonly kind: "plan-review"; readonly approve: string };
  readonly id: string;
  readonly header: string | null;
  readonly prompt: string;
  readonly options: readonly QuestionOption[];
  readonly isOther: boolean;
  readonly isSecret: boolean;
}

export interface QuestionTimelineBlock extends TimelineBlockBase<"question"> {
  readonly requestId: string;
  readonly targetItemId: string | null;
  readonly method: string | null;
  readonly questions: readonly UserInputQuestion[];
  readonly state: "pending" | "answered" | "cancelled";
}

/** Product option picker delivered through request_option_picker. */
export interface OptionPickerTimelineBlock extends TimelineBlockBase<"option-picker"> {
  readonly requestId: string;
  readonly targetItemId: string | null;
  readonly method: "item/tool/call" | "item/tool/requestOptionPicker";
  readonly question: string;
  readonly options: readonly QuestionOption[];
  readonly allowMultiple: boolean;
  readonly submitLabel: string | null;
  readonly skipLabel: string | null;
  readonly state: "pending" | "answered" | "cancelled";
}

/** Product-owned onboarding step requested through setup_codex_step. */
export interface SetupStepTimelineBlock extends TimelineBlockBase<"setup-step"> {
  readonly requestId: string;
  readonly targetItemId: string | null;
  readonly method: "item/tool/call";
  readonly step: "role" | "task" | "context";
  readonly state: "pending" | "answered" | "cancelled";
}

/** Product-owned context-source picker, available as dynamic and compatibility RPCs. */
export interface SetupContextPickerTimelineBlock extends TimelineBlockBase<"setup-context-picker"> {
  readonly requestId: string;
  readonly targetItemId: string | null;
  readonly method: "item/tool/call" | "item/tool/requestSetupCodexContextPicker";
  readonly state: "pending" | "answered" | "cancelled";
}

export interface McpElicitationTimelineBlock extends TimelineBlockBase<"elicitation"> {
  readonly requestId: string;
  readonly targetItemId: string | null;
  readonly method: "mcpServer/elicitation/request";
  readonly serverName: string | null;
  readonly message: string;
  readonly mode: "form" | "openai/form" | "url";
  readonly requestedSchema: unknown;
  readonly url: string | null;
  readonly elicitationId: string | null;
  readonly interactionKind: "form" | "tool-approval" | "tool-suggestion" | "connector-auth" | "url-action";
  readonly riskLevel: "low" | "high" | null;
  readonly subtitle: string | null;
  readonly persist: readonly ("session" | "always")[];
  readonly toolApproval: {
    readonly connectorId: string;
    readonly connectorName: string | null;
    readonly toolName: string | null;
    readonly toolTitle: string | null;
    readonly toolParams: Readonly<Record<string, unknown>>;
    readonly toolParamsDisplay: readonly {
      readonly name: string;
      readonly displayName: string;
      readonly value: unknown;
    }[];
  } | null;
  readonly toolSuggestion: {
    readonly suggestType: "install" | "enable";
    readonly suggestReason: string;
    readonly toolId: string;
    readonly toolName: string;
    readonly toolType: "connector" | "plugin";
    readonly installUrl: string | null;
    readonly remotePluginId: string | null;
    readonly persistAlways: boolean;
  } | null;
  readonly connectorAuth: {
    readonly connectorId: string;
    readonly connectorName: string;
    readonly installUrl: string;
    readonly authReason: string | null;
    readonly linkId: string | null;
    readonly requestedScopes: readonly string[];
  } | null;
  readonly state: "pending" | "accepted" | "declined" | "cancelled";
}

export interface ErrorTimelineBlock extends TimelineBlockBase<"error"> {
  readonly code: string | null;
  readonly message: string;
  readonly recovery: "automatic" | "terminal";
  readonly additionalDetails: string | null;
}

export interface CompactionTimelineBlock extends TimelineBlockBase<"compaction"> {
  readonly summary: string | null;
  readonly completed: boolean;
  readonly source: "manual" | "automatic";
}

export interface ImageTimelineBlock extends TimelineBlockBase<"image"> {
  readonly uri: string | null;
  readonly alt: string | null;
  readonly generated: boolean;
  /** AppServer path retained for host save/open actions; never assumed browser-readable. */
  readonly savedPath: string | null;
  readonly transparentBackground: boolean;
  readonly failure: {
    readonly type: string;
    readonly limitId: string | null;
    readonly resetsAt: number | null;
  } | null;
  readonly status: TimelineExecutionStatus;
}

export interface UnknownTimelineBlock extends TimelineBlockBase<"unknown"> {
  readonly itemType: string;
  readonly payload: unknown;
}

export type TimelineBlock =
  | TextTimelineBlock
  | UserMessageTimelineBlock
  | ReasoningTimelineBlock
  | RealtimeTranscriptTimelineBlock
  | CommandExecutionTimelineBlock
  | PatchTimelineBlock
  | TurnDiffTimelineBlock
  | ToolCallTimelineBlock
  | AutomationUpdateTimelineBlock
  | AutomaticApprovalReviewTimelineBlock
  | AutoReviewInterruptionWarningTimelineBlock
  | PlanTimelineBlock
  | PlanImplementationTimelineBlock
  | TodoTimelineBlock
  | SubagentTimelineBlock
  | ApprovalTimelineBlock
  | QuestionTimelineBlock
  | OptionPickerTimelineBlock
  | SetupStepTimelineBlock
  | SetupContextPickerTimelineBlock
  | McpElicitationTimelineBlock
  | ErrorTimelineBlock
  | CompactionTimelineBlock
  | ImageTimelineBlock
  | UnknownTimelineBlock;

interface TimelineFrameBase<TType extends string> {
  readonly type: TType;
  readonly id: string;
  readonly turnId: TurnId;
  readonly status: TimelineStatus;
  /** AppServer Turn duration: disclosure-label fallback only, not the work clock. */
  readonly durationMs: number | null;
  /** Previously visible aggregate label retained after activity bodies were omitted. */
  readonly displayDurationMs?: number | null;
  readonly workStatus?: WorkStatusItem | null;
  /** Turn-owned resource, never an ordered message or disclosure boundary. */
  readonly changeSummary?: TurnDiffTimelineBlock | null;
  readonly interruptedByThisClient?: boolean;
  /** Turn-scoped hook lifecycle summary rendered in the response action row. */
  readonly hookStats: HookStats | null;
  readonly anchors: readonly TimelineAnchor[];
  readonly blocks: readonly TimelineBlock[];
}

export type UserTimelineFrame = TimelineFrameBase<"user">;
export type AssistantTimelineFrame = TimelineFrameBase<"assistant">;
export type EventTimelineFrame = TimelineFrameBase<"event">;
export type InteractionTimelineFrame = TimelineFrameBase<"interaction">;

export type TimelineFrame =
  | UserTimelineFrame
  | AssistantTimelineFrame
  | EventTimelineFrame
  | InteractionTimelineFrame;

export interface TimelineSnapshot {
  readonly key: ConversationKey;
  readonly revision: number;
  readonly phase: ConversationPhase;
  readonly authoritative: boolean;
  readonly frames: readonly TimelineFrame[];
  readonly anchorFrameIds: ReadonlyMap<string, string>;
}
