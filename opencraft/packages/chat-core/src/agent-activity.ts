import type {
  AssistantTimelineFrame,
  EventTimelineFrame,
  InteractionTimelineFrame,
  ReasoningTimelineBlock,
  SubagentTimelineBlock,
  TextTimelineBlock,
  TodoTimelineBlock,
  TimelineBlock,
  TimelineStatus,
  UserTimelineFrame,
} from "./timeline";
import type { TimelineTurnView } from "./timeline-turns";
import type { WorkStatusItem } from "./work-status";
import type { ConversationDetailLevel } from "./conversation-presentation";
import { isAssistantAnswerContent, skillReadPresentation } from "./conversation-presentation";
import { summarizeAutomaticApprovalReviewAction } from "./automatic-approval-review";
import { parseSkillPath } from "./skill-path";
import { presentReasoning, type ReasoningContentPresentation } from "./reasoning";
import {
  isToolActivityBlock,
  isSummaryOnlyToolActivityBlock,
  isToolActivityPresentationSuppressed,
  presentToolActivity,
  type ToolActivityIcon,
  type ToolActivityPresenterRegistry,
} from "./tool-activity";

export type AgentActivityPhase = "before-final-answer" | "after-final-answer";

/** Why a chronological slice ended; never a grant to collapse its content. */
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
  /** A content/input boundary or terminal Turn closes the live slice, not the disclosure. */
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
  /** A qualifying answer terminating this slice, never a Turn-wide historical flag. */
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

/** An independent inner disclosure within the response work container. */
export interface ReasoningRenderUnit {
  readonly type: "reasoning";
  readonly id: string;
  readonly block: ReasoningTimelineBlock;
  readonly presentation: ReasoningContentPresentation;
  /** Only one current-response surface may own live Thinking feedback. */
  readonly active: boolean;
}

export type AssistantRenderUnit = AgentActivityRenderUnit | AssistantContentRenderUnit | SubagentActivityRenderUnit | ReasoningRenderUnit;

/**
 * Stable, renderer-neutral top-level slots for one assistant Turn.
 *
 * The recovered renderer builds this semantic plan before it creates DOM.
 * Item arrival may change slot contents, but it must never change slot
 * identity or move a live subtree between different owners.
 */
export interface AssistantTurnPresentationPlan {
  readonly slots: readonly AssistantRenderUnit[];
  /** Fixed Turn resource surface; not a response/disclosure/Thinking owner. */
  readonly changeSummary: Extract<TimelineBlock, { type: "turn-diff" }> | null;
}

export type TimelineTurnThinkingOwner =
  | { readonly type: "none" }
  | {
      readonly type: "reasoning";
      readonly reasoningId: string;
    }
  | {
      readonly type: "activity";
      readonly activityId: string;
      readonly groupId: string;
    }
  | {
      readonly type: "turn";
      readonly placeholderId: string;
      readonly label: "Thinking" | "Planning";
    };

/**
 * The only renderer-neutral presentation authority for one AppServer Turn.
 *
 * Protocol projection may produce several assistant Frames as Items arrive or
 * cross semantic lanes. Those Frames are storage/provenance boundaries, not UI
 * ownership boundaries. A Turn has one execution owner but can contain several
 * ordered Activity disclosures and responses, with at most one live Thinking
 * placeholder. Web and Native renderers must consume this plan instead of
 * independently deriving presentation from individual Frames.
 */
