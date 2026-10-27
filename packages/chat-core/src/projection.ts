import { asItemId, asTurnId, type ConversationKey, type ItemId } from "./identity";
import type {
  TimelineAnchor,
  TimelineBlock,
  TimelineFrame,
  TimelineSnapshot,
  TimelineStatus,
  ConversationPhase,
} from "./timeline";
import type { HookStats } from "./hook-stats";
import { normalizeTurnUserMessages } from "./turn-user-message-normalization";
import { deriveTurnWorkStatus } from "./work-status";
import { createTurnChangeSummary } from "./turn-diff";
import { normalizeCommandCompletionOrder } from "./command-completion-order";

export type TimelineLane = "user" | "assistant" | "event" | "interaction";

export interface TimelineSourceItem {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
}

export interface TimelineSourceTurn {
  readonly id: string;
  readonly status: TimelineStatus;
  readonly startedAtMs?: number | null;
  readonly completedAtMs?: number | null;
  readonly durationMs?: number | null;
  readonly firstTurnWorkItemStartedAtMs?: number | null;
  readonly finalAssistantStartedAtMs?: number | null;
  /** Aggregate resource owned by the Turn, outside ordered Item membership. */
  readonly unifiedDiff?: string | null;
  readonly interruptedByThisClient?: boolean;
  readonly hookStats?: HookStats | null;
  /** Complete Turn-start envelope retained for UserMessage ownership. */
  readonly params?: unknown;
  readonly mcpAppModelContextAttachments?: unknown;
  readonly preserveServerUserMessages?: boolean;
  /**
   * Protocol Items intentionally retained as non-visual display boundaries.
   * Keep `steered` acknowledgements in the normalized stream even
   * though the React renderer returns null for them. Keeping their identities
   * here prevents history recovery from erasing provenance merely because a
   * renderer has no visible node for the Item.
   */
  readonly nonVisualItemIds?: readonly string[];
  readonly items: readonly TimelineSourceItem[];
}

export interface TimelineProjectionSource {
  readonly key: ConversationKey;
  readonly revision: number;
  readonly phase: ConversationPhase;
  readonly authoritative: boolean;
  readonly turns: readonly TimelineSourceTurn[];
}

export interface TimelineItemProjection {
  readonly lane: TimelineLane;
  readonly block: TimelineBlock;
  readonly anchors?: readonly TimelineAnchor[];
}

export interface TimelineProjectionContext {
  readonly turn: TimelineSourceTurn;
  readonly itemIndex: number;
}

export interface TimelineItemProjector {
  readonly name: string;
  readonly priority?: number;
  readonly itemTypes?: readonly string[];
  canProject?(item: TimelineSourceItem, context: TimelineProjectionContext): boolean;
  project(item: TimelineSourceItem, context: TimelineProjectionContext): TimelineItemProjection | null;
}

function compareProjectors(left: TimelineItemProjector, right: TimelineItemProjector): number {
  return (right.priority ?? 0) - (left.priority ?? 0);
}

export class TimelineProjectorRegistry {
  private readonly byName = new Map<string, TimelineItemProjector>();
  private readonly turnFrames = new WeakMap<TimelineSourceTurn, {
    revision: number; frames: readonly TimelineFrame[];
  }>();

  /** Source Turns are immutable; registry changes invalidate their projection. */
  projectTurn(turn: TimelineSourceTurn): readonly TimelineFrame[] {
    const cached = this.turnFrames.get(turn);
    if (cached?.revision === this.revision) return cached.frames;
    const frames = projectTurnFrames(turn, this);
    this.turnFrames.set(turn, { revision: this.revision, frames });
    return frames;
  }

  private revision = 0;
  private cachedRevision = -1;
  private cachedByType = new Map<string, readonly TimelineItemProjector[]>();
  private cachedDynamic: readonly TimelineItemProjector[] = [];

  register(projector: TimelineItemProjector): () => void {
    if (projector.name.length === 0) throw new RangeError("Timeline projector name must not be empty");
    if (this.byName.has(projector.name)) throw new Error(`Timeline projector ${projector.name} is already registered`);
    this.byName.set(projector.name, projector);
    this.revision += 1;
    return () => {
      if (this.byName.get(projector.name) !== projector) return;
      this.byName.delete(projector.name);
      this.revision += 1;
    };
  }

  registerAll(projectors: readonly TimelineItemProjector[]): () => void {
    const removers: (() => void)[] = [];
    try {
      for (const projector of projectors) removers.push(this.register(projector));
    } catch (error) {
      removers.reverse().forEach((remove) => remove());
      throw error;
    }
    return () => removers.reverse().forEach((remove) => remove());
  }

