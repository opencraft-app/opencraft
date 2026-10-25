import type { TurnRecoveryMethodMap } from "./turn-recovery";
import type { ConversationSchedulesMethodMap } from "./conversation-schedules";
import type { MessageSender } from "./message-sender";
import type { RuntimeMachineReadResponse } from "./machine";
import type { AppServerProcessMethodMap } from "./process";
import type { ThreadPinsMethodMap } from "./thread-pins";
import type { SkillCatalogMethodMap } from "./skill-catalog";
import type { TasksMethodMap } from "./tasks";
import type { AppServerAttachmentMethodMap } from "./attachments";
import type { HostDesktopCredential } from "./desktop";
import type {
  ThreadUnsubscribeParams, ThreadUnsubscribeResponse,
  ThreadGoalGetParams, ThreadGoalGetResponse,
  ThreadGoalSetParams, ThreadGoalSetResponse,
  ThreadGoalClearParams, ThreadGoalClearResponse,
} from "./generated/v2";
import type {
  ThreadResumeHistoryRequest,
  ThreadResumeHistoryResponse,
  AppServerThread,
  AppServerThreadItem,
  AppServerTurn,
  CursorPage,
  ThreadItemPageEntry,
  ThreadItemsListRequest,
  ThreadTurnsListRequest,
} from "./resume-history";
import type {
  ReplicaMutateParams,
  ReplicaMutateResponse,
  ReplicaSyncParams,
  ReplicaSyncResponse,
} from "./replica";
import type {
  ThreadQueueAddParams as GeneratedThreadQueueAddParams,
  ThreadQueueDeleteParams as GeneratedThreadQueueDeleteParams,
  ThreadQueueListParams as GeneratedThreadQueueListParams,
  ThreadQueueReorderParams as GeneratedThreadQueueReorderParams,
  ThreadQueueStartParams as GeneratedThreadQueueStartParams,
  ThreadQueueStartResponse as GeneratedThreadQueueStartResponse,
  ThreadQueueUpdateParams as GeneratedThreadQueueUpdateParams,
  ThreadForkParams as GeneratedThreadForkParams,
  ThreadForkResponse as GeneratedThreadForkResponse,
  ThreadListParams as GeneratedThreadListParams,
  ThreadListResponse as GeneratedThreadListResponse,
  ThreadStartParams as GeneratedThreadStartParams,
  ThreadStartResponse as GeneratedThreadStartResponse,
  ModelListParams as GeneratedModelListParams,
  ModelListResponse as GeneratedModelListResponse,
  PermissionProfileListParams as GeneratedPermissionProfileListParams,
  PermissionProfileListResponse as GeneratedPermissionProfileListResponse,
  SkillsListParams as GeneratedSkillsListParams,
  SkillsListResponse as GeneratedSkillsListResponse,
  ProjectCreateParams as GeneratedProjectCreateParams,
  ProjectCreateResponse as GeneratedProjectCreateResponse,
  ProjectListParams as GeneratedProjectListParams,
  ProjectListResponse as GeneratedProjectListResponse,
  FsReadDirectoryParams as GeneratedFsReadDirectoryParams,
  FsReadDirectoryResponse as GeneratedFsReadDirectoryResponse,
  FsReadFileParams as GeneratedFsReadFileParams,
  FsReadFileResponse as GeneratedFsReadFileResponse,
  FsGetMetadataParams as GeneratedFsGetMetadataParams,
  FsGetMetadataResponse as GeneratedFsGetMetadataResponse,
  FsWatchParams as GeneratedFsWatchParams,
  FsWatchResponse as GeneratedFsWatchResponse,
  FsUnwatchParams as GeneratedFsUnwatchParams,
  FsUnwatchResponse as GeneratedFsUnwatchResponse,
  FsWriteFileParams as GeneratedFsWriteFileParams,
  FsWriteFileResponse as GeneratedFsWriteFileResponse,
  TurnInterruptParams as GeneratedTurnInterruptParams,
  TurnInterruptResponse as GeneratedTurnInterruptResponse,
  TurnStartParams as GeneratedTurnStartParams,
  TurnStartResponse as GeneratedTurnStartResponse,
  TurnSteerParams as GeneratedTurnSteerParams,
  TurnSteerResponse as GeneratedTurnSteerResponse,
  UserInput,
  CommandExecParams as GeneratedCommandExecParams,
  CommandExecResponse as GeneratedCommandExecResponse,
  CommandExecWriteParams as GeneratedCommandExecWriteParams,
  CommandExecWriteResponse as GeneratedCommandExecWriteResponse,
  CommandExecResizeParams as GeneratedCommandExecResizeParams,
  CommandExecResizeResponse as GeneratedCommandExecResizeResponse,
  CommandExecTerminateParams as GeneratedCommandExecTerminateParams,
  CommandExecTerminateResponse as GeneratedCommandExecTerminateResponse,
  ConfigBatchWriteParams,
  ConfigReadParams,
  ConfigReadResponse,
  ConfigWriteResponse,
} from "./generated/v2";
import type {
  FuzzyFileSearchParams,
  FuzzyFileSearchResponse,
  FuzzyFileSearchSessionStartParams,
  FuzzyFileSearchSessionStartResponse,
  FuzzyFileSearchSessionStopParams,
  FuzzyFileSearchSessionStopResponse,
  FuzzyFileSearchSessionUpdateParams,
  FuzzyFileSearchSessionUpdateResponse,
} from "./generated";
import type { AppServerBotMethodMap } from "./bot-conversations";
import type { AppServerCodexAccountMethodMap } from "./codex-accounts";
import type { ProfileSkillsMethodMap } from "./profile-skills";
import type {
  RuntimeCredentialSetParams,
  RuntimeCredentialUnsetParams,
  RuntimeCredentialsDescribeParams,
  RuntimeCredentialsDescribeResponse,
  RuntimeModelsListResponse,
  RuntimeModelsDiscoverParams,
  RuntimeModelsDiscoverResponse,
  RuntimeModelProbeParams,
  RuntimeModelProbeResponse,
  RuntimeProvidersListResponse,
  RuntimeProviderApplyParams,
  RuntimeProviderApplyResponse,
  RuntimeProviderSetEnabledParams,
  RuntimeModelMutationParams,
  RuntimeSettingsDescribeResponse,
  RuntimeSettingsMutateParams,
  RuntimeSettingsNamespaceView,
  RuntimeStatusResponse,
} from "./runtime-settings";

