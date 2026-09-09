import type {
  AssistantTimelineFrame,
  EventTimelineFrame,
  InteractionTimelineFrame,
  SubagentTimelineBlock,
  TextTimelineBlock,
  TimelineBlock,
  TimelineStatus,
  UserTimelineFrame,
} from "./timeline";
import type { TimelineTurnView } from "./timeline-turns";
import type { WorkStatusItem } from "./work-status";
import type { ConversationDetailLevel } from "./conversation-presentation";
import { skillReadPresentation } from "./conversation-presentation";
import { summarizeAutomaticApprovalReviewAction } from "./automatic-approval-review";
import { parseSkillPath } from "./skill-path";
import {
  isToolActivityBlock,
  isSummaryOnlyToolActivityBlock,
  isToolActivityPresentationSuppressed,
  presentToolActivity,
  type ToolActivityIcon,
  type ToolActivityPresenterRegistry,
} from "./tool-activity";

export type AgentActivityPhase = "before-final-answer" | "after-final-answer";

export interface AgentActivitySummary {
  readonly commandCount: number;
  readonly patchCount: number;
  readonly reasoningCount: number;
  readonly subagentCount: number;
  readonly toolCount: number;
}

export interface AgentActivityHeaderPresentation {
  readonly state: "active" | "thinking" | "summary";
  /** Identity of the semantic state, deliberately independent from changing copy. */
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

export type AgentActivityHeaderSummary =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "parts"; readonly parts: readonly AgentActivitySummaryPart[] };

export interface AgentActivityGroupLifecycle {
  /** Only the last visible unit in an open slice may own a live header. */
  readonly isLatestVisibleUnit: boolean;
  /** A final answer or terminal Turn permanently closes the live slice. */
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
  /** Feature cohort: keep a rendered MCP App surface visible while collapsed. */
  readonly keepMcpAppEntriesPersistent?: boolean;
  /** Host capability: this renderer can actually mount MCP App resources. */
  readonly renderMcpApps?: boolean;
  /** Optional host lookup for MCP Apps discovered from server tool metadata. */
  readonly resolvesMcpAppSurface?: (block: Extract<TimelineBlock, { type: "tool-call" }>) => boolean;
}

export interface AgentActivityRenderUnit {
  readonly type: "agent-activity";
  readonly id: string;
  readonly blocks: readonly TimelineBlock[];
  /** Codex's inner projection: adjacent tools group, semantic messages stand alone. */
  readonly contentUnits: readonly AgentActivityContentUnit[];
  /** Subagent activity is one inline surface owned by the outer disclosure. */
  readonly inlineSubagentActivity: SubagentActivityRenderUnit | null;
  /** Source-equivalent ownership around the outer Worked-for disclosure. */
  readonly partitions: AgentActivityUnitPartitions;
  readonly collapsedItemCount: number;
  readonly phase: AgentActivityPhase;
  readonly status: TimelineStatus;
  readonly workedDurationMs: number | null;
  readonly hasFinalAssistantStarted: boolean;
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
}

export interface AgentActivityWorkStatusContentUnit {
  readonly type: "worked-for";
  readonly id: string;
  readonly item: WorkStatusItem;
}

export type AgentActivityContentUnit = AgentActivityGroupContentUnit | AgentActivityStandaloneContentUnit | AgentActivityWorkStatusContentUnit;

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
  /** Extracted metadata belongs to the toggle, never its expanded body. */
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

export type AssistantRenderUnit = AgentActivityRenderUnit | AssistantContentRenderUnit | SubagentActivityRenderUnit;

/**
 * Stable, renderer-neutral top-level slots for one assistant Turn.
 *
 * The recovered renderer builds this semantic plan before it creates DOM.
 * Item arrival may change slot contents, but it must never change slot
 * identity or move a live subtree between different owners.
 */
export interface AssistantTurnPresentationPlan {
  readonly slots: readonly AssistantRenderUnit[];
}

/**
 * The only renderer-neutral presentation authority for one AppServer Turn.
 *
 * Protocol projection may produce several assistant Frames as Items arrive or
 * cross semantic lanes. Those Frames are storage/provenance boundaries, not UI
 * ownership boundaries. Codex classifies the complete Turn once, then owns one
 * Activity disclosure, one final-answer surface, and at most one live Thinking
 * placeholder. Web and Native renderers must consume this plan instead of
 * independently deriving presentation from individual Frames.
 */
export interface TimelineTurnPresentationPlan {
  readonly userFrames: readonly UserTimelineFrame[];
  readonly assistantFrame: AssistantTimelineFrame | null;
  readonly assistant: AssistantTurnPresentationPlan | null;
  readonly auxiliaryFrames: readonly (EventTimelineFrame | InteractionTimelineFrame)[];
  readonly showThinking: boolean;
  readonly thinkingId: string;
  readonly thinkingLabel: "Thinking" | "Planning";
  readonly topLevelSlotCount: number;
}

export interface TimelineTurnPresentationOptions {
  /** Only the newest mounted Turn may own transient live chrome. */
  readonly isMostRecentTurn: boolean;
  readonly partitionOptions?: AgentActivityPartitionOptions;
}

export function isAgentActivityBlock(block: TimelineBlock): boolean {
  return block.type === "reasoning"
    || block.type === "command-execution"
    || block.type === "patch"
    || block.type === "tool-call"
    || block.type === "automatic-approval-review"
    || block.type === "auto-review-interruption-warning"
    || block.type === "subagent"
    || block.type === "realtime-transcript"
    || block.type === "compaction"
    || block.type === "todo"
    || (block.type === "image" && block.generated
      && (block.status === "pending" || block.status === "running"))
    || (block.type === "user-message" && (block.steeringStatus !== null || block.hookFeedback))
    || (block.type === "text" && block.phase === "commentary");
}

