import { MAX_DISPLAY_ACTIVITIES, parseDisplayActivity, projectDisplayActivity, type ConversationDisplayActivity } from "./conversation-display-activity";
import {createConversationDisplayCache,CONVERSATION_DISPLAY_POLICY} from './conversation-display-cache';
import { displayResources, type ConversationDisplayResources } from "./conversation-display-resources";
import { asTurnId, createConversationKey, createTimelineTurnPresentationPlan, groupTimelineFramesByTurn, resolveAgentActivityLayout, type ConversationDisplayHeader, type TimelineTurnView, type TimelineBlock, type TimelineSnapshot, type UserMessageTimelineBlock, type WorkStatusItem, type TimelinePresentationRegion } from "@opencraft/chat-core";

import { parseConversationDisplayBlock, type ConversationDisplayBlock } from "./conversation-display-block";

import type { SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";
import { submittedMessageDisplay } from "./submitted-message-display";
import { selectConversationDisplay } from "./conversation-display-selection";

export interface ConversationDisplayStorage {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ConversationDisplayContinuity {
  /** Synchronous, account-scoped handoff; never persisted or command-capable. */
  retainSubmission(intent: SubmitIntent, receipt: SubmissionReceipt, sender?: UserMessageTimelineBlock["sender"]): void;
  peekSubmission(hostId: string, threadId: string): TimelineSnapshot | null;
  /** Bounded paint-only memory, available during render; never grants authority. */
  peek(hostId: string, threadId: string): TimelineSnapshot | null;
  load(hostId: string, threadId: string): Promise<TimelineSnapshot | null>;
  observe(snapshot: TimelineSnapshot, historyHasOlder?: boolean, header?: ConversationDisplayHeader): Promise<void>;
}

interface DisplayMessage {
  readonly turnId: string;
  readonly frameType: "user" | "assistant";
  readonly block: ConversationDisplayBlock;
  readonly before?: readonly ConversationDisplayActivity[];
  readonly after?: readonly ConversationDisplayActivity[];
  readonly durationMs: number | null;
  readonly workStatus: WorkStatusItem | null;
  readonly regions?: readonly TimelinePresentationRegion[];
  readonly resources?: ConversationDisplayResources;
  /** A Turn resource may outlive all retained assistant message bodies. */
  readonly assistantResources?: ConversationDisplayResources;
}

// Keep the namespace stable so logout still removes older envelopes. Version 1
// excerpts cannot reconstruct message boundaries and are intentionally rejected.
const VERSION = 2;
const MAX_MESSAGES = CONVERSATION_DISPLAY_POLICY.maxMessages;
const MAX_STORED_CHARACTERS = CONVERSATION_DISPLAY_POLICY.maxCharacters;
const MAX_AGE_MS = CONVERSATION_DISPLAY_POLICY.maxAgeMs;

export function conversationDisplayStoragePrefix(namespace: string): string {
  return `opencraft.display.v1.${namespace}.`;
}

function storageKey(namespace: string, hostId: string, threadId: string): string {
  return `${conversationDisplayStoragePrefix(namespace)}${JSON.stringify([hostId, threadId])}`;
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function completedWork(value: unknown): WorkStatusItem | null {
  if (typeof value !== "object" || value === null) return null;
  const work = value as Record<string, unknown>;
  const start = nonnegativeNumber(work.startedAtMs), end = nonnegativeNumber(work.completedAtMs);
  if (work.type !== "worked-for" || (work.status !== "worked" && work.status !== "stopped")
    || start === null || end === null || end < start) return null;
  return { type: "worked-for", status: work.status, startedAtMs: start, completedAtMs: end };
}

function parseRegions(value: unknown): readonly TimelinePresentationRegion[] | undefined {
  // The envelope already has a character budget. Message count is not a
  // region budget: older writers could attach a whole Turn's regions here.
  if (!Array.isArray(value)) return undefined;
  return value.flatMap(region => {
    if (!region || region.type !== "activity" || typeof region.id !== "string" || region.id.length > 512
      || (region.beforeBlockId !== null && (typeof region.beforeBlockId !== "string" || region.beforeBlockId.length > 256))
      || !Number.isSafeInteger(region.count) || region.count < 0) return [];
    return [{ type: "activity" as const, id: region.id, beforeBlockId: region.beforeBlockId,
      count: region.count, durationMs: nonnegativeNumber(region.durationMs), workStatus: completedWork(region.workStatus) }];
  });
}

/** Descriptors and messages form one bounded display snapshot. An omitted
 * anchor retires its region, rather than relocating it to another response.
 * Apply the same normalization before memory paint and after storage parsing. */
function retainMessageRegions(messages: readonly DisplayMessage[]): DisplayMessage[] {
  const anchors = new Map<string, Set<string>>();
  for (const message of messages) if (message.frameType === "assistant") {
    const ids = anchors.get(message.turnId) ?? new Set<string>();
    ids.add(message.block.id);
    anchors.set(message.turnId, ids);
  }
  const regionsByTurn = new Map<string, TimelinePresentationRegion[]>();
  const seenByTurn = new Map<string, Set<string>>();
  for (const message of messages) {
    if (message.frameType !== "assistant" || message.regions === undefined) continue;
    const regions = regionsByTurn.get(message.turnId) ?? [];
    const seen = seenByTurn.get(message.turnId) ?? new Set<string>();
    for (const region of message.regions) {
      if (seen.has(region.id) || (region.beforeBlockId !== null && !anchors.get(message.turnId)?.has(region.beforeBlockId))) continue;
      seen.add(region.id);
      regions.push(region);
    }
    regionsByTurn.set(message.turnId, regions);
    seenByTurn.set(message.turnId, seen);
  }
  return messages.map(message => {
    if (message.frameType !== "assistant") return { ...message, regions: undefined };
    const regions = regionsByTurn.get(message.turnId);
    regionsByTurn.delete(message.turnId);
    return { ...message, regions };
  });
}

function projectMessages(snapshot: TimelineSnapshot): readonly DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  const visibleDurations = new Map<string, number>();
  const regionsByTurn = new Map<string, TimelinePresentationRegion[]>();
  const resourcesByFrame = new Map<string, ConversationDisplayResources>();
  const durationEligible = new WeakSet<DisplayMessage>();
  const recentMessages: DisplayMessage[] = [];
  const recentConversation: DisplayMessage[] = [];
  let latestUser: DisplayMessage | undefined;
  let latestSentText: DisplayMessage | undefined;
  let latestWork: DisplayMessage | undefined;
  // Select from the tail before normalizing history. Each bucket is bounded;
  // absent optional anchors may still require cheap source-kind inspection,
  // but discarded message bodies are never parsed or cloned for the cache.
  scan: for (let frameIndex = snapshot.frames.length - 1; frameIndex >= 0; frameIndex--) {
    const frame = snapshot.frames[frameIndex]!;
    if (frame.turnId === snapshot.unplacedSearchTurnId) continue;
    if (frame.type !== "user" && frame.type !== "assistant") continue;
    const active = frame.status === "pending" || frame.status === "streaming";
    const workStatus = frame.type === "assistant" ? completedWork(frame.workStatus) : null;
    for (let blockIndex = frame.blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const source = frame.blocks[blockIndex]!;
      if (source.type !== "text" && source.type !== "reasoning" && source.type !== "user-message") continue;
      const conversationCandidate = source.type === "user-message"
        || (source.type === "text" && source.phase !== "commentary");
      if (recentMessages.length >= MAX_MESSAGES
        && (recentConversation.length >= MAX_MESSAGES / 2 || !conversationCandidate)
        && (latestUser !== undefined || source.type !== "user-message")
        && (latestSentText !== undefined || source.type !== "text" || nonnegativeNumber(source.sentAtMs) === null)
        && (latestWork !== undefined || workStatus === null)) continue;
      const block = parseConversationDisplayBlock(source.type === "text"
        ? { ...source, completed: active ? source.completed === true : true } : source);
      if (!block) continue;
      const message: DisplayMessage = { turnId: frame.turnId, frameType: frame.type, block,
        resources: frame.type === "user" ? displayResources({ hookStats: frame.hookStats }) : undefined,
        durationMs: active || frame.type !== "assistant" ? null : nonnegativeNumber(workStatus === null ? null : frame.durationMs),
        workStatus };
      let selected = false;
      if (recentMessages.length < MAX_MESSAGES) { recentMessages.push(message); selected = true; }
      if (recentConversation.length < MAX_MESSAGES / 2 && (block.type === "user-message"
        || (block.type === "text" && block.phase !== "commentary"))) {
        recentConversation.push(message); selected = true;
      }
      if (latestUser === undefined && block.type === "user-message") { latestUser = message; selected = true; }
      if (latestSentText === undefined && block.type === "text" && block.sentAtMs != null) { latestSentText = message; selected = true; }
      if (latestWork === undefined && workStatus !== null) { latestWork = message; selected = true; }
      if (selected) {
        messages.push(message);
        if (!active && frame.type === "assistant") durationEligible.add(message);
      }
      if (recentMessages.length === MAX_MESSAGES && recentConversation.length === MAX_MESSAGES / 2
        && latestUser !== undefined && latestSentText !== undefined && latestWork !== undefined) break scan;
    }
  }
  // Preserve the same three semantic anchors, then conversation boundaries,
  // then recent work. Distinct source occurrences remain distinct messages.
  const retained = new Set<DisplayMessage>();
  for (const message of [latestUser, latestSentText, latestWork]) if (message) retained.add(message);
  for (const message of recentConversation) {
    if (retained.size >= MAX_MESSAGES / 2) break;
    retained.add(message);
  }
  for (const message of recentMessages) {
    if (retained.size >= MAX_MESSAGES) break;
    retained.add(message);
  }
  messages.reverse();
  // Only resident Turns need expensive activity planning and diff indexing.
  // Keep every frame of those Turns: resources can outlive a message body.
  const retainedTurns = new Set([...retained].map(message => message.turnId));
  const retainedTurnViews = groupTimelineFramesByTurn({ ...snapshot,
    frames: snapshot.frames.filter(frame => retainedTurns.has(frame.turnId)),
  });
  for (const turn of retainedTurnViews) {
    const plan = createTimelineTurnPresentationPlan(turn);
    const slots = plan.assistant?.slots ?? [];
    for (const frameType of ["assistant"] as const) {
      const resources = displayResources({
        hookStats: plan.assistantFrame?.hookStats,
        changeSummary: plan.assistant?.changeSummary,
      }, true);
      if (resources) resourcesByFrame.set(JSON.stringify([turn.turnId, frameType]), resources);
    }
    const regions: TimelinePresentationRegion[] = [];
    let nextContentBlockId: string | null = null;
    // Find each successor in one reverse pass, without copying every suffix.
    for (let index = slots.length - 1; index >= 0; index--) {
      const unit = slots[index]!;
      if (unit.type === "assistant-content") { nextContentBlockId = unit.block.id; continue; }
      if (unit.type !== "agent-activity") continue;
      const layout = resolveAgentActivityLayout(unit);
      if (layout.showToggle) {
        regions.push({ type: "activity", id: unit.id, beforeBlockId: nextContentBlockId,
          count: unit.collapsedItemCount, durationMs: unit.workedDurationMs, workStatus: completedWork(layout.workedForItem) });
      }
      // The former forward pass chose the last eligible work duration.
      if (!visibleDurations.has(turn.turnId) && unit.workedDurationMs != null
        && (layout.showToggle || unit.contentUnits.length === 0)) {
        visibleDurations.set(turn.turnId, unit.workedDurationMs);
      }
    }
    if (regions.length) regionsByTurn.set(turn.turnId, [...(parseRegions(regions.reverse()) ?? [])]);
  }
  const retainedAssistantTurns = new Set(messages.filter(message => retained.has(message) && message.frameType === "assistant").map(message => message.turnId));
  const attached = new Set<string>();
  let result = retainMessageRegions(messages.filter(message => retained.has(message)).map(message => {
    const regions = message.frameType === "assistant" && !attached.has(message.turnId) ? regionsByTurn.get(message.turnId) : undefined;
    if (regions?.length) attached.add(message.turnId);
    const resourceKey = JSON.stringify([message.turnId, message.frameType]);
    const resources = resourcesByFrame.get(resourceKey) ?? message.resources;
    resourcesByFrame.delete(resourceKey);
    const assistantKey = JSON.stringify([message.turnId, "assistant"]);
    const assistantResources = !retainedAssistantTurns.has(message.turnId) ? resourcesByFrame.get(assistantKey) : undefined;
    if (assistantResources) resourcesByFrame.delete(assistantKey);
    const durationMs = durationEligible.has(message)
      ? nonnegativeNumber(visibleDurations.get(message.turnId) ?? message.durationMs) : message.durationMs;
    return { ...message, durationMs, regions, resources, assistantResources };
  }));
  result = retainActivityRows(retainedTurnViews, result);
  return boundDisplayMessages(result);
}

/** Measure each message once, including JSON escaping. Re-serializing the whole
 * document for every eviction blocks input on long conversation snapshots. */
function boundDisplayMessages(messages: DisplayMessage[]): DisplayMessage[] {
  const limit = MAX_STORED_CHARACTERS - 1_024;
  const sizes = messages.map(message => JSON.stringify(message).length + 1);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  // Array brackets replace the final comma; an empty array occupies two chars.
  const exceedsBudget = () => Math.max(2, total + 1) > limit;
  // Optional tool summaries yield before any complete message body is removed.
  for (let index = 0; index < messages.length && exceedsBudget(); index++) {
    const message = messages[index]!;
    if (message.before === undefined && message.after === undefined) continue;
    const stripped = { ...message, before: undefined, after: undefined };
    const size = JSON.stringify(stripped).length + 1;
    total += size - sizes[index]!;
    sizes[index] = size;
    messages[index] = stripped;
  }
  // Preserve whole-Turn eviction order without serializing each remaining suffix.
  const turnSizes = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    const turnId = messages[index]!.turnId;
    turnSizes.set(turnId, (turnSizes.get(turnId) ?? 0) + sizes[index]!);
  }
  const omitted = new Set<string>();
  for (const [turnId, size] of turnSizes) {
    if (!exceedsBudget()) break;
    omitted.add(turnId);
    total -= size;
  }
  return omitted.size ? messages.filter(message => !omitted.has(message.turnId)) : messages;
}

function displayHeader(value: unknown): ConversationDisplayHeader | undefined {
  if (!value || typeof value !== "object" || !("title" in value) || !("project" in value)
    || typeof value.title !== "string" || !value.title.trim() || value.title.length > 512
    || typeof value.project !== "string" || value.project.length > 256) return undefined;
  return { title: value.title, project: value.project };
}

/** Attach bounded tool summaries only to retained adjacent content. Dropping a
 * message also drops its preceding activity: it must never migrate to a later reply. */
function retainActivityRows(turns: readonly TimelineTurnView[], messages: DisplayMessage[]): DisplayMessage[] {
  const byTurn = new Map<string, Map<string, DisplayMessage>>();
  for (const message of messages) {
    const rows = byTurn.get(message.turnId) ?? new Map();
    rows.set(message.block.id, message); byTurn.set(message.turnId, rows);
  }
  const attached = new Map<DisplayMessage, { before?: ConversationDisplayActivity[]; after?: ConversationDisplayActivity[] }>();
  let remaining = MAX_DISPLAY_ACTIVITIES;
  // Reserve the tail first, without normalizing discarded tool output or args.
  function* reverseBlocks(turn: TimelineTurnView): Generator<TimelineBlock> {
    for (let f = turn.frames.length - 1; f >= 0; f--) {
      const blocks = turn.frames[f]!.blocks;
      for (let b = blocks.length - 1; b >= 0; b--) yield blocks[b]!;
    }
  }
  for (let t = turns.length - 1; t >= 0 && remaining > 0; t--) {
    const turn = turns[t]!;
    if (!byTurn.has(turn.turnId)) continue;
    const selected = byTurn.get(turn.turnId)!;
    let next: DisplayMessage | undefined;
    let trailing: DisplayMessage | undefined;
    for (const block of reverseBlocks(turn)) {
      if (block.type === "text" || block.type === "reasoning" || block.type === "user-message") {
        next = selected.get(block.id); break;
      }
    }
    trailing = next; next = undefined;
    for (const block of reverseBlocks(turn)) {
      if (remaining === 0) break;
      if (block.type === "text" || block.type === "reasoning" || block.type === "user-message") {
        next = selected.get(block.id); trailing = undefined; continue;
      }
      const target = next ?? trailing;
      if (!target || target.frameType !== "assistant") continue;
      const preview = projectDisplayActivity(block);
      if (!preview) continue;
      remaining--;
      const entry = attached.get(target) ?? {};
      const field = trailing ? "after" : "before";
      (entry[field] ??= []).unshift(preview); attached.set(target, entry);
    }
  }
  return messages.map(message => ({ ...message, ...attached.get(message) }));
}

function parse(value: string | null, hostId: string, threadId: string, now: number): { messages: readonly DisplayMessage[]; savedAt: number; historyTurnCount?: number; header?: ConversationDisplayHeader } | null {
  if (value === null || value.length > MAX_STORED_CHARACTERS) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== VERSION || candidate.hostId !== hostId || candidate.threadId !== threadId
      || typeof candidate.savedAt !== "number" || !Number.isFinite(candidate.savedAt) || candidate.savedAt > now || now - candidate.savedAt > MAX_AGE_MS
      || !Array.isArray(candidate.messages) || candidate.messages.length > MAX_MESSAGES) return null;
    const messages: DisplayMessage[] = [];
    let activityCount = 0;
    for (const item of candidate.messages) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
      const message = item as Record<string, unknown>;
      const block = parseConversationDisplayBlock(message.block);
      if (!block || typeof message.turnId !== "string" || message.turnId.length > 256
        || (message.frameType !== "user" && message.frameType !== "assistant")) return null;
      const activities = (value: unknown): ConversationDisplayActivity[] => {
        if (value === undefined) return [];
        if (!Array.isArray(value) || value.length > MAX_DISPLAY_ACTIVITIES) throw new Error("Invalid display activities");
        return value.map(item => {
          const activity = parseDisplayActivity(item);
          if (!activity || ++activityCount > MAX_DISPLAY_ACTIVITIES) throw new Error("Invalid display activity");
          return activity;
        });
      };
      const before = activities(message.before), after = activities(message.after);
      messages.push({ turnId: message.turnId, frameType: message.frameType, block,
        ...(before.length ? { before } : {}), ...(after.length ? { after } : {}),
        durationMs: nonnegativeNumber(message.durationMs), workStatus: completedWork(message.workStatus), regions: parseRegions(message.regions), resources: displayResources(message.resources), assistantResources: displayResources(message.assistantResources) });
    }
    return { messages: retainMessageRegions(messages), savedAt: candidate.savedAt, header: displayHeader(candidate.header), historyTurnCount: Number.isSafeInteger(candidate.historyTurnCount) && Number(candidate.historyTurnCount) >= 0 ? Number(candidate.historyTurnCount) : undefined };
  } catch { return null; }
}

