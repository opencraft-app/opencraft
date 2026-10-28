import { AppServerClientError, type AppServerClient } from "@opencraft/appserver-client";
import type { AppServerThread } from "@opencraft/appserver-protocol";
import { hydrateReadTurnItems, readTurnsPage, type HydratedThreadHistory, type ResumeHistoryContext, type ThreadHistoryStrategyRegistryService } from "./history-strategies";
import { reconcileHistoryTurns, reconcileHistoryWindow } from "./merge-turns";
import type { ThreadView } from "./models";
import type { ThreadViewStoreService } from "./view-store";

export interface DerivedReadContext { generation: number; hydrateItems: boolean }
export type DerivedHistorySource = DerivedReadContext | ResumeHistoryContext;
export interface DerivedHistoryOperation {
  readonly signal: AbortSignal;
  current(): boolean;
  assertCurrent(): void;
  onCancel?: () => void;
}
export interface DerivedHistoryPorts {
  readonly client: AppServerClient;
  readonly views: ThreadViewStoreService;
  readonly strategies: ThreadHistoryStrategyRegistryService;
  readonly requestTimeoutMs: number;
  source(): DerivedHistorySource | null;
}
function assertSource(ports: DerivedHistoryPorts, operation: DerivedHistoryOperation, source: DerivedHistorySource | null): void {
  operation.assertCurrent();
  if (ports.source() !== source) throw new AppServerClientError("ABORTED", "History source was superseded");
}

/** Demand-loaded projection work. Admission/cancellation remain with Session. */
export async function refreshDerivedHistory(ports: DerivedHistoryPorts, threadId: string, operation: DerivedHistoryOperation): Promise<boolean> {
  operation.assertCurrent();
  const source = ports.source(), initial = ports.views.get(threadId);
  if (!source || !("response" in source) || !initial || initial.resumeState !== "resumed" || initial.historySource !== "message-window") return false;
  assertSource(ports, operation, source);
  const { thread } = await ports.client.request("thread/read", { threadId, includeTurns: false }, {
    timeoutMs: ports.requestTimeoutMs, priority: "background", signal: operation.signal, historySource: "refresh",
  });
  assertSource(ports, operation, source);
  if (!thread || thread.id !== threadId || !Array.isArray(thread.turns)) throw new Error("History refresh returned an invalid Thread");
  const revision = (value: AppServerThread | null) => value === null ? null : JSON.stringify([value.updatedAt, value.preview, value.extra]);
  if (revision(initial.thread) === revision(thread)) return false;
  const history = await ports.strategies.load({ ...source, signal: operation.signal,
    response: { ...source.response, thread, initialTurnsPage: null, turnsBackwardsCursor: null } });
  assertSource(ports, operation, source);
  ports.views.update(threadId, view => ({ ...view, thread,
    turns: reconcileHistoryWindow(view.turns, history.turns, initial.turns),
    turnsPagination: { ...view.turnsPagination, olderCursor: history.olderCursor,
      oldestLoadedTurnId: history.turns[0]?.id ?? null, hasLoadedOldest: history.complete }, historyError: null,
  }));
  operation.assertCurrent();
  return true;
}

export async function loadOlderHistory(ports: DerivedHistoryPorts, threadId: string, operation: DerivedHistoryOperation): Promise<ThreadView> {
  operation.assertCurrent();
  const source = ports.source(), initial = ports.views.get(threadId);
  assertSource(ports, operation, source);
  if (!source || !initial) throw new Error(`Thread ${threadId} has no history source`);
  const cursor = initial.turnsPagination.olderCursor;
  if (cursor === null) return initial;
  if (!("response" in source)) {
    if (source.generation !== ports.client.connectionGeneration) throw new AppServerClientError("ABORTED", "History source generation was superseded");
    const context = { client: ports.client, threadId, requestTimeoutMs: ports.requestTimeoutMs, signal: operation.signal };
    const page = await readTurnsPage(context, cursor);
    assertSource(ports, operation, source);
    const turns = await hydrateReadTurnItems(context, [...page.data].reverse().map(turn => !source.hydrateItems && turn.itemsView === undefined ? { ...turn, itemsView: "full" as const } : turn));
    assertSource(ports, operation, source);
    return ports.views.update(threadId, view => ({ ...view,
      turns: reconcileHistoryTurns(view.turns, turns, "older", { baselineTurns: initial.turns }),
      tailHydrationComplete: page.nextCursor === null,
      turnsPagination: { olderCursor: page.nextCursor, oldestLoadedTurnId: turns[0]?.id ?? view.turnsPagination.oldestLoadedTurnId,
        hasLoadedOldest: page.nextCursor === null, isLoadingOlder: false },
    }));
  }
  operation.onCancel = () => {
    if (ports.source() !== source || !ports.views.get(threadId)) return;
    ports.views.update(threadId, view => ({ ...view, turnsPagination: { ...view.turnsPagination, isLoadingOlder: false } }));
  };
  ports.views.update(threadId, view => ({ ...view, turnsPagination: { ...view.turnsPagination, isLoadingOlder: true }, historyError: null }));
  try {
    assertSource(ports, operation, source);
    const page = await ports.strategies.loadOlder({ ...source, signal: operation.signal }, cursor);
    assertSource(ports, operation, source);
    if (ports.views.get(threadId)?.resumeState !== "resumed") return ports.views.get(threadId) ?? initial;
    operation.assertCurrent();
    return ports.views.update(threadId, view => ({ ...view,
      turns: page.source === "message-window" ? reconcileHistoryWindow(view.turns, page.turns)
        : reconcileHistoryTurns(view.turns, page.turns, "older", { baselineTurns: initial.turns }),
      tailHydrationComplete: page.complete,
      turnsPagination: { olderCursor: page.olderCursor, oldestLoadedTurnId: page.turns[0]?.id ?? view.turns[0]?.id ?? null,
        isLoadingOlder: false, hasLoadedOldest: page.complete },
      itemsPaginationByTurnId: { ...view.itemsPaginationByTurnId, ...page.itemsPaginationByTurnId },
    }));
  } catch (error) {
    if (!operation.current() || ports.source() !== source) throw error;
    const failure = error instanceof Error ? error : new Error(String(error));
    ports.views.update(threadId, view => ({ ...view, turnsPagination: { ...view.turnsPagination, isLoadingOlder: false }, historyError: failure }));
    throw failure;
  }
}

export async function drainHistory(ports: DerivedHistoryPorts, threadId: string, operation: DerivedHistoryOperation, history: HydratedThreadHistory): Promise<void> {
  operation.assertCurrent();
  const source = ports.source(), baselineTurns = ports.views.get(threadId)?.turns ?? [];
  assertSource(ports, operation, source);
  try {
    const olderTurns = await history.drainRemaining?.(operation.signal) ?? [];
    assertSource(ports, operation, source);
    ports.views.update(threadId, current => ({ ...current,
      turns: reconcileHistoryTurns(current.turns, olderTurns, "older", { baselineTurns }), tailHydrationComplete: true,
      turnsPagination: { olderCursor: null, oldestLoadedTurnId: olderTurns[0]?.id ?? current.turns[0]?.id ?? null,
        isLoadingOlder: false, hasLoadedOldest: true }, historyError: null,
    }));
  } catch (error) {
    if (!operation.current() || ports.source() !== source) return;
    ports.views.update(threadId, current => ({ ...current, historyError: error instanceof Error ? error : new Error(String(error)) }));
  }
}
