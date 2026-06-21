import type {
  ChatHostPolicy,
  ChatRenderModel,
  ChatRenderRow,
  MarkdownBlock,
} from "../../../vela-chat-render-model/src";

type UserMessagePart = Extract<ChatRenderRow, { kind: "user_message" }>["parts"][number];

export interface WebChatModel {
  sessionId: string;
  host: ChatHostPolicy;
  turns: WebTurn[];
  composer: {
    placeholder: string;
    canSend: boolean;
  };
}

export interface WebTurn {
  id: string;
  key: string;
  fingerprint: string;
  live: boolean;
  sourceTurnId?: string;
  sourceAgentWorkId?: string;
  blocks: WebBlock[];
}

export type WebBlock =
  | {
      kind: "user_message";
      id: string;
      key: string;
      text: string;
      copyText: string;
      collapsed: boolean;
      parts: UserMessagePart[];
      createdAt: string;
      sourceTurnId?: string;
      sourceAgentWorkId?: string;
    }
  | {
      kind: "assistant_markdown";
      id: string;
      key: string;
      blocks: MarkdownBlock[];
      createdAt: string;
      streaming: boolean;
      sourceTurnId?: string;
      sourceAgentWorkId?: string;
    }
  | {
      kind: "turn_meta";
      id: string;
      key: string;
      label: string;
      status: "running" | "completed" | "failed" | "cancelled";
      createdAt: string;
      updatedAt?: string;
      completedAt?: string;
      sourceTurnId?: string;
      sourceAgentWorkId?: string;
    }
  | {
      kind: "agent_work";
      id: string;
      key: string;
      title: string;
      summary: string;
      status: string;
      display: "compact" | "prominent";
      createdAt: string;
      updatedAt?: string;
      sourceTurnId?: string;
      sourceAgentWorkId?: string;
    }
  | {
      kind: "status";
      id: string;
      key: string;
      label: string;
      status: string;
      createdAt: string;
      sourceTurnId?: string;
      sourceAgentWorkId?: string;
    };

const MAX_CACHED_WEB_TURNS = 5_000;
const webTurnCache = new Map<string, WebTurn>();

export function toWebChatModel(model: ChatRenderModel): WebChatModel {
  return {
    sessionId: model.session_id,
    host: model.host,
    turns: groupRowsIntoTurns(model.session_id, model.rows),
    composer: {
      placeholder: model.composer.placeholder,
      canSend: model.composer.can_send,
    },
  };
}

function groupRowsIntoTurns(sessionId: string, rows: ChatRenderRow[]): WebTurn[] {
  const turns: WebTurn[] = [];
  let currentRows: ChatRenderRow[] = [];

  const flush = () => {
    if (currentRows.length === 0) return;
    turns.push(rowsToTurn(sessionId, currentRows));
    currentRows = [];
  };

  for (const row of rows) {
    if (row.kind === "user_message") {
      flush();
      currentRows = [row];
      continue;
    }

    if (currentRows.length === 0) {
      turns.push(rowsToTurn(sessionId, [row]));
      continue;
    }

    currentRows.push(row);
  }

  flush();
  return turns;
}

function rowsToTurn(sessionId: string, rows: ChatRenderRow[]): WebTurn {
  if (rows.length === 1) {
    return rowToTurn(sessionId, rows[0]!);
  }

  const fingerprint = rows.map(rowFingerprint).join("|");
  const first = rows[0]!;
  const sourceTurnId = first.turnId ?? rows.find((row) => row.turnId)?.turnId;
  const sourceAgentWorkId = rows.length === 1 ? first.agentWorkId : undefined;
  const cacheKey = [
    sessionId,
    "turn_shell",
    rows.map((row) => row.key).join(","),
    `turn:${sourceTurnId ?? ""}`,
    fingerprint,
  ].join(":");
  const cached = webTurnCache.get(cacheKey);
  if (cached) return cached;

  const blocks = rows.map((row) => rowToBlock(row));
  const turn = {
    id: sourceTurnId ?? first.id,
    key: `turn:${sourceTurnId ?? first.key}`,
    fingerprint,
    live: rows.some(isLiveRenderRow),
    sourceTurnId,
    sourceAgentWorkId,
    blocks,
  };
  webTurnCache.set(cacheKey, turn);
  evictOldestWebTurnIfNeeded();
  return turn;
}

function rowToTurn(sessionId: string, row: ChatRenderRow): WebTurn {
  const fingerprint = rowFingerprint(row);
  const cacheKey = [
    sessionId,
    row.kind,
    row.key,
    `turn:${row.turnId ?? ""}`,
    `agent_work:${row.agentWorkId ?? ""}`,
    fingerprint,
  ].join(":");
  const cached = webTurnCache.get(cacheKey);
  if (cached) return cached;

  const block = rowToBlock(row);
  const turn = {
    id: row.id,
    key: `turn:${row.key}`,
    fingerprint,
    live: isLiveRenderRow(row),
    sourceTurnId: row.turnId,
    sourceAgentWorkId: row.agentWorkId,
    blocks: [block],
  };
  webTurnCache.set(cacheKey, turn);
  evictOldestWebTurnIfNeeded();
  return turn;
}

