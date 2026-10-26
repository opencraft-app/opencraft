import { LoadingRingIcon } from "@opencraft/design-system-web/action-icons";
import { ForkTurnButton } from "./conversation/fork-turn-button";
import { MessageTimestamp } from "./conversation/message-timestamp";
import { PatchActivityIcon } from "./activity-glyphs";
import { ResetIcon as RotateCcw } from "@opencraft/design-system-web/action-icons";
import { ConversationSelectionMenu } from "./conversation/selection-menu";
import { ConversationEntryMotionContext, useConversationEntryMotion } from "./conversation/entry-motion";
import { CommandViewStateContext, type CommandViewState } from "./conversation/command-view-state";
import { VisibleTurnReceipt, VisibleTurnReceiptContext } from "./conversation/visible-turn-receipt";
import { useIntl } from "@opencraft/i18n/react";
import { ThinkingLabel } from "./thinking-label";
import { ResponsePositionedTurns, type ResponsePositionedTurnsApi } from "./conversation/response-positioned-turns";
import {
  createTimelineTurnPresentationPlan,
  activeTimelineTurnTodo,
  ReasoningPresentationCache,
  deriveAsyncQuestionPresentation,
  groupTimelineFramesByTurn,
  presentAutomationUpdate,
  type AssistantTurnPresentationPlan,
  type AutomationUpdateTimelineBlock,
  type TimelineBlock,
  type TimelineFrame,
  type TimelineSnapshot,
  type AsyncQuestion,
  type ToolActivityPresentation,
  type ToolActivityPresenterRegistry,
  type TimelineTurnView,
  type TurnId,
} from "@opencraft/chat-core";
import type { ConversationNavigationSource } from "@opencraft/chat-navigation";
import {
  WebChatDocument,
  ChatReadingPositionContext,
  type ChatReadingPosition,
  resolveStandardChatResource,
} from "@opencraft/chat-render-web";
import {
  normalizeInitialScrollDistance,
  normalizeInvertedWebViewportMetrics,
  shouldShowScrollToBottomAction,
  DEFAULT_TIMELINE_SURFACE_CAPABILITIES,
  type LatestTurnPlacementSnapshot,
  type TimelineSurfaceCapabilities,
  type TurnConversationScrollApi,
  type TurnFollowRestoreState,
  type VirtualizedTurnRestoreState,
  type VirtualizedTurnListApi,
} from "@opencraft/timeline-virtualizer";
import {
  createWebConversationViewportOwner,
} from "@opencraft/timeline-host-web";
import { useStableEvent } from "@opencraft/react-runtime";
import { useTurnHistoryBackfill } from "@opencraft/timeline-react";
import type { TimelineBlockRendererProps } from "@opencraft/timeline-render-react";
import { UserMessageNavigationRail } from "./user-message-navigation-rail";
import { ConversationSearchPosition } from "./conversation-search-position";
import { DisclosureReflowContext } from "./use-disclosure-reflow";
import { useLatestTurnFollowContentRef } from "./latest-turn-follow-content";
import { AlertIcon as AlertCircle, ArrowRightIcon as ArrowRight, CalendarIcon as CalendarClock, CodeFileIcon as FileCode2 } from "@opencraft/design-system-web/action-icons";
import {
  motion,
  type MotionValue,
} from "motion/react";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  Suspense,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { VirtualizedConversationTurns, type WebVirtualizedTurnListApi } from "./conversation/virtualized-conversation-turns";
import { assistantMessageActions, getTimelineUserMessageTargetKey } from "@opencraft/chat-core";
import { extractMarkdownElement } from "@opencraft/chat-render-web";
import { ActivitySummaryRow } from "./conversation-renderers/activity/activity-summary-row";
import { PlanBlock, TodoBlock, CompactionBlock } from "./conversation-renderers/plan-and-compaction";

import { TurnRenderErrorBoundary } from "./turn-render-error-boundary";
import { ScrollToBottomButton } from "./scroll-to-bottom-button";
import {
  ConversationDocumentContext,
  type ConversationDocumentContextValue,
} from "./conversation/document-context";
import { UserMessageBlock } from "./conversation/user-message";
import { TurnDiffBlock } from "./conversation/turn-diff-resource";
const AsyncQuestionCard = lazy(() => import("./conversation/async-question-card-view"));
import { DiffReadingPositionContext, UnifiedDiffPreview, type DiffReadingPosition } from "./conversation-renderers/unified-diff-preview";
import {
  ActivityDisclosure,
  ActivityDisclosureStateContext,
  CadencedShimmer,
  type ActivityDisclosureState,
  useActivityOpen,
} from "./conversation-renderers/activity/activity-disclosure";
import {
  ConversationInteractionContext,
  AsyncQuestionContext,
  ConversationDetailContext,
  DEFAULT_TOOL_ACTIVITY_PRESENTERS,
  SubagentNavigationContext,
  ToolActivityPresenterContext,
  ToolCallContentRendererContext,
  ToolCallIconRendererContext,
  useToolActivityPresentation,
  type ConversationInteractionAction,
  type ConversationInteractionContextValue,
  type AsyncQuestionContextValue,
  type AsyncQuestionDraft,
  type SubagentNavigationContextValue,
  type ToolCallContentRenderer,
  type ToolCallIconRenderer,
} from "./conversation-renderers/render-contexts";
import {
  AssistantCopyButton,
  AutomaticApprovalReviewBlock,
  AutomaticApprovalReviewList,
  AutoReviewInterruptionWarningBlock,
  CommandBlock,
  ReasoningBlock,
} from "./conversation-renderers/activity/command-and-review-renderers";
import {
  AgentActivity,
  GenericBlock,
  HookStatsButton,
  type ConversationDetailLevel,
} from "./conversation-renderers/activity/agent-activity-renderers";
import { InteractionTimelineStatusBlock } from "./conversation-renderers/interaction/interaction-renderers";
import {
  GeneratedImageBlock,
  ImageViewToolBlock,
  JsonPreview,
  SubagentActivityGroup,
  SubagentBlock,
  ToolCallBlock,
} from "./conversation-renderers/tool/tool-renderers";

export type { ConversationDocumentContextValue } from "./conversation/document-context";
export type {
  ConversationInteractionAction,
  ToolCallContentRenderer,
  ToolCallIconRenderer,
} from "./conversation-renderers/render-contexts";
export type { ConversationDetailLevel } from "./conversation-renderers/activity/agent-activity-renderers";

function fileChangeVerb(
  kind: Extract<TimelineBlock, { type: "patch" }>["changes"][number]["kind"],
  state: ToolActivityPresentation["state"],
): string {
  if (state === "failed") return "Rejected";
  if (state === "interrupted") {
    return kind === "add" ? "Stopped creating" : kind === "delete" ? "Stopped deleting" : "Stopped editing";
  }
  if (state === "running") {
    return kind === "add" ? "Creating" : kind === "delete" ? "Deleting" : "Editing";
  }
  return kind === "add" ? "Created" : kind === "delete" ? "Deleted" : "Edited";
}

