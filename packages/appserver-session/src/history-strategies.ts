import { Context, Service } from "@deepseek-ai/cordis";
import type { AppServerClient } from "@opencraft/appserver-client";
import type {
  AppServerThread,
  AppServerThreadItem,
  AppServerTurn,
  ThreadItemsListResponse,
  ThreadResumeResponse,
  ThreadTurnsListResponse,
} from "@opencraft/appserver-protocol";

import type {
  ThreadHistorySource,
  ThreadItemsPagination,
} from "./models";

declare module "@deepseek-ai/cordis" {
  interface Context {
    threadHistoryStrategies: ThreadHistoryStrategyRegistryService;
  }
}

export interface ResumeHistoryContext {
  client: AppServerClient;
  threadId: string;
  response: ThreadResumeResponse;
  metadata: AppServerThread | null;
  useTailHydration: boolean;
  isDurableHost: boolean;
  supportsPaginatedHistory: boolean;
  pageSize: number;
  requestTimeoutMs: number;
}

export interface HydratedThreadHistory {
  source: ThreadHistorySource;
  turns: readonly AppServerTurn[];
  complete: boolean;
  olderCursor: string | null;
  itemsPaginationByTurnId: Readonly<Record<string, ThreadItemsPagination>>;
  drainRemaining?: () => Promise<readonly AppServerTurn[]>;
}

export interface ThreadHistoryStrategy {
  readonly name: ThreadHistorySource;
  readonly priority: number;
  matches(context: ResumeHistoryContext): boolean;
  load(context: ResumeHistoryContext): Promise<HydratedThreadHistory>;
  loadOlder?(context: ResumeHistoryContext, cursor: string): Promise<HydratedThreadHistory>;
}

export class ThreadHistoryStrategyRegistryService extends Service {
  private readonly strategies = new Map<string, ThreadHistoryStrategy>();

  constructor(ctx: Context) {
    super(ctx, "threadHistoryStrategies");
  }

  register(strategy: ThreadHistoryStrategy): () => void {
    if (this.strategies.has(strategy.name)) {
      throw new Error(`Thread history strategy ${strategy.name} is already registered`);
    }
    this.strategies.set(strategy.name, strategy);
    return () => {
      if (this.strategies.get(strategy.name) === strategy) this.strategies.delete(strategy.name);
    };
  }

  resolve(context: ResumeHistoryContext): ThreadHistoryStrategy {
    const strategy = [...this.strategies.values()]
      .filter((candidate) => candidate.matches(context))
      .sort((left, right) => right.priority - left.priority)[0];
    if (strategy === undefined) throw new Error("No Thread history strategy matched Resume capabilities");
    return strategy;
  }

  load(context: ResumeHistoryContext): Promise<HydratedThreadHistory> {
    return this.resolve(context).load(context);
  }

