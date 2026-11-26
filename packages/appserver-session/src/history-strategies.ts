import { Context, Service } from "@deepseek-ai/cordis";
import { isHistoryResponseTooLargeError, type AppServerClient } from "@opencraft/appserver-client";
import { executionEngineExtension } from "@opencraft/appserver-client";
import type {
  AppServerThread,
  AppServerTurn,
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
  readonly signal?: AbortSignal;
  client: AppServerClient;
  threadId: string;
  response: ThreadResumeResponse;
  metadata: AppServerThread | null;
  useTailHydration: boolean;
  isDurableHost: boolean;
  supportsPaginatedHistory: boolean;
  supportsInitialTurnsPage?: boolean;
  pageSize: number;
  requestTimeoutMs: number;
}

export type PassiveHistoryRequest = Pick<ResumeHistoryContext, "client" | "threadId" | "requestTimeoutMs" | "signal"> & {
  openArchivedHistory?: true;
};

export interface HydratedThreadHistory {
  source: ThreadHistorySource;
  turns: readonly AppServerTurn[];
  complete: boolean;
  olderCursor: string | null;
  itemsPaginationByTurnId: Readonly<Record<string, ThreadItemsPagination>>;
  drainRemaining?: (signal?: AbortSignal) => Promise<readonly AppServerTurn[]>;
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

export function requireTurnsPage(value: ThreadTurnsListResponse, operation: string, cursor: string | null = null): ThreadTurnsListResponse {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error(`${operation} returned a non-array data field`);
  if (!(value.nextCursor === null || typeof value.nextCursor === "string")) {
    throw new Error(`${operation} returned an invalid nextCursor`);
  }
  if (cursor !== null && value.nextCursor === cursor) throw new Error(`${operation} returned a repeated cursor`);
  const seen = new Set<string>();
  const data = value.data.filter(entry => {
    const { id } = requireTurn(entry, operation);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { ...value, data };
}

/** Shrink oversized full pages before resorting to per-Turn Item hydration.
 * Each successful page keeps its native cursor; even a large single Turn can
 * still use the existing adaptive Item reader without Resume. */
export async function readTurnsPage(
  context: PassiveHistoryRequest,
  cursor: string | null,
  limit = 10,
): Promise<ThreadTurnsListResponse> {
  let pageLimit = limit;
  const capability = executionEngineExtension(context.client.initializeResult?.capabilities?.extensions, context.threadId, "opencraft/read-history");
  const request = async (itemsView: "full" | "notLoaded" | "presentation") => requireTurnsPage(await context.client.request("thread/turns/list", {
    threadId: context.threadId, cursor, limit: pageLimit, itemsView, sortDirection: "desc",
    openArchivedHistory: context.openArchivedHistory,
    imageResources: capability?.imageResources === true ? true : undefined,
  }, { timeoutMs: context.requestTimeoutMs, priority: "user-visible", signal: context.signal }), "thread/turns/list", cursor);
  while (true) {
    try { return await request(capability?.itemDetails === true ? "presentation" : "full"); }
    catch (error) {
      if (!isHistoryResponseTooLargeError(error)) throw error;
      if (pageLimit <= 1) return request("notLoaded");
      pageLimit = Math.max(1, Math.floor(pageLimit / 2));
    }
  }
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
    signal: context.signal,
  }), "thread/turns/list", cursor);
}

async function loadLegacyPaginatedPage(
  context: ResumeHistoryContext,
  cursor: string,
): Promise<HydratedThreadHistory> {
  const page = await fetchTurns(context, cursor, context.pageSize, "notLoaded");
  const { hydrateLegacyItemPage } = await import("./derived-history");
  return hydrateLegacyItemPage(context, page);
}

async function drainTailHistory(
  context: ResumeHistoryContext,
  initialCursor: string,
): Promise<readonly AppServerTurn[]> {
  const cursors = new Set<string>();
  const turns = new Map<string, AppServerTurn>();
  let cursor: string | null = initialCursor;
  while (cursor !== null) {
    if (cursors.has(cursor)) throw new Error(`thread/turns/list repeated cursor ${cursor}`);
    cursors.add(cursor);
    const page = await fetchTurns(context, cursor, 100, "full");
    for (const turn of page.data) {
      if (!turns.has(turn.id)) turns.set(turn.id, turn);
    }
    cursor = page.nextCursor;
  }
  return [...turns.values()].reverse();
}

async function readFullHistory(context: ResumeHistoryContext): Promise<HydratedThreadHistory> {
  const fallback = await context.client.request("thread/read", {
    threadId: context.threadId,
    includeTurns: true,
  }, { timeoutMs: context.requestTimeoutMs, priority: "background", signal: context.signal });
  return {
    source: "thread-read-fallback",
    turns: fallback.thread.turns,
    complete: true,
    olderCursor: null,
    itemsPaginationByTurnId: {},
  };
}

