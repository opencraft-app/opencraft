import { asTurnId, createConversationKey, createTimelineTurnPresentationPlan, groupTimelineFramesByTurn, resolveAgentActivityLayout, type TimelineSnapshot, type UserMessageTimelineBlock, type WorkStatusItem } from "@opencraft/chat-core";

import type { SubmissionReceipt, SubmitIntent } from "@opencraft/composer-core";
import { submittedMessageDisplay } from "./submitted-message-display";

export interface ConversationDisplayStorage {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ConversationDisplayContinuity {
  /** Synchronous, account-scoped handoff; never persisted or command-capable. */
  retainSubmission(intent: SubmitIntent, receipt: SubmissionReceipt): void;
  peekSubmission(hostId: string, threadId: string): TimelineSnapshot | null;
  /** Bounded paint-only memory, available during render; never grants authority. */
  peek(hostId: string, threadId: string): TimelineSnapshot | null;
  load(hostId: string, threadId: string): Promise<TimelineSnapshot | null>;
  observe(snapshot: TimelineSnapshot): Promise<void>;
}

interface DisplayMessage {
  readonly id: string;
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly kind: "text" | "reasoning";
  readonly phase: "commentary" | "final_answer";
  readonly completed: boolean;
  readonly sentAtMs: number | null;
  readonly durationMs: number | null;
  readonly workStatus: WorkStatusItem | null;
  readonly sender?: UserMessageTimelineBlock["sender"];
}

const VERSION = 1;
const MAX_MESSAGES = 24;
const MAX_MESSAGE_CHARACTERS = 2_048;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

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

function messageSender(value: unknown): UserMessageTimelineBlock["sender"] {
  if (typeof value !== "object" || value === null) return null;
  const sender = value as Record<string, unknown>;
  return sender.kind === "employee" && typeof sender.loginName === "string"
    && sender.loginName.trim().length > 0 && sender.loginName.length <= 256
    ? { kind: "employee", loginName: sender.loginName } : null;
}

function projectMessages(snapshot: TimelineSnapshot): readonly DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  const visibleDurations = new Map<string, number>();
  for (const turn of groupTimelineFramesByTurn(snapshot)) {
    const plan = createTimelineTurnPresentationPlan(turn);
    for (const unit of plan.assistant?.slots ?? []) {
      if (unit.type === "agent-activity" && unit.workedDurationMs != null
        && (resolveAgentActivityLayout(unit).showToggle || unit.contentUnits.length === 0)) {
        visibleDurations.set(turn.turnId, unit.workedDurationMs);
      }
    }
  }
  for (const frame of snapshot.frames) {
    const active = frame.status === "pending" || frame.status === "streaming";
    if (frame.type === "user") {
      for (const block of frame.blocks) {
        if (block.type !== "user-message" || block.messageKind !== "user" || !block.message.trim()) continue;
        messages.push({ id: block.id, turnId: frame.turnId, role: "user", text: block.message.slice(0, MAX_MESSAGE_CHARACTERS),
          kind: "text", phase: "final_answer", completed: true,
          sentAtMs: nonnegativeNumber(block.sentAtMs), durationMs: null, workStatus: null, sender: messageSender(block.sender) });
      }
    } else if (frame.type === "assistant") {
      for (const block of frame.blocks) {
        if (block.type === "reasoning" && active) {
          const text = block.summary.trim() || block.detail?.trim();
          if (text) messages.push({ id: block.id, turnId: frame.turnId, role: "assistant", text: text.slice(0, MAX_MESSAGE_CHARACTERS),
            kind: "reasoning", phase: "commentary", completed: false,
            sentAtMs: null, durationMs: null, workStatus: null });
          continue;
        }
        if (block.type !== "text" || (!active && (block.streaming || block.phase === "commentary")) || !block.text.trim()) continue;
        messages.push({ id: block.id, turnId: frame.turnId, role: "assistant", text: block.text.slice(0, MAX_MESSAGE_CHARACTERS),
          kind: "text", phase: block.phase === "commentary" ? "commentary" : "final_answer",
          completed: active ? block.completed === true : true,
          sentAtMs: nonnegativeNumber(block.sentAtMs), durationMs: active ? null : nonnegativeNumber(visibleDurations.get(frame.turnId) ?? (completedWork(frame.workStatus) === null ? null : frame.durationMs)),
          // Work may finish when the final reply begins, before the Turn ends.
          // Its observed end is static even while that reply is still streaming.
          workStatus: block.phase === "commentary" ? null : completedWork(frame.workStatus) });
      }
    }
  }
  // A long active Turn can contain dozens of reasoning/commentary blocks.
  // A raw tail drops the question and previous replies (including their clocks)
  // even though they remain the conversation the user is resuming.
  const conversation = messages.filter(message => message.role === "user"
    || (message.kind === "text" && (message.phase === "final_answer"
      || message.sentAtMs !== null || message.workStatus !== null)));
  const latest = (matches: (message: DisplayMessage) => boolean) => {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (matches(messages[index]!)) return messages[index];
    }
    return undefined;
  };
  const retained = new Set([
    latest(message => message.role === "user"),
    latest(message => message.role === "assistant" && message.sentAtMs !== null),
    latest(message => message.workStatus !== null),
  ].filter((message): message is DisplayMessage => message !== undefined));
  for (let index = conversation.length - 1; index >= 0 && retained.size < Math.floor(MAX_MESSAGES / 2); index--) {
    retained.add(conversation[index]!);
  }
  for (let index = messages.length - 1; index >= 0 && retained.size < MAX_MESSAGES; index--) {
    retained.add(messages[index]!);
  }
  // Keep source order; choosing a bounded subset never creates a new chronology.
  return messages.filter(message => retained.has(message));
}

