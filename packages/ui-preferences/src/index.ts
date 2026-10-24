export type UiPreferenceScope = "installation" | "account" | "workspace";
export type ShellNavigationDetent = "expanded" | "compact" | "hidden";
export type ShellNavigationVisibleDetent = Exclude<ShellNavigationDetent, "hidden">;

export interface UiPreferenceValues {
  readonly "interface.touchFriendly": "auto" | "on" | "off";
  readonly "voice.inputProvider": "auto" | "system" | "hunyuan";
  readonly "locale.override": string;
  readonly "chat.modelSelections": Readonly<Record<string, { readonly model: string; readonly effort: string | null; readonly serviceTier?: string | null }>>;
  readonly "chat.defaultFollowUpAction": "steer" | "queue";
  readonly "chat.turnNotifications": boolean;
  readonly "chat.touchNewera": boolean;
  readonly "shell.toolbarDocks": Readonly<Record<string, readonly string[]>>;
  readonly "shell.applicationsPinned": boolean;
  readonly "shell.accountPinned": boolean;
  readonly "shell.navigationDetent": ShellNavigationDetent;
  readonly "shell.lastVisibleNavigationDetent": ShellNavigationVisibleDetent;
  readonly "shell.navigationWidth": number;
  readonly "shell.contextSidebarWidth": number;
  readonly "sidebar.serverFilter": { readonly serverId: string; readonly label: string };
  readonly "sidebar.conversationOverview": boolean;
}

export type UiPreferenceKey = keyof UiPreferenceValues;
export type UiPreferenceValue<Key extends UiPreferenceKey> = UiPreferenceValues[Key];

export interface UiPreferenceDefinition<Key extends UiPreferenceKey = UiPreferenceKey> {
  readonly key: Key;
  readonly scope: UiPreferenceScope;
  readonly defaultValue: UiPreferenceValue<Key>;
  parse(value: unknown): UiPreferenceValue<Key> | null;
}

const booleanValue = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
const detentValue = (value: unknown): ShellNavigationDetent | null =>
  value === "expanded" || value === "compact" || value === "hidden" ? value : null;
const visibleDetentValue = (value: unknown): ShellNavigationVisibleDetent | null =>
  value === "expanded" || value === "compact" ? value : null;
const widthValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const uiPreferenceDefinitions = Object.freeze({
  "shell.toolbarDocks": {
    key: "shell.toolbarDocks", scope: "installation", defaultValue: {},
    parse: (value: unknown): UiPreferenceValues["shell.toolbarDocks"] | null => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const entries = Object.entries(value);
      if (entries.length > 256) return null;
      for (const [key, ids] of entries) {
        if (!key || key.length > 2048 || !Array.isArray(ids) || ids.length > 32
          || ids.some(id => typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(id))
          || new Set(ids).size !== ids.length) return null;
      }
      return Object.fromEntries(entries.map(([key, ids]) => [key, [...ids]]));
    },
  },
  "sidebar.conversationOverview": {
    key: "sidebar.conversationOverview", scope: "installation", defaultValue: false, parse: booleanValue,
  },
  "chat.modelSelections": {
    key: "chat.modelSelections", scope: "installation", defaultValue: {},
    parse: (value: unknown): UiPreferenceValues["chat.modelSelections"] | null => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
      const entries: [string, { model: string; effort: string | null; serviceTier?: string | null }][] = [];
      for (const [scope, selection] of Object.entries(value)) {
        if (!selection || typeof selection !== "object" || Array.isArray(selection)
          || typeof selection.model !== "string" || selection.model.length === 0
          || (selection.effort !== null && typeof selection.effort !== "string")
          || !(selection.serviceTier === undefined || selection.serviceTier === null || typeof selection.serviceTier === "string" && selection.serviceTier.trim().length > 0 && selection.serviceTier.length <= 128)) return null;
        entries.push([scope, { model: selection.model, effort: selection.effort, ...(selection.serviceTier === undefined ? {} : { serviceTier: selection.serviceTier }) }]);
      }
      return Object.fromEntries(entries);
    },
  },
  "sidebar.serverFilter": {
    key: "sidebar.serverFilter", scope: "installation", defaultValue: { serverId: "", label: "" },
    parse: (value: unknown): UiPreferenceValues["sidebar.serverFilter"] | null => {
      if (!value || typeof value !== "object" || !("serverId" in value) || !("label" in value)) return null;
      if (typeof value.serverId !== "string" || typeof value.label !== "string"
        || value.serverId.length > 1024 || value.label.length > 1024) return null;
      return { serverId: value.serverId, label: value.label };
    },
  },
  "interface.touchFriendly": {
    key: "interface.touchFriendly", scope: "installation", defaultValue: "auto",
    parse: (value: unknown): "auto" | "on" | "off" | null =>
      value === "auto" || value === "on" || value === "off" ? value : null,
  },
  "chat.touchNewera": {
    key: "chat.touchNewera", scope: "installation", defaultValue: false, parse: booleanValue,
  },
  "chat.turnNotifications": {
    key: "chat.turnNotifications", scope: "installation", defaultValue: false,
    parse: booleanValue,
  },
  "voice.inputProvider": {
    key: "voice.inputProvider", scope: "installation", defaultValue: "auto",
    parse: (value: unknown): "auto" | "system" | "hunyuan" | null =>
      value === "auto" || value === "system" || value === "hunyuan" ? value : null,
  },
  "chat.defaultFollowUpAction": {
    key: "chat.defaultFollowUpAction",
    scope: "installation",
    defaultValue: "queue",
    parse: (value: unknown): "steer" | "queue" | null =>
      value === "steer" || value === "queue" ? value : null,
  },
  "locale.override": {
    key: "locale.override",
    scope: "installation",
    defaultValue: "",
    parse: (value: unknown): string | null => {
      if (value === "") return "";
      if (typeof value !== "string" || value.length > 100) return null;
      try { return Intl.getCanonicalLocales(value)[0] ?? null; } catch { return null; }
    },
  },
  "shell.applicationsPinned": {
    key: "shell.applicationsPinned",
    scope: "installation",
    defaultValue: false,
    parse: booleanValue,
  },
  "shell.accountPinned": {
    key: "shell.accountPinned",
    scope: "installation",
    defaultValue: false,
    parse: booleanValue,
  },
  "shell.navigationDetent": {
    key: "shell.navigationDetent",
    scope: "installation",
    defaultValue: "expanded",
    parse: detentValue,
  },
  "shell.lastVisibleNavigationDetent": {
    key: "shell.lastVisibleNavigationDetent",
    scope: "installation",
    defaultValue: "expanded",
    parse: visibleDetentValue,
  },
  "shell.navigationWidth": {
    key: "shell.navigationWidth",
    scope: "installation",
    defaultValue: 137,
    parse: widthValue,
  },
  "shell.contextSidebarWidth": {
    key: "shell.contextSidebarWidth",
    scope: "installation",
    defaultValue: 275,
    parse: widthValue,
  },
} as const satisfies { readonly [Key in UiPreferenceKey]: UiPreferenceDefinition<Key> });

export const UI_PREFERENCE_KEYS = Object.freeze(Object.keys(uiPreferenceDefinitions) as UiPreferenceKey[]);

function definitionFor<Key extends UiPreferenceKey>(key: Key): UiPreferenceDefinition<Key> {
  return uiPreferenceDefinitions[key] as unknown as UiPreferenceDefinition<Key>;
}

export interface StoredUiPreference {
  readonly key: UiPreferenceKey;
  readonly revision: number;
  readonly valueJson: string;
  readonly updatedAt: number;
}

export type CompareAndSetPreferenceResult =
  | { readonly outcome: "updated"; readonly record: StoredUiPreference }
  | { readonly outcome: "conflict"; readonly revision: number };

export interface UiPreferenceStore {
  load(key: UiPreferenceKey): Promise<StoredUiPreference | null>;
  compareAndSet(
    key: UiPreferenceKey,
    expectedRevision: number,
    valueJson: string,
  ): Promise<CompareAndSetPreferenceResult>;
  subscribe?(listener: (key: UiPreferenceKey) => void): () => void;
  close?(): void | Promise<void>;
}

