import { ResponsePositionedTurns, type ResponsePositionedTurnsApi } from "./conversation/response-positioned-turns";
import {
  createTimelineTurnPresentationPlan,
  groupTimelineFramesByTurn,
  presentAutomationUpdate,
  type AssistantTurnPresentationPlan,
  type AutomationUpdateTimelineBlock,
  type TimelineBlock,
  type TimelineFrame,
  type TimelineSnapshot,
  type ToolActivityPresentation,
  type ToolActivityPresenterRegistry,
  type TimelineTurnView,
  type TurnDiffTimelineBlock,
  type TurnId,
} from "@opencraft/chat-core";
import type { ConversationNavigationSource } from "@opencraft/chat-navigation";
import {
  WebChatDocument,
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
import { useLatestTurnFollowContentRef } from "./latest-turn-follow-content";
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  ChevronDown,
  FileCode2,
  RotateCcw,
  Undo2,
  Redo2,
} from "lucide-react";
import {
  motion,
  type MotionValue,
} from "motion/react";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
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
import { assistantMessageActions } from "@opencraft/chat-core";
import { extractMarkdownElement } from "@opencraft/chat-render-web";
import { PlanBlock, TodoBlock, CompactionBlock } from "./conversation-renderers/plan-and-compaction";

import { TurnRenderErrorBoundary } from "./turn-render-error-boundary";
import { ScrollToBottomButton } from "./scroll-to-bottom-button";
import {
  ConversationDocumentContext,
  type ConversationDocumentContextValue,
} from "./conversation/document-context";
import { UserMessageBlock } from "./conversation/user-message";
import { UnifiedDiffPreview } from "./conversation-renderers/unified-diff-preview";
import {
  ActivityDisclosure,
  CadencedShimmer,
  useCodexActivityOpen,
} from "./conversation-renderers/activity/activity-disclosure";
import {
  ConversationInteractionContext,
  ConversationDetailContext,
  DEFAULT_TOOL_ACTIVITY_PRESENTERS,
  SubagentNavigationContext,
  ToolActivityPresenterContext,
  ToolCallContentRendererContext,
  ToolCallIconRendererContext,
  useToolActivityPresentation,
  type ConversationInteractionAction,
  type ConversationInteractionContextValue,
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
  const [open, setOpen] = useCodexActivityOpen(presentation.state === "running");
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
      icon={<FileCode2 size={14} />}
      onOpenChange={setOpen}
      open={open}
      running={presentation.state === "running"}
      status={presentation.state}
      summary={fileChangeVerb(change.kind, presentation.state)}
      trailing={(change.additions ?? 0) > 0 || (change.deletions ?? 0) > 0
        ? <><b className="is-added">+{change.additions ?? 0}</b><i className="is-deleted">−{change.deletions ?? 0}</i></>
        : null}
    >
      {hasDiff ? <UnifiedDiffPreview diff={change.unifiedDiff!} /> : null}
    </ActivityDisclosure>
  );
}

function PatchBlock({ block }: { block: Extract<TimelineBlock, { type: "patch" }> }) {
  const presentation = useToolActivityPresentation(block);
  if (block.changes.length === 0) {
    return (
      <>
        <div className="thread-activity-item thread-activity-item--static" data-status={presentation.state}>
          <div className="thread-activity-item__header">
            <span className="thread-activity-item__icon"><FileCode2 size={14} /></span>
            <span className="thread-activity-item__summary">{presentation.summary}</span>
          </div>
        </div>
        <AutomaticApprovalReviewList reviews={block.automaticApprovalReviews} />
      </>
    );
  }
  return (
    <div className="thread-patch-activities">
      {block.changes.map((change, index) => (
        <FileChangeActivity block={block} change={change} key={`${change.path}:${change.movePath ?? ""}:${index}`} />
      ))}
      <AutomaticApprovalReviewList reviews={block.automaticApprovalReviews} />
    </div>
  );
}

function turnDiffDisplayPath(path: string): { readonly basename: string; readonly directory: string } {
  const normalized = path.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  return separator < 0
    ? { basename: normalized, directory: "" }
    : { basename: normalized.slice(separator + 1), directory: normalized.slice(0, separator + 1) };
}

function TurnDiffStats({ additions, deletions }: { readonly additions: number; readonly deletions: number }) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span className="thread-turn-diff__stats" aria-label={`${additions} lines added, ${deletions} lines removed`}>
      {additions > 0 ? <b>+{additions}</b> : null}
      {deletions > 0 ? <i>−{deletions}</i> : null}
    </span>
  );
}

