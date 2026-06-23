import type {
  ChatSurface,
  ChatSurfaceConversationDebug,
  ChatSurfaceDebug,
  ChatSurfaceConversationItem,
  ChatSurfacePendingRequest,
  ChatSurfaceTurnMetaItem,
  ConversationMessagePart,
} from "../../vela-chat-surface/src";
import {
  type AgentWorkGroupRenderRow,
  groupAgentWorkRows,
  isGroupableAgentWork,
} from "./agent-work/grouping";
import {
  type AgentWorkRenderRow,
  renderAgentWorkRows,
} from "./agent-work/tools";

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
    is_running: boolean;
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
  agentWorkId?: string;
}

export type UserMessageRenderRow = {
  kind: "user_message";
  id: string;
  key: string;
  text: string;
  copy_text: string;
  collapsed: boolean;
  parts: ConversationMessagePart[];
  createdAt: string;
  debug: ChatSurfaceConversationDebug;
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
  debug: ChatSurfaceConversationDebug;
} & ChatRenderCorrelation;

export type StatusRenderRow = {
  kind: "status";
  id: string;
  key: string;
  label: string;
  status: string;
  createdAt: string;
  debug: ChatSurfaceConversationDebug;
} & ChatRenderCorrelation;

export type TurnMetaRenderRow = {
  kind: "turn_meta";
  id: string;
  key: string;
  label: string;
  status: TurnMetaStatus;
  createdAt: string;
  updatedAt?: string;
  completedAt?: string;
  debug: ChatSurfaceConversationDebug;
} & ChatRenderCorrelation;

export type TurnMetaStatus = "running" | "completed" | "failed" | "cancelled";

export type ChatRenderRow =
  | UserMessageRenderRow
  | AssistantMessageRenderRow
  | TurnMetaRenderRow
  | AgentWorkRenderRow
  | AgentWorkGroupRenderRow
  | StatusRenderRow;

export interface MarkdownBlock {
  id: string;
  text: string;
}

export function buildChatRenderModel(surface: ChatSurface, host: ChatHostPolicy): ChatRenderModel {
  const turnById = new Map(
    surface.conversation.items
      .filter(isTurnMetaItem)
      .map((turn) => [turn.turn_id, turn]),
  );
  const conversationRows = surface.conversation.items
    .filter((item) => shouldRenderConversationItem(item, turnById))
    .flatMap((item): ChatRenderRow[] => {
      if (item.kind === "agent_work") return renderAgentWorkRows([item]);
      return [renderConversationItem(item)];
    });
  const rows = applyTurnMetaRows(
    groupAgentWorkRuns(sortRenderRows(conversationRows)),
    Array.from(turnById.values()),
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
      is_running: surface.stream.running,
    },
  };
}

function shouldRenderConversationItem(
  item: ChatSurfaceConversationItem,
  turnById: ReadonlyMap<string, ChatSurfaceTurnMetaItem>,
): boolean {
  if (item.kind !== "status") return true;
  if (!item.turn_id) return true;

  const turn = turnById.get(item.turn_id);
  if (!turn || turn.status === "running") return true;

  return !isRunningStatusItem(item);
}

function isRunningStatusItem(item: ChatSurfaceConversationItem): boolean {
  return (
    item.kind === "status" &&
    (item.status === "pending" ||
      item.status === "streaming" ||
      item.text === "处理中" ||
      item.text.startsWith("处理中 "))
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

function renderConversationItem(
  item: Exclude<ChatSurfaceConversationItem, { kind: "agent_work" }>,
): ChatRenderRow {
  if (item.kind === "user_message") {
    const text = item.text || textFromMessageParts(item.parts);
    const collapsed = text.length > USER_COLLAPSE_LIMIT;
    return {
      kind: "user_message",
      id: item.id,
      key: `user:${item.id}`,
      text: collapsed ? `${text.slice(0, USER_COLLAPSE_LIMIT).trimEnd()}...` : text,
      copy_text: text,
      collapsed,
      parts: item.parts,
      createdAt: item.created_at,
      ...(item.turn_id !== undefined ? { turnId: item.turn_id } : {}),
      debug: item.debug,
    };
  }

  if (item.kind === "assistant_message") {
    const text = item.text || textFromMessageParts(item.parts);
    return {
      kind: "assistant_message",
      id: item.id,
      key: `assistant:${item.id}`,
      blocks: splitMarkdownBlocks(text).map((text, index) => ({
        id: `${item.id}:block:${index}`,
        text,
      })),
      status: item.status,
      streaming: item.status === "streaming" || item.status === "pending",
      updatedAt: item.updated_at,
      revision: item.revision,
      createdAt: item.created_at,
      ...(item.turn_id !== undefined ? { turnId: item.turn_id } : {}),
      debug: item.debug,
    };
  }

  if (item.kind === "turn_meta") return buildTurnMetaRow(item);

  return {
    kind: "status",
    id: item.id,
    key: `status:${item.id}`,
    label: item.text,
    status: item.status,
    createdAt: item.created_at,
    ...(item.turn_id !== undefined ? { turnId: item.turn_id } : {}),
    debug: item.debug,
  };
}

function textFromMessageParts(parts: ConversationMessagePart[]): string {
  return parts
    .filter(isTextualMessagePart)
    .map((part) => part.text)
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

function isTextualMessagePart(part: ConversationMessagePart): boolean {
  return part.type === "text";
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
  if (row.kind === "agent_work_group") return 1;
  if (row.kind === "assistant_message") return 2;
  return 3;
}

function groupAgentWorkRuns(rows: ChatRenderRow[]): ChatRenderRow[] {
  const output: ChatRenderRow[] = [];
  let pending: AgentWorkRenderRow[] = [];

  const flush = () => {
    if (pending.length > 0) {
      output.push(...groupAgentWorkRows(pending));
      pending = [];
    }
  };

  for (const row of rows) {
    if (row.kind === "agent_work" && isGroupableAgentWork(row)) {
      pending.push(row);
      continue;
    }

    flush();
    output.push(row);
  }

  flush();
  return output;
}

function applyTurnMetaRows(
  rows: ChatRenderRow[],
  turns: readonly ChatSurfaceTurnMetaItem[],
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

    if (row.kind === "turn_meta") {
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

function buildTurnMetaRow(turn: ChatSurfaceTurnMetaItem): ChatRenderRow {
  const updatedAt = turn.completed_at ?? turn.created_at;
  const label =
    turn.status === "running"
      ? "处理中"
      : formatProcessedFor(turn.created_at, updatedAt) ?? "已处理";

  return {
    kind: "turn_meta",
    id: `turn_meta:${turn.turn_id}`,
    key: `turn_meta:${turn.turn_id}`,
    label,
    status: normalizeTurnMetaStatus(turn.status),
    createdAt: turn.created_at,
    updatedAt,
    ...(turn.completed_at ? { completedAt: turn.completed_at } : {}),
    turnId: turn.turn_id,
    debug: turn.debug,
  };
}

function isTurnMetaItem(item: ChatSurfaceConversationItem): item is ChatSurfaceTurnMetaItem {
  return item.kind === "turn_meta";
}

function normalizeTurnMetaStatus(status: ChatSurfaceTurnMetaItem["status"]): TurnMetaStatus {
  if (status === "completed" || status === "failed" || status === "cancelled") {
    return status;
  }
  return "running";
}

function formatProcessedFor(startIso: string, endIso: string): string | undefined {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;

  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds === 0) return "已处理 <1s";
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
