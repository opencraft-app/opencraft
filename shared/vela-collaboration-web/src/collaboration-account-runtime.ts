export interface CollaborationAccountAuthority {
  getSnapshot(): { readonly authGeneration: number };
  subscribe(listener: () => void): () => void;
}

export interface CollaborationAccountScope {
  invalidate(): void;
  dispose(): Promise<void>;
}

export interface CollaborationScopeContext {
  readonly authGeneration: number;
  readonly beforeConnect: Promise<void>;
}

interface AccountRuntimeSnapshot<T> {
  readonly authGeneration: number;
  readonly scope: T;
}

export class CollaborationAccountRuntime<T extends CollaborationAccountScope> {
  private readonly listeners = new Set<() => void>();
  private snapshot: AccountRuntimeSnapshot<T>;
  private shutdown = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private disposeOperation: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly account: CollaborationAccountAuthority,
    private readonly createScope: (context: CollaborationScopeContext) => T,
  ) {
    const authGeneration = account.getSnapshot().authGeneration;
    this.snapshot = Object.freeze({
      authGeneration,
      scope: createScope({ authGeneration, beforeConnect: this.shutdown }),
    });
  }

  getSnapshot = (): AccountRuntimeSnapshot<T> => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (this.disposed) throw new Error("Collaboration account runtime is disposed");
    if (this.unsubscribe !== null) return;
    this.unsubscribe = this.account.subscribe(this.reconcile);
    this.reconcile();
  }

  private reconcile = (): void => {
    const authGeneration = this.account.getSnapshot().authGeneration;
    if (this.disposed || authGeneration === this.snapshot.authGeneration) return;
    const previous = this.snapshot.scope;
    previous.invalidate();
    this.shutdown = Promise.all([this.shutdown, previous.dispose()]).then(() => undefined);
    // Preserve a failed shutdown as the next connection barrier without an
    // unhandled rejection when no Workspace is currently mounted.
    void this.shutdown.catch(() => undefined);
    this.snapshot = Object.freeze({
      authGeneration,
      scope: this.createScope({ authGeneration, beforeConnect: this.shutdown }),
    });
    this.listeners.forEach((listener) => listener());
  };

  dispose(): Promise<void> {
    if (this.disposeOperation !== null) return this.disposeOperation;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
    this.snapshot.scope.invalidate();
    this.disposeOperation = Promise.all([this.shutdown, this.snapshot.scope.dispose()])
      .then(() => undefined);
    return this.disposeOperation;
  }
}
