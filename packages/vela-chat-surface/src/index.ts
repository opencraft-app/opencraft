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

export interface SourceEventRangeWire {
  epoch: number;
  from_event_id: string;
  to_event_id: string;
  from_seq: number;
  to_seq: number;
}

export interface ConversationWindow {
  first_item_id?: string | null;
  last_item_id?: string | null;
  anchor_item_id?: string | null;
  has_older: boolean;
  has_newer: boolean;
}

export type ConversationItemStatusWire =
  | "pending"
  | "running"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

export interface ConversationWireItemBase {
  id: string;
  kind: "user_message" | "assistant_message" | "turn_meta" | "agent_work" | "status";
  turn_id?: string;
  created_at: string;
  updated_at: string;
  revision: number;
  status: ConversationItemStatusWire;
  source_event_ids: string[];
  source_event_ranges: SourceEventRangeWire[];
}

export type ConversationWireItem =
  | (ConversationWireItemBase & {
      kind: "user_message" | "assistant_message";
      text: string;
      parts?: ConversationMessagePart[];
    })
  | (ConversationWireItemBase & {
      kind: "turn_meta";
      turn_id: string;
    })
  | (ConversationWireItemBase & {
      kind: "agent_work";
      title: string;
      summary?: string;
      detail?: AgentWorkDetailWire;
      event_range?: {
        from_event_id?: string;
        to_event_id?: string;
      };
    })
  | (ConversationWireItemBase & {
      kind: "status";
      text: string;
    });

export interface ConversationWireView {
  session_id: string;
  items: ConversationWireItem[];
  cursor: ChatSurfaceEventCursor;
  window: ConversationWindow;
}

export type ConversationMessagePartTypeWire = "text" | "image" | "file_reference";

export interface ConversationMessagePart {
  id: string;
  type: ConversationMessagePartTypeWire;
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
export type AgentWorkGenericDetailTypeWire = Exclude<
  AgentWorkDetailTypeWire,
  "shell" | "read" | "edit" | "write" | "search" | "fetch"
>;
export type AgentWorkFileDetailTypeWire = "read" | "edit" | "write";
export type AgentWorkSearchModeWire = "code" | "web" | "files" | "unknown";

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
  streams?: AgentWorkShellStreamWire[];
  exit_code?: number;
  error?: string;
}

