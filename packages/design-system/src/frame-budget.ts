/** Bounded, deterministic grants. The renderer owns visibility and its clock. */
export interface FrameBudgetPolicy { maxConcurrent: number; updatesPerSecond: number; frameWorkMs: number }
export interface FrameClient { fps: number; priority: number; paint: (time: number) => void; pause: () => void }
interface Entry { id: number; client: FrameClient; last: number; granted: boolean }
export class FrameBudget {
  private entries = new Map<number, Entry>();
  private grants: Entry[] = [];
  private nextId = 0;
  private enabled = true;
  private paints: number[] = [];
  constructor(readonly policy: FrameBudgetPolicy, private readonly clock: () => number) {
    if (!(policy.maxConcurrent > 0 && policy.updatesPerSecond > 0 && policy.frameWorkMs > 0)) throw Error('Invalid frame budget');
  }
  add(client: FrameClient): () => void {
    if (!(client.fps > 0 && Number.isFinite(client.fps) && Number.isFinite(client.priority))) throw Error('Invalid frame client');
    const entry = {id: ++this.nextId, client, last: -Infinity, granted: false};
    this.entries.set(entry.id, entry); this.allocate();
    return () => { if (!this.entries.delete(entry.id)) return; entry.client.pause(); this.allocate(); };
  }
  setEnabled(enabled: boolean) { if (this.enabled === enabled) return; this.enabled = enabled; this.allocate(); }
  get active() { return this.grants.length > 0; }
  get size() { return this.entries.size; }
  get grantedCount() { return this.grants.length; }
  private allocate() {
    const selected = this.enabled ? [...this.entries.values()].sort((a,b) => b.client.priority-a.client.priority || a.id-b.id).slice(0,this.policy.maxConcurrent) : [];
    const ids = new Set(selected.map(e => e.id));
    for (const e of this.entries.values()) {
      const granted = ids.has(e.id);
      if (e.granted && !granted) e.client.pause();
      if (!e.granted && granted) e.last = -Infinity;
      e.granted = granted;
    }
    this.grants = selected;
  }
  /** At most the rolling quota, each client FPS and the main-thread work budget. No catch-up burst. */
  frame(time: number) {
    const start = this.clock();
    this.paints = this.paints.filter(t => time - t < 1000);
    const due = this.grants.filter(e => time-e.last >= 1000/e.client.fps - .01).sort((a,b) => a.last-b.last || b.client.priority-a.client.priority || a.id-b.id);
    for (const e of due) {
      if (this.paints.length >= this.policy.updatesPerSecond || this.clock()-start >= this.policy.frameWorkMs) break;
      // A callback may synchronously dispose or disable another owner.
      if (!e.granted || !this.entries.has(e.id)) continue;
      e.last = time; this.paints.push(time);
      try { e.client.paint(time); } catch { this.entries.delete(e.id); e.client.pause(); this.allocate(); }
    }
  }
}
