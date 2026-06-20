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

export interface TranscriptWindow {
  first_row_id?: string | null;
  last_row_id?: string | null;
  anchor_row_id?: string | null;
  has_older: boolean;
  has_newer: boolean;
}

export interface ActivityWindow {
  first_item_id?: string | null;
  last_item_id?: string | null;
  anchor_item_id?: string | null;
  has_older: boolean;
  has_newer: boolean;
}

export interface TranscriptWireRow {
  id: string;
  kind: "user_message" | "assistant_message" | "working" | "activity_marker" | "error";
  created_at: string;
  updated_at: string;
  revision: number;
  turn_id?: string;
  text?: string;
  parts?: TranscriptWirePart[];
  activity_id?: string;
  label?: string;
  status: TranscriptRowStatusWire;
  source_event_ids: string[];
}

export type TranscriptRowStatusWire = "pending" | "streaming" | "completed" | "failed" | "cancelled";
export type TranscriptPartTypeWire = "markdown" | "text" | "code" | "image" | "file_reference";

export interface TranscriptWirePart {
  id: string;
  type: TranscriptPartTypeWire;
  text?: string;
  data?: Record<string, unknown>;
}

export interface ChatTranscriptWireView {
  session_id: string;
  rows: TranscriptWireRow[];
  cursor: EventCursorWire;
  window: TranscriptWindow;
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
  transcript: boolean;
  activity: boolean;
  requests: boolean;
  diffs: boolean;
  session: boolean;
  backends: boolean;
}

export type ViewWindowDirection = "tail" | "before" | "after" | "around";

export interface TranscriptWindowOptions {
  limit?: number;
  direction?: ViewWindowDirection;
  anchorRowId?: string;
  includeLive?: boolean;
}

export interface ActivityWindowOptions {
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

export type ActivityItemKindWire = "tool" | "command" | "task" | "warning" | "runtime";
export type ActivityItemStatusWire = "pending" | "running" | "completed" | "failed" | "cancelled";
export type ActivityDetailTypeWire =
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
export type ActivityFileDetailTypeWire = "read" | "edit" | "write";
export type ActivitySearchModeWire = "code" | "web" | "files" | "unknown";
export type ActivityGenericDetailTypeWire = Exclude<
  ActivityDetailTypeWire,
  "shell" | ActivityFileDetailTypeWire | "search" | "fetch"
>;

export type ActivityWireDetail =
  | ActivityShellToolDetailWire
  | ActivityFileToolDetailWire
  | ActivitySearchToolDetailWire
  | ActivityFetchToolDetailWire
  | ActivityGenericToolDetailWire;

export interface ActivityShellToolDetailWire {
  type: "shell";
  command?: string;
  cwd?: string;
  output?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  error?: string;
}

export interface ActivityFileToolDetailWire {
  type: ActivityFileDetailTypeWire;
  file_path?: string;
  path?: string;
  content?: string;
  old_string?: string;
  new_string?: string;
  unified_diff?: string;
}

export interface ActivitySearchToolDetailWire {
  type: "search";
  query?: string;
  mode?: ActivitySearchModeWire;
  content?: string;
  num_files?: number;
  num_matches?: number;
  duration_ms?: number;
  truncated?: boolean;
}

export interface ActivityFetchToolDetailWire {
  type: "fetch";
  url?: string;
  prompt?: string;
  result?: string;
  code?: number;
  code_text?: string;
  bytes?: number;
  duration_ms?: number;
}

export interface ActivityGenericToolDetailWire {
  type: ActivityGenericDetailTypeWire;
  [key: string]: unknown;
}

export interface ActivityWireItem {
  id: string;
  kind: ActivityItemKindWire;
  status: ActivityItemStatusWire;
  title: string;
  summary?: string;
  detail?: ActivityWireDetail;
  created_at: string;
  updated_at?: string;
  event_range?: {
    from_event_id?: string;
    to_event_id?: string;
  };
}

export interface ActivityWireView {
  session_id: string;
  items: ActivityWireItem[];
  window: ActivityWindow;
  cursor: EventCursorWire;
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
  | "turn_running"
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

export function commandAckRejectionMessage(ack: CommandAckWire) {
  return ack.status === "rejected" ? ack.message : null;
}

export interface VeladClient {
  createSession: (input: CreateSessionInput) => Promise<CreateSessionWireResponse>;
  getSession: (sessionId: string) => Promise<SessionWireResponse>;
  getBackends: () => Promise<BackendsWireResponse>;
  getBackend: (backend: BackendKindWire) => Promise<BackendWireResponse>;
  probeBackend: (backend: BackendKindWire) => Promise<BackendProbeResultWire>;
  updateAgentConfig: (input: {
    sessionId: string;
    patch: AgentConfigPatchWire;
    idempotencyKey?: string;
  }) => Promise<UpdateAgentConfigWireResponse>;
  transcriptUrl: (sessionId: string, options?: TranscriptWindowOptions) => URL;
  activityUrl: (sessionId: string, options?: ActivityWindowOptions) => URL;
  requestsUrl: (sessionId: string, options?: PendingRequestsOptions) => URL;
  diffsUrl: (sessionId: string) => URL;
  sessionEventStreamUrl: (sessionId: string, afterId?: string | null) => URL;
  getTranscript: (
    sessionId: string,
    options?: TranscriptWindowOptions,
  ) => Promise<ChatTranscriptWireView>;
  getActivity: (sessionId: string, options?: ActivityWindowOptions) => Promise<ActivityWireView>;
  getRequests: (
    sessionId: string,
    options?: PendingRequestsOptions,
  ) => Promise<PendingRequestsWireView>;
  getPendingRequests: (
    sessionId: string,
    options?: PendingRequestsOptions,
  ) => Promise<PendingRequestsWireView>;
  getDiffs: (sessionId: string) => Promise<DiffReviewWireView>;
  cancelSession: (input: CancelSessionInput) => Promise<CommandAckWire>;
  sendSessionInputEvents: (input: SendSessionInputEventsInput) => Promise<CommandAckWire>;
  sendUserMessage: (input: {
    sessionId: string;
    text?: string;
    content?: ClientInputPart[];
    idempotencyKey?: string;
  }) => Promise<CommandAckWire>;
}

export interface VelaEventSourceHandlers {
  onEvent: (event: MessageEvent | Event) => void;
  onOpen?: (event: Event) => void;
  onError?: (event: Event) => void;
}

export interface StreamRefreshScheduler {
  notifyStreamEvent: () => void;
  dispose: () => void;
}

export interface StreamRefreshSchedulerOptions {
  refresh: () => void | Promise<void>;
  minIntervalMs?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}

export const VELA_SESSION_STREAM_EVENT_TYPES = [
  "session.created",
  "session.updated",
  "session.config.updated",
  "session.status.changed",
  "session.closed",
  "user.message.accepted",
  "input.queued",
  "input.rejected",
  "turn.cancel.accepted",
  "request.response.accepted",
  "turn.started",
  "assistant.message.started",
  "assistant.message.delta",
  "assistant.message.completed",
  "assistant.reasoning.delta",
  "assistant.reasoning.completed",
  "tool.started",
  "tool.updated",
  "tool.output.delta",
  "tool.completed",
  "tool.failed",
  "command.started",
  "command.output.delta",
  "command.completed",
  "command.failed",
  "task.started",
  "task.updated",
  "task.completed",
  "request.opened",
  "request.updated",
  "request.resolved",
  "diff.updated",
  "projection.invalidated",
  "warning.raised",
  "error.raised",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "backend.status.changed",
  "usage.updated",
  "sync.reset",
] as const;

export function subscribeVelaEventSource(
  source: EventSource,
  handlers: VelaEventSourceHandlers,
) {
  source.onopen = handlers.onOpen ?? null;
  source.onerror = handlers.onError ?? null;
  source.onmessage = handlers.onEvent;
  for (const eventType of VELA_SESSION_STREAM_EVENT_TYPES) {
    source.addEventListener(eventType, handlers.onEvent);
  }

  return () => {
    source.onopen = null;
    source.onerror = null;
    source.onmessage = null;
    for (const eventType of VELA_SESSION_STREAM_EVENT_TYPES) {
      source.removeEventListener(eventType, handlers.onEvent);
    }
  };
}

export function readVelaStreamEvent(event: MessageEvent | Event): VelaStreamEventWire | null {
  const data = "data" in event ? event.data : undefined;
  if (typeof data !== "string" || data.length === 0) return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed)) return null;
    const eventType =
      typeof parsed.type === "string"
        ? parsed.type
        : event.type && event.type !== "message"
          ? event.type
          : "";
    if (!eventType) return null;
    return {
      event_id: typeof parsed.event_id === "string" ? parsed.event_id : undefined,
      epoch: typeof parsed.epoch === "number" ? parsed.epoch : undefined,
      seq: typeof parsed.seq === "number" ? parsed.seq : undefined,
      session_id: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
      type: eventType,
      created_at: typeof parsed.created_at === "string" ? parsed.created_at : undefined,
      payload: isRecord(parsed.payload) ? parsed.payload : undefined,
      affected_views: Array.isArray(parsed.affected_views)
        ? parsed.affected_views.filter((view): view is string => typeof view === "string")
        : undefined,
      views: Array.isArray(parsed.views)
        ? parsed.views.filter((view): view is string => typeof view === "string")
        : undefined,
    };
  } catch {
    return null;
  }
}

export function isVelaStreamEventForSession(
  sessionId: string | undefined,
  event: VelaStreamEventWire,
) {
  return !isDifferentKnownStreamSession(sessionId, event.session_id);
}

export function isVelaStreamEventFreshForCursor(
  cursor: EventCursorWire | CursorWindow | undefined,
  event: VelaStreamEventWire,
) {
  return cursor ? isStreamEventNewerThanCursor(cursor, event) : true;
}

export function applyTranscriptLiveOverlay(
  transcript: ChatTranscriptWireView,
  event: VelaStreamEventWire,
): ChatTranscriptWireView {
  if (
    isDifferentKnownStreamSession(transcript.session_id, event.session_id)
  ) {
    return transcript;
  }
  if (!isStreamEventNewerThanCursor(transcript.cursor, event)) return transcript;

  if (event.type === "assistant.message.delta") {
    const delta = stringPayload(event, "delta");
    if (!delta) return updateTranscriptCursor(transcript, event);
    return appendAssistantDelta(transcript, event, delta);
  }

  return updateTranscriptCursor(transcript, event);
}

export function needsTranscriptRefreshAfterLiveOverlay(
  transcript: ChatTranscriptWireView,
  event: VelaStreamEventWire,
) {
  if (event.type !== "assistant.message.delta") return false;
  if (isDifferentKnownStreamSession(transcript.session_id, event.session_id)) {
    return false;
  }
  if (!isStreamEventNewerThanCursor(transcript.cursor, event)) return false;
  const delta = stringPayload(event, "delta");
  if (!delta) return false;
  return !hasAssistantOverlayTarget(transcript, event);
}

