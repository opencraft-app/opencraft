import type {
  ChatSurface,
  ChatSurfaceDebug,
  ChatSurfacePendingRequest,
  ChatTranscriptPart,
  ChatSurfaceTranscriptRow,
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
  createdAt: string;
  debug: ChatSurfaceDebug;
}

export type ChatRenderRow =
  | {
      kind: "user_message";
      id: string;
      key: string;
      text: string;
      copy_text: string;
      collapsed: boolean;
      parts: ChatTranscriptPart[];
      createdAt: string;
      debug: ChatSurfaceDebug;
    }
  | {
      kind: "assistant_message";
      id: string;
      key: string;
      blocks: MarkdownBlock[];
      status: string;
      streaming: boolean;
      updatedAt?: string;
      settledLabel?: string;
      revision: number;
      createdAt: string;
      debug: ChatSurfaceDebug;
    }
  | AgentWorkRenderRow
  | {
      kind: "status";
      id: string;
      key: string;
      label: string;
      createdAt: string;
      debug: ChatSurfaceDebug;
    };

export interface MarkdownBlock {
  id: string;
  text: string;
}

export function buildChatRenderModel(surface: ChatSurface, host: ChatHostPolicy): ChatRenderModel {
  const transcriptRows = surface.transcript.rows.map((row) => renderTranscriptRow(row));
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
        createdAt: item.updated_at ?? item.created_at,
        debug: item.debug,
      },
    ];
  });
  const rows = applyMessageBoundaryLabels(sortRenderRows([...transcriptRows, ...toolRows, ...activityRows]));

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

function renderPendingRequest(request: ChatSurfacePendingRequest): RequestDockRenderItem {
  return {
    id: request.id,
    type: request.type,
    title: request.title,
    description: request.description,
    status: request.status,
    confirmable: isConfirmableRequest(request),
    createdAt: request.created_at,
    debug: request.debug,
  };
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
      debug: row.debug,
    };
  }

  if (row.role === "assistant") {
    return {
      kind: "assistant_message",
      id: row.id,
      key: `assistant:${row.id}`,
      blocks: splitMarkdownBlocks(row.text).map((text, index) => ({
        id: `${row.id}:block:${index}`,
        text,
      })),
      status: row.status,
      streaming: row.status === "streaming" || row.status === "pending",
      updatedAt: row.updated_at,
      revision: row.revision,
      createdAt: row.created_at,
      debug: row.debug,
    };
  }

  return {
    kind: "status",
    id: row.id,
    key: `status:${row.id}`,
    label: row.text,
    createdAt: row.created_at,
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
  if (row.kind === "agent_work") return 1;
  if (row.kind === "assistant_message") return 2;
  return 3;
}

function applyMessageBoundaryLabels(rows: ChatRenderRow[]): ChatRenderRow[] {
  let currentUserStartedAt: string | undefined;

  return rows.map((row) => {
    if (row.kind === "user_message") {
      currentUserStartedAt = row.createdAt;
      return row;
    }
    if (row.kind !== "assistant_message" || row.streaming) return row;

    const durationLabel = currentUserStartedAt
      ? formatWorkedFor(currentUserStartedAt, row.updatedAt ?? row.createdAt)
      : undefined;

    if (!durationLabel) return row;
    return {
      ...row,
      settledLabel: durationLabel,
    };
  });
}

function formatWorkedFor(startIso: string, endIso: string): string | undefined {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;

  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `Worked for ${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return remainder === 0 ? `Worked for ${minutes}m` : `Worked for ${minutes}m ${remainder}s`;
  }

  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder === 0
    ? `Worked for ${hours}h`
    : `Worked for ${hours}h ${minuteRemainder}m`;
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