export interface AgentWorkShellStreamWire {
  stream_id: string;
  stream?: string;
  text?: string;
  last_delta?: string;
  chunk_count?: number;
  last_sequence?: number;
  last_chunk_id?: string;
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

export interface ChatSurfaceConversationDebug {
  projection: "conversation";
  source_event_ids: string[];
  source_event_ranges: SourceEventRangeWire[];
}

export interface ChatSurfaceAuxiliaryDebug {
  projection: "requests" | "diffs";
  source_event_ids: string[];
}

export type ChatSurfaceDebug = ChatSurfaceConversationDebug | ChatSurfaceAuxiliaryDebug;

export type ChatSurfaceConversationItem =
  | ChatSurfaceUserMessageItem
  | ChatSurfaceAssistantMessageItem
  | ChatSurfaceTurnMetaItem
  | ChatSurfaceAgentWorkItem
  | ChatSurfaceStatusItem;

export interface ChatSurfaceConversationItemBase {
  id: string;
  kind: ConversationWireItem["kind"];
  created_at: string;
  updated_at: string;
  turn_id?: string;
  status: ConversationItemStatusWire;
  revision: number;
  debug: ChatSurfaceConversationDebug;
}

export interface ChatSurfaceUserMessageItem extends ChatSurfaceConversationItemBase {
  kind: "user_message";
  text: string;
  parts: ConversationMessagePart[];
}

export interface ChatSurfaceAssistantMessageItem extends ChatSurfaceConversationItemBase {
  kind: "assistant_message";
  text: string;
  parts: ConversationMessagePart[];
}

export interface ChatSurfaceTurnMetaItem extends ChatSurfaceConversationItemBase {
  kind: "turn_meta";
  turn_id: string;
  completed_at?: string | null;
}

export interface ChatSurfaceAgentWorkItem extends ChatSurfaceConversationItemBase {
  kind: "agent_work";
  title: string;
  summary: string;
  detail?: AgentWorkDetailWire;
  event_range?: {
    from_event_id?: string;
    to_event_id?: string;
  };
}

export interface ChatSurfaceStatusItem extends ChatSurfaceConversationItemBase {
  kind: "status";
  text: string;
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
  conversation: {
    items: ChatSurfaceConversationItem[];
    window?: ConversationWindow;
  };
  pending_requests: {
    items: ChatSurfacePendingRequest[];
  };
  cursors: {
    conversation?: ChatSurfaceCursor;
    requests?: ChatSurfaceCursor;
  };
  stream: {
    connected: boolean;
    running: boolean;
  };
}

export interface BuildChatSurfaceInput {
  sessionId: string;
  conversation: ConversationWireView;
  requests?: PendingRequestsWireView;
  stream?: Partial<ChatSurface["stream"]>;
}

export interface ConversationWindowState {
  first_item_id?: string | null;
  last_item_id?: string | null;
  has_older: boolean;
  has_newer: boolean;
}

export interface ConversationHistoryPrependPlan {
  has_older: boolean;
  conversation: {
    direction: "before";
    anchorItemId: string;
    sessionId?: string;
    limit: number;
  } | null;
}

export interface ConversationWindowInput {
  conversation?: Pick<ConversationWireView, "session_id" | "window"> | null;
}

export interface ConversationHistoryPrependPlanInput extends ConversationWindowInput {
  limit?: number;
}

export function buildChatSurfaceFromReadModels(input: BuildChatSurfaceInput): ChatSurface {
  return {
    session_id: input.sessionId,
    conversation: {
      items: input.conversation.items.map(normalizeConversationItem),
      window: input.conversation.window,
    },
    pending_requests: {
      items: input.requests?.requests.map(normalizePendingRequest) ?? [],
    },
    cursors: {
      conversation: input.conversation.cursor,
      ...(input.requests ? { requests: input.requests.cursor } : {}),
    },
    stream: {
      connected: input.stream?.connected ?? false,
      running: input.stream?.running ?? false,
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
  conversation,
}: ConversationWindowInput): ConversationWindowState {
  return {
    first_item_id: conversation?.window?.first_item_id ?? null,
    last_item_id: conversation?.window?.last_item_id ?? null,
    has_older: Boolean(conversation?.window?.has_older),
    has_newer: Boolean(conversation?.window?.has_newer),
  };
}

export function buildConversationHistoryPrependPlan({
  conversation,
  limit = 80,
}: ConversationHistoryPrependPlanInput): ConversationHistoryPrependPlan {
  const normalizedLimit = normalizeWindowLimit(limit);
  const firstItemId = conversation?.window?.has_older
    ? conversation.window.first_item_id
    : null;
  const conversationPlan =
    typeof firstItemId === "string" && firstItemId.length > 0
      ? {
          direction: "before" as const,
          anchorItemId: firstItemId,
          ...(conversation?.session_id ? { sessionId: conversation.session_id } : {}),
          limit: normalizedLimit,
        }
      : null;

  return {
    has_older: conversationPlan !== null,
    conversation: conversationPlan,
  };
}

export function canApplyConversationHistoryPrependPlan(
  plan: ConversationHistoryPrependPlan,
  current: ConversationWindowInput,
): boolean {
  if (plan.conversation) {
    if (
      plan.conversation.sessionId &&
      current.conversation?.session_id !== plan.conversation.sessionId
    ) {
      return false;
    }
    const currentFirstItemId = current.conversation?.window?.first_item_id;
    if (currentFirstItemId !== plan.conversation.anchorItemId) return false;
  }
  return true;
}

export function prependConversationWindow<T extends ConversationWireView>(current: T, older: T): T {
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

function normalizeConversationItem(item: ConversationWireItem): ChatSurfaceConversationItem {
  const sourceEventIds = uniqueStrings([
    item.kind === "agent_work" ? item.event_range?.from_event_id : undefined,
    item.kind === "agent_work" ? item.event_range?.to_event_id : undefined,
    ...item.source_event_ids,
  ].filter((id): id is string => Boolean(id)));

  const base = {
    id: item.id,
    created_at: item.created_at,
    updated_at: item.updated_at,
    ...(item.turn_id !== undefined ? { turn_id: item.turn_id } : {}),
    status: item.status,
    revision: item.revision,
    debug: {
      projection: "conversation" as const,
      source_event_ids: sourceEventIds,
      source_event_ranges: item.source_event_ranges,
    },
  };

  if (item.kind === "user_message" || item.kind === "assistant_message") {
    return {
      ...base,
      kind: item.kind,
      text: item.text,
      parts: item.parts ?? [],
    };
  }

  if (item.kind === "turn_meta") {
    return {
      ...base,
      kind: "turn_meta",
      turn_id: item.turn_id,
      completed_at: item.status === "running" ? null : item.updated_at,
    };
  }

  if (item.kind === "agent_work") {
    return {
      ...base,
      kind: "agent_work",
      id: item.id,
      title: item.title,
      summary: item.summary ?? "",
      ...(item.detail !== undefined ? { detail: item.detail } : {}),
      ...(item.event_range !== undefined ? { event_range: item.event_range } : {}),
    };
  }

  return {
    ...base,
    kind: "status",
    text: item.text,
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
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
