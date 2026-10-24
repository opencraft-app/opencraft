import type { AssistantTimelineFrame, EventTimelineFrame, InteractionTimelineFrame, ReasoningTimelineBlock, SubagentTimelineBlock, TextTimelineBlock, TodoTimelineBlock, TimelineBlock, TimelineStatus, UserTimelineFrame, } from "./timeline";

import type { TimelineTurnView } from "./timeline-turns";

import type { WorkStatusItem } from "./work-status";

import type { ConversationDetailLevel } from "./conversation-presentation";

import { isAssistantAnswerContent, skillReadPresentation } from "./conversation-presentation";



import { presentReasoning, readReasoningContent, type ReasoningContentPresentation } from "./reasoning";

import { isToolActivityBlock, isSummaryOnlyToolActivityBlock, isToolActivityPresentationSuppressed, presentToolActivity, type ToolActivityIcon, type ToolActivityPresenterRegistry, } from "./tool-activity";

export type AgentActivityPhase = "before-final-answer" | "after-final-answer";

export type AgentActivitySegmentEnd = "open" | "user-input" | "final-answer" | "reasoning" | "content" | "turn-terminal";

export interface AgentActivitySummary {
    readonly commandCount: number;
    readonly patchCount: number;
    readonly reasoningCount: number;
    readonly subagentCount: number;
    readonly toolCount: number;
}

export interface AgentActivityHeaderPresentation {
    readonly state: "active" | "thinking" | "summary";
    readonly summaryKey: string;
    readonly icon: ToolActivityIcon | null;
    readonly summary: AgentActivityHeaderSummary;
    readonly active: boolean;
}

export interface AgentActivitySummarySource {
    readonly key: string;
    readonly name: string;
    readonly kind: "integration" | "browser" | "tool";
    readonly isIntegration: boolean;
}

export interface AgentActivitySummaryPart {
    readonly key: string;
    readonly kind: "sources" | "files" | "exploration" | "commands" | "web-search" | "images" | "dynamic" | "tool";
    readonly text: string;
    readonly icon: ToolActivityIcon | null;
    readonly sources: readonly AgentActivitySummarySource[];
}

export type AgentActivityHeaderSummary = {
    readonly kind: "text";
    readonly text: string;
} | {
    readonly kind: "parts";
    readonly parts: readonly AgentActivitySummaryPart[];
};

export interface AgentActivityGroupLifecycle {
    readonly isLatestVisibleUnit: boolean;
    readonly isActivitySliceClosed: boolean;
    readonly isExploring: boolean;
    readonly inProgress: boolean;
}

export interface AgentActivityUnitPartitions {
    readonly workedForItem: WorkStatusItem | null;
    readonly collapsibleUnits: readonly AgentActivityContentUnit[];
    readonly expandedUnits: readonly AgentActivityContentUnit[];
    readonly persistentUnits: readonly AgentActivityContentUnit[];
    readonly preToggleUnits: readonly AgentActivityContentUnit[];
}

export interface AgentActivityPartitionOptions {
    readonly keepMcpAppEntriesPersistent?: boolean;
    readonly renderMcpApps?: boolean;
    readonly resolvesMcpAppSurface?: (block: Extract<TimelineBlock, {
        type: "tool-call";
    }>) => boolean;
}

export interface AgentActivityRenderUnit {
    readonly type: "agent-activity";
    readonly id: string;
    readonly blocks: readonly TimelineBlock[];
    readonly contentUnits: readonly AgentActivityContentUnit[];
    readonly inlineSubagentActivity: SubagentActivityRenderUnit | null;
    readonly partitions: AgentActivityUnitPartitions;
    readonly collapsedItemCount: number;
    readonly phase: AgentActivityPhase;
    readonly status: TimelineStatus;
    readonly workedDurationMs: number | null;
    readonly hasFinalAssistantStarted: boolean;
    readonly segmentEnd: AgentActivitySegmentEnd;
    readonly hasRenderableAgentItems: boolean;
    readonly isTurnCancelled: boolean;
    readonly forceExpanded: boolean;
    readonly disableCollapse: boolean;
    readonly preventAutoCollapse: boolean;
    readonly summary: AgentActivitySummary;
}

export interface AgentActivityGroupContentUnit {
    readonly type: "group";
    readonly id: string;
    readonly blocks: readonly TimelineBlock[];
    readonly lifecycle: AgentActivityGroupLifecycle;
}

export interface AgentActivityStandaloneContentUnit {
    readonly type: "standalone";
    readonly id: string;
    readonly block: TimelineBlock;
    /** Flatten the group's presentation without replacing its mounted content owner. */
    readonly groupOrigin?: true;
}