/** Recreates a paint-only Timeline; no Replica cursor, command or interaction is restored. */
function paint(hostId: string, threadId: string, messages: readonly DisplayMessage[]): TimelineSnapshot {
  const key = createConversationKey(hostId, threadId);
  // Work is a Turn resource. Cached activity and reply text are separate frames,
  // while the shared Turn presenter reads its resource from the first assistant.
  const workByTurn = new Map(messages.flatMap(message => message.workStatus === null
    ? [] : [[message.turnId, message.workStatus] as const]));
  return {
    key,
    revision: 0,
    phase: "painted",
    authoritative: false,
    frames: messages.flatMap((message, index) => [{
      type: message.frameType,
      id: "cached:" + index + ":" + message.block.id,
      turnId: asTurnId(message.turnId),
      status: "complete" as const,
      durationMs: message.durationMs,
      displayDurationMs: message.durationMs,
      workStatus: message.frameType === "assistant" ? workByTurn.get(message.turnId) ?? null : null,
      presentationRegions: message.regions,
      hookStats: message.resources?.hookStats ?? null,
      changeSummary: message.resources?.changeSummary,
      anchors: [],
      blocks: [...message.before ?? [], message.block, ...message.after ?? []],
    }, ...(message.assistantResources ? [{
      type: "assistant" as const, id: `cached-resources:${message.turnId}`, turnId: asTurnId(message.turnId),
      status: "complete" as const, durationMs: null,
      hookStats: message.assistantResources.hookStats, changeSummary: message.assistantResources.changeSummary,
      anchors: [], blocks: [],
    }] : [])]),
    anchorFrameIds: new Map(),
  };
}

