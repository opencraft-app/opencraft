import type { QueuedSubmission } from "./types";

export interface HermesComposerQueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface HermesComposerQueueStore {
  read(threadId: string): QueuedSubmission[];
  replace(threadId: string, submissions: readonly QueuedSubmission[]): void;
  subscribe(listener: (threadId: string) => void): () => void;
  dispose(): void;
}

type QueueState = Record<string, QueuedSubmission[]>;

const STORAGE_PREFIX = "vela.plugin.lightvela-hermes.composerQueue.v1";

function cloneSubmission(submission: QueuedSubmission): QueuedSubmission {
  return {
    id: submission.id,
    input: structuredClone(submission.input),
    clientUserMessageId: submission.clientUserMessageId,
  };
}

function validSubmission(value: unknown): value is QueuedSubmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Partial<QueuedSubmission>;
  return typeof row.id === "string"
    && row.id.trim() !== ""
    && Array.isArray(row.input)
    && typeof row.clientUserMessageId === "string";
}

function parseState(raw: string | null): QueueState {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const state: QueueState = {};
    for (const [threadId, value] of Object.entries(parsed)) {
      if (threadId.trim() === "" || !Array.isArray(value)) continue;
      const queue = value.filter(validSubmission).map(cloneSubmission);
      if (queue.length > 0) state[threadId] = queue;
    }
    return state;
  } catch {
    return {};
  }
}

/**
 * Hermes Desktop keeps the editable composer queue in renderer storage rather
 * than pretending it is durable Gateway state. This store preserves that
 * ownership while giving the AppServer adapter a deterministic in-memory
 * fallback when browser storage is unavailable or over quota.
 */
export class LocalStorageHermesComposerQueueStore implements HermesComposerQueueStore {
  readonly storageKey: string;
  private state: QueueState;
  private readonly listeners = new Set<(threadId: string) => void>();
  private readonly onStorage = (event: Event): void => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key !== this.storageKey) return;
    const previous = this.state;
    const next = parseState(storageEvent.newValue);
    this.state = next;
    for (const threadId of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (JSON.stringify(previous[threadId] ?? []) !== JSON.stringify(next[threadId] ?? [])) {
        this.publish(threadId);
      }
    }
  };

  constructor(
    scope: string,
    private readonly storage?: HermesComposerQueueStorage,
    private readonly eventTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  ) {
    const normalizedScope = scope.trim() || "default";
    this.storageKey = `${STORAGE_PREFIX}:${normalizedScope}`;
    let raw: string | null = null;
    try {
      raw = storage?.getItem(this.storageKey) ?? null;
    } catch {
      // Sandboxed/private contexts can deny localStorage entirely.
    }
    this.state = parseState(raw);
    this.eventTarget?.addEventListener("storage", this.onStorage);
  }

  read(threadId: string): QueuedSubmission[] {
    return (this.state[threadId] ?? []).map(cloneSubmission);
  }

  replace(threadId: string, submissions: readonly QueuedSubmission[]): void {
    const current = this.state;
    const next = { ...current };
    if (submissions.length === 0) delete next[threadId];
    else next[threadId] = submissions.map(cloneSubmission);
    this.state = next;
    try {
      if (Object.keys(next).length === 0) this.storage?.removeItem(this.storageKey);
      else this.storage?.setItem(this.storageKey, JSON.stringify(next));
    } catch {
      // Persistence is best-effort. The queue remains live in memory.
    }
    this.publish(threadId);
  }

  subscribe(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.eventTarget?.removeEventListener("storage", this.onStorage);
    this.listeners.clear();
  }

  private publish(threadId: string): void {
    for (const listener of this.listeners) listener(threadId);
  }
}

export class MemoryHermesComposerQueueStore extends LocalStorageHermesComposerQueueStore {
  constructor() {
    super("memory");
  }
}

export function browserHermesComposerQueueStore(
  scope: string,
  storage?: HermesComposerQueueStorage,
): HermesComposerQueueStore {
  let resolvedStorage = storage;
  if (resolvedStorage === undefined) {
    try {
      resolvedStorage = globalThis.localStorage;
    } catch {
      // Browser policy may reject even reading the localStorage property.
    }
  }
  const eventTarget = typeof globalThis.addEventListener === "function"
    ? globalThis
    : undefined;
  return new LocalStorageHermesComposerQueueStore(scope, resolvedStorage, eventTarget);
}