export function streamReadModelRefreshPlan(
  event: VelaStreamEventWire | null,
): StreamReadModelRefreshPlan {
  if (!event) return emptyRefreshPlan();
  if (event.type === "sync.reset") return resetRefreshPlan(event.views);
  if (event.type === "assistant.message.delta") return emptyRefreshPlan();
  const hintedPlan = affectedViewsRefreshPlan(event.affected_views);
  const typePlan = {
    transcript: transcriptRefreshEvents.has(event.type),
    activity: isActivityRefreshEvent(event.type),
    requests: isRequestRefreshEvent(event.type),
    diffs: event.type === "diff.updated",
    session: sessionRefreshEvents.has(event.type),
    backends: event.type.startsWith("backend."),
  };

  return {
    transcript: typePlan.transcript || hintedPlan.transcript,
    activity: typePlan.activity || hintedPlan.activity,
    requests: typePlan.requests || hintedPlan.requests,
    diffs: typePlan.diffs || hintedPlan.diffs,
    session: typePlan.session || hintedPlan.session,
    backends: typePlan.backends || event.type === "usage.updated" || hintedPlan.backends,
  };
}

export interface SessionEventStreamAfterIdInput {
  transcript?: EventCursorWire | null;
  activity?: EventCursorWire | null;
}

export function selectSessionEventStreamAfterId({
  transcript,
  activity,
}: SessionEventStreamAfterIdInput): string | null {
  const cursors = [transcript, activity].filter(
    (cursor): cursor is EventCursorWire => Boolean(cursor?.event_id),
  );
  if (cursors.length === 0) return null;
  let oldest = cursors[0];
  for (const cursor of cursors.slice(1)) {
    if (compareCursorOrder(cursor, oldest) < 0) {
      oldest = cursor;
    }
  }
  return oldest.event_id;
}

export interface StreamReadModelRefreshCursors {
  transcript?: EventCursorWire | null;
  activity?: EventCursorWire | null;
  requests?: CursorWindow | null;
  diffs?: CursorWindow | null;
}

export function streamReadModelRefreshPlanForCursors(
  event: VelaStreamEventWire | null,
  cursors: StreamReadModelRefreshCursors,
): StreamReadModelRefreshPlan {
  const plan = streamReadModelRefreshPlan(event);
  if (!event || event.type === "sync.reset") return plan;
  return {
    ...plan,
    transcript:
      plan.transcript && isStreamEventFreshForReadModelCursor(cursors.transcript, event),
    activity: plan.activity && isStreamEventFreshForReadModelCursor(cursors.activity, event),
    requests: plan.requests && isStreamEventFreshForReadModelCursor(cursors.requests, event),
    diffs: plan.diffs && isStreamEventFreshForReadModelCursor(cursors.diffs, event),
  };
}

export function createStreamRefreshScheduler({
  refresh,
  minIntervalMs = 120,
  now = () => Date.now(),
  setTimeout = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout = (timer) =>
    globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>),
}: StreamRefreshSchedulerOptions): StreamRefreshScheduler {
  let disposed = false;
  let dirty = false;
  let inFlight = false;
  let timer: unknown | null = null;
  let lastRefreshAt = Number.NEGATIVE_INFINITY;

  const schedule = (delay: number) => {
    if (timer !== null || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      void runRefresh();
    }, Math.max(0, delay));
  };

  const finishRefresh = () => {
    inFlight = false;
    if (!disposed && dirty) {
      const elapsed = now() - lastRefreshAt;
      if (elapsed >= minIntervalMs) {
        runRefresh();
      } else {
        schedule(minIntervalMs - elapsed);
      }
    }
  };

  const runRefresh = () => {
    if (disposed) return;
    if (inFlight) {
      dirty = true;
      return;
    }

    inFlight = true;
    dirty = false;
    lastRefreshAt = now();
    try {
      const result = refresh();
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined).finally(finishRefresh);
      } else {
        finishRefresh();
      }
    } catch {
      finishRefresh();
    }
  };

  return {
    notifyStreamEvent() {
      if (disposed) return;
      dirty = true;
      if (inFlight || timer !== null) return;

      const elapsed = now() - lastRefreshAt;
      if (elapsed >= minIntervalMs) {
        runRefresh();
      } else {
        schedule(minIntervalMs - elapsed);
      }
    },
    dispose() {
      disposed = true;
      dirty = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
  return typeof value === "object" && value !== null && "then" in value;
}

function appendAssistantDelta(
  transcript: ChatTranscriptWireView,
  event: VelaStreamEventWire,
  delta: string,
): ChatTranscriptWireView {
  const { rowId, fallbackIndex } = assistantOverlayTarget(transcript, event);
  const rows = transcript.rows.map((row, index): TranscriptWireRow => {
    if (row.kind !== "assistant_message") return row;
    if (rowId ? row.id !== rowId : index !== fallbackIndex) return row;
    if (event.event_id && row.source_event_ids.includes(event.event_id)) return row;
    return {
      ...row,
      updated_at: event.created_at ?? row.updated_at,
      revision: row.revision + 1,
      status: "streaming",
      text: `${assistantRowText(row)}${delta}`,
      source_event_ids: event.event_id
        ? [...row.source_event_ids, event.event_id]
        : row.source_event_ids,
    };
  });

  const changed = rows.some((row, index) => row !== transcript.rows[index]);
  if (changed) return { ...updateTranscriptCursor(transcript, event), rows };

  return updateTranscriptCursor(transcript, event);
}

function assistantRowText(row: TranscriptWireRow): string {
  return row.text || textFromTranscriptWireParts(row.parts);
}

function textFromTranscriptWireParts(parts: TranscriptWirePart[] | undefined): string {
  return (parts ?? [])
    .filter(isTextualTranscriptWirePart)
    .map((part) => part.text)
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

function isTextualTranscriptWirePart(part: TranscriptWirePart): boolean {
  return part.type === "text" || part.type === "markdown" || part.type === "code";
}

function hasAssistantOverlayTarget(
  transcript: ChatTranscriptWireView,
  event: VelaStreamEventWire,
) {
  const { rowId, fallbackIndex } = assistantOverlayTarget(transcript, event);
  if (rowId) {
    return transcript.rows.some(
      (row) => row.kind === "assistant_message" && row.id === rowId,
    );
  }
  return fallbackIndex >= 0;
}

function assistantOverlayTarget(
  transcript: ChatTranscriptWireView,
  event: VelaStreamEventWire,
) {
  const rowId = messageRowId(event);
  const fallbackIndex = rowId
    ? -1
    : findLastIndex(
        transcript.rows,
        (row) => row.kind === "assistant_message" && row.status === "streaming",
      );
  return { rowId, fallbackIndex };
}

function updateTranscriptCursor(
  transcript: ChatTranscriptWireView,
  event: VelaStreamEventWire,
): ChatTranscriptWireView {
  return {
    ...transcript,
    cursor: {
      ...transcript.cursor,
      ...(event.event_id ? { event_id: event.event_id } : {}),
      epoch: event.epoch ?? transcript.cursor.epoch,
      seq: event.seq ?? transcript.cursor.seq,
    },
  };
}

function isStreamEventNewerThanCursor(
  cursor: EventCursorWire | CursorWindow,
  event: VelaStreamEventWire,
) {
  if (isKnownCursorEvent(cursor, event.event_id)) return false;
  const cursorOrder = eventCursorOrder(cursor);
  const eventOrder = streamEventOrder(event);
  if (!cursorOrder || !eventOrder) return true;
  if (eventOrder.epoch > cursorOrder.epoch) return true;
  if (eventOrder.epoch < cursorOrder.epoch) return false;
  return eventOrder.seq > cursorOrder.seq;
}

function isStreamEventFreshForReadModelCursor(
  cursor: EventCursorWire | CursorWindow | null | undefined,
  event: VelaStreamEventWire,
) {
  return cursor ? isStreamEventNewerThanCursor(cursor, event) : true;
}

function compareCursorOrder(
  left: EventCursorWire | CursorWindow,
  right: EventCursorWire | CursorWindow,
) {
  const leftOrder = eventCursorOrder(left);
  const rightOrder = eventCursorOrder(right);
  if (!leftOrder && !rightOrder) return 0;
  if (!leftOrder) return 1;
  if (!rightOrder) return -1;
  if (leftOrder.epoch !== rightOrder.epoch) return leftOrder.epoch - rightOrder.epoch;
  return leftOrder.seq - rightOrder.seq;
}

function isKnownCursorEvent(
  cursor: EventCursorWire | CursorWindow,
  eventId: string | undefined,
) {
  const latestEventId = "latest_event_id" in cursor ? cursor.latest_event_id : undefined;
  const nextEventId = "next_event_id" in cursor ? cursor.next_event_id : undefined;
  return Boolean(
    eventId &&
      (cursor.event_id === eventId || latestEventId === eventId || nextEventId === eventId),
  );
}

function isDifferentKnownStreamSession(
  transcriptSessionId: string | undefined,
  eventSessionId: string | undefined,
) {
  return Boolean(transcriptSessionId && eventSessionId && transcriptSessionId !== eventSessionId);
}

function eventCursorOrder(cursor: EventCursorWire | CursorWindow) {
  const seq =
    typeof cursor.seq === "number"
      ? cursor.seq
      : "to_seq" in cursor
        ? cursor.to_seq
        : undefined;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return null;
  return {
    epoch:
      typeof cursor.epoch === "number" && Number.isFinite(cursor.epoch)
        ? cursor.epoch
        : 0,
    seq,
  };
}

function streamEventOrder(event: VelaStreamEventWire) {
  if (typeof event.seq !== "number" || !Number.isFinite(event.seq)) return null;
  return {
    epoch:
      typeof event.epoch === "number" && Number.isFinite(event.epoch)
        ? event.epoch
        : 0,
    seq: event.seq,
  };
}

const transcriptRefreshEvents = new Set([
  "user.message.accepted",
  "input.queued",
  "turn.started",
  "assistant.message.started",
  "assistant.message.completed",
  "session.status.changed",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "error.raised",
]);

const sessionRefreshEvents = new Set([
  "session.created",
  "session.updated",
  "session.config.updated",
  "session.status.changed",
  "session.closed",
  "backend.status.changed",
  "user.message.accepted",
  "turn.started",
  "turn.cancel.accepted",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "usage.updated",
]);

function isActivityRefreshEvent(eventType: string) {
  return (
    eventType.startsWith("input.") ||
    eventType.startsWith("tool.") ||
    eventType.startsWith("command.") ||
    eventType.startsWith("task.") ||
    eventType.startsWith("request.") ||
    eventType === "turn.started" ||
    eventType === "turn.completed" ||
    eventType === "turn.cancel.accepted" ||
    eventType === "turn.cancelled" ||
    eventType === "assistant.reasoning.delta" ||
    eventType === "assistant.reasoning.completed" ||
    eventType === "diff.updated" ||
    eventType === "warning.raised" ||
    eventType === "error.raised" ||
    eventType === "turn.failed"
  );
}

function isRequestRefreshEvent(eventType: string) {
  return eventType.startsWith("request.");
}

function emptyRefreshPlan(): StreamReadModelRefreshPlan {
  return {
    transcript: false,
    activity: false,
    requests: false,
    diffs: false,
    session: false,
    backends: false,
  };
}

function resetRefreshPlan(views: string[] | undefined): StreamReadModelRefreshPlan {
  const viewSet = new Set(views?.length ? views : ["workbench"]);
  const workbench = viewSet.has("workbench");
  return {
    transcript: workbench || viewSet.has("transcript"),
    activity:
      workbench ||
      viewSet.has("activity") ||
      viewSet.has("requests") ||
      viewSet.has("diffs"),
    requests: workbench || viewSet.has("requests"),
    diffs: workbench || viewSet.has("diffs"),
    session: workbench || viewSet.has("session") || viewSet.has("sessions"),
    backends: workbench || viewSet.has("backends"),
  };
}

function affectedViewsRefreshPlan(views: string[] | undefined): StreamReadModelRefreshPlan {
  if (!views?.length) return emptyRefreshPlan();
  const viewSet = new Set(views);
  const workbench = viewSet.has("workbench");
  return {
    transcript: workbench || viewSet.has("transcript"),
    activity:
      workbench ||
      viewSet.has("activity") ||
      viewSet.has("requests") ||
      viewSet.has("diffs"),
    requests: workbench || viewSet.has("requests"),
    diffs: workbench || viewSet.has("diffs"),
    session: workbench || viewSet.has("session") || viewSet.has("sessions"),
    backends: workbench || viewSet.has("backends"),
  };
}

function messageRowId(event: VelaStreamEventWire) {
  return stringPayload(event, "message_id");
}

function stringPayload(event: VelaStreamEventWire, field: string) {
  const value = event.payload?.[field];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findLastIndex<T>(values: T[], predicate: (value: T) => boolean) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index] as T)) return index;
  }
  return -1;
}

