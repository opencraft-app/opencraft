import type { TurnId } from "./identity";
import { isAssistantAnswerContent } from "./conversation-presentation";
import type {
  ApprovalTimelineBlock,
  QuestionTimelineBlock,
  OptionPickerTimelineBlock,
  SetupCodexStepTimelineBlock,
  SetupContextPickerTimelineBlock,
  McpElicitationTimelineBlock,
  TimelineFrame,
  TimelineSnapshot,
  TimelineStatus,
} from "./timeline";

export type AttachedInteractionTimelineBlock = ApprovalTimelineBlock | QuestionTimelineBlock | OptionPickerTimelineBlock
  | SetupCodexStepTimelineBlock | SetupContextPickerTimelineBlock | McpElicitationTimelineBlock;

/**
 * Composer-owned requests are projected into the timeline for durable identity
 * and history, but their interactive surface lives beside the Composer. Codex
 * presents one request at a time, with the newest pending request winning.
 */
export function findPendingInteraction(
  timeline: Pick<TimelineSnapshot, "frames"> | null | undefined,
): AttachedInteractionTimelineBlock | null {
  if (timeline == null) return null;
  for (let frameIndex = timeline.frames.length - 1; frameIndex >= 0; frameIndex -= 1) {
    const frame = timeline.frames[frameIndex];
    if (frame === undefined || frame.type !== "interaction") continue;
    for (let blockIndex = frame.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = frame.blocks[blockIndex];
      if (block === undefined) continue;
      if (block.type === "approval" && block.state === "pending") return block;
      if (block.type === "question" && block.state === "pending") return block;
      if (block.type === "option-picker" && block.state === "pending") return block;
      if (block.type === "setup-codex-step" && block.state === "pending") return block;
      if (block.type === "setup-context-picker" && block.state === "pending") return block;
      if (block.type === "elicitation" && block.state === "pending") return block;
    }
  }
  return null;
}

/**
 * The renderer and virtualizer mount one complete AppServer Turn at a time.
 * Frames remain the extensible semantic units inside that Turn.
 */
export interface TimelineTurnView {
  readonly type: "turn";
  readonly turnKey: string;
  readonly turnId: TurnId;
  readonly status: TimelineStatus;
  readonly frames: readonly TimelineFrame[];
}

/** React presentation identity; `turnKey` remains the protocol Turn locator. */
export function timelineTurnRenderKey(turn: TimelineTurnView): string {
  const primaryUserMessage = turn.frames.flatMap((frame) => frame.blocks).find((block) =>
    block.type === "user-message" && block.messageKind === "user" && block.clientId !== null);
  return primaryUserMessage?.type === "user-message"
    ? `user-message:${primaryUserMessage.clientId}:turn`
    : turn.turnKey;
}

/** The Item anchor used by both hosts for a visible user-message frame. */
export function getTimelineUserMessageTargetKey(frame: TimelineFrame): string | null {
  return frame.type === "user" && frame.blocks.length > 0
    ? frame.anchors.find((anchor) => anchor.type === "item")?.id ?? frame.id
    : null;
}

/**
 * Identity of the latest visual Activity inside a Turn.
 *
 * Codex deliberately does not use `turnKey` alone here: steering appends work
 * to an existing Turn, so the Turn row remains stable while latest-response
 * placement must run again. Source Item identity is the durable protocol key;
 * the projected block id is only a defensive fallback for synthetic frames.
 */
export function deriveTimelineLatestTurnActivityKey(
  turn: TimelineTurnView | null | undefined,
): string | null {
  if (turn == null) return null;
  for (let frameIndex = turn.frames.length - 1; frameIndex >= 0; frameIndex -= 1) {
    const frame = turn.frames[frameIndex];
    if (frame === undefined) continue;
    for (let blockIndex = frame.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = frame.blocks[blockIndex];
      if (block?.type !== "user-message" || block.messageKind !== "steering") continue;
      const steeringKey = block.sourceItemIds[0] ?? block.id;
      return `${timelineTurnRenderKey(turn)}:${steeringKey}`;
    }
  }
  return timelineTurnRenderKey(turn);
}