function FileChangeActivity({
  block,
  change,
}: {
  block: Extract<TimelineBlock, { type: "patch" }>;
  change: Extract<TimelineBlock, { type: "patch" }>["changes"][number];
}) {
  const documentContext = useContext(ConversationDocumentContext);
  const presentation = useToolActivityPresentation(block);
  const hasDiff = change.unifiedDiff !== null && change.unifiedDiff.trim().length > 0;
  const restoreKey = `patch:${JSON.stringify([block.id, change.path, change.movePath])}`;
  const [open, setOpen] = useActivityOpen(presentation.state === "running", false, restoreKey);
  const target = change.movePath ?? change.path;
  const openFile = useCallback(() => {
    const decision = resolveStandardChatResource(target, {
      cwd: documentContext.cwd,
      externalResourcePolicy: "allow",
    });
    if (decision.allowed && decision.target !== null) {
      documentContext.onOpenResource?.(decision.target, decision);
    }
  }, [documentContext, target]);
  return (
    <ActivityDisclosure
      detail={(
        <button
          className="thread-activity-item__file-link"
          onClick={(event) => { event.stopPropagation(); openFile(); }}
          type="button"
        >
          {change.movePath === null ? change.path : `${change.path} → ${change.movePath}`}
        </button>
      )}
      icon={presentation.state === "running" ? <PatchActivityIcon /> : <FileCode2 />}
      onOpenChange={setOpen}
      open={open}
      running={presentation.state === "running"}
      status={presentation.state}
      summary={fileChangeVerb(change.kind, presentation.state)}
      trailing={(change.additions ?? 0) > 0 || (change.deletions ?? 0) > 0
        ? <><b className="is-added">+{change.additions ?? 0}</b><i className="is-deleted">−{change.deletions ?? 0}</i></>
        : null}
    >
      {hasDiff ? <UnifiedDiffPreview diff={change.unifiedDiff!} restoreKey={restoreKey} /> : null}
    </ActivityDisclosure>
  );
}

function PatchBlock({ block }: { block: Extract<TimelineBlock, { type: "patch" }> }) {
  const presentation = useToolActivityPresentation(block);
  if (block.changes.length === 0) {
    return (
      <>
        <div className="thread-activity-item thread-activity-item--static" data-status={presentation.state}>
          <ActivitySummaryRow running={presentation.state === "running"} icon={presentation.state === "running" ? <PatchActivityIcon /> : <FileCode2 />} summary={presentation.summary} />
        </div>
        <AutomaticApprovalReviewList blockId={block.id} reviews={block.automaticApprovalReviews} />
      </>
    );
  }
  return (
    <div className="thread-patch-activities">
      {block.changes.map((change, index) => (
        <FileChangeActivity block={block} change={change} key={`${change.path}:${change.movePath ?? ""}:${index}`} />
      ))}
      <AutomaticApprovalReviewList blockId={block.id} reviews={block.automaticApprovalReviews} />
    </div>
  );
}

function AutomationUpdateBlock({ block }: { readonly block: AutomationUpdateTimelineBlock }) {
  const documentContext = useContext(ConversationDocumentContext);
  const presentation = presentAutomationUpdate(block);
  const canOpen = presentation.canOpen && documentContext.onOpenAutomation !== undefined;
  return (
    <section className="thread-automation-update" data-automation-mode={block.resultMode ?? block.mode}>
      <button
        aria-label={[presentation.actionLabel, presentation.scheduleLabel, presentation.title].filter(Boolean).join(" · ")}
        disabled={!canOpen}
        onClick={() => documentContext.onOpenAutomation?.(block)}
        type="button"
      >
        <span className="thread-automation-update__icon"><CalendarClock aria-hidden="true" size={24} /></span>
        <span className="thread-automation-update__copy">
          <strong>{presentation.title}</strong>
          <span>{presentation.subtitle}</span>
        </span>
        {canOpen ? <span className="thread-automation-update__open">Open <ArrowRight aria-hidden="true" size={12} /></span> : null}
      </button>
    </section>
  );
}

function UserMessageTimelineRenderer({ block }: TimelineBlockRendererProps) {
  return block.type === "user-message" ? <UserMessageBlock block={block} /> : null;
}

function TextTimelineRenderer({ block, richText }: TimelineBlockRendererProps) {
  const documentContext = useContext(ConversationDocumentContext);
  if (block.type !== "text") return null;
  // Question titles/options can also appear in the plain-text fallback.
  // The cards below own that same content on Web.
  const showText = (block.asyncQuestions?.length ?? 0) === 0;
  return <>
    {showText && (richText
      ? <WebChatDocument
        conversationId={documentContext.conversationId}
        cwd={documentContext.cwd}
        documentId={block.id}
        hostId={documentContext.hostId}
        loadMediaSource={documentContext.loadMediaSource}
        onMeasurementRequest={documentContext.onMeasurementRequest}
        onOpenResource={documentContext.onOpenResource}
        source={block.text}
        streaming={block.streaming}
        theme={documentContext.theme}
      />
      : <p>{block.text}</p>)}
    {block.asyncQuestions?.map((question) => (
      <Suspense key={question.id} fallback={<p aria-busy="true">{question.title}</p>}>
      <Suspense key={question.id} fallback={<p aria-busy="true">{question.title}</p>}><AsyncQuestionCard
        question={question}
        title={<WebChatDocument
          conversationId={documentContext.conversationId}
          cwd={documentContext.cwd}
          documentId={`async-question:${question.id}`}
          hostId={documentContext.hostId}
          loadMediaSource={documentContext.loadMediaSource}
          onMeasurementRequest={documentContext.onMeasurementRequest}
          onOpenResource={documentContext.onOpenResource}
          source={question.title}
          theme={documentContext.theme}
        />}
      /></Suspense>
      </Suspense>
    ))}
  </>;
}

function RealtimeTranscriptTimelineRenderer({ block }: TimelineBlockRendererProps) {
  if (block.type !== "realtime-transcript") return null;
  return (
    <section className="thread-realtime-transcript" data-handoff-id={block.handoffId ?? undefined}>
      <strong>Voice transcript</strong>
      <div className="thread-realtime-transcript__entries">
        {block.entries.map((entry, index) => (
          <p data-role={entry.role} key={`${entry.role}:${index}`}>
            <span>{entry.role === "user" ? "You" : "Assistant"}</span>
            {entry.text}
          </p>
        ))}
      </div>
    </section>
  );
}

function PlanTimelineRenderer({ block }: TimelineBlockRendererProps) {
  if (block.type !== "plan") return null;
  return <PlanBlock block={block} />;
}

