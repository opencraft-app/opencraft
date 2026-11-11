import type {
  InterruptReceipt,
  ModelRow,
  NativeFactory,
  NativeInitInfo,
  NativeSessionPort,
  NativeStartOptions,
  PermissionModeName,
} from '../../../apps/claude-code-bridge/src/types.js';

class MessageStream implements AsyncIterable<unknown> {
  private items: unknown[] = [];
  private waiters: { resolve: (result: IteratorResult<unknown>) => void; reject: (error: Error) => void }[] = [];
  private error?: Error;
  private ended = false;

  push(item: unknown): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    for (const waiter of this.waiters) waiter.reject(error ?? new Error('stream ended'));
    this.waiters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.ended) return this.error ? Promise.reject(this.error) : Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

export class FakeClaudeNative implements NativeSessionPort {
  readonly messages = new MessageStream();
  readonly pushes: { text: string; uuid: string }[] = [];
  readonly models: ModelRow[] = [
    { id: 'haiku', name: 'Haiku 5.5', description: 'cheap', resolvedModel: 'claude-haiku-5-5' },
    { id: 'sonnet', name: 'Sonnet 5.5', description: 'default', resolvedModel: 'claude-sonnet-5-5' },
  ];
  readonly init: NativeInitInfo;
  readonly pushedModels: string[] = [];
  readonly pushedPermissionModes: string[] = [];
  interrupts = 0;
  closes = 0;
  interruptReceipt: InterruptReceipt = { stillQueued: [], cancelled: [] };
  pushError?: Error;
  blockPush = false;
  hangInitialize = false;
  onPush?: (push: { text: string; uuid: string }, index: number) => void;
  private releases: { resolve: () => void; reject: (error: Error) => void }[] = [];
  private withdrawn = new Set<string>();

  constructor(readonly options: NativeStartOptions) {
    this.init = {
      sessionId: options.sessionId,
      version: '2.1.321',
      model: options.model ?? 'haiku',
      permissionMode: options.permissionMode ?? 'default',
      models: this.models,
      capabilities: ['interrupt_receipt_v1'],
      pid: 4242,
    };
  }

  initialize(): Promise<NativeInitInfo> {
    if (this.hangInitialize) return new Promise(() => {});
    return Promise.resolve(this.init);
  }

  push(text: string, uuid: string): Promise<void> {
    if (this.pushError) return Promise.reject(this.pushError);
    this.pushes.push({ text, uuid });
    this.onPush?.({ text, uuid }, this.pushes.length - 1);
    if (!this.blockPush) return Promise.resolve();
    return new Promise((resolve, reject) => { this.releases.push({ resolve, reject }); });
  }

  failInput(error: Error): void {
    this.pushError = error;
    for (const release of this.releases.splice(0)) release.reject(error);
  }

  releasePush(): void {
    this.blockPush = false;
    for (const release of this.releases.splice(0)) release.resolve();
  }

  withdraw(uuid: string): boolean {
    if (!this.pushes.some((push) => push.uuid === uuid) || this.withdrawn.has(uuid)) return false;
    this.withdrawn.add(uuid);
    return true;
  }

  interrupt(): Promise<InterruptReceipt> {
    this.interrupts += 1;
    return Promise.resolve(this.interruptReceipt);
  }

  close(): Promise<void> {
    this.closes += 1;
    this.failInput(new Error("native closed"));
    this.messages.end();
    return Promise.resolve();
  }

  setModel(model: string): Promise<void> {
    this.pushedModels.push(model);
    return Promise.resolve();
  }

  setPermissionMode(mode: PermissionModeName): Promise<void> {
    this.pushedPermissionModes.push(mode);
    return Promise.resolve();
  }

  emit(message: unknown): void {
    this.messages.push(message);
  }

  end(error?: Error): void {
    this.messages.end(error);
  }
}

export class FakeClaudeFactory implements NativeFactory {
  readonly natives: FakeClaudeNative[] = [];
  last!: FakeClaudeNative;

  start(options: NativeStartOptions): NativeSessionPort {
    const native = new FakeClaudeNative(options);
    this.natives.push(native);
    this.last = native;
    return native;
  }
}
