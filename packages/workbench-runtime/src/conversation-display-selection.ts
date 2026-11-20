import type { TimelineSnapshot, WorkStatusItem } from "@opencraft/chat-core";

type Frame = TimelineSnapshot["frames"][number];
type Block = Frame["blocks"][number];
type ConversationKey = TimelineSnapshot["key"];

/** Display provenance is not a command grant. Execution still requires its live lease. */
export type ConversationDisplaySelection =
  | { readonly source: "empty"; readonly timeline: null }
  | { readonly source: "history" | "preview" | "cache" | "submission"; readonly timeline: TimelineSnapshot }
  | { readonly source: "mixed"; readonly timeline: TimelineSnapshot; readonly cachedTurnIds: ReadonlySet<string> };

/** A shared oldest Turn proves the order of a cached prefix. Missing Turns
 * inside the returned range are authoritative deletions, not retained cache.
 * Disjoint windows and complete baselines cannot inherit an unproven prefix. */
function selectHistoryTimeline(timeline: TimelineSnapshot, cached: TimelineSnapshot | null,
  hasOlder: boolean | undefined): ConversationDisplaySelection {
  const boundary = timeline.frames[0]?.turnId;
  const index = hasOlder === true && boundary !== undefined
    ? cached?.frames.findIndex(frame => frame.turnId === boundary) ?? -1 : -1;
  if (index <= 0 || cached === null) return { source: "history", timeline };
  const liveTurns = new Set(timeline.frames.map(frame => frame.turnId));
  const prefix = cached.frames.slice(0, index).filter(frame => !liveTurns.has(frame.turnId));
  if (prefix.length === 0) return { source: "history", timeline };
  return {
    source: "mixed",
    cachedTurnIds: new Set(prefix.map(frame => frame.turnId)),
    timeline: { ...timeline, authoritative: false, frames: [...prefix, ...timeline.frames] },
  };
}

function sameConversation(a: ConversationKey, b: ConversationKey): boolean {
  return a.hostId === b.hostId && a.threadId === b.threadId;
}

function messageKey(frame: Frame, block: Block): string {
  return JSON.stringify([frame.turnId, frame.type, block.type, block.id]);
}

function indexMessages(timeline: TimelineSnapshot) {
  return new Map(timeline.frames.flatMap(frame => frame.blocks.map(block =>
    [messageKey(frame, block), { frame, block }] as const)));
}

function endedWork(work: WorkStatusItem | null | undefined): WorkStatusItem | null {
  return work?.type === "worked-for" && work.status !== "working"
    && work.completedAtMs !== null && Number.isFinite(work.startedAtMs)
    && Number.isFinite(work.completedAtMs) && work.startedAtMs >= 0 && work.completedAtMs >= work.startedAtMs
    ? work : null;
}

/** Keep known static clocks and per-message sender through preview, never authority. */
export function retainPreviewMetadata(preview: TimelineSnapshot, display: TimelineSnapshot | null): TimelineSnapshot {
  if (preview.authoritative || display === null || !sameConversation(preview.key, display.key)) return preview;
  const known = indexMessages(display);
  return { ...preview, historyTurnCount: preview.historyTurnCount ?? display.historyTurnCount, frames: preview.frames.map(frame => {
    let durationMs = frame.durationMs, workStatus = frame.workStatus, displayDurationMs = frame.displayDurationMs;
    const blocks = frame.blocks.map(block => {
      const prior = known.get(messageKey(frame, block));
      if (!prior) return block;
      if (block.type === "user-message" && prior.block.type === "user-message") {
        return { ...block, sentAtMs: block.sentAtMs ?? prior.block.sentAtMs,
          sender: block.sender === undefined ? prior.block.sender : block.sender };
      }
      if (block.type !== "text" || prior.block.type !== "text") return block;
      if (frame.status === "complete" && !block.streaming && block.completed !== false && block.phase === "final_answer"
        && prior.block.completed !== false && prior.block.phase === "final_answer") {
        durationMs ??= prior.frame.durationMs;
        displayDurationMs ??= prior.frame.displayDurationMs;
        workStatus ??= endedWork(prior.frame.workStatus);
      }
      return block.sentAtMs == null ? { ...block, sentAtMs: prior.block.sentAtMs } : block;
    });
    return { ...frame, blocks, durationMs, workStatus, displayDurationMs };
  }) };
}

