import type {
  AppServerTurn,
  ThreadItemsListRequest,
  ThreadItemsListResponse,
  ThreadTurnsListRequest,
  ThreadTurnsListResponse,
} from "@opencraft/appserver-protocol";
import type {
  ConversationNavigationAnchor,
  ConversationNavigationSnapshot,
  ConversationNavigationSource,
} from "@opencraft/chat-navigation";
import { conversationNavigationTargetVersion } from "@opencraft/chat-navigation";

import type { ThreadView } from "./models";
import type { HydratedTurnNavigation, TurnPromptPreview } from "./derived-history";
import { isNavigationPromptItem, navigationItemText } from "./navigation-items";
import type {
  ThreadViewProjectionBarrier,
  ThreadViewProjectionCommit,
} from "./projection-barrier";

export type V3TurnLocator = { readonly turnId: string } & (
  { readonly local: true } | { readonly pageCursor: string | null; readonly descendingOffset: number }
);

export interface V3ConversationNavigationPort {
  /** An admitted history baseline, independent of execution activation. */
  getView(): ThreadView | null;
  subscribeView(listener: () => void): () => void;
  listTurns(params: ThreadTurnsListRequest, signal?: AbortSignal): Promise<ThreadTurnsListResponse>;
  listItems?(params: ThreadItemsListRequest, signal: AbortSignal): Promise<ThreadItemsListResponse>;
  commitHydratedTurn(
    turn: AppServerTurn,
    chronologicalTurnIds: readonly string[],
    baselineTurn: AppServerTurn | undefined,
    intent?: "search",
  ): ThreadViewProjectionCommit;
  readonly projectionBarrier: ThreadViewProjectionBarrier;
}

export interface V3ConversationNavigationConfig {
  readonly threadId: string;
  readonly port: V3ConversationNavigationPort;
  readonly maxPages?: number;
  readonly pageSize?: number;
}

function hasPartialItems(turn: AppServerTurn): boolean {
  return turn.itemsView === "summary" || turn.itemsView === "notLoaded";
}

function navigationAnchorId(turnId: string, promptIndex: number): string {
  return `v3:${turnId}:user:${promptIndex}`;
}

export function projectionCommitForView(view: ThreadView): ThreadViewProjectionCommit {
  return {
    hostId: view.hostId,
    threadId: view.threadId,
    connectionGeneration: view.connectionGeneration,
    viewRevision: view.revision,
  };
}

const supersededSearch = new DOMException("Search selection superseded", "AbortError");

/**
 * AppServer V3 compatibility source. It enumerates lightweight Turn stubs, then
 * hydrates only one full Turn for hover or navigation.
 */
