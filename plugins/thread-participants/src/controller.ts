import type { AppServerClient } from "@opencraft/appserver-client";
import {
  LEGACY_THREAD_PARTICIPANTS_CHANGED,
  LEGACY_THREAD_PARTICIPANTS_LIST,
  THREAD_PARTICIPANTS_BATCH_LIMIT,
  THREAD_PARTICIPANTS_CHANGED,
  parseThreadParticipantsResponse,
  supportedParticipantsMethod,
  type ThreadParticipants,
} from "./contract";

export type ThreadParticipantsClient = Pick<
  AppServerClient,
  | "requestRaw"
  | "initializeResult"
  | "connectionGeneration"
  | "subscribeNotification"
  | "subscribeStatus"
  | "subscribeRequestLifecycle"
>;
export interface ThreadParticipantsSnapshot {
  readonly phase: "loading" | "ready" | "error" | "unsupported";
  /** Last verified row for this Host and Thread; kept while refreshing or after a failed refresh. */
  readonly data: ThreadParticipants | null;
}
/** The read side that badges and grouping consume. */
export interface ThreadParticipantsSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(hostId: string, threadId: string): ThreadParticipantsSnapshot;
  watch(hostId: string, threadId: string): () => void;
  refresh?(hostId: string, threadId: string): void;
}

type Entry = {
  retryTimer?: ReturnType<typeof setTimeout>;
  failures: number;
  hostId: string;
  threadId: string;
  refs: number;
  revision: number;
  snapshot: ThreadParticipantsSnapshot;
  client: ThreadParticipantsClient | undefined;
  generation: number;
  loadedAt: number;
};
type Host = {
  client: ThreadParticipantsClient;
  busy: boolean;
  pending: Set<string>;
  disposers: (() => void)[];
  abort: AbortController | null;
};
const initial: ThreadParticipantsSnapshot = Object.freeze({ phase: "loading", data: null });
const key = (hostId: string, threadId: string) => JSON.stringify([hostId, threadId]);
const changedFor = (method: string) =>
  method === LEGACY_THREAD_PARTICIPANTS_LIST ? LEGACY_THREAD_PARTICIPANTS_CHANGED : THREAD_PARTICIPANTS_CHANGED;
const FRESH_MS = 300_000;
const INACTIVE_LIMIT = 256;
const RETRY_DELAYS = [5000, 15000, 60000] as const;