function TodoTimelineRenderer({ block }: TimelineBlockRendererProps) {
  if (block.type !== "todo") return null;
  return <TodoBlock block={block} />;
}

function ErrorTimelineRenderer({ block, onRetry }: TimelineBlockRendererProps) {
  if (block.type !== "error") return null;
  if (block.recovery === "automatic") {
    return <div className="thread-stream-error" role="status"><CadencedShimmer active>{block.message}</CadencedShimmer></div>;
  }
  return (
    <aside
      className="thread-system-error"
      data-error-code={block.code ?? undefined}
      role="alert"
    >
      <AlertCircle aria-hidden="true" className="thread-system-error__icon" size={16} />
      <p className="thread-system-error__message">{block.message}</p>
      {onRetry ? (
        <button className="thread-system-error__retry" type="button" onClick={onRetry}>
          <RotateCcw aria-hidden="true" size={14} />
          Continue
        </button>
      ) : null}
    </aside>
  );
}

function InteractionTimelineRenderer({ block }: TimelineBlockRendererProps) {
  return block.type === "approval" || block.type === "question" || block.type === "option-picker" || block.type === "elicitation"
    ? <InteractionTimelineStatusBlock block={block} />
    : null;
}

const componentRenderer = <T extends TimelineBlock["type"]>(
  type: T,
  render: (block: Extract<TimelineBlock, { type: T }>) => ReactNode,
) => function RegisteredTimelineRenderer({ block }: TimelineBlockRendererProps) {
  return block.type === type ? render(block as Extract<TimelineBlock, { type: T }>) : null;
};

/** Presentation components consumed by the root-owned Web renderer plugin. */
export const webBuiltinTimelineRendererComponents = Object.freeze({
  userMessage: UserMessageTimelineRenderer,
  text: TextTimelineRenderer,
  reasoning: componentRenderer("reasoning", (block) => <ReasoningBlock block={block} />),
  realtimeTranscript: RealtimeTranscriptTimelineRenderer,
  command: componentRenderer("command-execution", (block) => <CommandBlock block={block} />),
  patch: componentRenderer("patch", (block) => <PatchBlock block={block} />),
  turnDiff: componentRenderer("turn-diff", (block) => <TurnDiffBlock block={block} />),
  automationUpdate: componentRenderer("automation-update", (block) => <AutomationUpdateBlock block={block} />),
  imageViewTool: componentRenderer("tool-call", (block) => <ImageViewToolBlock block={block} />),
  toolCall: componentRenderer("tool-call", (block) => <ToolCallBlock block={block} />),
  automaticApprovalReview: componentRenderer("automatic-approval-review", (block) => block.review.status === "approved" ? null : <AutomaticApprovalReviewBlock block={block} />),
  autoReviewWarning: componentRenderer("auto-review-interruption-warning", (block) => <AutoReviewInterruptionWarningBlock block={block} />),
  plan: PlanTimelineRenderer,
  todo: TodoTimelineRenderer,
  subagent: componentRenderer("subagent", (block) => <SubagentBlock block={block} />),
  interaction: InteractionTimelineRenderer,
  error: ErrorTimelineRenderer,
  compaction: componentRenderer("compaction", (block) => <CompactionBlock block={block} />),
  "plan-implementation": () => null,
  image: componentRenderer("image", (block) => <GeneratedImageBlock block={block} />),
  unknown: componentRenderer("unknown", (block) => <details className="thread-semantic-card"><summary className="ui-native-disclosure">Unsupported AppServer item: {block.itemType}</summary><JsonPreview value={block.payload} /></details>),
});