export interface AgentActivityWorkStatusContentUnit {
    readonly type: "worked-for";
    readonly id: string;
    readonly item: WorkStatusItem;
}

export type AgentActivityContentUnit = AgentActivityGroupContentUnit | AgentActivityStandaloneContentUnit | AgentActivityWorkStatusContentUnit | ReasoningRenderUnit;

export interface AgentActivityDisclosureInput {
    readonly hasFinalAssistantStarted: boolean;
    readonly isTurnCancelled: boolean;
    readonly hasRenderableAgentItems: boolean;
    readonly forceExpanded?: boolean;
    readonly preventAutoCollapse?: boolean;
    readonly persistedCollapsed?: boolean;
}

export interface AgentActivityDisclosureState {
    readonly shouldAllowCollapse: boolean;
    readonly isCollapsed: boolean;
}

export interface AgentActivityLayout {
    readonly showToggle: boolean;
    readonly workedForItem: WorkStatusItem | null;
    readonly isCollapsed: boolean;
    readonly preToggleUnits: readonly AgentActivityContentUnit[];
    readonly persistentUnits: readonly AgentActivityContentUnit[];
    readonly visibleUnits: readonly AgentActivityContentUnit[];
    readonly collapsedItemCount: number;
    readonly showInlineSubagentActivity: boolean;
}

export interface AssistantContentRenderUnit {
    readonly type: "assistant-content";
    readonly id: string;
    readonly block: TimelineBlock;
}

export interface SubagentActivityRenderUnit {
    readonly type: "subagent-activity";
    readonly id: string;
    readonly blocks: readonly SubagentTimelineBlock[];
}

export interface ReasoningRenderUnit {
    readonly type: "reasoning";
    readonly id: string;
    readonly block: ReasoningTimelineBlock;
    readonly presentation: ReasoningContentPresentation;
    readonly active: boolean;
}

export type AssistantRenderUnit = AgentActivityRenderUnit | AssistantContentRenderUnit | SubagentActivityRenderUnit | ReasoningRenderUnit;

export interface AssistantTurnPresentationPlan {
    readonly slots: readonly AssistantRenderUnit[];
    readonly changeSummary: Extract<TimelineBlock, {
        type: "turn-diff";
    }> | null;
}

export type TimelineTurnThinkingOwner = {
    readonly type: "none";
} | {
    readonly type: "reasoning";
    readonly reasoningId: string;
} | {
    readonly type: "activity";
    readonly activityId: string;
    readonly groupId: string;
} | {
    readonly type: "turn";
    readonly placeholderId: string;
    readonly label: "Thinking" | "Planning";
};

export interface TimelineTurnPresentationPlan {
    readonly userFrames: readonly UserTimelineFrame[];
    readonly assistantFrame: AssistantTimelineFrame | null;
    readonly assistant: AssistantTurnPresentationPlan | null;
    readonly activeTodo: TodoTimelineBlock | null;
    readonly auxiliaryFrames: readonly (EventTimelineFrame | InteractionTimelineFrame)[];
    readonly thinkingOwner: TimelineTurnThinkingOwner;
    readonly topLevelSlotCount: number;
}

export interface TimelineTurnPresentationOptions {
    readonly isMostRecentTurn: boolean;
    readonly partitionOptions?: AgentActivityPartitionOptions;
    readonly reasoningPresenter?: typeof presentReasoning;
}


function lastIndex<T>(values: readonly T[], matches: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index--) if (matches(values[index]!)) return index;
  return -1;
}
const live = (status: TimelineStatus) => status === "pending" || status === "streaming";
const running = (block: TimelineBlock) => "status" in block && (block.status === "pending" || block.status === "running");
const qualifyingAnswer = (block: TimelineBlock): block is TextTimelineBlock => block.type === "text"
  && block.phase === "final_answer" && isAssistantAnswerContent(block)
  && (block.text.trim().length > 0 || block.completed === true || block.hasStructuredOutput === true);

export function isAgentActivityBlock(block: TimelineBlock): boolean {
  return (block.type === "user-message" && block.messageKind === "steering") || (block.type === "image" && block.generated && running(block)) || isToolActivityBlock(block) || ["reasoning", "subagent", "todo", "compaction", "realtime-transcript", "automatic-approval-review", "auto-review-interruption-warning"].includes(block.type)
    || (block.type === "text" && block.phase === "commentary" && block.delivery !== "async" && !block.asyncQuestions?.length);
}

