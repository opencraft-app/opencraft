/** Bounded polling of explicitly configured material paths, with business-owned baselines. */
export class FileEventSource {
  constructor({
    source,
    watchedPaths,
    observe,
    onError = () => {},
    now = Date.now,
  }) {
    Object.assign(this, { source, watchedPaths, observe, onError, now });
    this.nextAt = 0;
  }
  tick() {
    if (!this.source || this.now() < this.nextAt) return;
    this.nextAt = this.now() + 1000;
    for (const path of this.watchedPaths()) {
      try {
        this.observe(path, this.source.read(path).sha256);
      } catch (error) {
        if (error.code === "ENOENT") this.observe(path, null);
        else this.onError(error);
      }
    }
  }
}