/** Codex classifies each activity Item before building the collapsible group. */
export function isGroupableAgentActivityBlock(
  block: TimelineBlock,
  registry?: ToolActivityPresenterRegistry,
): boolean {
  if (!isAgentActivityBlock(block)) return false;
  if (block.type === "subagent") return false;
  if (block.type === "auto-review-interruption-warning") return false;
  if (block.type === "automatic-approval-review") return block.review.status === "inProgress";
  if (block.type === "tool-call") return presentToolActivity(block, registry).grouping === "groupable";
  return true;
}

/** Exact dynamic-tool registry rule used to hide status polling from expanded Activity rows. */
export function isVisibleAgentActivityRow(
  block: TimelineBlock,
  registry?: ToolActivityPresenterRegistry,
  detailLevel: ConversationDetailLevel = "STEPS_COMMANDS",
): boolean {
  if (block.type === "command-execution" && skillReadPresentation(block, detailLevel)?.visible === false) return false;
  // Reasoning participates in the live Thinking state but Codex's Item
  // classifier returns null for it. It must never leak as a "Thought" row.
  if (block.type === "reasoning") return false;
  // AppServer may transiently expose an empty fileChange while a patch is
  // being assembled. Codex's display normalizer drops it unless it already
  // owns a visualization; this model has no visualization-only patch shape.
  if (block.type === "patch" && block.changes.length === 0) return false;
  // Codex keeps ordinary exploration retrospective: unfinished read/search/
  // list rows are absent until their Item finishes. Skill-definition reads
  // are a product presenter concern and may supply a separate external row.
  if (isHiddenRunningExploration(block)) return false;
  return !(block.type === "tool-call" && isToolActivityPresentationSuppressed(block, registry))
    && !isSummaryOnlyToolActivityBlock(block, registry);
}

type AgentActivityItemGrouping = "groupable" | "standalone" | "hidden";

function classifyAgentActivityItem(
  block: TimelineBlock,
  registry?: ToolActivityPresenterRegistry,
): AgentActivityItemGrouping {
  if (block.type === "reasoning") return "hidden";
  if (block.type === "patch" && block.changes.length === 0) return "hidden";
  if (block.type === "realtime-transcript") return "standalone";
  if (block.type === "compaction" || block.type === "image" || block.type === "todo") return "standalone";
  if (block.type === "text") return block.phase === "commentary" ? "standalone" : "hidden";
  if (block.type === "user-message") {
    return block.steeringStatus !== null || block.hookFeedback ? "standalone" : "hidden";
  }
  if (block.type === "automatic-approval-review") {
    if (block.review.status === "approved") return "hidden";
    return block.review.status === "inProgress" ? "groupable" : "standalone";
  }
  if (block.type === "auto-review-interruption-warning" || block.type === "subagent") return "standalone";
  if (block.type === "tool-call") {
    if (isToolActivityPresentationSuppressed(block, registry)) return "hidden";
    return presentToolActivity(block, registry).grouping;
  }
  if (block.type === "command-execution" || block.type === "patch") return "groupable";
  return "hidden";
}

function isRunningActivityItem(block: TimelineBlock, registry?: ToolActivityPresenterRegistry): boolean {
  return isActiveAgentActivityBlock(block, registry);
}

function shouldKeepSingleItemGroup(
  block: TimelineBlock,
  lifecycle: AgentActivityGroupLifecycle,
  registry?: ToolActivityPresenterRegistry,
): boolean {
  if (lifecycle.inProgress || isRunningActivityItem(block, registry)) return true;
  // Codex retains the grouped patch surface for multi-file changes; a
  // one-file completed patch is presented as one independent semantic row.
  return block.type === "patch" && block.changes.length !== 1;
}

/**
 * Source-equivalent inner Agent Activity splitter.
 *
 * The outer Turn disclosure owns "Worked for …". Inside it, reasoning is
 * hidden, commentary is standalone, and only consecutive groupable tool
 * Items share a summary. A completed single-item group is demoted to a plain
 * semantic row, which is why Codex does not show a redundant "Read files"
 * disclosure around one `Read SKILL.md` event.
 */
