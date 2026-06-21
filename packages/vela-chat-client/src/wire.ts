export interface VeladClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export interface CursorWindow {
  event_id?: string;
  epoch?: number;
  seq?: number;
  from_seq?: number;
  to_seq?: number;
  latest_event_id?: string;
  next_event_id?: string;
  has_more?: boolean;
  has_newer?: boolean;
  has_older?: boolean;
}

export interface EventCursorWire {
  event_id: string;
  epoch: number;
  seq: number;
}

export interface ConversationWindow {
  first_item_id?: string | null;
  last_item_id?: string | null;
  anchor_item_id?: string | null;
  has_older: boolean;
  has_newer: boolean;
}

export type ConversationItemKindWire =
  | "user_message"
  | "assistant_message"
  | "turn_meta"
  | "agent_work"
  | "status";
export type ConversationItemStatusWire =
  | "pending"
  | "running"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";
export type MessagePartTypeWire = "text" | "image" | "file_reference";

export interface MessagePartWire {
  id: string;
  type: MessagePartTypeWire;
  text?: string;
  data?: Record<string, unknown>;
}

export type ConversationWireItem =
  | UserMessageConversationWireItem
  | AssistantMessageConversationWireItem
  | TurnMetaConversationWireItem
  | AgentWorkConversationWireItem
  | StatusConversationWireItem;

export interface ConversationWireItemBase {
  id: string;
  kind: ConversationItemKindWire;
  turn_id?: string;
  created_at: string;
  updated_at: string;
  revision: number;
  status: ConversationItemStatusWire;
  source_event_ids: string[];
}

export interface UserMessageConversationWireItem extends ConversationWireItemBase {
  kind: "user_message";
  text: string;
  parts?: MessagePartWire[];
}

export interface AssistantMessageConversationWireItem extends ConversationWireItemBase {
  kind: "assistant_message";
  text: string;
  parts?: MessagePartWire[];
}

export interface TurnMetaConversationWireItem extends ConversationWireItemBase {
  kind: "turn_meta";
  turn_id: string;
}

export interface AgentWorkConversationWireItem extends ConversationWireItemBase {
  kind: "agent_work";
  title: string;
  summary?: string;
  detail: AgentWorkDetailWire;
  event_range?: {
    from_event_id?: string;
    to_event_id?: string;
  };
}

export interface StatusConversationWireItem extends ConversationWireItemBase {
  kind: "status";
  text: string;
}

export interface ConversationWireView {
  session_id: string;
  items: ConversationWireItem[];
  cursor: EventCursorWire;
  window: ConversationWindow;
}

export interface VelaStreamEventWire {
  event_id?: string;
  epoch?: number;
  seq?: number;
  session_id?: string;
  type: string;
  created_at?: string;
  payload?: Record<string, unknown>;
  affected_views?: string[];
  views?: string[];
}

export interface StreamReadModelRefreshPlan {
  conversation: boolean;
  requests: boolean;
  diffs: boolean;
  session: boolean;
  backends: boolean;
}

export type ViewWindowDirection = "tail" | "before" | "after" | "around";

export interface ConversationWindowOptions {
  limit?: number;
  direction?: ViewWindowDirection;
  anchorItemId?: string;
}

export type AgentRequestTypeWire =
  | "permission"
  | "question"
  | "tool_call"
  | "tool_confirmation"
  | "custom_input"
  | "other";

export type RequestStatusWire =
  | "pending"
  | "approved"
  | "denied"
  | "answered"
  | "expired"
  | "cancelled";

export interface PendingRequestsOptions {
  status?: RequestStatusWire;
}

export interface AgentRequestWire {
  id: string;
  session_id: string;
  type: AgentRequestTypeWire;
  status: RequestStatusWire;
  title?: string;
  description?: string;
  payload?: Record<string, unknown>;
  backend_ref?: Record<string, unknown>;
  created_at: string;
  resolved_at?: string;
}

export interface PendingRequestsWireView {
  requests: AgentRequestWire[];
  cursor: CursorWindow;
}

export type DiffSummaryStatusWire = "added" | "modified" | "deleted" | "renamed";

