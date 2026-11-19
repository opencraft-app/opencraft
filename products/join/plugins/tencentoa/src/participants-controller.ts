import type { AppServerClient } from "@opencraft/appserver-client";
import { TENCENTOA_PARTICIPANTS_CHANGED, TENCENTOA_PARTICIPANTS_METHOD, type TencentOaThreadParticipants } from "./contract";
import { parseParticipantsResponse } from "./participants-response";

export type ParticipantsClient = Pick<AppServerClient, "requestRaw" | "initializeResult" | "connectionGeneration" | "subscribeNotification" | "subscribeStatus" | "subscribeRequestLifecycle">;
export interface ParticipantsSnapshot {
  readonly phase: "loading" | "ready" | "error" | "unsupported";
  readonly data: TencentOaThreadParticipants | null;
}
type Entry = { retryTimer?: ReturnType<typeof setTimeout>; failures: number; hostId: string; threadId: string; refs: number; revision: number; snapshot: ParticipantsSnapshot; client: ParticipantsClient | undefined; generation: number; loadedAt: number };
type Host = { client: ParticipantsClient; busy: boolean; pending: Set<string>; disposers: (() => void)[]; abort: AbortController | null };
const initial: ParticipantsSnapshot = Object.freeze({ phase: "loading", data: null });
const key = (hostId: string, threadId: string) => JSON.stringify([hostId, threadId]);