  project(item: TimelineSourceItem, context: TimelineProjectionContext): TimelineItemProjection {
    this.rebuildCache();
    const candidates = [
      ...(this.cachedByType.get(item.type) ?? []),
      ...this.cachedDynamic,
    ].sort(compareProjectors);
    for (const projector of candidates) {
      if (projector.canProject !== undefined && !projector.canProject(item, context)) continue;
      const projected = projector.project(item, context);
      if (projected !== null) return projected;
    }
    return unknownProjection(item);
  }

  private rebuildCache(): void {
    if (this.cachedRevision === this.revision) return;
    const byType = new Map<string, TimelineItemProjector[]>();
    const dynamic: TimelineItemProjector[] = [];
    for (const projector of this.byName.values()) {
      if (projector.itemTypes === undefined || projector.itemTypes.length === 0) {
        dynamic.push(projector);
        continue;
      }
      for (const itemType of projector.itemTypes) {
        const projectors = byType.get(itemType) ?? [];
        projectors.push(projector);
        byType.set(itemType, projectors);
      }
    }
    this.cachedByType = new Map([...byType].map(([type, projectors]) => [type, projectors.sort(compareProjectors)]));
    this.cachedDynamic = dynamic.sort(compareProjectors);
    this.cachedRevision = this.revision;
  }
}

function unknownProjection(item: TimelineSourceItem): TimelineItemProjection {
  const sourceItemId = asItemId(item.id);
  return {
    lane: "event",
    block: {
      type: "unknown",
      id: `unknown:${item.id}`,
      sourceItemIds: [sourceItemId],
      itemType: item.type,
      payload: item.payload,
    },
  };
}

function frameId(turnId: string, lane: TimelineLane, firstItemId: ItemId): string {
  return `${turnId}:${lane}:${firstItemId}`;
}

