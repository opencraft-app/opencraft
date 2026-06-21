import type {
  ChatSurface,
  ChatSurfaceDebug,
  ChatSurfacePendingRequest,
  ChatTranscriptPart,
  ChatSurfaceTranscriptRow,
  ChatSurfaceTranscriptTurn,
} from "../../vela-chat-surface/src";
import {
  type AgentWorkRenderRow,
  renderToolActivityRows,
} from "./activity/tools";

const USER_COLLAPSE_LIMIT = 600;

export type ChatHostKind = "mobile_web" | "desktop_web" | "desktop_shell";

export interface ChatHostPolicy {
  kind: ChatHostKind;
}

export interface ChatRenderModel {
  session_id: string;
  host: ChatHostPolicy;
  rows: ChatRenderRow[];
  requests: RequestDockRenderModel;
  composer: {
    placeholder: string;
    can_send: boolean;
  };
}

export interface RequestDockRenderModel {
  items: RequestDockRenderItem[];
}

export interface RequestDockRenderItem {
  id: string;
  type: string;
  title: string;
  description: string;
  status: string;
  confirmable: boolean;
  response_kind: "confirmation" | "answer" | "unsupported";
  createdAt: string;
  debug: ChatSurfaceDebug;
}

interface ChatRenderCorrelation {
  turnId?: string;
  activityId?: string;
}

export type UserMessageRenderRow = {
  kind: "user_message";
  id: string;
  key: string;
  text: string;
  copy_text: string;
  collapsed: boolean;
  parts: ChatTranscriptPart[];
  createdAt: string;
  debug: ChatSurfaceDebug;
} & ChatRenderCorrelation;

export type AssistantMessageRenderRow = {
  kind: "assistant_message";
  id: string;
  key: string;
  blocks: MarkdownBlock[];
  status: string;
  streaming: boolean;
  updatedAt?: string;
  revision: number;
  createdAt: string;
  debug: ChatSurfaceDebug;
} & ChatRenderCorrelation;

export type StatusRenderRow = {
  kind: "status";
  id: string;
  key: string;
  label: string;
  status: string;
  createdAt: string;
  debug: ChatSurfaceDebug;
} & ChatRenderCorrelation;

export type TurnMetaRenderRow = {
  kind: "turn_meta";
  id: string;
  key: string;
  label: string;
  status: ChatSurfaceTranscriptTurn["status"];
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  debug: ChatSurfaceDebug;
} & ChatRenderCorrelation;

export type ChatRenderRow =
  | UserMessageRenderRow
  | AssistantMessageRenderRow
  | TurnMetaRenderRow
  | AgentWorkRenderRow
  | StatusRenderRow;

export interface MarkdownBlock {
  id: string;
  text: string;
}

export function buildChatRenderModel(surface: ChatSurface, host: ChatHostPolicy): ChatRenderModel {
  const turnById = new Map(
    surface.transcript.turns.map((turn) => [turn.turn_id, turn]),
  );
  const transcriptRows = surface.transcript.rows
    .filter((row) => shouldRenderTranscriptRow(row, turnById))
    .map((row) => renderTranscriptRow(row));
  const toolRows = renderToolActivityRows(surface.activity.items);
  const activityRows = surface.activity.items.flatMap((item): ChatRenderRow[] => {
    if (item.kind === "tool") return [];
    if (item.status !== "failed") return [];
    const label = item.summary || item.title;
    if (!label) return [];
    return [
      {
        kind: "status",
        id: item.id,
        key: `activity:${item.id}`,
        label: `处理失败：${label}`,
        status: item.status,
        createdAt: item.updated_at ?? item.created_at,
        ...(item.turn_id !== undefined ? { turnId: item.turn_id } : {}),
        activityId: item.id,
        debug: item.debug,
      },
    ];
  });
  const rows = applyTurnMetaRows(
    sortRenderRows([...transcriptRows, ...toolRows, ...activityRows]),
    surface.transcript.turns,
  );

  return {
    session_id: surface.session_id,
    host,
    rows,
    requests: {
      items: surface.pending_requests.items.map(renderPendingRequest),
    },
    composer: {
      placeholder: "要求后续变更",
      can_send: true,
    },
  };
}

