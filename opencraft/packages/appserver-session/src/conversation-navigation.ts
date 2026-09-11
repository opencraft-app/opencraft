import type {
  AppServerThreadItem,
  AppServerTurn,
  ThreadTurnsListRequest,
  ThreadTurnsListResponse,
} from "@opencraft/appserver-protocol";
import type {
  ConversationNavigationAnchor,
  ConversationNavigationOutput,
  ConversationNavigationPreview,
  ConversationNavigationSnapshot,
  ConversationNavigationSource,
} from "@opencraft/chat-navigation";
import { conversationNavigationTargetVersion } from "@opencraft/chat-navigation";

import type { ThreadView } from "./models";
import type {
  ThreadViewProjectionBarrier,
  ThreadViewProjectionCommit,
} from "./projection-barrier";

interface V3TurnLocator {
  readonly turnId: string;
  readonly pageBackwardsCursor: string | null;
  readonly descendingOffset: number;
}

interface TurnPromptPreview {
  readonly itemId: string;
  readonly label: string;
  readonly response: string;
  readonly outputs: readonly ConversationNavigationOutput[];
  readonly isHeartbeat: boolean;
}

interface HydratedTurnNavigation {
  readonly turn: AppServerTurn;
  readonly turnCursor: string | null;
  readonly prompts: readonly TurnPromptPreview[];
}

export interface CodexV3ConversationNavigationPort {
  getView(): ThreadView | null;
  subscribeView(listener: () => void): () => void;
  listTurns(params: ThreadTurnsListRequest): Promise<ThreadTurnsListResponse>;
  commitHydratedTurn(
    turn: AppServerTurn,
    chronologicalTurnIds: readonly string[],
  ): ThreadViewProjectionCommit;
  readonly projectionBarrier: ThreadViewProjectionBarrier;
}

export interface CodexV3ConversationNavigationConfig {
  readonly threadId: string;
  readonly port: CodexV3ConversationNavigationPort;
  readonly maxPages?: number;
  readonly pageSize?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (!isRecord(entry)) return [];
    return typeof entry.text === "string" ? [entry.text] : [];
  }).join("\n");
}

function itemText(item: AppServerThreadItem): string {
  return textFrom(item.content ?? item.text ?? item.message ?? item.fragments);
}

