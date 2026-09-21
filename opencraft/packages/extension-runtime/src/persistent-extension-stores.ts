import type { ExtensionJson } from "@opencraft/extension-contract";
import type { ExtensionPersistence, ExtensionDataRecord } from "./persistence";
import type { ExtensionSettingsStorage, StoredExtensionSetting } from "./settings-store";
import { normalizeStoredExtensionSetting } from "./settings-store";
import { normalizeInstallation } from "./installation-repository";
import type { ExtensionInstallationPersistence, ExtensionInstallationRecord } from "./installation-repository";

/** Existing settings/installations keep their domain codecs; this owns persistent CAS. */
class RecordCollection {
  private current: ExtensionDataRecord | null = null;
  private closed = false;
  constructor(private readonly backend: ExtensionPersistence, private readonly scope: string, private readonly key: string, private readonly validate: (value: unknown) => void) {}
  async initialize(legacy: () => Promise<readonly unknown[]>) {
    this.current = await this.backend.read(this.scope);
    if (!this.current) {
      const values = await legacy();
      this.validateRows(values);
      // Even an empty import is recorded once; later reloads cannot resurrect legacy data.
      const result = await this.backend.compareAndSet(this.scope, 0, 1, JSON.parse(JSON.stringify(values)) as ExtensionJson);
      this.current = result.record;
    }
    this.decode(this.current);
  }
  async load(): Promise<readonly unknown[]> {
    this.ensureOpen(); this.current = await this.backend.read(this.scope); return this.decode(this.current);
  }
  async change(id: string, record?: unknown) {
    this.ensureOpen();
    const rows = this.decode(this.current).filter(value => this.id(value) !== id);
    if (record !== undefined) rows.push(record);
    const result = await this.backend.compareAndSet(this.scope, this.current?.revision ?? 0, 1, JSON.parse(JSON.stringify(rows)) as ExtensionJson);
    this.current = result.record;
    if (!result.updated) throw new Error("Extension storage changed in another window; review the latest values and retry");
  }
  subscribe(listener: () => void) {
    return this.backend.subscribe(scope => { if (!this.closed && (scope === this.scope || scope === "*")) listener(); });
  }
  close() { this.closed = true; }
  private decode(record: ExtensionDataRecord | null): unknown[] {
    if (!record) return [];
    if (record.version !== 1 || !Array.isArray(record.value)) throw new Error("Unsupported extension data version; original data retained");
    this.validateRows(record.value);
    return structuredClone(record.value);
  }
  private validateRows(values: readonly unknown[]) {
    const ids = new Set<unknown>();
    for (const value of values) {
      this.validate(value);
      const id = this.id(value);
      if (ids.has(id)) throw new Error("Duplicate extension storage record; original data retained");
      ids.add(id);
    }
  }
  private id(value: unknown): unknown { return value && typeof value === "object" ? (value as Record<string, unknown>)[this.key] : undefined; }
  private ensureOpen() { if (this.closed) throw new Error("Extension collection closed"); }
}

export async function createPersistentExtensionSettingsStorage(backend: ExtensionPersistence, legacy: () => Promise<readonly unknown[]> = async () => []): Promise<ExtensionSettingsStorage> {
  const collection = new RecordCollection(backend, "system/settings", "key", value => {
    if (!normalizeStoredExtensionSetting(value)) throw new Error("Unknown extension settings record; original data retained");
  });
  await collection.initialize(legacy);
  return {
    load: () => collection.load() as Promise<readonly StoredExtensionSetting[]>,
    put: record => collection.change(record.key, record),
    remove: key => collection.change(key),
    subscribe: listener => collection.subscribe(listener),
    close: () => collection.close(),
  };
}
export async function createPersistentExtensionInstallations(backend: ExtensionPersistence, legacy: () => Promise<readonly unknown[]> = async () => []): Promise<ExtensionInstallationPersistence> {
  const collection = new RecordCollection(backend, "system/installations", "extensionId", normalizeInstallation);
  await collection.initialize(legacy);
  return {
    load: () => collection.load(),
    put: (record: ExtensionInstallationRecord) => collection.change(record.extensionId, record),
    remove: id => collection.change(id),
    subscribe: listener => collection.subscribe(listener),
    close: () => collection.close(),
  };
}