function Frame({
  allowSingleSlotVirtualization,
  activityCollapsedById,
  assistantPlan,
  frame,
  onActivityCollapsedChange,
  onRetry,
  thinkingId,
  thinkingLabel = "Thinking",
  showActions,
  onFork,
  threadDetailLevel,
}: {
  allowSingleSlotVirtualization: boolean;
  activityCollapsedById: Readonly<Record<string, boolean>>;
  assistantPlan: AssistantTurnPresentationPlan | null;
  frame: TimelineFrame;
  onActivityCollapsedChange: (id: string, collapsed: boolean) => void;
  onRetry?: () => void;
  thinkingId: string | null;
  thinkingLabel?: "Thinking" | "Planning";
  showActions: boolean;
  onFork?: () => Promise<void>;
  threadDetailLevel: ConversationDetailLevel;
}) {
  const intl = useIntl();
  const followContentRef = useLatestTurnFollowContentRef();
  const documentContext = useContext(ConversationDocumentContext);
  const frameRef = useRef<HTMLDivElement>(null);
  const visibleFrame = frame;
  if (visibleFrame.blocks.length === 0 && thinkingId === null && assistantPlan?.changeSummary == null) return null;
  if (visibleFrame.type === "user") {
    const itemId = getTimelineUserMessageTargetKey(visibleFrame) ?? visibleFrame.id;
    return (
      <div
        className="thread-user-message-anchor"
        data-content-search-unit-key={itemId}
        data-local-conversation-user-anchor=""
        data-virtualized-turn-content={allowSingleSlotVirtualization ? "" : undefined}
      >
        {visibleFrame.blocks.map((block) => block.type === "user-message"
          ? <UserMessageBlock
              block={block}
              hookStatsAccessory={block.deliveryStatus === "not-sent" && visibleFrame.hookStats !== null
                ? <HookStatsButton detailLevel="STEPS_COMMANDS" stats={visibleFrame.hookStats} />
                : undefined}
              key={block.id}
            />
          : <div className="thread-user-message" key={block.id}><GenericBlock block={block} richText={false} /></div>)}
      </div>
    );
  }
  const units = assistantPlan?.slots ?? [];
  const actions = visibleFrame.type === "assistant" ? assistantMessageActions(visibleFrame) : null;
  const assistantCopyText = actions?.completed ? actions.copyText : "";
  const hasMessageActions = onFork !== undefined || assistantCopyText.length > 0 || onRetry !== undefined || visibleFrame.hookStats !== null;
  if (visibleFrame.type === "assistant"
    && units.length === 0
    && assistantPlan?.changeSummary == null
    && thinkingId === null
    && !hasMessageActions
    && actions?.sentAtMs == null) return null;
  const virtualizeSingleSlot = allowSingleSlotVirtualization;
  return (
    <div ref={frameRef} className={`thread-frame thread-frame--${visibleFrame.type}`} data-frame-key={visibleFrame.id}>
      {visibleFrame.type === "assistant"
        ? units.map((unit) => {
          const content = unit.type === "agent-activity" ? (
              <AgentActivity
                persistedCollapsed={activityCollapsedById[unit.id]}
                onCollapsedChange={(collapsed) => onActivityCollapsedChange(unit.id, collapsed)}
                innerCollapsedById={activityCollapsedById}
                onInnerCollapsedChange={onActivityCollapsedChange}
                onRetry={onRetry}
                unit={unit}
              />
            ) : unit.type === "subagent-activity"
              ? <SubagentActivityGroup unit={unit} />
              : unit.type === "reasoning" ? <ReasoningBlock block={unit.block}
                presentation={unit.presentation} active={unit.active}
                collapsed={activityCollapsedById[unit.id] ?? true}
                onCollapsedChange={(collapsed) => onActivityCollapsedChange(unit.id, collapsed)} />
              : <GenericBlock block={unit.block} onRetry={onRetry} />;
          return (
            <div
              className="thread-frame__slot"
              data-presentation-slot-id={unit.id}
              data-source-item-id={unit.type === "assistant-content" ? unit.block.sourceItemIds[0] : undefined}
              data-assistant-copy-content={unit.type === "assistant-content" && actions?.copyBlockIds.includes(unit.block.id) ? "" : undefined}
              ref={unit.type === "agent-activity" ? undefined : followContentRef}
              data-virtualized-turn-content={virtualizeSingleSlot ? "" : undefined}
              key={unit.id}
            >
              {content}
            </div>
          );
        })
        : visibleFrame.blocks.map((block) => (
          <div
            className="thread-frame__slot"
            ref={followContentRef}
            data-virtualized-turn-content={virtualizeSingleSlot ? "" : undefined}
            key={block.id}
          >
            <GenericBlock block={block} onRetry={onRetry} />
          </div>
        ))}
      {assistantPlan?.changeSummary == null
        || (documentContext.composerChangeSummaryTurnId === frame.turnId
          && (assistantPlan.changeSummary.status === "pending" || assistantPlan.changeSummary.status === "running")) ? null : (
        <div className="thread-frame__slot" data-turn-resource-id={assistantPlan.changeSummary.id}
          data-virtualized-turn-content={virtualizeSingleSlot ? "" : undefined}
          key={assistantPlan.changeSummary.id}>
          <GenericBlock block={assistantPlan.changeSummary} />
        </div>
      )}
      {thinkingId === null ? null : (
        <div
          aria-live="polite"
          className="thread-thinking-placeholder thread-frame__slot"
          ref={followContentRef}
          data-virtualized-turn-content={virtualizeSingleSlot ? "" : undefined}
          key={thinkingId}
        >
          <span aria-hidden="true" /><CadencedShimmer active>{thinkingLabel === "Thinking"
            ? <ThinkingLabel />
            : thinkingLabel}</CadencedShimmer>
        </div>
      )}
      {visibleFrame.type === "assistant" && showActions && (hasMessageActions || actions?.sentAtMs != null) ? (
        <div className="thread-message-actions">
          {assistantCopyText.length > 0 ? <AssistantCopyButton value={assistantCopyText} getHtml={() => {
            const nodes = frameRef.current?.querySelectorAll<HTMLElement>("[data-assistant-copy-content] .opencraft-chat-document");
            return nodes?.length ? Array.from(nodes).map((node) => extractMarkdownElement(node).htmlText).join("\n") : null;
          }} /> : null}
          {onFork === undefined ? null : <ForkTurnButton fork={onFork} />}
          {onRetry === undefined ? null : <button onClick={onRetry} type="button" title={intl.formatMessage({ id: "common.retry", defaultMessage: "Try again" })}><RotateCcw size={13} /></button>}
          {visibleFrame.hookStats == null ? null : <HookStatsButton detailLevel={threadDetailLevel} stats={visibleFrame.hookStats} />}
          <MessageTimestamp assistant sentAtMs={actions?.sentAtMs} />
        </div>
      ) : null}
    </div>
  );
}

function Turn({
  startAfterTurnIntro = false,
  activityCollapsedById,
  onActivityCollapsedChange,
  onRetry,
  isMostRecentTurn,
  threadDetailLevel,
  turn,
}: {
  startAfterTurnIntro?: boolean;
  activityCollapsedById: Readonly<Record<string, boolean>>;
  onActivityCollapsedChange: (id: string, collapsed: boolean) => void;
  onRetry?: () => void;
  isMostRecentTurn: boolean;
  threadDetailLevel: ConversationDetailLevel;
  turn: TimelineTurnView;
}) {
  const forkTurn = useContext(ConversationDocumentContext).onForkTurn;
  const toolActivityPresenters = useContext(ToolActivityPresenterContext);
  const renderMcpApps = useContext(ConversationDocumentContext).mcpApps !== undefined;
  const toolActivityPresenterVersion = useSyncExternalStore(
    toolActivityPresenters.subscribe,
    toolActivityPresenters.getSnapshot,
    toolActivityPresenters.getSnapshot,
  );
  const reasoningCache = useMemo(() => new ReasoningPresentationCache(), [turn.turnKey]);
  const presentation = useMemo(
    () => createTimelineTurnPresentationPlan(turn, toolActivityPresenters, { isMostRecentTurn, reasoningPresenter: reasoningCache.present, partitionOptions: { keepMcpAppEntriesPersistent: renderMcpApps, renderMcpApps } }),
    [isMostRecentTurn, reasoningCache, renderMcpApps, toolActivityPresenterVersion, toolActivityPresenters, turn],
  );
  const turnThinking = presentation.thinkingOwner.type === "turn"
    ? presentation.thinkingOwner
    : null;
  const virtualizeSingleSlot = presentation.topLevelSlotCount === 1;
  return (
    <section className="thread-turn" data-selection="text" data-turn-key={turn.turnKey} data-turn-status={turn.status}>
      {(startAfterTurnIntro ? [] : presentation.userFrames).map((frame) => (
        <Frame
          allowSingleSlotVirtualization={virtualizeSingleSlot}
          activityCollapsedById={activityCollapsedById}
          assistantPlan={null}
          frame={frame}
          key={frame.id}
          onActivityCollapsedChange={onActivityCollapsedChange}
          onRetry={onRetry}
          showActions={false}
          thinkingId={null}
          threadDetailLevel={threadDetailLevel}
        />
      ))}
      {presentation.assistantFrame === null ? null : (
        <Frame
          allowSingleSlotVirtualization={virtualizeSingleSlot}
          activityCollapsedById={activityCollapsedById}
          assistantPlan={presentation.assistant}
          frame={presentation.assistantFrame}
          key={presentation.assistantFrame.id}
          onActivityCollapsedChange={onActivityCollapsedChange}
          onRetry={onRetry}
          showActions
          onFork={forkTurn !== undefined && ["complete", "failed", "interrupted"].includes(turn.status)
            ? () => forkTurn(turn.turnId) : undefined}
          thinkingId={turnThinking?.placeholderId ?? null}
          thinkingLabel={turnThinking?.label}
          threadDetailLevel={threadDetailLevel}
        />
      )}
      {presentation.auxiliaryFrames.map((frame) => (
        <Frame
          allowSingleSlotVirtualization={virtualizeSingleSlot}
          activityCollapsedById={activityCollapsedById}
          assistantPlan={null}
          frame={frame}
          key={frame.id}
          onActivityCollapsedChange={onActivityCollapsedChange}
          onRetry={onRetry}
          showActions={false}
          thinkingId={null}
          threadDetailLevel={threadDetailLevel}
        />
      ))}
      {turn.status === "complete" || turn.status === "failed" || turn.status === "interrupted"
        ? <VisibleTurnReceipt turnId={turn.turnId} /> : null}
    </section>
  );
}

