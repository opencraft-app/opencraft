import { parseNativeConversationProject } from "./native-conversation-project";
import type { Thread, ThreadStatus } from "./generated/v2";

export const THREAD_CATALOG_CHANGED = "opencraft/thread-catalog/changed";
export type ThreadCatalogFact =
  | { readonly type: "upsert"; readonly thread: Thread }
  | { readonly type: "remove"; readonly threadId: string }
  | { readonly type: "patch"; readonly threadId: string; readonly name?: string; readonly status?: ThreadStatus };
export type ThreadCatalogMutation = ThreadCatalogFact | { readonly type: "invalidate" }
  | { readonly type: "batch"; readonly changes: readonly ThreadCatalogFact[] };
export interface ThreadCatalogChange {
  readonly version: 1;
  readonly authority?: "directory";
  readonly source: string;
  readonly revision: number;
  readonly change: ThreadCatalogMutation;
}
/**
 * Whether every directory source contributed to a page. Partial and unknown
 * pages retain cached rows; their absence never certifies deletion.
 */
export type ThreadCatalogCoverage = "complete" | "partial" | "unknown";
/** Optional aggregate-directory metadata; native AppServers omit it. */
export interface ThreadCatalogMetadata {
  /** Last complete directory synchronization, if one has succeeded. */
  readonly lastSuccessAt?: number | null;
  /** Reader synchronization state. `error` and `warming` pages are incomplete. */
  readonly state: string;
  readonly coverage: ThreadCatalogCoverage;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const fields = ["id", "sessionId", "forkedFromId", "parentThreadId", "section", "sectionEnteredAt", "projectId", "historyMode", "modelProvider", "model", "reasoningEffort", "createdAt", "updatedAt", "recencyAt", "path", "cwd", "cliVersion", "originator", "source", "canAcceptDirectInput", "threadSource", "agentNickname", "agentRole", "gitInfo", "daybreakEnabled", "visibility"];

/** Directory metadata never carries history, tool payloads or execution credentials. */
export function threadCatalogEntry(value: unknown): Thread | null {
  const row = object(value);
  if (!id(row.id) || typeof row.cwd !== "string" || !time(row.createdAt) || !time(row.updatedAt) || row.ephemeral === true) return null;
  return { ...Object.fromEntries(fields.filter(key => key in row).map(key => [key, row[key]])),
    ...(parseNativeConversationProject(row.nativeProject) ? { nativeProject: parseNativeConversationProject(row.nativeProject)! } : {}),
    ...(row.accessMode === 'private' || row.accessMode === 'shared' ? {accessMode:row.accessMode} : {}),
    name: typeof row.name === "string" ? row.name.slice(0, 1024) : null,
    preview: typeof row.preview === "string" ? row.preview.slice(0, 512) : "",
    status: threadCatalogStatus(row.status) ?? { type: "notLoaded" }, ephemeral: false, extra: null, turns: [],
  } as unknown as Thread;
}
export function threadCatalogStatus(value: unknown): ThreadStatus | null {
  const row = object(value);
  if (row.type === "active") return { type: "active", activeFlags: Array.isArray(row.activeFlags)
    ? row.activeFlags.filter((flag): flag is "waitingOnApproval" | "waitingOnUserInput" => flag === "waitingOnApproval" || flag === "waitingOnUserInput") : [] };
  return row.type === "idle" || row.type === "notLoaded" || row.type === "systemError" ? { type: row.type } : null;
}
export function parseThreadCatalogChange(value: unknown): ThreadCatalogChange | null {
  const row = object(value), change = object(row.change);
  if (row.version !== 1 || !id(row.source) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) return null;
  let mutation: ThreadCatalogMutation;
  if (change.type === "upsert") { const thread = threadCatalogEntry(change.thread); if (!thread) return null; mutation = { type: "upsert", thread }; }
  else if (change.type === "remove" && id(change.threadId)) mutation = { type: "remove", threadId: change.threadId };
  else if (change.type === "patch" && id(change.threadId)) {
    const status = threadCatalogStatus(change.status);
    if (typeof change.name !== "string" && !status) return null;
    mutation = { type: "patch", threadId: change.threadId, ...(typeof change.name === "string" ? { name: change.name.slice(0, 1024) } : {}), ...(status ? { status } : {}) };
  } else if (change.type === "batch" && Array.isArray(change.changes) && change.changes.length > 0 && change.changes.length <= 256) {
    const changes: ThreadCatalogFact[] = [];
    for (const item of change.changes) {
      if (!["upsert", "patch", "remove"].includes(String(object(item).type))) return null;
      const parsed = parseThreadCatalogChange({ version: 1, source: row.source, revision: row.revision, change: item });
      if (!parsed || parsed.change.type === "invalidate" || parsed.change.type === "batch") return null;
      changes.push(parsed.change);
    }
    mutation = { type: "batch", changes };
  } else if (change.type === "invalidate") mutation = { type: "invalidate" };
  else return null;
  return { version: 1, ...(row.authority === "directory" ? { authority: "directory" as const } : {}), source: row.source, revision: Number(row.revision), change: mutation };
}

/** A terminal page describes only current projection rows, not source completeness. */
export interface ThreadDirectoryCoverage {
  readonly state: "warming" | "ready" | "error" | "syncing";
  readonly coverage?: "unknown" | "partial" | "complete";
  readonly lastSuccessAt?: number | null;
}
export function threadDirectoryIncomplete(value: unknown): boolean {
  const row = object(value), catalog = object(row.catalog ?? object(row.historyCoverage).catalog);
  return catalog.state === "warming" || catalog.state === "error"
    || catalog.coverage === "unknown" || catalog.coverage === "partial";
}
export const THREAD_DIRECTORY_UPDATES = "opencraft/thread-directory-updates";

export const THREAD_DIRECTORY_SNAPSHOTS = "opencraft/thread-directory-snapshots";
export const THREAD_DIRECTORY_SNAPSHOT_START = "opencraft-catalog-snapshot-v1:start";
export const CATALOG_SNAPSHOT_EXPIRED = -32086;
export function isCatalogSnapshotExpired(value: unknown): boolean {
  return object(value).code === CATALOG_SNAPSHOT_EXPIRED || object(value).rpcCode === CATALOG_SNAPSHOT_EXPIRED;
}
export interface ThreadCatalogCheckpoint { readonly source: string; readonly revision: number }
export interface ThreadCatalogSnapshot {
  readonly version: 1;
  readonly id: string;
  readonly checkpoints: readonly ThreadCatalogCheckpoint[];
}
export function parseThreadCatalogSnapshot(value: unknown): ThreadCatalogSnapshot | null {
  const row = object(object(value).catalogSnapshot);
  if (row.version !== 1 || !id(row.id) || !Array.isArray(row.checkpoints) || !row.checkpoints.length || row.checkpoints.length > 32) return null;
  const seen = new Set<string>();
  const checkpoints: ThreadCatalogCheckpoint[] = [];
  for (const item of row.checkpoints) {
    const entry = object(item);
    if (!id(entry.source) || seen.has(entry.source) || !Number.isSafeInteger(entry.revision) || Number(entry.revision) < 0) return null;
    seen.add(entry.source); checkpoints.push({ source: entry.source, revision: Number(entry.revision) });
  }
  return { version: 1, id: row.id, checkpoints };
}

export function threadDirectoryFailed(value: unknown): boolean {
  const row = object(value);
  return object(row.catalog ?? object(row.historyCoverage).catalog).state === "error";
}
