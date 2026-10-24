import type { AppServerClientRegistry } from "@opencraft/appserver-client";
import type { HostConnectionProfile, TurnCompletionObserver } from "@opencraft/workbench-runtime";
import { ThreadAttention, parseThreadReadReceipts, type ThreadReadReceiptPort } from "@opencraft/workbench-runtime";
import type { PlatformAccountContributionRegistry } from "./platform-account-contributions";

/** Application lifetime owner. Account authority stores exact read identities;
 * browser storage is a cache/outbox (or local-only fallback without an account port).
 * History catch-up borrows connected clients; it never resumes or executes work. */
export class BrowserThreadAttention {
  private state = new ThreadAttention();
  private scope: string | null = null;
  private revision = 0;
  private epoch = 0;
  private disposed = false;
  private port: ThreadReadReceiptPort | undefined;
  private hydrated = true;
  private controller = new AbortController();
  private readonly unsent = new Set<string>();
  private synchronization: Promise<void> | null = null;
  private persistedReceipts: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly stops: Array<() => void> = [];
  private stopAccount = () => {};
  private stopState = () => {};
  private readonly checked = new Map<string, string>();
  private readonly pending = new Set<string>();
  private readonly live = new Map<string, number>();
  constructor(private readonly clients: Pick<AppServerClientRegistry, "get">,
    source: TurnCompletionObserver, accounts: PlatformAccountContributionRegistry,
    private readonly storage: Pick<Storage, "getItem" | "setItem">,
    private readonly prefix: string,
    private readonly resetBeforeSeconds = 0) {
    const bind = () => {
      this.stopAccount();
      const account = accounts.getSnapshot().contribution;
      const refresh = () => this.setScope(account ? account.getSnapshot().readStateScope ?? null : "local", account?.readReceipts);
      this.stopAccount = account?.subscribe(refresh) ?? (() => {});
      refresh();
    };
    this.stops.push(accounts.subscribe(bind));
    bind();
    this.stops.push(source.subscribe(result => {
      if (this.scope === null) return;
      const key = JSON.stringify([result.hostId, result.threadId]);
      this.live.set(key, (this.live.get(key) ?? 0) + 1);
      this.state.observe(result.hostId, result.threadId, result.turnId);
    }));
    if (typeof window !== "undefined") {
      const refresh = () => { if (document.visibilityState === "visible") void this.synchronize(); };
      const timer = window.setInterval(refresh, 15_000);
      window.addEventListener("focus", refresh);
      window.addEventListener("online", refresh);
      document.addEventListener("visibilitychange", refresh);
      this.stops.push(() => { window.clearInterval(timer); window.removeEventListener("focus", refresh);
        window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", refresh); });
    }
  }
  private setScope(scope: string | null, port?: ThreadReadReceiptPort) {
    if (this.scope === scope && this.port === port) return;
    this.controller.abort(); this.controller = new AbortController();
    this.synchronization = null; this.unsent.clear();
    this.port = port; this.hydrated = !port;
    this.stopState();
    this.scope = scope;
    this.persistedReceipts = null;
    ++this.epoch;
    this.checked.clear(); this.pending.clear(); this.live.clear();
    let receipts: string[] = [];
    try {
      const value: unknown = scope === null ? null : JSON.parse(this.storage.getItem(this.storageKey(scope)) ?? "null");
      if (Array.isArray(value)) receipts = value.filter((item): item is string => typeof item === "string");
    } catch { /* Private/disabled storage retains in-memory read semantics. */ }
    this.state = new ThreadAttention(receipts);
    // Import legacy browser reads by union; never replace another device's receipts.
    if (port) for (const receipt of receipts) this.unsent.add(receipt);
    this.stopState = this.state.subscribe(() => { this.publish(); });
    this.publish();
    void this.synchronize();
  }
  private storageKey(scope: string) { return `${this.prefix}:${JSON.stringify(scope)}`; }
  private publish() { ++this.revision; for (const listener of this.listeners) listener(); }
  getSnapshot = () => this.revision;
  getScope = () => this.scope;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  unread(hostId: string, threadId: string) { return this.hydrated && this.scope !== null && this.state.unread(hostId, threadId); }
  acknowledge(scope: string | null, hostId: string, threadId: string, turnId: string) {
    if (this.disposed || scope === null || scope !== this.scope) return;
    if (!this.state.acknowledge(hostId, threadId, turnId)) return;
    if (this.port) this.unsent.add(JSON.stringify([hostId, threadId, turnId]));
    this.persistCache(scope);
    void this.synchronize();
  }
  private persistCache(scope: string) {
    const value = JSON.stringify(this.state.receipts());
    if (value === this.persistedReceipts) return;
    try {
      this.storage.setItem(this.storageKey(scope), value);
      this.persistedReceipts = value;
    } catch { /* Retry persistence next time; in-memory outbox remains retryable. */ }
  }
  /** Refresh on account activation, foreground/online recovery and bounded foreground polling. */
  synchronize(): Promise<void> {
    if (this.synchronization) return this.synchronization;
    const { scope, port, epoch, state } = this;
    if (this.disposed || scope === null || !port) return Promise.resolve();
    const signal = this.controller.signal;
    const current = () => !this.disposed && !signal.aborted && epoch === this.epoch && scope === this.scope;
    const task = Promise.resolve().then(async () => {
      try {
        const remote = parseThreadReadReceipts(await port.read(scope, signal));
        if (!current()) return;
        state.mergeReceipts(remote);
        // A cached confirmed receipt needs no repeated upload; uncertain writes are idempotent.
        for (const receipt of remote) this.unsent.delete(receipt);
        while (current() && this.unsent.size) {
          const batch = [...this.unsent].slice(0, 128);
          const confirmed = parseThreadReadReceipts(await port.merge(scope, batch, signal));
          if (!current()) return;
          if (batch.some(receipt => !confirmed.includes(receipt))) throw new Error("Read receipt not confirmed");
          state.mergeReceipts(confirmed);
          for (const receipt of batch) this.unsent.delete(receipt);
        }
        if (current()) this.persistCache(scope);
      } catch { /* Keep the scoped cache/outbox; foreground/online refresh retries, without changing execution. */ }
      finally {
        if (current()) {
          const wasHydrated = this.hydrated;
          this.hydrated = true;
          this.synchronization = null;
          // Receipt changes already publish through ThreadAttention. Settling
          // an unchanged foreground refresh is not a new sidebar snapshot.
          if (!wasHydrated) this.publish();
        }
      }
    });
    this.synchronization = task;
    return task;
  }
  async catchUp(profile: HostConnectionProfile, threads: readonly { id: string; updatedAt: number }[], isCurrent: () => boolean) {
    const client = this.clients.get(profile.hostId);
    const scope = this.scope;
    const epoch = this.epoch;
    if (!client || scope === null || client.status.state !== "open") return;
    const generation = client.connectionGeneration;
    const current = () => !this.disposed && epoch === this.epoch && scope === this.scope && isCurrent()
      && this.clients.get(profile.hostId) === client && client.connectionGeneration === generation && client.status.state === "open";
    const queue = threads.slice(0, 50);
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (let thread = queue.shift(); thread && current(); thread = queue.shift()) {
        const key = JSON.stringify([profile.hostId, thread.id]);
        const stamp = JSON.stringify([profile.revision, generation, thread.updatedAt]);
        if (this.checked.get(key) === stamp || this.pending.has(key)) continue;
        this.pending.add(key);
        const liveRevision = this.live.get(key) ?? 0;
        try {
          const page = await client.request("thread/turns/list", {
            threadId: thread.id, cursor: null, limit: 1, itemsView: "notLoaded", sortDirection: "desc",
          }, { priority: "background", timeoutMs: 10_000 });
          if (!current()) return;
          this.checked.set(key, stamp);
          const turn = page.data[0];
          // A late catalog read cannot replace a completion received while it was in flight.
          if ((this.live.get(key) ?? 0) === liveRevision && turn
            && (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted")) {
            // A deployment may establish a fixed historical baseline for every account
            // and browser. Never use first-visit time: newer offline replies remain unread.
            const completedAt = typeof turn.completedAt === "number" ? turn.completedAt : thread.updatedAt;
            if (Number.isFinite(this.resetBeforeSeconds) && this.resetBeforeSeconds > 0
              && Number.isFinite(completedAt) && completedAt <= this.resetBeforeSeconds) {
              this.acknowledge(scope, profile.hostId, thread.id, turn.id);
            }
            this.state.observe(profile.hostId, thread.id, turn.id);
          }
        } catch {
          // Unsupported/temporarily unavailable history must not break the sidebar.
          // Retry only on the next catalog revision/connection generation, never in a loop.
          if (current()) this.checked.set(key, stamp);
        } finally { if (epoch === this.epoch) this.pending.delete(key); }
      }
    }));
  }
  dispose() {
    this.disposed = true; this.controller.abort(); this.unsent.clear(); this.stopAccount(); this.stopState();
    for (const stop of this.stops) stop();
    this.listeners.clear(); this.checked.clear(); this.pending.clear(); this.live.clear();
  }
}