export function createVeladClient(options: VeladClientOptions): VeladClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const doFetch = options.fetch ?? fetch;

  const postSessionInputEvents = async ({
    sessionId,
    events,
    idempotencyKey,
    options: requestOptions,
  }: SendSessionInputEventsInput) => {
    validateClientInputEvents(events);
    if (requestOptions !== undefined && !isRecord(requestOptions)) {
      throw invalidInputEvent("SendSessionEventsRequest.options must be an object");
    }
    const url = new URL(`sessions/${encodeSessionId(sessionId)}/events`, baseUrl);
    const headerIdempotencyKey = validateOptionalIdempotencyKey(idempotencyKey) ?? createIdempotencyKey();
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": headerIdempotencyKey,
      },
      body: JSON.stringify({
        events,
        ...(requestOptions !== undefined ? { options: requestOptions } : {}),
      }),
    });
    return readCommandAckResponse(response);
  };

  return {
    async createSession(input) {
      validateCreateSessionInput(input);
      const idempotencyKey = validateOptionalIdempotencyKey(input.idempotencyKey) ?? createSessionIdempotencyKey();
      const url = new URL("sessions", baseUrl);
      const body: Record<string, unknown> = {
        backend: input.backend,
        working_directory: input.workingDirectory,
      };
      if (input.title) body.title = input.title;
      if (input.model) body.model = input.model;
      if (input.agentConfig) body.agent_config = input.agentConfig;
      if (input.metadata) body.metadata = input.metadata;

      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      return readCreateSessionResponse(response);
    },
    async getSession(sessionId) {
      const url = new URL(`sessions/${encodeSessionId(sessionId)}`, baseUrl);
      const response = await doFetch(url);
      return readSessionResponse(response);
    },
    async getBackends() {
      const url = new URL("backends", baseUrl);
      const response = await doFetch(url);
      return readBackendsResponse(response);
    },
    async getBackend(backend) {
      const url = new URL(`backends/${encodeBackendKind(backend)}`, baseUrl);
      const response = await doFetch(url);
      return readBackendResponse(response);
    },
    async probeBackend(backend) {
      const url = new URL(`backends/${encodeBackendKind(backend)}/probe`, baseUrl);
      const response = await doFetch(url, { method: "POST" });
      return readBackendProbeResponse(response);
    },
    async updateAgentConfig({ sessionId, patch, idempotencyKey }) {
      validateAgentConfigPatch(patch);
      const headerIdempotencyKey = validateOptionalIdempotencyKey(idempotencyKey) ?? createConfigIdempotencyKey();
      const url = new URL(`sessions/${encodeSessionId(sessionId)}/agent-config`, baseUrl);
      const response = await doFetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": headerIdempotencyKey,
        },
        body: JSON.stringify(patch),
      });
      return readUpdateAgentConfigResponse(response);
    },
    transcriptUrl(sessionId, options) {
      validateTranscriptWindowOptions(options);
      const url = new URL(`sessions/${encodeSessionId(sessionId)}/views/transcript`, baseUrl);
      if (options?.limit !== undefined) url.searchParams.set("limit", String(options.limit));
      if (options?.direction) url.searchParams.set("direction", options.direction);
      if (options?.anchorRowId) url.searchParams.set("anchor_row_id", options.anchorRowId);
      if (options?.includeLive !== undefined) {
        url.searchParams.set("include_live", String(options.includeLive));
      }
      return url;
    },
    activityUrl(sessionId, options) {
      validateActivityWindowOptions(options);
      const url = new URL(`sessions/${encodeSessionId(sessionId)}/views/activity`, baseUrl);
      if (options?.limit !== undefined) url.searchParams.set("limit", String(options.limit));
      if (options?.direction) url.searchParams.set("direction", options.direction);
      if (options?.anchorItemId) url.searchParams.set("anchor_item_id", options.anchorItemId);
      return url;
    },
    requestsUrl(sessionId, options) {
      validatePendingRequestsOptions(options);
      const url = new URL(`sessions/${encodeSessionId(sessionId)}/views/requests`, baseUrl);
      if (options?.status) url.searchParams.set("status", options.status);
      return url;
    },
    diffsUrl(sessionId) {
      return new URL(`sessions/${encodeSessionId(sessionId)}/views/diffs`, baseUrl);
    },
    sessionEventStreamUrl(sessionId, afterId) {
      const url = new URL(`sessions/${encodeSessionId(sessionId)}/events/stream`, baseUrl);
      const validAfterId = validateAfterId(afterId);
      if (validAfterId) url.searchParams.set("after_id", validAfterId);
      return url;
    },
    async getTranscript(sessionId, options) {
      const response = await doFetch(this.transcriptUrl(sessionId, options));
      return readTranscriptViewResponse(response);
    },
    async getActivity(sessionId, options) {
      const response = await doFetch(this.activityUrl(sessionId, options));
      return readActivityViewResponse(response);
    },
    async getRequests(sessionId, options) {
      const response = await doFetch(this.requestsUrl(sessionId, options));
      return readPendingRequestsViewResponse(response);
    },
    async getPendingRequests(sessionId, options) {
      return this.getRequests(sessionId, options);
    },
    async getDiffs(sessionId) {
      const response = await doFetch(this.diffsUrl(sessionId));
      return readDiffReviewViewResponse(response);
    },
    async cancelSession({ sessionId, idempotencyKey }) {
      const url = new URL(`sessions/${encodeSessionId(sessionId)}/cancel`, baseUrl);
      const headerIdempotencyKey = validateOptionalIdempotencyKey(idempotencyKey) ?? createIdempotencyKey();
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "Idempotency-Key": headerIdempotencyKey,
        },
      });
      return readCommandAckResponse(response);
    },
    async sendSessionInputEvents(input) {
      return postSessionInputEvents(input);
    },
    async sendUserMessage({ sessionId, text, content, idempotencyKey }) {
      const messageContent = content ?? (text ? [{ type: "text", text } as const] : []);
      return postSessionInputEvents({
        sessionId,
        idempotencyKey,
        events: [
          {
            type: "user.message",
            content: messageContent,
          },
        ],
      });
    },
  };
}

function validateOptionalIdempotencyKey(idempotencyKey: unknown) {
  if (idempotencyKey === undefined) return undefined;
  if (typeof idempotencyKey !== "string") {
    throw invalidIdempotencyKey("Idempotency-Key must be a string");
  }
  return idempotencyKey;
}

function encodeSessionId(sessionId: unknown) {
  if (typeof sessionId !== "string") {
    throw invalidSessionId("session_id must be a string");
  }
  return encodeURIComponent(sessionId);
}

function validateAfterId(afterId: string | null | undefined) {
  if (afterId === undefined || afterId === null) return undefined;
  if (typeof afterId !== "string") {
    throw invalidAfterId("after_id must be a string");
  }
  return afterId;
}

function encodeBackendKind(backend: unknown) {
  if (typeof backend !== "string" || !backendKinds.has(backend)) {
    throw invalidBackendKind("backend must be a known BackendKind");
  }
  return encodeURIComponent(backend);
}

const backendKinds = new Set<string>(
  [
    "codex",
    "cloudagent",
    "claude_code",
    "pi",
    "opencode",
    "acp",
    "qoder",
  ] satisfies BackendKindWire[],
);

function validateCreateSessionInput(input: unknown): asserts input is CreateSessionInput {
  if (!isRecord(input)) {
    throw invalidCreateSessionRequest("CreateSessionRequest must be an object");
  }

  const workingDirectory = input.workingDirectory;
  if (typeof workingDirectory !== "string") {
    throw invalidCreateSessionRequest("CreateSessionRequest requires working_directory");
  }

  const backend = input.backend;
  if (typeof backend !== "string" || !backendKinds.has(backend)) {
    throw invalidCreateSessionRequest("CreateSessionRequest backend must be a known BackendKind");
  }

  validateOptionalCreateSessionString(input, "title");
  validateOptionalCreateSessionString(input, "model");

  if (input.metadata !== undefined && !isRecord(input.metadata)) {
    throw invalidCreateSessionRequest("CreateSessionRequest metadata must be an object");
  }

  if (input.agentConfig !== undefined) {
    validateAgentConfigShape(input.agentConfig, invalidCreateSessionRequest, "CreateSessionRequest.agent_config");
  }
}

function validateOptionalCreateSessionString(input: Record<string, unknown>, field: string) {
  if (input[field] !== undefined && typeof input[field] !== "string") {
    throw invalidCreateSessionRequest(`CreateSessionRequest ${field} must be a string`);
  }
}

const agentConfigPatchKeys = new Set([
  "model",
  "reasoning_effort",
  "permission_mode",
  "feature_values",
]);