function shouldRenderTranscriptRow(
  row: ChatSurfaceTranscriptRow,
  turnById: ReadonlyMap<string, ChatSurfaceTranscriptTurn>,
): boolean {
  if (row.role !== "working" && row.role !== "activity") return true;
  if (!row.turn_id) return true;

  const turn = turnById.get(row.turn_id);
  if (!turn || turn.status === "running") return true;

  return !isRunningStatusRow(row);
}

function isRunningStatusRow(row: ChatSurfaceTranscriptRow): boolean {
  return (
    row.status === "pending" ||
    row.status === "streaming" ||
    row.text === "处理中" ||
    row.text.startsWith("处理中 ")
  );
}

function renderPendingRequest(request: ChatSurfacePendingRequest): RequestDockRenderItem {
  return {
    id: request.id,
    type: request.type,
    title: request.title,
    description: request.description,
    status: request.status,
    confirmable: isConfirmableRequest(request),
    response_kind: responseKindForRequest(request),
    createdAt: request.created_at,
    debug: request.debug,
  };
}

function responseKindForRequest(
  request: ChatSurfacePendingRequest,
): RequestDockRenderItem["response_kind"] {
  if (isConfirmableRequest(request)) return "confirmation";
  if (
    request.status === "pending" &&
    (request.type === "question" || request.type === "custom_input")
  ) {
    return "answer";
  }
  return "unsupported";
}

function isConfirmableRequest(request: ChatSurfacePendingRequest): boolean {
  return (
    request.status === "pending" &&
    (request.type === "permission" ||
      request.type === "tool_confirmation" ||
      request.type === "tool_call")
  );
}

function renderTranscriptRow(row: ChatSurfaceTranscriptRow): ChatRenderRow {
  if (row.role === "user") {
    const text = row.text || textFromTranscriptParts(row.parts);
    const collapsed = text.length > USER_COLLAPSE_LIMIT;
    return {
      kind: "user_message",
      id: row.id,
      key: `user:${row.id}`,
      text: collapsed ? `${text.slice(0, USER_COLLAPSE_LIMIT).trimEnd()}...` : text,
      copy_text: text,
      collapsed,
      parts: row.parts,
      createdAt: row.created_at,
      ...(row.turn_id !== undefined ? { turnId: row.turn_id } : {}),
      ...(row.activity_id !== undefined ? { activityId: row.activity_id } : {}),
      debug: row.debug,
    };
  }

  if (row.role === "assistant") {
    const text = row.text || textFromTranscriptParts(row.parts);
    return {
      kind: "assistant_message",
      id: row.id,
      key: `assistant:${row.id}`,
      blocks: splitMarkdownBlocks(text).map((text, index) => ({
        id: `${row.id}:block:${index}`,
        text,
      })),
      status: row.status,
      streaming: row.status === "streaming" || row.status === "pending",
      updatedAt: row.updated_at,
      revision: row.revision,
      createdAt: row.created_at,
      ...(row.turn_id !== undefined ? { turnId: row.turn_id } : {}),
      ...(row.activity_id !== undefined ? { activityId: row.activity_id } : {}),
      debug: row.debug,
    };
  }

  return {
    kind: "status",
    id: row.id,
    key: `status:${row.id}`,
    label: row.text,
    status: row.status,
    createdAt: row.created_at,
    ...(row.turn_id !== undefined ? { turnId: row.turn_id } : {}),
    ...(row.activity_id !== undefined ? { activityId: row.activity_id } : {}),
    debug: row.debug,
  };
}

