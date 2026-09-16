/** A single physical recognition completion; cancellation always wins late results. */
export class DictationCompletion {
  private resolve!: (committed: boolean) => void;
  private readonly promise = new Promise<boolean>(resolve => { this.resolve = resolve; });
  private stopped = false;
  private settled = false;
  finish(stop: () => void): Promise<boolean> {
    if (!this.stopped && !this.settled) { this.stopped = true; stop(); }
    return this.promise;
  }
  settle(committed: boolean): void {
    if (this.settled) return;
    this.settled = true; this.resolve(committed);
  }
}
