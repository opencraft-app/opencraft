export interface ChatSurfaceCursor {
  event_id?: string;
  epoch?: number;
  seq?: number;
  latest_event_id?: string;
  next_event_id?: string;
  has_more?: boolean;
  has_newer?: boolean;
  has_older?: boolean;
}

export interface ChatTranscriptWindow {
  first_row_id?: string | null;
  last_row_id?: string | null;
  anchor_row_id?: string | null;
  has_older: boolean;
  has_newer: boolean;
}

export interface ChatTranscriptWireRow {
  id: string;
  kind: "user_message" | "assistant_message" | "working" | "activity_marker" | "error";
  created_at: string;
  updated_at?: string;
  revision?: number;
  text?: string;
  parts?: ChatTranscriptPart[];
  status?: string;
  source_event_ids?: string[];
}

export interface ChatTranscriptPart {
  id: string;
  type: "markdown" | "text" | "code" | "image" | "file_reference" | string;
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

export interface ChatTranscriptWireView {
  session_id?: string;
  rows: ChatTranscriptWireRow[];
  cursor: ChatSurfaceCursor;
  window?: ChatTranscriptWindow;
}

export interface ActivityWireItem {
  id: string;
  kind: string;
  status: string;
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
  | {
      type: "shell";
      command?: string;
      cwd?: string;
      output?: string;
      stdout?: string;
      stderr?: string;
      exit_code?: number;
      error?: string;
    }
  | {
      type: "read" | "edit" | "write";
      file_path?: string;
      path?: string;
      content?: string;
      old_string?: string;
      new_string?: string;
      unified_diff?: string;
    }
  | {
      type: "search";
      query?: string;
      mode?: string;
      content?: string;
      num_files?: number;
      num_matches?: number;
      duration_ms?: number;
      truncated?: boolean;
    }
  | {
      type: "fetch";
      url?: string;
      prompt?: string;
      result?: string;
      code?: number;
      code_text?: string;
      bytes?: number;
      duration_ms?: number;
    }
  | {
      type:
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
      [key: string]: unknown;
    }
  | {
      type: string;
      [key: string]: unknown;
    };

export interface ActivityWireView {
  session_id?: string;
  items: ActivityWireItem[];
  window?: ActivityWindow;
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
  updated_at?: string;
  status: string;
  revision: number;
  debug: ChatSurfaceDebug;
}

export interface ChatSurfaceActivityItem {
  id: string;
  kind: string;
  status: string;
  title: string;
  summary: string;
  detail?: ActivityWireDetail;
  created_at: string;
  updated_at?: string;
  debug: ChatSurfaceDebug;
}

export interface ChatSurface {
  session_id: string;
  transcript: {
    rows: ChatSurfaceTranscriptRow[];
    window?: ChatTranscriptWindow;
  };
  activity: {
    items: ChatSurfaceActivityItem[];
    window?: ActivityWindow;
  };
  pending_requests: {
    items: unknown[];
  };
  cursors: {
    transcript?: ChatSurfaceCursor;
    activity?: ChatSurfaceCursor;
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
    includeLive: false;
    limit: number;
  } | null;
  activity: {
    direction: "before";
    anchorItemId: string;
    limit: number;
  } | null;
}

export interface ConversationWindowInput {
  transcript?: Pick<ChatTranscriptWireView, "window"> | null;
  activity?: Pick<ActivityWireView, "window"> | null;
}

export interface ConversationHistoryPrependPlanInput extends ConversationWindowInput {
  limit?: number;
}

export function buildChatSurfaceFromReadModels(input: BuildChatSurfaceInput): ChatSurface {
  return {
    session_id: input.sessionId,
    transcript: {
      rows: input.transcript.rows.map(normalizeTranscriptRow),
      window: input.transcript.window,
    },
    activity: {
      items: input.activity?.items.map(normalizeActivityItem) ?? [],
      window: input.activity?.window,
    },
    pending_requests: { items: [] },
    cursors: {
      transcript: input.transcript.cursor,
      ...(input.activity ? { activity: input.activity.cursor } : {}),
    },
    stream: {
      connected: input.stream?.connected ?? false,
      running: input.stream?.running ?? false,
    },
  };
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
          includeLive: false as const,
          limit: normalizedLimit,
        }
      : null;
  const activityPlan =
    typeof firstActivityItemId === "string" && firstActivityItemId.length > 0
      ? {
          direction: "before" as const,
          anchorItemId: firstActivityItemId,
          limit: normalizedLimit,
        }
      : null;

  return {
    has_older: transcriptPlan !== null || activityPlan !== null,
    transcript: transcriptPlan,
    activity: activityPlan,
  };
}

export function prependTranscriptWindow<T extends ChatTranscriptWireView>(current: T, older: T): T {
  const seen = new Set<string>();
  const rows = [...older.rows, ...current.rows].filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });

  return {
    ...current,
    session_id: current.session_id ?? older.session_id,
    rows,
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
    cursor: older.cursor ?? current.cursor,
  } as T;
}

export function prependActivityWindow<T extends ActivityWireView>(current: T, older: T): T {
  const seen = new Set<string>();
  const items = [...older.items, ...current.items].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

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
    cursor: older.cursor ?? current.cursor,
  } as T;
}

function normalizeActivityItem(item: ActivityWireItem): ChatSurfaceActivityItem {
  const sourceEventIds = [
    item.event_range?.from_event_id,
    item.event_range?.to_event_id,
  ].filter((id): id is string => Boolean(id));
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    title: item.title,
    summary: item.summary ?? "",
    detail: item.detail,
    created_at: item.created_at,
    updated_at: item.updated_at,
    debug: {
      projection: "activity",
      source_event_ids: sourceEventIds.length > 0 ? sourceEventIds : [item.id],
    },
  };
}

function normalizeTranscriptRow(row: ChatTranscriptWireRow): ChatSurfaceTranscriptRow {
  return {
    id: row.id,
    role: transcriptKindToRole(row.kind),
    text: row.text ?? "",
    parts: row.parts ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: row.status ?? "completed",
    revision: row.revision ?? 1,
    debug: {
      projection: "transcript",
      source_event_ids: row.source_event_ids?.length ? row.source_event_ids : [row.id],
    },
  };
}

function transcriptKindToRole(kind: ChatTranscriptWireRow["kind"]): ChatSurfaceTranscriptRow["role"] {
  if (kind === "user_message") return "user";
  if (kind === "assistant_message") return "assistant";
  if (kind === "activity_marker") return "activity";
  return "working";
}

function normalizeWindowLimit(limit: number) {
  if (!Number.isFinite(limit)) return 80;
  return Math.max(1, Math.floor(limit));
}