const permissionModes = new Set(["read_only", "auto", "auto_review", "full_access"]);
const viewWindowDirections = new Set(["tail", "before", "after", "around"]);
const backendStatuses = new Set(["available", "unavailable", "degraded"]);
const sessionStatuses = new Set<string>(
  [
    "starting",
    "idle",
    "running",
    "waiting_for_input",
    "canceling",
    "failed",
    "closed",
  ] satisfies SessionStatusWire[],
);
const transcriptRowKinds = new Set([
  "user_message",
  "assistant_message",
  "working",
  "activity_marker",
  "error",
]);
const transcriptRowStatuses = new Set<string>(
  ["pending", "streaming", "completed", "failed", "cancelled"] satisfies TranscriptRowStatusWire[],
);
const transcriptPartTypes = new Set<string>(
  ["markdown", "text", "code", "image", "file_reference"] satisfies TranscriptPartTypeWire[],
);
const activityItemKinds = new Set<string>(
  ["tool", "command", "task", "warning", "runtime"] satisfies ActivityItemKindWire[],
);
const activityItemStatuses = new Set<string>(
  ["pending", "running", "completed", "failed", "cancelled"] satisfies ActivityItemStatusWire[],
);
const requestTypes = new Set<string>(
  [
    "permission",
    "question",
    "tool_call",
    "tool_confirmation",
    "custom_input",
    "other",
  ] satisfies AgentRequestTypeWire[],
);
const requestStatuses = new Set<string>(
  [
    "pending",
    "approved",
    "denied",
    "answered",
    "expired",
    "cancelled",
  ] satisfies RequestStatusWire[],
);
const diffSummaryStatuses = new Set(["added", "modified", "deleted", "renamed"]);
const activitySearchModes = new Set<ActivitySearchModeWire>(
  ["code", "web", "files", "unknown"] satisfies ActivitySearchModeWire[],
);
const activityDetailTypes = new Set<string>(
  [
    "shell",
    "read",
    "edit",
    "write",
    "search",
    "fetch",
    "browser",
    "mcp_tool",
    "dynamic_tool",
    "sub_agent",
    "image_generation",
    "image_view",
    "plan",
    "plain_text",
    "unknown",
    "tool",
  ] satisfies ActivityDetailTypeWire[],
);
const backendCapabilityFields = [
  "streaming",
  "cancel",
  "permission_requests",
  "structured_diff",
  "session_agent_config",
];

function validateAgentConfigPatch(patch: unknown): asserts patch is AgentConfigPatchWire {
  if (!isRecord(patch)) {
    throw invalidAgentConfigPatch("AgentConfig patch must be an object");
  }

  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw invalidAgentConfigPatch("AgentConfig patch requires at least one field");
  }

  validateAgentConfigShape(patch, invalidAgentConfigPatch, "AgentConfig patch");
}

function validateAgentConfigShape(
  config: unknown,
  invalid: ViewContractErrorFactory,
  owner: string,
): asserts config is AgentConfigWire {
  if (!isRecord(config)) {
    throw invalid(`${owner} must be an object`);
  }

  const keys = Object.keys(config);
  for (const key of keys) {
    if (!agentConfigPatchKeys.has(key)) {
      throw invalid(`${owner} does not support ${key}`);
    }
    if (config[key] === undefined) {
      throw invalid(`${owner} ${key} must not be undefined`);
    }
    validateAgentConfigValue(key, config[key], invalid, owner);
  }
}

function validateAgentConfigValue(
  key: string,
  value: unknown,
  invalid: ViewContractErrorFactory,
  owner: string,
) {
  switch (key) {
    case "model":
    case "reasoning_effort":
      if (typeof value !== "string") {
        throw invalid(`${owner} ${key} must be a string`);
      }
      return;
    case "permission_mode":
      if (typeof value !== "string" || !permissionModes.has(value)) {
        throw invalid(
          `${owner} permission_mode must be read_only, auto, auto_review, or full_access`,
        );
      }
      return;
    case "feature_values":
      if (!isRecord(value)) {
        throw invalid(`${owner} feature_values must be an object`);
      }
      return;
  }
}

function parseSessionRuntimeInfoWire(
  runtimeInfo: unknown,
  invalid: ViewContractErrorFactory,
  owner: string,
): SessionRuntimeInfoWire {
  if (!isRecord(runtimeInfo)) {
    throw invalid(`${owner} must be an object`);
  }

  const provider = runtimeInfo.provider;
  if (typeof provider !== "string" || !backendKinds.has(provider)) {
    throw invalid(`${owner}.provider must be a known BackendKind`);
  }

  validateOptionalNullableSessionString(runtimeInfo, "native_session_id", invalid, owner);
  validateOptionalNullableSessionString(runtimeInfo, "model", invalid, owner);
  validateOptionalNullableSessionString(runtimeInfo, "reasoning_effort", invalid, owner);

  const permissionMode = runtimeInfo.permission_mode;
  if (
    permissionMode !== undefined &&
    permissionMode !== null &&
    (typeof permissionMode !== "string" || !permissionModes.has(permissionMode))
  ) {
    throw invalid(
      `${owner}.permission_mode must be read_only, auto, auto_review, or full_access`,
    );
  }

  const featureValues = runtimeInfo.feature_values;
  if (featureValues !== undefined && !isRecord(featureValues)) {
    throw invalid(`${owner}.feature_values must be an object`);
  }

  return {
    ...(runtimeInfo as unknown as SessionRuntimeInfoWire),
    provider: provider as BackendKindWire,
  };
}

function validateOptionalNullableSessionString(
  data: Record<string, unknown>,
  field: string,
  invalid: ViewContractErrorFactory,
  owner: string,
) {
  const value = data[field];
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw invalid(`${owner}.${field} must be a string or null`);
  }
}

function validateSessionOperationsShape(
  operations: unknown,
  invalid: ViewContractErrorFactory,
  owner: string,
): asserts operations is Record<string, SessionOperationWire | undefined> {
  if (!isRecord(operations)) {
    throw invalid(`${owner} must be an object`);
  }

  for (const [key, operation] of Object.entries(operations)) {
    const operationOwner = `${owner}.${key}`;
    if (!isRecord(operation)) {
      throw invalid(`${operationOwner} must be an object`);
    }
    if (typeof operation.available !== "boolean") {
      throw invalid(`${operationOwner}.available must be a boolean`);
    }
    if (
      operation.reason !== undefined &&
      operation.reason !== null &&
      typeof operation.reason !== "string"
    ) {
      throw invalid(`${operationOwner}.reason must be a string or null`);
    }
    if (
      operation.effective_after !== undefined &&
      operation.effective_after !== "current_session" &&
      operation.effective_after !== "next_turn"
    ) {
      throw invalid(`${operationOwner}.effective_after must be current_session or next_turn`);
    }
  }
}

function validateClientInputParts(parts: readonly ClientInputPart[]) {
  if (!Array.isArray(parts)) {
    throw invalidInputPart("InputPart content must be an array");
  }
  for (const part of parts) {
    validateClientInputPart(part);
  }
}

function validateClientInputEvents(events: readonly ClientInputEvent[]) {
  if (!Array.isArray(events) || events.length === 0) {
    throw invalidInputEvent("SendSessionEventsRequest.events requires at least one event");
  }
  for (const event of events) {
    validateClientInputEvent(event);
  }
}

function validateClientInputEvent(event: unknown): asserts event is ClientInputEvent {
  if (!isRecord(event)) {
    throw invalidInputEvent("ClientInputEvent must be an object");
  }
  validateOptionalInputEventOptions(event);
  switch (event.type) {
    case "user.message":
      validateClientInputParts(event.content as ClientInputPart[]);
      return;
    case "user.tool_confirmation":
      requireInputEventString(event, "request_id");
      requireInputEventEnum(event, "result", toolConfirmationResults);
      if (event.scope !== undefined) {
        requireInputEventEnum(event, "scope", toolConfirmationScopes);
      }
      return;
    case "user.custom_tool_result":
      requireInputEventString(event, "request_id");
      validateClientInputParts(event.content as ClientInputPart[]);
      return;
    case "user.request_answer":
      requireInputEventString(event, "request_id");
      requireInputEventString(event, "answer");
      return;
    default:
      throw invalidInputEvent(
        "ClientInputEvent.type must be user.message, user.tool_confirmation, user.custom_tool_result, or user.request_answer",
      );
  }
}

function validateClientInputPart(part: unknown): asserts part is ClientInputPart {
  if (!isRecord(part)) {
    throw invalidInputPart("InputPart must be an object");
  }
  switch (part.type) {
    case "text":
      requireInputPartString(part, "text");
      return;
    case "file_ref":
    case "image_ref":
      requireInputPartString(part, "uri");
      return;
    case "image":
      requireInputPartString(part, "data");
      requireInputPartString(part, "mime_type");
      return;
    default:
      throw invalidInputPart("InputPart.type must be text, file_ref, image_ref, or image");
  }
}

const toolConfirmationResults = new Set(["allow", "deny"]);
const toolConfirmationScopes = new Set(["once", "session", "project"]);

function requireInputEventString(event: Record<string, unknown>, field: string) {
  if (typeof event[field] !== "string") {
    throw invalidInputEvent(`ClientInputEvent.${String(event.type)} requires ${field}`);
  }
}

function requireInputEventEnum(
  event: Record<string, unknown>,
  field: string,
  values: Set<string>,
) {
  const value = event[field];
  if (typeof value !== "string" || !values.has(value)) {
    throw invalidInputEvent(`ClientInputEvent.${String(event.type)} ${field} must be a known value`);
  }
}

function validateOptionalInputEventOptions(event: Record<string, unknown>) {
  if (event.options !== undefined && !isRecord(event.options)) {
    throw invalidInputEvent(`ClientInputEvent.${String(event.type)} options must be an object`);
  }
}

function requireInputPartString(part: Record<string, unknown>, field: string) {
  if (typeof part[field] !== "string") {
    throw invalidInputPart(`InputPart.${String(part.type)} requires ${field}`);
  }
}

function validateTranscriptWindowOptions(options: TranscriptWindowOptions | undefined) {
  const unsupportedKey = firstUnsupportedTranscriptWindowOption(options);
  if (unsupportedKey) {
    throw new VeladClientError(
      "invalid_transcript_window_options",
      `unsupported transcript window option: ${unsupportedKey}`,
    );
  }
  validateViewWindowLimit(options?.limit, "invalid_transcript_window_options");
  validateViewWindowDirection(options?.direction, "invalid_transcript_window_options");
  validateOptionalViewWindowString(
    options?.anchorRowId,
    "anchorRowId",
    "invalid_transcript_window_options",
  );
  validateOptionalViewWindowBoolean(
    options?.includeLive,
    "includeLive",
    "invalid_transcript_window_options",
  );
  if (options?.direction) {
    if (options.direction === "tail") {
      if (options.anchorRowId) {
        throw new VeladClientError(
          "invalid_transcript_window_options",
          "direction=tail cannot include anchorRowId",
        );
      }
    } else if (!options.anchorRowId) {
      throw new VeladClientError(
        "invalid_transcript_window_options",
        `anchorRowId is required when direction=${options.direction}`,
      );
    }
    return;
  }
  if (options?.anchorRowId) {
    throw new VeladClientError(
      "invalid_transcript_window_options",
      "anchorRowId requires direction",
    );
  }
}

function validateActivityWindowOptions(options: ActivityWindowOptions | undefined) {
  validateViewWindowLimit(options?.limit, "invalid_activity_window_options");
  validateViewWindowDirection(options?.direction, "invalid_activity_window_options");
  validateOptionalViewWindowString(
    options?.anchorItemId,
    "anchorItemId",
    "invalid_activity_window_options",
  );
  if (!options?.direction) {
    if (options?.anchorItemId) {
      throw new VeladClientError(
        "invalid_activity_window_options",
        "anchorItemId requires direction",
      );
    }
    return;
  }
  if (options.direction === "tail") {
    if (options.anchorItemId) {
      throw new VeladClientError(
        "invalid_activity_window_options",
        "direction=tail cannot include anchorItemId",
      );
    }
    return;
  }
  if (!options.anchorItemId) {
    throw new VeladClientError(
      "invalid_activity_window_options",
      `anchorItemId is required when direction=${options.direction}`,
    );
  }
}