  loadOlder(context: ResumeHistoryContext, cursor: string): Promise<HydratedThreadHistory> {
    const strategy = this.resolve(context);
    if (strategy.loadOlder === undefined) {
      throw new Error(`Thread history strategy ${strategy.name} does not support older-page loading`);
    }
    return strategy.loadOlder(context, cursor);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireTurn(value: unknown, operation: string): AppServerTurn {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error(`${operation} returned a Turn without a string id`);
  }
  return value as AppServerTurn;
}

function requireTurnsPage(value: ThreadTurnsListResponse, operation: string): ThreadTurnsListResponse {
  if (!Array.isArray(value.data)) throw new Error(`${operation} returned a non-array data field`);
  if (!(value.nextCursor === null || typeof value.nextCursor === "string")) {
    throw new Error(`${operation} returned an invalid nextCursor`);
  }
  return { ...value, data: value.data.map((turn) => requireTurn(turn, operation)) };
}

function extractItem(entry: ThreadItemsListResponse["data"][number], turnId: string): AppServerThreadItem {
  if (!isRecord(entry)) throw new Error("thread/items/list returned a non-object entry");
  if (typeof entry.turnId === "string" && entry.turnId !== turnId) {
    throw new Error(`thread/items/list returned an Item for unexpected Turn ${entry.turnId}`);
  }
  const item = isRecord(entry.item) ? entry.item : entry;
  if (typeof item.id !== "string") throw new Error("thread/items/list returned an Item without a string id");
  return item as AppServerThreadItem;
}

async function fetchItemsPage(
  context: ResumeHistoryContext,
  turnId: string,
  cursor: string | null,
  limit: number,
  sortDirection: "asc" | "desc",
): Promise<{ items: AppServerThreadItem[]; nextCursor: string | null }> {
  const page = await context.client.request("thread/items/list", {
    threadId: context.threadId,
    turnId,
    cursor,
    limit,
    sortDirection,
  }, { timeoutMs: context.requestTimeoutMs, priority: "background" });
  if (!Array.isArray(page.data)) throw new Error("thread/items/list returned a non-array data field");
  if (!(page.nextCursor === null || typeof page.nextCursor === "string")) {
    throw new Error("thread/items/list returned an invalid nextCursor");
  }
  if (page.nextCursor !== null && page.nextCursor === cursor) {
    throw new Error(`thread/items/list returned an unchanged cursor for Turn ${turnId}`);
  }
  const items = page.data.map((entry) => extractItem(entry, turnId));
  return { items: sortDirection === "desc" ? items.reverse() : items, nextCursor: page.nextCursor };
}

async function fetchAllTurnItems(
  context: ResumeHistoryContext,
  turnId: string,
): Promise<readonly AppServerThreadItem[]> {
  const items: AppServerThreadItem[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let limit = 100;
  while (true) {
    let page;
    try {
      page = await fetchItemsPage(context, turnId, cursor, limit, "asc");
    } catch (error) {
      if (limit > 1 && error instanceof Error && error.message.includes("decoded message length too large")) {
        limit = Math.max(1, Math.floor(limit / 2));
        continue;
      }
      throw error;
    }
    const seenIds = new Set(items.map((item) => item.id));
    for (const item of page.items) if (!seenIds.has(item.id)) {
      seenIds.add(item.id);
      items.push(item);
    }
    if (page.nextCursor === null) return items;
    if (cursors.has(page.nextCursor)) {
      throw new Error(`thread/items/list repeated cursor ${page.nextCursor} for Turn ${turnId}`);
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

async function mapConcurrent<T, TResult>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<TResult>,
): Promise<readonly TResult[]> {
  const result = Array<TResult>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const value = values[index];
      if (value !== undefined) result[index] = await mapper(value, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return result;
}

async function fetchTurns(
  context: ResumeHistoryContext,
  cursor: string | null,
  limit: number | null,
  itemsView: "full" | "notLoaded",
): Promise<ThreadTurnsListResponse> {
  return requireTurnsPage(await context.client.request("thread/turns/list", {
    threadId: context.threadId,
    cursor,
    limit,
    itemsView,
    sortDirection: "desc",
  }, {
    timeoutMs: context.response.thread.historyMode === "message-window" ? 0 : context.requestTimeoutMs,
    priority: "background",
  }), "thread/turns/list");
}

async function loadPaginatedTurnItems(
  context: ResumeHistoryContext,
  turns: readonly AppServerTurn[],
): Promise<{
  turns: readonly AppServerTurn[];
  itemsPaginationByTurnId: Readonly<Record<string, ThreadItemsPagination>>;
}> {
  let remainingBudget = Math.min(context.pageSize, 5) * 100;
  const pagination: Record<string, ThreadItemsPagination> = {};
  const hydrated: AppServerTurn[] = [];
  for (const turn of turns) {
    const items: AppServerThreadItem[] = [];
    const itemIds = new Set<string>();
    const cursors = new Set<string | null>();
    let cursor: string | null = context.response.itemsBackwardsCursor ?? null;
    let requestedOnce = false;
    while ((!requestedOnce || cursor !== null) && remainingBudget > 0) {
      if (cursors.has(cursor)) throw new Error(`thread/items/list repeated cursor ${String(cursor)} for Turn ${turn.id}`);
      cursors.add(cursor);
      requestedOnce = true;
      const page = await fetchItemsPage(
        context,
        turn.id,
        cursor,
        Math.min(100, remainingBudget),
        "desc",
      );
      const unique = page.items.filter((item) => {
        if (itemIds.has(item.id)) return false;
        itemIds.add(item.id);
        return true;
      });
      items.push(...unique.reverse());
      remainingBudget -= unique.length;
      cursor = page.nextCursor;
    }
    items.reverse();
    pagination[turn.id] = { olderCursor: cursor, hasLoadedOldest: requestedOnce && cursor === null };
    hydrated.push({
      ...turn,
      items,
      itemsView: cursor === null ? "full" : "summary",
    });
  }
  return { turns: hydrated, itemsPaginationByTurnId: pagination };
}

async function drainTailHistory(
  context: ResumeHistoryContext,
  initialCursor: string,
): Promise<readonly AppServerTurn[]> {
  const cursors = new Set<string>();
  const turns: AppServerTurn[] = [];
  let cursor: string | null = initialCursor;
  while (cursor !== null) {
    if (cursors.has(cursor)) throw new Error(`thread/turns/list repeated cursor ${cursor}`);
    cursors.add(cursor);
    const page = await fetchTurns(context, cursor, 100, "full");
    turns.unshift(...page.data.slice().reverse());
    cursor = page.nextCursor;
  }
  return turns;
}

export function registerBuiltinThreadHistoryStrategies(ctx: Context): () => void {
  const remove = [
    ctx.threadHistoryStrategies.register({
      name: "message-window",
      priority: 50,
      matches: context => context.response.thread.historyMode === "message-window",
      async load(context) {
        const initial = context.response.initialTurnsPage;
        const page = initial ?? await fetchTurns(context, context.response.turnsBackwardsCursor ?? null, null, "full");
        return {
          source: "message-window", turns: page.data.slice().reverse(),
          complete: page.nextCursor === null, olderCursor: page.nextCursor,
          itemsPaginationByTurnId: {},
        };
      },
      async loadOlder(context, cursor) {
        const page = await fetchTurns(context, cursor, null, "full");
        return {
          source: "message-window", turns: page.data.slice().reverse(),
          complete: page.nextCursor === null, olderCursor: page.nextCursor,
          itemsPaginationByTurnId: {},
        };
      },
    }),
    ctx.threadHistoryStrategies.register({
      name: "durable",
      priority: 40,
      matches: (context) => context.useTailHydration && context.isDurableHost,
      async load(context) {
        const page = await fetchTurns(context, null, context.pageSize, "notLoaded");
        const turns = await mapConcurrent(page.data, 5, async (turn) => ({
          ...turn,
          items: await fetchAllTurnItems(context, turn.id),
          itemsView: "full" as const,
        }));
        return {
          source: "durable",
          turns: turns.slice().reverse(),
          complete: page.nextCursor === null,
          olderCursor: page.nextCursor,
          itemsPaginationByTurnId: Object.fromEntries(turns.map((turn) => [turn.id, {
            olderCursor: null,
            hasLoadedOldest: true,
          }])),
        };
      },
      async loadOlder(context, cursor) {
        const page = await fetchTurns(context, cursor, context.pageSize, "notLoaded");
        const turns = await mapConcurrent(page.data, 5, async (turn) => ({
          ...turn,
          items: await fetchAllTurnItems(context, turn.id),
          itemsView: "full" as const,
        }));
        return {
          source: "durable",
          turns: turns.slice().reverse(),
          complete: page.nextCursor === null,
          olderCursor: page.nextCursor,
          itemsPaginationByTurnId: Object.fromEntries(turns.map((turn) => [turn.id, {
            olderCursor: null,
            hasLoadedOldest: true,
          }])),
        };
      },
    }),
    ctx.threadHistoryStrategies.register({
      name: "paginated",
      priority: 30,
      matches: (context) => context.useTailHydration && !context.isDurableHost && context.supportsPaginatedHistory,
      async load(context) {
        if (context.response.turnsBackwardsCursor == null) {
          return {
            source: "paginated",
            turns: [],
            complete: true,
            olderCursor: null,
            itemsPaginationByTurnId: {},
          };
        }
        const page = await fetchTurns(context, context.response.turnsBackwardsCursor, context.pageSize, "notLoaded");
        const hydrated = await loadPaginatedTurnItems(context, page.data);
        return {
          source: "paginated",
          turns: hydrated.turns.slice().reverse(),
          complete: page.nextCursor === null,
          olderCursor: page.nextCursor,
          itemsPaginationByTurnId: hydrated.itemsPaginationByTurnId,
        };
      },
      async loadOlder(context, cursor) {
        const page = await fetchTurns(context, cursor, context.pageSize, "notLoaded");
        const hydrated = await loadPaginatedTurnItems(context, page.data);
        return {
          source: "paginated",
          turns: hydrated.turns.slice().reverse(),
          complete: page.nextCursor === null,
          olderCursor: page.nextCursor,
          itemsPaginationByTurnId: hydrated.itemsPaginationByTurnId,
        };
      },
    }),
    ctx.threadHistoryStrategies.register({
      name: "tail",
      priority: 20,
      matches: (context) => context.useTailHydration && !context.isDurableHost && !context.supportsPaginatedHistory,
      async load(context) {
        const page = context.response.initialTurnsPage;
        if (page == null) {
          const fallback = await context.client.request("thread/read", {
            threadId: context.threadId,
            includeTurns: true,
          }, { timeoutMs: context.requestTimeoutMs, priority: "background" });
          return {
            source: "thread-read-fallback",
            turns: fallback.thread.turns,
            complete: true,
            olderCursor: null,
            itemsPaginationByTurnId: {},
          };
        }
        const turns = page.data.map((turn) => requireTurn(turn, "thread/resume.initialTurnsPage"));
        const olderCursor = page.nextCursor;
        return {
          source: "tail",
          turns: turns.slice().reverse(),
          complete: olderCursor === null,
          olderCursor,
          itemsPaginationByTurnId: {},
          ...(olderCursor === null ? {} : {
            drainRemaining: () => drainTailHistory(context, olderCursor),
          }),
        };
      },
      async loadOlder(context, cursor) {
        const page = await fetchTurns(context, cursor, context.pageSize, "full");
        return {
          source: "tail",
          turns: page.data.slice().reverse(),
          complete: page.nextCursor === null,
          olderCursor: page.nextCursor,
          itemsPaginationByTurnId: {},
        };
      },
    }),
    ctx.threadHistoryStrategies.register({
      name: "legacy",
      priority: 10,
      matches: (context) => !context.useTailHydration,
      async load(context) {
        return {
          source: "legacy",
          turns: context.response.thread.turns.map((turn) => requireTurn(turn, "thread/resume.thread.turns")),
          complete: true,
          olderCursor: null,
          itemsPaginationByTurnId: {},
        };
      },
    }),
  ];
  return () => remove.reverse().forEach((dispose) => dispose());
}
