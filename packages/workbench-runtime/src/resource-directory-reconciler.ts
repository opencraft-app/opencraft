/** Notifications are hints. Each resource owner supplies its authorized read.
 * An invalidation arriving during a read schedules another pass, never gets lost.
 * Failed reads preserve the last projection and may be retried by the next hint
 * or anti-entropy pass; disposal fences all queued work. */
export class ResourceDirectoryReconciler {
  private readonly jobs = new Map<string, { dirty: boolean; run: () => Promise<void>; promise: Promise<void> }>();
  private disposed = false;
  invalidate(key: string, read: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const existing = this.jobs.get(key);
    if (existing) { existing.dirty = true; existing.run = read; return existing.promise; }
    const job = { dirty: true, run: read, promise: Promise.resolve() };
    job.promise = Promise.resolve().then(async () => {
      let failure: unknown;
      let failed = false;
      do {
        if (this.disposed) return;
        job.dirty = false;
        try { await job.run(); failed = false; } catch (error) { failure = error; failed = true; }
      } while (job.dirty && !this.disposed);
      if (failed) throw failure;
    }).finally(() => { if (this.jobs.get(key) === job) this.jobs.delete(key); });
    this.jobs.set(key, job);
    return job.promise;
  }
  dispose(): void { this.disposed = true; }
}
