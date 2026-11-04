import { useIntl } from "@opencraft/i18n/react";
import { useOptionalAsyncNotices } from "../async-notices";
import {
  createDefaultToolActivityPresenterRegistry,
  presentToolActivity,
  type TimelineBlock,
  type AsyncQuestion,
  type AsyncQuestionState,
  type ConversationDetailLevel,
  type ToolActivityPresentation,
  type ToolActivityPresenterRegistry,
} from "@opencraft/chat-core";
import {
  setupContextSourceExamples,
  type SetupContextSource,
  type WorkbenchInteractionAction,
} from "@opencraft/workbench-runtime";
import {
  createContext,
  useContext,
  useMemo,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type ConversationInteractionAction = WorkbenchInteractionAction;

export interface ConversationInteractionContextValue {
  readonly responseState?: "pending" | "responding" | "unconfirmed";
  readonly canRespond?: boolean;
  readonly drafts?: Map<string, unknown>;
  readonly respond: ((requestId: string, action: ConversationInteractionAction) => Promise<void>) | null;
}

export const ConversationInteractionContext = createContext<ConversationInteractionContextValue>({ respond: null });

export interface AsyncQuestionDraft {
  readonly selectedIndex: number | null;
  readonly otherText: string;
}

export interface AsyncQuestionContextValue {
  readonly states: ReadonlyMap<string, AsyncQuestionState>;
  readonly answers: ReadonlyMap<string, string>;
  readonly queuedIds: ReadonlySet<string>;
  readonly drafts: Readonly<Record<string, AsyncQuestionDraft>>;
  readonly submittingIds: ReadonlySet<string>;
  readonly errors: Readonly<Record<string, string>>;
  readonly answer: ((question: AsyncQuestion, answer: string) => Promise<void>) | null;
  readonly updateDraft: (questionId: string, draft: AsyncQuestionDraft) => void;
}

export const AsyncQuestionContext = createContext<AsyncQuestionContextValue>({
  states: new Map(), answers: new Map(), queuedIds: new Set(), drafts: {}, submittingIds: new Set(), errors: {},
  answer: null, updateDraft: () => undefined,
});
export const HistoryItemDetailContext = createContext<((ids: readonly string[], signal: AbortSignal) => Promise<void>) | null>(null);
export function useHistoryItemDetail(block: TimelineBlock, open: boolean): void {
  const load = useContext(HistoryItemDetailContext);
  const intl = useIntl(), notices = useOptionalAsyncNotices();
  const ids = JSON.stringify(block.sourceItemIds);
  useEffect(() => {
    if (!open || !block.historyDetail || !load) return;
    const controller = new AbortController();
    void load(JSON.parse(ids), controller.signal).catch(error => {
      if (controller.signal.aborted || error?.code === "ABORTED") return;
      notices?.error({ key: `history-item:${ids}`, message: intl.formatMessage({ id: "chat.restore.failed", defaultMessage: "Could not load this conversation" }) });
    });
    return () => controller.abort();
  }, [open, block.historyDetail, ids, load, notices, intl]);
}

export const ConversationDetailContext = createContext<ConversationDetailLevel>("STEPS_COMMANDS");

export interface SetupContextCatalogValue {
  readonly sources: readonly SetupContextSource[];
  readonly loading: boolean;
  readonly connect: ((source: SetupContextSource) => Promise<void>) | null;
}

export const SetupContextCatalog = createContext<SetupContextCatalogValue>({
  sources: setupContextSourceExamples,
  loading: false,
  connect: null,
});

export const DEFAULT_TOOL_ACTIVITY_PRESENTERS = createDefaultToolActivityPresenterRegistry();
export const ToolActivityPresenterContext = createContext<ToolActivityPresenterRegistry>(DEFAULT_TOOL_ACTIVITY_PRESENTERS);

export type ToolCallContentRenderer = (
  block: Extract<TimelineBlock, { type: "tool-call" }>,
  presentation: ToolActivityPresentation,
) => ReactNode | undefined;

export const ToolCallContentRendererContext = createContext<ToolCallContentRenderer | null>(null);

/** Host-owned icon seam for MCP apps, browser favicons, and plugin/catalog logos. */
export type ToolCallIconRenderer = (
  block: Extract<TimelineBlock, { type: "tool-call" }>,
  presentation: ToolActivityPresentation,
) => ReactNode | undefined;

export const ToolCallIconRendererContext = createContext<ToolCallIconRenderer | null>(null);

export interface SubagentNavigationContextValue {
  readonly open: ((threadId: string, displayName: string) => void) | null;
}

export const SubagentNavigationContext = createContext<SubagentNavigationContextValue>({ open: null });

export function useToolActivityPresentation(
  block: Extract<TimelineBlock, { type: "command-execution" | "patch" | "tool-call" | "subagent" }>,
): ToolActivityPresentation {
  const registry = useContext(ToolActivityPresenterContext);
  const version = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  return useMemo(() => { const result = presentToolActivity(block, registry); return block.historyDetail ? { ...result, canExpand: true } : result; }, [block, registry, version]);
}