export function createAgentActivityContentUnits(
  blocks: readonly TimelineBlock[],
  status: TimelineStatus,
  registry?: ToolActivityPresenterRegistry,
  isActivitySliceClosed = status !== "pending" && status !== "streaming",
): readonly AgentActivityContentUnit[] {
  const preliminaryUnits: (Omit<AgentActivityGroupContentUnit, "lifecycle"> | AgentActivityStandaloneContentUnit)[] = [];
  let group: TimelineBlock[] = [];

  const flushGroup = () => {
    const first = group[0];
    if (first === undefined) return;
    preliminaryUnits.push({
      type: "group",
      // Codex r2440 derives the group key from its first semantic Item. A
      // streaming append must grow the existing group rather than remount
      // it, otherwise disclosure state, scroll position, and animation
      // ownership are all lost on every tool event.
      id: `agent-activity-group:${first.id}`,
      blocks: group,
    });
    group = [];
  };

  for (const block of blocks) {
    const grouping = classifyAgentActivityItem(block, registry);
    if (grouping === "hidden") continue;
    if (grouping === "groupable") {
      group.push(block);
      continue;
    }
    flushGroup();
    if (isVisibleAgentActivityRow(block, registry)) {
      preliminaryUnits.push({ type: "standalone", id: `agent-activity-standalone:${block.id}`, block });
    }
  }
  flushGroup();
  if (preliminaryUnits.length === 0 && (status === "pending" || status === "streaming")) {
    const liveReasoning = [...blocks].reverse().find((block) => block.type === "reasoning" && block.streaming);
    if (liveReasoning !== undefined) {
      preliminaryUnits.push({ type: "group", id: `agent-activity-group:${liveReasoning.id}`, blocks: [liveReasoning] });
    }
  }
  const lastVisibleIndex = preliminaryUnits.length - 1;
  return preliminaryUnits.reduce<AgentActivityContentUnit[]>((result, unit, index) => {
    if (unit.type === "standalone") {
      result.push(unit);
      return result;
    }
    const isLatestVisibleUnit = index === lastVisibleIndex;
    const isExploring = isTrailingExploration(unit.blocks);
    const inProgress = isLatestVisibleUnit
      && !isActivitySliceClosed
      && (status === "pending" || status === "streaming");
    const lifecycle = { isLatestVisibleUnit, isActivitySliceClosed, isExploring, inProgress };
    if (unit.blocks.length === 1 && !shouldKeepSingleItemGroup(unit.blocks[0]!, lifecycle, registry)) {
      const block = unit.blocks[0]!;
      if (isVisibleAgentActivityRow(block, registry)) {
        // r3562 je: demotion changes presentation, not the Unit's identity.
        result.push({ type: "standalone", id: unit.id, block });
      }
      return result;
    }
    result.push({
      ...unit,
      lifecycle,
    });
    return result;
  }, []);
}

function isRenderableMcpAppEntry(
  block: Extract<TimelineBlock, { type: "tool-call" }>,
  options: AgentActivityPartitionOptions,
): boolean {
  // r2440 mA: a settled call without a raw result cannot own an App surface,
  // even when transport metadata contains a resource URI.
  const completed = block.status !== "pending" && block.status !== "running";
  if (completed && block.output === null) return false;
  return block.appResourceUri !== null || options.resolvesMcpAppSurface?.(block) === true;
}

function isPersistentAgentActivityUnit(
  unit: AgentActivityContentUnit,
  options: AgentActivityPartitionOptions,
): boolean {
  if (unit.type !== "standalone") return false;
  const block = unit.block;
  if (block.type === "user-message") return block.steeringStatus !== null || block.hookFeedback;
  return options.keepMcpAppEntriesPersistent === true
    && options.renderMcpApps === true
    && block.type === "tool-call"
    && block.kind === "mcp"
    && isRenderableMcpAppEntry(block, options);
}

/** Codex's four ownership regions around the outer Activity toggle. */
export function partitionAgentActivityContentUnits(
  units: readonly AgentActivityContentUnit[],
  options: AgentActivityPartitionOptions = {},
): AgentActivityUnitPartitions {
  const persistentUnits: AgentActivityContentUnit[] = [];
  const collapsibleUnits: AgentActivityContentUnit[] = [];
  const expandedUnits: AgentActivityContentUnit[] = [];
  const preToggleUnits: AgentActivityContentUnit[] = [];
  let workedForItem: WorkStatusItem | null = null;
  for (const unit of units) {
    if (unit.type === "worked-for") {
      workedForItem = unit.item;
      continue;
    }
    if (unit.type === "standalone" && unit.block.type === "realtime-transcript") {
      // r2440 fA: the leading voice handoff introduces the Activity before
      // the toggle. A later transcript remains visible while collapsed and
      // also keeps its chronological slot in the expanded sequence.
      if (expandedUnits.length === 0) preToggleUnits.push(unit);
      else {
        expandedUnits.push(unit);
        persistentUnits.push(unit);
      }
      continue;
    }
    expandedUnits.push(unit);
    if (isPersistentAgentActivityUnit(unit, options)) persistentUnits.push(unit);
    else collapsibleUnits.push(unit);
  }
  return {
    workedForItem,
    collapsibleUnits,
    expandedUnits,
    persistentUnits,
    preToggleUnits,
  };
}

export function countAgentActivityContentItems(units: readonly AgentActivityContentUnit[]): number {
  return units.reduce((count, unit) => count + (unit.type === "group" ? unit.blocks.length : 1), 0);
}

function isHiddenRunningExploration(block: TimelineBlock): boolean {
  if (block.type !== "command-execution"
    || (block.status !== "pending" && block.status !== "running")
    || block.actions.length !== 1) return false;
  const action = block.actions[0];
  if (action?.type === "read") {
    return parseSkillPath(action.path || action.name, block.cwd)?.isSkillDefinitionFile !== true;
  }
  return action?.type === "search" || action?.type === "list-files";
}

function isTrailingExploration(blocks: readonly TimelineBlock[]): boolean {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.type === "reasoning") continue;
    return block?.type === "command-execution"
      && (block.status === "pending" || block.status === "running")
      && block.actions.some((action) => action.type === "read" || action.type === "search" || action.type === "list-files");
  }
  return false;
}

/**
 * Codex keeps a Turn visually live between selected app-control calls. The
 * rule is deliberately suffix-based: a non-dynamic Item ends the chain.
 */