/** IOA-owned, batched metadata reads. Each Host and connection fences late replies. */
export class TencentOaParticipantsController {
  readonly #entries = new Map<string, Entry>();
  readonly #hosts = new Map<string, Host>();
  readonly #hostRefs = new Map<string, number>();
  readonly #inactive = new Map<string, Entry>();
  readonly #listeners = new Set<() => void>();
  #closed = false;
  #batchDepth = 0;
  #notificationPending = false;
  constructor(readonly getClient: (hostId: string) => ParticipantsClient | undefined, readonly now = Date.now) {}
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  getSnapshot = (hostId: string, threadId: string): ParticipantsSnapshot => {
    const entry = this.#entries.get(key(hostId, threadId)), client = this.getClient(hostId);
    return entry && (!client || !entry.client || entry.client === client) ? entry.snapshot : initial;
  };
  watch(hostId: string, threadId: string): () => void {
    if (this.#closed) return () => {};
    const id = key(hostId, threadId);
    let entry = this.#entries.get(id);
    if (!entry) { entry = { failures: 0, hostId, threadId, refs: 0, revision: 0, snapshot: initial, client: undefined, generation: -1, loadedAt: -Infinity }; this.#entries.set(id, entry); }
    this.#inactive.delete(id);
    this.#hostRefs.set(hostId, (this.#hostRefs.get(hostId) ?? 0) + 1);
    entry.refs++; if (entry.refs === 1) this.refresh(hostId, threadId, true);
    let active = true;
    return () => {
      if (!active) return; active = false;
      if (this.#closed) return;
      const remaining = this.#hostRefs.get(hostId)! - 1;
      if (remaining) this.#hostRefs.set(hostId, remaining);
      else this.#hostRefs.delete(hostId);
      entry!.refs--;
      if (!entry!.refs) {
        clearTimeout(entry!.retryTimer); entry!.retryTimer = undefined;
        this.#hosts.get(hostId)?.pending.delete(threadId);
        if (!entry!.snapshot.data) this.#entries.delete(id);
        else {
          // Insertion order is the last-release order; only inactive rows count
          // toward the existing cache limit. Rewatching removes this candidate.
          this.#inactive.set(id, entry!);
          if (this.#inactive.size > 256) {
            const oldest = this.#inactive.keys().next().value!;
            this.#inactive.delete(oldest); this.#entries.delete(oldest);
          }
        }
      }
      if (!remaining) this.#releaseHost(hostId);
    };
  }
  refresh(hostId: string, threadId: string, ifStale = false): void {
    if (this.#closed) return;
    const entry = this.#entries.get(key(hostId, threadId)); if (!entry) return;
    if (!entry.refs) { entry.loadedAt = -Infinity; return; }
    clearTimeout(entry.retryTimer); entry.retryTimer = undefined;
    const client = this.getClient(hostId);
    if (!client) { this.#publish(entry, { phase: "error", data: entry.snapshot.data }); return; }
    let host = this.#hosts.get(hostId);
    const replaced = host && host.client !== client;
    if (replaced) { this.#releaseHost(hostId); host = undefined; }
    if (!host) {
      host = { client, busy: false, pending: new Set(), disposers: [], abort: null };
      this.#hosts.set(hostId, host);
      let initializedTimer: ReturnType<typeof setTimeout> | undefined;
      host.disposers.push(() => clearTimeout(initializedTimer), client.subscribeRequestLifecycle(event => {
        if (event.type !== "completed" || event.method !== "initialize") return;
        initializedTimer = setTimeout(() => {
          if (this.#hosts.get(hostId)?.client !== client) return;
          for (const value of this.#entries.values()) if (value.hostId === hostId) this.refresh(hostId, value.threadId);
        }, 0);
      }));
      host.disposers.push(client.subscribeNotification(notification => {
        if (notification.method !== TENCENTOA_PARTICIPANTS_CHANGED) return;
        const params = notification.params as { threadId?: string };
        if (typeof params?.threadId === "string") this.refresh(hostId, params.threadId);
      }), client.subscribeStatus(() => {
        const current = this.#hosts.get(hostId); if (!current) return;
        current.abort?.abort();
        for (const value of this.#entries.values()) if (value.hostId === hostId) this.refresh(hostId, value.threadId);
      }));
    }
    if (entry.client && entry.client !== client) this.#publish(entry, initial);
    const fresh = entry.snapshot.phase === "ready" && entry.snapshot.data && entry.client === client && entry.generation === client.connectionGeneration && this.now() - entry.loadedAt < 300_000;
    entry.client = client;
    if (ifStale && fresh) return;
    // Revoke freshness before dispatch: an invalidated read may be cancelled by
    // unmounting while its last successful snapshot remains useful for display.
    entry.loadedAt = -Infinity;
    entry.revision++; host.pending.add(threadId);
    // Releasing the old Host cleared every row's retry timer. Transfer all active
    // watchers to the installed client, including rows whose timer has not fired.
    if (replaced) for (const value of this.#entries.values()) {
      if (value.hostId === hostId && value.refs > 0 && value !== entry) this.refresh(hostId, value.threadId);
    }
    queueMicrotask(() => { void this.#flush(hostId); });
  }
  clear(): void {
    this.#batch(() => {
      this.#inactive.clear();
      for (const id of [...this.#hosts.keys()]) this.#releaseHost(id);
      for (const [id, value] of this.#entries) {
        value.revision++; value.loadedAt = -Infinity;
        if (!value.refs) { this.#entries.delete(id); continue; }
        this.#publish(value, initial); this.refresh(value.hostId, value.threadId);
      }
    });
  }
  async #flush(hostId: string): Promise<void> {
    const host = this.#hosts.get(hostId);
    if (!host || host.busy || !host.pending.size || this.#closed) return;
    const threadIds = [...host.pending].slice(0, 100);
    for (const id of threadIds) host.pending.delete(id);
    const reads = new Map(threadIds.map(id => {
      const entry = this.#entries.get(key(hostId, id));
      return [id, { entry, revision: entry?.revision }] as const;
    }));
    const currentEntry = (id: string) => {
      const entry = this.#entries.get(key(hostId, id)), read = reads.get(id);
      return entry && entry === read?.entry && entry.revision === read.revision ? entry : undefined;
    };
    if (!host.client.initializeResult) return; // The initialize completion hook resumes these rows.
    const capabilities = host.client.initializeResult.capabilities?.extensions;
    if ((capabilities?.[TENCENTOA_PARTICIPANTS_METHOD] as { version?: number } | undefined)?.version !== 1) {
      this.#batch(() => {
        for (const id of threadIds) { const entry = this.#entries.get(key(hostId, id)); if (entry) this.#publish(entry, { phase: "unsupported", data: null }); }
      });
      return;
    }
    host.busy = true; const abort = new AbortController(); host.abort = abort;
    const generation = host.client.connectionGeneration;
    const current = () => !this.#closed && this.#hosts.get(hostId) === host && this.getClient(hostId) === host.client
      && generation === host.client.connectionGeneration && !abort.signal.aborted;
    try {
      const result = await host.client.requestRaw<unknown>(TENCENTOA_PARTICIPANTS_METHOD, { threadIds }, { signal: abort.signal, timeoutMs: 15000, priority: "background" });
      const { rows, errors } = parseParticipantsResponse(result, threadIds);
      if (current()) this.#batch(() => { for (const id of threadIds) {
        const entry = currentEntry(id);
        if (entry) {
          if (errors.has(id)) this.#publish(entry, { phase: "error", data: entry.snapshot.data });
          else if (rows.get(id)!.pending) this.#publish(entry, { phase: "loading", data: entry.snapshot.data }, true);
          else {
            entry.loadedAt = this.now(); entry.generation = generation;
            this.#publish(entry, { phase: "ready", data: rows.get(id)! });
          }
        }
      } });
    } catch {
      if (current()) this.#batch(() => {
        for (const id of threadIds) { const entry = currentEntry(id); if (entry) this.#publish(entry, { phase: "error", data: entry.snapshot.data }); }
      });
    } finally {
      host.busy = false; if (host.abort === abort) host.abort = null;
      if (this.#hosts.get(hostId) === host && host.pending.size) queueMicrotask(() => { void this.#flush(hostId); });
    }
  }
  #publish(entry: Entry, snapshot: ParticipantsSnapshot, retryPending = false): void {
    clearTimeout(entry.retryTimer); entry.retryTimer = undefined;
    entry.snapshot = snapshot;
    if ((snapshot.phase === "error" || retryPending) && entry.refs && !this.#closed) {
      const delay = [5000, 15000, 60000][Math.min(entry.failures++, 2)]!;
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = undefined;
        this.refresh(entry.hostId, entry.threadId);
      }, delay);
    } else if (snapshot.phase !== "error") entry.failures = 0;
    this.#notificationPending = true;
    this.#notify();
  }
  // A metadata response is one publication, including errors and account reset.
  // Every row is committed before catalog and badge subscribers rescan it.
  #batch(update: () => void): void {
    this.#batchDepth++;
    try { update(); }
    finally { this.#batchDepth--; this.#notify(); }
  }
  #notify(): void {
    if (this.#batchDepth || !this.#notificationPending) return;
    this.#notificationPending = false;
    for (const listener of this.#listeners) listener();
  }
  #releaseHost(hostId: string): void {
    for (const entry of this.#entries.values()) if (entry.hostId === hostId) {
      clearTimeout(entry.retryTimer); entry.retryTimer = undefined; entry.failures = 0;
    }
    const host = this.#hosts.get(hostId); host?.abort?.abort(); host?.disposers.forEach(dispose => dispose()); this.#hosts.delete(hostId); }
  dispose(): void { this.#closed = true; for (const id of [...this.#hosts.keys()]) this.#releaseHost(id); for (const entry of this.#entries.values()) clearTimeout(entry.retryTimer); this.#entries.clear(); this.#inactive.clear(); this.#hostRefs.clear(); this.#listeners.clear(); }
}
