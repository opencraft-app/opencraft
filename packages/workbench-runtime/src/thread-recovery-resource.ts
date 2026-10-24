import type { TurnRecoveryNotice } from "@opencraft/appserver-protocol";
import { parseTurnRecoveryNotice } from "@opencraft/appserver-protocol";

/** Replaceable presentation cache. The engine Host is the only authority. */
export class ThreadRecoveryResource {
  private readonly values = new Map<string, TurnRecoveryNotice | null>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly revisions = new Map<string, number>();
  private generation = 0;
  constructor(private readonly client: {
    supported(threadId: string): boolean;
    read(threadId: string): Promise<{ recovery: TurnRecoveryNotice | null }>;
  }) {}
  getSnapshot(id: string): TurnRecoveryNotice | null { return this.values.get(id) ?? null; }
  subscribe(id: string, listener: () => void): () => void {
    const set = this.listeners.get(id) ?? new Set(); set.add(listener); this.listeners.set(id, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(id); };
  }
  observe(id: string, value: unknown): void {
    const notice = parseTurnRecoveryNotice(value);
    if (value !== null && (!notice || notice.threadId !== id)) return;
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    this.values.set(id, notice);
    for (const listener of this.listeners.get(id) ?? []) listener();
  }
  async refresh(id: string): Promise<void> {
    if (!id || !this.client.supported(id)) return;
    const generation = this.generation, revision = this.revisions.get(id) ?? 0;
    try {
      const value = await this.client.read(id);
      if (generation === this.generation && revision === (this.revisions.get(id) ?? 0)) this.observe(id, value.recovery);
    } catch { /* A temporary read failure must not erase the last server notice. */ }
  }
  reset(): void {
    this.generation++; this.values.clear(); this.revisions.clear();
    for (const [id, listeners] of this.listeners) {
      for (const listener of listeners) listener();
      void this.refresh(id);
    }
  }
}