export interface TimelineTurnPresentationPlan {
  readonly userFrames: readonly UserTimelineFrame[];
  readonly assistantFrame: AssistantTimelineFrame | null;
  readonly assistant: AssistantTurnPresentationPlan | null;
  /** Latest live todo snapshot, projected outside transcript/virtual rows. */
  readonly activeTodo: TodoTimelineBlock | null;
  readonly auxiliaryFrames: readonly (EventTimelineFrame | InteractionTimelineFrame)[];
  /** Turn-parent arbitration: one discriminated owner, with no parallel visibility flag. */
  readonly thinkingOwner: TimelineTurnThinkingOwner;
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
    || (block.type === "text" && block.phase === "commentary" && block.delivery !== "async" && (block.asyncQuestions?.length ?? 0) === 0);
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
  // Reasoning has an independent disclosure, not a tool-work body row.
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
 * The outer response disclosure owns "Worked for …". Returned reasoning is
 * an independent inner disclosure, commentary is standalone, and consecutive tool
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
  const preliminaryUnits: (Omit<AgentActivityGroupContentUnit, "lifecycle"> | AgentActivityStandaloneContentUnit | ReasoningRenderUnit)[] = [];
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
    if (block.type === "reasoning") {
      const presentation = presentReasoning(block, false);
      if (presentation !== null) {
        flushGroup();
        preliminaryUnits.push({ type: "reasoning", id: block.id, block, presentation, active: false });
      }
      continue;
    }
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
  const lastVisibleIndex = preliminaryUnits.length - 1;
  return preliminaryUnits.reduce<AgentActivityContentUnit[]>((result, unit, index) => {
    if (unit.type !== "group") {
      result.push(unit);
      return result;
    }
    const isLatestVisibleUnit = index === lastVisibleIndex;
    const isExploring = isTrailingExploration(unit.blocks);
    // Codex's group display reducer does not infer liveness from the group's
    // Items. The latest visible group owns the open Activity slice for as long
    // as the Turn is live; if it has no active Item, its header becomes the
    // Activity-local Thinking fallback. The Turn parent arbitrates that
    // fallback against the outer placeholder later.
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
  // A qualifying answer is never hidden by an outer task disclosure, even
  // when a caller supplies it through the inner Unit projection.
  if (isFinalAssistantText(block)) return true;
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

function isFinalAssistantText(block: TimelineBlock): boolean {
  // r3562 hasDisplayableContent / isFinalAnswerPhase are separate predicates.
  // Rendering unphased text does not give it authority to close work.
  return isDisplayableAssistantText(block) && isAssistantAnswerContent(block) && block.phase === "final_answer";
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

/** Deterministic English conjunction formatting for Web and Hermes runtimes. */
function formatConjunctionList(values: readonly string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0]!;
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

export function agentActivityHeaderAccessibleLabel(summary: AgentActivityHeaderSummary): string {
  if (summary.kind === "text") return summary.text;
  if (summary.parts.length === 0) return "Worked";
  if (summary.parts.length === 1) return summary.parts[0]!.text;
  const labels = [summary.parts[0]!.text, ...summary.parts.slice(1).map((part) => lowerInitial(part.text))];
  return formatConjunctionList(labels);
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
    const sourceNames = formatConjunctionList(sources.map(({ name }) => name));
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

/** Only the suffix after the latest input/response can describe current work. */
function currentResponseBlocks(blocks: readonly TimelineBlock[]): readonly TimelineBlock[] {
  let boundary = -1;
  blocks.forEach((block, index) => {
    if (block.type === "user-message" || (block.type === "text" && (isAssistantAnswerContent(block)
      || block.delivery === "async" || (block.asyncQuestions?.length ?? 0) > 0))) boundary = index;
  });
  if (boundary < 0) return blocks;
  const block = blocks[boundary]!;
  // A live answer (or unanswered question) at the tail owns its own surface.
  return block.type === "text" && boundary === blocks.length - 1
    ? blocks.slice(boundary) : blocks.slice(boundary + 1);
}

/**
 * Renderer-neutral form of Codex's trailing Thinking placeholder decision.
 * Completed list/read calls can deliberately bridge the gap to the next call.
 * This function returns the Turn-level candidate only; the Turn parent still
 * gives a live Activity group first refusal before mounting that candidate.
 */
export function shouldRenderAgentThinkingPlaceholder(
  frame: AssistantTimelineFrame,
  registry?: ToolActivityPresenterRegistry,
): boolean {
  if (frame.status !== "pending" && frame.status !== "streaming") return false;
  frame = { ...frame, blocks: currentResponseBlocks(frame.blocks) };
  if (frame.blocks.some(isDisplayableAssistantText)) return false;
  if (frame.blocks.some((block) => block.type === "text"
    && (block.delivery === "async" || (block.asyncQuestions?.length ?? 0) > 0))) return false;
  if (frame.blocks.some(isPendingNonActivityBlock)) return false;
  // A new reasoning Item starts the next phase even before its first text
  // delta. Empty reasoning cannot create a disclosure, so the Turn retains
  // its ordinary placeholder until actual returned content arrives.
  const latestSemanticBlock = frame.blocks.filter((block) => block.type !== "todo").at(-1);
  if (latestSemanticBlock?.type === "reasoning") return true;
  // This selector returns a candidate, not a second live owner. The Turn
  // later resolves actual reasoning text into its independent disclosure.
  // A trailing live exploration owns the separate Exploring state; otherwise
  // only the latest renderable non-exploration Item may suppress Thinking.
  if (isTrailingExploration(frame.blocks)
    && frame.blocks.some((block) => isActiveAgentActivityBlock(block, registry))) return false;
  const trailingRenderableActivity = [...frame.blocks].reverse().find((block) =>
    isAgentActivityBlock(block)
    && block.type !== "reasoning"
    && block.type !== "text");
  if (trailingRenderableActivity !== undefined
    && isActiveAgentActivityBlock(trailingRenderableActivity, registry)) return false;
  // Todo records are immutable observations. Only a trailing observation can
  // describe current work; an earlier unfinished snapshot cannot stay active
  // after a newer update or another Item has taken over.
  const trailing = frame.blocks.filter(isAgentActivityBlock).at(-1);
  if (trailing?.type === "todo" && trailing.entries.some((entry) => entry.status !== "complete")) return false;
  return !hasContinuingLiveDynamicToolActivity(frame.blocks, frame.status, registry);
}

/**
 * Codex resolves the Activity-local fallback before mounting the Turn-level
 * placeholder. This selector mirrors the recovered `innerThinkingCandidate`
 * boundary: only the latest group in the still-open current response Activity
 * slice can take ownership, never a historical answer's group.
 */
function findAgentActivityThinkingOwner(
  assistant: AssistantTurnPresentationPlan | null,
  registry?: ToolActivityPresenterRegistry,
): Extract<TimelineTurnThinkingOwner, { readonly type: "activity" }> | null {
  if (assistant === null) return null;
  const activity = assistant.slots.at(-1);
  if (activity?.type !== "agent-activity"
    || (activity.status !== "pending" && activity.status !== "streaming")) return null;
  const latestUnit = [...activity.contentUnits]
    .reverse()
    .find((unit) => unit.type !== "worked-for");
  return latestUnit?.type === "group"
    && deriveAgentActivityHeaderPresentation(latestUnit, registry).state === "thinking"
    ? { type: "activity", activityId: activity.id, groupId: latestUnit.id }
    : null;
}

/** Task disclosure policy, matching Codex 26.930.31428 EO (ordinary chat mode).
 * Closure/status do not grant eligibility. Explicit intent beats the automatic
 * default; a temporary expansion constraint beats both without writing intent. */
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
 * Ordered semantic segments, not global before/answer/after buckets.
 * Execution belongs to the Turn; disclosure belongs to contiguous activity.
 * A user input, question, answer or auxiliary interaction closes that segment
 * without closing the execution. Streaming updates keep their source slot.
 */
export function createAssistantTurnPresentationPlan(
  frame: AssistantTimelineFrame,
  registry?: ToolActivityPresenterRegistry,
  partitionOptions: AgentActivityPartitionOptions = {},
): AssistantTurnPresentationPlan {
  const changeSummary = frame.changeSummary !== undefined ? frame.changeSummary
    : frame.blocks.filter((block): block is Extract<TimelineBlock, { type: "turn-diff" }> => block.type === "turn-diff").at(-1) ?? null;
  frame = { ...frame, blocks: frame.blocks.filter(block => block.type !== "turn-diff") };
  interface ActivitySegment {
    readonly type: "activity-segment";
    readonly blocks: readonly TimelineBlock[];
    readonly subagents: readonly SubagentTimelineBlock[];
    readonly boundaryId: string | null;
    readonly phase: AgentActivityPhase;
    readonly end: AgentActivitySegmentEnd;
  }
  const segments: (ActivitySegment | AssistantContentRenderUnit)[] = [];
  let pendingBlocks: TimelineBlock[] = [];
  let pendingSubagents: SubagentTimelineBlock[] = [];
  let boundaryId: string | null = null;
  const latestPlan = frame.blocks.filter((block) => block.type === "plan").at(-1);
  let passedFinalAssistant = false;
  const flushActivity = (end: AgentActivitySegmentEnd) => {
    if (pendingBlocks.length === 0 && pendingSubagents.length === 0) return;
    segments.push({ type: "activity-segment", blocks: pendingBlocks, subagents: pendingSubagents,
      boundaryId, phase: passedFinalAssistant ? "after-final-answer" : "before-final-answer",
      end });
    pendingBlocks = [];
    pendingSubagents = [];
  };

  const createActivitySlot = (
    segment: ActivitySegment,
    ownsWorkStatus: boolean,
    hasFinalAssistantStarted: boolean,
  ): AgentActivityRenderUnit | null => {
    const { blocks, phase, subagents: subagentBlocks } = segment;
    const turnIsActive = frame.status === "pending" || frame.status === "streaming";
    const endedByContent = segment.end !== "open" && segment.end !== "turn-terminal";
    const endedByAnswer = hasFinalAssistantStarted;
    const isActivitySliceClosed = segment.end !== "open";
    const status = endedByContent ? "complete" : frame.status;
    // Work owns the response container; thinking and tools own inner controls.
    // Readable reasoning never re-keys or splits this outer surface.
    const id = segment.boundaryId === null ? `${frame.turnId}:slot:agent-activity`
      : `${frame.turnId}:slot:activity-after:${segment.boundaryId}`;
    const contentUnits = activityContentUnits.get(segment)!.map(unit => unit.type === "reasoning"
      ? { ...unit, id: `${frame.turnId}:slot:reasoning:${unit.block.id}` } : unit);
    // One Turn total, not a fabricated elapsed time for each response. A new
    // input awaiting work must not animate an already-closed historical slice.
    const workStatus = !ownsWorkStatus || (turnIsActive && endedByContent && !endedByAnswer) ? null
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
        const unitBlocks = unit.type === "group" ? unit.blocks
          : unit.type === "standalone" || unit.type === "reasoning" ? [unit.block] : [];
        return unitBlocks.some((block) => blocks.indexOf(block) >= firstWorkBlockIndex);
      });
      const insertionIndex = workStatus.status === "working"
        ? firstWorkIndex < 0 ? contentUnits.length : firstWorkIndex : contentUnits.length;
      contentUnits.splice(insertionIndex, 0, workUnit);
    }
    if (contentUnits.length === 0 && subagentBlocks.length === 0) return null;
    const partitions = partitionAgentActivityContentUnits(contentUnits, partitionOptions);
    const inlineSubagentActivity = subagentBlocks.length === 0 ? null : {
      type: "subagent-activity" as const,
      id: `${id}:subagents`,
      blocks: subagentBlocks,
    };
    return {
      type: "agent-activity",
      id,
      blocks,
      contentUnits,
      inlineSubagentActivity,
      partitions,
      collapsedItemCount: countAgentActivityContentItems(partitions.collapsibleUnits)
        + (inlineSubagentActivity === null ? 0 : 1),
      phase,
      status,
      workedDurationMs: ownsWorkStatus ? frame.durationMs : null,
      hasFinalAssistantStarted,
      segmentEnd: segment.end,
      // Partitioning is a disclosure-only projection. When the Turn cannot
      // collapse, Codex renders the original Unit stream, including a leading
      // realtime transcript that intentionally does not appear in expandedUnits.
      hasRenderableAgentItems: contentUnits.length > 0 || inlineSubagentActivity !== null,
      isTurnCancelled: frame.status === "interrupted",
      forceExpanded: false,
      disableCollapse: phase === "after-final-answer" && !endedByContent,
      preventAutoCollapse: !isActivitySliceClosed && (blocks.some((block) => isActiveAgentActivityBlock(block, registry))
        || subagentBlocks.some((block) => block.status === "pending" || block.status === "running")),
      summary: {
        ...summarize(blocks),
        subagentCount: subagentBlocks.length,
      },
    };
  };

  for (const block of frame.blocks) {
    // Only the latest proposal is visible, but it retains its source position.
    if (block.type === "plan-implementation") continue;
    if (block.type === "plan" && block !== latestPlan) continue;
    // Plan updates are immutable protocol observations. Codex selects the
    // latest snapshot into fixed in-progress chrome; snapshots never become
    // transcript Activity rows.
    if (block.type === "todo") continue;
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
    if (block.type === "reasoning") {
      // Item-level thinking and tool choices are independent, but share the
      // same response work owner. Only actual response/input boundaries flush
      // that owner; returned thinking merely splits inner tool groups.
      pendingBlocks.push(block);
      continue;
    }
    if (block.type === "subagent") {
      pendingSubagents.push(block);
      continue;
    }
    // Steering is a chronological boundary, never a persistent row pulled
    // out of a disclosure spanning older work and newer answers.
    if (isAgentActivityBlock(block) && block.type !== "user-message") {
      pendingBlocks.push(block);
      continue;
    }
    flushActivity(isFinalAssistantText(block) ? "final-answer"
      : block.type === "user-message" || block.type === "realtime-transcript" ? "user-input" : "content");
    segments.push({ type: "assistant-content", id: `${frame.turnId}:slot:assistant-content:${block.id}`, block });
    boundaryId = block.id;
    if (isFinalAssistantText(block)) passedFinalAssistant = true;
    else if (block.type === "user-message" || block.type === "realtime-transcript"
      || (block.type === "text" && (block.delivery === "async" || (block.asyncQuestions?.length ?? 0) > 0))) {
      passedFinalAssistant = false;
    }
  }
  flushActivity(frame.status === "pending" || frame.status === "streaming" ? "open" : "turn-terminal");
  // Use the actual semantic projection, not raw Item count, when selecting
  // owners. Hidden-only segments cannot consume a response's fold or clock.
  const activityContentUnits = new Map<ActivitySegment, readonly AgentActivityContentUnit[]>();
  const hasWorkContent = (segment: ActivitySegment) =>
    activityContentUnits.get(segment)!.length > 0 || segment.subagents.length > 0;
  for (const segment of segments) {
    if (segment.type !== "activity-segment") continue;
    const endedByContent = segment.end !== "open" && segment.end !== "turn-terminal";
    activityContentUnits.set(segment, createAgentActivityContentUnits(segment.blocks,
      endedByContent ? "complete" : frame.status, registry, segment.end !== "open"));
  }
  // Only a real final answer grants its preceding response work disclosure.
  // Reasoning is inner content, not a response boundary or a fold grant.
  const finalAnswerGrants = new Set<ActivitySegment>();
  let qualifyingAnswerAhead = false;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    if (segment.type === "assistant-content") {
      qualifyingAnswerAhead = isFinalAssistantText(segment.block);
      continue;
    }
    if (segment.end !== "final-answer") qualifyingAnswerAhead = false;
    if (qualifyingAnswerAhead && hasWorkContent(segment)) {
      finalAnswerGrants.add(segment);
      qualifyingAnswerAhead = false;
    }
  }
  let workStatusOwner = -1;
  segments.forEach((segment, index) => { if (segment.type === "activity-segment") workStatusOwner = index; });
  // The latest work container owns the Turn clock, including reasoning-only
  // work. Never move it across a response/input/content boundary.
  const slots = segments.flatMap<AssistantRenderUnit>((segment, index) => {
    if (segment.type !== "activity-segment") return [segment];
    const activity = createActivitySlot(segment, index === workStatusOwner, finalAnswerGrants.has(segment));
    return activity === null ? [] : [activity];
  });
  return { slots, changeSummary };
}

/**
 * Classify a complete Turn into stable renderer surfaces.
 *
 * Provenance frames remain in the snapshot. Only the contiguous user intro is
 * outside the ordered surface; later user/interaction frames retain their
 * chronological slots inside it. One parent arbitrates live state and extras.
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
  const orderedBlocks: TimelineBlock[] = [];
  let inUserIntro = true;
  const resourceFrame = turn.frames.find(frame => frame.changeSummary !== undefined);
  const changeSummary = resourceFrame !== undefined ? resourceFrame.changeSummary ?? null
    : turn.frames.flatMap(frame => frame.blocks).filter((block): block is Extract<TimelineBlock, { type: "turn-diff" }> => block.type === "turn-diff").at(-1) ?? null;

  for (const frame of turn.frames) {
    if (inUserIntro && frame.type === "user") { userFrames.push(frame); continue; }
    inUserIntro = false;
    orderedBlocks.push(...frame.blocks.filter(block => block.type !== "turn-diff"));
    if (frame.type === "assistant") assistantFrames.push(frame);
  }

  const turnIsActive = turn.status === "pending" || turn.status === "streaming";
  const materializeAssistantSurface = orderedBlocks.length > 0
    || changeSummary !== null
    || (isMostRecentTurn && turnIsActive);
  const assistantFrame: AssistantTimelineFrame | null = materializeAssistantSurface
    ? {
        type: "assistant",
        id: `${turn.turnKey}:assistant-surface`,
        turnId: turn.turnId,
        status: turn.status,
        durationMs: [...assistantFrames].reverse().find((frame) => frame.durationMs !== null)?.durationMs ?? null,
        workStatus: assistantFrames.find((frame) => frame.workStatus != null)?.workStatus ?? null,
        changeSummary,
        interruptedByThisClient: turn.frames.some((frame) => frame.interruptedByThisClient),
        hookStats: [...assistantFrames].reverse().find((frame) => frame.hookStats !== null)?.hookStats ?? null,
        anchors: assistantFrames.flatMap((frame) => frame.anchors),
        blocks: orderedBlocks,
      }
    : null;
  let assistant = assistantFrame === null
    ? null
    : createAssistantTurnPresentationPlan(assistantFrame, registry, partitionOptions);
  const latestTodo = assistantFrame?.blocks.filter(
    (block): block is TodoTimelineBlock => block.type === "todo",
  ).at(-1) ?? null;
  const activeTodo = isMostRecentTurn && turnIsActive ? latestTodo : null;
  const currentBlocks = currentResponseBlocks(orderedBlocks);
  const hasPendingInteraction = currentBlocks.some(isPendingNonActivityBlock);
  const latestProposal = currentBlocks.filter((block) => block.type === "plan").at(-1);
  const isPlanning = turnIsActive && latestProposal?.type === "plan" && !latestProposal.completed
    && !currentBlocks.some((block) => block.type === "command-execution"
      && block.actions.some((action) => action.type === "read" || action.type === "search" || action.type === "list-files")
      && isActiveAgentActivityBlock(block, registry));
  const turnThinkingCandidate = isMostRecentTurn
    && assistantFrame !== null
    && (isPlanning || (!hasPendingInteraction && shouldRenderAgentThinkingPlaceholder(assistantFrame, registry)));
  const activityThinkingOwner = isMostRecentTurn
    && !isPlanning
    ? findAgentActivityThinkingOwner(assistant, registry)
    : null;
  const trailingThinkingBlock = currentBlocks.filter((block) => block.type !== "todo").at(-1);
  const reasoningThinkingUnit = isMostRecentTurn && turnIsActive && !hasPendingInteraction && !isPlanning
    && trailingThinkingBlock?.type === "reasoning"
    ? assistant?.slots.flatMap<ReasoningRenderUnit>(slot => slot.type === "agent-activity"
      ? slot.contentUnits.filter((unit): unit is ReasoningRenderUnit => unit.type === "reasoning")
      : slot.type === "reasoning" ? [slot] : [])
      .find((slot): slot is ReasoningRenderUnit => slot.type === "reasoning"
      && slot.block.id === trailingThinkingBlock.id) ?? null
    : null;
  const thinkingOwner: TimelineTurnThinkingOwner = activityThinkingOwner !== null
    ? activityThinkingOwner
    : reasoningThinkingUnit !== null
      ? { type: "reasoning", reasoningId: reasoningThinkingUnit.id }
    : turnThinkingCandidate
      ? {
          type: "turn",
          placeholderId: `${turn.turnKey}:slot:thinking-placeholder`,
          label: isPlanning ? "Planning" : "Thinking",
        }
      : { type: "none" };
  if (assistant !== null) {
    const updateReasoning = (unit: ReasoningRenderUnit): ReasoningRenderUnit => {
      const active = thinkingOwner.type === "reasoning" && thinkingOwner.reasoningId === unit.id;
      return { ...unit, active, presentation: presentReasoning(unit.block, active)! };
    };
    assistant = { ...assistant, slots: assistant.slots.map((slot) => {
      if (slot.type === "agent-activity") {
        const contentUnits = slot.contentUnits.map(unit => unit.type === "reasoning" ? updateReasoning(unit) : unit);
        return { ...slot, contentUnits, partitions: partitionAgentActivityContentUnits(contentUnits, partitionOptions) };
      }
      if (slot.type !== "reasoning") return slot;
      return updateReasoning(slot);
    }) };
  }
  const topLevelSlotCount = userFrames.reduce(
    (count, frame) => count + (frame.blocks.length > 0 ? 1 : 0),
    0,
  ) + (assistant?.slots.length ?? 0)
    + (assistant?.changeSummary == null ? 0 : 1)
    + (thinkingOwner.type === "turn" ? 1 : 0)
    + auxiliaryFrames.reduce((count, frame) => count + frame.blocks.length, 0);

  return {
    userFrames,
    assistantFrame,
    assistant,
    activeTodo,
    auxiliaryFrames,
    thinkingOwner,
    topLevelSlotCount,
  };
}

export function shouldAllowAgentActivityCollapse(unit: AgentActivityRenderUnit): boolean {
  return resolveAgentActivityLayout(unit, false).showToggle;
}

/** Shared partition/visibility calculation, matching current Codex DO regions. */
export function resolveAgentActivityLayout(
  unit: AgentActivityRenderUnit,
  persistedCollapsed?: boolean,
): AgentActivityLayout {
  // Preserve raw user intent through partitioning. The effective
  // visibility of the toggle/body is an OUTPUT, never fed back as a choice.
  const disclosure = resolveAgentActivityDisclosure({ ...unit, persistedCollapsed,
    forceExpanded: unit.forceExpanded || unit.disableCollapse });
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