export interface TimelineHistoryGapView {
  readonly type: "history-gap";
  readonly turnKey: string;
  readonly estimatedHeightPx: number;
  readonly direction: "older" | "newer";
  readonly cursor: string | null;
}

export type TimelineRenderEntry = TimelineTurnView | TimelineHistoryGapView;

/** Server requests remain independent protocol Items but are rendered with the Item they target. */
export function indexAttachedInteractions(
  frames: readonly TimelineFrame[],
): ReadonlyMap<string, readonly AttachedInteractionTimelineBlock[]> {
  const mutable = new Map<string, AttachedInteractionTimelineBlock[]>();
  for (const frame of frames) {
    if (frame.type !== "interaction") continue;
    for (const block of frame.blocks) {
      if ((block.type !== "approval" && block.type !== "question" && block.type !== "option-picker"
        && block.type !== "setup-codex-step" && block.type !== "setup-context-picker" && block.type !== "elicitation")
        || block.targetItemId === null) continue;
      const existing = mutable.get(block.targetItemId) ?? [];
      existing.push(block);
      mutable.set(block.targetItemId, existing);
    }
  }
  return new Map([...mutable].map(([itemId, blocks]) => [itemId, Object.freeze([...blocks])]));
}

export type TimelineLatestTurnPhase = "idle" | "prework" | "final_answer";

/**
 * Renderer-neutral equivalent of Codex's latest Turn phase classifier. A
 * projected assistant Item is the final-answer boundary even before its
 * first text delta (Codex AD classifies by Item phase, not text length); reasoning,
 * tools and interaction/event work remain prework while the Turn is active.
 */
export function deriveTimelineLatestTurnPhase(
  turn: TimelineTurnView | null | undefined,
): TimelineLatestTurnPhase {
  if (turn === null || turn === undefined || (turn.status !== "pending" && turn.status !== "streaming")) {
    return "idle";
  }
  let phase: TimelineLatestTurnPhase = "idle";
  for (const frame of turn.frames) {
    for (const block of frame.blocks) {
      if (block.type === "turn-diff") continue;
      if (block.type === "user-message") phase = block.messageKind === "steering" ? "prework" : "idle";
      else if (isAssistantAnswerContent(block)) phase = "final_answer";
      else if (frame.type !== "user") phase = "prework";
    }
  }
  return phase;
}

export function groupTimelineFramesByTurn(
  timeline: Pick<TimelineSnapshot, "frames">,
): readonly TimelineTurnView[] {
  const turns: TimelineTurnView[] = [];
  const indexByTurnId = new Map<TurnId, number>();
  for (const frame of timeline.frames) {
    const existingIndex = indexByTurnId.get(frame.turnId);
    if (existingIndex === undefined) {
      indexByTurnId.set(frame.turnId, turns.length);
      turns.push({
        type: "turn",
        turnKey: frame.turnId,
        turnId: frame.turnId,
        status: frame.status,
        frames: [frame],
      });
      continue;
    }
    const existing = turns[existingIndex];
    if (existing === undefined) continue;
    turns[existingIndex] = {
      ...existing,
      status: frame.status,
      frames: [...existing.frames, frame],
    };
  }
  return turns;
}

export function createOlderHistoryGap(
  key: string,
  estimatedHeightPx: number,
  cursor: string | null,
): TimelineHistoryGapView {
  if (key.length === 0) throw new RangeError("History gap key must not be empty");
  if (!Number.isFinite(estimatedHeightPx) || estimatedHeightPx <= 0) {
    throw new RangeError("History gap estimated height must be positive");
  }
  return {
    type: "history-gap",
    turnKey: key,
    estimatedHeightPx,
    direction: "older",
    cursor,
  };
}