function validatePendingRequestsOptions(options: PendingRequestsOptions | undefined) {
  if (options?.status !== undefined && !requestStatuses.has(options.status)) {
    throw new VeladClientError(
      "invalid_pending_requests_options",
      "PendingRequestsView status must be pending, approved, denied, answered, expired, or cancelled",
    );
  }
}

function validateViewWindowDirection(direction: string | undefined, code: string) {
  if (direction === undefined) return;
  if (typeof direction !== "string" || !viewWindowDirections.has(direction)) {
    throw new VeladClientError(code, "direction must be tail, before, after, or around");
  }
}

function validateOptionalViewWindowString(value: string | undefined, field: string, code: string) {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new VeladClientError(code, `${field} must be a string`);
  }
}

function validateOptionalViewWindowBoolean(
  value: boolean | undefined,
  field: string,
  code: string,
) {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw new VeladClientError(code, `${field} must be a boolean`);
  }
}

function validateViewWindowLimit(limit: number | undefined, code: string) {
  if (limit === undefined) return;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new VeladClientError(code, "limit must be an integer between 1 and 500");
  }
}

const transcriptWindowOptionKeys = new Set([
  "limit",
  "direction",
  "anchorRowId",
  "includeLive",
]);

function firstUnsupportedTranscriptWindowOption(options: TranscriptWindowOptions | undefined) {
  if (!options) return false;
  return Object.keys(options).find((key) => !transcriptWindowOptionKeys.has(key));
}

function normalizeBaseUrl(baseUrl: string) {
  const withSlash = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(withSlash)) {
    return withSlash;
  }

  const origin =
    typeof window !== "undefined" && typeof window.location?.origin === "string"
      ? window.location.origin
      : "http://localhost";
  return new URL(withSlash, origin).toString();
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      typeof data?.error?.message === "string"
        ? data.error.message
        : `velad request failed with ${response.status}`;
    throw new VeladClientError("velad_request_failed", message, data);
  }
  return data as T;
}

async function readCreateSessionResponse(response: Response): Promise<CreateSessionWireResponse> {
  return parseCreateSessionWireResponse(await readJsonResponse<unknown>(response));
}

export function parseCreateSessionWireResponse(data: unknown): CreateSessionWireResponse {
  if (!isRecord(data)) {
    throw invalidCreateSessionResponse("CreateSessionResponse must be an object");
  }
  return {
    session: requiredSessionObject(data, "CreateSessionResponse", invalidCreateSessionResponse),
    cursor: requiredViewEventCursor(data, "cursor", "CreateSessionResponse", invalidCreateSessionResponse),
  };
}

async function readUpdateAgentConfigResponse(
  response: Response,
): Promise<UpdateAgentConfigWireResponse> {
  return parseUpdateAgentConfigWireResponse(await readJsonResponse<unknown>(response));
}

export function parseUpdateAgentConfigWireResponse(
  data: unknown,
): UpdateAgentConfigWireResponse {
  if (!isRecord(data)) {
    throw invalidUpdateAgentConfigResponse("UpdateAgentConfigResponse must be an object");
  }
  return {
    session: requiredSessionObject(
      data,
      "UpdateAgentConfigResponse",
      invalidUpdateAgentConfigResponse,
    ),
    effective_after: requiredEffectiveAfter(data),
    cursor: requiredViewEventCursor(
      data,
      "cursor",
      "UpdateAgentConfigResponse",
      invalidUpdateAgentConfigResponse,
    ),
  };
}

async function readSessionResponse(response: Response): Promise<SessionWireResponse> {
  return parseSessionWireResponse(await readJsonResponse<unknown>(response));
}

export function parseSessionWireResponse(data: unknown): SessionWireResponse {
  if (!isRecord(data)) {
    throw invalidSessionResponse("SessionResponse must be an object");
  }
  return {
    session: requiredSessionObject(data, "SessionResponse", invalidSessionResponse),
  };
}

async function readBackendsResponse(response: Response): Promise<BackendsWireResponse> {
  return parseBackendsWireResponse(await readJsonResponse<unknown>(response));
}

export function parseBackendsWireResponse(data: unknown): BackendsWireResponse {
  if (!isRecord(data)) {
    throw invalidBackendsResponse("BackendsResponse must be an object");
  }
  const backends = requiredViewArray(
    data,
    "backends",
    "BackendsResponse",
    invalidBackendsResponse,
  );
  return {
    backends: backends.map((backend, index) =>
      parseBackendWire(backend, `BackendsResponse.backends[${index}]`),
    ),
  };
}

async function readBackendResponse(response: Response): Promise<BackendWireResponse> {
  return parseBackendWireResponse(await readJsonResponse<unknown>(response));
}

export function parseBackendWireResponse(data: unknown): BackendWireResponse {
  if (!isRecord(data)) {
    throw invalidBackendsResponse("BackendResponse must be an object");
  }
  const backend = data.backend;
  if (!isRecord(backend)) {
    throw invalidBackendsResponse("BackendResponse requires backend");
  }
  return {
    backend: parseBackendWire(backend, "BackendResponse.backend"),
  };
}

function parseBackendWire(data: unknown, owner: string): BackendWire {
  if (!isRecord(data)) {
    throw invalidBackendsResponse(`${owner} must be an object`);
  }
  const kind = requiredViewString(data, "kind", owner, invalidBackendsResponse);
  if (!backendKinds.has(kind)) {
    throw invalidBackendsResponse(`${owner}.kind must be a known BackendKind`);
  }
  const status = requiredViewString(data, "status", owner, invalidBackendsResponse);
  if (!backendStatuses.has(status)) {
    throw invalidBackendsResponse(`${owner}.status must be available, unavailable, or degraded`);
  }
  return {
    kind: kind as BackendKindWire,
    status: status as BackendStatusWire,
    display_name: requiredViewString(data, "display_name", owner, invalidBackendsResponse),
    capabilities: requiredBackendCapabilities(data, owner),
    models: optionalBackendArray(data, "models", owner).map((model, index) =>
      parseBackendModelWire(model, `${owner}.models[${index}]`),
    ),
    permission_modes: optionalBackendArray(data, "permission_modes", owner).map((mode, index) =>
      parsePermissionModeOptionWire(mode, `${owner}.permission_modes[${index}]`),
    ),
    features: optionalBackendArray(data, "features", owner).map((feature, index) =>
      parseBackendFeatureWire(feature, `${owner}.features[${index}]`),
    ),
    ...(data.diagnostics !== undefined
      ? { diagnostics: optionalBackendObject(data, "diagnostics", owner) }
      : {}),
  };
}

function parseBackendModelWire(data: unknown, owner: string): BackendModelWire {
  if (!isRecord(data)) {
    throw invalidBackendsResponse(`${owner} must be an object`);
  }
  return {
    ...(data as unknown as BackendModelWire),
    id: requiredBackendString(data, "id", owner),
    label: requiredBackendString(data, "label", owner),
    ...(data.description !== undefined
      ? { description: optionalBackendString(data, "description", owner) }
      : {}),
    ...(data.is_default !== undefined
      ? { is_default: optionalBackendBoolean(data, "is_default", owner) }
      : {}),
    reasoning_efforts: optionalBackendArray(data, "reasoning_efforts", owner).map(
      (option, index) => parseReasoningEffortOptionWire(option, `${owner}.reasoning_efforts[${index}]`),
    ),
    ...(data.metadata !== undefined
      ? { metadata: optionalBackendObject(data, "metadata", owner) }
      : {}),
  };
}

function parseReasoningEffortOptionWire(
  data: unknown,
  owner: string,
): ReasoningEffortOptionWire {
  if (!isRecord(data)) {
    throw invalidBackendsResponse(`${owner} must be an object`);
  }
  return {
    ...(data as unknown as ReasoningEffortOptionWire),
    id: requiredBackendString(data, "id", owner),
    label: requiredBackendString(data, "label", owner),
    ...(data.description !== undefined
      ? { description: optionalBackendString(data, "description", owner) }
      : {}),
    ...(data.is_default !== undefined
      ? { is_default: optionalBackendBoolean(data, "is_default", owner) }
      : {}),
    ...(data.metadata !== undefined
      ? { metadata: optionalBackendObject(data, "metadata", owner) }
      : {}),
  };
}

function parsePermissionModeOptionWire(data: unknown, owner: string): PermissionModeOptionWire {
  if (!isRecord(data)) {
    throw invalidBackendsResponse(`${owner} must be an object`);
  }
  const id = requiredBackendString(data, "id", owner);
  if (!permissionModes.has(id)) {
    throw invalidBackendsResponse(`${owner}.id must be a known PermissionMode`);
  }
  return {
    ...(data as unknown as PermissionModeOptionWire),
    id: id as PermissionModeWire,
    label: requiredBackendString(data, "label", owner),
    ...(data.description !== undefined
      ? { description: optionalBackendString(data, "description", owner) }
      : {}),
    ...(data.is_default !== undefined
      ? { is_default: optionalBackendBoolean(data, "is_default", owner) }
      : {}),
    ...(data.metadata !== undefined
      ? { metadata: optionalBackendObject(data, "metadata", owner) }
      : {}),
  };
}

function parseBackendFeatureWire(data: unknown, owner: string): BackendFeatureWire {
  if (!isRecord(data)) {
    throw invalidBackendsResponse(`${owner} must be an object`);
  }
  const type = requiredBackendString(data, "type", owner);
  const base: BackendFeatureBaseWire = {
    id: requiredBackendString(data, "id", owner),
    label: requiredBackendString(data, "label", owner),
    ...(data.description !== undefined
      ? { description: optionalBackendString(data, "description", owner) }
      : {}),
    ...(data.metadata !== undefined
      ? { metadata: optionalBackendObject(data, "metadata", owner) }
      : {}),
  };

  if (type === "toggle") {
    return {
      ...base,
      type: "toggle",
      default_value: requiredBackendBoolean(data, "default_value", owner),
    };
  }

  if (type === "select") {
    return {
      ...base,
      type: "select",
      ...(data.default_value !== undefined
        ? { default_value: optionalBackendStringOrNull(data, "default_value", owner) }
        : {}),
      options: requiredBackendArray(data, "options", owner).map((option, index) =>
        parseReasoningEffortOptionWire(option, `${owner}.options[${index}]`),
      ),
    };
  }

  throw invalidBackendsResponse(`${owner}.type must be toggle or select`);
}

async function readBackendProbeResponse(response: Response): Promise<BackendProbeResultWire> {
  return parseBackendProbeResultWire(await readJsonResponse<unknown>(response));
}

