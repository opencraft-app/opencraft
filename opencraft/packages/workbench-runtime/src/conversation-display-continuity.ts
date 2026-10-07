import { createConversationKey, type TimelineSnapshot } from "@opencraft/chat-core";

export interface ConversationDisplayStorage {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ConversationDisplayContinuity {
  load(hostId: string, threadId: string): Promise<TimelineSnapshot | null>;
  observe(snapshot: TimelineSnapshot): Promise<void>;
}

interface DisplayMessage {
  readonly id: string;
  readonly turnId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
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

function projectMessages(snapshot: TimelineSnapshot): readonly DisplayMessage[] {
  const messages: DisplayMessage[] = [];
  for (const frame of snapshot.frames) {
    if (frame.status !== "complete") continue;
    if (frame.type === "user") {
      for (const block of frame.blocks) {
        if (block.type !== "user-message" || block.messageKind !== "user" || !block.message.trim()) continue;
        messages.push({ id: block.id, turnId: frame.turnId, role: "user", text: block.message.slice(0, MAX_MESSAGE_CHARACTERS) });
      }
    } else if (frame.type === "assistant") {
      for (const block of frame.blocks) {
        if (block.type !== "text" || block.streaming || block.phase === "commentary" || !block.text.trim()) continue;
        messages.push({ id: block.id, turnId: frame.turnId, role: "assistant", text: block.text.slice(0, MAX_MESSAGE_CHARACTERS) });
      }
    }
  }
  return messages.slice(-MAX_MESSAGES);
}

function parse(value: string | null, hostId: string, threadId: string, now: number): readonly DisplayMessage[] | null {
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
      messages.push({ id: message.id, turnId: message.turnId, role: message.role, text: message.text });
    }
    return messages;
  } catch { return null; }
}

/** Recreates a paint-only Timeline; no Replica cursor, command or interaction is restored. */
function paint(hostId: string, threadId: string, messages: readonly DisplayMessage[]): TimelineSnapshot {
  const key = createConversationKey(hostId, threadId);
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
      durationMs: null,
      hookStats: null,
      anchors: [],
      blocks: message.role === "user"
        ? [{
            type: "user-message" as const, id: message.id, sourceItemIds: [], message: message.text,
            content: [{ type: "text" as const, text: message.text, textElements: [] }], attachments: [],
            messageKind: "user" as const, clientId: null, steeringStatus: null, sentAtMs: null,
            deliveryStatus: "sent" as const, referencesPriorConversation: false, reviewMode: false,
            pullRequestFixMode: false, autoResolveSync: false, goal: false, hookFeedback: false,
            commentCount: 0, hasExternalAttachments: false,
          }]
        : [{ type: "text" as const, id: message.id, sourceItemIds: [], text: message.text,
            streaming: false, completed: true, phase: "final_answer" as const }],
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
  const lastProjection = new Map<string, string>();
  return {
    async load(hostId, threadId) {
      const key = storageKey(input.namespace, hostId, threadId);
      await pending.get(key)?.catch(() => undefined);
      try {
        const messages = parse(await input.storage.load(key), hostId, threadId, now());
        return messages?.length ? paint(hostId, threadId, messages) : null;
      } catch { return null; }
    },
    observe(snapshot) {
      if (!snapshot.authoritative) return Promise.resolve();
      const key = storageKey(input.namespace, snapshot.key.hostId, snapshot.key.threadId);
      const messages = projectMessages(snapshot);
      const projection = JSON.stringify(messages);
      if (lastProjection.get(key) === projection) return pending.get(key) ?? Promise.resolve();
      lastProjection.set(key, projection);
      const value = JSON.stringify({ version: VERSION, hostId: snapshot.key.hostId,
        threadId: snapshot.key.threadId, savedAt: now(), messages });
      const previous = pending.get(key) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => messages.length
        ? input.storage.save(key, value)
        : input.storage.remove(key));
      pending.set(key, next);
      void next.catch(() => { if (lastProjection.get(key) === projection) lastProjection.delete(key); });
      void next.finally(() => { if (pending.get(key) === next) pending.delete(key); }).catch(() => undefined);
      return next;
    },
  };
}
