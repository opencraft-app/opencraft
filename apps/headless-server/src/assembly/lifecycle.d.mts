export interface HeadlessLifecycle {
  /** True from the moment shutdown starts; never returns to false. */
  closing(): boolean;
  /** Starts shutdown once: `dispose` runs in a later microtask and every call returns the same promise. */
  shutdown(dispose: () => Promise<void>): Promise<void>;
}

export function createHeadlessLifecycle(): HeadlessLifecycle;

export interface LateBinding<T> {
  /** Binds the value exactly once, where the composition root constructs it; returns it. */
  bind(value: T): T;
  /** The bound value; throws a named error when called before `bind`. */
  get(): T;
  /** The bound value, or `undefined` before `bind`. */
  current(): T | undefined;
}

export function createLateBinding<T>(name: string): LateBinding<T>;
