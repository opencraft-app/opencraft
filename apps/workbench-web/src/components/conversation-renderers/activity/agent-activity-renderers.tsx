import { HookIcon } from "@opencraft/design-system-web/action-icons";
import { ConversationEntryMotionContext } from "../../conversation/entry-motion";
import { ThinkingLabel } from "../../thinking-label";
import {
  deriveAgentActivityHeaderPresentation,
  formatHookEventName,
  formatHookSource,
  isVisibleAgentActivityRow,
  isToolActivityBlock,
  presentToolActivity,
  resolveAgentActivityLayout,
  type AgentActivityContentUnit,
  type AgentActivityGroupContentUnit,
  type AgentActivityStandaloneContentUnit,
  type AgentActivityHeaderSummary,
  type AgentActivityRenderUnit,
  type HookStats,
  type TimelineBlock,
  type ConversationDetailLevel,
} from "@opencraft/chat-core";
import { TimelineBlockView } from "@opencraft/timeline-render-react";

import { motion, useReducedMotion } from "motion/react";
import {
  Fragment,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { AgentActivityGroupDisclosure } from "../../agent-activity-group-disclosure";
import { useLatestTurnFollowContentRef } from "../../latest-turn-follow-content";
import { activityIcon } from "./activity-icon";
import { ThinkingActivityIcon } from "../../activity-glyphs";
import { SubagentActivityGroup } from "../tool/tool-renderers";
import { ToolActivityPresenterContext, ConversationDetailContext } from "../render-contexts";
import { ActivityDisclosureHeader, WorkStatusDivider } from "./work-status";
import { useDisclosureReflow } from "../../use-disclosure-reflow";
import { ReasoningBlock } from "./command-and-review-renderers";

function GenericBlock({ block, onRetry, richText = true }: { block: TimelineBlock; onRetry?: () => void; richText?: boolean }): ReactNode {
  return <TimelineBlockView block={block} onRetry={onRetry} richText={richText} />;
}

function AgentActivitySummaryView({ summary }: { readonly summary: AgentActivityHeaderSummary }) {
  if (summary.kind === "text") return <>{summary.text}</>;
  if (summary.parts.length === 0) return <>Worked</>;
  return (
    <span className="thread-agent-activity__summary-parts">
      {summary.parts.map((part, index) => (
        <span data-summary-kind={part.kind} key={part.key}>
          {index > 0 ? (
            <span aria-hidden="true" className="thread-agent-activity__summary-separator">
              {index === summary.parts.length - 1 ? (summary.parts.length === 2 ? " and " : ", and ") : ", "}
            </span>
          ) : null}
          <span data-source-count={part.sources.length || undefined}>{index === 0 ? part.text : part.text.charAt(0).toLocaleLowerCase() + part.text.slice(1)}</span>
        </span>
      ))}
    </span>
  );
}

function AgentActivityGroup({
  group,
  onRetry,
  collapsed,
  onCollapsedChange,
}: {
  group: AgentActivityGroupContentUnit | AgentActivityStandaloneContentUnit;
  onRetry?: () => void;
  collapsed: boolean | undefined;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const registry = useContext(ToolActivityPresenterContext);
  const detailLevel = useContext(ConversationDetailContext);
  const version = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const standalone = group.type === "standalone";
  const header = useMemo(
    () => group.type === "group" ? deriveAgentActivityHeaderPresentation(group, registry, detailLevel) : null,
    [group, registry, version, detailLevel],
  );
  const visibleBlocks = useMemo(
    () => (group.type === "group" ? group.blocks : [group.block]).filter((block) => isVisibleAgentActivityRow(block, registry, detailLevel)),
    [group, registry, version, detailLevel],
  );
  return (
    <div className="thread-agent-activity__group" data-conversation-row="activity" data-activity-group-id={group.id}>
      <AgentActivityGroupDisclosure
        canExpand={visibleBlocks.length > 0}
        standalone={standalone}
        collapsed={collapsed}
        onCollapsedChange={onCollapsedChange}
        icon={header?.state === "thinking" ? <ThinkingActivityIcon /> : header?.icon == null ? undefined : activityIcon(header.icon)}
        running={header?.active ?? false}
        hasRunningRows={visibleBlocks.some(block => isToolActivityBlock(block) && presentToolActivity(block, registry).state === "running")}
        shouldAnimateInitialCollapse={group.type === "group" && group.lifecycle.isLatestVisibleUnit && group.lifecycle.inProgress && !group.lifecycle.isActivitySliceClosed}
        summary={header === null ? null : <>
          {header.state === "thinking" && header.summary.kind === "text"
            ? <ThinkingLabel summary={header.summary.text} />
            : <AgentActivitySummaryView summary={header.summary} />}
        </>}
        summaryKey={header?.summaryKey ?? group.id}
        summaryTransition={header?.state === "summary" ? "immediate" : "deferred"}
      >
        {() => visibleBlocks.length > 0 ? (
          <div className="thread-agent-activity__rows" data-scroll-owner="timeline" style={standalone ? { display: "contents" } : undefined}>
            {visibleBlocks.map((block) => <GenericBlock block={block} key={block.id} onRetry={onRetry} />)}
          </div>
        ) : null}
      </AgentActivityGroupDisclosure>
    </div>
  );
}

function AgentActivityContent({
  contentUnits,
  onRetry,
  innerCollapsedById,
  onInnerCollapsedChange,
}: {
  contentUnits: readonly AgentActivityContentUnit[];
  onRetry?: () => void;
  innerCollapsedById: Readonly<Record<string, boolean>>;
  onInnerCollapsedChange: (id: string, collapsed: boolean) => void;
}) {
  const followContentRef = useLatestTurnFollowContentRef();
  const followUnit = contentUnits.findLast((unit) => unit.type === "group" || unit.type === "reasoning"
    || (unit.type === "standalone" && unit.block.type !== "user-message"));
  return (
    <div className="thread-agent-activity__content" data-unit-count={contentUnits.length}>
      {contentUnits.map((contentUnit) => (
        <div
          className="thread-agent-activity__unit"
          ref={contentUnit === followUnit ? followContentRef : undefined}
          key={contentUnit.id}
        >
          {contentUnit.type === "group" || (contentUnit.type === "standalone" && contentUnit.groupOrigin)
            ? <AgentActivityGroup group={contentUnit} onRetry={onRetry}
                collapsed={innerCollapsedById[contentUnit.id]}
                onCollapsedChange={collapsed => onInnerCollapsedChange(contentUnit.id, collapsed)} />
            : contentUnit.type === "reasoning" ? <ReasoningBlock block={contentUnit.block}
                presentation={contentUnit.presentation} active={contentUnit.active}
                collapsed={innerCollapsedById[contentUnit.id] ?? true}
                onCollapsedChange={collapsed => onInnerCollapsedChange(contentUnit.id, collapsed)} />
            : contentUnit.type === "worked-for" ? <WorkStatusDivider item={contentUnit.item} />
              : <GenericBlock block={contentUnit.block} onRetry={onRetry} />}
        </div>
      ))}
    </div>
  );
}

function AgentActivity({
  persistedCollapsed,
  onCollapsedChange,
  onRetry,
  unit,
  innerCollapsedById,
  onInnerCollapsedChange,
}: {
  persistedCollapsed: boolean | undefined;
  onCollapsedChange: (collapsed: boolean) => void;
  onRetry?: () => void;
  unit: AgentActivityRenderUnit;
  innerCollapsedById: Readonly<Record<string, boolean>>;
  onInnerCollapsedChange: (id: string, collapsed: boolean) => void;
}) {
  const prefersReducedMotion = useReducedMotion();
  const allowEntryMotion = useContext(ConversationEntryMotionContext);
  // Explicit disclosure interaction may animate even while recovery is syncing.
  const userOpening = useRef(false);
  const animateEntry = allowEntryMotion || userOpening.current;
  const layout = resolveAgentActivityLayout(unit, persistedCollapsed);
  const open = !layout.isCollapsed;
  const inlineSubagentActivity = unit.inlineSubagentActivity;
  const reflow = useDisclosureReflow();
  const staticWork = unit.contentUnits.find(content => content.type === "worked-for");
  const staticHeader = !layout.showToggle && inlineSubagentActivity === null
    && unit.contentUnits.every(content => content.type === "worked-for")
    && (staticWork?.type !== "worked-for" || staticWork.item.status !== "working")
    && (unit.workedDurationMs !== null || (staticWork?.type === "worked-for" && staticWork.item.status !== "working"));
  const hasAnimatedContent = !staticHeader && (layout.visibleUnits.length > 0 || inlineSubagentActivity !== null);
  // A static header already owns the completed interval; do not repeat its divider below.
  const visibleContent = staticHeader ? [] : open ? layout.visibleUnits : layout.persistentUnits;
  // One keyed list keeps persistent Apps mounted while restoring chronological
  // expanded content. Separate persistent/expanded trees duplicate the surface.
  const keepsPersistentContent = layout.showToggle && unit.partitions.persistentUnits.length > 0;
  const hasContent = visibleContent.length > 0 || (open && inlineSubagentActivity !== null);
  const renderContent = (contentUnits: readonly AgentActivityContentUnit[]) => (
    <ConversationEntryMotionContext.Provider value={animateEntry}>
      <AgentActivityContent contentUnits={contentUnits} onRetry={onRetry}
        innerCollapsedById={innerCollapsedById} onInnerCollapsedChange={onInnerCollapsedChange} />
    </ConversationEntryMotionContext.Provider>
  );
  useLayoutEffect(() => {
    // A persistent surface keeps this keyed list mounted. When there is no
    // outer entrance animation, settle after committing the visible rows.
    if (!open || !hasAnimatedContent || keepsPersistentContent) reflow.complete();
  }, [hasAnimatedContent, keepsPersistentContent, open, reflow.complete]);
  return (
    <section
      className="thread-agent-activity"
      data-activity-id={unit.id}
      data-activity-phase={unit.phase}
      data-collapsed={layout.isCollapsed || undefined}
      data-force-expanded={unit.forceExpanded || undefined}
    >
      {staticHeader ? <ActivityDisclosureHeader
        item={staticWork?.type === "worked-for" ? staticWork.item : null}
        durationMs={unit.workedDurationMs} count={0} open={false}
      /> : null}
      {layout.preToggleUnits.length > 0 ? (
        <div className="thread-agent-activity__pre-toggle">
          {renderContent(layout.preToggleUnits)}
          {layout.showToggle ? <div aria-hidden="true" className="thread-agent-activity__section-divider" /> : null}
        </div>
      ) : null}
      {layout.showToggle ? <ActivityDisclosureHeader
        item={layout.workedForItem}
        durationMs={unit.workedDurationMs}
        count={layout.collapsedItemCount}
        open={open}
        onToggle={(anchor) => {
          userOpening.current = !open;
          reflow.begin(anchor);
          onCollapsedChange(open);
        }}
      /> : null}
      {/* This disclosure only animates entry. A presence owner without an exit
          animation would defer removal past our collapsed layout completion. */}
      {hasContent ? (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="thread-agent-activity__outer-content"
            initial={animateEntry && !keepsPersistentContent ? { opacity: 0, y: prefersReducedMotion ? 0 : -8 } : false}
            key="content"
            onAnimationComplete={(definition) => {
              if (open && typeof definition === "object" && !Array.isArray(definition)
                && definition.opacity === 1) reflow.complete();
            }}
            transition={{ duration: prefersReducedMotion ? 0.12 : 0.22, ease: [0.33, 1, 0.68, 1] }}
          >
            {layout.showToggle ? <div aria-hidden="true" className="thread-agent-activity__section-divider" /> : null}
            {visibleContent.length > 0
              ? renderContent(visibleContent)
              : null}
            {!open || inlineSubagentActivity === null ? null : (
              <>
                {visibleContent.length > 0 ? <div aria-hidden="true" className="thread-agent-activity__section-divider" /> : null}
                <SubagentActivityGroup unit={inlineSubagentActivity} />
              </>
            )}
          </motion.div>
      ) : null}
    </section>
  );
}

function HookLifecycleIcon(): ReactNode { return <HookIcon size={18} />; }

function hookStatsEntryLabel(kind: HookStats["entries"][number]["kind"]): string {
  switch (kind) {
    case "feedback": return "Feedback";
    case "stop": return "Stop";
    case "error": return "Error";
  }
}

export type { ConversationDetailLevel } from "@opencraft/chat-core";

function HookStatsSummary({ stats }: { readonly stats: HookStats }) {
  return (
    <>
      <strong>Hooks summary</strong>
      <span className="thread-hook-stats__counts">
        <span>Ran</span><b>{stats.count}</b>
        {stats.blockedCount > 0 ? <><span>Blocked</span><b>{stats.blockedCount}</b></> : null}
        {stats.errorCount > 0 ? <><span>Errors</span><b>{stats.errorCount}</b></> : null}
      </span>
      {stats.entries.length > 0 ? (
        <span className="thread-hook-stats__entries">
          {stats.entries.map((entry, index) => (
            <span className="thread-hook-stats__entry" key={`${entry.kind}:${index}:${entry.text}`}>
              <em>{hookStatsEntryLabel(entry.kind)}</em>
              <span>{entry.text}</span>
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}

function HookStatsDetails({ stats }: { readonly stats: HookStats }) {
  return (
    <>
      <strong>Hooks</strong>
      <ul className="thread-hook-stats__runs">
        {stats.runs.map((run) => (
          <Fragment key={run.id}>
            <li>{formatHookEventName(run.eventName)}</li>
            <li className="thread-hook-stats__run">
              <span>{formatHookSource(run.source)}{run.count > 1 ? ` · ${String(run.count)} runs` : ""}</span>
              {run.statusMessage === null ? null : <span>{run.statusMessage}</span>}
              {run.entries.map((entry, index) => (
                <span className={`is-${entry.tone}`} key={`${entry.tone}:${index}:${entry.text}`}>{entry.text}</span>
              ))}
            </li>
          </Fragment>
        ))}
      </ul>
    </>
  );
}

function HookStatsButton({
  detailLevel,
  stats,
}: {
  readonly detailLevel: ConversationDetailLevel;
  readonly stats: HookStats;
}) {
  const tooltipId = useId();
  const detailed = detailLevel !== "STEPS_PROSE";
  return (
    <span className="thread-hook-stats">
      <span aria-describedby={tooltipId} aria-label="Hooks" className="thread-hook-stats__trigger" role="img" tabIndex={0}>
        <HookLifecycleIcon />
      </span>
      <span className="thread-hook-stats__tooltip" data-detail-level={detailed ? "commands" : "prose"} id={tooltipId} role="tooltip">
        {detailed ? <HookStatsDetails stats={stats} /> : <HookStatsSummary stats={stats} />}
      </span>
    </span>
  );
}


export {
  AgentActivity,
  GenericBlock,
  HookStatsButton,
};