export function hasContinuingLiveDynamicToolActivity(
  blocks: readonly TimelineBlock[],
  status: TimelineStatus,
  registry?: ToolActivityPresenterRegistry,
): boolean {
  if (status !== "pending" && status !== "streaming") return false;
  const suffix: Extract<TimelineBlock, { type: "tool-call" }>[] = [];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.type !== "tool-call" || block.kind !== "dynamic") break;
    suffix.unshift(block);
  }
  if (suffix.length === 0) return false;
  const physicalLast = suffix.at(-1);
  if (physicalLast === undefined || isToolActivityPresentationSuppressed(physicalLast, registry)) return false;
  const renderableSuffix = suffix.filter((block) => !isToolActivityPresentationSuppressed(block, registry));
  if (renderableSuffix.some((block) => block.status === "pending" || block.status === "running")) return true;
  const last = renderableSuffix.at(-1);
  return last !== undefined && presentToolActivity(last, registry).continuesLiveActivityBetweenCalls;
}

function isDisplayableAssistantText(block: TimelineBlock): block is TextTimelineBlock {
  return block.type === "text"
    && (block.text.trim().length > 0 || block.completed === true || block.hasStructuredOutput === true)
    && block.phase !== "commentary";
}

function isFinalAssistantText(block: TimelineBlock): block is TextTimelineBlock {
  // r3562 hasDisplayableContent / isFinalAnswerPhase are separate predicates.
  // Rendering unphased text does not give it authority to close work.
  return isDisplayableAssistantText(block) && block.phase === "final_answer";
}

function summarize(blocks: readonly TimelineBlock[]): AgentActivitySummary {
  return blocks.reduce<AgentActivitySummary>((summary, block) => ({
    commandCount: summary.commandCount + (block.type === "command-execution" ? 1 : 0),
    patchCount: summary.patchCount + (block.type === "patch" ? 1 : 0),
    reasoningCount: summary.reasoningCount + (block.type === "reasoning" ? 1 : 0),
    subagentCount: summary.subagentCount + (block.type === "subagent" ? 1 : 0),
    toolCount: summary.toolCount + (block.type === "tool-call" ? 1 : 0),
  }), {
    commandCount: 0,
    patchCount: 0,
    reasoningCount: 0,
    subagentCount: 0,
    toolCount: 0,
  });
}

function isActiveAgentActivityBlock(
  block: TimelineBlock,
  registry?: ToolActivityPresenterRegistry,
): boolean {
  switch (block.type) {
    case "compaction": return !block.completed;
    case "text": return block.streaming;
    case "reasoning": return block.streaming;
    case "command-execution":
      return block.status === "pending" || block.status === "running";
    case "patch":
    case "subagent":
      return block.status === "pending" || block.status === "running";
    case "tool-call":
      return !isToolActivityPresentationSuppressed(block, registry)
        && (block.status === "pending" || block.status === "running");
    case "automatic-approval-review": return block.review.status === "inProgress";
    case "image": return block.status === "pending" || block.status === "running";
    default:
      return false;
  }
}

function lowerInitial(value: string): string {
  return value.length === 0 ? value : value[0].toLocaleLowerCase() + value.slice(1);
}

export function agentActivityHeaderAccessibleLabel(summary: AgentActivityHeaderSummary): string {
  if (summary.kind === "text") return summary.text;
  if (summary.parts.length === 0) return "Worked";
  if (summary.parts.length === 1) return summary.parts[0]!.text;
  const labels = [summary.parts[0]!.text, ...summary.parts.slice(1).map((part) => lowerInitial(part.text))];
  return new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(labels);
}

function textHeader(
  state: "active" | "thinking",
  summaryKey: string,
  text: string,
  icon: ToolActivityIcon | null,
): AgentActivityHeaderPresentation {
  return { state, summaryKey, icon, summary: { kind: "text", text }, active: true };
}

function activePresentation(
  block: TimelineBlock,
  registry?: ToolActivityPresenterRegistry,
  detailLevel: ConversationDetailLevel = "STEPS_COMMANDS",
): AgentActivityHeaderPresentation {
  if (block.type === "reasoning") {
    return textHeader("thinking", "thinking", block.summary || "Thinking", null);
  }
  if (block.type === "text") {
    return textHeader("thinking", "thinking", "Thinking", null);
  }
  if (block.type === "patch") {
    return textHeader("active", `active:${block.id}`, "Editing files", "patch");
  }
  if (block.type === "automatic-approval-review") {
    return textHeader("thinking", "thinking", summarizeAutomaticApprovalReviewAction(block.review.action), null);
  }
  if (isToolActivityBlock(block)) {
    const presentation = presentToolActivity(block, registry);
    if (block.type === "command-execution"
      && !block.actions.some((action) => action.type === "read" || action.type === "search" || action.type === "list-files")) {
      return textHeader("active", `active:${block.id}`, detailLevel === "STEPS_PROSE" ? "Running command" : `Running ${block.command.trim() || "command"}`, presentation.icon);
    }
    const text = presentation.detail === null
      ? presentation.summary
      : `${presentation.summary} ${presentation.detail}`;
    return textHeader("active", `active:${block.id}`, text, presentation.icon);
  }
  return textHeader("thinking", "thinking", "Thinking", null);
}

/**
 * Renderer-neutral reconstruction of Codex's inner Activity summary. It is
 * deliberately semantic: renderer code never guesses from raw tool names.
 */