/** A partial history may regroup or omit cached messages. Do not let that
 * provisional body erase their already visible metadata before authority. */
function selectPreviewTimeline(timeline: TimelineSnapshot, display: TimelineSnapshot | null): TimelineSnapshot {
  if (timeline.authoritative || display === null || !sameConversation(timeline.key, display.key)) return timeline;
  const preview = retainPreviewMetadata(timeline, display);
  const messages = indexMessages(preview);
  for (const frame of display.frames) for (const block of frame.blocks) {
    if (block.type !== "text" && block.type !== "user-message" && block.type !== "reasoning"
      && !("displayPreview" in block && block.displayPreview)) continue;
    const incoming = messages.get(messageKey(frame, block));
    // A provisional window cannot delete already visible messages. Canonical
    // history, including confirmed deletion or empty history, bypasses this guard.
    if (!incoming) return display;
    // Metadata here determines grouping, not decoration: losing async delivery
    // turns a question into an answer; losing steering content removes its reply.
    if (block.type === "text" && incoming.block.type === "text"
      && ((block.delivery ?? null) !== (incoming.block.delivery ?? null)
        || JSON.stringify(block.asyncQuestions ?? []) !== JSON.stringify(incoming.block.asyncQuestions ?? [])
        || (block.hasStructuredOutput ?? false) !== (incoming.block.hasStructuredOutput ?? false))) return display;
    if (block.type === "user-message" && incoming.block.type === "user-message"
      && (block.messageKind !== incoming.block.messageKind
        || JSON.stringify(block.content) !== JSON.stringify(incoming.block.content)
        || JSON.stringify(block.attachments) !== JSON.stringify(incoming.block.attachments))) return display;
    if ("sentAtMs" in block && block.sentAtMs != null && (!("sentAtMs" in incoming.block) || incoming.block.sentAtMs == null)) return display;
    if (block.type === "user-message" && block.sender != null
      && (!incoming || incoming.block.type !== "user-message" || incoming.block.sender === undefined)) return display;
    if (frame.type === "assistant" && (frame.durationMs != null || endedWork(frame.workStatus) !== null)
      && (!incoming || (frame.durationMs != null && incoming.frame.durationMs == null)
        || (endedWork(frame.workStatus) !== null && endedWork(incoming.frame.workStatus) === null))) return display;
  }
  return preview;
}

/** One selection policy for initial paint, partial history and canonical history.
 * The committed View key fences every input; account isolation belongs to the
 * continuity owner. This function has no storage, subscriptions or side effects. */
export function selectConversationDisplay(input: {
  readonly key: ConversationKey | null;
  readonly timeline: TimelineSnapshot | null;
  readonly cached: TimelineSnapshot | null;
  readonly submission?: TimelineSnapshot | null;
  /** Coverage of the canonical history window, independent of its authority. */
  readonly historyHasOlder?: boolean;
}): ConversationDisplaySelection {
  const scoped = (value: TimelineSnapshot | null | undefined) =>
    value != null && input.key !== null && sameConversation(input.key, value.key) ? value : null;
  const timeline = scoped(input.timeline);
  const cached = scoped(input.cached);
  const submission = scoped(input.submission);
  if (timeline !== null && timeline.frames.length > 0) {
    if (timeline.authoritative) return selectHistoryTimeline(timeline, cached, input.historyHasOlder);
    const preview = selectPreviewTimeline(timeline, cached);
    return { source: preview === cached ? "cache" : "preview", timeline: preview };
  }
  // The creation receipt's local echo survives an empty baseline until the
  // continuity owner observes a canonical user message and retires the handoff.
  if (submission !== null) return { source: "submission", timeline: submission };
  if (timeline?.authoritative) return { source: "history", timeline };
  if (cached !== null) return { source: "cache", timeline: cached };
  if (timeline !== null) return { source: "preview", timeline };
  return { source: "empty", timeline: null };
}
