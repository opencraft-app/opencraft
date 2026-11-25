// Private Client -> WorkspaceHost read contract. Renderer frames never select a
// workspace, native RPC method, native lane or installation server identity.
import type { InstallationCoreNamespace } from "./bindings.js";
import { parseClientAttachment, type ClientAttachment } from "./client-attachment.js";
import { parseThreadPlacementReceipt, type ThreadPlacementReceipt } from "./thread-placement.js";

export const CODEX_THREAD_LOOKUP_PATH = "/__opencraft_internal/thread-placement/codex";
export const CODEX_HISTORY_RESPONSE_TOO_LARGE = -32072;
export const CODEX_HISTORY_PREVIEW_PAGE_LIMIT = 10;

const nonempty = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/u.test(value);

export interface CodexThreadRead {
  readonly threadId: string;
  readonly includeTurns?: boolean;
  readonly initialTurnsPage?: {
    readonly limit: number;
    readonly sortDirection: "desc";
    readonly itemsView: "full";
  };
}

export function parseCodexThreadRead(value: unknown): CodexThreadRead | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { threadId, includeTurns, initialTurnsPage } = value as Partial<CodexThreadRead>;
  if (
    !nonempty(threadId, 512) ||
    (includeTurns !== undefined && typeof includeTurns !== "boolean") ||
    Object.keys(value).some((key) => !["threadId", "includeTurns", "initialTurnsPage"].includes(key))
  )
    return null;
  if (initialTurnsPage === undefined) return { threadId, ...(includeTurns === undefined ? {} : { includeTurns }) };
  if (
    includeTurns === true ||
    !initialTurnsPage ||
    typeof initialTurnsPage !== "object" ||
    !Number.isInteger(initialTurnsPage.limit) ||
    initialTurnsPage.limit < 1 ||
    initialTurnsPage.limit > CODEX_HISTORY_PREVIEW_PAGE_LIMIT ||
    initialTurnsPage.itemsView !== "full" ||
    initialTurnsPage.sortDirection !== "desc" ||
    Object.keys(initialTurnsPage).some((key) => !["limit", "itemsView", "sortDirection"].includes(key))
  )
    return null;
  return { threadId, includeTurns: false, initialTurnsPage };
}

type HistoryPageParams = {
  readonly threadId: string;
  readonly cursor: string | null;
  readonly limit: number;
  readonly sortDirection: "asc" | "desc";
};

export type CodexHistoryRead =
  | { method: "thread/read"; params: CodexThreadRead }
  | { method: "thread/turns/list"; params: HistoryPageParams & { itemsView: "summary" | "full" | "notLoaded" } }
  | { method: "thread/items/list"; params: HistoryPageParams & { turnId?: string } };

export function initialCodexTurnsRead(
  params: CodexThreadRead,
): Extract<CodexHistoryRead, { method: "thread/turns/list" }> | undefined {
  return (
    params.initialTurnsPage && {
      method: "thread/turns/list",
      params: { threadId: params.threadId, cursor: null, ...params.initialTurnsPage },
    }
  );
}

export function parseCodexHistoryRead(method: unknown, value: unknown): CodexHistoryRead | null {
  if (method === undefined || method === "thread/read") {
    const params = parseCodexThreadRead(value);
    return params && { method: "thread/read" as const, params };
  }
  if (
    (method !== "thread/turns/list" && method !== "thread/items/list") ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return null;
  const params = value as Record<string, unknown>;
  const { threadId, turnId, cursor, limit, itemsView, sortDirection } = params;
  const turns = method === "thread/turns/list";
  if (
    !nonempty(threadId, 512) ||
    (cursor != null && !nonempty(cursor, 4096)) ||
    (limit != null && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)) ||
    (sortDirection != null && sortDirection !== "asc" && sortDirection !== "desc") ||
    Object.keys(params).some(
      (key) => !["threadId", "cursor", "limit", "sortDirection", turns ? "itemsView" : "turnId"].includes(key),
    )
  )
    return null;
  const page: HistoryPageParams = {
    threadId,
    cursor: cursor ?? null,
    limit: limit ?? 10,
    sortDirection: sortDirection ?? (turns ? "desc" : "asc"),
  };
  if (turns) {
    if (itemsView != null && itemsView !== "full" && itemsView !== "summary" && itemsView !== "notLoaded") return null;
    return { method: "thread/turns/list", params: { ...page, itemsView: itemsView ?? "summary" } };
  }
  if (turnId != null && !nonempty(turnId, 512)) return null;
  return { method: "thread/items/list", params: { ...page, ...(turnId == null ? {} : { turnId }) } };
}

export function isCodexHistoryResult(read: CodexHistoryRead, result: unknown): boolean {
  if (read.method === "thread/read") {
    if (!isCodexThreadResult(result, read.params.threadId)) return false;
    const page = (result as { initialTurnsPage?: unknown }).initialTurnsPage;
    const pageRead = initialCodexTurnsRead(read.params);
    return pageRead === undefined || page === undefined || isCodexHistoryResult(pageRead, page);
  }
  const page = result as { data?: unknown; nextCursor?: unknown; backwardsCursor?: unknown } | null;
  if (
    !Array.isArray(page?.data) ||
    page.data.length > read.params.limit ||
    !(page.nextCursor === null || (nonempty(page.nextCursor, 4096) && page.nextCursor !== read.params.cursor)) ||
    !(page.backwardsCursor === null || nonempty(page.backwardsCursor, 4096))
  )
    return false;
  return read.method === "thread/turns/list"
    ? page.data.every((turn) => nonempty(turn?.id, 512) && Array.isArray(turn.items))
    : page.data.every(
        (entry) =>
          nonempty(entry?.turnId, 512) &&
          nonempty(entry?.item?.id, 512) &&
          (read.params.turnId === undefined || entry.turnId === read.params.turnId),
      );
}

export function parseWorkspaceCodexRead(value: unknown) {
  const body = value as { method?: unknown; read?: unknown; attachment?: unknown; placement?: unknown } | null;
  const read = parseCodexHistoryRead(body?.method, body?.read);
  const attachment = parseClientAttachment(body?.attachment);
  const placement = parseThreadPlacementReceipt(body?.placement);
  return read && attachment && placement?.state === "placed" && placement.threadId === read.params.threadId
    ? { read, attachment, placement }
    : null;
}

export async function lookupCodexThread(
  installation: ReturnType<InstallationCoreNamespace["get"]>,
  attachment: ClientAttachment,
  threadId: string,
  options?: { readonly archiveState?: boolean },
): Promise<(ThreadPlacementReceipt & { readonly archived?: boolean }) | null> {
  const response = await installation.fetch(
    new Request(`https://installation.invalid${CODEX_THREAD_LOOKUP_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachment, threadId, ...(options?.archiveState ? { archiveState: true } : {}) }),
    }),
  );
  if ([401, 403, 404].includes(response.status)) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Codex Thread placement unavailable");
  }
  const result = (await response.json()) as { archived?: unknown } | null;
  const placement = parseThreadPlacementReceipt(result);
  if (placement?.state !== "placed" || placement.threadId !== threadId)
    throw new Error("Invalid Codex Thread placement");
  return options?.archiveState && typeof result?.archived === "boolean"
    ? { ...placement, archived: result.archived }
    : placement;
}

export function isCodexThreadResult(value: unknown, threadId: string): boolean {
  const thread = (value as { thread?: { id?: unknown; ephemeral?: unknown } } | null)?.thread;
  return thread?.id === threadId && thread.ephemeral === false;
}