export function parseBackendProbeResultWire(data: unknown): BackendProbeResultWire {
  if (!isRecord(data)) {
    throw invalidBackendProbeResponse("BackendProbeResult must be an object");
  }
  const backend = data.backend;
  if (typeof backend !== "string" || !backendKinds.has(backend)) {
    throw invalidBackendProbeResponse("BackendProbeResult.backend must be a known BackendKind");
  }
  const status = data.status;
  if (typeof status !== "string" || !backendStatuses.has(status)) {
    throw invalidBackendProbeResponse(
      "BackendProbeResult.status must be available, unavailable, or degraded",
    );
  }
  const message = data.message;
  if (message !== undefined && typeof message !== "string") {
    throw invalidBackendProbeResponse("BackendProbeResult.message must be a string");
  }
  return {
    backend: backend as BackendKindWire,
    status: status as BackendProbeResultWire["status"],
    ...(message !== undefined ? { message } : {}),
  };
}

async function readTranscriptViewResponse(response: Response): Promise<ChatTranscriptWireView> {
  return parseChatTranscriptWireView(await readJsonResponse<unknown>(response));
}

export function parseChatTranscriptWireView(data: unknown): ChatTranscriptWireView {
  if (!isRecord(data)) {
    throw invalidTranscriptView("ChatTranscriptView must be an object");
  }
  const rows = requiredViewArray(data, "rows", "ChatTranscriptView", invalidTranscriptView);
  return {
    session_id: requiredViewString(data, "session_id", "ChatTranscriptView", invalidTranscriptView),
    rows: rows.map((row, index) =>
      parseTranscriptWireRow(row, `ChatTranscriptView.rows[${index}]`),
    ),
    window: parseTranscriptWindow(data.window, invalidTranscriptView),
    cursor: requiredViewEventCursor(data, "cursor", "ChatTranscriptView", invalidTranscriptView),
  };
}

function parseTranscriptWireRow(data: unknown, owner: string): TranscriptWireRow {
  if (!isRecord(data)) {
    throw invalidTranscriptView(`${owner} must be an object`);
  }
  const kind = requiredViewString(data, "kind", owner, invalidTranscriptView);
  if (!transcriptRowKinds.has(kind)) {
    throw invalidTranscriptView(`${owner}.kind must be a known transcript row kind`);
  }
  const status = requiredViewString(data, "status", owner, invalidTranscriptView);
  if (!transcriptRowStatuses.has(status)) {
    throw invalidTranscriptView(`${owner}.status must be pending, streaming, completed, failed, or cancelled`);
  }
  return {
    ...(data as unknown as TranscriptWireRow),
    id: requiredViewString(data, "id", owner, invalidTranscriptView),
    kind: kind as TranscriptWireRow["kind"],
    created_at: requiredViewString(data, "created_at", owner, invalidTranscriptView),
    updated_at: requiredViewString(data, "updated_at", owner, invalidTranscriptView),
    revision: requiredViewInteger(data, "revision", owner, invalidTranscriptView, { minimum: 1 }),
    ...(data.turn_id !== undefined
      ? { turn_id: optionalViewString(data, "turn_id", owner, invalidTranscriptView) }
      : {}),
    ...(data.text !== undefined
      ? { text: optionalViewString(data, "text", owner, invalidTranscriptView) }
      : {}),
    ...(data.parts !== undefined
      ? { parts: parseTranscriptWireParts(data, `${owner}.parts`) }
      : {}),
    ...(data.activity_id !== undefined
      ? { activity_id: optionalViewString(data, "activity_id", owner, invalidTranscriptView) }
      : {}),
    ...(data.label !== undefined
      ? { label: optionalViewString(data, "label", owner, invalidTranscriptView) }
      : {}),
    status: status as TranscriptRowStatusWire,
    source_event_ids: requiredViewStringArray(
      data,
      "source_event_ids",
      owner,
      invalidTranscriptView,
    ),
  };
}

function parseTranscriptWireParts(
  data: Record<string, unknown>,
  owner: string,
): TranscriptWirePart[] {
  const parts = data.parts;
  if (!Array.isArray(parts)) {
    throw invalidTranscriptView(`${owner} must be an array`);
  }
  return parts.map((part, index) => parseTranscriptWirePart(part, `${owner}[${index}]`));
}

function parseTranscriptWirePart(data: unknown, owner: string): TranscriptWirePart {
  if (!isRecord(data)) {
    throw invalidTranscriptView(`${owner} must be an object`);
  }
  const type = requiredViewString(data, "type", owner, invalidTranscriptView);
  if (!transcriptPartTypes.has(type)) {
    throw invalidTranscriptView(`${owner}.type must be a known transcript part type`);
  }
  return {
    ...(data as unknown as TranscriptWirePart),
    id: requiredViewString(data, "id", owner, invalidTranscriptView),
    type: type as TranscriptPartTypeWire,
    ...(data.text !== undefined
      ? { text: optionalViewString(data, "text", owner, invalidTranscriptView) }
      : {}),
    ...(data.data !== undefined
      ? { data: optionalViewObject(data, "data", owner, invalidTranscriptView) }
      : {}),
  };
}

async function readActivityViewResponse(response: Response): Promise<ActivityWireView> {
  return parseActivityWireView(await readJsonResponse<unknown>(response));
}

async function readPendingRequestsViewResponse(response: Response): Promise<PendingRequestsWireView> {
  return parsePendingRequestsWireView(await readJsonResponse<unknown>(response));
}

async function readDiffReviewViewResponse(response: Response): Promise<DiffReviewWireView> {
  return parseDiffReviewWireView(await readJsonResponse<unknown>(response));
}

export function parseActivityWireView(data: unknown): ActivityWireView {
  if (!isRecord(data)) {
    throw invalidActivityView("ActivityShelfView must be an object");
  }
  const items = requiredViewArray(data, "items", "ActivityShelfView", invalidActivityView);
  return {
    session_id: requiredViewString(data, "session_id", "ActivityShelfView", invalidActivityView),
    items: items.map((item, index) =>
      parseActivityWireItem(item, `ActivityShelfView.items[${index}]`),
    ),
    window: parseActivityWindow(data.window, invalidActivityView),
    cursor: requiredViewEventCursor(data, "cursor", "ActivityShelfView", invalidActivityView),
  };
}

export function parsePendingRequestsWireView(data: unknown): PendingRequestsWireView {
  if (!isRecord(data)) {
    throw invalidPendingRequestsView("PendingRequestsView must be an object");
  }
  const requests = requiredViewArray(
    data,
    "requests",
    "PendingRequestsView",
    invalidPendingRequestsView,
  );
  return {
    requests: requests.map((request, index) =>
      parseAgentRequestWire(request, `PendingRequestsView.requests[${index}]`),
    ),
    cursor: requiredCursorWindow(
      data,
      "cursor",
      "PendingRequestsView",
      invalidPendingRequestsView,
    ),
  };
}

export function parseDiffReviewWireView(data: unknown): DiffReviewWireView {
  if (!isRecord(data)) {
    throw invalidDiffReviewView("DiffReviewView must be an object");
  }
  const diffs = requiredViewArray(
    data,
    "diffs",
    "DiffReviewView",
    invalidDiffReviewView,
  );
  return {
    diffs: diffs.map((diff, index) =>
      parseDiffSummaryWire(diff, `DiffReviewView.diffs[${index}]`),
    ),
    cursor: requiredCursorWindow(data, "cursor", "DiffReviewView", invalidDiffReviewView),
  };
}

function parseDiffSummaryWire(data: unknown, owner: string): DiffSummaryWire {
  if (!isRecord(data)) {
    throw invalidDiffReviewView(`${owner} must be an object`);
  }
  const status = requiredViewString(data, "status", owner, invalidDiffReviewView);
  if (!diffSummaryStatuses.has(status)) {
    throw invalidDiffReviewView(`${owner}.status must be added, modified, deleted, or renamed`);
  }
  return {
    file_path: requiredViewString(data, "file_path", owner, invalidDiffReviewView),
    status: status as DiffSummaryStatusWire,
    ...(data.additions !== undefined
      ? { additions: optionalViewInteger(data, "additions", owner, invalidDiffReviewView) }
      : {}),
    ...(data.deletions !== undefined
      ? { deletions: optionalViewInteger(data, "deletions", owner, invalidDiffReviewView) }
      : {}),
  };
}

function parseAgentRequestWire(data: unknown, owner: string): AgentRequestWire {
  if (!isRecord(data)) {
    throw invalidPendingRequestsView(`${owner} must be an object`);
  }
  const type = requiredViewString(data, "type", owner, invalidPendingRequestsView);
  if (!requestTypes.has(type)) {
    throw invalidPendingRequestsView(`${owner}.type must be a known request type`);
  }
  const status = requiredViewString(data, "status", owner, invalidPendingRequestsView);
  if (!requestStatuses.has(status)) {
    throw invalidPendingRequestsView(`${owner}.status must be a known request status`);
  }
  return {
    id: requiredViewString(data, "id", owner, invalidPendingRequestsView),
    session_id: requiredViewString(data, "session_id", owner, invalidPendingRequestsView),
    type: type as AgentRequestTypeWire,
    status: status as RequestStatusWire,
    ...(data.title !== undefined
      ? { title: optionalViewString(data, "title", owner, invalidPendingRequestsView) }
      : {}),
    ...(data.description !== undefined
      ? {
          description: optionalViewString(
            data,
            "description",
            owner,
            invalidPendingRequestsView,
          ),
        }
      : {}),
    ...(data.payload !== undefined
      ? { payload: optionalViewObject(data, "payload", owner, invalidPendingRequestsView) }
      : {}),
    ...(data.backend_ref !== undefined
      ? {
          backend_ref: optionalViewObject(
            data,
            "backend_ref",
            owner,
            invalidPendingRequestsView,
          ),
        }
      : {}),
    created_at: requiredViewString(data, "created_at", owner, invalidPendingRequestsView),
    ...(data.resolved_at !== undefined
      ? { resolved_at: optionalViewString(data, "resolved_at", owner, invalidPendingRequestsView) }
      : {}),
  };
}

function parseActivityWireItem(data: unknown, owner: string): ActivityWireItem {
  if (!isRecord(data)) {
    throw invalidActivityView(`${owner} must be an object`);
  }
  const kind = requiredViewString(data, "kind", owner, invalidActivityView);
  if (!activityItemKinds.has(kind)) {
    throw invalidActivityView(`${owner}.kind must be a known activity item kind`);
  }
  const status = requiredViewString(data, "status", owner, invalidActivityView);
  if (!activityItemStatuses.has(status)) {
    throw invalidActivityView(`${owner}.status must be pending, running, completed, failed, or cancelled`);
  }
  return {
    ...(data as unknown as ActivityWireItem),
    id: requiredViewString(data, "id", owner, invalidActivityView),
    kind: kind as ActivityItemKindWire,
    status: status as ActivityItemStatusWire,
    title: requiredViewString(data, "title", owner, invalidActivityView),
    ...(data.summary !== undefined
      ? { summary: optionalViewString(data, "summary", owner, invalidActivityView) }
      : {}),
    ...(data.detail !== undefined
      ? { detail: parseActivityWireDetail(data.detail, `${owner}.detail`) }
      : {}),
    created_at: requiredViewString(data, "created_at", owner, invalidActivityView),
    ...(data.updated_at !== undefined
      ? { updated_at: optionalViewString(data, "updated_at", owner, invalidActivityView) }
      : {}),
    ...(data.event_range !== undefined
      ? { event_range: parseActivityEventRange(data.event_range, `${owner}.event_range`) }
      : {}),
  };
}