export interface UiPreferencesSnapshot {
  readonly revision: number;
  readonly values: Readonly<UiPreferenceValues>;
  readonly storedRevisions: Readonly<Partial<Record<UiPreferenceKey, number>>>;
}

function defaultValues(): UiPreferenceValues {
  return Object.fromEntries(UI_PREFERENCE_KEYS.map((key) => [
    key,
    uiPreferenceDefinitions[key].defaultValue,
  ])) as unknown as UiPreferenceValues;
}

function parseRecord<Key extends UiPreferenceKey>(
  key: Key,
  record: StoredUiPreference | null,
  fallback: UiPreferenceValue<Key> = definitionFor(key).defaultValue,
): { readonly revision: number; readonly value: UiPreferenceValue<Key> } {
  const definition = definitionFor(key);
  if (record === null) return { revision: 0, value: fallback };
  try {
    const parsed = definition.parse(JSON.parse(record.valueJson));
    return parsed === null
      ? { revision: record.revision, value: fallback }
      : { revision: record.revision, value: parsed };
  } catch {
    return { revision: record.revision, value: fallback };
  }
}

export class UiPreferencesRuntime {
  readonly #listeners = new Set<() => void>();
  readonly #defaults: Readonly<UiPreferenceValues>;
  readonly #stores: Readonly<Partial<Record<UiPreferenceScope, UiPreferenceStore>>>;
  readonly #tails = new Map<UiPreferenceKey, Promise<void>>();
  readonly #disposeStores: (() => void)[] = [];
  #closed = false;
  #snapshot: UiPreferencesSnapshot;