export interface ConversationRestoreSnapshot {
  readonly agentActivityCollapsedById?: Readonly<Record<string, boolean>>;
  readonly chatReadingPositions?: Readonly<Record<string, ChatReadingPosition>>;
  readonly activityDisclosures?: Readonly<Record<string, ActivityDisclosureState>>;
  readonly diffReadingPositions?: Readonly<Record<string, DiffReadingPosition>>;
  readonly commandViews?: Readonly<Record<string, CommandViewState>>;
  readonly asyncQuestionDrafts?: Readonly<Record<string, AsyncQuestionDraft>>;
  readonly distanceFromBottomPx: number;
  readonly virtualizedTurnList: VirtualizedTurnRestoreState | null;
  readonly turnFollow?: TurnFollowRestoreState | null;
}

export interface ConversationProps {
  /** The host selects the policy; content growth must never select one implicitly. */
  readonly scrollPolicy: ConversationScrollPolicy;
  readonly timeline: TimelineSnapshot | null;
  /** Only shown when the timeline has no visible rows; never replaces retained history. */
  readonly emptyState?: ReactNode;
  /** Protocol-neutral prompt index. V3 cursors and V4 epochs remain behind this port. */
  readonly navigationSource?: ConversationNavigationSource | null;
  readonly searchTarget?: import("./conversation-search").ConversationSearchTarget | null;
  readonly footer?: ReactNode;
  readonly onAddSelectionToChat?: (text: string) => boolean;
  readonly documentContext?: ConversationDocumentContextValue;
  readonly initialRestoreSnapshot?: ConversationRestoreSnapshot | null;
  readonly onRestoreSnapshotChange?: (snapshot: ConversationRestoreSnapshot) => void;
  readonly onLoadOlder?: () => void | "stop" | Promise<void | "stop">;
  readonly loadingOlder?: boolean;
  readonly onContinueTurn?: (turnId: TurnId) => void;
  readonly continuableTurnId?: TurnId | null;
  /** Opens a child/background-agent thread when the host exposes it. */
  readonly onOpenSubagent?: (threadId: string, displayName: string) => void;
  readonly onRespondInteraction?: (requestId: string, action: ConversationInteractionAction) => Promise<void>;
  readonly onAnswerAsyncQuestion?: (question: AsyncQuestion, answer: string) => Promise<void>;
  readonly queuedAsyncQuestionIds?: readonly string[];
  readonly onConversationScrollApiChange?: (api: ConversationScrollApi | null) => void;
  /** Local-submit intent is owned above the renderer and consumed exactly once. */
  readonly consumePendingLatestTurnSubmitPlacement?: () => LatestTurnPlacementSnapshot | null;
  readonly onVisibleContentReady?: () => void;
  readonly onTerminalResultVisible?: (turnId: string) => void;
  readonly onVirtualizedTurnListApiChange?: (api: VirtualizedTurnListApi | null) => void;
  /** Renderer-neutral semantics supplied by product feature plugins. */
  readonly toolActivityPresenterRegistry?: ToolActivityPresenterRegistry;
  /** Optional product renderer for tool bodies such as Skills or Figma cards. */
  readonly renderToolCallContent?: ToolCallContentRenderer;
  /** Host resolver for external app/plugin/native icons; no network policy lives in ChatUI. */
  readonly renderToolCallIcon?: ToolCallIconRenderer;
  /** Host/layout capabilities; protocol and conversation data never infer these. */
  readonly surfaceCapabilities?: TimelineSurfaceCapabilities;
  readonly threadDetailLevel?: ConversationDetailLevel;
}

export type ConversationScrollApi = TurnConversationScrollApi;

// Presentation primitive, independent of the viewport / response policy.
export { Turn as ConversationTurn };

function distanceFromBottom(element: HTMLDivElement): number {
  return normalizeInvertedWebViewportMetrics({
    contentHeightPx: element.scrollHeight,
    viewportHeightPx: element.clientHeight,
    scrollTopPx: element.scrollTop,
  }).distanceFromBottomPx;
}

function AnimatedTurn({
  activityCollapsedById,
  offset,
  onActivityCollapsedChange,
  onRetry,
  isMostRecentTurn,
  threadDetailLevel,
  turn,
}: {
  readonly activityCollapsedById: Readonly<Record<string, boolean>>;
  readonly offset: MotionValue<number> | null;
  readonly onActivityCollapsedChange: (id: string, collapsed: boolean) => void;
  readonly onRetry?: () => void;
  readonly isMostRecentTurn: boolean;
  readonly threadDetailLevel: ConversationDetailLevel;
  readonly turn: TimelineTurnView;
}) {
  // Latest/historical is a position, not a React lifetime boundary.
  return <motion.div style={{ y: offset ?? 0 }}><Turn activityCollapsedById={activityCollapsedById} isMostRecentTurn={isMostRecentTurn} onActivityCollapsedChange={onActivityCollapsedChange} onRetry={onRetry} threadDetailLevel={threadDetailLevel} turn={turn} /></motion.div>;
}


/** Product presentation policy, never inferred from provider, phase or status. */
export type ConversationScrollPolicy = "natural" | "response-placement";