function textFromTranscriptParts(parts: ChatTranscriptPart[]): string {
  return parts
    .filter(isTextualTranscriptPart)
    .map((part) => part.text)
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

function isTextualTranscriptPart(part: ChatTranscriptPart): boolean {
  return part.type === "text" || part.type === "markdown" || part.type === "code";
}

function sortRenderRows(rows: ChatRenderRow[]): ChatRenderRow[] {
  return [...rows].sort((a, b) => {
    const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (byTime !== 0) return byTime;
    return rowSortPriority(a) - rowSortPriority(b);
  });
}

function rowSortPriority(row: ChatRenderRow): number {
  if (row.kind === "user_message") return 0;
  if (row.kind === "turn_meta") return 1;
  if (row.kind === "agent_work") return 1;
  if (row.kind === "assistant_message") return 2;
  return 3;
}

function applyTurnMetaRows(
  rows: ChatRenderRow[],
  turns: readonly ChatSurfaceTranscriptTurn[],
): ChatRenderRow[] {
  const output: ChatRenderRow[] = [];
  const turnById = new Map(turns.map((turn) => [turn.turn_id, turn]));
  const emittedTurnIds = new Set<string>();

  for (const row of rows) {
    const turn = row.turnId ? turnById.get(row.turnId) : undefined;
    if (!turn) {
      output.push(row);
      continue;
    }

    if (row.kind === "user_message") {
      output.push(row);
      if (!emittedTurnIds.has(turn.turn_id)) {
        output.push(buildTurnMetaRow(turn));
        emittedTurnIds.add(turn.turn_id);
      }
      continue;
    }

    if (!emittedTurnIds.has(turn.turn_id)) {
      output.push(buildTurnMetaRow(turn));
      emittedTurnIds.add(turn.turn_id);
    }
    output.push(row);
  }

  return output;
}

function buildTurnMetaRow(turn: ChatSurfaceTranscriptTurn): ChatRenderRow {
  const updatedAt = turn.completed_at ?? turn.started_at;
  const label =
    turn.status === "running"
      ? "处理中"
      : formatProcessedFor(turn.started_at, updatedAt) ?? "已处理";

  return {
    kind: "turn_meta",
    id: `turn_meta:${turn.turn_id}`,
    key: `turn_meta:${turn.turn_id}`,
    label,
    status: turn.status,
    createdAt: turn.started_at,
    updatedAt,
    ...(turn.completed_at ? { completedAt: turn.completed_at } : {}),
    turnId: turn.turn_id,
    debug: turn.debug,
  };
}

function formatProcessedFor(startIso: string, endIso: string): string | undefined {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;

  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `已处理 ${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return remainder === 0 ? `已处理 ${minutes}m` : `已处理 ${minutes}m ${remainder}s`;
  }

  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder === 0
    ? `已处理 ${hours}h`
    : `已处理 ${hours}h ${minuteRemainder}m`;
}

function getFenceDelimiter(line: string) {
  const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  return match?.[2] ?? null;
}

export function splitMarkdownBlocks(text: string): string[] {
  if (text.length === 0) return [];

  const blocks: string[] = [];
  let currentLines: string[] = [];
  let activeFenceCharacter: "`" | "~" | null = null;
  let activeFenceLength = 0;
  let sawBlockSeparator = false;

  for (const line of text.split("\n")) {
    const isBlankLine = line.trim().length === 0;
    if (!activeFenceCharacter && isBlankLine) {
      if (currentLines.length > 0) sawBlockSeparator = true;
      continue;
    }
    if (!activeFenceCharacter && sawBlockSeparator) {
      blocks.push(currentLines.join("\n"));
      currentLines = [];
      sawBlockSeparator = false;
    }

    currentLines.push(line);
    const fenceDelimiter = getFenceDelimiter(line);
    if (!fenceDelimiter) continue;

    if (!activeFenceCharacter) {
      activeFenceCharacter = fenceDelimiter[0] as "`" | "~";
      activeFenceLength = fenceDelimiter.length;
      continue;
    }

    if (fenceDelimiter[0] === activeFenceCharacter && fenceDelimiter.length >= activeFenceLength) {
      activeFenceCharacter = null;
      activeFenceLength = 0;
    }
  }

  if (currentLines.length > 0) blocks.push(currentLines.join("\n"));
  return blocks.filter(Boolean);
}