function isUserMessage(item: AppServerThreadItem): boolean {
  return item.type === "userMessage" || item.type === "steeringUserMessage" || item.type === "hookPrompt";
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

function projectTurnPrompts(turn: AppServerTurn): readonly TurnPromptPreview[] {
  const prompts: Array<{
    itemId: string;
    label: string;
    response: string;
    outputs: ConversationNavigationOutput[];
    isHeartbeat: boolean;
  }> = [];
  for (const item of turn.items ?? []) {
    if (isUserMessage(item)) {
      prompts.push({
        itemId: item.id,
        label: itemText(item).trim(),
        response: "",
        outputs: [],
        isHeartbeat: item.type === "hookPrompt",
      });
      continue;
    }
    const current = prompts.at(-1);
    if (current === undefined) continue;
    if (isAssistantMessage(item)) {
      const response = itemText(item).trim();
      if (response.length > 0) current.response = response;
    }
    current.outputs.push(...outputForItem(item));
  }
  return prompts.map((prompt) => ({
    ...prompt,
    outputs: deduplicateOutputs(prompt.outputs),
  }));
}

function loadedTurnMap(view: ThreadView | null): ReadonlyMap<string, AppServerTurn> {
  return new Map((view?.turns ?? []).filter((turn) => projectTurnPrompts(turn).length > 0).map((turn) => [turn.id, turn]));
}

function navigationAnchorId(turnId: string, promptIndex: number): string {
  return `v3:${turnId}:user:${promptIndex}`;
}

function projectionCommitForView(view: ThreadView): ThreadViewProjectionCommit {
  return {
    hostId: view.hostId,
    threadId: view.threadId,
    connectionGeneration: view.connectionGeneration,
    viewRevision: view.revision,
  };
}

/**
 * Codex V3 compatibility source. It enumerates lightweight Turn stubs, then
 * hydrates only one full Turn for hover or navigation.
 */
export function createCodexV3ConversationNavigationSource(
  config: CodexV3ConversationNavigationConfig,
): ConversationNavigationSource {
  const maxPages = config.maxPages ?? 10;
  const pageSize = config.pageSize ?? 100;
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError("maxPages must be positive");
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize must be positive");

  const listeners = new Set<() => void>();
  const hydratedByTurnId = new Map<string, HydratedTurnNavigation>();
  const hydrationOperations = new Map<string, {
    readonly generation: string;
    readonly promise: Promise<HydratedTurnNavigation | null>;
  }>();
  let locators: readonly V3TurnLocator[] = [];
  let completeness: "complete" | "partial" = "partial";
  let phase: ConversationNavigationSnapshot["phase"] = "empty";
  let error: Error | null = null;
  let revision = 0;
  let disposed = false;
  let prepareOperation: Promise<void> | null = null;
  let preparedGeneration: string | null = null;
  let snapshot: ConversationNavigationSnapshot;

  const generation = (): string | null => {
    const view = config.port.getView();
    return view === null ? null : `codex-v3:${view.hostId}:${view.connectionGeneration}`;
  };

  const anchors = (): readonly ConversationNavigationAnchor[] => {
    const view = config.port.getView();
    const loaded = loadedTurnMap(view);
    const orderedTurnIds: string[] = [];
    const seen = new Set<string>();
    for (const locator of locators) {
      if (!seen.has(locator.turnId)) {
        seen.add(locator.turnId);
        orderedTurnIds.push(locator.turnId);
      }
    }
    for (const turn of view?.turns ?? []) {
      if (!seen.has(turn.id) && projectTurnPrompts(turn).length > 0) {
        seen.add(turn.id);
        orderedTurnIds.push(turn.id);
      }
    }
    return orderedTurnIds.map((turnId, order): ConversationNavigationAnchor => {
      const loadedTurn = loaded.get(turnId);
      const cached = hydratedByTurnId.get(turnId);
      const prompts = loadedTurn === undefined ? cached?.prompts : projectTurnPrompts(loadedTurn);
      const prompt = prompts?.[0];
      return {
        // V3 exposes only a lightweight Turn index. Hydration may enrich this
        // anchor, but must never expand/reorder the rail within one generation.
        // Item-level topology belongs to the V4 Prompt Index.
        id: navigationAnchorId(turnId, 0),
        turnKey: turnId,
        itemId: prompt?.itemId ?? null,
        order,
        label: prompt?.label ?? "",
        isLoaded: loadedTurn !== undefined,
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
      generation: generation(),
      completeness,
      anchors: anchors(),
      error,
    };
  };

  const publish = () => {
    rebuild();
    for (const listener of listeners) listener();
  };
  rebuild();

  const enumerate = async (): Promise<void> => {
    phase = "loading";
    error = null;
    publish();
    const nextLocators: V3TurnLocator[] = [];
    let cursor: string | null = null;
    let complete = false;
    try {
      for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const page = await config.port.listTurns({
          threadId: config.threadId,
          cursor,
          limit: pageSize,
          itemsView: "notLoaded",
          sortDirection: "desc",
        });
        page.data.forEach((turn, descendingOffset) => {
          nextLocators.push({
            turnId: turn.id,
            pageBackwardsCursor: page.backwardsCursor ?? cursor,
            descendingOffset,
          });
        });
        if (page.nextCursor === null) {
          complete = true;
          break;
        }
        if (page.nextCursor === cursor) throw new Error("thread/turns/list repeated a cursor");
        cursor = page.nextCursor;
      }
      locators = nextLocators.reverse();
      completeness = complete ? "complete" : "partial";
      phase = complete ? "ready" : "degraded";
      preparedGeneration = generation();
      publish();
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error(String(cause));
      phase = "degraded";
      completeness = "partial";
      publish();
    }
  };

  const prepare = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    const view = config.port.getView();
    // Resume owns discovery of the history model. Enumerating before it has
    // settled can accidentally turn a message-window provider into a second
    // all-history reader, competing with foreground hydration.
    if (view === null || view.resumeState !== "resumed") return Promise.resolve();
    if (view.historyMode === "message-window") {
      locators = [];
      completeness = view.tailHydrationComplete ? "complete" : "partial";
      phase = view.tailHydrationComplete ? "ready" : "degraded";
      preparedGeneration = generation();
      publish();
      return Promise.resolve();
    }
    if (preparedGeneration === generation() && (phase === "ready" || phase === "degraded")) {
      return Promise.resolve();
    }
    if (prepareOperation !== null) return prepareOperation;
    const operation = enumerate().finally(() => {
      if (prepareOperation === operation) prepareOperation = null;
    });
    prepareOperation = operation;
    return operation;
  };

  const fetchHydratedTurn = (
    turnId: string,
    expectedGeneration: string | null,
  ): Promise<HydratedTurnNavigation | null> => {
    if (disposed || expectedGeneration === null || generation() !== expectedGeneration) return Promise.resolve(null);
    const loaded = config.port.getView()?.turns.find((turn) => turn.id === turnId);
    if (loaded !== undefined && projectTurnPrompts(loaded).length > 0) {
      return Promise.resolve({ turn: loaded, turnCursor: null, prompts: projectTurnPrompts(loaded) });
    }
    const cached = hydratedByTurnId.get(turnId);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = hydrationOperations.get(turnId);
    if (pending?.generation === expectedGeneration) return pending.promise;
    const locator = locators.find((candidate) => candidate.turnId === turnId);
    if (locator === undefined) return Promise.resolve(null);
    const promise = (async () => {
      let cursor = locator.pageBackwardsCursor;
      if (locator.descendingOffset > 0) {
        const skipped = await config.port.listTurns({
          threadId: config.threadId,
          cursor,
          limit: locator.descendingOffset,
          itemsView: "notLoaded",
          sortDirection: "desc",
        });
        if (disposed || generation() !== expectedGeneration) return null;
        cursor = skipped.nextCursor;
        if (cursor === null) return null;
      }
      const page = await config.port.listTurns({
        threadId: config.threadId,
        cursor,
        limit: 1,
        itemsView: "full",
        sortDirection: "desc",
      });
      if (disposed || generation() !== expectedGeneration) return null;
      const turn = page.data[0];
      if (turn === undefined || turn.id !== turnId) return null;
      const result: HydratedTurnNavigation = {
        turn,
        turnCursor: page.backwardsCursor ?? cursor,
        prompts: projectTurnPrompts(turn),
      };
      if (disposed) return null;
      hydratedByTurnId.set(turnId, result);
      publish();
      return result;
    })().finally(() => {
      if (hydrationOperations.get(turnId)?.promise === promise) hydrationOperations.delete(turnId);
    });
    hydrationOperations.set(turnId, { generation: expectedGeneration, promise });
    return promise;
  };

  const removeViewListener = config.port.subscribeView(() => {
    if (disposed) return;
    const view = config.port.getView();
    if (view?.historyMode === "message-window" || (preparedGeneration === null && view?.resumeState === "resumed")) {
      publish();
      void prepare();
      return;
    }
    const nextGeneration = generation();
    if (preparedGeneration !== null && nextGeneration !== preparedGeneration) {
      locators = [];
      hydratedByTurnId.clear();
      hydrationOperations.clear();
      completeness = "partial";
      phase = "empty";
      preparedGeneration = null;
      publish();
      void prepare();
      return;
    }
    publish();
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
      const anchor = snapshot.anchors.find((candidate) => candidate.id === anchorId);
      if (anchor === undefined) return null;
      const hydrated = await fetchHydratedTurn(anchor.turnKey, generation());
      if (hydrated === null || disposed) return null;
      const prompt = hydrated.prompts.find((candidate) => candidate.itemId === anchor.itemId)
        ?? hydrated.prompts[0];
      return prompt === undefined ? null : {
        label: prompt.label,
        response: prompt.response,
        outputs: prompt.outputs,
      };
    },
    async prepareTarget(anchorId, options) {
      const isAborted = () => disposed || options?.signal?.aborted === true;
      const anchor = snapshot.anchors.find((candidate) => candidate.id === anchorId);
      if (anchor === undefined) return null;
      const expectedGeneration = generation();
      if (expectedGeneration === null || isAborted()) return null;
      if (anchor.isLoaded) {
        const currentView = config.port.getView();
        if (currentView === null) return null;
        const projectionRevision = await config.port.projectionBarrier.waitUntilProjected(
          projectionCommitForView(currentView),
          options,
        );
        if (isAborted() || generation() !== expectedGeneration) return null;
        const target = { turnKey: anchor.turnKey, itemId: anchor.itemId, projectionRevision };
        const currentAnchor = snapshot.anchors.find((candidate) => candidate.id === anchorId);
        if (
          currentAnchor === undefined
          || conversationNavigationTargetVersion(currentAnchor) !== conversationNavigationTargetVersion(target)
        ) return null;
        return {
          ...target,
          anchorId,
          generation: expectedGeneration,
          targetVersion: conversationNavigationTargetVersion(target),
        };
      }
      const hydrated = await fetchHydratedTurn(anchor.turnKey, expectedGeneration);
      if (
        hydrated === null
        || isAborted()
        || generation() !== expectedGeneration
      ) return null;
      const prompt = hydrated.prompts.find((candidate) => candidate.itemId === anchor.itemId)
        ?? hydrated.prompts[0];
      if (prompt === undefined) return null;
      const commit = config.port.commitHydratedTurn(
        hydrated.turn,
        locators.map((locator) => locator.turnId),
      );
      const projectionRevision = await config.port.projectionBarrier.waitUntilProjected(commit, options);
      if (isAborted() || generation() !== expectedGeneration) return null;
      const target = {
        turnKey: anchor.turnKey,
        itemId: prompt.itemId,
        projectionRevision,
      };
      const currentAnchor = snapshot.anchors.find((candidate) => candidate.id === anchorId);
      if (
        currentAnchor === undefined
        || conversationNavigationTargetVersion(currentAnchor) !== conversationNavigationTargetVersion(target)
      ) return null;
      return {
        ...target,
        anchorId,
        generation: expectedGeneration,
        targetVersion: conversationNavigationTargetVersion(target),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      removeViewListener();
      listeners.clear();
      hydratedByTurnId.clear();
      hydrationOperations.clear();
    },
  };
}