export function isVisibleAgentActivityRow(block: TimelineBlock, registry?: ToolActivityPresenterRegistry, detailLevel: ConversationDetailLevel = "STEPS_COMMANDS"): boolean {
  if (block.type === "reasoning" || (block.type === "patch" && !block.changes.length)) return false;
  if (block.type === "automatic-approval-review" && block.review.status === "approved") return false;
  if (isToolActivityBlock(block)) {
    if ((block.type === "tool-call" && isToolActivityPresentationSuppressed(block, registry))) return false;
    if (block.type === "command-execution") {
      const skill = skillReadPresentation(block, detailLevel);
      if (skill) return skill.visible;
      if (running(block) && block.actions.some(action => action.type !== "unknown")) return false;
    }
    return !isSummaryOnlyToolActivityBlock(block, registry);
  }
  return true;
}

export function createAgentActivityContentUnits(blocks: readonly TimelineBlock[], status: TimelineStatus, registry?: ToolActivityPresenterRegistry,
  isActivitySliceClosed = !live(status), reasoningPresenter = presentReasoning): readonly AgentActivityContentUnit[] {
  const output: AgentActivityContentUnit[] = [];
  let group: TimelineBlock[] = [];
  const flush = () => {
    if (!group.length) return;
    output.push({ type: "group", id: `agent-activity-group:${group[0]!.id}`, blocks: group,
      lifecycle: { isLatestVisibleUnit: false, isActivitySliceClosed, isExploring: false, inProgress: false } });
    group = [];
  };
  for (const block of blocks) {
    if (block.type === "patch" && !block.changes.length) continue;
    if (block.type === "reasoning") {
      if (!readReasoningContent(block)) continue;
      flush();
      const presentation = reasoningPresenter(block, false);
      if (presentation) output.push({ type: "reasoning", id: block.id, block, presentation, active: false });
      continue;
    }
    if (isToolActivityBlock(block)) {
      const presentation = presentToolActivity(block, registry);
      if ((block.type === "tool-call" && isToolActivityPresentationSuppressed(block, registry))) continue;
      if (presentation.grouping === "groupable") { group.push(block); continue; }
      if (isSummaryOnlyToolActivityBlock(block, registry)) continue;
      flush();
      output.push({ type: "standalone", id: `agent-activity-standalone:${block.id}`, block });
      continue;
    }
    if (block.type === "text" && !isAgentActivityBlock(block)) continue;
    if (!isAgentActivityBlock(block) && block.type !== "image" && block.type !== "user-message") continue;
    if (!isVisibleAgentActivityRow(block, registry)) continue;
    flush();
    output.push({ type: "standalone", id: `agent-activity-standalone:${block.id}`, block });
  }
  flush();
  return output.flatMap((unit, index): AgentActivityContentUnit[] => {
    if (unit.type !== "group") return [unit];
    const latest = index === output.length - 1;
    const inProgress = latest && !isActivitySliceClosed && live(status);
    const onlyBlock = unit.blocks.length === 1 ? unit.blocks[0] : undefined;
    const groupedPatch = onlyBlock?.type === "patch" && onlyBlock.changes.length > 1;
    if (!inProgress && onlyBlock && !running(onlyBlock) && !groupedPatch) {
      return isVisibleAgentActivityRow(onlyBlock, registry) ? [{ type: "standalone", id: unit.id, block: onlyBlock, groupOrigin: true }] : [];
    }
    return [{ ...unit, lifecycle: { isLatestVisibleUnit: latest, isActivitySliceClosed,
      isExploring: (() => { const block = unit.blocks[unit.blocks.length - 1]; return Boolean(block?.type === "command-execution" && running(block) && block.actions.some(action => action.type !== "unknown")); })(), inProgress } }];
  });
}

export function partitionAgentActivityContentUnits(units: readonly AgentActivityContentUnit[], options: AgentActivityPartitionOptions = {}): AgentActivityUnitPartitions {
  let workedForItem: WorkStatusItem | null = null;
  const preToggleUnits: AgentActivityContentUnit[] = [], persistentUnits: AgentActivityContentUnit[] = [], collapsibleUnits: AgentActivityContentUnit[] = [], expandedUnits: AgentActivityContentUnit[] = [];
  for (const unit of units) {
    if (unit.type === "worked-for") { workedForItem = unit.item; continue; }
    const block = unit.type === "standalone" ? unit.block : null;
    if (block?.type === "realtime-transcript" && block.handoffId === null) { preToggleUnits.push(unit); continue; }
    expandedUnits.push(unit);
    const persistent = block?.type === "user-message" || (block && qualifyingAnswer(block))
      || (block?.type === "realtime-transcript" && block.handoffId !== null)
      || (block?.type === "tool-call" && options.keepMcpAppEntriesPersistent === true && options.renderMcpApps === true
        && block.kind === "mcp" && (running(block) || block.output !== null)
        && (Boolean(block.appResourceUri) || options.resolvesMcpAppSurface?.(block) === true));
    (persistent ? persistentUnits : collapsibleUnits).push(unit);
  }
  return { workedForItem, collapsibleUnits, expandedUnits, persistentUnits, preToggleUnits };
}