export function Conversation({
  timeline,
  emptyState,
  scrollPolicy,
  navigationSource = null,
  searchTarget = null,
  footer,
  onAddSelectionToChat,
  documentContext = { conversationId: null, cwd: null, hostId: null, theme: "light" },
  initialRestoreSnapshot = null,
  onRestoreSnapshotChange,
  onLoadOlder,
  loadingOlder = false,
  onOpenSubagent,
  onContinueTurn,
  continuableTurnId = null,
  onRespondInteraction,
  onAnswerAsyncQuestion,
  queuedAsyncQuestionIds = [],
  onConversationScrollApiChange,
  consumePendingLatestTurnSubmitPlacement,
  onVisibleContentReady,
  onTerminalResultVisible,
  onVirtualizedTurnListApiChange,
  toolActivityPresenterRegistry = DEFAULT_TOOL_ACTIVITY_PRESENTERS,
  renderToolCallContent,
  renderToolCallIcon,
  surfaceCapabilities = DEFAULT_TIMELINE_SURFACE_CAPABILITIES,
  threadDetailLevel = "STEPS_COMMANDS",
}: ConversationProps) {
  const intl = useIntl();
  const allowEntryMotion = useConversationEntryMotion(timeline);
  const entries = useMemo(() => timeline === null ? [] : groupTimelineFramesByTurn(timeline), [timeline]);
  const latestTurn = entries.length === 0 ? null : entries[entries.length - 1] ?? null;
  const isLatestTurnInProgress = latestTurn?.status === "pending" || latestTurn?.status === "streaming";
  const activeTodo = useMemo(
    () => latestTurn === null
      ? null
      : activeTimelineTurnTodo(latestTurn, true),
    [latestTurn],
  );
  const [activityCollapsedById, setActivityCollapsedById] = useState<Readonly<Record<string, boolean>>>(
    () => initialRestoreSnapshot?.agentActivityCollapsedById ?? {},
  );
  const activityCollapsedByIdRef = useRef(activityCollapsedById);
  activityCollapsedByIdRef.current = activityCollapsedById;
  const [chatReadingPositions] = useState(() => new Map(Object.entries(initialRestoreSnapshot?.chatReadingPositions ?? {})));
  const [activityDisclosures] = useState(() => new Map(Object.entries(initialRestoreSnapshot?.activityDisclosures ?? {})));
  const [diffReadingPositions] = useState(() => new Map(Object.entries(initialRestoreSnapshot?.diffReadingPositions ?? {})));
  const [commandViews] = useState(() => new Map(Object.entries(initialRestoreSnapshot?.commandViews ?? {})));
  const [asyncQuestionDrafts, setAsyncQuestionDrafts] = useState<Readonly<Record<string, AsyncQuestionDraft>>>(
    () => initialRestoreSnapshot?.asyncQuestionDrafts ?? {},
  );
  const asyncQuestionDraftsRef = useRef(asyncQuestionDrafts);
  asyncQuestionDraftsRef.current = asyncQuestionDrafts;
  const asyncQuestionPresentation = useMemo(() => deriveAsyncQuestionPresentation(timeline ?? { frames: [] }), [timeline]);
  const [asyncQuestionSubmitting, setAsyncQuestionSubmitting] = useState<ReadonlySet<string>>(() => new Set());
  const asyncQuestionSubmittingRef = useRef(new Set<string>());
  const [asyncQuestionErrors, setAsyncQuestionErrors] = useState<Readonly<Record<string, string>>>({});
  const updateAsyncQuestionDraft = useCallback((questionId: string, draft: AsyncQuestionDraft) => {
    setAsyncQuestionDrafts((current) => ({ ...current, [questionId]: draft }));
  }, []);
  const answerAsyncQuestion = useCallback(async (question: AsyncQuestion, answer: string) => {
    if (onAnswerAsyncQuestion === undefined || asyncQuestionSubmittingRef.current.has(question.id)) return;
    asyncQuestionSubmittingRef.current.add(question.id);
    setAsyncQuestionSubmitting(new Set(asyncQuestionSubmittingRef.current));
    setAsyncQuestionErrors((current) => {
      const next = { ...current };
      delete next[question.id];
      return next;
    });
    try {
      await onAnswerAsyncQuestion(question, answer);
    } catch (error) {
      setAsyncQuestionErrors((current) => ({
        ...current,
        [question.id]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      asyncQuestionSubmittingRef.current.delete(question.id);
      setAsyncQuestionSubmitting(new Set(asyncQuestionSubmittingRef.current));
    }
  }, [onAnswerAsyncQuestion]);
  const asyncQuestionQueuedIds = useMemo(() => new Set(queuedAsyncQuestionIds), [queuedAsyncQuestionIds]);
  const asyncQuestionContext = useMemo<AsyncQuestionContextValue>(() => ({
    states: asyncQuestionPresentation.states,
    answers: asyncQuestionPresentation.answers,
    queuedIds: asyncQuestionQueuedIds,
    drafts: asyncQuestionDrafts,
    submittingIds: asyncQuestionSubmitting,
    errors: asyncQuestionErrors,
    answer: onAnswerAsyncQuestion === undefined ? null : answerAsyncQuestion,
    updateDraft: updateAsyncQuestionDraft,
  }), [asyncQuestionPresentation, asyncQuestionQueuedIds, asyncQuestionDrafts, asyncQuestionSubmitting, asyncQuestionErrors, onAnswerAsyncQuestion, answerAsyncQuestion, updateAsyncQuestionDraft]);
  const handleActivityCollapsedChange = useCallback((id: string, collapsed: boolean) => {
    setActivityCollapsedById((current) => current[id] === collapsed
      ? current
      : { ...current, [id]: collapsed });
  }, []);
  const viewportOwnerRef = useRef<ReturnType<typeof createWebConversationViewportOwner> | null>(null);
  if (viewportOwnerRef.current === null) {
    viewportOwnerRef.current = createWebConversationViewportOwner(
      normalizeInitialScrollDistance(initialRestoreSnapshot?.distanceFromBottomPx),
    );
  }
  const viewportOwner = viewportOwnerRef.current;
  const scrollRef = viewportOwner.scrollElementRef;
  const scrollController = viewportOwner.scrollController;
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const attachScrollElement = useCallback((element: HTMLDivElement | null) => {
    viewportOwner.attachScrollElement(element);
    setScrollElement(element);
  }, [viewportOwner]);
  useLayoutEffect(() => {
    // Thread scroll layout owns initialOffset in both policies. Never
    // reapply it on phase/content changes or a policy branch change.
    scrollController.scrollToDistanceFromBottomPx(
      normalizeInitialScrollDistance(initialRestoreSnapshot?.distanceFromBottomPx), "instant",
    );
  }, [initialRestoreSnapshot?.distanceFromBottomPx, scrollController]);
  const handleReflowAnchorCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    viewportOwner.captureReflowAnchor(event.target);
  }, [viewportOwner]);
  const virtualizerApiRef = useRef<WebVirtualizedTurnListApi | null>(null);
  const virtualizerRestoreSnapshotRef = useRef<ReturnType<WebVirtualizedTurnListApi["captureRestoreSnapshot"]> | null>(
    initialRestoreSnapshot === null ? null : {
      distanceFromBottomPx: normalizeInitialScrollDistance(initialRestoreSnapshot.distanceFromBottomPx),
      virtualizedTurnList: initialRestoreSnapshot.virtualizedTurnList,
    },
  );
  const [virtualizedTurnListApi, setVirtualizedTurnListApi] = useState<WebVirtualizedTurnListApi | null>(null);
  const handleVirtualizerApiChange = useStableEvent((api: WebVirtualizedTurnListApi | null) => {
    if (api === null && virtualizerApiRef.current !== null) {
      virtualizerRestoreSnapshotRef.current = virtualizerApiRef.current.captureRestoreSnapshot();
    }
    virtualizerApiRef.current = api;
    setVirtualizedTurnListApi(api);
    onVirtualizedTurnListApiChange?.(api);
  });
  const cancelPendingTargetPosition = useCallback(() => {
    virtualizerApiRef.current?.cancelPositioning();
  }, []);
  const historyBackfill = useTurnHistoryBackfill({
    historyKey: timeline === null
      ? null
      : JSON.stringify([timeline.key.hostId, timeline.key.threadId]),
    loadPage: onLoadOlder,
    readMetrics: () => {
      const element = scrollRef.current;
      return element === null
        ? null
        : {
            distanceFromBottomPx: distanceFromBottom(element),
            viewportHeightPx: element.clientHeight,
            scrollHeightPx: element.scrollHeight,
          };
    },
    afterLayout: () => new Promise<void>((resolve) => window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    })),
  });
  const loadOlderUntilScrollable = historyBackfill.request;


  // Selection precedes policy construction. Baseline never owns
  // response state, even if a checkpoint from another policy contains it.
  const responseApiRef = useRef<ResponsePositionedTurnsApi | null>(null);
  const responseRestoreRef = useRef<ReturnType<ResponsePositionedTurnsApi["captureRestoreSnapshot"]> | null>(null);
  const [responseApi, setResponseApi] = useState<ResponsePositionedTurnsApi | null>(null);
  const handleResponseApiChange = useStableEvent((api: ResponsePositionedTurnsApi | null) => {
    if (api === null && responseApiRef.current !== null) {
      responseRestoreRef.current = responseApiRef.current.captureRestoreSnapshot();
    }
    responseApiRef.current = api;
    setResponseApi(api);
  });
  const conversationScrollApi = useMemo<ConversationScrollApi>(() => ({
    captureLatestTurnSubmitPlacement: () =>
      responseApiRef.current?.captureLatestTurnSubmitPlacement() ?? null,
    releaseLatestTurnSubmitPlacementCapture: () =>
      responseApiRef.current?.releaseLatestTurnSubmitPlacementCapture(),
    scrollToBottom: () => {
      if (responseApiRef.current !== null) responseApiRef.current.scrollToBottom();
      else scrollController.scrollToBottom();
    },
  }), [scrollController]);
  useEffect(() => {
    onConversationScrollApiChange?.(conversationScrollApi);
    return () => onConversationScrollApiChange?.(null);
  }, [conversationScrollApi, onConversationScrollApiChange]);

  const subscribeScrollToBottomVisibility = useCallback((listener: () => void) => {
    const releaseScroll = scrollController.subscribeState(listener);
    const releaseSpacer = responseApi?.subscribeSpacerHeight(listener);
    return () => { releaseScroll(); releaseSpacer?.(); };
  }, [responseApi, scrollController]);
  const getScrollToBottomVisibility = useCallback(() => shouldShowScrollToBottomAction({
    isScrolledFromBottom: scrollController.getState().isScrolledFromBottom,
    responseSpacerHeightPx: responseApi?.getSpacerHeightPx() ?? 0,
    scrollDistanceFromBottomPx: scrollController.getLastScrollDistanceFromBottomPx(),
  }), [responseApi, scrollController]);
  const showScrollToBottom = useSyncExternalStore(
    subscribeScrollToBottomVisibility, getScrollToBottomVisibility, getScrollToBottomVisibility,
  );
  useEffect(() => viewportOwner.bindScrollBehavior({
    onUserInput: cancelPendingTargetPosition,
    onUserScrollToTop: () => { void loadOlderUntilScrollable(); },
  }), [cancelPendingTargetPosition, loadOlderUntilScrollable, viewportOwner]);
  useEffect(() => {
    historyBackfill.invalidate();
    const release = viewportOwner.observeViewportGeometry(() => {
      void loadOlderUntilScrollable();
    });
    return () => { historyBackfill.invalidate(); release(); };
  }, [historyBackfill, loadOlderUntilScrollable, viewportOwner]);

  const restoreCallbackRef = useRef(onRestoreSnapshotChange);
  restoreCallbackRef.current = onRestoreSnapshotChange;
  const scrollPolicyRef = useRef(scrollPolicy);
  scrollPolicyRef.current = scrollPolicy;
  useEffect(() => () => {
    cancelPendingTargetPosition();
    const responseRestore = scrollPolicyRef.current === "response-placement"
      ? responseApiRef.current?.captureRestoreSnapshot() ?? responseRestoreRef.current
      : null;
    const virtualizerRestore = virtualizerApiRef.current?.captureRestoreSnapshot()
      ?? virtualizerRestoreSnapshotRef.current;
    restoreCallbackRef.current?.({
      agentActivityCollapsedById: activityCollapsedByIdRef.current,
      chatReadingPositions: Object.fromEntries(chatReadingPositions),
      activityDisclosures: Object.fromEntries(activityDisclosures),
      diffReadingPositions: Object.fromEntries(diffReadingPositions),
      commandViews: Object.fromEntries(commandViews),
      asyncQuestionDrafts: asyncQuestionDraftsRef.current,
      distanceFromBottomPx: responseRestore?.distanceFromBottomPx
        ?? virtualizerRestore?.distanceFromBottomPx
        ?? scrollController.getLastScrollDistanceFromBottomPx(),
      virtualizedTurnList: virtualizerRestore?.virtualizedTurnList ?? null,
      turnFollow: responseRestore?.turnFollow ?? null,
    });
    viewportOwner.dispose();
  }, [activityDisclosures, cancelPendingTargetPosition, chatReadingPositions, commandViews, diffReadingPositions, scrollController, viewportOwner]);

  const renderTurn = (turn: TimelineTurnView, isLatest: boolean, offset?: MotionValue<number> | null) => (
    <TurnRenderErrorBoundary resetKey={turn.turnKey}>
      {scrollPolicy === "response-placement" ? (
        <AnimatedTurn activityCollapsedById={activityCollapsedById} isMostRecentTurn={isLatest}
          offset={offset ?? null} onActivityCollapsedChange={handleActivityCollapsedChange}
          onRetry={onContinueTurn === undefined || continuableTurnId !== turn.turnId ? undefined : () => onContinueTurn(turn.turnId)}
          threadDetailLevel={threadDetailLevel} turn={turn} />
      ) : (
        <Turn activityCollapsedById={activityCollapsedById} isMostRecentTurn={isLatest}
          onActivityCollapsedChange={handleActivityCollapsedChange}
          onRetry={onContinueTurn === undefined || continuableTurnId !== turn.turnId ? undefined : () => onContinueTurn(turn.turnId)}
          threadDetailLevel={threadDetailLevel} turn={turn} />
      )}
    </TurnRenderErrorBoundary>
  );
  const interactionContext = useMemo<ConversationInteractionContextValue>(() => ({
    respond: onRespondInteraction ?? null,
  }), [onRespondInteraction]);
  const subagentNavigation = useMemo<SubagentNavigationContextValue>(() => ({
    open: onOpenSubagent ?? null,
  }), [onOpenSubagent]);
  const presentedDocumentContext = useMemo<ConversationDocumentContextValue>(() => ({
    ...documentContext,
    onMeasurementRequest: viewportOwner.requestLayoutMeasurement,
  }), [documentContext, viewportOwner]);
  const footerElement = footer === undefined && activeTodo === null ? null : (
    <div
      className="thread-scroll-footer"
      data-thread-scroll-footer="true"
      ref={viewportOwner.attachFooterElement}
    >
      <div aria-hidden="true" className="thread-scroll-footer__gradient" />
      <div
        className="thread-scroll-footer__content thread-layout-width"
        data-pip-obstacle="thread-footer"
      >
        <div className="thread-scroll-to-bottom-anchor">
          <ScrollToBottomButton
            label="Scroll to bottom"
            onClick={conversationScrollApi.scrollToBottom}
            show={showScrollToBottom}
            showWorkingDots={showScrollToBottom && isLatestTurnInProgress}
          />
        </div>
        {activeTodo === null ? null : (
          <div className="thread-in-progress-fixed-content" data-in-progress-fixed-content="true">
            <TodoBlock block={activeTodo} />
          </div>
        )}
        {footer}
      </div>
    </div>
  );
  return (
    <ChatReadingPositionContext.Provider value={chatReadingPositions}>
    <ActivityDisclosureStateContext.Provider value={activityDisclosures}>
    <DiffReadingPositionContext.Provider value={diffReadingPositions}>
    <CommandViewStateContext.Provider value={commandViews}>
    <ConversationEntryMotionContext.Provider value={allowEntryMotion}>
    <VisibleTurnReceiptContext.Provider value={onTerminalResultVisible}>
    <DisclosureReflowContext.Provider value={viewportOwner.beginReflowAnchor}>
    <ConversationDetailContext.Provider value={threadDetailLevel}>
    <ToolActivityPresenterContext.Provider value={toolActivityPresenterRegistry}>
      <ToolCallIconRendererContext.Provider value={renderToolCallIcon ?? null}>
        <ToolCallContentRendererContext.Provider value={renderToolCallContent ?? null}>
          <AsyncQuestionContext.Provider value={asyncQuestionContext}>
          <ConversationInteractionContext.Provider value={interactionContext}>
            <SubagentNavigationContext.Provider value={subagentNavigation}>
              <ConversationDocumentContext.Provider value={presentedDocumentContext}>
                <div
                  className="thread-scroll-layout"
                  data-live-embedded-surface={surfaceCapabilities.hasLiveEmbeddedSurface || undefined}
                >
                  <div
                    className="thread-scroll"
                    data-app-action-timeline-scroll=""
                    data-pip-anchor-host={surfaceCapabilities.pipAnchorHostId ?? undefined}
                    data-thread-find-target="conversation"
                    onClickCapture={handleReflowAnchorCapture}
                    ref={attachScrollElement}
                    tabIndex={0}
                  >
                    <motion.div
                      className="thread-scroll-surface"
                      style={{
                        x: surfaceCapabilities.wideContentOffsetPx,
                        "--thread-wide-block-inline-shift": `${Math.abs(surfaceCapabilities.wideContentOffsetPx)}px`,
                      } as CSSProperties}
                    >
                      <div className="thread-history-status" role="status" aria-label={loadingOlder ? intl.formatMessage({ id: "chat.restore.loading", defaultMessage: "Loading conversation history…" }) : undefined}>
                        {loadingOlder ? <LoadingRingIcon aria-hidden="true" className="is-spinning" size={20} /> : null}
                      </div>
                      <div
                        className="thread-content thread-layout-width"
                        data-mcp-app-portal-target={surfaceCapabilities.embeddedPortalTarget || undefined}
                        data-thread-user-message-navigation-content="true"
                      >

                        {entries.length === 0 ? emptyState : null}

                        {scrollPolicy === "response-placement" ? (
                          <ResponsePositionedTurns
                            entries={entries}
                            timelineRevision={timeline?.revision ?? -1}
                            viewportOwner={viewportOwner}
                            scrollElement={scrollElement}
                            initialRestoreSnapshot={initialRestoreSnapshot}
                            consumePendingLatestTurnSubmitPlacement={consumePendingLatestTurnSubmitPlacement}
                            onVisibleContentReady={onVisibleContentReady}
                            onContentLayoutCommitted={loadOlderUntilScrollable}
                            onApiChange={handleVirtualizerApiChange}
                            onResponseApiChange={handleResponseApiChange}
                            renderTurn={renderTurn}
                          />
                        ) : (
                          <VirtualizedConversationTurns
                            entries={entries}
                            timelineRevision={timeline?.revision ?? -1}
                            viewportOwner={viewportOwner}
                            initialRestoreState={initialRestoreSnapshot?.virtualizedTurnList ?? null}
                            initialDistanceFromBottomPx={normalizeInitialScrollDistance(initialRestoreSnapshot?.distanceFromBottomPx)}
                            preserveMeasuredTurnViewport
                            onApiChange={handleVirtualizerApiChange}
                            onVisibleContentReady={onVisibleContentReady}
                            onContentLayoutCommitted={loadOlderUntilScrollable}
                            renderTurn={renderTurn}
                          />
                        )}
                      </div>
                      {footerElement}
                    </motion.div>
                  </div>
                  <ConversationSelectionMenu root={scrollElement} onAddToChat={onAddSelectionToChat} />
                  {navigationSource !== null && virtualizedTurnListApi !== null ? (
                    <UserMessageNavigationRail
                      getScrollElement={() => scrollRef.current}
                      source={navigationSource}
                      virtualizedTurnListApi={virtualizedTurnListApi}
                    />
                  ) : null}
                  {searchTarget && navigationSource && virtualizedTurnListApi ? <ConversationSearchPosition
                    source={navigationSource} target={searchTarget} api={virtualizedTurnListApi} scrollElement={scrollElement} /> : null}
                </div>
              </ConversationDocumentContext.Provider>
            </SubagentNavigationContext.Provider>
          </ConversationInteractionContext.Provider>
          </AsyncQuestionContext.Provider>
        </ToolCallContentRendererContext.Provider>
      </ToolCallIconRendererContext.Provider>
    </ToolActivityPresenterContext.Provider>
    </ConversationDetailContext.Provider>
    </DisclosureReflowContext.Provider>
    </VisibleTurnReceiptContext.Provider>
    </ConversationEntryMotionContext.Provider>
    </CommandViewStateContext.Provider>
    </DiffReadingPositionContext.Provider>
    </ActivityDisclosureStateContext.Provider>
    </ChatReadingPositionContext.Provider>
  );
}