export interface AppServerClientInfo {
  name: string;
  version: string;
  title?: string | null;
}

export interface AppServerInitializeCapabilities {
  experimentalApi?: boolean;
  extensions?: Readonly<Record<string, unknown>> | null;
  mcpServerOpenaiFormElicitation?: boolean;
  optOutNotificationMethods?: readonly string[] | null;
  requestAttestation?: boolean;
}

export interface AppServerInitializeParams {
  clientInfo: AppServerClientInfo;
  capabilities?: AppServerInitializeCapabilities | null;
}

export interface AppServerInitializeResponse {
  codexHome: string;
  platformFamily: string;
  platformOs: string;
  userAgent: string;
  serverInfo?: AppServerClientInfo;
  capabilities?: {
    extensions?: Readonly<Record<string, unknown>> | null;
  } | null;
}

export type ThreadResumeParams = ThreadResumeHistoryRequest & {
  threadId: string;
  /** message-window extension: correlate non-authoritative REST paint with
   * this exact Resume. Other providers need not implement it. */
  historyPreviewToken?: string;
  [field: string]: unknown;
};

export interface ThreadHistoryPreviewParams {
  threadId: string;
  token: string;
  turns: readonly AppServerTurn[];
}

export type ThreadResumeResponse = ThreadResumeHistoryResponse<AppServerTurn> & {
  approvalPolicy: unknown;
  approvalsReviewer: unknown;
  cwd: string;
  instructionSources?: readonly string[];
  model: string;
  modelProvider: string;
  reasoningEffort?: unknown;
  sandbox: unknown;
  serviceTier?: string | null;
  thread: AppServerThread;
  [field: string]: unknown;
};

