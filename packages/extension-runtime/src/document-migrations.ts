import type { ExtensionDocumentOptions, ExtensionDocumentSnapshot, ExtensionJson } from "@opencraft/extension-contract";
import { serializeExtensionData, validateDataVersion, type ExtensionDataRecord, type ExtensionPersistence } from "./persistence";

function unpack(record: ExtensionDataRecord): { data: ExtensionJson; migrations: Record<string, string> } {
  const value = record.value;
  if (!value || typeof value !== "object" || Array.isArray(value) || !("data" in value) || !value.migrations || typeof value.migrations !== "object" || Array.isArray(value.migrations)
    || Object.values(value.migrations).some(v => typeof v !== "string")) throw new Error("Unsupported plugin document; original data retained");
  return { data: value.data!, migrations: value.migrations as Record<string, string> };
}

/** Payload policy is separate from activation ownership and physical schema. */
export function documentSchema(input: ExtensionDocumentOptions) {
  validateDataVersion(input.version);
  const version = input.version;
  const initialValue = JSON.parse(serializeExtensionData(input.initialValue)) as ExtensionJson;
  const migrations = (input.migrations ?? []).map(m => ({ version: m.version, checksum: m.checksum, migrate: m.migrate }));
  if (migrations.length !== version - 1 || migrations.some((m, i) => m.version !== i + 2 || !/^[a-f0-9]{64}$/.test(m.checksum) || typeof m.migrate !== "function")) throw new Error("Incomplete plugin document migration chain");
  const hashes = Object.fromEntries(migrations.map(m => [String(m.version), m.checksum]));
  function check(record: ExtensionDataRecord) {
    if (record.version > version) throw new Error("Plugin document requires a newer plugin; original data retained");
    const value = unpack(record);
    for (const [target, checksum] of Object.entries(value.migrations)) {
      if (hashes[target] !== checksum) throw new Error("Plugin document migration checksum mismatch");
    }
    for (let v = 2; v <= record.version; v++) {
      if (value.migrations[String(v)] !== hashes[String(v)]) throw new Error("Plugin document migration history incomplete");
    }
    return value;
  }
  const payload = (data: ExtensionJson): ExtensionJson => ({ data, migrations: hashes });
  const snapshot = (record: ExtensionDataRecord): ExtensionDocumentSnapshot => {
    const value = check(record);
    if (record.version !== version) throw new Error("Plugin document version changed; reopen required");
    return { revision: record.revision, version: record.version, value: structuredClone(value.data) };
  };
  async function prepare(backend: ExtensionPersistence, scope: string, assertLive: () => void): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      assertLive();
      const current = await backend.read(scope); assertLive();
      if (current?.version === version) { check(current); return; }
      let data = initialValue;
      if (current) {
        data = check(current).data;
        for (const migration of migrations.filter(m => m.version > current.version)) {
          data = migration.migrate(structuredClone(data)); serializeExtensionData(data);
        }
      }
      assertLive();
      const result = await backend.compareAndSet(scope, current?.revision ?? 0, version, payload(data));
      if (result.updated) return;
    }
    throw new Error("Plugin document changed during migration; retry opening it");
  }
  return { version, payload, snapshot, prepare };
}
