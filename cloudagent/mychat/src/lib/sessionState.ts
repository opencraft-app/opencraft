import type { ListedSession } from "./acpClient";
import type { ConfigOption } from "./protocol";

export type RestoreState = "new" | "restoring" | "live" | "blocked" | "error";
export type SessionRowSource = "acp" | "draft";
export type SessionListStatus =
  | "idle"
  | "loading"
  | "ready"
  | "blocked"
  | "error";

export interface SessionRow {
  id: string;
  title: string;
  subtitle: string;
  sessionId?: string;
  cwd: string;
  readOnly?: boolean;
  readOnlyReason?: string;
  additionalDirectories?: string[];
  mcpServers?: unknown[];
  mcpServersAuthoritative: boolean;
  configOptions: ConfigOption[];
  restoreState: RestoreState;
  source: SessionRowSource;
}

export interface StoredUiState {
  activeSessionId?: string;
  gatewayURL?: string;
  sessionMetaTemplateId?: string;
  sessionCreateMetaJSON?: string;
}

export function rowsFromListedSessions(
  sessions: ListedSession[],
  previousRows: SessionRow[],
  defaultCwd: string,
): SessionRow[] {
  const previousBySession = new Map(
    previousRows
      .filter((row) => row.sessionId)
      .map((row) => [row.sessionId, row]),
  );
  const drafts = previousRows.filter(
    (row) => row.source === "draft" && !row.sessionId,
  );
  const acpRows = sessions.map((session): SessionRow => {
    const previous = previousBySession.get(session.sessionId);
    const cwd = session.cwd || previous?.cwd || defaultCwd;
    return {
      id: session.sessionId,
      title: session.title?.trim() || "New conversation",
      subtitle: session.updatedAt
        ? formatListedSessionTime(session.updatedAt)
        : cwd || "ACP session",
      sessionId: session.sessionId,
      cwd,
      readOnly: session.readOnly,
      readOnlyReason: session.readOnlyReason,
      additionalDirectories:
        session.additionalDirectories ?? previous?.additionalDirectories,
      mcpServers: previous?.mcpServersAuthoritative
        ? previous.mcpServers
        : undefined,
      mcpServersAuthoritative: previous?.mcpServersAuthoritative ?? false,
      configOptions: previous?.configOptions ?? [],
      restoreState: session.readOnly
        ? "blocked"
        : previous?.restoreState === "live"
          ? "live"
          : "new",
      source: "acp",
    };
  });

  return [...drafts, ...acpRows];
}

export function createDraftRow(
  id: string,
  cwd: string,
  mcpServers: unknown[] = [],
): SessionRow {
  return {
    id,
    title: "New conversation",
    subtitle: "主AGENTS",
    cwd,
    mcpServers,
    mcpServersAuthoritative: true,
    configOptions: [],
    restoreState: "new",
    source: "draft",
  };
}

export function promoteDraftToSession(
  rows: SessionRow[],
  draftId: string,
  sessionId: string,
  configOptions: ConfigOption[],
): SessionRow[] {
  return rows.map((row) =>
    row.id === draftId
      ? {
          ...row,
          id: sessionId,
          sessionId,
          readOnly: false,
          readOnlyReason: undefined,
          configOptions,
          restoreState: "live",
          source: "acp",
        }
      : row,
  );
}

export function updateRowRestoreState(
  rows: SessionRow[],
  rowId: string,
  restoreState: RestoreState,
): SessionRow[] {
  return rows.map((row) => (row.id === rowId ? { ...row, restoreState } : row));
}

export function updateRowConfigOptions(
  rows: SessionRow[],
  rowId: string,
  configOptions: ConfigOption[],
): SessionRow[] {
  return rows.map((row) =>
    row.id === rowId ? { ...row, configOptions } : row,
  );
}

export function removeSessionRow(rows: SessionRow[], rowId: string): SessionRow[] {
  return rows.filter((row) => row.id !== rowId);
}

export function markRowsDisconnected(rows: SessionRow[]): SessionRow[] {
  return rows.map((row) => {
    if (row.restoreState === "restoring")
      return { ...row, restoreState: "error" };
    if (row.restoreState === "live") return { ...row, restoreState: "new" };
    return row;
  });
}

export function canStartSessionOpen(
  row: Pick<SessionRow, "restoreState">,
): boolean {
  return row.restoreState !== "restoring";
}

export function removeTranscriptForSession<
  T extends { conversationId: string },
>(messages: T[], conversationId: string): T[] {
  return messages.filter(
    (message) => message.conversationId !== conversationId,
  );
}

export function resolveActiveRowId(
  rows: SessionRow[],
  preferredId?: string,
): string {
  if (preferredId && rows.some((row) => row.id === preferredId))
    return preferredId;
  return rows[0]?.id ?? "";
}

export function sanitizeStoredUiState(value: unknown): StoredUiState {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const candidate = record.activeSessionId ?? record.activeConversationId;
  const gatewayCandidate = record.gatewayURL;
  const templateCandidate = record.sessionMetaTemplateId;
  const metaCandidate = record.sessionCreateMetaJSON;
  const out: StoredUiState = {};
  if (typeof candidate === "string" && candidate)
    out.activeSessionId = candidate;
  if (typeof gatewayCandidate === "string" && gatewayCandidate.trim()) {
    out.gatewayURL = gatewayCandidate.trim();
  }
  if (typeof templateCandidate === "string" && templateCandidate.trim()) {
    out.sessionMetaTemplateId = templateCandidate.trim();
  }
  if (typeof metaCandidate === "string") {
    out.sessionCreateMetaJSON = metaCandidate;
  }
  return out;
}

function formatListedSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