function parseActivityWireDetail(data: unknown, owner: string): ActivityWireDetail {
  if (!isRecord(data)) {
    throw invalidActivityView(`${owner} must be an object`);
  }
  const type = data.type;
  if (typeof type !== "string" || !activityDetailTypes.has(type)) {
    throw invalidActivityView(`${owner}.type must be a known activity detail type`);
  }
  if (type === "shell") {
    return {
      ...(data as Record<string, unknown>),
      type: "shell",
      ...(data.command !== undefined
        ? { command: optionalViewString(data, "command", owner, invalidActivityView) }
        : {}),
      ...(data.cwd !== undefined
        ? { cwd: optionalViewString(data, "cwd", owner, invalidActivityView) }
        : {}),
      ...(data.output !== undefined
        ? { output: optionalViewString(data, "output", owner, invalidActivityView) }
        : {}),
      ...(data.stdout !== undefined
        ? { stdout: optionalViewString(data, "stdout", owner, invalidActivityView) }
        : {}),
      ...(data.stderr !== undefined
        ? { stderr: optionalViewString(data, "stderr", owner, invalidActivityView) }
        : {}),
      ...(data.exit_code !== undefined
        ? { exit_code: optionalViewInteger(data, "exit_code", owner, invalidActivityView) }
        : {}),
      ...(data.error !== undefined
        ? { error: optionalViewString(data, "error", owner, invalidActivityView) }
        : {}),
    };
  }
  if (type === "search") {
    return {
      ...(data as Record<string, unknown>),
      type: "search",
      ...(data.query !== undefined
        ? { query: optionalViewString(data, "query", owner, invalidActivityView) }
        : {}),
      ...(data.mode !== undefined
        ? { mode: optionalViewEnum(data, "mode", owner, invalidActivityView, activitySearchModes) }
        : {}),
      ...(data.content !== undefined
        ? { content: optionalViewString(data, "content", owner, invalidActivityView) }
        : {}),
      ...(data.num_matches !== undefined
        ? { num_matches: optionalViewInteger(data, "num_matches", owner, invalidActivityView) }
        : {}),
      ...(data.num_files !== undefined
        ? { num_files: optionalViewInteger(data, "num_files", owner, invalidActivityView) }
        : {}),
      ...(data.duration_ms !== undefined
        ? { duration_ms: optionalViewInteger(data, "duration_ms", owner, invalidActivityView) }
        : {}),
      ...(data.truncated !== undefined
        ? { truncated: optionalViewBoolean(data, "truncated", owner, invalidActivityView) }
        : {}),
    };
  }
  if (type === "read" || type === "edit" || type === "write") {
    return {
      ...(data as Record<string, unknown>),
      type: type as ActivityFileDetailTypeWire,
      ...(data.file_path !== undefined
        ? { file_path: optionalViewString(data, "file_path", owner, invalidActivityView) }
        : {}),
      ...(data.path !== undefined
        ? { path: optionalViewString(data, "path", owner, invalidActivityView) }
        : {}),
      ...(data.content !== undefined
        ? { content: optionalViewString(data, "content", owner, invalidActivityView) }
        : {}),
      ...(data.old_string !== undefined
        ? { old_string: optionalViewString(data, "old_string", owner, invalidActivityView) }
        : {}),
      ...(data.new_string !== undefined
        ? { new_string: optionalViewString(data, "new_string", owner, invalidActivityView) }
        : {}),
      ...(data.unified_diff !== undefined
        ? { unified_diff: optionalViewString(data, "unified_diff", owner, invalidActivityView) }
        : {}),
    };
  }
  if (type === "fetch") {
    return {
      ...(data as Record<string, unknown>),
      type: "fetch",
      ...(data.url !== undefined
        ? { url: optionalViewString(data, "url", owner, invalidActivityView) }
        : {}),
      ...(data.prompt !== undefined
        ? { prompt: optionalViewString(data, "prompt", owner, invalidActivityView) }
        : {}),
      ...(data.result !== undefined
        ? { result: optionalViewString(data, "result", owner, invalidActivityView) }
        : {}),
      ...(data.code !== undefined
        ? { code: optionalViewInteger(data, "code", owner, invalidActivityView) }
        : {}),
      ...(data.code_text !== undefined
        ? { code_text: optionalViewString(data, "code_text", owner, invalidActivityView) }
        : {}),
      ...(data.bytes !== undefined
        ? { bytes: optionalViewInteger(data, "bytes", owner, invalidActivityView) }
        : {}),
      ...(data.duration_ms !== undefined
        ? { duration_ms: optionalViewInteger(data, "duration_ms", owner, invalidActivityView) }
        : {}),
    };
  }
  return { ...(data as Record<string, unknown>), type: type as ActivityGenericDetailTypeWire };
}

function parseActivityEventRange(
  data: unknown,
  owner: string,
): NonNullable<ActivityWireItem["event_range"]> {
  if (!isRecord(data)) {
    throw invalidActivityView(`${owner} must be an object`);
  }
  return {
    ...(data.from_event_id !== undefined
      ? { from_event_id: optionalViewString(data, "from_event_id", owner, invalidActivityView) }
      : {}),
    ...(data.to_event_id !== undefined
      ? { to_event_id: optionalViewString(data, "to_event_id", owner, invalidActivityView) }
      : {}),
  };
}

async function readCommandAckResponse(response: Response): Promise<CommandAckWire> {
  return parseCommandAckWire(await readJsonResponse<unknown>(response));
}

export function parseCommandAckWire(data: unknown): CommandAckWire {
  if (!isRecord(data)) {
    throw invalidCommandAck("CommandAck must be an object");
  }

  switch (data.status) {
    case "accepted":
      return {
        status: "accepted",
        command_id: requiredStringField(data, "command_id"),
        session_id: requiredStringField(data, "session_id"),
        ...(optionalStringField(data, "turn_id")
          ? { turn_id: optionalStringField(data, "turn_id") }
          : {}),
        cursor: requiredEventCursor(data, "cursor"),
      };
    case "queued":
      return {
        status: "queued",
        command_id: requiredStringField(data, "command_id"),
        session_id: requiredStringField(data, "session_id"),
        queued_message_id: requiredStringField(data, "queued_message_id"),
        cursor: requiredEventCursor(data, "cursor"),
      };
    case "rejected": {
      const cursor = optionalEventCursor(data, "cursor");
      return {
        status: "rejected",
        code: requiredStringField(data, "code") as CommandRejectionCodeWire,
        message: requiredStringField(data, "message"),
        ...(optionalStringField(data, "command_id")
          ? { command_id: optionalStringField(data, "command_id") }
          : {}),
        ...(optionalStringField(data, "session_id")
          ? { session_id: optionalStringField(data, "session_id") }
          : {}),
        ...(cursor ? { cursor } : {}),
      };
    }
    default:
      throw invalidCommandAck("CommandAck.status must be accepted, queued, or rejected");
  }
}

function requiredStringField(data: Record<string, unknown>, field: string) {
  const value = data[field];
  if (typeof value !== "string" || value.length === 0) {
    throw invalidCommandAck(`CommandAck.${String(data.status)} requires ${field}`);
  }
  return value;
}

function optionalStringField(data: Record<string, unknown>, field: string) {
  const value = data[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw invalidCommandAck(`CommandAck.${String(data.status)} ${field} must be a string`);
  }
  return value;
}

function requiredEventCursor(data: Record<string, unknown>, field: string) {
  const cursor = optionalEventCursor(data, field);
  if (!cursor) {
    throw invalidCommandAck(`CommandAck.${String(data.status)} requires ${field}`);
  }
  return cursor;
}

function optionalEventCursor(
  data: Record<string, unknown>,
  field: string,
): EventCursorWire | undefined {
  const value = data[field];
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw invalidCommandAck(`CommandAck.${String(data.status)} ${field} must be an object`);
  }
  const eventId = value.event_id;
  const epoch = value.epoch;
  const seq = value.seq;
  if (
    typeof eventId !== "string" ||
    eventId.length === 0 ||
    typeof epoch !== "number" ||
    !Number.isInteger(epoch) ||
    typeof seq !== "number" ||
    !Number.isInteger(seq)
  ) {
    throw invalidCommandAck(
      `CommandAck.${String(data.status)} ${field} must include event_id, epoch, and seq`,
    );
  }
  return { event_id: eventId, epoch, seq };
}

type ViewContractErrorFactory = (message: string) => VeladClientError;

function requiredSessionObject(
  data: Record<string, unknown>,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const session = data.session;
  if (!isRecord(session)) {
    throw invalid(`${owner} requires session`);
  }
  return parseSessionWire(session, `${owner}.session`, invalid);
}

function parseSessionWire(
  data: Record<string, unknown>,
  owner: string,
  invalid: ViewContractErrorFactory,
): SessionWire {
  const id = data.id;
  if (typeof id !== "string") {
    throw invalid(`${owner}.id must be a string`);
  }
  const backend = data.backend;
  if (typeof backend !== "string" || !backendKinds.has(backend)) {
    throw invalid(`${owner}.backend must be a known BackendKind`);
  }
  const status = data.status;
  if (typeof status !== "string" || !sessionStatuses.has(status)) {
    throw invalid(`${owner}.status must be a known SessionStatus`);
  }
  const title = requiredViewString(data, "title", owner, invalid);
  const workingDirectory = requiredViewString(data, "working_directory", owner, invalid);
  const createdAt = requiredViewString(data, "created_at", owner, invalid);
  const updatedAt = requiredViewString(data, "updated_at", owner, invalid);
  const agentConfig = data.agent_config;
  if (agentConfig !== undefined) {
    validateAgentConfigShape(agentConfig, invalid, `${owner}.agent_config`);
  }
  const runtimeInfo = data.runtime_info;
  const parsedRuntimeInfo =
    runtimeInfo !== undefined
      ? parseSessionRuntimeInfoWire(runtimeInfo, invalid, `${owner}.runtime_info`)
      : undefined;
  const operations = data.operations;
  if (operations !== undefined) {
    validateSessionOperationsShape(operations, invalid, `${owner}.operations`);
  }
  return {
    ...(data as unknown as SessionWire),
    id,
    backend: backend as BackendKindWire,
    status: status as SessionStatusWire,
    title,
    working_directory: workingDirectory,
    created_at: createdAt,
    updated_at: updatedAt,
    ...(agentConfig !== undefined ? { agent_config: agentConfig } : {}),
    ...(parsedRuntimeInfo !== undefined ? { runtime_info: parsedRuntimeInfo } : {}),
    ...(operations !== undefined ? { operations } : {}),
  };
}

function requiredEffectiveAfter(data: Record<string, unknown>) {
  const value = data.effective_after;
  if (value !== "current_session" && value !== "next_turn") {
    throw invalidUpdateAgentConfigResponse(
      "UpdateAgentConfigResponse.effective_after must be current_session or next_turn",
    );
  }
  return value;
}

