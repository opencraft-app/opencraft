import type { TaskConversationActivity } from "./index";

export interface ConversationActivityTarget {
  readonly key: string;
  readonly hostId: string;
  readonly threadId: string;
}

/** One View owns one bounded round. Refresh hints coalesce while reads settle. */
export class ConversationActivityReader {
  private readonly lifetime = new AbortController();
  private targets: readonly ConversationActivityTarget[] = [];
  private values = new Map<string, TaskConversationActivity>();
  private pending = false;
  private running = false;
  constructor(
    private readonly read: (target: ConversationActivityTarget, signal: AbortSignal) => Promise<TaskConversationActivity>,
    private readonly publish: (values: ReadonlyMap<string, TaskConversationActivity>) => void,
  ) {}

  refresh(targets: readonly ConversationActivityTarget[]): void {
    if (this.lifetime.signal.aborted) return;
    this.targets = [...new Map(targets.map(target => [target.key, target])).values()];
    this.pending = true;
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    const signal = this.lifetime.signal;
    try {
      while (this.pending && !signal.aborted) {
        this.pending = false;
        const targets = this.targets;
        const values = new Map(this.values);
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
          while (!signal.aborted && cursor < targets.length) {
            const target = targets[cursor++]!;
            // A removed/rebound target cannot admit more work from an old round.
            if (!this.targets.some(current => current.key === target.key && current.hostId === target.hostId && current.threadId === target.threadId)) continue;
            try { values.set(target.key, await this.read(target, signal)); }
            catch { /* Retain known activity through a failed background read. */ }
          }
        }));
        if (signal.aborted) return;
        this.values = new Map(this.targets.flatMap(target => {
          const previous = targets.find(value => value.key === target.key);
          const value = previous?.hostId === target.hostId && previous.threadId === target.threadId ? values.get(target.key) : undefined;
          return value ? [[target.key, value] as const] : [];
        }));
        this.publish(this.values);
      }
    } finally { this.running = false; }
  }

  dispose(): void { this.pending = false; this.lifetime.abort(); this.targets = []; this.values = new Map(); }
}
