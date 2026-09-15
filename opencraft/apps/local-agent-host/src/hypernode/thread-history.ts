// Source copy: ref/hypernode/policy/src/services/transparent-thread-history.ts
export interface ProjectedThreadItem {
  id?: string | null;
  type?: string;
  [key: string]: unknown;
}

export interface ProjectedTurn {
  id: string;
  items?: ProjectedThreadItem[];
  itemsView?: string;
  [key: string]: unknown;
}

export interface ProjectedThread {
  id: string;
  turns?: ProjectedTurn[];
  [key: string]: unknown;
}

export interface ProjectionPageParams {
  threadId: string;
  turnId?: string | null;
  cursor?: string | null;
  limit?: number | null;
  sortDirection?: "asc" | "desc" | string | null;
  itemsView?: "full" | "summary" | "notLoaded" | string | null;
}

export interface ProjectionPage<Entry> {
  data: Entry[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

interface ProjectionCursor {
  version: 1;
  kind: string;
  threadId: string;
  direction: string;
  anchor: string;
}

export interface ProjectedItemEntry {
  turnId: string;
  item: ProjectedThreadItem;
}

export interface ProjectedHistoryHeadCursors {
  turnsBackwardsCursor: string | null;
  itemsBackwardsCursor: string | null;
}

export function projectedThreadForRead(
  thread: ProjectedThread,
  includeTurns = true,
): ProjectedThread {
  if (includeTurns !== false) return thread;
  return { ...thread, turns: [] };
}

function encodeProjectionCursor(
  kind: string,
  threadId: string,
  direction: string,
  anchor: string,
): string {
  return encodeURIComponent(JSON.stringify({ version: 1, kind, threadId, direction, anchor }));
}

function decodeProjectionCursor(
  value: string | null | undefined,
  kind: string,
  threadId: string,
): ProjectionCursor | null {
  if (value == null) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(decodeURIComponent(value));
  } catch {
    throw new Error(`invalid ${kind} cursor`);
  }
  if (typeof candidate !== "object" || candidate == null) {
    throw new Error(`${kind} cursor does not match this thread`);
  }
  const version = Reflect.get(candidate, "version");
  const cursorKind = Reflect.get(candidate, "kind");
  const cursorThreadId = Reflect.get(candidate, "threadId");
  const direction = Reflect.get(candidate, "direction");
  const anchor = Reflect.get(candidate, "anchor");
  if (version !== 1 || cursorKind !== kind || cursorThreadId !== threadId ||
      typeof direction !== "string" || typeof anchor !== "string") {
    throw new Error(`${kind} cursor does not match this thread`);
  }
  return {
    version: 1,
    kind: cursorKind,
    threadId: cursorThreadId,
    direction,
    anchor,
  };
}

function projectionPage<Entry>(
  entries: readonly Entry[],
  params: ProjectionPageParams,
  kind: string,
  anchorOf: (entry: Entry) => string,
): ProjectionPage<Entry> {
  const direction = params.sortDirection === "asc" ? "asc" : "desc";
  const ordered = direction === "asc" ? [...entries] : [...entries].reverse();
  const cursor = decodeProjectionCursor(params.cursor, kind, params.threadId);
  let start = 0;
  if (cursor != null) {
    const exact = ordered.findIndex((entry) => anchorOf(entry) === cursor.anchor);
    if (exact >= 0) start = exact + (cursor.direction === direction ? 1 : 0);
  }
  const requestedLimit = Number(params.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 100)
    : 20;
  const data = ordered.slice(start, start + limit);
  const first = data[0];
  const last = data.at(-1);
  return {
    data,
    nextCursor: start + data.length < ordered.length && last != null
      ? encodeProjectionCursor(kind, params.threadId, direction, anchorOf(last))
      : null,
    backwardsCursor: first != null
      ? encodeProjectionCursor(kind, params.threadId, direction, anchorOf(first))
      : null,
  };
}

export function projectedTurnsPage(
  thread: ProjectedThread,
  params: ProjectionPageParams,
): ProjectionPage<ProjectedTurn> {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const page = projectionPage(turns, params, "thread/turns/list", (turn) => String(turn.id));
  if (params.itemsView === "notLoaded") {
    return {
      ...page,
      data: page.data.map((turn) => ({ ...turn, items: [], itemsView: "notLoaded" })),
    };
  }
  if (params.itemsView !== "summary") return page;
  return {
    ...page,
    data: page.data.map((turn) => {
      const items = Array.isArray(turn.items) ? turn.items : [];
      const firstUser = items.find((item) => item.type === "userMessage");
      const finalAgent = [...items].reverse().find((item) => item.type === "agentMessage");
      const summaryItems: ProjectedThreadItem[] = [];
      if (firstUser != null) summaryItems.push(firstUser);
      if (finalAgent != null && firstUser?.id !== finalAgent.id) summaryItems.push(finalAgent);
      return { ...turn, items: summaryItems, itemsView: "summary" };
    }),
  };
}

export function projectedItemsPage(
  thread: ProjectedThread,
  params: ProjectionPageParams,
): ProjectionPage<ProjectedItemEntry> {
  const entries: ProjectedItemEntry[] = [];
  for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
    if (params.turnId != null && turn.id !== params.turnId) continue;
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      entries.push({ turnId: turn.id, item });
    }
  }
  return projectionPage(
    entries,
    { ...params, sortDirection: params.sortDirection ?? "asc" },
    "thread/items/list",
    (entry) => `${entry.turnId}\0${entry.item.id ?? ""}`,
  );
}

export function projectedHistoryHeadCursors(
  thread: ProjectedThread,
): ProjectedHistoryHeadCursors {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const latestTurn = turns.at(-1);
  let latestItem: ProjectedItemEntry | null = null;
  for (let turnIndex = turns.length - 1; turnIndex >= 0 && latestItem == null; turnIndex -= 1) {
    const turn = turns[turnIndex];
    if (turn == null) continue;
    const item = Array.isArray(turn.items) ? turn.items.at(-1) : undefined;
    if (item != null) latestItem = { turnId: turn.id, item };
  }

  return {
    turnsBackwardsCursor: latestTurn == null
      ? null
      : encodeProjectionCursor("thread/turns/list", thread.id, "asc", String(latestTurn.id)),
    itemsBackwardsCursor: latestItem == null
      ? null
      : encodeProjectionCursor(
        "thread/items/list",
        thread.id,
        "asc",
        `${latestItem.turnId}\0${latestItem.item.id ?? ""}`,
      ),
  };
}