export function createV3ConversationNavigationSource(
  config: V3ConversationNavigationConfig,
): ConversationNavigationSource {
  const maxPages = config.maxPages ?? 10;
  const pageSize = config.pageSize ?? 100;
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError("maxPages must be positive");
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize must be positive");

  const listeners = new Set<() => void>();
  // The rail needs only the first prompt's metadata, never assistant/tool output.
  // ThreadView Turns are immutable; a replacement also invalidates null results.
  type PromptAnchor = Pick<TurnPromptPreview, "itemId" | "label" | "isHeartbeat">;
  const promptAnchors = new WeakMap<AppServerTurn, PromptAnchor | null>();
  const firstPrompt = (turn: AppServerTurn): PromptAnchor | null => {
    const cached = promptAnchors.get(turn);
    if (cached !== undefined) return cached;
    const item = turn.items?.find(isNavigationPromptItem);
    const prompt = item ? {
      itemId: item.id, label: navigationItemText(item).trim(), isHeartbeat: item.type === "hookPrompt",
    } : null;
    promptAnchors.set(turn, prompt);
    return prompt;
  };
  const hydratedByTurnId = new Map<string, HydratedTurnNavigation>();
  const hydrationOperations = new Map<string, {
    readonly generation: string;
    readonly promise: Promise<HydratedTurnNavigation | null>;
    readonly controller: AbortController;
  }>();
  let locatedRead: AbortController | null = null;
  const resetHydration = () => {
    hydratedByTurnId.clear();
    for (const operation of hydrationOperations.values()) operation.controller.abort();
    hydrationOperations.clear();
    locatedRead?.abort();
    locatedRead = null;
  };
  let locators: readonly V3TurnLocator[] = [];
  let adoptedTurns: ThreadView["turns"] | undefined;
  const orderedTurnIds = () => locators.map(locator => locator.turnId);
  let completeness: "complete" | "partial" = "partial";
  let phase: ConversationNavigationSnapshot["phase"] = "empty";
  let error: Error | null = null;
  let revision = 0;
  let disposed = false;
  let prepareOperation: { cancel: () => void; promise: Promise<void> } | null = null;
  let scannedGeneration: string | null = null;
  let requested = false;
  let snapshot: ConversationNavigationSnapshot;
  const findAnchor = (id: string) => snapshot.anchors.find(anchor => anchor.id === id);

  const generation = (view = config.port.getView()): string | null =>
    view === null ? null : `appserver-v3:${view.hostId}:${view.historyCheckpoint ? `${view.historyCheckpoint.epoch}:${view.historyCheckpoint.nextSeq}` : view.connectionGeneration}:${view.historyMode}:${view.historyBaselineRevision ?? 0}`;

  const anchors = (view: ThreadView | null): readonly ConversationNavigationAnchor[] => {
    const loaded = new Map<string, PromptAnchor>();
    for (const turn of view?.turns ?? []) {
      if (hasPartialItems(turn)) continue;
      const prompt = firstPrompt(turn);
      if (prompt) loaded.set(turn.id, prompt);
    }
    const turnIds = orderedTurnIds();
    const seen = new Set(turnIds);
    const turns = view?.turns ?? [];
    const independent = adoptedTurns ? view?.navigationOnlyTurnIds : undefined;
    const boundary = view?.historyMode === "paginated"
      ? turns.findIndex(turn => turn.id === view.turnsPagination.oldestLoadedTurnId) : -1;
    // A sparse search hit becomes a rail anchor only when its order is known.
    for (let index = Math.max(0, boundary); index < turns.length; index++) {
      const turn = turns[index]!;
      if (turn.id !== view?.unplacedSearchTurnId && !independent?.includes(turn.id) &&
          !seen.has(turn.id) && firstPrompt(turn) !== null) {
        seen.add(turn.id);
        turnIds.push(turn.id);
      }
    }
    return turnIds.map((turnId, order): ConversationNavigationAnchor => {
      const prompt = loaded.get(turnId) ?? hydratedByTurnId.get(turnId)?.prompts[0];
      return {
        // V3 exposes only a lightweight Turn index. Hydration may enrich this
        // anchor, but must never expand/reorder the rail within one generation.
        // Item-level topology belongs to the V4 Prompt Index.
        id: navigationAnchorId(turnId, 0),
        turnKey: turnId,
        itemId: prompt?.itemId ?? null,
        order,
        label: prompt?.label ?? "",
        isLoaded: loaded.has(turnId),
        isHeartbeat: prompt?.isHeartbeat ?? false,
      };
    });
  };

  const rebuild = () => {
    const view = config.port.getView();
    if (view?.tailHydrationComplete === true && locators.length === 0) completeness = "complete";
    revision += 1;
    snapshot = {
      revision,
      phase,
      generation: generation(view),
      completeness,
      anchors: anchors(view),
      error,
    };
  };

  const publish = () => {
    rebuild();
    for (const listener of listeners) listener();
  };
  rebuild();

  const stopScan = () => {
    const previous = prepareOperation;
    prepareOperation = null;
    previous?.cancel();
  };

  const retireGeneration = (next: string | null): boolean => {
    if (next === snapshot.generation) return false;
    stopScan();
    resetHydration();
    locators = [];
    adoptedTurns = undefined;
    completeness = "partial";
    phase = "empty";
    error = null;
    scannedGeneration = null;
    return true;
  };

  const adoptCompleteView = (view: ThreadView | null, owner: string | null): boolean => {
    if (!view || view.historyMode === "message-window" ||
        !view.turnsPagination.hasLoadedOldest || view.turnsPagination.olderCursor !== null) {
      if (adoptedTurns) {
        adoptedTurns = undefined;
        locators = [];
        scannedGeneration = null;
        phase = "empty";
        completeness = "partial";
      }
      return false;
    }
    if (adoptedTurns === view.turns) return false;
    adoptedTurns = view.turns;
    locators = [...new Set(view.turns.map(turn => turn.id))]
      .filter(turnId => turnId !== view.unplacedSearchTurnId && !view.navigationOnlyTurnIds?.includes(turnId))
      .map(turnId => ({ turnId, local: true }));
    completeness = "complete";
    phase = "ready";
    error = null;
    scannedGeneration = owner;
    stopScan();
    return true;
  };

  const enumerate = async (expectedGeneration: string | null, signal: AbortSignal): Promise<void> => {
    const current = () => !disposed && !signal.aborted && generation() === expectedGeneration;
    if (!current()) return;
    phase = "loading";
    error = null;
    publish();
    if (!current()) return;
    try {
      const { discoverNavigationTurns } = await import("./derived-history");
      const index = await discoverNavigationTurns(config.threadId, (params, signal) => config.port.listTurns(params, signal),
        config.port.getView(), pageSize, maxPages, signal, current);
      if (!index || !current()) return;
      const { complete } = index;
      locators = index.locators;
      completeness = complete ? "complete" : "partial";
      phase = complete ? "ready" : "degraded";
      scannedGeneration = expectedGeneration;
      publish();
    } catch (cause) {
      if (!current()) return;
      error = cause instanceof Error ? cause : new Error(String(cause));
      phase = "degraded";
      completeness = "partial";
      scannedGeneration = expectedGeneration;
      publish();
    }
  };

  const prepare = (): Promise<void> => {
    requested = true;
    if (disposed) return Promise.resolve();
    const view = config.port.getView();
    const nextGeneration = generation(view);
    const changed = retireGeneration(nextGeneration);
    if (view === null) {
      if (changed) publish();
      return Promise.resolve();
    }
    if (view.historyMode === "message-window") {
      locators = [];
      completeness = view.tailHydrationComplete ? "complete" : "partial";
      phase = view.tailHydrationComplete ? "ready" : "degraded";
      scannedGeneration = nextGeneration;
      publish();
      return Promise.resolve();
    }
    if (adoptCompleteView(view, nextGeneration)) {
      publish();
      return Promise.resolve();
    }
    if (scannedGeneration === nextGeneration && error === null && (phase === "ready" || phase === "degraded")) {
      return Promise.resolve();
    }
    if (prepareOperation !== null) return prepareOperation.promise;
    const controller = new AbortController();
    let finish = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      finish = resolve;
      void Promise.resolve().then(() => enumerate(nextGeneration, controller.signal)).then(resolve, reject);
    }).finally(() => {
      if (prepareOperation?.promise !== promise) return;
      prepareOperation = null;
      if (!disposed && generation() !== nextGeneration) void prepare();
    });
    prepareOperation = { promise, cancel: () => { finish(); controller.abort(); } };
    if (changed) publish();
    return promise;
  };

  const fetchHydratedTurn = (
    turnId: string,
    expectedGeneration: string | null,
  ): Promise<HydratedTurnNavigation | null> => {
    if (disposed || expectedGeneration === null || generation() !== expectedGeneration) return Promise.resolve(null);
    const loaded = config.port.getView()?.turns.find((turn) => turn.id === turnId);
    if (loaded !== undefined && !hasPartialItems(loaded) && firstPrompt(loaded) !== null) {
      return import("./derived-history").then(({ projectTurnPrompts }) => ({
        turn: loaded, baselineTurn: loaded, prompts: projectTurnPrompts(loaded),
      }));
    }
    const cached = hydratedByTurnId.get(turnId);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = hydrationOperations.get(turnId);
    if (pending?.generation === expectedGeneration) return pending.promise;
    const locator = locators.find((candidate) => candidate.turnId === turnId);
    if (locator === undefined) return Promise.resolve(null);
    const controller = new AbortController();
    const current = () => !disposed && !controller.signal.aborted && generation() === expectedGeneration;
    const promise = (async () => {
      const { projectTurnPrompts, readNavigationTurn } = await import("./derived-history");
      if (!current()) return null;
      const turn = await readNavigationTurn(config.port, config.threadId, locator, loaded, controller.signal, current);
      if (!current() || !turn) return null;
      const result: HydratedTurnNavigation = {
        turn,
        baselineTurn: loaded,
        prompts: projectTurnPrompts(turn),
      };
      if (disposed) return null;
      hydratedByTurnId.set(turnId, result);
      publish();
      return result;
    })().catch(error => {
      if (!current()) return null;
      throw error;
    }).finally(() => {
      if (hydrationOperations.get(turnId)?.promise === promise) hydrationOperations.delete(turnId);
    });
    hydrationOperations.set(turnId, { generation: expectedGeneration, promise, controller });
    return promise;
  };

  const removeViewListener = config.port.subscribeView(() => {
    if (disposed) return;
    const view = config.port.getView();
    const owner = generation(view);
    retireGeneration(owner);
    if (requested) adoptCompleteView(view, owner);
    publish();
    // Index discovery is requested by the rail/search consumer, not retention.
    if (requested && view && (view.historyMode === "message-window" || scannedGeneration === null)) {
      void prepare();
    }
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prepare,
    async loadPreview(anchorId) {
      if (disposed) return null;
      const anchor = findAnchor(anchorId);
      if (anchor === undefined) return null;
      const expectedGeneration = snapshot.generation;
      const { selectNavigationPreview } = await import("./derived-history");
      const hydrated = await fetchHydratedTurn(anchor.turnKey, expectedGeneration);
      if (hydrated === null || disposed || generation() !== expectedGeneration || !findAnchor(anchorId)) return null;
      return selectNavigationPreview(hydrated.prompts, anchor.itemId);
    },
    async prepareTarget(anchorId, options) {
      const isAborted = () => disposed || options?.signal?.aborted === true;
      const anchor = findAnchor(anchorId);
      if (anchor === undefined) return null;
      const expectedGeneration = snapshot.generation;
      if (expectedGeneration === null || isAborted() || generation() !== expectedGeneration) return null;
      const { projectNavigationAnchorTarget } = await import("./derived-history");
      return projectNavigationAnchorTarget(config.port, anchor, expectedGeneration, options, {
        current: () => !isAborted() && generation() === expectedGeneration,
        getAnchor: () => findAnchor(anchorId),
        orderedTurnIds,
        hydrate: () => fetchHydratedTurn(anchor.turnKey, expectedGeneration),
      });
    },
    async prepareLocatedTarget(target, signal) {
      const owner = generation();
      if (!owner || disposed || signal.aborted) return null;
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      const current = () => !disposed && !controller.signal.aborted && generation() === owner;
      locatedRead?.abort(supersededSearch);
      locatedRead = controller;
      signal.addEventListener("abort", abort, { once: true });
      let prepared;
      try {
        const { projectLocatedNavigationTarget } = await import("./derived-history");
        prepared = await projectLocatedNavigationTarget(config.port, target, orderedTurnIds, controller.signal, current);
      } catch (error) {
        if (current()) throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        if (locatedRead === controller) locatedRead = null;
      }
      if (controller.signal.reason === supersededSearch) throw supersededSearch;
      return prepared && current() ? { ...prepared, anchorId: navigationAnchorId(target.turnId, 0),
        generation: owner, targetVersion: conversationNavigationTargetVersion(prepared) } : null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopScan();
      removeViewListener();
      listeners.clear();
      resetHydration();
    },
  };
}
