export interface PersistedFeatureStateHost extends EventTarget {
  readonly localStorage?: Pick<Storage, "getItem" | "setItem">;
}

export interface PersistedFeatureStateOptions {
  readonly id: string;
  readonly storageKey: string;
  readonly eventName?: string;
  readonly defaultValue?: boolean;
}

export interface PersistedFeatureState {
  readonly eventName: string;
  readonly storageKey: string;
  get(host?: PersistedFeatureStateHost | null): boolean;
  set(value: boolean, host?: PersistedFeatureStateHost | null): boolean;
  toggle(host?: PersistedFeatureStateHost | null): boolean;
  subscribe(listener: (value: boolean) => void, host?: PersistedFeatureStateHost | null): () => void;
}

const browserHost = (): PersistedFeatureStateHost | null => (
  typeof window === "undefined" ? null : window
);

/** Versioned durable feature state with storage-policy-safe in-page fallback. */
export function createPersistedFeatureState(
  options: PersistedFeatureStateOptions,
): PersistedFeatureState {
  const eventName = options.eventName ?? `lightvela:feature-state:${options.id}`;
  const fallback = options.defaultValue ?? false;
  const memory = new WeakMap<PersistedFeatureStateHost, boolean>();
  const resolveHost = (host?: PersistedFeatureStateHost | null) => host ?? browserHost();

  const readStorage = (host: PersistedFeatureStateHost): boolean | null => {
    try {
      const value = host.localStorage?.getItem(options.storageKey);
      if (value === "1") return true;
      if (value === "0") return false;
    } catch {
      // Privacy modes and storage policy may reject access.
    }
    return null;
  };

  const get = (host?: PersistedFeatureStateHost | null): boolean => {
    const target = resolveHost(host);
    if (target === null) return fallback;
    return memory.get(target) ?? readStorage(target) ?? fallback;
  };

  const set = (value: boolean, host?: PersistedFeatureStateHost | null): boolean => {
    const target = resolveHost(host);
    if (target === null) return value;
    memory.set(target, value);
    try {
      target.localStorage?.setItem(options.storageKey, value ? "1" : "0");
    } catch {
      // The in-page value remains authoritative until this Host is retired.
    }
    target.dispatchEvent(new CustomEvent<boolean>(eventName, { detail: value }));
    return value;
  };

  const subscribe = (
    listener: (value: boolean) => void,
    host?: PersistedFeatureStateHost | null,
  ): (() => void) => {
    const target = resolveHost(host);
    if (target === null) return () => undefined;
    const handleFeatureEvent = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const value = typeof detail === "boolean" ? detail : get(target);
      memory.set(target, value);
      listener(value);
    };
    const handleStorage = (event: Event) => {
      const storageEvent = event as StorageEvent;
      if (storageEvent.key !== options.storageKey) return;
      const value = storageEvent.newValue === "1"
        ? true
        : storageEvent.newValue === "0"
          ? false
          : fallback;
      memory.set(target, value);
      listener(value);
    };
    target.addEventListener(eventName, handleFeatureEvent);
    target.addEventListener("storage", handleStorage);
    listener(get(target));
    return () => {
      target.removeEventListener(eventName, handleFeatureEvent);
      target.removeEventListener("storage", handleStorage);
    };
  };

  return Object.freeze({
    eventName,
    storageKey: options.storageKey,
    get,
    set,
    toggle: (host?: PersistedFeatureStateHost | null) => set(!get(host), host),
    subscribe,
  });
}
