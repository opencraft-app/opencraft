import type { MessageSender } from "./message-sender";
export type ThreadHistoryItemsView = "full" | "notLoaded";
export type ThreadHistorySortDirection = "asc" | "desc";

export interface ThreadTurnsPageRequest {
  limit: number | null;
  itemsView: ThreadHistoryItemsView;
  sortDirection: ThreadHistorySortDirection;
}

export interface ThreadHistoryCursors {
  itemsBackwardsCursor?: string | null;
  turnsBackwardsCursor?: string | null;
}

export interface AppServerThreadItem {
  /** Host-owned user-message provenance; absent on native/legacy items. */
  readonly sender?: MessageSender | null;
  id: string;
  type?: string;
  [field: string]: unknown;
}

export interface AppServerTurn {
  id: string;
  items?: readonly AppServerThreadItem[];
  itemsView?: ThreadHistoryItemsView | "summary";
  [field: string]: unknown;
}

export interface AppServerThread {
  id: string;
  sessionId?: string;
  name?: string | null;
  cwd?: string;
  path?: string | null;
  historyMode?: "legacy" | "paginated" | string;
  status?: unknown;
  turns: readonly AppServerTurn[];
  [field: string]: unknown;
}

export interface ThreadTurnsListRequest {
  threadId: string;
  cursor: string | null;
  limit: number | null;
  itemsView: ThreadHistoryItemsView | "summary";
  sortDirection: ThreadHistorySortDirection;
}

export interface ThreadItemsListRequest {
  threadId: string;
  turnId: string;
  cursor: string | null;
  limit: number;
  sortDirection: ThreadHistorySortDirection;
}

export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
}

export interface ThreadTurnsPage<TTurn> extends CursorPage<TTurn> {
  backwardsCursor?: string | null;
  itemsPaginationByTurnId?: Readonly<Record<string, unknown>>;
}

export interface ThreadItemPageEntry {
  /** Provider lifecycle clocks, separate from the nested protocol Item. */
  startedAtMs?: number | null;
  completedAtMs?: number | null;
  turnId?: string;
  item?: AppServerThreadItem;
  [field: string]: unknown;
}

/**
 * Optional tail-hydration extension for `thread/resume`.
 * The remaining resume fields stay owned by the generated AppServer schema.
 */
/** Provider-owned history position; valid across client connections only. */
export interface ThreadHistoryCheckpoint {
  epoch: string;
  nextSeq: number;
}
export interface ThreadHistoryRecovery {
  checkpoint: ThreadHistoryCheckpoint;
  mode: "unchanged" | "append" | "replace";
}
export interface ThreadResumeHistoryRequest {
  historyCheckpoint?: ThreadHistoryCheckpoint;
  excludeTurns: boolean;
  initialTurnsPage?: ThreadTurnsPageRequest;
}

/** Fields read from the latest `thread/resume` response by Desktop. */
export interface ThreadResumeHistoryResponse<TTurn> extends ThreadHistoryCursors {
  initialTurnsPage?: ThreadTurnsPage<TTurn> | null;
  historyRecovery?: ThreadHistoryRecovery;
  runtimeWorkspaceRoots: string[];
}

export interface ResumeHistoryCapabilities {
  useTailHydration: boolean;
  isDurableHost: boolean;
  supportsPaginatedHistory: boolean;
  supportsInitialTurnsPage?: boolean;
}

/** Prefer an explicitly advertised initial page regardless of Host placement. */
export function buildResumeHistoryRequest({
  useTailHydration,
  isDurableHost,
  supportsPaginatedHistory,
  supportsInitialTurnsPage = false,
}: ResumeHistoryCapabilities): ThreadResumeHistoryRequest {
  return {
    excludeTurns: useTailHydration,
    ...(useTailHydration && (supportsInitialTurnsPage || (!isDurableHost && !supportsPaginatedHistory))
      ? {
          initialTurnsPage: {
            limit: 5,
            itemsView: "full" as const,
            sortDirection: "desc" as const,
          },
        }
      : {}),
  };
}
