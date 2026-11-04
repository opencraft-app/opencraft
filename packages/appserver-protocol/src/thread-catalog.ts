import type { Thread, ThreadStatus } from "./generated/v2";

export const THREAD_CATALOG_CHANGED = "opencraft/thread-catalog/changed";
export type ThreadCatalogMutation =
  | { readonly type: "upsert"; readonly thread: Thread }
  | { readonly type: "remove"; readonly threadId: string }
  | { readonly type: "patch"; readonly threadId: string; readonly name?: string; readonly status?: ThreadStatus }
  | { readonly type: "invalidate" };
export interface ThreadCatalogChange {
  readonly version: 1;
  readonly source: string;
  readonly revision: number;
  readonly change: ThreadCatalogMutation;
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
  } else if (change.type === "invalidate") mutation = { type: "invalidate" };
  else return null;
  return { version: 1, source: row.source, revision: Number(row.revision), change: mutation };
}
