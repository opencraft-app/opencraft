import type {
  SettingsFieldContribution,
} from "@opencraft/extension-contract";

import type { ExtensionContributionStore } from "./contribution-store";

export type ExtensionSettingValue = boolean | number | string;

export interface StoredExtensionSetting {
  readonly key: string;
  readonly contributionId: string;
  readonly fieldKey: string;
  readonly value: ExtensionSettingValue;
}

export interface ExtensionSettingsStorage {
  load(): Promise<readonly StoredExtensionSetting[]>;
  put(record: StoredExtensionSetting): Promise<void>;
  remove(key: string): Promise<void>;
  subscribe?(listener: () => void): () => void;
  close(): void | Promise<void>;
}

export interface ExtensionSettingsSnapshot {
  readonly revision: number;
  readonly values: readonly StoredExtensionSetting[];
}

export function extensionSettingStorageKey(
  contributionId: string,
  fieldKey: string,
): string {
  return `${contributionId}\u0000${fieldKey}`;
}

function findField(
  contributions: ExtensionContributionStore,
  contributionId: string,
  fieldKey: string,
): SettingsFieldContribution {
  const settings = contributions.getSnapshot().settingsSchemas.find(
    ({ contribution }) => contribution.id === contributionId,
  )?.contribution;
  if (settings === undefined) {
    throw new Error(`Settings contribution ${contributionId} is not registered`);
  }
  const field = settings.fields.find((candidate) => candidate.key === fieldKey);
  if (field === undefined) {
    throw new Error(`Setting ${contributionId}.${fieldKey} is not declared`);
  }
  return field;
}

function defaultValue(field: SettingsFieldContribution): ExtensionSettingValue | undefined {
  return field.defaultValue;
}

function isValidValue(
  field: SettingsFieldContribution,
  value: unknown,
): value is ExtensionSettingValue {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "select":
      return typeof value === "string"
        && field.options.some((option) => option.value === value);
  }
}

function assertValidValue(
  contributionId: string,
  field: SettingsFieldContribution,
  value: unknown,
): asserts value is ExtensionSettingValue {
  if (!isValidValue(field, value)) {
    throw new TypeError(
      `Setting ${contributionId}.${field.key} does not accept ${JSON.stringify(value)}`,
    );
  }
}

export function normalizeStoredExtensionSetting(input: unknown): StoredExtensionSetting | null {
  if (!input || typeof input !== "object") return null;
  const value = input as StoredExtensionSetting;
  if (
    typeof value.contributionId !== "string"
    || value.contributionId.length === 0
    || typeof value.fieldKey !== "string"
    || value.fieldKey.length === 0
    || value.key !== extensionSettingStorageKey(value.contributionId, value.fieldKey)
    || (
      typeof value.value !== "boolean"
      && typeof value.value !== "string"
      && (typeof value.value !== "number" || !Number.isFinite(value.value))
    )
  ) return null;
  return Object.freeze({ ...value });
}

/**
 * Minimal current-profile settings service. Contributions own schemas;
 * storage owns bytes; this service owns validation and publication ordering.
 */
export class ExtensionSettingsStore {
  private readonly values = new Map<string, StoredExtensionSetting>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeContributions: () => void;
  private unsubscribeStorage: (() => void) | undefined;
  private revision = 0;
  private closed = false;
  private mutation: Promise<void> = Promise.resolve();
  private snapshot: ExtensionSettingsSnapshot = Object.freeze({
    revision: 0,
    values: Object.freeze([]),
  });

  private constructor(
    private readonly contributions: ExtensionContributionStore,
    private readonly storage: ExtensionSettingsStorage,
  ) {
    this.unsubscribeContributions = contributions.subscribe(() => this.publish());
  }

  static async open(
    contributions: ExtensionContributionStore,
    storage: ExtensionSettingsStorage,
  ): Promise<ExtensionSettingsStore> {
    const store = new ExtensionSettingsStore(contributions, storage);
    try {
      for (const raw of await storage.load()) {
        const record = normalizeStoredExtensionSetting(raw);
        if (record !== null) store.values.set(record.key, record);
      }
      store.publish();
      store.unsubscribeStorage = storage.subscribe?.(() => {
        if (store.closed) return;
        void store.enqueue(async () => {
          const records = await storage.load();
          if (store.closed) return;
          store.values.clear();
          for (const raw of records) { const record = normalizeStoredExtensionSetting(raw); if (record) store.values.set(record.key, record); }
          store.publish();
        }).catch(() => { /* Preserve last good values; writes still surface storage errors. */ });
      });
      return store;
    } catch (error) {
      store.unsubscribeContributions();
      await storage.close();
      throw error;
    }
  }

  getSnapshot = (): ExtensionSettingsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.ensureOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get(
    contributionId: string,
    fieldKey: string,
  ): ExtensionSettingValue | undefined {
    this.ensureOpen();
    const field = findField(this.contributions, contributionId, fieldKey);
    const stored = this.values.get(extensionSettingStorageKey(contributionId, fieldKey));
    return stored !== undefined && isValidValue(field, stored.value)
      ? stored.value
      : defaultValue(field);
  }

  async set(
    contributionId: string,
    fieldKey: string,
    value: ExtensionSettingValue,
  ): Promise<void> {
    return this.enqueue(async () => {
      const field = findField(this.contributions, contributionId, fieldKey);
      assertValidValue(contributionId, field, value);
      const record = Object.freeze({
        key: extensionSettingStorageKey(contributionId, fieldKey),
        contributionId,
        fieldKey,
        value,
      });
      await this.storage.put(record);
      this.values.set(record.key, record);
      this.publish();
    });
  }

  async reset(contributionId: string, fieldKey: string): Promise<void> {
    return this.enqueue(async () => {
      findField(this.contributions, contributionId, fieldKey);
      const key = extensionSettingStorageKey(contributionId, fieldKey);
      if (!this.values.has(key)) return;
      await this.storage.remove(key);
      this.values.delete(key);
      this.publish();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeStorage?.();
    this.unsubscribeContributions();
    await this.mutation;
    this.listeners.clear();
    await this.storage.close();
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.ensureOpen();
    const operation = this.mutation.then(work);
    this.mutation = operation.catch(() => undefined);
    return operation;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Extension settings store is closed");
  }

  private publish(): void {
    if (this.closed) return;
    this.snapshot = Object.freeze({
      revision: ++this.revision,
      values: Object.freeze([...this.values.values()].sort(
        (left, right) => left.key.localeCompare(right.key),
      )),
    });
    for (const listener of this.listeners) listener();
  }
}

export class MemoryExtensionSettingsStorage implements ExtensionSettingsStorage {
  private readonly values = new Map<string, StoredExtensionSetting>();

  constructor(seed: readonly StoredExtensionSetting[] = []) {
    for (const record of seed) this.values.set(record.key, structuredClone(record));
  }

  async load(): Promise<readonly StoredExtensionSetting[]> {
    return [...this.values.values()].map((record) => structuredClone(record));
  }

  async put(record: StoredExtensionSetting): Promise<void> {
    this.values.set(record.key, structuredClone(record));
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }

  close(): void {}
}