export function deriveAgentActivityHeaderPresentation(
  unit: Pick<AgentActivityGroupContentUnit, "blocks" | "lifecycle">,
  registry?: ToolActivityPresenterRegistry,
  detailLevel: ConversationDetailLevel = "STEPS_COMMANDS",
): AgentActivityHeaderPresentation {
  const { blocks, lifecycle } = unit;
  if (lifecycle.isLatestVisibleUnit && lifecycle.inProgress && !lifecycle.isActivitySliceClosed) {
    if (lifecycle.isExploring) {
      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index];
        if (block?.type === "command-execution"
          && block.actions.some((action) => action.type === "read" || action.type === "search" || action.type === "list-files")) {
          return activePresentation(block, registry, detailLevel);
        }
      }
    }
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (isActiveAgentActivityBlock(block, registry)) return activePresentation(block, registry, detailLevel);
    }
    return textHeader("thinking", "thinking", "Thinking", null);
  }

  const mcpSources = new Map<string, AgentActivitySummarySource>();
  const dynamicSummaries = new Map<string, { readonly text: string; readonly icon: ToolActivityIcon }>();
  const changedFiles = new Set<string>();
  let unnamedMcpCalls = 0;
  let stoppedCreates = 0;
  let explorationCount = 0;
  let commandCount = 0;
  let webSearchCount = 0;
  let imageViewCount = 0;

  for (const block of blocks) {
    if (block.type === "patch") {
      for (const change of block.changes) {
        if (block.status !== "failed") changedFiles.add(change.movePath ?? change.path);
        if (block.status === "interrupted" && change.kind === "add") stoppedCreates += 1;
      }
      continue;
    }
    if (block.type === "command-execution") {
      const isExploration = block.actions.some((action) => action.type === "read"
        || action.type === "list-files"
        || action.type === "search");
      if (isExploration) explorationCount += 1;
      else commandCount += 1;
      continue;
    }
    if (block.type !== "tool-call") continue;
    if (isToolActivityPresentationSuppressed(block, registry)) continue;
    const presentation = presentToolActivity(block, registry);
    if (block.kind === "web-search") {
      webSearchCount += 1;
    } else if (block.activityPresentation?.operation === "read" || block.activityPresentation?.operation === "search") {
      explorationCount += 1;
    } else if (block.kind === "image-view") {
      imageViewCount += 1;
    } else if (block.kind === "mcp") {
      if (block.server === "node_repl" && (block.sourceKind === undefined || block.sourceKind === null)) {
        commandCount += 1;
      } else if (block.server === null || block.server.trim().length === 0) {
        unnamedMcpCalls += 1;
      } else if (block.sourceKind === "browserUse") {
        const chrome = block.sourceBackend === "chrome";
        mcpSources.set(chrome ? "browser-use:chrome" : "browser-use", {
          key: chrome ? "browser-use:chrome" : "browser-use",
          name: chrome ? "Chrome" : "the browser",
          kind: "browser",
          isIntegration: chrome,
        });
      } else {
        const sourceAppName = block.sourceApp?.kind === "displayName"
          ? block.sourceApp.displayName.trim()
          : null;
        const sourceName = block.appName?.trim()
          || sourceAppName
          || block.server.split(/[_-]+/gu).filter(Boolean).map((part, index) => {
            const lower = part.toLocaleLowerCase();
            if (lower === "github") return "GitHub";
            if (lower === "openai") return "OpenAI";
            return lower.length === 0 ? lower : lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
          }).join(" ");
        const sourceKey = block.appName
          ? `app:${block.appName}`
          : sourceAppName
            ? `native-app:${sourceAppName}`
            : `server:${block.server}`;
        mcpSources.set(sourceKey, { key: sourceKey, name: sourceName, kind: "integration", isIntegration: true });
      }
    } else if (block.kind === "dynamic") {
      dynamicSummaries.set(presentation.summaryKey, { text: presentation.summary, icon: presentation.icon });
    } else {
      // All currently known non-MCP tool kinds are handled above.
    }
  }

  const parts: AgentActivitySummaryPart[] = [];
  if (mcpSources.size > 0) {
    const sources = [...mcpSources.values()];
    const sourceNames = new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(sources.map(({ name }) => name));
    const integration = sources.every(({ isIntegration }) => isIntegration);
    parts.push({
      key: `sources:${sources.map(({ key }) => key).join("|")}`,
      kind: "sources",
      text: integration ? `Used ${sourceNames} ${sources.length === 1 ? "integration" : "integrations"}` : `Used ${sourceNames}`,
      icon: sources[0]?.kind === "browser" ? "browser" : "wrench",
      sources,
    });
  }
  if (unnamedMcpCalls > 0) parts.push({ key: "tools", kind: "tool", text: unnamedMcpCalls === 1 ? "Called a tool" : "Called tools", icon: "wrench", sources: [] });
  if (changedFiles.size > 0) parts.push({ key: "files", kind: "files", text: changedFiles.size === 1 ? "Edited a file" : "Edited files", icon: "patch", sources: [] });
  if (stoppedCreates > 0) parts.push({ key: "stopped-files", kind: "files", text: stoppedCreates === 1 ? "Stopped creating a file" : "Stopped creating files", icon: "stop", sources: [] });
  if (explorationCount > 0) parts.push({ key: "exploration", kind: "exploration", text: "Read files", icon: "read", sources: [] });
  if (commandCount > 0) parts.push({ key: "commands", kind: "commands", text: commandCount === 1 ? "Ran a command" : "Ran commands", icon: "terminal", sources: [] });
  if (webSearchCount > 0) parts.push({ key: "web-search", kind: "web-search", text: "Searched the web", icon: "browser", sources: [] });
  if (imageViewCount > 0) parts.push({ key: "images", kind: "images", text: imageViewCount === 1 ? "Viewed an image" : `Viewed ${imageViewCount} images`, icon: "image", sources: [] });
  for (const [key, dynamic] of dynamicSummaries) {
    parts.push({ key: `dynamic:${key}`, kind: "dynamic", text: dynamic.text, icon: dynamic.icon, sources: [] });
  }

  return {
    state: "summary",
    summaryKey: "summary",
    icon: parts[0]?.icon ?? null,
    summary: { kind: "parts", parts },
    active: false,
  };
}

