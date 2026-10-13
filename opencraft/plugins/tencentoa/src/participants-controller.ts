import type { AppServerClient } from "@opencraft/appserver-client";
import { TENCENTOA_PARTICIPANTS_CHANGED, TENCENTOA_PARTICIPANTS_METHOD, type TencentOaThreadParticipants } from "./contract";

export type ParticipantsClient = Pick<AppServerClient, "requestRaw" | "initializeResult" | "connectionGeneration" | "subscribeNotification" | "subscribeStatus" | "subscribeRequestLifecycle">;
export interface ParticipantsSnapshot {
  readonly phase: "loading" | "ready" | "error" | "unsupported";
  readonly data: TencentOaThreadParticipants | null;
}
type Entry = { hostId: string; threadId: string; refs: number; revision: number; snapshot: ParticipantsSnapshot };
type Host = { client: ParticipantsClient; generation: number; busy: boolean; pending: Set<string>; disposers: (() => void)[]; abort: AbortController | null };
const initial: ParticipantsSnapshot = Object.freeze({ phase: "loading", data: null });
const key = (hostId: string, threadId: string) => JSON.stringify([hostId, threadId]);

/** IOA-owned, batched metadata reads. Each Host and connection fences late replies. */
export class TencentOaParticipantsController {
  readonly #entries = new Map<string, Entry>();
  readonly #hosts = new Map<string, Host>();
  readonly #listeners = new Set<() => void>();
  #closed = false;
  constructor(readonly getClient: (hostId: string) => ParticipantsClient | undefined) {}
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  getSnapshot = (hostId: string, threadId: string): ParticipantsSnapshot => this.#entries.get(key(hostId, threadId))?.snapshot ?? initial;
  watch(hostId: string, threadId: string): () => void {
    if (this.#closed) return () => {};
    const id = key(hostId, threadId);
    let entry = this.#entries.get(id);
    if (!entry) { entry = { hostId, threadId, refs: 0, revision: 0, snapshot: initial }; this.#entries.set(id, entry); }
    entry.refs++; this.refresh(hostId, threadId);
    return () => {
      entry!.refs--;
      if (entry!.refs === 0) this.#entries.delete(id);
      if (![...this.#entries.values()].some(value => value.hostId === hostId && value.refs > 0)) this.#releaseHost(hostId);
    };
  }
  refresh(hostId: string, threadId: string): void {
    if (this.#closed) return;
    const entry = this.#entries.get(key(hostId, threadId)); if (!entry) return;
    const client = this.getClient(hostId);
    if (!client) { this.#publish(entry, { phase: "error", data: entry.snapshot.data }); return; }
    let host = this.#hosts.get(hostId);
    if (host && host.client !== client) { this.#releaseHost(hostId); host = undefined; }
    if (!host) {
      host = { client, generation: client.connectionGeneration, busy: false, pending: new Set(), disposers: [], abort: null };
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
        current.generation = client.connectionGeneration;
        for (const value of this.#entries.values()) if (value.hostId === hostId) this.refresh(hostId, value.threadId);
      }));
    }
    entry.revision++; host.pending.add(threadId);
    queueMicrotask(() => { void this.#flush(hostId); });
  }
  clear(): void {
    for (const id of [...this.#hosts.keys()]) this.#releaseHost(id);
    for (const value of this.#entries.values()) { value.revision++; this.#publish(value, initial); this.refresh(value.hostId, value.threadId); }
  }
  async #flush(hostId: string): Promise<void> {
    const host = this.#hosts.get(hostId);
    if (!host || host.busy || !host.pending.size || this.#closed) return;
    const threadIds = [...host.pending].slice(0, 100);
    for (const id of threadIds) host.pending.delete(id);
    const revisions = new Map(threadIds.map(id => [id, this.#entries.get(key(hostId, id))?.revision]));
    if (!host.client.initializeResult) return; // The initialize completion hook resumes these rows.
    const capabilities = host.client.initializeResult.capabilities?.extensions;
    if ((capabilities?.[TENCENTOA_PARTICIPANTS_METHOD] as { version?: number } | undefined)?.version !== 1) {
      for (const id of threadIds) { const entry = this.#entries.get(key(hostId, id)); if (entry) this.#publish(entry, { phase: "unsupported", data: null }); }
      return;
    }
    host.busy = true; const abort = new AbortController(); host.abort = abort;
    const generation = host.client.connectionGeneration;
    const current = () => !this.#closed && this.#hosts.get(hostId) === host && this.getClient(hostId) === host.client
      && generation === host.client.connectionGeneration && !abort.signal.aborted;
    try {
      const result = await host.client.requestRaw<{ data: TencentOaThreadParticipants[]; errors?: { threadId: string }[] }>(TENCENTOA_PARTICIPANTS_METHOD, { threadIds }, { signal: abort.signal, timeoutMs: 15000, priority: "background" });
      if (!Array.isArray(result?.data)) throw new Error("Invalid participant response");
      const rows = new Map(result.data.map(row => [row.threadId, row]));
      const errors = new Set((result.errors ?? []).map(row => row.threadId));
      if (rows.size + errors.size !== threadIds.length || [...errors].some(id => !threadIds.includes(id) || rows.has(id))) throw new Error("Incomplete participant response");
      for (const id of threadIds) {
        if (errors.has(id)) continue;
        const row = rows.get(id);
        if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0 || !Array.isArray(row.participants)
          || row.participants.length > 10000 || row.participants.some(name => typeof name !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(name))
          || new Set(row.participants).size !== row.participants.length) throw new Error("Invalid participant response");
      }
      if (current()) for (const id of threadIds) {
        const entry = this.#entries.get(key(hostId, id));
        if (entry && entry.revision === revisions.get(id)) this.#publish(entry, errors.has(id) ? { phase: "error", data: entry.snapshot.data } : { phase: "ready", data: rows.get(id)! });
      }
    } catch {
      if (current()) for (const id of threadIds) { const entry = this.#entries.get(key(hostId, id)); if (entry && entry.revision === revisions.get(id)) this.#publish(entry, { phase: "error", data: entry.snapshot.data }); }
    } finally {
      host.busy = false; if (host.abort === abort) host.abort = null;
      if (this.#hosts.get(hostId) === host && host.pending.size) queueMicrotask(() => { void this.#flush(hostId); });
    }
  }
  #publish(entry: Entry, snapshot: ParticipantsSnapshot): void { entry.snapshot = snapshot; for (const listener of this.#listeners) listener(); }
  #releaseHost(hostId: string): void { const host = this.#hosts.get(hostId); host?.abort?.abort(); host?.disposers.forEach(dispose => dispose()); this.#hosts.delete(hostId); }
  dispose(): void { this.#closed = true; for (const id of [...this.#hosts.keys()]) this.#releaseHost(id); this.#entries.clear(); this.#listeners.clear(); }
}
