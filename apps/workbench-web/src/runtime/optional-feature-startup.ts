/** Background startup progresses only while visible and yields between features.
 * No periodic polling: visibility, idle and owner cancellation own the wait.
 */
export function waitForOptionalFeatureWindow(signal: AbortSignal): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let cancelWork: (() => void) | undefined;
    const cleanup = () => { cancelWork?.(); document.removeEventListener("visibilitychange", changed); signal.removeEventListener("abort", abort); };
    const done = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const changed = () => {
      cancelWork?.(); cancelWork = undefined;
      if (document.visibilityState === "hidden") return;
      if (typeof window.requestIdleCallback === "function") {
        const id = window.requestIdleCallback(done, { timeout: 1000 });
        cancelWork = () => window.cancelIdleCallback(id);
      } else {
        const id = window.setTimeout(done, 0);
        cancelWork = () => window.clearTimeout(id);
      }
    };
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", abort, { once: true });
    document.addEventListener("visibilitychange", changed);
    changed();
  });
}

/** Two animation frames put optional activation after the committed Shell paint. */
export function startAfterWorkbenchPaint(start: () => Promise<void>, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};
  let frame = 0;
  const abort = () => cancelAnimationFrame(frame);
  signal.addEventListener("abort", abort, { once: true });
  frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
    signal.removeEventListener("abort", abort);
    if (!signal.aborted) void start().catch(() => { /* Each feature reports its own failure. */ });
  }); });
  return () => { abort(); signal.removeEventListener("abort", abort); };
}

type OptionalFeature = {
  readonly id: string;
  readonly activate: (signal: AbortSignal) => Promise<unknown>;
};

/** Application-owned work, released only after its first usable chat paint. */
export class OptionalFeatureStartup {
  private readonly controller = new AbortController();
  private readonly features: OptionalFeature[] = [];
  private operation: Promise<void> | null = null;

  add(id: string, activate: OptionalFeature["activate"]): void {
    this.controller.signal.throwIfAborted();
    if (this.operation !== null) throw new Error("Optional startup plan has already started");
    this.features.push({ id, activate });
  }

  start(): Promise<void> {
    if (this.operation !== null) return this.operation;
    if (this.controller.signal.aborted) return Promise.resolve();
    this.operation = Promise.resolve().then(() => this.run());
    return this.operation;
  }

  async dispose(): Promise<void> {
    this.controller.abort();
    this.features.length = 0;
    // Drain an activation before disposing the registries it may still borrow.
    // ExtensionSupervisor bounds activation/rollback independently.
    await this.operation;
  }

  private async run(): Promise<void> {
    while (!this.controller.signal.aborted) {
      if (typeof document !== "undefined") {
        try { await waitForOptionalFeatureWindow(this.controller.signal); } catch { return; }
      }
      const feature = this.features.shift();
      if (feature === undefined) return;
      try {
        await feature.activate(this.controller.signal);
      } catch {
        if (!this.controller.signal.aborted) {
          console.warn("[optional-startup] Feature unavailable", { featureId: feature.id });
        }
      }
    }
  }
}

/** A late module cannot acquire an activation or install into a retired app. */
export function loadOptionalFeatureModule<T>(load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const moduleController = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const finish = (complete: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => {
      moduleController.abort(signal?.reason);
      finish(() => reject(moduleController.signal.reason));
    };
    const timer = setTimeout(() => {
      moduleController.abort(new Error("Optional feature module load timed out"));
      finish(() => reject(moduleController.signal.reason));
    }, 15_000);
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      moduleController.signal.throwIfAborted();
      return load(moduleController.signal);
    }).then(
      value => finish(() => { moduleController.signal.aborted ? reject(moduleController.signal.reason) : resolve(value); }),
      error => finish(() => reject(error)),
    );
  });
}