function isPendingNonActivityBlock(block: TimelineBlock): boolean {
  if (block.type === "approval"
    || block.type === "question"
    || block.type === "option-picker"
    || block.type === "setup-codex-step"
    || block.type === "setup-context-picker"
    || block.type === "elicitation") {
    return block.state === "pending";
  }
  if (block.type === "image") return block.status === "pending" || block.status === "running";
  if (block.type === "plan") return !block.completed;
  return false;
}

/**
 * Renderer-neutral form of Codex's trailing Thinking placeholder decision.
 * Completed list/read calls can deliberately bridge the gap to the next call;
 * ordinary completed tools show a separate Thinking row while the Turn lives.
 */
export function shouldRenderAgentThinkingPlaceholder(
  frame: AssistantTimelineFrame,
  registry?: ToolActivityPresenterRegistry,
): boolean {
  if (frame.status !== "pending" && frame.status !== "streaming") return false;
  if (frame.blocks.some(isDisplayableAssistantText)) return false;
  if (frame.blocks.some((block) => isActiveAgentActivityBlock(block, registry))) return false;
  if (frame.blocks.some(isPendingNonActivityBlock)) return false;
  // Todo records are immutable observations. Only a trailing observation can
  // describe current work; an earlier unfinished snapshot cannot stay active
  // after a newer update or another Item has taken over.
  const trailing = frame.blocks.filter(isAgentActivityBlock).at(-1);
  if (trailing?.type === "todo" && trailing.entries.some((entry) => entry.status !== "complete")) return false;
  return !hasContinuingLiveDynamicToolActivity(frame.blocks, frame.status, registry);
}

/** Renderer-neutral Turn-level disclosure reducer, audited against Codex r2440. */
export function resolveAgentActivityDisclosure({
  forceExpanded = false,
  hasFinalAssistantStarted,
  hasRenderableAgentItems,
  isTurnCancelled,
  persistedCollapsed,
  preventAutoCollapse = false,
}: AgentActivityDisclosureInput): AgentActivityDisclosureState {
  if (!hasFinalAssistantStarted || isTurnCancelled || !hasRenderableAgentItems) {
    return { shouldAllowCollapse: false, isCollapsed: false };
  }
  return {
    shouldAllowCollapse: true,
    isCollapsed: !forceExpanded && (persistedCollapsed ?? !preventAutoCollapse),
  };
}

/**
 * Renderer-neutral reconstruction of Codex's Turn entry ordering.
 *
 * All renderable agent work before the final assistant message belongs to one
 * Turn-level Agent Activity unit. Whether an individual Item is grouped or
 * standalone is an inner projection concern handled by
 * `createAgentActivityContentUnits`; it must not split the outer disclosure.
 * Work emitted after the final answer remains in order but is not
 * auto-collapsed, matching Codex's post-assistant activity slice.
 */