export interface DiffSummaryWire {
  file_path: string;
  status: DiffSummaryStatusWire;
  additions?: number;
  deletions?: number;
}

export interface DiffReviewWireView {
  diffs: DiffSummaryWire[];
  cursor: CursorWindow;
}

export type AgentWorkDetailTypeWire =
  | "shell"
  | "read"
  | "edit"
  | "write"
  | "search"
  | "fetch"
  | "browser"
  | "mcp_tool"
  | "dynamic_tool"
  | "sub_agent"
  | "image_generation"
  | "image_view"
  | "plan"
  | "plain_text"
  | "unknown"
  | "tool";
export type AgentWorkFileDetailTypeWire = "read" | "edit" | "write";
export type AgentWorkSearchModeWire = "code" | "web" | "files" | "unknown";
export type AgentWorkGenericDetailTypeWire = Exclude<
  AgentWorkDetailTypeWire,
  "shell" | AgentWorkFileDetailTypeWire | "search" | "fetch"
>;

export type AgentWorkDetailWire =
  | AgentWorkShellDetailWire
  | AgentWorkFileDetailWire
  | AgentWorkSearchDetailWire
  | AgentWorkFetchDetailWire
  | AgentWorkGenericDetailWire;

export interface AgentWorkShellDetailWire {
  type: "shell";
  command?: string;
  cwd?: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  error?: string;
}

export interface AgentWorkFileDetailWire {
  type: AgentWorkFileDetailTypeWire;
  file_path?: string;
  path?: string;
  content?: string;
  old_string?: string;
  new_string?: string;
  unified_diff?: string;
}

export interface AgentWorkSearchDetailWire {
  type: "search";
  query?: string;
  mode?: AgentWorkSearchModeWire;
  content?: string;
  num_files?: number;
  num_matches?: number;
  duration_ms?: number;
  truncated?: boolean;
}

export interface AgentWorkFetchDetailWire {
  type: "fetch";
  url?: string;
  prompt?: string;
  result?: string;
  code?: number;
  code_text?: string;
  bytes?: number;
  duration_ms?: number;
}

export interface AgentWorkGenericDetailWire {
  type: AgentWorkGenericDetailTypeWire;
  [key: string]: unknown;
}

export type BackendKindWire =
  | "codex"
  | "cloudagent"
  | "claude_code"
  | "pi"
  | "opencode"
  | "acp"
  | "qoder";

export type PermissionModeWire = "read_only" | "auto" | "auto_review" | "full_access";

export interface AgentConfigWire {
  model?: string;
  reasoning_effort?: string;
  permission_mode?: PermissionModeWire;
  feature_values?: Record<string, unknown>;
}

export interface AgentConfigPatchWire {
  model?: string;
  reasoning_effort?: string;
  permission_mode?: PermissionModeWire;
  feature_values?: Record<string, unknown>;
}

export interface SessionRuntimeInfoWire {
  provider: BackendKindWire;
  native_session_id?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  permission_mode?: PermissionModeWire | null;
  feature_values?: Record<string, unknown>;
}

export interface SessionOperationWire {
  available: boolean;
  reason?: string | null;
  effective_after?: "current_session" | "next_turn";
}

export interface SessionWire {
  id: string;
  backend: BackendKindWire;
  status: SessionStatusWire;
  working_directory: string;
  title: string;
  created_at: string;
  updated_at: string;
  model?: string | null;
  agent_config?: AgentConfigWire;
  runtime_info?: SessionRuntimeInfoWire;
  operations?: Record<string, SessionOperationWire | undefined>;
  metadata?: Record<string, unknown>;
}

export type SessionStatusWire =
  | "starting"
  | "idle"
  | "running"
  | "waiting_for_input"
  | "canceling"
  | "failed"
  | "closed";

export interface CreateSessionInput {
  workingDirectory: string;
  idempotencyKey?: string;
  backend: BackendKindWire;
  title?: string;
  model?: string;
  agentConfig?: AgentConfigWire;
  metadata?: Record<string, unknown>;
}

export interface CreateSessionWireResponse {
  session: SessionWire;
  cursor: EventCursorWire;
}

export interface CancelSessionInput {
  sessionId: string;
  idempotencyKey?: string;
}

