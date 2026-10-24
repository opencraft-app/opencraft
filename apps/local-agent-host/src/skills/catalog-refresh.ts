/** Pending application of committed filesystem changes, not a second Skill catalog. */
export class SkillCatalogRefresh {
  private revision = 0;
  private applied = 0;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly refresh: (() => Promise<void>) | null) {}

  changed(): Promise<void | "unsupported"> {
    if (this.refresh === null) return Promise.resolve("unsupported");
    this.revision++;
    return this.ensureFresh();
  }

  ensureFresh(): Promise<void> {
    const refresh = this.refresh;
    if (refresh === null) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (this.applied === this.revision) return Promise.resolve();
    const operation = (async () => {
      while (this.applied !== this.revision) {
        const revision = this.revision;
        await refresh();
        this.applied = revision;
      }
    })();
    this.inFlight = operation.finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
}
