import type { QueuedSubmission } from "../types";

export interface HermesComposerQueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface HermesComposerQueueService {
  read(threadId: string): QueuedSubmission[];
  add(threadId: string, submission: QueuedSubmission): Promise<QueuedSubmission>;
  update(
    threadId: string,
    submissionId: string,
    update: (submission: QueuedSubmission) => QueuedSubmission,
  ): Promise<QueuedSubmission>;
  remove(threadId: string, submissionId: string): Promise<boolean>;
  reorder(threadId: string, submissionIds: readonly string[]): Promise<void>;
  pause(threadId: string, submissionId: string, reason: string): Promise<void>;
  pauseAll(threadId: string, reason: string): Promise<void>;
  resume(threadId: string, submissionId: string): Promise<void>;
  withConsumptionLease<T>(
    threadId: string,
    submissionId: string,
    consume: (submission: QueuedSubmission) => Promise<T>,
  ): Promise<{ readonly acquired: false } | { readonly acquired: true; readonly value: T }>;
  subscribe(listener: (threadId: string) => void): () => void;
  dispose(): void;
}

interface QueueDocument {
  readonly revision: number;
  readonly queues: Readonly<Record<string, readonly QueuedSubmission[]>>;
}

interface WebLockLike {}

interface WebLocksLike {
  request<T>(
    name: string,
    options: { readonly mode: "exclusive"; readonly ifAvailable?: boolean },
    callback: (lock: WebLockLike | null) => T | Promise<T>,
  ): Promise<T>;
}

const STORAGE_PREFIX = "vela.plugin.lightvela-hermes.composerQueue.v2";
const inProcessLocks = new Map<string, Promise<void>>();

function cloneSubmission(submission: QueuedSubmission): QueuedSubmission {
  return {
    id: submission.id,
    input: structuredClone(submission.input),
    clientUserMessageId: submission.clientUserMessageId,
    createdAt: submission.createdAt,
    pausedReason: submission.pausedReason,
  };
}

function validSubmission(value: unknown): value is QueuedSubmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Partial<QueuedSubmission>;
  return typeof row.id === "string"
    && row.id.trim() !== ""
    && Array.isArray(row.input)
    && typeof row.clientUserMessageId === "string"
    && typeof row.createdAt === "number"
    && Number.isFinite(row.createdAt)
    && (row.pausedReason === null || typeof row.pausedReason === "string");
}

function emptyDocument(): QueueDocument {
  return { revision: 0, queues: {} };
}

function parseDocument(raw: string | null): QueueDocument {
  if (raw === null) return emptyDocument();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptyDocument();
    const row = parsed as { revision?: unknown; queues?: unknown };
    if (typeof row.revision !== "number" || !Number.isFinite(row.revision)
      || typeof row.queues !== "object" || row.queues === null || Array.isArray(row.queues)) {
      return emptyDocument();
    }
    const queues: Record<string, QueuedSubmission[]> = {};
    for (const [threadId, value] of Object.entries(row.queues)) {
      if (threadId.trim() === "" || !Array.isArray(value)) continue;
      const queue = value.filter(validSubmission).map(cloneSubmission);
      if (queue.length > 0) queues[threadId] = queue;
    }
    return { revision: row.revision, queues };
  } catch {
    return emptyDocument();
  }
}

async function withInProcessLock<T>(name: string, action: () => Promise<T>): Promise<T> {
  const previous = inProcessLocks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  inProcessLocks.set(name, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (inProcessLocks.get(name) === tail) inProcessLocks.delete(name);
  }
}

function browserLocks(): WebLocksLike | null {
  const navigatorValue = (globalThis as { navigator?: { locks?: WebLocksLike } }).navigator;
  return navigatorValue?.locks ?? null;
}

/**
 * Browser-backed implementation of Codex's queued-follow-up owner.
 *
 * The service owns persistence revision, per-item pause state and the single
 * consumption lease. Adapters may translate a claimed item to Hermes, but may
 * never independently decide that the item was consumed.
 */