function parse(value: string | null, hostId: string, threadId: string, now: number): { messages: readonly DisplayMessage[]; savedAt: number } | null {
  if (value === null || value.length > 64 * 1_024) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== VERSION || candidate.hostId !== hostId || candidate.threadId !== threadId
      || typeof candidate.savedAt !== "number" || candidate.savedAt > now || now - candidate.savedAt > MAX_AGE_MS
      || !Array.isArray(candidate.messages) || candidate.messages.length > MAX_MESSAGES) return null;
    const messages: DisplayMessage[] = [];
    for (const item of candidate.messages) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
      const message = item as Record<string, unknown>;
      if (typeof message.id !== "string" || message.id.length > 256
        || typeof message.turnId !== "string" || message.turnId.length > 256
        || (message.role !== "user" && message.role !== "assistant")
        || typeof message.text !== "string" || message.text.length > MAX_MESSAGE_CHARACTERS) return null;
      messages.push({ id: message.id, turnId: message.turnId, role: message.role, text: message.text,
        kind: message.kind === "reasoning" ? "reasoning" : "text",
        phase: message.phase === "commentary" ? "commentary" : "final_answer",
        completed: message.completed !== false,
        sentAtMs: nonnegativeNumber(message.sentAtMs), durationMs: nonnegativeNumber(message.durationMs),
        workStatus: message.role === "assistant" ? completedWork(message.workStatus) : null,
        sender: message.role === "user" ? messageSender(message.sender) : null });
    }
    return { messages, savedAt: candidate.savedAt };
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
    frames: messages.map((message, index) => ({
      type: message.role,
      id: `cached:${index}:${message.id}`,
      turnId: message.turnId as TimelineSnapshot["frames"][number]["turnId"],
      status: "complete" as const,
      durationMs: message.durationMs,
      displayDurationMs: message.durationMs,
      workStatus: message.role === "assistant" ? workByTurn.get(message.turnId) ?? null : null,
      hookStats: null,
      anchors: [],
      blocks: message.role === "user"
        ? [{
            type: "user-message" as const, id: message.id, sourceItemIds: [], message: message.text,
            content: [{ type: "text" as const, text: message.text, textElements: [] }], attachments: [],
            messageKind: "user" as const, clientId: null, steeringStatus: null, sentAtMs: message.sentAtMs,
            sender: message.sender,
            deliveryStatus: "sent" as const, referencesPriorConversation: false, reviewMode: false,
            pullRequestFixMode: false, autoResolveSync: false, goal: false, hookFeedback: false,
            commentCount: 0, hasExternalAttachments: false,
          }]
        : message.kind === "reasoning"
          ? [{ type: "reasoning" as const, id: message.id, sourceItemIds: [], summary: message.text, detail: null, streaming: false }]
          : [{ type: "text" as const, id: message.id, sourceItemIds: [], text: message.text,
              streaming: false, completed: message.completed, phase: message.phase, sentAtMs: message.sentAtMs }],
    })),
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
  const lastProjection = new Map<string, string>();
  const submissions = new Map<string, TimelineSnapshot>();
  const displays = new Map<string, { savedAt: number; timeline: TimelineSnapshot }>();
  const remember = (key: string, messages: readonly DisplayMessage[], hostId: string, threadId: string, savedAt = now()) => {
    displays.delete(key);
    if (!messages.length) return null;
    const timeline = paint(hostId, threadId, messages);
    displays.set(key, { savedAt, timeline });
    if (displays.size > 64) displays.delete(displays.keys().next().value!);
    return timeline;
  };
  const peek = (hostId: string, threadId: string) => {
    const key = storageKey(input.namespace, hostId, threadId), entry = displays.get(key);
    if (!entry) return null;
    if (now() < entry.savedAt || now() - entry.savedAt > MAX_AGE_MS) { displays.delete(key); return null; }
    return entry.timeline;
  };
  return {
    retainSubmission(intent, receipt) {
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
          blocks: [submittedMessageDisplay(intent)],
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
      const memory = peek(hostId, threadId);
      if (memory !== null) return memory;
      const key = storageKey(input.namespace, hostId, threadId);
      const observed = lastProjection.get(key);
      await pending.get(key)?.catch(() => undefined);
      try {
        const stored = parse(await input.storage.load(key), hostId, threadId, now());
        // An authoritative observation during I/O always wins over an old read.
        if (lastProjection.get(key) !== observed) return peek(hostId, threadId);
        return stored?.messages.length ? remember(key, stored.messages, hostId, threadId, stored.savedAt) : null;
      } catch { return null; }
    },
    observe(snapshot) {
      if (!snapshot.authoritative) return Promise.resolve();
      const key = storageKey(input.namespace, snapshot.key.hostId, snapshot.key.threadId);
      // An empty baseline can arrive before the first Turn is submitted. Keep
      // its local presentation until the canonical user message can replace it.
      if (snapshot.frames.some(frame => frame.blocks.some(block => block.type === "user-message"
        && block.messageKind === "user"))) submissions.delete(key);
      const messages = projectMessages(snapshot);
      const projection = JSON.stringify(messages);
      if (lastProjection.get(key) === projection) return pending.get(key) ?? Promise.resolve();
      lastProjection.set(key, projection);
      remember(key, messages, snapshot.key.hostId, snapshot.key.threadId);
      const value = JSON.stringify({ version: VERSION, hostId: snapshot.key.hostId,
        threadId: snapshot.key.threadId, savedAt: now(), messages });
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
            if (lastProjection.get(key) === update.projection) lastProjection.delete(key);
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
