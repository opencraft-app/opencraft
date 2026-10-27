import { mergeTouchMoves } from '@opencraft/remote-interaction/touch';

// Bound work before it enters WebSocket/native queues. Only unsent adjacent
// samples merge; edges, modifiers, contact sets and wheel reversals are barriers.
const signature = (input: any) => JSON.stringify([input.type, input.pointerType, input.document,
  input.button, input.modifiers, input.touchPoints?.map((p: any) => p.id).sort((a: number, b: number) => a - b)]);
export function mergeRemoteInput(previous: any, next: any): any | null {
  if (signature(previous) !== signature(next)) return null;
  if (next.type === 'touchMove') return mergeTouchMoves(previous, next);
  if (next.type === 'mouseMove') return next;
  if (next.type !== 'mouseWheel' || previous.x !== next.x || previous.y !== next.y) return null;
  const merged = { ...next };
  for (const axis of ['deltaX', 'deltaY']) {
    const a = previous[axis] ?? 0, b = next[axis] ?? 0;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a * b < 0 || Math.abs(a + b) > 10000) return null;
    merged[axis] = a + b;
  }
  return merged;
}

export class RemoteBrowserInputQueue {
  private queued: ({ input: any } | { run: () => Promise<any>; resolve: (value: any) => void; reject: (error: Error) => void })[] = [];
  private active = 0;
  private exclusive = false;
  private generation = 0;
  private waiters: ((drained: boolean) => void)[] = [];
  constructor(private readonly send: (input: any, current: () => boolean) => Promise<unknown>, private readonly overflow: () => void,
    private readonly failed: (error: Error) => void = () => {}, private readonly limit: () => number = () => 2) {}
  get busy() { return this.active > 0 || this.queued.length > 0; }
  idle(): Promise<boolean> { return this.busy ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve(true); }
  reset() {
    ++this.generation;
    for (const job of this.queued) if ('reject' in job) job.reject(new Error('Browser interaction ended'));
    this.queued = []; this.active = 0; this.exclusive = false;
    for (const resolve of this.waiters.splice(0)) resolve(false);
  }
  push(input: any) {
    const last = this.queued.at(-1), merged = last && 'input' in last && mergeRemoteInput(last.input, input);
    if (merged) this.queued[this.queued.length - 1] = { input: merged };
    else this.queued.push({ input });
    if (this.queued.length > 128) { this.reset(); this.overflow(); return; }
    this.pump();
  }
  barrier<T>(run: () => Promise<T>): Promise<T> {
    const result = new Promise<T>((resolve, reject) => this.queued.push({ run, resolve, reject }));
    if (this.queued.length > 128) { this.reset(); this.overflow(); }
    else this.pump();
    return result;
  }
  private pump() {
    while (!this.exclusive && this.active < Math.max(2, Math.min(12, this.limit())) && this.queued.length) {
      const job = this.queued[0], generation = this.generation;
      if ('run' in job && this.active) break;
      this.queued.shift();
      this.exclusive = 'run' in job;
      ++this.active;
      void Promise.resolve().then(async () => {
        if (generation !== this.generation) { if ('reject' in job) job.reject(new Error('Browser interaction ended')); return; }
        if ('input' in job) return this.send(job.input, () => generation === this.generation);
        try { job.resolve(await job.run()); } catch (error) { job.reject(error as Error); }
      })
        .catch(error => {
          if (generation !== this.generation) return;
          this.reset(); this.failed(error);
        })
        .finally(() => {
          if (generation !== this.generation) return;
          --this.active; if ('run' in job) this.exclusive = false; this.pump();
          if (!this.busy) for (const resolve of this.waiters.splice(0)) resolve(true);
        });
    }
  }
}