  private constructor(
    stores: Readonly<Partial<Record<UiPreferenceScope, UiPreferenceStore>>>,
    snapshot: UiPreferencesSnapshot,
    defaults: Readonly<UiPreferenceValues>,
  ) {
    this.#stores = stores;
    this.#defaults = defaults;
    this.#snapshot = snapshot;
    for (const [scope, store] of Object.entries(stores) as [UiPreferenceScope, UiPreferenceStore][]) {
      if (store.subscribe === undefined) continue;
      this.#disposeStores.push(store.subscribe((key) => {
        if (uiPreferenceDefinitions[key].scope === scope) void this.#refresh(key);
      }));
    }
  }

  static async open(stores: Readonly<Partial<Record<UiPreferenceScope, UiPreferenceStore>>>, options: {
    readonly defaults?: Readonly<Partial<UiPreferenceValues>>;
  } = {}): Promise<UiPreferencesRuntime> {
    const defaults = Object.freeze({ ...defaultValues(), ...options.defaults });
    for (const key of UI_PREFERENCE_KEYS) {
      if (definitionFor(key).parse(defaults[key]) === null) throw new TypeError(`Invalid default for ${key}`);
    }
    const values = { ...defaults };
    const storedRevisions: Partial<Record<UiPreferenceKey, number>> = {};
    for (const key of UI_PREFERENCE_KEYS) {
      const definition = uiPreferenceDefinitions[key];
      const store = stores[definition.scope];
      if (store === undefined) throw new Error(`Missing ${definition.scope} preference store for ${key}`);
      const parsed = parseRecord(key, await store.load(key), defaults[key]);
      (values as Record<UiPreferenceKey, unknown>)[key] = parsed.value;
      storedRevisions[key] = parsed.revision;
    }
    return new UiPreferencesRuntime(stores, Object.freeze({
      revision: 1,
      values: Object.freeze(values),
      storedRevisions: Object.freeze(storedRevisions),
    }), defaults);
  }

  getSnapshot = (): UiPreferencesSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#ensureOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  get<Key extends UiPreferenceKey>(key: Key): UiPreferenceValue<Key> {
    return this.#snapshot.values[key];
  }

  storedRevision(key: UiPreferenceKey): number {
    return this.#snapshot.storedRevisions[key] ?? 0;
  }

  set<Key extends UiPreferenceKey>(key: Key, value: UiPreferenceValue<Key>, options: { readonly optimistic?: boolean } = {}): Promise<void> {
    this.#ensureOpen();
    const parsed = definitionFor(key).parse(value);
    if (parsed === null) return Promise.reject(new TypeError(`Invalid UI preference value for ${key}`));
    if (this.storedRevision(key) > 0 && Object.is(this.#snapshot.values[key], parsed) && !this.#tails.has(key)) return Promise.resolve();
    if (options.optimistic !== false) this.#publishValue(key, parsed);
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const tail = previous.catch(() => undefined).then(() => this.#persist(key, parsed)).then(() => {
      if (options.optimistic === false && this.#tails.get(key) === tail) this.#publishValue(key, parsed);
    }).finally(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    this.#tails.set(key, tail);
    return tail;
  }

  reset<Key extends UiPreferenceKey>(key: Key): Promise<void> {
    return this.set(key, this.#defaults[key]);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.#tails.values()]);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.flush();
    this.#closed = true;
    for (const dispose of this.#disposeStores.splice(0)) dispose();
    this.#listeners.clear();
    await Promise.all(Object.values(this.#stores).map((store) => store?.close?.()));
  }

  async #persist<Key extends UiPreferenceKey>(key: Key, value: UiPreferenceValue<Key>): Promise<void> {
    const definition = definitionFor(key);
    const store = this.#stores[definition.scope]!;
    let expectedRevision = this.storedRevision(key);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await store.compareAndSet(key, expectedRevision, JSON.stringify(value));
      if (result.outcome === "updated") {
        this.#publishStoredRevision(key, result.record.revision);
        return;
      }
      const latest = parseRecord(key, await store.load(key), this.#defaults[key]);
      expectedRevision = latest.revision;
      this.#publishStoredRevision(key, latest.revision);
    }
    throw new Error(`UI preference conflict for ${key}`);
  }

  async #refresh(key: UiPreferenceKey): Promise<void> {
    if (this.#closed || this.#tails.has(key)) return;
    const definition = definitionFor(key);
    const record = parseRecord(key, await this.#stores[definition.scope]!.load(key), this.#defaults[key]);
    if (record.revision <= this.storedRevision(key)) return;
    this.#publish(key, record.value, record.revision);
  }

  #publishValue<Key extends UiPreferenceKey>(key: Key, value: UiPreferenceValue<Key>): void {
    this.#publish(key, value, this.storedRevision(key));
  }

  #publishStoredRevision(key: UiPreferenceKey, revision: number): void {
    this.#publish(key, this.#snapshot.values[key], revision);
  }

  #publish<Key extends UiPreferenceKey>(key: Key, value: UiPreferenceValue<Key>, storedRevision: number): void {
    this.#snapshot = Object.freeze({
      revision: this.#snapshot.revision + 1,
      values: Object.freeze({ ...this.#snapshot.values, [key]: value }),
      storedRevisions: Object.freeze({ ...this.#snapshot.storedRevisions, [key]: storedRevision }),
    });
    for (const listener of this.#listeners) listener();
  }

  #ensureOpen(): void {
    if (this.#closed) throw new Error("UI preferences runtime is closed");
  }
}

export class MemoryUiPreferenceStore implements UiPreferenceStore {
  readonly #records = new Map<UiPreferenceKey, StoredUiPreference>();
  readonly #listeners = new Set<(key: UiPreferenceKey) => void>();

  async load(key: UiPreferenceKey): Promise<StoredUiPreference | null> {
    return this.#records.get(key) ?? null;
  }

  async compareAndSet(key: UiPreferenceKey, expectedRevision: number, valueJson: string): Promise<CompareAndSetPreferenceResult> {
    const current = this.#records.get(key);
    const revision = current?.revision ?? 0;
    if (revision !== expectedRevision) return { outcome: "conflict", revision };
    const record = Object.freeze({ key, revision: revision + 1, valueJson, updatedAt: Date.now() });
    this.#records.set(key, record);
    for (const listener of this.#listeners) listener(key);
    return { outcome: "updated", record };
  }

  subscribe(listener: (key: UiPreferenceKey) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
