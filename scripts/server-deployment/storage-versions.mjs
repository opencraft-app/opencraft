import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// Owned databases only migrate forward and old code refuses a newer ledger
// (`newer-schema`). Execution health reports each opened store's applied
// version, which equals the highest migration that release knows. Recording
// those observations per release lets a rollback be refused before it restarts
// a backend that can no longer open its own databases.

const KEY = /^[A-Za-z0-9._:@-]{1,160}$/;
const MAX_LISTED = 8;

/** Map `hostId:name` to applied version from an untrusted health body. */
export function storageVersionsFromHealth(health) {
  if (!Array.isArray(health?.storage)) return null;
  const versions = {};
  for (const item of health.storage) {
    if (!item || typeof item.name !== "string" || !Number.isSafeInteger(item.appliedVersion) || item.appliedVersion < 0)
      continue;
    if (item.hostId !== undefined && typeof item.hostId !== "string") continue;
    const key = `${item.hostId ?? ""}:${item.name}`;
    if (!KEY.test(key)) continue;
    versions[key] = Math.max(versions[key] ?? 0, item.appliedVersion);
  }
  return versions;
}

function validVersions(value) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, version]) => KEY.test(key) && Number.isSafeInteger(version) && version >= 0)
  );
}

export function emptyStorageRecord() {
  return { schemaVersion: 1, releases: {}, current: {} };
}

export async function readStorageRecord(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return emptyStorageRecord();
    throw error;
  }
  if (
    value?.schemaVersion !== 1 ||
    !validVersions(value.current) ||
    !value.releases ||
    typeof value.releases !== "object" ||
    !Object.values(value.releases).every(validVersions)
  ) {
    // An unreadable record only loses this guard; it must not block startup or recovery.
    console.warn("[opencraft execution] Ignoring an invalid storage version record");
    return emptyStorageRecord();
  }
  return value;
}

export async function writeStorageRecord(path, record) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Record what a running release reported. Its versions are both what that
 * release supports and what the opened databases now are.
 */
export function observeRelease(record, releaseRoot, versions) {
  if (!versions) return record;
  // A release's supported version per store never changes; lazily opened
  // stores may be missing from one observation, so merge rather than replace.
  return {
    ...record,
    releases: { ...record.releases, [releaseRoot]: { ...record.releases[releaseRoot], ...versions } },
    current: { ...record.current, ...versions },
  };
}

/** A candidate may migrate and still fail later checks; its databases moved anyway. */
export function observeDatabases(record, versions) {
  if (!versions) return record;
  const current = { ...record.current };
  for (const [key, version] of Object.entries(versions)) current[key] = Math.max(current[key] ?? 0, version);
  return { ...record, current };
}

/** Keep only releases the deployment still retains. */
export function retainReleases(record, roots) {
  const keep = new Set(roots);
  return {
    ...record,
    releases: Object.fromEntries(Object.entries(record.releases).filter(([root]) => keep.has(root))),
  };
}

/** Stores whose databases are newer than the target release last reported. */
export function advancedStores(record, releaseRoot) {
  const supported = record.releases[releaseRoot];
  if (!supported) return [];
  return Object.entries(record.current)
    .filter(([key, version]) => supported[key] !== undefined && version > supported[key])
    .map(([key, version]) => ({ key, from: supported[key], to: version }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function schemaAdvancedError(advanced, recordPath) {
  const listed = advanced
    .slice(0, MAX_LISTED)
    .map(({ key, from, to }) => `${key.replace(/^:/, "")} v${from}→v${to}`)
    .join(", ");
  const more = advanced.length > MAX_LISTED ? ` and ${advanced.length - MAX_LISTED} more` : "";
  return Object.assign(
    new Error(
      `Execution rollback refused: databases were upgraded beyond the selected release (${listed}${more}). ` +
        "That release cannot open them. Restore the pre-upgrade database snapshots (*.pre-v<N>-*.sqlite) with the execution service stopped, " +
        `then remove ${recordPath} before rolling back.`,
    ),
    { code: "EXECUTION_SCHEMA_ADVANCED", reason: "schema-advanced", advanced },
  );
}