function frameAnchors(turnId: string, itemIds: readonly ItemId[], extra: readonly TimelineAnchor[]): TimelineAnchor[] {
  const anchors: TimelineAnchor[] = [
    { type: "turn", id: turnId },
    ...itemIds.map((id): TimelineAnchor => ({ type: "item", id })),
    ...extra,
  ];
  const seen = new Set<string>();
  return anchors.filter((anchor) => {
    const key = `${anchor.type}:${anchor.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isImageViewToolBlock(block: TimelineBlock): block is Extract<TimelineBlock, { type: "tool-call" }> {
  return block.type === "tool-call" && block.kind === "image-view";
}

/**
 * Normalize a contiguous run of imageView Items into one display Item.
 * Do this after projection so provenance anchors still retain every source
 * Item and feature projectors do not need a suppression/tombstone protocol.
 */
function coalesceAdjacentImageViews(blocks: readonly TimelineBlock[]): readonly TimelineBlock[] {
  const result: TimelineBlock[] = [];
  for (const block of blocks) {
    const previous = result.at(-1);
    if (!isImageViewToolBlock(block) || previous === undefined || !isImageViewToolBlock(previous)) {
      result.push(block);
      continue;
    }
    const imagePaths = [
      ...(previous.imagePaths ?? []),
      ...(block.imagePaths ?? []),
    ];
    result[result.length - 1] = {
      ...previous,
      sourceItemIds: [...previous.sourceItemIds, ...block.sourceItemIds],
      imagePaths,
      input: { paths: imagePaths },
    };
  }
  return result;
}

function expandCommandActions(blocks: readonly TimelineBlock[]): readonly TimelineBlock[] {
  return blocks.flatMap((block): readonly TimelineBlock[] => {
    if (block.type !== "command-execution" || block.actions.length <= 1) return [block];
    // Emit one display `exec` per parsed command action while retaining
    // the original commandExecution Item as their common provenance owner.
    return block.actions.map((action, index) => ({
      ...block,
      id: `${block.id}:${index}`,
      callId: `${block.callId}:${index}`,
      command: action.command.trim().length > 0 ? action.command : block.command,
      actions: [action],
      // An automatic review belongs to the underlying execution, not every
      // visual row generated from it. Keep a single attachment/accessory.
      automaticApprovalReviews: index === 0 ? block.automaticApprovalReviews : [],
    }));
  });
}

function normalizeAssistantBlocks(blocks: readonly TimelineBlock[]): readonly TimelineBlock[] {
  return coalesceAdjacentImageViews(expandCommandActions(blocks));
}

function projectTurnFrames(
  sourceTurn: TimelineSourceTurn,
  registry: TimelineProjectorRegistry,
): readonly TimelineFrame[] {
  const frames: TimelineFrame[] = [];
    const turn = normalizeTurnUserMessages(normalizeCommandCompletionOrder(sourceTurn));
    const workStatus = deriveTurnWorkStatus(turn);
    // Compatibility Items are lowered once here, not allowed to participate
    // in transcript topology. An explicit Turn value (including null) wins.
    const legacyDiff = turn.items.filter(item => item.type === "turnDiff").at(-1);
    const legacyBlock = legacyDiff === undefined ? null
      : registry.project(legacyDiff, { turn, itemIndex: turn.items.indexOf(legacyDiff) }).block;
    const changeSummary = turn.unifiedDiff !== undefined
      ? createTurnChangeSummary(turn.id, turn.status, turn.unifiedDiff)
      : legacyBlock?.type === "turn-diff"
        ? { ...legacyBlock, id: `${turn.id}:turn-diff`, sourceItemIds: [] } : null;
    const initialFrameCount = frames.length;
    let pendingLane: TimelineLane | null = null;
    let pendingBlocks: TimelineBlock[] = [];
    let pendingAnchors: TimelineAnchor[] = [];

    const flush = () => {
      const blocks = pendingLane === "assistant"
        ? normalizeAssistantBlocks(pendingBlocks)
        : pendingBlocks;
      const firstBlock = blocks[0];
      if (pendingLane === null || firstBlock === undefined) return;
      const itemIds = blocks.flatMap((block) => block.sourceItemIds);
      const userClientId = pendingLane === "user" && firstBlock.type === "user-message"
        && firstBlock.messageKind === "user" ? firstBlock.clientId : null;
      frames.push({
        type: pendingLane,
        id: userClientId === null
          ? frameId(turn.id, pendingLane, itemIds[0] ?? asItemId(firstBlock.id))
          : `user-message:${userClientId}:frame`,
        turnId: asTurnId(turn.id),
        status: turn.status,
        durationMs: turn.durationMs ?? null,
        workStatus,
        changeSummary,
        interruptedByThisClient: turn.interruptedByThisClient === true,
        hookStats: turn.hookStats ?? null,
        anchors: frameAnchors(turn.id, itemIds, pendingAnchors),
        blocks,
      });
      pendingLane = null;
      pendingBlocks = [];
      pendingAnchors = [];
    };

    turn.items.forEach((item, itemIndex) => {
      if (item.type === "turnDiff") return;
      const projected = registry.project(item, { turn, itemIndex });
      const canGroup = projected.lane === "assistant" && pendingLane === "assistant";
      if (!canGroup) flush();
      if (pendingLane === null) pendingLane = projected.lane;
      pendingBlocks.push(projected.block);
      pendingAnchors.push(...(projected.anchors ?? []));
      if (projected.lane !== "assistant") flush();
    });
    flush();
    // A resource-only recovered Turn still owns a surface, not a fake Item.
    if (frames.length === initialFrameCount && changeSummary !== null) {
      frames.push({ type: "assistant", id: `${turn.id}:resources`, turnId: asTurnId(turn.id),
        status: turn.status, durationMs: turn.durationMs ?? null, workStatus,
        changeSummary, hookStats: turn.hookStats ?? null, anchors: [{ type: "turn", id: turn.id }], blocks: [] });
    }
  return frames;
}

const previousProjection = new WeakMap<TimelineProjectorRegistry, {
  frames: readonly TimelineFrame[]; anchorFrameIds: ReadonlyMap<string, string>;
}>();

export function projectTimeline(
  source: TimelineProjectionSource,
  registry: TimelineProjectorRegistry,
): TimelineSnapshot {
  const projected = source.turns.flatMap(turn => registry.projectTurn(turn));
  const previous = previousProjection.get(registry);
  const unchanged = previous !== undefined && projected.length === previous.frames.length
    && projected.every((frame, index) => frame === previous.frames[index]);
  const frames = unchanged ? previous.frames : projected;

  const anchorFrameIds = unchanged ? previous.anchorFrameIds : new Map<string, string>();
  if (!unchanged) {
    const anchors = anchorFrameIds as Map<string, string>;
    for (const frame of frames) {
      for (const anchor of frame.anchors) anchors.set(`${anchor.type}:${anchor.id}`, frame.id);
    }
    previousProjection.set(registry, { frames, anchorFrameIds });
  }
  return {
    key: source.key,
    revision: source.revision,
    phase: source.phase,
    authoritative: source.authoritative,
    frames,
    anchorFrameIds,
  };
}