export interface SessionWireResponse {
  session: SessionWire;
  cursor?: CursorWindow;
}

export interface ReasoningEffortOptionWire {
  id: string;
  label: string;
  description?: string;
  is_default?: boolean;
  metadata?: Record<string, unknown>;
}

export interface BackendModelWire {
  id: string;
  label: string;
  description?: string;
  is_default?: boolean;
  reasoning_efforts?: ReasoningEffortOptionWire[];
  metadata?: Record<string, unknown>;
}

export interface PermissionModeOptionWire {
  id: PermissionModeWire;
  label: string;
  description?: string;
  is_default?: boolean;
  metadata?: Record<string, unknown>;
}

export type BackendFeatureWire = BackendToggleFeatureWire | BackendSelectFeatureWire;

export interface BackendFeatureBaseWire {
  id: string;
  label: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface BackendToggleFeatureWire extends BackendFeatureBaseWire {
  type: "toggle";
  default_value: boolean;
}

export interface BackendSelectFeatureWire extends BackendFeatureBaseWire {
  type: "select";
  default_value?: string | null;
  options: ReasoningEffortOptionWire[];
}

export interface BackendCapabilitiesWire {
  streaming: boolean;
  cancel: boolean;
  permission_requests: boolean;
  structured_diff: boolean;
  session_agent_config: boolean;
  [key: string]: unknown;
}

export interface BackendWire {
  kind: BackendKindWire;
  status: BackendStatusWire;
  display_name: string;
  capabilities: BackendCapabilitiesWire;
  models: BackendModelWire[];
  permission_modes: PermissionModeOptionWire[];
  features: BackendFeatureWire[];
  diagnostics?: Record<string, unknown>;
}

export type BackendStatusWire = "available" | "unavailable" | "degraded";

export interface BackendsWireResponse {
  backends: BackendWire[];
}

export interface BackendWireResponse {
  backend: BackendWire;
}

export interface BackendProbeResultWire {
  backend: BackendKindWire;
  status: "available" | "unavailable" | "degraded";
  message?: string;
}

export interface UpdateAgentConfigWireResponse {
  session: SessionWire;
  effective_after: "current_session" | "next_turn";
  cursor: EventCursorWire;
}

export type ClientInputPart =
  | { type: "text"; text: string }
  | { type: "file_ref"; uri: string }
  | { type: "image_ref"; uri: string }
  | { type: "image"; data: string; mime_type: string };

export type ToolConfirmationResultWire = "allow" | "deny";
export type ToolConfirmationScopeWire = "once" | "session" | "project";

export type ClientInputEvent =
  | {
      type: "user.message";
      content: ClientInputPart[];
      options?: Record<string, unknown>;
    }
  | {
      type: "user.tool_confirmation";
      request_id: string;
      result: ToolConfirmationResultWire;
      scope?: ToolConfirmationScopeWire;
      options?: Record<string, unknown>;
    }
  | {
      type: "user.custom_tool_result";
      request_id: string;
      content: ClientInputPart[];
      options?: Record<string, unknown>;
    }
  | {
      type: "user.request_answer";
      request_id: string;
      answer: string;
      options?: Record<string, unknown>;
    };

export interface SendSessionInputEventsInput {
  sessionId: string;
  events: ClientInputEvent[];
  idempotencyKey?: string;
  options?: Record<string, unknown>;
}

export type CommandAckWire =
  | AcceptedCommandAckWire
  | QueuedCommandAckWire
  | RejectedCommandAckWire;

export interface AcceptedCommandAckWire {
  status: "accepted";
  command_id: string;
  session_id: string;
  turn_id?: string;
  cursor: EventCursorWire;
}

export interface QueuedCommandAckWire {
  status: "queued";
  command_id: string;
  session_id: string;
  queued_message_id: string;
  cursor: EventCursorWire;
}

export type CommandRejectionCodeWire =
  | "session_not_found"
  | "session_closed"
  | "permission_blocked"
  | "backend_unavailable"
  | "duplicate_command"
  | (string & {});

export interface RejectedCommandAckWire {
  status: "rejected";
  code: CommandRejectionCodeWire;
  message: string;
  command_id?: string;
  session_id?: string;
  cursor?: EventCursorWire;
}
