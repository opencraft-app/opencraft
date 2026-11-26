import { AppServerClientError, AppServerRpcError, isHistoryResponseTooLargeError, type AppServerClient } from "@opencraft/appserver-client";
import type { AppServerThread, AppServerThreadItem, AppServerTurn, MessageSender, ThreadHistoryCheckpoint, ThreadHistoryRecovery, ThreadItemsListRequest, ThreadItemsListResponse, ThreadTurnsListResponse } from "@opencraft/appserver-protocol";
import { HISTORY_PREVIEW_CURSOR_EXPIRED } from "@opencraft/appserver-protocol/history-preview";
import { readTurnsPage, type HydratedThreadHistory, type PassiveHistoryRequest, type ResumeHistoryContext, type ThreadHistoryStrategyRegistryService } from "./history-strategies";
import {
  conversationNavigationTargetVersion,
  type ConversationNavigationAnchor,
  type ConversationNavigationOutput,
  type LocatedConversationNavigationTarget,
  type PreparedConversationNavigationTarget,
  type PrepareConversationNavigationTargetOptions,
} from "@opencraft/chat-navigation";
import { projectionCommitForView, type V3ConversationNavigationPort, type V3TurnLocator } from "./conversation-navigation";
import { reconcileHistoryTurns, reconcileHistoryWindow, reconcileRecoveryWindow } from "./merge-turns";
import type { ThreadItemsPagination, ThreadView } from "./models";
import type { ThreadViewStoreService } from "./view-store";
import { isNavigationPromptItem, isRecord, navigationItemText } from "./navigation-items";

interface OlderCursorRecovery {
  readonly expiredCursor: string;
  readonly visited: Set<string>;
  anchor: string | null;
  cursor: string | null;
  failure?: Error;
}

export interface DerivedReadContext {
  generation: number;
  hydrateItems: boolean;
  olderCursorRecovery?: OlderCursorRecovery;
}
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

const committedOlderCursors = new WeakMap<DerivedHistorySource, Set<string>>();
const itemPageCursors = new WeakMap<ThreadItemsPagination, Set<string | null>>();

function assertItemCursor(cursors: ReadonlySet<string | null>, next: string | null, turnId: string): void {
  if (next !== null && cursors.has(next))
    throw new Error(`thread/items/list repeated cursor ${next} for Turn ${turnId}`);
}

function extractItem(entry: ThreadItemsListResponse["data"][number], turnId: string): AppServerThreadItem {
  if (typeof entry !== "object" || entry === null) throw new Error("thread/items/list returned a non-object entry");
  if (typeof entry.turnId === "string" && entry.turnId !== turnId) {
    throw new Error(`thread/items/list returned an Item for unexpected Turn ${entry.turnId}`);
  }
  const item = typeof entry.item === "object" && entry.item !== null ? entry.item as AppServerThreadItem : entry;
  if (typeof item.id !== "string") throw new Error("thread/items/list returned an Item without a string id");
  // Page envelopes carry lifecycle clocks separately from the protocol Item.
  const clocks = Object.fromEntries(["startedAtMs", "completedAtMs"].flatMap((key) =>
    typeof entry[key] === "number" && Number.isFinite(entry[key]) ? [[key, entry[key]]] : []));
  return { ...item, ...clocks } as AppServerThreadItem;
}

interface ItemPageReader {
  threadId: string;
  listItems(params: ThreadItemsListRequest): Promise<ThreadItemsListResponse>;
}

function itemPageReader(context: PassiveHistoryRequest): ItemPageReader {
  return {
    threadId: context.threadId,
    listItems: params => context.client.request("thread/items/list", { ...params, openArchivedHistory: context.openArchivedHistory },
      { timeoutMs: context.requestTimeoutMs, priority: "background", signal: context.signal }),
  };
}

async function fetchItemsPage(
  context: ItemPageReader,
  turnId: string,
  cursor: string | null,
  limit: number,
  sortDirection: "asc" | "desc",
): Promise<{ items: AppServerThreadItem[]; nextCursor: string | null; limit: number }> {
  let page: ThreadItemsListResponse;
  while (true) {
    try {
      page = await context.listItems({ threadId: context.threadId, turnId, cursor, limit, sortDirection });
      break;
    } catch (error) {
      if (limit <= 1 || !isHistoryResponseTooLargeError(error)) throw error;
      limit = Math.max(1, Math.floor(limit / 2));
    }
  }
  if (!Array.isArray(page?.data)) throw new Error("thread/items/list returned a non-array data field");
  if (!(page.nextCursor === null || typeof page.nextCursor === "string")) {
    throw new Error("thread/items/list returned an invalid nextCursor");
  }
  if (page.nextCursor !== null && page.nextCursor === cursor) {
    throw new Error(`thread/items/list returned an unchanged cursor for Turn ${turnId}`);
  }
  const items = page.data.map((entry) => extractItem(entry, turnId));
  return { items: sortDirection === "desc" ? items.reverse() : items, nextCursor: page.nextCursor, limit };
}