function isLiveRenderRow(row: ChatRenderRow): boolean {
  if (row.kind === "assistant_message") return row.streaming;
  if (row.kind === "agent_work") return row.status === "running" || row.status === "pending";
  if (row.kind === "turn_meta") return row.status === "running";
  if (row.kind !== "status") return false;
  return row.label === "处理中" || row.label.startsWith("处理中 ");
}

function rowFingerprint(row: ChatRenderRow): string {
  if (row.kind === "assistant_message") {
    const textLength = row.blocks.reduce((total, block) => total + block.text.length, 0);
    const blockHash = hashString(
      row.blocks.map((block) => `${block.id}:${block.text}`).join("\n---block---\n"),
    );
    return `${row.key}:created:${hashString(row.createdAt)}:${row.status}:streaming:${row.streaming}:rev:${row.revision}:len:${textLength}:hash:${blockHash}`;
  }
  if (row.kind === "user_message") {
    return `${row.key}:created:${hashString(row.createdAt)}:collapsed:${row.collapsed}:len:${row.text.length}:text:${hashString(row.text)}:copy:${hashString(row.copy_text)}:parts:${partsFingerprint(row.parts)}`;
  }
  if (row.kind === "agent_work") {
    return `${row.key}:${row.status}:display:${row.display}:created:${hashString(row.createdAt)}:updated:${hashString(row.updatedAt ?? "")}:title:${hashString(row.title)}:summary:${hashString(row.summary)}`;
  }
  if (row.kind === "turn_meta") {
    return `${row.key}:created:${hashString(row.createdAt)}:updated:${hashString(row.updatedAt ?? "")}:completed:${hashString(row.completedAt ?? "")}:status:${row.status}:label:${hashString(row.label)}`;
  }
  return `${row.key}:created:${hashString(row.createdAt)}:status:${row.status}:label:${hashString(row.label)}`;
}

function rowToBlock(row: ChatRenderRow): WebBlock {
  if (row.kind === "user_message") {
    return {
      kind: "user_message",
      id: row.id,
      key: row.key,
      text: row.text,
      copyText: row.copy_text,
      collapsed: row.collapsed,
      parts: row.parts,
      createdAt: row.createdAt,
      sourceTurnId: row.turnId,
      sourceAgentWorkId: row.agentWorkId,
    };
  }

  if (row.kind === "assistant_message") {
    return {
      kind: "assistant_markdown",
      id: row.id,
      key: row.key,
      blocks: row.blocks,
      createdAt: row.createdAt,
      streaming: row.streaming,
      sourceTurnId: row.turnId,
      sourceAgentWorkId: row.agentWorkId,
    };
  }

  if (row.kind === "turn_meta") {
    return {
      kind: "turn_meta",
      id: row.id,
      key: row.key,
      label: row.label,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt,
      sourceTurnId: row.turnId,
      sourceAgentWorkId: row.agentWorkId,
    };
  }

  if (row.kind === "agent_work") {
    return {
      kind: "agent_work",
      id: row.id,
      key: row.key,
      title: row.title,
      summary: row.summary,
      status: row.status,
      display: row.display,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sourceTurnId: row.turnId,
      sourceAgentWorkId: row.agentWorkId,
    };
  }

  return {
    kind: "status",
    id: row.id,
    key: row.key,
    label: row.label,
    status: row.status,
    createdAt: row.createdAt,
    sourceTurnId: row.turnId,
    sourceAgentWorkId: row.agentWorkId,
  };
}

function partsFingerprint(parts: UserMessagePart[]): string {
  return parts
    .map((part) => {
      const data = part.data;
      const encodedLength =
        typeof data?.data === "string" ? data.data.length : 0;
      const encodedHash = typeof data?.data === "string" ? hashString(data.data) : "";
      const mimeType = typeof data?.mime_type === "string" ? data.mime_type : "";
      const sha256 = typeof data?.sha256 === "string" ? data.sha256 : "";
      const blobId = typeof data?.blob_id === "string" ? data.blob_id : "";
      const sizeBytes =
        typeof data?.size_bytes === "number" && Number.isFinite(data.size_bytes)
          ? data.size_bytes
          : "";
      return `${part.id}:${part.type}:text:${hashString(part.text ?? "")}:mime:${mimeType}:sha:${sha256}:blob:${blobId}:size:${sizeBytes}:data:${encodedLength}:${encodedHash}`;
    })
    .join("|");
}

function evictOldestWebTurnIfNeeded() {
  if (webTurnCache.size <= MAX_CACHED_WEB_TURNS) return;
  const oldestKey = webTurnCache.keys().next().value;
  if (typeof oldestKey === "string") {
    webTurnCache.delete(oldestKey);
  }
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