function requiredViewString(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (typeof value !== "string") {
    throw invalid(`${owner} requires ${field}`);
  }
  return value;
}

function requiredViewArray(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (!Array.isArray(value)) {
    throw invalid(`${owner} requires ${field}`);
  }
  return value;
}

function optionalViewString(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalid(`${owner}.${field} must be a string`);
  }
  return value;
}

function optionalViewEnum<T extends string>(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
  values: ReadonlySet<T>,
) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(values as ReadonlySet<string>).has(value)) {
    throw invalid(`${owner}.${field} must be a known value`);
  }
  return value as T;
}

function optionalViewInteger(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid(`${owner}.${field} must be an integer`);
  }
  return value;
}

function optionalViewBoolean(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw invalid(`${owner}.${field} must be a boolean`);
  }
  return value;
}

function optionalViewObject(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw invalid(`${owner}.${field} must be an object`);
  }
  return value;
}

function requiredCursorWindow(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
): CursorWindow {
  const value = data[field];
  if (!isRecord(value)) {
    throw invalid(`${owner} requires ${field}`);
  }
  const cursorOwner = `${owner}.${field}`;
  return {
    ...(value.event_id !== undefined
      ? { event_id: optionalViewString(value, "event_id", cursorOwner, invalid) }
      : {}),
    ...(value.epoch !== undefined
      ? { epoch: optionalViewInteger(value, "epoch", cursorOwner, invalid) }
      : {}),
    ...(value.seq !== undefined
      ? { seq: optionalViewInteger(value, "seq", cursorOwner, invalid) }
      : {}),
    ...(value.from_seq !== undefined
      ? { from_seq: optionalViewInteger(value, "from_seq", cursorOwner, invalid) }
      : {}),
    ...(value.to_seq !== undefined
      ? { to_seq: optionalViewInteger(value, "to_seq", cursorOwner, invalid) }
      : {}),
    ...(value.latest_event_id !== undefined
      ? {
          latest_event_id: optionalViewString(value, "latest_event_id", cursorOwner, invalid),
        }
      : {}),
    ...(value.next_event_id !== undefined
      ? { next_event_id: optionalViewString(value, "next_event_id", cursorOwner, invalid) }
      : {}),
    ...(value.has_more !== undefined
      ? { has_more: optionalViewBoolean(value, "has_more", cursorOwner, invalid) }
      : {}),
    ...(value.has_newer !== undefined
      ? { has_newer: optionalViewBoolean(value, "has_newer", cursorOwner, invalid) }
      : {}),
    ...(value.has_older !== undefined
      ? { has_older: optionalViewBoolean(value, "has_older", cursorOwner, invalid) }
      : {}),
  };
}

function requiredViewInteger(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
  options?: { minimum?: number },
) {
  const value = data[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid(`${owner} requires ${field}`);
  }
  if (options?.minimum !== undefined && value < options.minimum) {
    throw invalid(`${owner}.${field} must be at least ${options.minimum}`);
  }
  return value;
}

function requiredViewStringArray(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalid(`${owner} requires ${field}`);
  }
  return value as string[];
}

function requiredBackendCapabilities(
  data: Record<string, unknown>,
  owner: string,
): BackendCapabilitiesWire {
  const value = data.capabilities;
  if (!isRecord(value)) {
    throw invalidBackendsResponse(`${owner} requires capabilities`);
  }
  for (const field of backendCapabilityFields) {
    if (typeof value[field] !== "boolean") {
      throw invalidBackendsResponse(`${owner}.capabilities requires ${field}`);
    }
  }
  return value as BackendCapabilitiesWire;
}

function optionalBackendArray(data: Record<string, unknown>, field: string, owner: string) {
  const value = data[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw invalidBackendsResponse(`${owner}.${field} must be an array`);
  }
  return value;
}

function requiredBackendArray(data: Record<string, unknown>, field: string, owner: string) {
  const value = data[field];
  if (!Array.isArray(value)) {
    throw invalidBackendsResponse(`${owner}.${field} must be an array`);
  }
  return value;
}

function requiredBackendString(data: Record<string, unknown>, field: string, owner: string) {
  const value = data[field];
  if (typeof value !== "string") {
    throw invalidBackendsResponse(`${owner}.${field} must be a string`);
  }
  return value;
}

function optionalBackendString(data: Record<string, unknown>, field: string, owner: string) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalidBackendsResponse(`${owner}.${field} must be a string`);
  }
  return value;
}

function optionalBackendStringOrNull(
  data: Record<string, unknown>,
  field: string,
  owner: string,
) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string") return value;
  throw invalidBackendsResponse(`${owner}.${field} must be a string or null`);
}

function requiredBackendBoolean(data: Record<string, unknown>, field: string, owner: string) {
  const value = data[field];
  if (typeof value !== "boolean") {
    throw invalidBackendsResponse(`${owner}.${field} must be a boolean`);
  }
  return value;
}

function optionalBackendBoolean(data: Record<string, unknown>, field: string, owner: string) {
  const value = data[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw invalidBackendsResponse(`${owner}.${field} must be a boolean`);
  }
  return value;
}

function optionalBackendObject(data: Record<string, unknown>, field: string, owner: string) {
  const value = data[field];
  if (!isRecord(value)) {
    throw invalidBackendsResponse(`${owner}.${field} must be an object`);
  }
  return value;
}

function requiredViewEventCursor(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  return parseViewEventCursor(data[field], `${owner}.${field}`, invalid);
}

function parseViewEventCursor(
  value: unknown,
  owner: string,
  invalid: ViewContractErrorFactory,
): EventCursorWire {
  if (!isRecord(value)) {
    throw invalid(`${owner} must be an object`);
  }
  const eventId = value.event_id;
  const epoch = value.epoch;
  const seq = value.seq;
  if (
    typeof eventId !== "string" ||
    eventId.length === 0 ||
    typeof epoch !== "number" ||
    !Number.isInteger(epoch) ||
    typeof seq !== "number" ||
    !Number.isInteger(seq)
  ) {
    throw invalid(`${owner} must include event_id, epoch, and seq`);
  }
  return { event_id: eventId, epoch, seq };
}

function parseTranscriptWindow(
  value: unknown,
  invalid: ViewContractErrorFactory,
): TranscriptWindow {
  const window = parseViewWindow(value, "ChatTranscriptView.window", invalid);
  return {
    ...optionalNullableWindowString(window, "first_row_id", "ChatTranscriptView.window", invalid),
    ...optionalNullableWindowString(window, "last_row_id", "ChatTranscriptView.window", invalid),
    ...optionalNullableWindowString(window, "anchor_row_id", "ChatTranscriptView.window", invalid),
    has_older: window.has_older,
    has_newer: window.has_newer,
  };
}

function parseActivityWindow(value: unknown, invalid: ViewContractErrorFactory): ActivityWindow {
  const window = parseViewWindow(value, "ActivityShelfView.window", invalid);
  return {
    ...optionalNullableWindowString(window, "first_item_id", "ActivityShelfView.window", invalid),
    ...optionalNullableWindowString(window, "last_item_id", "ActivityShelfView.window", invalid),
    ...optionalNullableWindowString(window, "anchor_item_id", "ActivityShelfView.window", invalid),
    has_older: window.has_older,
    has_newer: window.has_newer,
  };
}

function parseViewWindow(value: unknown, owner: string, invalid: ViewContractErrorFactory) {
  if (!isRecord(value)) {
    throw invalid(`${owner} must be an object`);
  }
  const hasOlder = value.has_older;
  const hasNewer = value.has_newer;
  if (typeof hasOlder !== "boolean" || typeof hasNewer !== "boolean") {
    throw invalid(`${owner} requires has_older and has_newer`);
  }
  return { ...value, has_older: hasOlder, has_newer: hasNewer };
}

function optionalNullableWindowString(
  data: Record<string, unknown>,
  field: string,
  owner: string,
  invalid: ViewContractErrorFactory,
) {
  const value = data[field];
  if (value === undefined) return {};
  if (value === null || typeof value === "string") return { [field]: value };
  throw invalid(`${owner}.${field} must be a string or null`);
}

function invalidCommandAck(message: string) {
  return new VeladClientError("invalid_command_ack", message);
}

function invalidInputPart(message: string) {
  return new VeladClientError("invalid_input_part", message);
}

function invalidInputEvent(message: string) {
  return new VeladClientError("invalid_input_event", message);
}

function invalidIdempotencyKey(message: string) {
  return new VeladClientError("invalid_idempotency_key", message);
}

function invalidSessionId(message: string) {
  return new VeladClientError("invalid_session_id", message);
}

function invalidAfterId(message: string) {
  return new VeladClientError("invalid_after_id", message);
}

function invalidBackendKind(message: string) {
  return new VeladClientError("invalid_backend_kind", message);
}

function invalidCreateSessionRequest(message: string) {
  return new VeladClientError("invalid_create_session_request", message);
}

function invalidAgentConfigPatch(message: string) {
  return new VeladClientError("invalid_agent_config_patch", message);
}

function invalidCreateSessionResponse(message: string) {
  return new VeladClientError("invalid_create_session_response", message);
}

function invalidUpdateAgentConfigResponse(message: string) {
  return new VeladClientError("invalid_update_agent_config_response", message);
}

function invalidSessionResponse(message: string) {
  return new VeladClientError("invalid_session_response", message);
}

function invalidBackendsResponse(message: string) {
  return new VeladClientError("invalid_backends_response", message);
}

function invalidBackendProbeResponse(message: string) {
  return new VeladClientError("invalid_backend_probe_response", message);
}

function invalidTranscriptView(message: string) {
  return new VeladClientError("invalid_transcript_view", message);
}

function invalidActivityView(message: string) {
  return new VeladClientError("invalid_activity_view", message);
}

function invalidPendingRequestsView(message: string) {
  return new VeladClientError("invalid_pending_requests_view", message);
}

function invalidDiffReviewView(message: string) {
  return new VeladClientError("invalid_diff_review_view", message);
}

export class VeladClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "VeladClientError";
  }
}

export async function imageFileToInputPart(file: Pick<File, "arrayBuffer" | "type">) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    type: "image",
    data: bytesToBase64(bytes),
    mime_type: file.type || "application/octet-stream",
  } satisfies ClientInputPart;
}

export function createIdempotencyKey() {
  return createRandomKey("cmd");
}

export function createSessionIdempotencyKey() {
  return createRandomKey("ses");
}

export function createConfigIdempotencyKey() {
  return createRandomKey("cfg");
}

function createRandomKey(prefix: string) {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  const suffix = Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("");
  return `${prefix}_${suffix}`;
}

function bytesToBase64(bytes: Uint8Array) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const packed = (first << 16) | (second << 8) | third;
    output += alphabet[(packed >> 18) & 63];
    output += alphabet[(packed >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(packed >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[packed & 63] : "=";
  }
  return output;
}

export function parseSseJsonFrames(chunk: string): unknown[] {
  const frames: unknown[] = [];
  for (const frame of chunk.split(/\n\n+/)) {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());
    if (dataLines.length === 0) continue;
    frames.push(JSON.parse(dataLines.join("\n")));
  }
  return frames;
}