export interface ThreadReadParams {
  threadId: string;
  includeTurns: boolean;
  /** Passive Host notifications; does not retain a native execution engine. */
  watch?: boolean;
  /** Optional opencraft/read-history v1 page. Never resumes execution. */
  initialTurnsPage?: import("./resume-history").ThreadTurnsPageRequest;
  historyCheckpoint?: import("./resume-history").ThreadHistoryCheckpoint;
}

export interface ThreadReadResponse {
  thread: AppServerThread;
  initialTurnsPage?: ThreadTurnsListResponse;
  historyRecovery?: import("./resume-history").ThreadHistoryRecovery;
}

export type ThreadTurnsListResponse = CursorPage<AppServerTurn> & {
  backwardsCursor?: string | null;
  itemsPaginationByTurnId?: Readonly<Record<string, unknown>>;
};

export type ThreadItemsListResponse = CursorPage<ThreadItemPageEntry | AppServerThreadItem>;

export type ThreadStartParams = GeneratedThreadStartParams & {
  /** Host-owned execution Agent. Omitted means the Host default. */
  agentId?: string | null;
};
export type ThreadStartResponse = GeneratedThreadStartResponse;
export type ModelListParams = GeneratedModelListParams & {
  /**
   * Optional catalog owner. Clients send this only when the Host advertises
   * `opencraft/scoped-model-catalog`; unextended AppServers remain untouched.
   */
  threadId?: string | null;
};
/** OpenCraft can explicitly represent a model without configurable reasoning. */
export type CatalogModel = Omit<GeneratedModelListResponse["data"][number], "defaultReasoningEffort"> & {
  defaultReasoningEffort: GeneratedModelListResponse["data"][number]["defaultReasoningEffort"] | null;
  /** Optional OpenCraft-owned model metadata supplied by the Host. */
  contextWindow?: number;
  maxTokens?: number;
  source?: "builtin" | "custom";
  /** Optional composition-owned display metadata; not execution authorization. */
  groupKey?: string | null;
  groupLabel?: string | null;
  configuredRole?: "primary" | "fallback" | null;
};
export type ModelListResponse = Omit<GeneratedModelListResponse, "data"> & { data: CatalogModel[] };
export type PermissionProfileListParams = GeneratedPermissionProfileListParams;
export type PermissionProfileListResponse = GeneratedPermissionProfileListResponse;
export type SkillsListParams = GeneratedSkillsListParams;
export type SkillsListResponse = GeneratedSkillsListResponse;
export type ProjectCreateParams = GeneratedProjectCreateParams;
export type ProjectCreateResponse = GeneratedProjectCreateResponse;
export type ProjectListParams = GeneratedProjectListParams;
export type ProjectListResponse = GeneratedProjectListResponse;
export type FsReadDirectoryParams = GeneratedFsReadDirectoryParams;
export type FsReadDirectoryResponse = GeneratedFsReadDirectoryResponse;
export type FsReadFileParams = GeneratedFsReadFileParams;
export type FsReadFileResponse = GeneratedFsReadFileResponse;
export type ThreadForkParams = GeneratedThreadForkParams;
export type ThreadForkResponse = GeneratedThreadForkResponse;
export type ThreadListParams = GeneratedThreadListParams;
export type ThreadListResponse = Omit<GeneratedThreadListResponse, "data"> & {
  data: Array<GeneratedThreadListResponse["data"][number] & { pinned?: boolean }>;
};
export type TurnStartParams = GeneratedTurnStartParams;
export type TurnStartResponse = GeneratedTurnStartResponse;
export type TurnSteerParams = GeneratedTurnSteerParams;
export type TurnSteerResponse = GeneratedTurnSteerResponse & {
  /**
   * Extension used by Hosts that preserve a steer racing Turn completion.
   * When omitted, the accepted input is treated as `steered`.
   */
  readonly disposition?: "steered" | "queued";
};
export type TurnInterruptParams = GeneratedTurnInterruptParams;
export type TurnInterruptResponse = GeneratedTurnInterruptResponse;
export type ThreadQueueAddParams = GeneratedThreadQueueAddParams;
export interface QueuedSubmission {
  readonly sender?: MessageSender | null;
  readonly id: string;
  readonly input: readonly UserInput[];
  readonly clientUserMessageId: string;
  readonly createdAt: number;
  readonly pausedReason: string | null;
}
/** Host-accepted user input waiting for the active Turn's next step boundary. */
export interface SteeringSubmission extends QueuedSubmission {
  readonly targetTurnId: string;
}
export interface ThreadQueueAddResponse {
  readonly queuedSubmission: QueuedSubmission;
}
export type ThreadQueueListParams = GeneratedThreadQueueListParams;
export interface ThreadQueueListResponse {
  readonly data: readonly QueuedSubmission[];
  readonly nextCursor: string | null;
  /** Optional Host extension for accepted input awaiting the next step boundary. */
  readonly steering?: readonly SteeringSubmission[];
}
export type ThreadQueueUpdateParams = GeneratedThreadQueueUpdateParams;
export interface ThreadQueueUpdateResponse {
  readonly queuedSubmission: QueuedSubmission;
}
export type ThreadQueueDeleteParams = GeneratedThreadQueueDeleteParams & {
  /** Native extension: CAS target for an unresolved steering claim. */
  readonly expectedTurnId?: string;
  /** Required when abandoning a claim whose delivery outcome is unknown. */
  readonly acknowledgeUnknownDelivery?: boolean;
};
export interface ThreadQueueDeleteResponse {
  readonly deleted: boolean;
}
export type ThreadQueueReorderParams = GeneratedThreadQueueReorderParams;
export type ThreadQueueReorderResponse = Record<string, never>;
export type ThreadQueueStartParams = GeneratedThreadQueueStartParams;
export type ThreadQueueStartResponse = GeneratedThreadQueueStartResponse;
export interface ThreadQueueSteerParams {
  readonly threadId: string;
  readonly queuedSubmissionId: string;
  readonly expectedTurnId: string;
}
export interface ThreadQueueSteerResponse {
  readonly turnId: string;
}
export type FsGetMetadataParams = GeneratedFsGetMetadataParams;
export type FsGetMetadataResponse = GeneratedFsGetMetadataResponse;
export type FsWatchParams = GeneratedFsWatchParams;
export type FsWatchResponse = GeneratedFsWatchResponse;
export type FsUnwatchParams = GeneratedFsUnwatchParams;
export type FsUnwatchResponse = GeneratedFsUnwatchResponse;
export type FsWriteFileParams = GeneratedFsWriteFileParams;
export type FsWriteFileResponse = GeneratedFsWriteFileResponse;
export type CommandExecParams = GeneratedCommandExecParams;
export type CommandExecResponse = GeneratedCommandExecResponse;
export type CommandExecWriteParams = GeneratedCommandExecWriteParams;
export type CommandExecWriteResponse = GeneratedCommandExecWriteResponse;
export type CommandExecResizeParams = GeneratedCommandExecResizeParams;
export type CommandExecResizeResponse = GeneratedCommandExecResizeResponse;
export type CommandExecTerminateParams = GeneratedCommandExecTerminateParams;
export type CommandExecTerminateResponse = GeneratedCommandExecTerminateResponse;