/** A provider may embed the initial page; otherwise read one full page before
 * falling back to per-Turn Items for older headers-only implementations. */
async function loadDurablePage(context: ResumeHistoryContext, cursor: string | null): Promise<HydratedThreadHistory> {
  const embedded = cursor === null && context.supportsInitialTurnsPage === true
    ? context.response.initialTurnsPage : null;
  let page: ThreadTurnsListResponse;
  try {
    // Unadvertised native providers keep bounded Item reads: a single large
    // full-Turn response can regress low-latency restore despite fewer RPCs.
    const itemsView = context.supportsInitialTurnsPage === true ? "full" : "notLoaded";
    page = embedded == null ? await fetchTurns(context, cursor, context.pageSize, itemsView)
      : requireTurnsPage(embedded, "thread/resume.initialTurnsPage");
  } catch (error) {
    // Retain the existing adaptive Item pagination for transport frame limits.
    // Connection/permission failures remain failures, never hidden retries.
    if (!isHistoryResponseTooLargeError(error)) throw error;
    page = await fetchTurns(context, cursor, context.pageSize, "notLoaded");
  }
  const turns = page.data.some(turn => turn.itemsView !== "full" || !Array.isArray(turn.items))
    ? await (await import("./derived-history")).hydrateReadTurnItems(context, page.data, true) : page.data;
  return {
    source: "durable", turns: turns.slice().reverse(), complete: page.nextCursor === null,
    olderCursor: page.nextCursor,
    itemsPaginationByTurnId: Object.fromEntries(turns.map(turn => [turn.id, {
      olderCursor: null, hasLoadedOldest: true,
    }])),
  };
}

export function registerBuiltinThreadHistoryStrategies(ctx: Context): () => void {
  const remove = [
    ctx.threadHistoryStrategies.register({
      name: "message-window",
      priority: 50,
      matches: context => context.response.thread.historyMode === "message-window",
      async load(context) {
        const initial = context.response.initialTurnsPage;
        const page = initial == null
          ? await fetchTurns(context, context.response.turnsBackwardsCursor ?? null, null, "full")
          : requireTurnsPage(initial, "thread/resume.initialTurnsPage");
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
        // Host placement does not imply support for paginated Item history.
        // Honor the returned history mode before choosing a paginated read strategy.
        if (context.response.thread.historyMode === "legacy") return readFullHistory(context);
        return loadDurablePage(context, null);
      },
      async loadOlder(context, cursor) {
        return loadDurablePage(context, cursor);
      },
    }),
    ctx.threadHistoryStrategies.register({
      name: "paginated",
      priority: 30,
      matches: (context) => context.useTailHydration && !context.isDurableHost && context.supportsPaginatedHistory,
      async load(context) {
        const initial = context.response.initialTurnsPage;
        if (initial != null && context.supportsInitialTurnsPage === true) {
          const page = requireTurnsPage(initial, "thread/resume.initialTurnsPage");
          if (page.data.some(turn => turn.itemsView !== "full" || !Array.isArray(turn.items))) {
            throw new Error("thread/resume.initialTurnsPage must contain full Turns");
          }
          return {
            source: "paginated",
            turns: page.data.slice().reverse(),
            complete: page.nextCursor === null,
            olderCursor: page.nextCursor,
            itemsPaginationByTurnId: Object.fromEntries(page.data.map(turn => [turn.id, {
              olderCursor: null, hasLoadedOldest: true,
            }])),
          };
        }
        if (context.response.turnsBackwardsCursor == null) {
          return {
            source: "paginated",
            turns: [],
            complete: true,
            olderCursor: null,
            itemsPaginationByTurnId: {},
          };
        }
        return loadLegacyPaginatedPage(context, context.response.turnsBackwardsCursor);
      },
      loadOlder: loadLegacyPaginatedPage,
    }),
    ctx.threadHistoryStrategies.register({
      name: "tail",
      priority: 20,
      matches: (context) => context.useTailHydration && !context.isDurableHost && !context.supportsPaginatedHistory,
      async load(context) {
        const initial = context.response.initialTurnsPage;
        if (initial == null) {
          return readFullHistory(context);
        }
        const page = requireTurnsPage(initial, "thread/resume.initialTurnsPage");
        const olderCursor = page.nextCursor;
        return {
          source: "tail",
          turns: page.data.slice().reverse(),
          complete: olderCursor === null,
          olderCursor,
          itemsPaginationByTurnId: {},
          ...(olderCursor === null ? {} : {
            drainRemaining: signal => drainTailHistory({ ...context, signal: signal ?? context.signal }, olderCursor),
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