export function createAssistantTurnPresentationPlan(
  frame: AssistantTimelineFrame,
  registry?: ToolActivityPresenterRegistry,
  partitionOptions: AgentActivityPartitionOptions = {},
): AssistantTurnPresentationPlan {
  const slots: AssistantRenderUnit[] = [];
  const beforeFinalActivity: TimelineBlock[] = [];
  const afterFinalActivity: TimelineBlock[] = [];
  const inlineSubagentBlocks: SubagentTimelineBlock[] = [];
  const postAssistantSubagentBlocks: SubagentTimelineBlock[] = [];
  const automationBlocks: TimelineBlock[] = [];
  const assistantContentBlocks: TimelineBlock[] = [];
  let proposedPlan: Extract<TimelineBlock, { type: "plan" }> | null = null;
  const hasFinalAssistantStarted = frame.blocks.some(isFinalAssistantText);
  let passedFinalAssistant = false;

  const createActivitySlot = (
    blocks: readonly TimelineBlock[],
    phase: AgentActivityPhase,
    subagentBlocks: readonly SubagentTimelineBlock[],
  ): AgentActivityRenderUnit | null => {
    const isActivitySliceClosed = frame.status !== "pending" && frame.status !== "streaming"
      || (phase === "before-final-answer" && hasFinalAssistantStarted);
    const contentUnits = [...createAgentActivityContentUnits(blocks, frame.status, registry, isActivitySliceClosed)];
    const workStatus = phase !== "before-final-answer" ? null
      : frame.status === "interrupted" && frame.interruptedByThisClient && frame.durationMs !== null
        ? { type: "worked-for" as const, status: "stopped" as const, startedAtMs: 0, completedAtMs: frame.durationMs }
        : frame.workStatus ?? null;
    if (workStatus !== null) {
      const workUnit: AgentActivityWorkStatusContentUnit = { type: "worked-for", id: `${frame.turnId}:worked-for`, item: workStatus };
      // The live divider precedes work; a settled Turn places it immediately
      // before the answer. Partitioning later extracts it for the disclosure.
      // Locate the boundary before filtering hidden rows. Hidden reasoning
      // before a transcript still starts work before that transcript.
      const firstWorkBlockIndex = blocks.findIndex((block) =>
        block.type !== "realtime-transcript" && block.type !== "user-message");
      const firstWorkIndex = firstWorkBlockIndex < 0 ? -1 : contentUnits.findIndex((unit) => {
        const unitBlocks = unit.type === "group" ? unit.blocks : unit.type === "standalone" ? [unit.block] : [];
        return unitBlocks.some((block) => blocks.indexOf(block) >= firstWorkBlockIndex);
      });
      const insertionIndex = frame.status === "streaming" || frame.status === "pending"
        ? firstWorkIndex < 0 ? contentUnits.length : firstWorkIndex : contentUnits.length;
      contentUnits.splice(insertionIndex, 0, workUnit);
    }
    if (contentUnits.length === 0 && subagentBlocks.length === 0) return null;
    const partitions = partitionAgentActivityContentUnits(contentUnits, partitionOptions);
    const inlineSubagentActivity = subagentBlocks.length === 0 ? null : {
      type: "subagent-activity" as const,
      id: `${frame.turnId}:slot:${phase === "before-final-answer" ? "inline-subagent-activity" : "post-assistant-subagent-activity"}`,
      blocks: subagentBlocks,
    };
    return {
      type: "agent-activity",
      id: `${frame.turnId}:slot:${phase === "before-final-answer" ? "agent-activity" : "post-assistant-activity"}`,
      blocks,
      contentUnits,
      inlineSubagentActivity,
      partitions,
      collapsedItemCount: countAgentActivityContentItems(partitions.collapsibleUnits)
        + (inlineSubagentActivity === null ? 0 : 1),
      phase,
      status: frame.status,
      workedDurationMs: phase === "before-final-answer" ? frame.durationMs : null,
      hasFinalAssistantStarted,
      // Partitioning is a disclosure-only projection. When the Turn cannot
      // collapse, Codex renders the original Unit stream, including a leading
      // realtime transcript that intentionally does not appear in expandedUnits.
      hasRenderableAgentItems: contentUnits.length > 0 || inlineSubagentActivity !== null,
      isTurnCancelled: frame.status === "interrupted",
      forceExpanded: false,
      disableCollapse: phase === "after-final-answer",
      preventAutoCollapse: blocks.some((block) => isActiveAgentActivityBlock(block, registry))
        || subagentBlocks.some((block) => block.status === "pending" || block.status === "running"),
      summary: {
        ...summarize(blocks),
        subagentCount: subagentBlocks.length,
      },
    };
  };

  for (const block of frame.blocks) {
    // Original Turn classifier extracts the latest proposal into its own slot;
    // implementation records remain facts and never become a second card.
    if (block.type === "plan-implementation") continue;
    if (block.type === "plan") { proposedPlan = block; continue; }
    // Registered dynamic renderers may intentionally reject malformed tool
    // arguments. Codex does not leak those calls through its generic row.
    if (block.type === "tool-call" && isToolActivityPresentationSuppressed(block, registry)) continue;
    // Running exploration remains in the semantic slice so it can own the
    // live header. Its body row is filtered independently until completion.
    // r1381 keeps clock sleep in the protocol record but deliberately omits it from local conversation UI.
    if (block.type === "tool-call" && block.kind === "dynamic" && block.namespace === "clock" && block.name === "sleep") {
      continue;
    }
    // The recovered classifier drops empty Web Search items instead of
    // rendering either a group row or a standalone fallback.
    if (block.type === "tool-call" && block.kind === "web-search") {
      const input = typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)
        ? block.input as Readonly<Record<string, unknown>>
        : null;
      if (typeof input?.query !== "string" || input.query.trim().length === 0) continue;
    }
    // Approved automatic reviews remain attached protocol facts but the
    // Codex item classifier returns null, so they cannot split Activity.
    if (block.type === "automatic-approval-review" && block.review.status === "approved") continue;
    if (block.type === "subagent") {
      (passedFinalAssistant ? postAssistantSubagentBlocks : inlineSubagentBlocks).push(block);
      continue;
    }
    if (isAgentActivityBlock(block)) {
      (passedFinalAssistant ? afterFinalActivity : beforeFinalActivity).push(block);
      continue;
    }
    if (block.type === "automation-update") automationBlocks.push(block);
    else assistantContentBlocks.push(block);
    if (isDisplayableAssistantText(block)) passedFinalAssistant = true;
  }

  const before = createActivitySlot(beforeFinalActivity, "before-final-answer", inlineSubagentBlocks);
  if (before !== null) slots.push(before);
  for (const block of automationBlocks) {
    slots.push({ type: "assistant-content", id: `${frame.turnId}:slot:automation:${block.id}`, block });
  }
  for (const block of assistantContentBlocks) {
    slots.push({ type: "assistant-content", id: `${frame.turnId}:slot:assistant-content:${block.id}`, block });
  }
  const after = createActivitySlot(afterFinalActivity, "after-final-answer", postAssistantSubagentBlocks);
  if (after !== null) slots.push(after);
  if (proposedPlan !== null) slots.push({ type: "assistant-content", id: `${frame.turnId}:slot:proposed-plan`, block: proposedPlan });
  return { slots };
}

/**
 * Classify a complete Turn into stable renderer surfaces.
 *
 * This is intentionally a lossy UI projection: all assistant provenance Frames
 * are folded into one stable assistant surface. The original Frames remain in
 * the TimelineSnapshot for navigation and diagnostics, while presentation gets
 * exactly one owner for Activity, final-answer actions, and live Thinking.
 */