export function createConversationDisplayContinuity(input: {
  readonly namespace: string;
  readonly storage: ConversationDisplayStorage;
  readonly now?: () => number;
}): ConversationDisplayContinuity {
  if (!input.namespace.trim()) throw new RangeError("Display namespace is required");
  const now = input.now ?? Date.now;
  const pending = new Map<string, Promise<void>>();
  // Streaming observations replace the queued value instead of accumulating a
  // storage write for every delta while a slower platform adapter is saving.
  const queued = new Map<string, { value: string | null; projection: string }>();
  // Persistence deduplication is not an authority/version fence. A failed write
  // may clear this record to permit retry, without making any old read valid.
  const writeProjection = new Map<string, string>();
  const reads = new Map<string, { invalidated: boolean; promise: Promise<TimelineSnapshot | null> }>();
  const submissions = new Map<string, TimelineSnapshot>();
  const displays = createConversationDisplayCache<{ savedAt: number; projection: string; timeline: TimelineSnapshot | null }>(now);
  const remember = (key: string, messages: readonly DisplayMessage[], hostId: string, threadId: string, savedAt = now(), historyTurnCount?: number,
    header?: ConversationDisplayHeader, projection = JSON.stringify([messages, historyTurnCount, header])) => {
    const previous = displays.get(key);
    displays.delete(key);
    // An authoritative empty transcript is a resident tombstone, not a miss.
    // Failed storage removal must not resurrect old content on the next load.
    const timeline = !messages.length ? null : previous?.projection === projection
      ? previous.timeline : { ...paint(hostId, threadId, messages), historyTurnCount, displayHeader: header };
    displays.set(key, { savedAt, projection, timeline });
    return timeline;
  };
  const resident = (hostId: string, threadId: string) => {
    const key = storageKey(input.namespace, hostId, threadId), entry = displays.get(key);
    if (!entry) return null;
    if (now() < entry.savedAt || now() - entry.savedAt > MAX_AGE_MS) { displays.delete(key); return null; }
    return entry;
  };
  const peek = (hostId: string, threadId: string) => resident(hostId, threadId)?.timeline ?? null;
  return {
    retainSubmission(intent, receipt, sender) {
      if (intent.target.type !== "new-thread" || intent.target.execution.hostId !== receipt.hostId
        || intent.clientMessageId !== receipt.clientMessageId || intent.commandId !== receipt.commandId) {
        throw new Error("First submission display does not match its Thread receipt");
      }
      const key = storageKey(input.namespace, receipt.hostId, receipt.threadId);
      if (submissions.has(key)) return;
      submissions.set(key, {
        key: createConversationKey(receipt.hostId, receipt.threadId), revision: 0,
        phase: "painted", authoritative: false, anchorFrameIds: new Map(),
        frames: [{ type: "user", id: `submitted:${intent.clientMessageId}`,
          turnId: asTurnId(receipt.turnId ?? `submitted:${intent.clientMessageId}`),
          status: "complete", durationMs: null, hookStats: null, anchors: [],
          blocks: [submittedMessageDisplay(intent, receipt.sender === undefined ? sender : receipt.sender)],
        }],
      });
      // A small transient handoff, not another durable conversation store.
      if (submissions.size > 64) submissions.delete(submissions.keys().next().value!);
    },
    peekSubmission(hostId, threadId) {
      return submissions.get(storageKey(input.namespace, hostId, threadId)) ?? null;
    },
    peek,
    async load(hostId, threadId) {
      const memory = resident(hostId, threadId);
      if (memory !== null) return memory.timeline;
      const key = storageKey(input.namespace, hostId, threadId);
      const existing = reads.get(key);
      if (existing) return existing.promise;
      // Only in-flight reads own these receipts; they cannot accumulate with
      // visited conversations. Coalescing prevents older reads racing newer ones.
      const read = { invalidated: false, promise: Promise.resolve<TimelineSnapshot | null>(null) };
      read.promise = Promise.resolve().then(async () => {
        await pending.get(key)?.catch(() => undefined);
        if (read.invalidated) return peek(hostId, threadId);
        try {
          const value = await input.storage.load(key);
          if (read.invalidated) return peek(hostId, threadId);
          const stored = parse(value, hostId, threadId, now());
          return stored?.messages.length ? remember(key, stored.messages, hostId, threadId, stored.savedAt, stored.historyTurnCount, stored.header) : null;
        } catch { return peek(hostId, threadId); }
      }).finally(() => { if (reads.get(key) === read) reads.delete(key); });
      reads.set(key, read);
      return read.promise;
    },
    observe(snapshot, historyHasOlder, header) {
      if (!snapshot.authoritative) return Promise.resolve();
      const key = storageKey(input.namespace, snapshot.key.hostId, snapshot.key.threadId);
      const reading = reads.get(key);
      if (reading) reading.invalidated = true;
      const unplaced = snapshot.unplacedSearchTurnId;
      const outside = snapshot.outsideHistoryWindowTurnIds;
      const history = outside ? { ...snapshot, frames: snapshot.frames.filter(frame => !outside.has(frame.turnId)) } : snapshot;
      const cached = peek(snapshot.key.hostId, snapshot.key.threadId);
      // An empty baseline can arrive before the first Turn is submitted. Keep
      // its local presentation until the canonical user message can replace it.
      if (history.frames.some(frame => frame.turnId !== unplaced && frame.blocks.some(block => block.type === "user-message"
        && block.messageKind === "user"))) submissions.delete(key);
      const display = selectConversationDisplay({ key: snapshot.key, timeline: history, cached, historyHasOlder });
      const messages = projectMessages(display.timeline ?? history);
      const retainedHeader = displayHeader(header) ?? cached?.displayHeader;
      const projection = JSON.stringify([messages, snapshot.historyTurnCount, retainedHeader]);
      // Residency/expiry is independent of whether this content needs saving.
      remember(key, messages, snapshot.key.hostId, snapshot.key.threadId, now(), snapshot.historyTurnCount, retainedHeader, projection);
      if (writeProjection.get(key) === projection) return pending.get(key) ?? Promise.resolve();
      writeProjection.set(key, projection);
      const value = JSON.stringify({ version: VERSION, hostId: snapshot.key.hostId,
        threadId: snapshot.key.threadId, savedAt: now(), messages, historyTurnCount: snapshot.historyTurnCount, header: retainedHeader });
      queued.set(key, { value: messages.length ? value : null, projection });
      const writing = pending.get(key);
      if (writing) return writing;
      const next = Promise.resolve().then(async () => {
        let failure: unknown;
        while (queued.has(key)) {
          const update = queued.get(key)!;
          queued.delete(key);
          try {
            if (update.value === null) await input.storage.remove(key);
            else await input.storage.save(key, update.value);
            failure = undefined;
          } catch (error) {
            failure = error;
            if (writeProjection.get(key) === update.projection) writeProjection.delete(key);
          }
        }
        pending.delete(key);
        if (failure !== undefined) throw failure;
      });
      pending.set(key, next);
      void next.catch(() => undefined);
      return next;
    },
  };
}