export interface ThreadArchiveParams {
  threadId: string;
}

/**
 * Typed method registry. It is intentionally declaration-mergeable so feature
 * packages can add protocol methods without introducing an untyped index
 * signature into the core client.
 */
import type {
  McpResourceReadParams, McpResourceReadResponse, McpServerToolCallParams,
  McpServerToolCallResponse, ListMcpServerStatusParams, ListMcpServerStatusResponse,
} from "./generated/v2";

export interface AppServerMethodMap extends TurnRecoveryMethodMap, AppServerBotMethodMap, AppServerCodexAccountMethodMap, AppServerProcessMethodMap, AppServerAttachmentMethodMap, ProfileSkillsMethodMap, ThreadPinsMethodMap, TasksMethodMap, ConversationSchedulesMethodMap, SkillCatalogMethodMap {
  "opencraft/token-usage/configure": { params: {enabled:boolean}; result: {enabled:boolean;enabledAt:number;revision:number} };
  "opencraft/token-usage/query": { params: Record<string, unknown>; result: import("./token-usage.js").TokenUsageSnapshot };
  "opencraft/collaboration": { params: Record<string, unknown>; result: Record<string, unknown> };
  "mcpServer/resource/read": { params: McpResourceReadParams; result: McpResourceReadResponse };
  "mcpServer/tool/call": { params: McpServerToolCallParams; result: McpServerToolCallResponse };
  "mcpServerStatus/list": { params: ListMcpServerStatusParams; result: ListMcpServerStatusResponse };
  "thread/goal/get": { params: ThreadGoalGetParams; result: ThreadGoalGetResponse };
  "thread/goal/set": { params: ThreadGoalSetParams; result: ThreadGoalSetResponse };
  "thread/goal/clear": { params: ThreadGoalClearParams; result: ThreadGoalClearResponse };
  "runtime/machine/read": { params: Record<string, never>; result: RuntimeMachineReadResponse };
  "runtime/status/read": {
    params: Record<string, never>;
    result: RuntimeStatusResponse;
  };
  "runtime/settings/describe": {
    params: Record<string, never>;
    result: RuntimeSettingsDescribeResponse;
  };
  "runtime/settings/mutate": {
    params: RuntimeSettingsMutateParams;
    result: RuntimeSettingsNamespaceView;
  };
  "runtime/credentials/describe": {
    params: RuntimeCredentialsDescribeParams;
    result: RuntimeCredentialsDescribeResponse;
  };
  "runtime/credentials/set": {
    params: RuntimeCredentialSetParams;
    result: Record<string, never>;
  };
  "runtime/credentials/unset": {
    params: RuntimeCredentialUnsetParams;
    result: Record<string, never>;
  };
  "runtime/providers/list": {
    params: Record<string, never>;
    result: RuntimeProvidersListResponse;
  };
  "runtime/providers/reapply": {
    params: Record<string, never>;
    result: RuntimeProvidersListResponse["application"] | null;
  };
  "runtime/providers/apply": {
    params: RuntimeProviderApplyParams;
    result: RuntimeProviderApplyResponse;
  };
  "runtime/providers/setEnabled": {
    params: RuntimeProviderSetEnabledParams;
    result: RuntimeProviderApplyResponse;
  };
  "runtime/providers/delete": {
    params: Omit<RuntimeProviderSetEnabledParams, "enabled">;
    result: RuntimeProviderApplyResponse;
  };
  "runtime/models/list": {
    params: { readonly includeDisabled?: boolean };
    result: RuntimeModelsListResponse;
  };
  "runtime/models/setEnabled": {
    params: RuntimeModelMutationParams & { readonly enabled: boolean };
    result: RuntimeProviderApplyResponse;
  };
  "runtime/models/delete": {
    params: RuntimeModelMutationParams;
    result: RuntimeProviderApplyResponse;
  };
  "runtime/models/discover": {
    params: RuntimeModelsDiscoverParams;
    result: RuntimeModelsDiscoverResponse;
  };
  "runtime/models/probe": {
    params: RuntimeModelProbeParams;
    result: RuntimeModelProbeResponse;
  };
  "runtime/models/check": {
    params: import("./runtime-settings").RuntimeSavedModelCheckParams;
    result: import("./runtime-settings").RuntimeModelProbeResponse;
  };
  initialize: {
    params: AppServerInitializeParams;
    result: AppServerInitializeResponse;
  };
  "config/read": {
    params: ConfigReadParams;
    result: ConfigReadResponse;
  };
  "config/batchWrite": {
    params: ConfigBatchWriteParams;
    result: ConfigWriteResponse;
  };
  "thread/resume": {
    params: ThreadResumeParams;
    result: ThreadResumeResponse;
  };
  "thread/read": {
    params: ThreadReadParams;
    result: ThreadReadResponse;
  };
  "thread/list": {
    params: ThreadListParams;
    result: ThreadListResponse;
  };
  "thread/search": {
    params: import("./generated/v2/ThreadSearchParams").ThreadSearchParams;
    result: import("./generated/v2/ThreadSearchResponse").ThreadSearchResponse;
  };
  "thread/searchOccurrences": {
    params: import("./generated/v2/ThreadSearchOccurrencesParams").ThreadSearchOccurrencesParams;
    result: import("./generated/v2/ThreadSearchOccurrencesResponse").ThreadSearchOccurrencesResponse;
  };
  "thread/turns/list": {
    params: ThreadTurnsListRequest;
    result: ThreadTurnsListResponse;
  };
  "thread/items/list": {
    params: ThreadItemsListRequest;
    result: ThreadItemsListResponse;
  };
  "runtime/capabilities/register": {
    params: { threadId: string; dynamicTools: readonly import("./generated/v2/DynamicToolSpec").DynamicToolSpec[] };
    result: { registered: number };
  };
  "runtime/http/request": {
    params: { requestId: string; url: string; method?: string; headers?: Record<string,string>; bodyBase64?: string };
    result: { status: number; statusText: string; headers: Record<string,string>; bodyBase64: string };
  };
  "runtime/http/cancel": { params: { requestId: string }; result: { cancelled: boolean } };
  "opencraft/desktop/attachment/create": { params: { threadId: string }; result: HostDesktopCredential };
  "opencraft/desktop/attachment/release": { params: { attachmentId: string }; result: Record<string, never> };
  "runtime/diagnostics/read": {
    params: Record<string, never>;
    result: { presentation: Record<string, unknown>; executions: Array<Record<string, unknown>> };
  };
  "thread/start": {
    params: ThreadStartParams;
    result: ThreadStartResponse;
  };
  "thread/fork": {
    params: ThreadForkParams;
    result: ThreadForkResponse;
  };
  "thread/unsubscribe": {
    params: ThreadUnsubscribeParams;
    result: ThreadUnsubscribeResponse;
  };
  "thread/inject_items": {
    params: import("./generated/v2").ThreadInjectItemsParams;
    result: import("./generated/v2").ThreadInjectItemsResponse;
  };
  "thread/name/set": {
    params: { threadId: string; name: string };
    result: Record<string, never>;
  };
  "thread/delete": {
    params: import("./generated/v2").ThreadDeleteParams;
    result: import("./generated/v2").ThreadDeleteResponse;
  };
  "turn/start": {
    params: TurnStartParams;
    result: TurnStartResponse;
  };
  "turn/steer": {
    params: TurnSteerParams;
    result: TurnSteerResponse;
  };
  "turn/interrupt": {
    params: TurnInterruptParams;
    result: TurnInterruptResponse;
  };
  "hermes/stop": {
    params: { threadId: string | null; expectedTurnId: string | null };
    result: { killed: number };
  };
  "thread/queue/add": {
    params: ThreadQueueAddParams;
    result: ThreadQueueAddResponse;
  };
  "thread/queue/list": {
    params: ThreadQueueListParams;
    result: ThreadQueueListResponse;
  };
  "thread/queue/update": {
    params: ThreadQueueUpdateParams;
    result: ThreadQueueUpdateResponse;
  };
  "thread/queue/delete": {
    params: ThreadQueueDeleteParams;
    result: ThreadQueueDeleteResponse;
  };
  "thread/queue/reorder": {
    params: ThreadQueueReorderParams;
    result: ThreadQueueReorderResponse;
  };
  "thread/queue/start": {
    params: ThreadQueueStartParams;
    result: ThreadQueueStartResponse;
  };
  "thread/queue/steer": {
    params: ThreadQueueSteerParams;
    result: ThreadQueueSteerResponse;
  };
  "thread/archive": {
    params: ThreadArchiveParams;
    result: Record<string, never>;
  };
  "thread/unarchive": {
    params: ThreadArchiveParams;
    result: import("./generated/v2").ThreadUnarchiveResponse;
  };
  "model/list": {
    params: ModelListParams;
    result: ModelListResponse;
  };
  "permissionProfile/list": {
    params: PermissionProfileListParams;
    result: PermissionProfileListResponse;
  };
  "skills/list": {
    params: SkillsListParams;
    result: SkillsListResponse;
  };
  "project/list": {
    params: ProjectListParams;
    result: ProjectListResponse;
  };
  "project/create": {
    params: ProjectCreateParams;
    result: ProjectCreateResponse;
  };
  "fs/readDirectory": {
    params: FsReadDirectoryParams;
    result: FsReadDirectoryResponse;
  };
  "fs/readFile": {
    params: FsReadFileParams;
    result: FsReadFileResponse;
  };
  "fs/getMetadata": {
    params: FsGetMetadataParams;
    result: FsGetMetadataResponse;
  };
  "fs/watch": {
    params: FsWatchParams;
    result: FsWatchResponse;
  };
  "fs/unwatch": {
    params: FsUnwatchParams;
    result: FsUnwatchResponse;
  };
  "fs/writeFile": {
    params: FsWriteFileParams;
    result: FsWriteFileResponse;
  };
  "command/exec": {
    params: CommandExecParams;
    result: CommandExecResponse;
  };
  "command/exec/write": {
    params: CommandExecWriteParams;
    result: CommandExecWriteResponse;
  };
  "command/exec/resize": {
    params: CommandExecResizeParams;
    result: CommandExecResizeResponse;
  };
  "command/exec/terminate": {
    params: CommandExecTerminateParams;
    result: CommandExecTerminateResponse;
  };
  fuzzyFileSearch: {
    params: FuzzyFileSearchParams;
    result: FuzzyFileSearchResponse;
  };
  "fuzzyFileSearch/sessionStart": {
    params: FuzzyFileSearchSessionStartParams;
    result: FuzzyFileSearchSessionStartResponse;
  };
  "fuzzyFileSearch/sessionUpdate": {
    params: FuzzyFileSearchSessionUpdateParams;
    result: FuzzyFileSearchSessionUpdateResponse;
  };
  "fuzzyFileSearch/sessionStop": {
    params: FuzzyFileSearchSessionStopParams;
    result: FuzzyFileSearchSessionStopResponse;
  };
  "replica/sync": {
    params: ReplicaSyncParams;
    result: ReplicaSyncResponse;
  };
  "replica/mutate": {
    params: ReplicaMutateParams;
    result: ReplicaMutateResponse;
  };
}

export type AppServerMethod = keyof AppServerMethodMap & string;
export type AppServerMethodParams<TMethod extends AppServerMethod> =
  AppServerMethodMap[TMethod]["params"];
export type AppServerMethodResult<TMethod extends AppServerMethod> =
  AppServerMethodMap[TMethod]["result"];

export interface AppServerNotification<TParams = unknown> {
  method: string;
  params: TParams;
}

export interface AppServerServerRequest<TParams = unknown> {
  id: string | number;
  method: string;
  params: TParams;
}