export class BrowserHermesComposerQueueService implements HermesComposerQueueService {
  readonly storageKey: string;
  private document: QueueDocument;
  private readonly listeners = new Set<(threadId: string) => void>();
  private readonly lockPrefix: string;
  private readonly onStorage = (event: Event): void => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key !== this.storageKey) return;
    const next = parseDocument(storageEvent.newValue);
    if (next.revision <= this.document.revision) return;
    const previous = this.document;
    this.document = next;
    this.publishChangedThreads(previous, next);
  };

  constructor(
    scope: string,
    private readonly storage?: HermesComposerQueueStorage,
    private readonly eventTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  ) {
    const normalizedScope = scope.trim() || "default";
    this.storageKey = `${STORAGE_PREFIX}:${normalizedScope}`;
    this.lockPrefix = `lightvela-hermes-composer-queue:${normalizedScope}`;
    this.document = this.readStoredDocument();
    this.eventTarget?.addEventListener("storage", this.onStorage);
  }

  read(threadId: string): QueuedSubmission[] {
    this.refreshFromStorage();
    return (this.document.queues[threadId] ?? []).map(cloneSubmission);
  }

  async add(threadId: string, submission: QueuedSubmission): Promise<QueuedSubmission> {
    return await this.mutate(threadId, (queue) => {
      if (queue.some((candidate) => candidate.id === submission.id
        || candidate.clientUserMessageId === submission.clientUserMessageId)) {
        throw new Error(`Hermes queued submission already exists: ${submission.id}`);
      }
      const added = cloneSubmission(submission);
      queue.push(added);
      return added;
    });
  }

  async update(
    threadId: string,
    submissionId: string,
    update: (submission: QueuedSubmission) => QueuedSubmission,
  ): Promise<QueuedSubmission> {
    return await this.mutate(threadId, (queue) => {
      const index = queue.findIndex((candidate) => candidate.id === submissionId);
      if (index < 0) throw new Error(`Hermes queued submission not found: ${submissionId}`);
      const updated = cloneSubmission(update(cloneSubmission(queue[index]!)));
      if (updated.id !== submissionId) throw new Error("A queued submission update cannot replace its identity");
      queue[index] = updated;
      return updated;
    });
  }

  async remove(threadId: string, submissionId: string): Promise<boolean> {
    return await this.mutate(threadId, (queue) => {
      const index = queue.findIndex((candidate) => candidate.id === submissionId);
      if (index < 0) return false;
      queue.splice(index, 1);
      return true;
    });
  }

  async reorder(threadId: string, submissionIds: readonly string[]): Promise<void> {
    await this.mutate(threadId, (queue) => {
      if (submissionIds.length !== queue.length || new Set(submissionIds).size !== queue.length) {
        throw new Error("queuedSubmissionIds must contain every queued submission exactly once");
      }
      const byId = new Map(queue.map((submission) => [submission.id, submission]));
      const reordered = submissionIds.map((id) => {
        const submission = byId.get(id);
        if (submission === undefined) throw new Error(`Hermes queued submission not found: ${id}`);
        return submission;
      });
      queue.splice(0, queue.length, ...reordered);
    });
  }

  async pause(threadId: string, submissionId: string, reason: string): Promise<void> {
    await this.update(threadId, submissionId, (submission) => ({ ...submission, pausedReason: reason }));
  }

  async pauseAll(threadId: string, reason: string): Promise<void> {
    await this.mutate(threadId, (queue) => {
      for (let index = 0; index < queue.length; index += 1) {
        queue[index] = { ...queue[index]!, pausedReason: reason };
      }
    });
  }

  async resume(threadId: string, submissionId: string): Promise<void> {
    await this.update(threadId, submissionId, (submission) => ({ ...submission, pausedReason: null }));
  }

  async withConsumptionLease<T>(
    threadId: string,
    submissionId: string,
    consume: (submission: QueuedSubmission) => Promise<T>,
  ): Promise<{ readonly acquired: false } | { readonly acquired: true; readonly value: T }> {
    return await this.withExclusive(`${this.lockPrefix}:consume:${threadId}`, true, async (lock) => {
      if (!lock) return { acquired: false } as const;
      const submission = this.read(threadId).find((candidate) => candidate.id === submissionId);
      if (submission === undefined) return { acquired: false } as const;
      return { acquired: true, value: await consume(submission) } as const;
    });
  }

  subscribe(listener: (threadId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.eventTarget?.removeEventListener("storage", this.onStorage);
    this.listeners.clear();
  }

  private async mutate<T>(threadId: string, mutate: (queue: QueuedSubmission[]) => T): Promise<T> {
    return await this.withExclusive(`${this.lockPrefix}:state`, false, async () => {
      const previous = this.readStoredDocument();
      const queues: Record<string, QueuedSubmission[]> = Object.fromEntries(
        Object.entries(previous.queues).map(([id, queue]) => [id, queue.map(cloneSubmission)]),
      );
      const queue = queues[threadId] ?? [];
      const result = mutate(queue);
      if (queue.length === 0) delete queues[threadId];
      else queues[threadId] = queue;
      const next: QueueDocument = { revision: previous.revision + 1, queues };
      this.document = next;
      this.writeStoredDocument(next);
      this.publish(threadId);
      return result;
    });
  }

  private async withExclusive<T>(
    suffix: string,
    ifAvailable: boolean,
    action: (acquired: boolean) => Promise<T>,
  ): Promise<T> {
    const locks = browserLocks();
    if (locks !== null) {
      return await locks.request(suffix, { mode: "exclusive", ...(ifAvailable ? { ifAvailable: true } : {}) },
        async (lock) => await action(lock !== null));
    }
    if (ifAvailable && inProcessLocks.has(suffix)) return await action(false);
    return await withInProcessLock(suffix, async () => await action(true));
  }

  private readStoredDocument(): QueueDocument {
    if (this.storage === undefined) return this.document ?? emptyDocument();
    try {
      const stored = parseDocument(this.storage.getItem(this.storageKey));
      const current = this.document;
      return current !== undefined && current.revision > stored.revision ? current : stored;
    } catch {
      return this.document ?? emptyDocument();
    }
  }

  private refreshFromStorage(): void {
    const stored = this.readStoredDocument();
    if (stored.revision > this.document.revision) this.document = stored;
  }

  private writeStoredDocument(document: QueueDocument): void {
    try {
      // Keep the empty tombstone. Removing the key loses the monotonic revision,
      // so another tab can neither observe the deletion nor reject stale state.
      this.storage?.setItem(this.storageKey, JSON.stringify(document));
    } catch {
      // Persistence failure does not revoke the in-memory owner.
    }
  }

  private publishChangedThreads(previous: QueueDocument, next: QueueDocument): void {
    for (const threadId of new Set([...Object.keys(previous.queues), ...Object.keys(next.queues)])) {
      if (JSON.stringify(previous.queues[threadId] ?? []) !== JSON.stringify(next.queues[threadId] ?? [])) {
        this.publish(threadId);
      }
    }
  }

  private publish(threadId: string): void {
    for (const listener of this.listeners) listener(threadId);
  }
}

export class MemoryHermesComposerQueueService extends BrowserHermesComposerQueueService {
  constructor() {
    super(`memory:${crypto.randomUUID()}`);
  }
}

export function browserHermesComposerQueueService(
  scope: string,
  storage?: HermesComposerQueueStorage,
): HermesComposerQueueService {
  let resolvedStorage = storage;
  if (resolvedStorage === undefined) {
    try {
      resolvedStorage = globalThis.localStorage;
    } catch {
      // Browser policy may reject even reading localStorage.
    }
  }
  const eventTarget = typeof globalThis.addEventListener === "function" ? globalThis : undefined;
  return new BrowserHermesComposerQueueService(scope, resolvedStorage, eventTarget);
}