function TurnDiffBlock({ block }: { readonly block: TurnDiffTimelineBlock }) {
  const documentContext = useContext(ConversationDocumentContext);
  const [expandedFiles, setExpandedFiles] = useState(false);
  const [lastAction, setLastAction] = useState<"undo" | "reapply" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const inProgress = block.status === "pending" || block.status === "running";
  const files = expandedFiles ? block.files : block.files.slice(0, 3);
  const hiddenFileCount = block.files.length - files.length;
  const nextAction = lastAction === "undo" ? "reapply" : "undo";

  const openPath = useCallback((path: string) => {
    const decision = resolveStandardChatResource(path, {
      cwd: documentContext.cwd,
      externalResourcePolicy: "allow",
    });
    if (decision.allowed && decision.target !== null) {
      documentContext.onOpenResource?.(decision.target, decision);
    }
  }, [documentContext]);
  const review = useCallback((path?: string) => {
    if (documentContext.onReviewTurnDiff !== undefined) documentContext.onReviewTurnDiff(block, path);
    else if (path !== undefined) openPath(path);
  }, [block, documentContext, openPath]);
  const apply = useCallback(async (action: "undo" | "reapply") => {
    if (documentContext.onApplyTurnDiff === undefined || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await documentContext.onApplyTurnDiff(block, action);
      setLastAction(action);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }, [block, documentContext, submitting]);

  if (block.files.length === 0) return null;
  if (inProgress) {
    return (
      <motion.button
        animate={{ opacity: 1 }}
        className="thread-turn-diff-live"
        initial={{ opacity: 0 }}
        onClick={() => review()}
        transition={{ duration: 0.18, ease: "easeOut" }}
        type="button"
      >
        <span>{block.files.length === 1 ? "1 file changed" : `${block.files.length} files changed`}</span>
        <TurnDiffStats additions={block.additions} deletions={block.deletions} />
      </motion.button>
    );
  }

  const singleFile = block.files.length === 1 ? block.files[0]! : null;
  const title = singleFile === null
    ? `Edited ${block.files.length} files`
    : `Edited ${turnDiffDisplayPath(singleFile.path).basename}`;
  return (
    <section className="thread-turn-diff" data-status={block.status}>
      <div className="thread-turn-diff__header">
        <button
          aria-label="Review changed files"
          className="thread-turn-diff__header-target"
          onClick={() => review(singleFile?.path)}
          type="button"
        />
        <span className="thread-turn-diff__icon"><FileCode2 aria-hidden="true" size={24} /></span>
        <span className="thread-turn-diff__copy">
          <strong>{title}</strong>
          <span className="thread-turn-diff__subtitle">
            <span className="thread-turn-diff__default-subtitle"><TurnDiffStats additions={block.additions} deletions={block.deletions} /></span>
            <span className="thread-turn-diff__hover-subtitle">Review changes <ArrowRight aria-hidden="true" size={12} /></span>
          </span>
        </span>
        <span className="thread-turn-diff__actions">
          <button
            disabled={documentContext.onApplyTurnDiff === undefined || submitting}
            onClick={(event) => { event.stopPropagation(); void apply(nextAction); }}
            type="button"
          >
            {nextAction === "undo" ? "Undo" : "Reapply"}
            {nextAction === "undo" ? <Undo2 aria-hidden="true" size={12} /> : <Redo2 aria-hidden="true" size={12} />}
          </button>
          <button className="is-review" onClick={(event) => { event.stopPropagation(); review(singleFile?.path); }} type="button">Review</button>
        </span>
      </div>
      {block.files.length > 1 ? (
        <div className="thread-turn-diff__files">
          {files.map((file) => {
            const display = turnDiffDisplayPath(file.path);
            return (
              <button aria-label={`Open ${file.path}`} key={file.path} onClick={() => review(file.path)} type="button">
                <span className="thread-turn-diff__path"><span>{display.directory}</span><b>{display.basename}</b></span>
                <TurnDiffStats additions={file.additions} deletions={file.deletions} />
              </button>
            );
          })}
          {hiddenFileCount > 0 ? <button className="thread-turn-diff__more" onClick={() => setExpandedFiles(true)} type="button">Show {hiddenFileCount} more {hiddenFileCount === 1 ? "file" : "files"}<ChevronDown size={12} /></button> : null}
          {expandedFiles && block.files.length > 3 ? <button className="thread-turn-diff__more" onClick={() => setExpandedFiles(false)} type="button">Collapse files<ChevronDown className="is-expanded" size={12} /></button> : null}
        </div>
      ) : null}
      {actionError === null ? null : <p className="thread-turn-diff__error" role="alert">{actionError}</p>}
    </section>
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
  return richText
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
    : <p>{block.text}</p>;
}

function RealtimeTranscriptTimelineRenderer({ block }: TimelineBlockRendererProps) {
  if (block.type !== "realtime-transcript") return null;
  return (
    <section className="thread-realtime-transcript" data-handoff-id={block.handoffId ?? undefined}>
      <strong>Voice transcript</strong>
      <div className="thread-realtime-transcript__entries">
        {block.entries.map((entry, index) => (
          <p data-role={entry.role} key={`${entry.role}:${index}`}>
            <span>{entry.role === "user" ? "You" : "Codex"}</span>
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
  unknown: componentRenderer("unknown", (block) => <details className="thread-semantic-card"><summary>Unsupported AppServer item: {block.itemType}</summary><JsonPreview value={block.payload} /></details>),
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
  threadDetailLevel: ConversationDetailLevel;
}) {
  const followContentRef = useLatestTurnFollowContentRef();
  const frameRef = useRef<HTMLDivElement>(null);
  const visibleFrame = frame;
  if (visibleFrame.blocks.length === 0 && thinkingId === null) return null;
  if (visibleFrame.type === "user") {
    const itemId = visibleFrame.anchors.find((anchor) => anchor.type === "item")?.id ?? visibleFrame.id;
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
  const hasMessageActions = assistantCopyText.length > 0 || onRetry !== undefined || visibleFrame.hookStats !== null;
  const virtualizeSingleSlot = allowSingleSlotVirtualization;
  return (
    <div ref={frameRef} className={`thread-frame thread-frame--${visibleFrame.type}`} data-frame-key={visibleFrame.id}>
      {visibleFrame.type === "assistant"
        ? units.map((unit) => {
          const content = unit.type === "agent-activity" ? (
              <AgentActivity
                persistedCollapsed={activityCollapsedById[unit.id]}
                onCollapsedChange={(collapsed) => onActivityCollapsedChange(unit.id, collapsed)}
                onRetry={onRetry}
                unit={unit}
              />
            ) : unit.type === "subagent-activity"
              ? <SubagentActivityGroup unit={unit} />
              : <GenericBlock block={unit.block} onRetry={onRetry} />;
          return (
            <div
              className="thread-frame__slot"
              data-assistant-copy-content={unit.type === "assistant-content" && unit.block.type === "text" ? "" : undefined}
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
      {thinkingId === null ? null : (
        <div
          aria-live="polite"
          className="thread-thinking-placeholder thread-frame__slot"
          ref={followContentRef}
          data-virtualized-turn-content={virtualizeSingleSlot ? "" : undefined}
          key={thinkingId}
        >
          <span aria-hidden="true" /><CadencedShimmer active>{thinkingLabel}</CadencedShimmer>
        </div>
      )}
      {visibleFrame.type === "assistant" && showActions && (hasMessageActions || actions?.sentAtMs != null) ? (
        <div className="thread-message-actions">
          {assistantCopyText.length > 0 ? <AssistantCopyButton value={assistantCopyText} getHtml={() => {
            const nodes = frameRef.current?.querySelectorAll<HTMLElement>("[data-assistant-copy-content] .opencraft-chat-document");
            return nodes?.length ? Array.from(nodes).map((node) => extractMarkdownElement(node).htmlText).join("\n") : null;
          }} /> : null}
          {onRetry === undefined ? null : <button onClick={onRetry} type="button" title="Retry"><RotateCcw size={13} /></button>}
          {visibleFrame.hookStats == null ? null : <HookStatsButton detailLevel={threadDetailLevel} stats={visibleFrame.hookStats} />}
          {actions?.sentAtMs == null ? null : <time data-assistant-message-sent-time dateTime={new Date(actions.sentAtMs).toISOString()} title={new Date(actions.sentAtMs).toLocaleString()}>{new Date(actions.sentAtMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
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
  const toolActivityPresenters = useContext(ToolActivityPresenterContext);
  const toolActivityPresenterVersion = useSyncExternalStore(
    toolActivityPresenters.subscribe,
    toolActivityPresenters.getSnapshot,
    toolActivityPresenters.getSnapshot,
  );
  const presentation = useMemo(
    () => createTimelineTurnPresentationPlan(turn, toolActivityPresenters, { isMostRecentTurn }),
    [isMostRecentTurn, toolActivityPresenterVersion, toolActivityPresenters, turn],
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
    </section>
  );
}

export interface ConversationRestoreSnapshot {
  readonly agentActivityCollapsedById?: Readonly<Record<string, boolean>>;
  readonly distanceFromBottomPx: number;
  readonly virtualizedTurnList: VirtualizedTurnRestoreState | null;
  readonly turnFollow?: TurnFollowRestoreState | null;
}

export interface ConversationProps {
  /** The host selects the policy; content growth must never select one implicitly. */
  readonly scrollPolicy: ConversationScrollPolicy;
  readonly timeline: TimelineSnapshot | null;
  /** Protocol-neutral prompt index. V3 cursors and V4 epochs remain behind this port. */
  readonly navigationSource?: ConversationNavigationSource | null;
  readonly footer?: ReactNode;
  readonly documentContext?: ConversationDocumentContextValue;
  readonly initialRestoreSnapshot?: ConversationRestoreSnapshot | null;
  readonly onRestoreSnapshotChange?: (snapshot: ConversationRestoreSnapshot) => void;
  readonly onLoadOlder?: () => void | "stop" | Promise<void | "stop">;
  readonly onContinueTurn?: (turnId: TurnId) => void;
  readonly continuableTurnId?: TurnId | null;
  /** Opens a child/background-agent thread when the host exposes it. */
  readonly onOpenSubagent?: (threadId: string, displayName: string) => void;
  readonly onRespondInteraction?: (requestId: string, action: ConversationInteractionAction) => Promise<void>;
  readonly onConversationScrollApiChange?: (api: ConversationScrollApi | null) => void;
  /** Local-submit intent is owned above the renderer and consumed exactly once. */
  readonly consumePendingLatestTurnSubmitPlacement?: () => LatestTurnPlacementSnapshot | null;
  readonly onVisibleContentReady?: () => void;
  readonly onVirtualizedTurnListApiChange?: (api: VirtualizedTurnListApi | null) => void;
  /** Renderer-neutral semantics supplied by product feature plugins. */
  readonly toolActivityPresenterRegistry?: ToolActivityPresenterRegistry;
  /** Optional product renderer for tool bodies such as Skills or Figma cards. */
  readonly renderToolCallContent?: ToolCallContentRenderer;
  /** Host resolver for external app/plugin/native icons; no network policy lives in ChatUI. */
  readonly renderToolCallIcon?: ToolCallIconRenderer;
  /** Host/layout capabilities; protocol and conversation data never infer these. */
  readonly surfaceCapabilities?: TimelineSurfaceCapabilities;
  /** Mirrors Codex's conversationDetailMode; commands is the desktop default. */
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
  // r3562 cO: latest/historical is a position, not a React lifetime boundary.
  return <motion.div style={{ y: offset ?? 0 }}><Turn activityCollapsedById={activityCollapsedById} isMostRecentTurn={isMostRecentTurn} onActivityCollapsedChange={onActivityCollapsedChange} onRetry={onRetry} threadDetailLevel={threadDetailLevel} turn={turn} /></motion.div>;
}


/** Product presentation policy, never inferred from provider, phase or status. */
export type ConversationScrollPolicy = "natural" | "response-placement";

export function Conversation({
  timeline,
  scrollPolicy,
  navigationSource = null,
  footer,
  documentContext = { conversationId: null, cwd: null, hostId: null, theme: "light" },
  initialRestoreSnapshot = null,
  onRestoreSnapshotChange,
  onLoadOlder,
  onOpenSubagent,
  onContinueTurn,
  continuableTurnId = null,
  onRespondInteraction,
  onConversationScrollApiChange,
  consumePendingLatestTurnSubmitPlacement,
  onVisibleContentReady,
  onVirtualizedTurnListApiChange,
  toolActivityPresenterRegistry = DEFAULT_TOOL_ACTIVITY_PRESENTERS,
  renderToolCallContent,
  renderToolCallIcon,
  surfaceCapabilities = DEFAULT_TIMELINE_SURFACE_CAPABILITIES,
  threadDetailLevel = "STEPS_COMMANDS",
}: ConversationProps) {
  const entries = useMemo(() => timeline === null ? [] : groupTimelineFramesByTurn(timeline), [timeline]);
  const latestTurn = entries.length === 0 ? null : entries[entries.length - 1] ?? null;
  const isLatestTurnInProgress = latestTurn?.status === "pending" || latestTurn?.status === "streaming";
  const [activityCollapsedById, setActivityCollapsedById] = useState<Readonly<Record<string, boolean>>>(
    () => initialRestoreSnapshot?.agentActivityCollapsedById ?? {},
  );
  const activityCollapsedByIdRef = useRef(activityCollapsedById);
  activityCollapsedByIdRef.current = activityCollapsedById;
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
    // r3562 ThreadScrollLayout owns initialOffset in BOTH policies. Never
    // reapply it on phase/content changes or a policy branch change.
    scrollController.scrollToDistanceFromBottomPx(
      normalizeInitialScrollDistance(initialRestoreSnapshot?.distanceFromBottomPx), "instant",
    );
  }, [initialRestoreSnapshot?.distanceFromBottomPx, scrollController]);
  const handleReflowAnchorCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    viewportOwner.captureReflowAnchor(event.target);
  }, [viewportOwner]);
  const virtualizerApiRef = useRef<WebVirtualizedTurnListApi | null>(null);
  const virtualizerRestoreStateRef = useRef(initialRestoreSnapshot?.virtualizedTurnList ?? null);
  const [virtualizedTurnListApi, setVirtualizedTurnListApi] = useState<WebVirtualizedTurnListApi | null>(null);
  const handleVirtualizerApiChange = useStableEvent((api: WebVirtualizedTurnListApi | null) => {
    if (api === null && virtualizerApiRef.current !== null) {
      virtualizerRestoreStateRef.current = virtualizerApiRef.current.captureRestoreState();
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


  // r3562 _k/wk: selection precedes policy construction. Baseline never owns
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
    const releaseScroll = scrollController.subscribe(listener);
    const releaseSpacer = responseApi?.subscribeSpacerHeight(listener);
    return () => { releaseScroll(); releaseSpacer?.(); };
  }, [responseApi, scrollController]);
  const getScrollToBottomVisibility = useCallback(() => shouldShowScrollToBottomAction({
    isScrolledFromBottom: scrollController.getSnapshot().isScrolledFromBottom,
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
    restoreCallbackRef.current?.({
      agentActivityCollapsedById: activityCollapsedByIdRef.current,
      distanceFromBottomPx: responseRestore?.distanceFromBottomPx
        ?? scrollController.getLastScrollDistanceFromBottomPx(),
      virtualizedTurnList: virtualizerApiRef.current?.captureRestoreState() ?? virtualizerRestoreStateRef.current,
      turnFollow: responseRestore?.turnFollow ?? null,
    });
    viewportOwner.dispose();
  }, [cancelPendingTargetPosition, scrollController, viewportOwner]);

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
  const footerElement = footer === undefined ? null : (
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
        {footer}
      </div>
    </div>
  );
  return (
    <ConversationDetailContext.Provider value={threadDetailLevel}>
    <ToolActivityPresenterContext.Provider value={toolActivityPresenterRegistry}>
      <ToolCallIconRendererContext.Provider value={renderToolCallIcon ?? null}>
        <ToolCallContentRendererContext.Provider value={renderToolCallContent ?? null}>
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
                      <div
                        className="thread-content thread-layout-width"
                        data-mcp-app-portal-target={surfaceCapabilities.embeddedPortalTarget || undefined}
                        data-thread-user-message-navigation-content="true"
                      >

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
                  {navigationSource !== null && virtualizedTurnListApi !== null ? (
                    <UserMessageNavigationRail
                      getScrollElement={() => scrollRef.current}
                      source={navigationSource}
                      virtualizedTurnListApi={virtualizedTurnListApi}
                    />
                  ) : null}
                </div>
              </ConversationDocumentContext.Provider>
            </SubagentNavigationContext.Provider>
          </ConversationInteractionContext.Provider>
        </ToolCallContentRendererContext.Provider>
      </ToolCallIconRendererContext.Provider>
    </ToolActivityPresenterContext.Provider>
    </ConversationDetailContext.Provider>
  );
}