async function fetchAllTurnItems(
  context: ItemPageReader,
  turnId: string,
): Promise<readonly AppServerThreadItem[]> {
  const items: AppServerThreadItem[] = [];
  const cursors = new Set<string>();
  const seenIds = new Set<string>();
  let cursor: string | null = null;
  let limit = 100;
  while (true) {
    const page = await fetchItemsPage(context, turnId, cursor, limit, "asc");
    limit = page.limit;
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

/** Legacy native paginators can ignore itemsView=full. Read their existing
 * item pages without acquiring an execution stream. */
export function hydrateReadTurnItems(
  context: PassiveHistoryRequest,
  turns: readonly AppServerTurn[],
  durable = false,
): Promise<readonly AppServerTurn[]> {
  const reader = itemPageReader(context);
  return mapConcurrent(turns, durable ? 5 : 4, async turn => turn.itemsView === "full" && (!durable || Array.isArray(turn.items))
    ? turn : { ...turn, items: await fetchAllTurnItems(reader, turn.id), itemsView: "full" });
}

export async function discoverNavigationTurns(
  threadId: string,
  listTurns: V3ConversationNavigationPort["listTurns"],
  view: ThreadView | null,
  pageSize: number,
  maxPages: number,
  signal: AbortSignal,
  current: () => boolean,
): Promise<{ locators: V3TurnLocator[]; complete: boolean } | null> {
  if (!current()) return null;
  // Resume owns the contiguous range above its older boundary. A Turn
  // independently located by search may already be visible below it.
  const boundary = view?.turns.findIndex(turn => turn.id === view.turnsPagination.oldestLoadedTurnId) ?? -1;
  const seeded = view?.historyMode === "paginated" && view.historyCheckpoint !== undefined
    && (boundary >= 0 || view.turns.length === 0);
  const nextLocators = new Map<string, V3TurnLocator>();
  const indexPage = (turns: readonly AppServerTurn[], pageCursor: string | null) => {
    turns.forEach(({ id }, descendingOffset) => {
      const previous = nextLocators.get(id);
      if (!previous || "local" in previous) nextLocators.set(id, { turnId: id, pageCursor, descendingOffset });
    });
  };
  if (seeded && boundary >= 0) {
    for (const turn of view.turns.slice(boundary).reverse()) nextLocators.set(turn.id, { turnId: turn.id, local: true });
  }
  let cursor: string | null = seeded ? view.turnsPagination.olderCursor : null;
  let complete = seeded && view.turnsPagination.hasLoadedOldest;
  const consumedCursors = new Set<string | null>();
  for (let pageIndex = 0; !complete && pageIndex < maxPages; pageIndex += 1) {
    consumedCursors.add(cursor);
    const page = await listTurns({
      threadId,
      cursor,
      limit: pageSize,
      itemsView: "notLoaded",
      sortDirection: "desc",
    }, signal);
    if (!current()) return null;
    if (page.nextCursor !== null && consumedCursors.has(page.nextCursor))
      throw new Error("thread/turns/list repeated a cursor");
    // The backwards cursor belongs to a request in the opposite order.
    indexPage(page.data, cursor);
    if (page.nextCursor === null) {
      complete = true;
      break;
    }
    cursor = page.nextCursor;
  }
  return { locators: [...nextLocators.values()].reverse(), complete };
}

export async function readNavigationTurn(
  port: Pick<V3ConversationNavigationPort, "listTurns" | "listItems">,
  threadId: string,
  locator: V3TurnLocator,
  loaded: AppServerTurn | undefined,
  signal: AbortSignal,
  current: () => boolean,
): Promise<AppServerTurn | null> {
  const listItems = port.listItems;
  const readItems = async (turn: AppServerTurn) => {
    if (!listItems) return null;
    const items = await fetchAllTurnItems({ threadId, listItems: params => {
      if (!current()) throw new AppServerClientError("ABORTED", "Navigation history was superseded");
      return listItems.call(port, params, signal);
    } }, turn.id);
    return current() ? { ...turn, items, itemsView: "full" as const } : null;
  };
  // Local order proves display placement, not a native cursor or page offset.
  if ("local" in locator) return loaded ? readItems(loaded) : null;
  let cursor = locator.pageCursor;
  let remaining = locator.descendingOffset;
  const consumed = new Set<string | null>();
  const read = (limit: number, itemsView: "full" | "notLoaded") =>
    port.listTurns({ threadId, cursor, limit, itemsView, sortDirection: "desc" }, signal);
  while (remaining > 0) {
    consumed.add(cursor);
    const page = await read(remaining, "notLoaded");
    if (!current()) return null;
    const count = page.data.length;
    const next = page.nextCursor;
    if (count === 0 || count > remaining || next === null || consumed.has(next)) return null;
    remaining -= count;
    cursor = next;
  }
  let page: ThreadTurnsListResponse;
  let readItemPages = false;
  try {
    page = await read(1, "full");
  } catch (error) {
    if (!current()) return null;
    if (!listItems || !isHistoryResponseTooLargeError(error)) throw error;
    page = await read(1, "notLoaded");
    readItemPages = true;
  }
  const turn = page.data[0];
  if (!current() || turn?.id !== locator.turnId) return null;
  if (readItemPages || turn.itemsView === "summary" || turn.itemsView === "notLoaded") {
    return readItems(turn);
  }
  return turn.itemsView === undefined && Array.isArray(turn.items) ? { ...turn, itemsView: "full" } : turn;
}

export interface TurnPromptPreview {
  readonly sender?: MessageSender;
  readonly itemId: string;
  readonly label: string;
  readonly response: string;
  readonly outputs: readonly ConversationNavigationOutput[];
  readonly isHeartbeat: boolean;
}

export interface HydratedTurnNavigation {
  readonly turn: AppServerTurn;
  readonly baselineTurn: AppServerTurn | undefined;
  readonly prompts: readonly TurnPromptPreview[];
}

export function selectNavigationPreview(prompts: readonly TurnPromptPreview[], itemId: string | null) {
  const prompt = prompts.find(candidate => candidate.itemId === itemId) ?? prompts[0];
  return prompt ? { ...(prompt.sender ? { sender: prompt.sender } : {}),
    label: prompt.label, response: prompt.response, outputs: prompt.outputs } : null;
}

function isAssistantMessage(item: AppServerThreadItem): boolean {
  return item.type === "agentMessage" || item.type === "assistantMessage";
}

function outputForItem(item: AppServerThreadItem): ConversationNavigationOutput[] {
  if (item.type === "imageGeneration") return [{ kind: "image", label: null }];
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return changes.flatMap((change) => {
      if (!isRecord(change)) return [];
      const path = typeof change.path === "string" ? change.path : null;
      return [{ kind: "file" as const, label: path?.split(/[\\/]/).at(-1) ?? null }];
    });
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const name = typeof item.tool === "string"
      ? item.tool
      : typeof item.name === "string"
        ? item.name
        : "";
    if (/pull.?request|create.?pr/i.test(name)) return [{ kind: "pull-request", label: null }];
    if (/commit/i.test(name)) return [{ kind: "commit", label: null }];
    if (/website|preview/i.test(name)) return [{ kind: "website", label: null }];
  }
  return [];
}

function deduplicateOutputs(outputs: readonly ConversationNavigationOutput[]): ConversationNavigationOutput[] {
  const seen = new Set<string>();
  return outputs.filter((output) => {
    const key = `${output.kind}:${output.label ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function projectTurnPrompts(turn: AppServerTurn): readonly TurnPromptPreview[] {
  const prompts: Array<{
    itemId: string;
    sender?: MessageSender;
    label: string;
    response: string;
    outputs: ConversationNavigationOutput[];
    isHeartbeat: boolean;
  }> = [];
  for (const item of turn.items ?? []) {
    if (isNavigationPromptItem(item)) {
      const sender = isRecord(item.sender) && item.sender.kind === "employee"
        && typeof item.sender.loginName === "string" && item.sender.loginName.trim()
        ? { kind: "employee" as const, loginName: item.sender.loginName } : undefined;
      prompts.push({
        ...(sender ? { sender } : {}),
        itemId: item.id,
        label: navigationItemText(item).trim(),
        response: "",
        outputs: [],
        isHeartbeat: item.type === "hookPrompt",
      });
      continue;
    }
    const current = prompts.at(-1);
    if (current === undefined) continue;
    if (isAssistantMessage(item)) {
      const response = navigationItemText(item).trim();
      if (response.length > 0) current.response = response;
    }
    current.outputs.push(...outputForItem(item));
  }
  return prompts.map((prompt) => ({
    ...prompt,
    outputs: deduplicateOutputs(prompt.outputs),
  }));
}

export async function projectNavigationAnchorTarget(
  port: V3ConversationNavigationPort,
  anchor: ConversationNavigationAnchor,
  expectedGeneration: string,
  options: PrepareConversationNavigationTargetOptions | undefined,
  lookup: {
    readonly current: () => boolean;
    readonly getAnchor: () => ConversationNavigationAnchor | undefined;
    readonly orderedTurnIds: () => readonly string[];
    readonly hydrate: () => Promise<HydratedTurnNavigation | null>;
  },
): Promise<PreparedConversationNavigationTarget | null> {
  const { current, getAnchor, orderedTurnIds, hydrate } = lookup;
  const currentView = port.getView();
  if (!currentView || !current()) return null;
  const explicitItemId = options?.itemId;
  const loaded = explicitItemId === undefined ? undefined : currentView.turns.find(turn => turn.id === anchor.turnKey);
  const hasExplicitItem = loaded?.items?.some(item => item.id === explicitItemId);
  const alreadyVisible = anchor.isLoaded || hasExplicitItem;
  let itemId = explicitItemId ?? anchor.itemId;
  let commit: ReturnType<typeof projectionCommitForView>;
  if (alreadyVisible) {
    commit = loaded && hasExplicitItem && currentView.unplacedSearchTurnId
      ? port.commitHydratedTurn(loaded, orderedTurnIds(), loaded, "search")
      : projectionCommitForView(currentView);
  } else {
    const hydrated = await hydrate();
    if (!hydrated || !current() || !getAnchor()) return null;
    const prompt = hydrated.prompts.find(candidate => candidate.itemId === anchor.itemId) ?? hydrated.prompts[0];
    itemId = explicitItemId ?? prompt?.itemId ?? null;
    if (itemId === null || (explicitItemId !== undefined && !hydrated.turn.items?.some(item => item.id === explicitItemId))) return null;
    commit = port.commitHydratedTurn(hydrated.turn, orderedTurnIds(), hydrated.baselineTurn,
      explicitItemId === undefined ? undefined : "search");
  }
  const projectionRevision = await port.projectionBarrier.waitUntilProjected(commit, options);
  if (!current()) return null;
  if (itemId !== null && (alreadyVisible || explicitItemId !== undefined) &&
      !port.getView()?.turns.find(turn => turn.id === anchor.turnKey)?.items?.some(item => item.id === itemId)) return null;
  const target = { turnKey: anchor.turnKey, itemId, projectionRevision };
  const currentAnchor = getAnchor();
  const targetVersion = conversationNavigationTargetVersion(target);
  if (!currentAnchor || (explicitItemId === undefined && conversationNavigationTargetVersion(currentAnchor) !== targetVersion)) return null;
  return {
    ...target,
    anchorId: anchor.id,
    generation: expectedGeneration,
    targetVersion,
  };
}

export async function projectLocatedNavigationTarget(
  port: V3ConversationNavigationPort,
  target: LocatedConversationNavigationTarget,
  orderedTurnIds: () => readonly string[],
  signal: AbortSignal,
  current: () => boolean,
) {
  const view = port.getView();
  if (!view || !current()) return null;
  const { turnId, itemId, turnCursor } = target;
  const hasMatch = (turn: AppServerTurn | undefined) => turn?.items?.some(item => item.id === itemId);
  const baseline = view.turns.find(turn => turn.id === turnId);
  let commit = projectionCommitForView(view);
  if (!hasMatch(baseline)) {
    let turn: AppServerTurn | null;
    try {
      // The occurrence cursor includes its target in the provider's default order.
      turn = await readNavigationTurn(port, view.threadId, {
        turnId, pageCursor: turnCursor, descendingOffset: 0,
      }, baseline, signal, current);
    } catch (error) {
      if (expiredPreviewCursor(error) ||
          (error instanceof AppServerRpcError && error.code === -32602 && /^invalid cursor\b/i.test(error.message))) return null;
      throw error;
    }
    if (!current() || !turn || !hasMatch(turn)) return null;
    const latest = port.getView();
    if (!view.turnsPagination.hasLoadedOldest && latest?.turnsPagination.hasLoadedOldest &&
        !latest.turns.some(candidate => candidate.id === turnId)) return null;
    commit = port.commitHydratedTurn(turn, orderedTurnIds(), baseline, "search");
  } else if (baseline && view.unplacedSearchTurnId) {
    commit = port.commitHydratedTurn(baseline, orderedTurnIds(), baseline, "search");
  }
  const projectionRevision = await port.projectionBarrier.waitUntilProjected(commit, { signal });
  if (!current() || !hasMatch(port.getView()?.turns.find(turn => turn.id === turnId))) return null;
  return { turnKey: turnId, itemId, projectionRevision };
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

export async function hydrateLegacyItemPage(
  context: ResumeHistoryContext,
  page: ThreadTurnsListResponse,
): Promise<HydratedThreadHistory> {
  let remainingBudget = Math.min(context.pageSize, 5) * 100;
  const reader = itemPageReader(context);
  const pagination: Record<string, ThreadItemsPagination> = Object.create(null);
  const turns: AppServerTurn[] = [];
  for (const turn of page.data) {
    const items: AppServerThreadItem[] = [];
    const itemIds = new Set<string>();
    const cursors = new Set<string | null>();
    let cursor = context.response.itemsBackwardsCursor ?? null;
    let requestedOnce = false;
    let itemLimit = 100;
    while ((!requestedOnce || cursor !== null) && remainingBudget > 0) {
      cursors.add(cursor);
      requestedOnce = true;
      const itemsPage = await fetchItemsPage(reader, turn.id, cursor, Math.min(itemLimit, remainingBudget), "desc");
      assertItemCursor(cursors, itemsPage.nextCursor, turn.id);
      itemLimit = itemsPage.limit;
      // Preserve descending provider order until the complete slice is assembled.
      for (const item of itemsPage.items.reverse()) {
        if (itemIds.has(item.id)) continue;
        itemIds.add(item.id);
        items.push(item);
      }
      remainingBudget -= Math.max(1, itemsPage.items.length);
      cursor = itemsPage.nextCursor;
    }
    const hasLoadedOldest = requestedOnce && cursor === null;
    const coverage = { olderCursor: cursor, hasLoadedOldest };
    if (!hasLoadedOldest) itemPageCursors.set(coverage, cursors);
    pagination[turn.id] = coverage;
    turns.push({ ...turn, items: items.reverse(), itemsView: hasLoadedOldest ? "full" : requestedOnce ? "summary" : "notLoaded" });
  }
  return { source: "paginated", turns: turns.reverse(), complete: page.nextCursor === null,
    olderCursor: page.nextCursor, itemsPaginationByTurnId: pagination };
}

function assertNewOlderCursor(consumed: ReadonlySet<string>, next: string | null): void {
  if (next !== null && consumed.has(next)) throw new Error("thread/turns/list returned a repeated cursor");
}

function commitOlderCursor(source: DerivedHistorySource, consumed: Set<string>, cursor: string | null, next: string | null): void {
  if (next === null) {
    committedOlderCursors.delete(source);
    return;
  }
  if (cursor !== null) consumed.add(cursor);
  committedOlderCursors.set(source, consumed);
}

function assertSource(ports: DerivedHistoryPorts, operation: DerivedHistoryOperation, source: DerivedHistorySource | null): void {
  operation.assertCurrent();
  if (ports.source() !== source) throw new AppServerClientError("ABORTED", "History source was superseded");
}

function reconcileOlderTurnPage(view: ThreadView, incoming: readonly AppServerTurn[], baselineTurns: readonly AppServerTurn[]) {
  const previous = view.turnsPagination.oldestLoadedTurnId;
  let isolated: readonly AppServerTurn[] = [];
  let existing = view.turns;
  const boundary = existing.findIndex(turn => turn.id === previous);
  // A contiguous page extends the covered tail. Keep still-uncovered search
  // hits outside it until a page supplies their authoritative position.
  if (incoming.length > 0 && (boundary > 0 || (boundary < 0 && view.navigationOnlyTurnIds))) {
    const covered = new Set(incoming.map(turn => turn.id));
    const prefix = boundary > 0 ? existing.slice(0, boundary)
      : existing.filter(turn => view.navigationOnlyTurnIds?.includes(turn.id));
    isolated = prefix.filter(turn => !covered.has(turn.id));
    if (isolated.length) {
      const isolatedIds = new Set(isolated.map(turn => turn.id));
      existing = existing.filter(turn => !isolatedIds.has(turn.id));
    }
  }
  const merged = reconcileHistoryTurns(existing, incoming, "older", { baselineTurns });
  // An overlapping page may contain a newer Turn and advance the cursor
  // without extending the covered range. Preserve the older proven boundary.
  const oldest = merged.find(turn => turn.id === previous || turn.id === incoming[0]?.id);
  return { turns: isolated.length ? [...isolated, ...merged] : merged, oldestLoadedTurnId: oldest?.id ?? null };
}

function expiredPreviewCursor(error: unknown): boolean {
  return error instanceof AppServerRpcError && error.code === -32602 &&
    (error.data as { code?: unknown } | null)?.code === HISTORY_PREVIEW_CURSOR_EXPIRED;
}

const MAX_CURSOR_RECOVERY_PAGES = 8;

export function validateHistoryRecovery(recovery: ThreadHistoryRecovery | undefined): void {
  if (recovery && (typeof recovery.checkpoint?.epoch !== "string" || !Number.isSafeInteger(recovery.checkpoint.nextSeq)
    || recovery.checkpoint.nextSeq < 0 || !["unchanged", "append", "replace"].includes(recovery.mode))) {
    throw new Error("Invalid history recovery checkpoint");
  }
}

/** Apply the supplied coverage without changing execution or stream ownership. */
export function projectResumedHistory(
  projected: ThreadView,
  current: ThreadView,
  initial: ThreadView,
  history: HydratedThreadHistory,
  recovery: ThreadHistoryRecovery | undefined,
  preserveRange: boolean,
  unresolvedTurnIds: readonly string[] | undefined,
  requestedCheckpoint: ThreadHistoryCheckpoint | undefined,
) {
  if (preserveRange && recovery && (!requestedCheckpoint
    || requestedCheckpoint.epoch !== recovery.checkpoint.epoch
    || recovery.checkpoint.nextSeq < requestedCheckpoint.nextSeq
    || (recovery.mode === "unchanged" && (recovery.checkpoint.nextSeq !== requestedCheckpoint.nextSeq || history.turns.length !== 0)))) {
    throw new Error("History recovery does not cover the requested checkpoint");
  }
  const turns = recovery?.mode === "unchanged" ? current.turns
    : recovery?.mode === "replace" ? reconcileRecoveryWindow(projected.turns, history.turns, initial.turns, unresolvedTurnIds)
    : history.source === "message-window" ? reconcileHistoryWindow(projected.turns, history.turns, initial.turns)
    : reconcileHistoryTurns(projected.turns, history.turns, "latest");
  return {
    turns,
    historySource: history.source,
    historyCheckpoint: recovery?.checkpoint,
    historyBaselineRevision: preserveRange ? initial.historyBaselineRevision : current.revision + 1,
    tailHydrationComplete: preserveRange ? initial.tailHydrationComplete : history.complete,
    turnsPagination: preserveRange ? { ...initial.turnsPagination, isLoadingOlder: false } : {
      olderCursor: history.olderCursor,
      // The oldest ordinary Turn and the older cursor come from the same page.
      oldestLoadedTurnId: history.turns[0]?.id ?? null,
      isLoadingOlder: false,
      hasLoadedOldest: history.complete,
    },
    itemsPaginationByTurnId: recovery?.mode === "unchanged" ? initial.itemsPaginationByTurnId
      : preserveRange ? { ...initial.itemsPaginationByTurnId, ...history.itemsPaginationByTurnId } : history.itemsPaginationByTurnId,
  };
}

export function resumeHistoryAdmission(history: HydratedThreadHistory, initial: ThreadView, preserveRange: boolean,
  unresolvedTurnIds: readonly string[] | undefined) {
  return { turns: history.turns, completeAgainst: !preserveRange && history.complete && history.olderCursor === null
    ? initial.turns.filter(turn => !unresolvedTurnIds?.includes(turn.id)) : undefined };
}

async function readOlderPage(
  context: Parameters<typeof readTurnsPage>[0],
  source: DerivedReadContext,
  { olderCursor, oldestLoadedTurnId }: ThreadView["turnsPagination"],
  assertCurrent: () => void,
) {
  if (olderCursor === null) return null;
  const startRecovery = (): OlderCursorRecovery => ({
    expiredCursor: olderCursor, visited: new Set(), anchor: oldestLoadedTurnId, cursor: null,
  });
  let recovery = source.olderCursorRecovery;
  if (recovery?.expiredCursor !== olderCursor) {
    try {
      return await readTurnsPage(context, olderCursor);
    } catch (error) {
      if (!expiredPreviewCursor(error)) throw error;
      assertCurrent();
      recovery = source.olderCursorRecovery = startRecovery();
    }
  }
  if (recovery.failure) throw recovery.failure;
  for (let index = 0; index < MAX_CURSOR_RECOVERY_PAGES; index++) {
    assertCurrent();
    const page = await readTurnsPage(context, recovery.cursor).catch((error: unknown) => {
      assertCurrent();
      if (expiredPreviewCursor(error)) source.olderCursorRecovery = startRecovery();
      throw error;
    });
    assertCurrent();
    const next = page.nextCursor;
    if (next !== null && recovery.visited.has(next)) {
      recovery.failure = new Error("History cursor did not advance during recovery");
      throw recovery.failure;
    }
    if (recovery.anchor === null) return page;
    const anchor = page.data.findIndex(turn => turn.id === recovery.anchor);
    if (anchor !== -1 && (anchor < page.data.length - 1 || next === null))
      return { ...page, data: page.data.slice(anchor + 1) };
    if (next === null) {
      recovery.failure = new Error("History no longer contains the oldest loaded Turn");
      throw recovery.failure;
    }
    // Record progress only after a validated page. A sleep or cancellation
    // can interrupt the next page without losing the recovered position.
    if (recovery.cursor !== null) recovery.visited.add(recovery.cursor);
    recovery.cursor = next;
    if (anchor !== -1) recovery.anchor = null;
  }
  return null;
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
  committedOlderCursors.delete(source);
  ports.views.update(threadId, view => ({ ...view, thread,
    turns: reconcileHistoryWindow(view.turns, history.turns, initial.turns),
    historyBaselineRevision: view.revision + 1,
    tailHydrationComplete: history.complete,
    turnsPagination: { ...view.turnsPagination, olderCursor: history.olderCursor,
      oldestLoadedTurnId: history.turns[0]?.id ?? null, hasLoadedOldest: history.complete }, historyError: null,
  }), { turns: history.turns, completeAgainst: history.complete && history.olderCursor === null ? initial.turns : undefined });
  operation.assertCurrent();
  return true;
}

export async function loadOlderHistory(ports: DerivedHistoryPorts, threadId: string, operation: DerivedHistoryOperation,
  openArchivedHistory?: true): Promise<ThreadView> {
  operation.assertCurrent();
  const source = ports.source(), initial = ports.views.get(threadId);
  assertSource(ports, operation, source);
  if (!source || !initial) throw new Error(`Thread ${threadId} has no history source`);
  const cursor = initial.turnsPagination.olderCursor;
  const itemTurn = "response" in source && initial.historySource === "paginated"
    ? initial.turns.find(turn => initial.itemsPaginationByTurnId[turn.id]?.hasLoadedOldest === false)
    : undefined;
  if (cursor === null && !itemTurn) return initial;
  const consumed = committedOlderCursors.get(source) ?? new Set<string>();
  if (!("response" in source)) {
    if (source.generation !== ports.client.connectionGeneration) throw new AppServerClientError("ABORTED", "History source generation was superseded");
    const context = { client: ports.client, threadId, requestTimeoutMs: ports.requestTimeoutMs, signal: operation.signal, openArchivedHistory };
    const page = await readOlderPage(context, source, initial.turnsPagination, () => assertSource(ports, operation, source));
    assertSource(ports, operation, source);
    if (!page) return ports.views.get(threadId) ?? initial;
    // A successful checkpoint rebase brings its own traversal and can
    // legitimately reuse a cursor from the previous checkpoint.
    const recovery = source.olderCursorRecovery?.expiredCursor === cursor ? source.olderCursorRecovery : undefined;
    const currentChain = recovery?.visited ?? consumed;
    assertNewOlderCursor(currentChain, page.nextCursor);
    const turns = await hydrateReadTurnItems(context, [...page.data].reverse().map(turn => !source.hydrateItems && turn.itemsView === undefined ? { ...turn, itemsView: "full" as const } : turn));
    assertSource(ports, operation, source);
    commitOlderCursor(source, currentChain, recovery ? recovery.cursor : cursor, page.nextCursor);
    delete source.olderCursorRecovery;
    return ports.views.update(threadId, view => {
      const merged = reconcileOlderTurnPage(view, turns, initial.turns);
      return { ...view, turns: merged.turns, tailHydrationComplete: page.nextCursor === null,
        turnsPagination: { olderCursor: page.nextCursor, oldestLoadedTurnId: merged.oldestLoadedTurnId,
          hasLoadedOldest: page.nextCursor === null, isLoadingOlder: false } };
    }, { turns, completeAgainst: page.nextCursor === null ? initial.turns : undefined });
  }
  operation.onCancel = () => {
    if (ports.source() !== source || !ports.views.get(threadId)) return;
    ports.views.update(threadId, view => ({ ...view, turnsPagination: { ...view.turnsPagination, isLoadingOlder: false } }));
  };
  const currentView = () => {
    const view = ports.views.get(threadId);
    assertSource(ports, operation, source);
    return view;
  };
  const itemCoverage = itemTurn && initial.itemsPaginationByTurnId[itemTurn.id]!;
  const settleSupersededItemRead = (view: ThreadView) => view.turnsPagination.isLoadingOlder
    ? ports.views.update(threadId, current => ({ ...current, turnsPagination: { ...current.turnsPagination, isLoadingOlder: false } }))
    : view;
  ports.views.update(threadId, view => ({ ...view, turnsPagination: { ...view.turnsPagination, isLoadingOlder: true }, historyError: null }));
  try {
    assertSource(ports, operation, source);
    if (itemTurn && itemCoverage) {
      const before = itemCoverage;
      const page = await fetchItemsPage(itemPageReader({ ...source, signal: operation.signal, openArchivedHistory }),
        itemTurn.id, before.olderCursor, 100, "desc");
      const view = currentView();
      if (view?.resumeState !== "resumed") return view ?? initial;
      if (view.itemsPaginationByTurnId[itemTurn.id] !== before) return settleSupersededItemRead(view);
      const cursors = itemPageCursors.get(before) ?? new Set<string | null>();
      assertItemCursor(cursors, page.nextCursor, itemTurn.id);
      const next = { olderCursor: page.nextCursor, hasLoadedOldest: page.nextCursor === null };
      if (!next.hasLoadedOldest) {
        cursors.add(before.olderCursor);
        itemPageCursors.set(next, cursors);
      }
      const suffix = itemTurn.items ?? [];
      const known = new Set(suffix.map(item => item.id));
      const items = page.items.filter(item => {
        if (known.has(item.id)) return false;
        known.add(item.id);
        return true;
      });
      const restored = { ...itemTurn, items: [...items, ...suffix], itemsView: next.hasLoadedOldest ? "full" as const : "summary" as const };
      return ports.views.update(threadId, view => ({ ...view,
        turns: reconcileHistoryTurns(view.turns, [restored], "older", { baselineTurns: [itemTurn] }),
        turnsPagination: { ...view.turnsPagination, isLoadingOlder: false },
        itemsPaginationByTurnId: { ...view.itemsPaginationByTurnId, [itemTurn.id]: next },
      }));
    }
    if (cursor === null) return initial;
    const page = await ports.strategies.loadOlder({ ...source, signal: operation.signal }, cursor);
    const view = currentView();
    if (view?.resumeState !== "resumed" || view.turnsPagination.olderCursor !== cursor) return view ?? initial;
    assertNewOlderCursor(consumed, page.olderCursor);
    commitOlderCursor(source, consumed, cursor, page.olderCursor);
    return ports.views.update(threadId, view => {
      const merged = page.source === "message-window" ? {
        turns: reconcileHistoryWindow(view.turns, page.turns),
        oldestLoadedTurnId: page.turns[0]?.id ?? view.turnsPagination.oldestLoadedTurnId,
      } : reconcileOlderTurnPage(view, page.turns, initial.turns);
      return { ...view, turns: merged.turns, tailHydrationComplete: page.complete,
        turnsPagination: { olderCursor: page.olderCursor, oldestLoadedTurnId: merged.oldestLoadedTurnId,
          isLoadingOlder: false, hasLoadedOldest: page.complete },
        itemsPaginationByTurnId: { ...view.itemsPaginationByTurnId, ...page.itemsPaginationByTurnId } };
    }, { turns: page.turns, completeAgainst: page.complete && page.olderCursor === null ? initial.turns : undefined });
  } catch (error) {
    if (!operation.current() || ports.source() !== source) throw error;
    // An optional background drain may have settled this boundary while
    // the manual page was in flight. Its late failure is no longer relevant.
    const view = currentView();
    if (!view) throw error;
    if (itemTurn && view.itemsPaginationByTurnId[itemTurn.id] !== itemCoverage) return settleSupersededItemRead(view);
    if (view.turnsPagination.olderCursor !== cursor) return view;
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
    if (source) committedOlderCursors.delete(source);
    ports.views.update(threadId, current => {
      const merged = reconcileOlderTurnPage(current, olderTurns, baselineTurns);
      return { ...current, turns: merged.turns, tailHydrationComplete: true,
        turnsPagination: { olderCursor: null, oldestLoadedTurnId: merged.oldestLoadedTurnId,
          isLoadingOlder: false, hasLoadedOldest: true }, historyError: null };
    }, { turns: olderTurns, completeAgainst: baselineTurns });
  } catch (error) {
    if (!operation.current() || ports.source() !== source) return;
    ports.views.update(threadId, current => ({ ...current, historyError: error instanceof Error ? error : new Error(String(error)) }));
  }
}