export function createTimelineTurnPresentationPlan(
  turn: TimelineTurnView,
  registry?: ToolActivityPresenterRegistry,
  {
    isMostRecentTurn,
    partitionOptions = {},
  }: TimelineTurnPresentationOptions = { isMostRecentTurn: false },
): TimelineTurnPresentationPlan {
  const userFrames: UserTimelineFrame[] = [];
  const assistantFrames: AssistantTimelineFrame[] = [];
  const auxiliaryFrames: (EventTimelineFrame | InteractionTimelineFrame)[] = [];

  for (const frame of turn.frames) {
    if (frame.type === "user") userFrames.push(frame);
    else if (frame.type === "assistant") assistantFrames.push(frame);
    else auxiliaryFrames.push(frame);
  }

  const turnIsActive = turn.status === "pending" || turn.status === "streaming";
  const materializeAssistantSurface = assistantFrames.length > 0
    || (isMostRecentTurn && turnIsActive);
  const assistantFrame: AssistantTimelineFrame | null = materializeAssistantSurface
    ? {
        type: "assistant",
        id: `${turn.turnKey}:assistant-surface`,
        turnId: turn.turnId,
        status: turn.status,
        durationMs: [...assistantFrames].reverse().find((frame) => frame.durationMs !== null)?.durationMs ?? null,
        workStatus: assistantFrames.find((frame) => frame.workStatus != null)?.workStatus ?? null,
        interruptedByThisClient: turn.frames.some((frame) => frame.interruptedByThisClient),
        hookStats: [...assistantFrames].reverse().find((frame) => frame.hookStats !== null)?.hookStats ?? null,
        anchors: assistantFrames.flatMap((frame) => frame.anchors),
        blocks: assistantFrames.flatMap((frame) => frame.blocks),
      }
    : null;
  const assistant = assistantFrame === null
    ? null
    : createAssistantTurnPresentationPlan(assistantFrame, registry, partitionOptions);
  const hasPendingInteraction = auxiliaryFrames.some((frame) =>
    frame.type === "interaction" && frame.blocks.some(isPendingNonActivityBlock));
  const latestProposal = assistantFrame?.blocks.filter((block) => block.type === "plan").at(-1);
  const isPlanning = turnIsActive && latestProposal?.type === "plan" && !latestProposal.completed
    && !assistantFrame?.blocks.some((block) => block.type === "command-execution"
      && block.actions.some((action) => action.type === "read" || action.type === "search" || action.type === "list-files")
      && isActiveAgentActivityBlock(block, registry));
  const showThinking = isMostRecentTurn
    && assistantFrame !== null
    && (isPlanning || (!hasPendingInteraction && shouldRenderAgentThinkingPlaceholder(assistantFrame, registry)));
  const topLevelSlotCount = userFrames.reduce(
    (count, frame) => count + (frame.blocks.length > 0 ? 1 : 0),
    0,
  ) + (assistant?.slots.length ?? 0)
    + (showThinking ? 1 : 0)
    + auxiliaryFrames.reduce((count, frame) => count + frame.blocks.length, 0);

  return {
    userFrames,
    assistantFrame,
    assistant,
    auxiliaryFrames,
    showThinking,
    thinkingId: `${turn.turnKey}:slot:thinking-placeholder`,
    thinkingLabel: isPlanning ? "Planning" : "Thinking",
    topLevelSlotCount,
  };
}

export function shouldAllowAgentActivityCollapse(unit: AgentActivityRenderUnit): boolean {
  return resolveAgentActivityLayout(unit, false).showToggle;
}

/** Pure reconstruction of r3562 DA's final node-ownership calculation. */
export function resolveAgentActivityLayout(
  unit: AgentActivityRenderUnit,
  persistedCollapsed: boolean | undefined,
): AgentActivityLayout {
  // r3562 DA: preserve raw user intent through partitioning. The effective
  // visibility of the toggle/body is an OUTPUT, never fed back as a choice.
  const disclosure = resolveAgentActivityDisclosure({ ...unit, persistedCollapsed });
  const partitioned = !unit.forceExpanded && disclosure.shouldAllowCollapse;
  let visibleUnits = partitioned
    ? disclosure.isCollapsed ? unit.partitions.collapsibleUnits : unit.partitions.expandedUnits
    : unit.contentUnits;
  const persistentUnits = partitioned && disclosure.isCollapsed
    ? unit.partitions.persistentUnits
    : [];
  const preToggleUnits = partitioned ? unit.partitions.preToggleUnits : [];
  const countUnits = partitioned ? unit.partitions.collapsibleUnits : visibleUnits;
  const collapsedItemCount = countAgentActivityContentItems(countUnits)
    + (unit.inlineSubagentActivity === null ? 0 : 1);
  const isCompactionOnly = countUnits.length === 1
    && unit.inlineSubagentActivity === null
    && countUnits[0]?.type === "standalone"
    && countUnits[0].block.type === "compaction";
  const showToggle = !unit.disableCollapse
    && disclosure.shouldAllowCollapse
    && (visibleUnits.length > 0 || unit.inlineSubagentActivity !== null)
    && collapsedItemCount > 0;
  const effectiveShowToggle = showToggle && !isCompactionOnly;

  // A transcript-only or steering-only slice intentionally remains in its
  // special region. Fall back only when every ownership region is empty.
  if (!effectiveShowToggle
    && visibleUnits.length === 0
    && persistentUnits.length === 0
    && preToggleUnits.length === 0) {
    visibleUnits = unit.contentUnits;
  }

  return {
    showToggle: effectiveShowToggle,
    workedForItem: partitioned ? unit.partitions.workedForItem : null,
    isCollapsed: effectiveShowToggle && disclosure.isCollapsed,
    preToggleUnits,
    persistentUnits,
    visibleUnits,
    collapsedItemCount,
    showInlineSubagentActivity: unit.inlineSubagentActivity !== null,
  };
}