export function countAgentActivityContentItems(units: readonly AgentActivityContentUnit[]): number {
  return units.reduce((count, unit) => count + (unit.type === "group" ? unit.blocks.length : 1), 0);
}

export function hasContinuingLiveDynamicToolActivity(blocks: readonly TimelineBlock[], status: TimelineStatus, registry?: ToolActivityPresenterRegistry): boolean {
  if (!live(status)) return false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.type !== "tool-call" || block.kind !== "dynamic") return false;
    if (!isToolActivityPresentationSuppressed(block, registry) && (running(block) || presentToolActivity(block, registry).continuesLiveActivityBetweenCalls)) return true;
  }
  return false;
}

function joinWords(parts: readonly string[]): string {
  if (parts.length < 2) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

export function agentActivityHeaderAccessibleLabel(summary: AgentActivityHeaderSummary): string {
  if (summary.kind === "text") return summary.text;
  return joinWords(summary.parts.map((part, index) => index === 0 ? part.text : part.text.charAt(0).toLowerCase() + part.text.slice(1)));
}

function sourceTitle(value: string): string {
  if (value.toLowerCase() === "github") return "GitHub";
  return value.split(/[_-]+/).filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function completedSummary(blocks: readonly TimelineBlock[], registry?: ToolActivityPresenterRegistry): AgentActivitySummaryPart[] {
  const sources = new Map<string, AgentActivitySummarySource>(), dynamic = new Map<string, AgentActivitySummaryPart>();
  const changedFiles = new Set<string>();
  let commands = 0, reads = false, searches = false, lists = false, web = false, images = 0, tools = 0;
  for (const block of blocks) {
    if (block.type === "patch") { for (const change of block.changes) changedFiles.add(change.path); continue; }
    if (block.type === "command-execution") {
      if (block.actions.some(action => ["read", "search", "list-files"].includes(action.type))) {
        reads ||= block.actions.some(action => action.type === "read"); searches ||= block.actions.some(action => action.type === "search"); lists ||= block.actions.some(action => action.type === "list-files");
      } else commands++;
      continue;
    }
    if (block.type !== "tool-call" || (block.type === "tool-call" && isToolActivityPresentationSuppressed(block, registry))) continue;
    const presentation = presentToolActivity(block, registry);
    if (block.kind === "web-search") web = true;
    else if (block.kind === "image-view") images += block.imagePaths?.length ?? 1;
    else if (block.kind === "dynamic") {
      const key = `dynamic:${presentation.summaryKey}`;
      dynamic.set(key, { key, kind: "dynamic", text: presentation.summary, icon: presentation.icon, sources: [] });
    } else if (block.sourceKind === "browserUse") {
      const chrome = block.sourceBackend === "chrome";
      const key = chrome ? "browser-use:chrome" : "browser-use";
      sources.set(key, { key, name: chrome ? "Chrome" : "the browser", kind: "browser", isIntegration: chrome });
    } else if (block.sourceKind === "computerUse" && (block.appName || block.sourceApp?.kind === "displayName")) {
      const name = block.appName || (block.sourceApp?.kind === "displayName" ? block.sourceApp.displayName : "");
      const key = `${block.appName ? "app" : "native-app"}:${name}`;
      sources.set(key, { key, name, kind: "integration", isIntegration: true });
    } else if (block.server) {
      const key = `server:${block.server}`;
      sources.set(key, { key, name: sourceTitle(block.server), kind: "integration", isIntegration: true });
    } else tools++;
  }
  const result: AgentActivitySummaryPart[] = [];
  const add = (key: string, kind: AgentActivitySummaryPart["kind"], text: string, icon: ToolActivityIcon) => result.push({ key, kind, text, icon, sources: [] });
  if (sources.size) {
    const sourceList = [...sources.values()];
    result.push({ key: `sources:${sourceList.map(source => source.key).join("|")}`, kind: "sources", text: `Used ${joinWords(sourceList.map(source => source.name))}${sourceList.every(source => source.isIntegration) ? ` integration${sources.size > 1 ? "s" : ""}` : ""}`, icon: sourceList.every(source => source.kind === "browser") ? "browser" : "wrench", sources: sourceList });
  }
  if (changedFiles.size) add("files", "files", changedFiles.size === 1 ? "Edited a file" : "Edited files", "patch");
  if (reads || searches || lists) add("exploration", "exploration", reads ? "Read files" : searches ? "Searched for files" : "Listed files", reads ? "read" : searches ? "search" : "files");
  if (commands) add("commands", "commands", commands === 1 ? "Ran a command" : "Ran commands", "terminal");
  if (web) add("web-search", "web-search", "Searched the web", "browser");
  if (images) add("images", "images", images === 1 ? "Viewed an image" : "Viewed images", "image");
  result.push(...dynamic.values());
  if (tools) add("tools", "tool", tools === 1 ? "Called a tool" : "Called tools", "wrench");
  return result;
}

export function deriveAgentActivityHeaderPresentation(unit: Pick<AgentActivityGroupContentUnit, "blocks" | "lifecycle">, registry?: ToolActivityPresenterRegistry, detailLevel: ConversationDetailLevel = "STEPS_COMMANDS"): AgentActivityHeaderPresentation {
  if (unit.lifecycle.inProgress && !unit.lifecycle.isActivitySliceClosed) {
    const activeBlock = [...unit.blocks].reverse().find(block => isToolActivityBlock(block) && !(block.type === "tool-call" && isToolActivityPresentationSuppressed(block, registry)) && (running(block) || unit.lifecycle.isExploring));
    if (activeBlock && isToolActivityBlock(activeBlock)) {
      const presentation = presentToolActivity(activeBlock, registry);
      const skill = activeBlock.type === "command-execution" ? skillReadPresentation(activeBlock, detailLevel) : null;
      let text = skill ? `${running(activeBlock) ? "Reading" : skill.summary} ${skill.detail}` : `${presentation.summary}${presentation.detail ? ` ${presentation.detail}` : ""}`;
      if (activeBlock.type === "command-execution"
        && !activeBlock.actions.some(action => action.type === "read" || action.type === "search" || action.type === "list-files")
        && detailLevel === "STEPS_COMMANDS") text = `Running ${activeBlock.command.trim() || "command"}`;
      return { state: "active", summaryKey: `active:${activeBlock.id}`, icon: presentation.icon, summary: { kind: "text", text }, active: true };
    }
    return { state: "thinking", summaryKey: "thinking", icon: null, summary: { kind: "text", text: "Thinking" }, active: true };
  }
  const parts = completedSummary(unit.blocks, registry);
  return { state: "summary", summaryKey: "summary", icon: parts[0]?.icon ?? null, summary: { kind: "parts", parts }, active: false };
}

export function shouldRenderAgentThinkingPlaceholder(frame: AssistantTimelineFrame, registry?: ToolActivityPresenterRegistry): boolean {
  if (!live(frame.status)) return false;
  const blocks = frame.blocks.filter(block => !(block.type === "automatic-approval-review" && block.review.status === "approved"));
  // Generated media owns its pending feedback within the current response.
  // Earlier images must not suppress work after a new answer or input.
  const responseBoundary = lastIndex(blocks, block => block.type === "user-message" || block.type === "realtime-transcript"
    || (block.type === "text" && (isAssistantAnswerContent(block)
      || block.delivery === "async" || (block.asyncQuestions?.length ?? 0) > 0)));
  if (blocks.slice(responseBoundary + 1).some(block => block.type === "image"
    && (block.status === "pending" || block.status === "running"))) return false;
  const block = blocks[blocks.length - 1];
  if (!block) return true;
  if (block.type === "reasoning") return true;
  if (block.type === "text" && block.phase !== "commentary") return !(block.text.trim() || block.completed);
  if (block.type === "plan" && !block.completed) return false;
  if (block.type === "user-message" || block.type === "realtime-transcript") return true;
  if (block.type === "todo") {
    const predecessor = [...blocks.slice(0, -1)].reverse().find(b => b.type !== "todo");
    if (predecessor?.type === "reasoning") return true;
    return block.entries.every(entry => entry.status === "complete");
  }
  for (let index = blocks.length - 1; index >= 0; index--) {
    const current = blocks[index]!;
    if (current.type === "reasoning") continue;
    if (current.type === "text") {
      if (current.phase !== "commentary") return index === blocks.length - 1 ? false : true;
      continue;
    }
    if (current.type === "image") continue;
    if (current.type === "todo") {
      if (block.type === "text" && block.phase === "commentary") continue;
      return current.entries.every(entry => entry.status === "complete");
    }
    if (current.type === "compaction") return current.completed;
    if (isToolActivityBlock(current)) {
      if (current.type === "tool-call" && isToolActivityPresentationSuppressed(current, registry)) continue;
      return !running(current) && !hasContinuingLiveDynamicToolActivity(blocks, frame.status, registry);
    }
  }
  return true;
}

export function resolveAgentActivityDisclosure({ forceExpanded = false, hasFinalAssistantStarted, hasRenderableAgentItems, isTurnCancelled, persistedCollapsed, preventAutoCollapse = false }: AgentActivityDisclosureInput): AgentActivityDisclosureState {
  const shouldAllowCollapse = hasFinalAssistantStarted && hasRenderableAgentItems && !isTurnCancelled;
  return { shouldAllowCollapse, isCollapsed: shouldAllowCollapse && !forceExpanded && (persistedCollapsed ?? !preventAutoCollapse) };
}

export function shouldAllowAgentActivityCollapse(unit: AgentActivityRenderUnit): boolean {
  const onlyContent = unit.partitions.collapsibleUnits.length === 1 ? unit.partitions.collapsibleUnits[0] : null;
  const compactionOnly = unit.inlineSubagentActivity === null && onlyContent?.type === "standalone" && onlyContent.block.type === "compaction";
  return unit.collapsedItemCount > 0 && !unit.disableCollapse && !unit.forceExpanded && !compactionOnly && resolveAgentActivityDisclosure(unit).shouldAllowCollapse;
}

export function resolveAgentActivityLayout(unit: AgentActivityRenderUnit, persistedCollapsed?: boolean): AgentActivityLayout {
  const showToggle = shouldAllowAgentActivityCollapse(unit);
  const collapsed = showToggle && resolveAgentActivityDisclosure({ ...unit, persistedCollapsed }).isCollapsed;
  return { showToggle, workedForItem: showToggle ? unit.partitions.workedForItem : null, isCollapsed: collapsed,
    preToggleUnits: showToggle ? unit.partitions.preToggleUnits : [],
    persistentUnits: showToggle && collapsed ? unit.partitions.persistentUnits : [],
    visibleUnits: showToggle ? (collapsed ? unit.partitions.collapsibleUnits : unit.partitions.expandedUnits) : unit.contentUnits,
    collapsedItemCount: showToggle ? unit.collapsedItemCount : countAgentActivityContentItems(unit.contentUnits) + (unit.inlineSubagentActivity ? 1 : 0), showInlineSubagentActivity: Boolean(unit.inlineSubagentActivity) && !collapsed };
}

export function createAssistantTurnPresentationPlan(frame: AssistantTimelineFrame, registry?: ToolActivityPresenterRegistry,
  partitionOptions: AgentActivityPartitionOptions = {}, reasoningPresenter = presentReasoning): AssistantTurnPresentationPlan {
  const slots: AssistantRenderUnit[] = [];
  const work = frame.status === "interrupted" && frame.interruptedByThisClient && frame.durationMs !== null ? { type: "worked-for" as const, status: "stopped" as const, startedAtMs: 0, completedAtMs: frame.durationMs } : frame.workStatus;
  const hasStaticDuration = !live(frame.status) && frame.displayDurationMs != null
    && Number.isFinite(frame.displayDurationMs) && frame.displayDurationMs >= 0;
  const latestPlan = [...frame.blocks].reverse().find(block => block.type === "plan");
  let changeSummary = frame.changeSummary ?? null;
  let pending: TimelineBlock[] = [];
  let activityId = `${frame.turnId}:slot:agent-activity`;
  let phase: AgentActivityPhase = "before-final-answer";
  let finalSegmentId: string | null = null;
  const flush = (segmentEnd: AgentActivitySegmentEnd) => {
    // A paint-only history can retain the completed clock without tool bodies.
    if (!pending.length && !((work || hasStaticDuration) && segmentEnd === "final-answer"
      && !slots.some(slot => slot.type === "agent-activity"))) return;
    finalSegmentId = activityId;
    const subagents = pending.filter((block): block is SubagentTimelineBlock => block.type === "subagent");
    const blocks = pending.filter(block => block.type !== "subagent");
    pending = [];
    const closed = segmentEnd !== "open";
    const status = closed && segmentEnd !== "turn-terminal" ? "complete" : frame.status;
    const contentUnits = createAgentActivityContentUnits(blocks, status, registry, closed, reasoningPresenter).map(unit =>
      unit.type === "reasoning" ? { ...unit, id: `${frame.turnId}:slot:reasoning:${unit.block.id}` } : unit);
    const inlineSubagentActivity: SubagentActivityRenderUnit | null = subagents.length
      ? { type: "subagent-activity", id: `${activityId}:subagents`, blocks: subagents } : null;
    const visible = contentUnits.length > 0 || subagents.length > 0;
    if (!visible && !work && !hasStaticDuration) return;
    slots.push({ type: "agent-activity", id: activityId, blocks, contentUnits, inlineSubagentActivity,
      partitions: partitionAgentActivityContentUnits(contentUnits, partitionOptions),
      collapsedItemCount: countAgentActivityContentItems(partitionAgentActivityContentUnits(contentUnits, partitionOptions).collapsibleUnits) + (subagents.length ? 1 : 0), phase, status,
      workedDurationMs: null, hasFinalAssistantStarted: segmentEnd === "final-answer", segmentEnd,
      hasRenderableAgentItems: visible || Boolean(work) || hasStaticDuration, isTurnCancelled: frame.status === "interrupted", forceExpanded: false,
      disableCollapse: phase === "after-final-answer" && (segmentEnd === "open" || segmentEnd === "turn-terminal"), preventAutoCollapse: live(status) && (blocks.some(b => running(b) || (b.type === "reasoning" && b.streaming) || (b.type === "compaction" && !b.completed)) || subagents.some(running)),
      summary: { commandCount: blocks.filter(b => b.type === "command-execution").length,
        patchCount: blocks.filter(b => b.type === "patch").length, reasoningCount: blocks.filter(b => b.type === "reasoning").length,
        subagentCount: subagents.length, toolCount: blocks.filter(b => b.type === "tool-call").length } });
  };
  for (const block of frame.blocks) {
    if (block.type === "turn-diff") { changeSummary = block; continue; }
    if (block.type === "todo" || block.type === "plan-implementation" || (block.type === "plan" && block !== latestPlan)) continue;
    if (block.type === "automatic-approval-review" && block.review.status === "approved") continue;
    if (block.type === "patch" && !block.changes.length) continue;
    if (block.type === "tool-call" && ((block.namespace === "clock" && block.name === "sleep") ||
      (block.kind === "web-search" && (!block.input || (typeof block.input === "object" && "query" in block.input && !block.input.query && !("action" in block.input && block.input.action)))))) continue;
    if (block.type !== "user-message" && isAgentActivityBlock(block)) { pending.push(block); continue; }
    const end: AgentActivitySegmentEnd = qualifyingAnswer(block) ? "final-answer" : block.type === "user-message" ? "user-input" : "content";
    flush(end);
    slots.push({ type: "assistant-content", id: `${frame.turnId}:slot:assistant-content:${block.id}`, block });
    activityId = `${frame.turnId}:slot:activity-after:${block.id}`;
    if (end === "final-answer") phase = "after-final-answer";
    else if (end === "user-input" || (block.type === "text" && (block.delivery === "async" || Boolean(block.asyncQuestions?.length)))) phase = "before-final-answer";
  }
  flush(live(frame.status) ? "open" : "turn-terminal");
  const clockIndex = lastIndex(slots, slot => slot.type === "agent-activity" && slot.id === finalSegmentId);
  if (clockIndex >= 0) {
    const owner = slots[clockIndex] as AgentActivityRenderUnit;
    const workUnit: AgentActivityWorkStatusContentUnit | null = work ? { type: "worked-for", id: `${frame.turnId}:worked-for`, item: work } : null;
    const contentUnits = workUnit ? work?.status === "working" ? [workUnit, ...owner.contentUnits] : [...owner.contentUnits, workUnit] : owner.contentUnits;
    slots[clockIndex] = { ...owner, workedDurationMs: frame.displayDurationMs ?? frame.durationMs, contentUnits,
      partitions: partitionAgentActivityContentUnits(contentUnits, partitionOptions) };
  }
  // Only the assigned clock owner can keep an otherwise empty work segment.
  // Earlier hidden observations must not reserve a timeline layout slot.
  return { slots: slots.filter(slot => slot.type !== "agent-activity"
    || slot.contentUnits.length > 0 || slot.inlineSubagentActivity !== null
    || slot.workedDurationMs !== null), changeSummary };
}

export function activeTimelineTurnTodo(turn: TimelineTurnView, isMostRecentTurn: boolean): TodoTimelineBlock | null {
  if (!isMostRecentTurn || !live(turn.status)) return null;
  const blocks = turn.frames.flatMap(frame => frame.blocks);
  return [...blocks].reverse().find((block): block is TodoTimelineBlock => block.type === "todo") ?? null;
}

export function createTimelineTurnPresentationPlan(turn: TimelineTurnView, registry?: ToolActivityPresenterRegistry,
  { isMostRecentTurn, partitionOptions = {}, reasoningPresenter = presentReasoning }: TimelineTurnPresentationOptions = { isMostRecentTurn: false }): TimelineTurnPresentationPlan {
  const userFrames: UserTimelineFrame[] = [];
  let start = 0;
  while (turn.frames[start]?.type === "user") { userFrames.push(turn.frames[start] as UserTimelineFrame); start++; }
  const remaining = turn.frames.slice(start);
  const assistants = remaining.filter(frame => frame.type === "assistant");
  const seed = assistants[0];
  // A Turn resource survives independently of which transcript lanes exist.
  const changeSummary = turn.frames.find(frame => frame.changeSummary !== undefined)?.changeSummary ?? null;
  const blocks = remaining.flatMap(frame => frame.blocks);
  const active = isMostRecentTurn && live(turn.status);
  const latestObservation = [...blocks].reverse().find(block => block.type !== "todo");
  let assistantFrame: AssistantTimelineFrame | null = remaining.length || active || changeSummary !== null ? {
    type: "assistant", id: `${turn.turnId}:assistant-surface`, turnId: turn.turnId, status: turn.status,
    durationMs: seed?.durationMs ?? null, displayDurationMs: seed?.displayDurationMs ?? null, workStatus: seed?.workStatus ?? null, changeSummary,
    interruptedByThisClient: seed?.interruptedByThisClient ?? false, hookStats: seed?.hookStats ?? null,
    anchors: assistants.flatMap(frame => frame.anchors), blocks,
  } : null;
  const activeReasoningId = active && latestObservation?.type === "reasoning" && readReasoningContent(latestObservation) ? latestObservation.id : null;
  const finalReasoningPresenter: typeof presentReasoning = (block) => reasoningPresenter(block, block.id === activeReasoningId);
  let assistant = assistantFrame ? createAssistantTurnPresentationPlan(assistantFrame, registry, partitionOptions, finalReasoningPresenter) : null;
  let thinkingOwner: TimelineTurnThinkingOwner = { type: "none" };
  if (assistant && assistantFrame) {
    const last = assistant.slots.at(-1);
    let innerOwner: AgentActivityContentUnit | undefined;
    if (last?.type === "agent-activity" && last.segmentEnd === "open") innerOwner = [...last.contentUnits].reverse().find(unit => unit.type !== "worked-for");
    if (active && last?.type === "agent-activity" && innerOwner?.type === "reasoning" && latestObservation?.id === innerOwner.block.id) {
      thinkingOwner = { type: "reasoning", reasoningId: innerOwner.id };
    } else if (active && last?.type === "agent-activity" && innerOwner?.type === "group"
      && deriveAgentActivityHeaderPresentation(innerOwner, registry).state === "thinking") {
      thinkingOwner = { type: "activity", activityId: last.id, groupId: innerOwner.id };
    }
    const pendingInteraction = blocks.some(block => "state" in block && block.state === "pending");
    const lastBoundary = lastIndex(blocks, block => block.type === "user-message" || block.type === "realtime-transcript");
    const currentFrame = { ...assistantFrame, blocks: blocks.slice(lastBoundary + 1) };
    const planning = currentFrame.blocks.some(block => block.type === "plan" && !block.completed);
    if (active && thinkingOwner.type === "none" && !pendingInteraction
      && (shouldRenderAgentThinkingPlaceholder(currentFrame, registry) || (planning && !currentFrame.blocks.some(block => isToolActivityBlock(block) && running(block))))) {
      thinkingOwner = { type: "turn", placeholderId: `${turn.turnId}:slot:thinking-placeholder`, label: planning ? "Planning" : "Thinking" };
    }
    assistant = { ...assistant, slots: assistant.slots.map(slot => {
      if (slot.type !== "agent-activity") return slot;
      const contentUnits = slot.contentUnits.map(unit => {
        if (unit.type === "reasoning") {
          const owns = thinkingOwner.type === "reasoning" && thinkingOwner.reasoningId === unit.id;
          return { ...unit, active: owns };
        }
        return unit;
      });
      return { ...slot, contentUnits, partitions: partitionAgentActivityContentUnits(contentUnits, partitionOptions) };
    }) };
  }
  return { userFrames, assistantFrame, assistant, activeTodo: activeTimelineTurnTodo(turn, isMostRecentTurn), auxiliaryFrames: [], thinkingOwner,
    topLevelSlotCount: userFrames.length + (assistant?.slots.length ?? 0) + (assistant?.changeSummary ? 1 : 0) + (thinkingOwner.type === "turn" ? 1 : 0) };
}
