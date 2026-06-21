export interface ChatSurfaceCursor {
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

export interface ChatSurfaceEventCursor {
  event_id: string;
  epoch: number;
  seq: number;
}

export interface ChatTranscriptWindow {
  first_row_id?: string | null;
  last_row_id?: string | null;
  anchor_row_id?: string | null;
  has_older: boolean;
  has_newer: boolean;
}

export type ChatTranscriptRowStatusWire =
  | "pending"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";
export type ChatTranscriptTurnStatusWire = "running" | "completed" | "failed" | "cancelled";
export type ChatTranscriptPartTypeWire = "markdown" | "text" | "code" | "image" | "file_reference";

export interface ChatTranscriptWireRow {
  id: string;
  kind: "user_message" | "assistant_message" | "working" | "activity_marker" | "error";
  created_at: string;
  updated_at: string;
  revision: number;
  turn_id?: string;
  text?: string;
  activity_id?: string;
  label?: string;
  parts?: ChatTranscriptPart[];
  status: ChatTranscriptRowStatusWire;
  source_event_ids: string[];
}

export interface ChatTranscriptPart {
  id: string;
  type: ChatTranscriptPartTypeWire;
  text?: string;
  data?: {
    [key: string]: unknown;
    data?: string;
    mime_type?: string;
    sha256?: string;
    size_bytes?: number;
    blob_id?: string;
  };
}

export interface ChatTranscriptTurnSummaryWire {
  turn_id: string;
  status: ChatTranscriptTurnStatusWire;
  started_at: string;
  completed_at?: string | null;
  first_row_id?: string | null;
  last_row_id?: string | null;
  source_event_ids: string[];
}

export interface ChatTranscriptWireView {
  session_id: string;
  rows: ChatTranscriptWireRow[];
  turns: ChatTranscriptTurnSummaryWire[];
  cursor: ChatSurfaceEventCursor;
  window: ChatTranscriptWindow;
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
export type ActivityGenericDetailTypeWire = Exclude<
  ActivityDetailTypeWire,
  "shell" | "read" | "edit" | "write" | "search" | "fetch"
>;
export type ActivityFileDetailTypeWire = "read" | "edit" | "write";
export type ActivitySearchModeWire = "code" | "web" | "files" | "unknown";

export interface ActivityWireItem {
  id: string;
  turn_id?: string;
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

export interface ActivityWindow {
  first_item_id?: string | null;
  last_item_id?: string | null;
  anchor_item_id?: string | null;
  has_older: boolean;
  has_newer: boolean;
}

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

export interface ActivityWireView {
  session_id: string;
  items: ActivityWireItem[];
  window: ActivityWindow;
  cursor: ChatSurfaceEventCursor;
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
  cursor: ChatSurfaceCursor;
}

export interface ChatSurfaceDebug {
  projection: "transcript" | "activity" | "requests" | "diffs";
  source_event_ids: string[];
}

export interface ChatSurfaceTranscriptRow {
  id: string;
  role: "user" | "assistant" | "working" | "activity";
  text: string;
  parts: ChatTranscriptPart[];
  created_at: string;
  updated_at: string;
  turn_id?: string;
  activity_id?: string;
  status: ChatTranscriptRowStatusWire;
  revision: number;
  debug: ChatSurfaceDebug;
}

export interface ChatSurfaceTranscriptTurn {
  turn_id: string;
  status: ChatTranscriptTurnStatusWire;
  started_at: string;
  completed_at?: string | null;
  first_row_id?: string | null;
  last_row_id?: string | null;
  debug: ChatSurfaceDebug;
}

export interface ChatSurfaceActivityItem {
  id: string;
  turn_id?: string;
  kind: ActivityItemKindWire;
  status: ActivityItemStatusWire;
  title: string;
  summary: string;
  detail?: ActivityWireDetail;
  created_at: string;
  updated_at?: string;
  debug: ChatSurfaceDebug;
}

export interface ChatSurfacePendingRequest {
  id: string;
  type: AgentRequestTypeWire;
  status: RequestStatusWire;
  title: string;
  description: string;
  payload?: Record<string, unknown>;
  created_at: string;
  resolved_at?: string;
  debug: ChatSurfaceDebug;
}

export interface ChatSurface {
  session_id: string;
  transcript: {
    rows: ChatSurfaceTranscriptRow[];
    turns: ChatSurfaceTranscriptTurn[];
    window?: ChatTranscriptWindow;
  };
  activity: {
    items: ChatSurfaceActivityItem[];
    window?: ActivityWindow;
  };
  pending_requests: {
    items: ChatSurfacePendingRequest[];
  };
  cursors: {
    transcript?: ChatSurfaceCursor;
    activity?: ChatSurfaceCursor;
    requests?: ChatSurfaceCursor;
  };
  stream: {
    connected: boolean;
    running: boolean;
  };
}

export interface BuildChatSurfaceInput {
  sessionId: string;
  transcript: ChatTranscriptWireView;
  activity?: ActivityWireView;
  requests?: PendingRequestsWireView;
  stream?: Partial<ChatSurface["stream"]>;
}

export interface ConversationWindowState {
  first_row_id?: string | null;
  last_row_id?: string | null;
  first_activity_item_id?: string | null;
  last_activity_item_id?: string | null;
  has_older: boolean;
  has_newer: boolean;
}

export interface ConversationHistoryPrependPlan {
  has_older: boolean;
  transcript: {
    direction: "before";
    anchorRowId: string;
    sessionId?: string;
    includeLive: false;
    limit: number;
  } | null;
  activity: {
    direction: "before";
    anchorItemId: string;
    sessionId?: string;
    limit: number;
  } | null;
}

export interface ConversationWindowInput {
  transcript?: Pick<ChatTranscriptWireView, "session_id" | "window"> | null;
  activity?: Pick<ActivityWireView, "session_id" | "window"> | null;
}

export interface ConversationHistoryPrependPlanInput extends ConversationWindowInput {
  limit?: number;
}

export function buildChatSurfaceFromReadModels(input: BuildChatSurfaceInput): ChatSurface {
  return {
    session_id: input.sessionId,
    transcript: {
      rows: input.transcript.rows.map(normalizeTranscriptRow),
      turns: input.transcript.turns.map(normalizeTranscriptTurnSummary),
      window: input.transcript.window,
    },
    activity: {
      items: input.activity?.items.map(normalizeActivityItem) ?? [],
      window: input.activity?.window,
    },
    pending_requests: {
      items: input.requests?.requests.map(normalizePendingRequest) ?? [],
    },
    cursors: {
      transcript: input.transcript.cursor,
      ...(input.activity ? { activity: input.activity.cursor } : {}),
      ...(input.requests ? { requests: input.requests.cursor } : {}),
    },
    stream: {
      connected: input.stream?.connected ?? false,
      running: input.stream?.running ?? false,
    },
  };
}

function normalizeTranscriptTurnSummary(turn: ChatTranscriptTurnSummaryWire): ChatSurfaceTranscriptTurn {
  return {
    turn_id: turn.turn_id,
    status: turn.status,
    started_at: turn.started_at,
    ...(turn.completed_at !== undefined ? { completed_at: turn.completed_at } : {}),
    ...(turn.first_row_id !== undefined ? { first_row_id: turn.first_row_id } : {}),
    ...(turn.last_row_id !== undefined ? { last_row_id: turn.last_row_id } : {}),
    debug: {
      projection: "transcript",
      source_event_ids: turn.source_event_ids,
    },
  };
}

function normalizePendingRequest(request: AgentRequestWire): ChatSurfacePendingRequest {
  return {
    id: request.id,
    type: request.type,
    status: request.status,
    title: request.title?.trim() || titleFromRequestType(request.type),
    description: request.description?.trim() || "",
    ...(request.payload ? { payload: request.payload } : {}),
    created_at: request.created_at,
    ...(request.resolved_at ? { resolved_at: request.resolved_at } : {}),
    debug: {
      projection: "requests",
      source_event_ids: [],
    },
  };
}

function titleFromRequestType(type: string) {
  switch (type) {
    case "permission":
      return "Permission required";
    case "tool_confirmation":
    case "tool_call":
      return "Tool confirmation";
    case "question":
      return "Question";
    case "custom_input":
      return "Input required";
    default:
      return "Request";
  }
}

export function deriveConversationWindowState({
  transcript,
  activity,
}: ConversationWindowInput): ConversationWindowState {
  return {
    first_row_id: transcript?.window?.first_row_id ?? null,
    last_row_id: transcript?.window?.last_row_id ?? null,
    first_activity_item_id: activity?.window?.first_item_id ?? null,
    last_activity_item_id: activity?.window?.last_item_id ?? null,
    has_older: Boolean(
      transcript?.window?.has_older || activity?.window?.has_older,
    ),
    has_newer: Boolean(
      transcript?.window?.has_newer || activity?.window?.has_newer,
    ),
  };
}

export function buildConversationHistoryPrependPlan({
  transcript,
  activity,
  limit = 80,
}: ConversationHistoryPrependPlanInput): ConversationHistoryPrependPlan {
  const normalizedLimit = normalizeWindowLimit(limit);
  const firstRowId = transcript?.window?.has_older
    ? transcript.window.first_row_id
    : null;
  const firstActivityItemId = activity?.window?.has_older
    ? activity.window.first_item_id
    : null;
  const transcriptPlan =
    typeof firstRowId === "string" && firstRowId.length > 0
      ? {
          direction: "before" as const,
          anchorRowId: firstRowId,
          ...(transcript?.session_id ? { sessionId: transcript.session_id } : {}),
          includeLive: false as const,
          limit: normalizedLimit,
        }
      : null;
  const activityPlan =
    typeof firstActivityItemId === "string" && firstActivityItemId.length > 0
      ? {
          direction: "before" as const,
          anchorItemId: firstActivityItemId,
          ...(activity?.session_id ? { sessionId: activity.session_id } : {}),
          limit: normalizedLimit,
        }
      : null;

  return {
    has_older: transcriptPlan !== null || activityPlan !== null,
    transcript: transcriptPlan,
    activity: activityPlan,
  };
}

export function canApplyConversationHistoryPrependPlan(
  plan: ConversationHistoryPrependPlan,
  current: ConversationWindowInput,
): boolean {
  if (plan.transcript) {
    if (
      plan.transcript.sessionId &&
      current.transcript?.session_id !== plan.transcript.sessionId
    ) {
      return false;
    }
    const currentFirstRowId = current.transcript?.window?.first_row_id;
    if (currentFirstRowId !== plan.transcript.anchorRowId) return false;
  }
  if (plan.activity) {
    if (
      plan.activity.sessionId &&
      current.activity?.session_id !== plan.activity.sessionId
    ) {
      return false;
    }
    const currentFirstItemId = current.activity?.window?.first_item_id;
    if (currentFirstItemId !== plan.activity.anchorItemId) return false;
  }
  return true;
}

export function prependTranscriptWindow<T extends ChatTranscriptWireView>(current: T, older: T): T {
  if (isDifferentKnownSession(current.session_id, older.session_id)) return current;

  const rows = prependMissingItemsById(older.rows, current.rows);
  const turns = prependMissingTurnsById(older.turns, current.turns);

  return {
    ...current,
    session_id: current.session_id ?? older.session_id,
    rows,
    turns,
    window: {
      first_row_id:
        older.window?.first_row_id ?? rows[0]?.id ?? current.window?.first_row_id ?? null,
      last_row_id:
        current.window?.last_row_id ??
        rows[rows.length - 1]?.id ??
        older.window?.last_row_id ??
        null,
      anchor_row_id: current.window?.anchor_row_id ?? older.window?.anchor_row_id ?? null,
      has_older: older.window?.has_older ?? false,
      has_newer: current.window?.has_newer ?? false,
    },
    cursor: latestCursor(current.cursor, older.cursor),
  } as T;
}

export function prependActivityWindow<T extends ActivityWireView>(current: T, older: T): T {
  if (isDifferentKnownSession(current.session_id, older.session_id)) return current;

  const items = prependMissingItemsById(older.items, current.items);

  return {
    ...current,
    session_id: current.session_id ?? older.session_id,
    items,
    window: {
      first_item_id:
        older.window?.first_item_id ?? items[0]?.id ?? current.window?.first_item_id ?? null,
      last_item_id:
        current.window?.last_item_id ??
        items[items.length - 1]?.id ??
        older.window?.last_item_id ??
        null,
      anchor_item_id: current.window?.anchor_item_id ?? older.window?.anchor_item_id ?? null,
      has_older: older.window?.has_older ?? false,
      has_newer: current.window?.has_newer ?? false,
    },
    cursor: latestCursor(current.cursor, older.cursor),
  } as T;
}

function normalizeActivityItem(item: ActivityWireItem): ChatSurfaceActivityItem {
  const sourceEventIds = uniqueStrings([
    item.event_range?.from_event_id,
    item.event_range?.to_event_id,
  ].filter((id): id is string => Boolean(id)));
  return {
    id: item.id,
    ...(item.turn_id !== undefined ? { turn_id: item.turn_id } : {}),
    kind: item.kind,
    status: item.status,
    title: item.title,
    summary: item.summary ?? "",
    detail: item.detail,
    created_at: item.created_at,
    updated_at: item.updated_at,
    debug: {
      projection: "activity",
      source_event_ids: sourceEventIds,
    },
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function normalizeTranscriptRow(row: ChatTranscriptWireRow): ChatSurfaceTranscriptRow {
  return {
    id: row.id,
    role: transcriptKindToRole(row.kind),
    text: transcriptRowText(row),
    parts: row.parts ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.turn_id !== undefined ? { turn_id: row.turn_id } : {}),
    ...(row.activity_id !== undefined ? { activity_id: row.activity_id } : {}),
    status: row.status,
    revision: row.revision,
    debug: {
      projection: "transcript",
      source_event_ids: row.source_event_ids,
    },
  };
}

function transcriptRowText(row: ChatTranscriptWireRow) {
  if (row.kind === "user_message" || row.kind === "assistant_message") {
    return row.text ?? "";
  }
  return row.text ?? row.label ?? "";
}

function transcriptKindToRole(kind: ChatTranscriptWireRow["kind"]): ChatSurfaceTranscriptRow["role"] {
  if (kind === "user_message") return "user";
  if (kind === "assistant_message") return "assistant";
  if (kind === "activity_marker") return "activity";
  return "working";
}

function isDifferentKnownSession(
  currentSessionId: string | undefined,
  olderSessionId: string | undefined,
) {
  return Boolean(currentSessionId && olderSessionId && currentSessionId !== olderSessionId);
}

function latestCursor(current: ChatSurfaceCursor, older: ChatSurfaceCursor) {
  const currentOrder = cursorOrder(current);
  const olderOrder = cursorOrder(older);
  if (currentOrder && !olderOrder) return current;
  if (!currentOrder && olderOrder) return older;
  if (!currentOrder || !olderOrder) return current;
  if (currentOrder.epoch > olderOrder.epoch) return current;
  if (currentOrder.epoch < olderOrder.epoch) return older;
  return currentOrder.seq >= olderOrder.seq ? current : older;
}

function cursorOrder(cursor: ChatSurfaceCursor) {
  const seq = typeof cursor.seq === "number" ? cursor.seq : cursor.to_seq;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return null;
  return {
    epoch:
      typeof cursor.epoch === "number" && Number.isFinite(cursor.epoch)
        ? cursor.epoch
        : 0,
    seq,
  };
}

function normalizeWindowLimit(limit: number) {
  if (!Number.isFinite(limit)) return 80;
  return Math.max(1, Math.floor(limit));
}

function prependMissingItemsById<T extends { id: string }>(
  olderItems: readonly T[],
  currentItems: readonly T[],
): T[] {
  const currentIds = new Set(currentItems.map((item) => item.id));
  const seenOlderIds = new Set<string>();
  const prepended = olderItems.filter((item) => {
    if (currentIds.has(item.id) || seenOlderIds.has(item.id)) return false;
    seenOlderIds.add(item.id);
    return true;
  });
  return [...prepended, ...currentItems];
}

function prependMissingTurnsById<T extends { turn_id: string }>(
  olderTurns: readonly T[],
  currentTurns: readonly T[],
): T[] {
  const currentIds = new Set(currentTurns.map((turn) => turn.turn_id));
  const seenOlderIds = new Set<string>();
  const prepended = olderTurns.filter((turn) => {
    if (currentIds.has(turn.turn_id) || seenOlderIds.has(turn.turn_id)) return false;
    seenOlderIds.add(turn.turn_id);
    return true;
  });
  return [...prepended, ...currentTurns];
}