/** Batched per-Host participant reads. Each Host client and connection generation fences late replies. */
export class ThreadParticipantsController implements ThreadParticipantsSource {
  readonly #entries = new Map<string, Entry>();
  readonly #hosts = new Map<string, Host>();
  readonly #hostRefs = new Map<string, number>();
  readonly #inactive = new Map<string, Entry>();
  readonly #listeners = new Set<() => void>();
  #closed = false;
  #batchDepth = 0;
  #notificationPending = false;
  constructor(
    readonly getClient: (hostId: string) => ThreadParticipantsClient | undefined,
    readonly now = Date.now,
  ) {}
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  getSnapshot = (hostId: string, threadId: string): ThreadParticipantsSnapshot => {
    const entry = this.#entries.get(key(hostId, threadId)),
      client = this.getClient(hostId);
    return entry && (!client || !entry.client || entry.client === client) ? entry.snapshot : initial;
  };
  watch(hostId: string, threadId: string): () => void {
    if (this.#closed) return () => {};
    const id = key(hostId, threadId);
    let entry = this.#entries.get(id);
    if (!entry) {
      entry = {
        failures: 0,
        hostId,
        threadId,
        refs: 0,
        revision: 0,
        snapshot: initial,
        client: undefined,
        generation: -1,
        loadedAt: -Infinity,
      };
      this.#entries.set(id, entry);
    }
    this.#inactive.delete(id);
    this.#hostRefs.set(hostId, (this.#hostRefs.get(hostId) ?? 0) + 1);
    entry.refs++;
    if (entry.refs === 1) this.refresh(hostId, threadId, true);
    let active = true;
    const watched = entry;
    return () => {
      if (!active) return;
      active = false;
      if (this.#closed) return;
      const remaining = this.#hostRefs.get(hostId)! - 1;
      if (remaining) this.#hostRefs.set(hostId, remaining);
      else this.#hostRefs.delete(hostId);
      watched.refs--;
      if (!watched.refs) {
        clearTimeout(watched.retryTimer);
        watched.retryTimer = undefined;
        this.#hosts.get(hostId)?.pending.delete(threadId);
        if (!watched.snapshot.data) this.#entries.delete(id);
        else {
          // Insertion order is last-release order; only inactive rows count
          // toward the cache limit. Rewatching removes the candidate.
          this.#inactive.set(id, watched);
          if (this.#inactive.size > INACTIVE_LIMIT) {
            const oldest = this.#inactive.keys().next().value!;
            this.#inactive.delete(oldest);
            this.#entries.delete(oldest);
          }
        }
      }
      if (!remaining) this.#releaseHost(hostId);
    };
  }
  refresh(hostId: string, threadId: string, ifStale = false): void {
    if (this.#closed) return;
    const entry = this.#entries.get(key(hostId, threadId));
    if (!entry) return;
    if (!entry.refs) {
      entry.loadedAt = -Infinity;
      return;
    }
    clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
    const client = this.getClient(hostId);
    if (!client) {
      this.#publish(entry, { phase: "error", data: entry.snapshot.data });
      return;
    }
    let host = this.#hosts.get(hostId);
    const replaced = host !== undefined && host.client !== client;
    if (replaced) {
      this.#releaseHost(hostId);
      host = undefined;
    }
    if (!host) host = this.#installHost(hostId, client);
    if (entry.client && entry.client !== client) this.#publish(entry, initial);
    const fresh =
      entry.snapshot.phase === "ready" &&
      entry.snapshot.data &&
      entry.client === client &&
      entry.generation === client.connectionGeneration &&
      this.now() - entry.loadedAt < FRESH_MS;
    entry.client = client;
    if (ifStale && fresh) return;
    // Revoke freshness before dispatch: an invalidated read may be cancelled by
    // unmounting while its last successful snapshot remains useful for display.
    entry.loadedAt = -Infinity;
    entry.revision++;
    host.pending.add(threadId);
    // Releasing the old Host cleared every row's retry timer. Transfer all active
    // watchers to the installed client, including rows whose timer has not fired.
    if (replaced)
      for (const value of this.#entries.values()) {
        if (value.hostId === hostId && value.refs > 0 && value !== entry) this.refresh(hostId, value.threadId);
      }
    queueMicrotask(() => {
      void this.#flush(hostId);
    });
  }
  /** Account or scope change: drop every row and reread the active ones. */
  clear(): void {
    this.#batch(() => {
      this.#inactive.clear();
      for (const id of [...this.#hosts.keys()]) this.#releaseHost(id);
      for (const [id, value] of this.#entries) {
        value.revision++;
        value.loadedAt = -Infinity;
        if (!value.refs) {
          this.#entries.delete(id);
          continue;
        }
        this.#publish(value, initial);
        this.refresh(value.hostId, value.threadId);
      }
    });
  }
  dispose(): void {
    this.#closed = true;
    for (const id of [...this.#hosts.keys()]) this.#releaseHost(id);
    for (const entry of this.#entries.values()) clearTimeout(entry.retryTimer);
    this.#entries.clear();
    this.#inactive.clear();
    this.#hostRefs.clear();
    this.#listeners.clear();
  }

  #installHost(hostId: string, client: ThreadParticipantsClient): Host {
    const host: Host = { client, busy: false, pending: new Set(), disposers: [], abort: null };
    this.#hosts.set(hostId, host);
    let initializedTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshHost = () => {
      for (const value of this.#entries.values()) if (value.hostId === hostId) this.refresh(hostId, value.threadId);
    };
    host.disposers.push(
      () => clearTimeout(initializedTimer),
      client.subscribeRequestLifecycle((event) => {
        if (event.type !== "completed" || event.method !== "initialize") return;
        initializedTimer = setTimeout(() => {
          if (this.#hosts.get(hostId)?.client === client) refreshHost();
        }, 0);
      }),
      client.subscribeNotification((notification) => {
        // Only the changed name that matches the advertised method is consumed;
        // a Host that sends both names must not cause two reads.
        const method = supportedParticipantsMethod(
          client.initializeResult?.capabilities?.extensions as Record<string, unknown> | undefined,
        );
        if (!method || notification.method !== changedFor(method)) return;
        const params = notification.params as { threadId?: unknown } | undefined;
        if (typeof params?.threadId === "string") this.refresh(hostId, params.threadId);
      }),
      client.subscribeStatus(() => {
        const current = this.#hosts.get(hostId);
        if (!current) return;
        current.abort?.abort();
        refreshHost();
      }),
    );
    return host;
  }

  async #flush(hostId: string): Promise<void> {
    const host = this.#hosts.get(hostId);
    if (!host || host.busy || !host.pending.size || this.#closed) return;
    const threadIds = [...host.pending].slice(0, THREAD_PARTICIPANTS_BATCH_LIMIT);
    for (const id of threadIds) host.pending.delete(id);
    const reads = new Map(
      threadIds.map((id) => {
        const entry = this.#entries.get(key(hostId, id));
        return [id, { entry, revision: entry?.revision }] as const;
      }),
    );
    const currentEntry = (id: string) => {
      const entry = this.#entries.get(key(hostId, id)),
        read = reads.get(id);
      return entry && entry === read?.entry && entry.revision === read.revision ? entry : undefined;
    };
    if (!host.client.initializeResult) return; // The initialize completion hook resumes these rows.
    const method = supportedParticipantsMethod(
      host.client.initializeResult.capabilities?.extensions as Record<string, unknown> | undefined,
    );
    if (!method) {
      this.#batch(() => {
        for (const id of threadIds) {
          const entry = this.#entries.get(key(hostId, id));
          if (entry) this.#publish(entry, { phase: "unsupported", data: null });
        }
      });
      return;
    }
    host.busy = true;
    const abort = new AbortController();
    host.abort = abort;
    const generation = host.client.connectionGeneration;
    const current = () =>
      !this.#closed &&
      this.#hosts.get(hostId) === host &&
      this.getClient(hostId) === host.client &&
      generation === host.client.connectionGeneration &&
      !abort.signal.aborted;
    try {
      const result = await host.client.requestRaw<unknown>(
        method,
        { threadIds },
        { signal: abort.signal, timeoutMs: 15000, priority: "background" },
      );
      const { rows, errors } = parseThreadParticipantsResponse(result, threadIds);
      if (current())
        this.#batch(() => {
          for (const id of threadIds) {
            const entry = currentEntry(id);
            if (!entry) continue;
            if (errors.has(id)) this.#publish(entry, { phase: "error", data: entry.snapshot.data });
            else if (rows.get(id)!.pending) this.#publish(entry, { phase: "loading", data: entry.snapshot.data }, true);
            else {
              entry.loadedAt = this.now();
              entry.generation = generation;
              this.#publish(entry, { phase: "ready", data: rows.get(id)! });
            }
          }
        });
    } catch {
      if (current())
        this.#batch(() => {
          for (const id of threadIds) {
            const entry = currentEntry(id);
            if (entry) this.#publish(entry, { phase: "error", data: entry.snapshot.data });
          }
        });
    } finally {
      host.busy = false;
      if (host.abort === abort) host.abort = null;
      if (this.#hosts.get(hostId) === host && host.pending.size)
        queueMicrotask(() => {
          void this.#flush(hostId);
        });
    }
  }
  #publish(entry: Entry, snapshot: ThreadParticipantsSnapshot, retryPending = false): void {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
    entry.snapshot = snapshot;
    if ((snapshot.phase === "error" || retryPending) && entry.refs && !this.#closed) {
      const delay = RETRY_DELAYS[Math.min(entry.failures++, RETRY_DELAYS.length - 1)]!;
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = undefined;
        this.refresh(entry.hostId, entry.threadId);
      }, delay);
    } else if (snapshot.phase !== "error") entry.failures = 0;
    this.#notificationPending = true;
    this.#notify();
  }
  // A response is one publication, including errors and account reset. Every
  // row is committed before grouping and badge subscribers rescan it.
  #batch(update: () => void): void {
    this.#batchDepth++;
    try {
      update();
    } finally {
      this.#batchDepth--;
      this.#notify();
    }
  }
  #notify(): void {
    if (this.#batchDepth || !this.#notificationPending) return;
    this.#notificationPending = false;
    for (const listener of this.#listeners) listener();
  }
  #releaseHost(hostId: string): void {
    for (const entry of this.#entries.values())
      if (entry.hostId === hostId) {
        clearTimeout(entry.retryTimer);
        entry.retryTimer = undefined;
        entry.failures = 0;
      }
    const host = this.#hosts.get(hostId);
    host?.abort?.abort();
    host?.disposers.forEach((dispose) => dispose());
    this.#hosts.delete(hostId);
  }
}
