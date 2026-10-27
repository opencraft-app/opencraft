import { TextDeltaPacerController } from "./hypernode/text-delta-pacer.js";
type Frame = { method: string; params: any };

/** Execution snapshots remain immediate; presentation preserves ordered
 * delivery while the source pacer smooths text, never dropping terminal data.
 */
export class DshPresentationQueue {
  private readonly queues = new Map<string, Frame[]>();
  private readonly blocked = new Set<string>();
  private readonly pumping = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly pacer: TextDeltaPacerController;
  constructor(private readonly send: (method: string, params: any) => void) {
    this.pacer = new TextDeltaPacerController({
      emit: (metadata, delta) => this.send("item/agentMessage/delta", { ...metadata, delta }),
      requestTick: delay => {
        if (this.disposed || this.timer) return;
        this.timer = setTimeout(() => { this.timer = null; this.pacer.tick(); }, delay);
      },
    });
  }
  emit(method: string, params: any): void {
    if (this.disposed) return;
    const id = params?.threadId;
    if (typeof id !== "string") { this.send(method, params); return; }
    const queue = this.queues.get(id) ?? [];
    queue.push({ method, params: structuredClone(params) });
    this.queues.set(id, queue);
    this.pump(id);
    if (method === "turn/completed" && params.turn?.status !== "completed") this.flush(id);
  }
  private pump(id: string) {
    if (this.pumping.has(id) || this.blocked.has(id)) return;
    this.pumping.add(id);
    try {
      const queue = this.queues.get(id)!;
      while (!this.blocked.has(id) && queue?.length) {
        const { method, params } = queue.shift()!;
        if (method === "item/agentMessage/delta") {
          this.pacer.enqueue({ threadId: id, turnId: params.turnId, itemId: params.itemId }, params.delta);
        } else if (method === "item/completed" && params.item?.type === "agentMessage") {
          this.blocked.add(id);
          this.pacer.afterDrained({ threadId: id, turnId: params.turnId, itemId: params.item.id }, () => {
            if (this.disposed) return;
            this.send(method, params);
            this.blocked.delete(id);
            this.pump(id);
          });
        } else this.send(method, params);
      }
      if (!queue?.length && !this.blocked.has(id)) this.queues.delete(id);
    } finally { this.pumping.delete(id); }
  }
  flush(threadId: string) {
    for (const state of [...this.pacer.items.values()]) if (state.metadata.threadId === threadId) this.pacer.flush(state.metadata);
  }
  diagnostics() { return { ...this.pacer.diagnostics(), queuedThreads: this.queues.size }; }
  close() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.pacer.items.clear(); this.pacer.cadences.clear();
    this.queues.clear(); this.blocked.clear();
  }
}
