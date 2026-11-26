import type { StateDocumentStore } from "@opencraft/document-storage/state";
import type { WorkspacePlacementRecord } from "@opencraft/sandbox";
import {
  CODEX_HISTORY_PREVIEW_PAGE_LIMIT as PAGE_LIMIT,
  initialCodexTurnsRead,
  isCodexHistoryResult,
  isCodexHistorySizeError,
  type CodexHistoryRead,
} from "./codex-thread-read.js";
import {
  directoryCheckpoint,
  matchesDirectoryCheckpoint,
  type WorkspaceDirectoryCheckpoint,
} from "./workspace-directory-checkpoint.js";
import { sameThreadPlacement, type ThreadPlacementReceipt } from "./thread-placement.js";

export const WORKSPACE_HISTORY_PREVIEW_THREADS = 4;
const MAX_BYTES = 96 * 1024;
const encoder = new TextEncoder();
const DOCUMENT = "codex-history-preview";
const CURSOR_PREFIX = "oc-history/";
type Page = { data: unknown[]; nextCursor: string | null; backwardsCursor: string | null };
type TurnsRead = Extract<CodexHistoryRead, { method: "thread/turns/list" }>;
type Preview = {
  placement: ThreadPlacementReceipt;
  metadata: { thread: Record<string, unknown> };
  page?: Page;
};

export function isWorkspaceHistoryPreviewCursor(read: CodexHistoryRead): boolean {
  return read.method !== "thread/read" && read.params.cursor?.startsWith(CURSOR_PREFIX) === true;
}

async function previewPage(
  checkpoint: WorkspaceDirectoryCheckpoint,
  thread: ThreadPlacementReceipt,
  page: Page,
  read: TurnsRead,
): Promise<Page | null> {
  const { cursor, limit, sortDirection, itemsView } = read.params;
  if (sortDirection !== "desc" || itemsView !== "full" || (cursor === null && limit > PAGE_LIMIT)) return null;
  if (cursor === null && page.data.length <= limit) return page;
  if (cursor !== null && !isWorkspaceHistoryPreviewCursor(read)) return null;
  const { serverId, threadId, workspaceId, revision } = thread;
  const scope = encoder.encode(JSON.stringify([
    checkpoint.snapshot, checkpoint.receipt.backend, checkpoint.receipt.instanceId,
    serverId, threadId, workspaceId, revision,
  ]));
  const digest = await crypto.subtle.digest("SHA-256", scope);
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const prefix = CURSOR_PREFIX + fingerprint + "/";
  const index = cursor?.startsWith(prefix) ? cursor.slice(prefix.length) : "";
  if (cursor !== null && !/^[1-9][0-9]*$/u.test(index)) return null;
  const offset = cursor === null ? 0 : Number(index);
  if (cursor !== null && offset >= page.data.length) return null;
  const end = offset + limit;
  return {
    data: page.data.slice(offset, end),
    nextCursor: end < page.data.length ? prefix + end : page.nextCursor,
    backwardsCursor: offset === 0 ? page.backwardsCursor : null,
  };
}

function fitsPreviewBudget(value: object): boolean {
  const serialized = JSON.stringify(value);
  return serialized.length <= MAX_BYTES && encoder.encode(serialized).byteLength <= MAX_BYTES;
}

export async function captureWorkspaceHistory(
  placement: ThreadPlacementReceipt,
  read: (read: CodexHistoryRead) => Promise<unknown>,
): Promise<Preview | null> {
  const threadId = placement.threadId;
  const metadataRead = { method: "thread/read", params: { threadId, includeTurns: false } } as const;
  const metadata = await read(metadataRead);
  if (!isCodexHistoryResult(metadataRead, metadata)) return null;
  const thread = (metadata as Preview["metadata"]).thread;
  if (
    typeof thread.status !== "object" ||
    thread.status === null ||
    !["idle", "notLoaded"].includes(String((thread.status as { type?: unknown }).type))
  )
    return null;

  const preview = { placement, metadata: { thread: { ...thread, turns: [] } } };
  for (let limit = PAGE_LIMIT; ; limit = Math.floor(limit / 2)) {
    const pageRead = {
      method: "thread/turns/list",
      params: { threadId, cursor: null, limit, sortDirection: "desc", itemsView: "full" },
    } as const;
    try {
      const page = await read(pageRead);
      if (!isCodexHistoryResult(pageRead, page)) break;
      const candidate = { ...preview, page: page as Page };
      if (fitsPreviewBudget(candidate)) return candidate;
      if (candidate.page.data.length <= 1) break;
    } catch (error) {
      if (!isCodexHistorySizeError(error)) break;
    }
    if (limit === 1) break;
  }
  return preview;
}

export async function recordWorkspaceHistory(
  documents: StateDocumentStore,
  placement: WorkspacePlacementRecord,
  previews: readonly Preview[],
) {
  const checkpoint = directoryCheckpoint(placement);
  if (!checkpoint) return;
  const entries: Preview[] = [];
  const pages = new Map<number, Page>();
  // Reserve metadata first so a large page cannot crowd out other Threads.
  for (const { placement, metadata, page } of previews) {
    const preview = { placement, metadata };
    if (!fitsPreviewBudget({ ...checkpoint, entries: [...entries, preview] })) continue;
    if (page) pages.set(entries.length, page);
    entries.push(preview);
  }
  for (const [index, page] of pages) {
    const metadataOnly = entries[index]!;
    entries[index] = { ...metadataOnly, page };
    if (!fitsPreviewBudget({ ...checkpoint, entries })) entries[index] = metadataOnly;
  }
  await documents.update(DOCUMENT, () => ({ result: undefined, next: { ...checkpoint, entries } }));
}

export async function readWorkspaceHistory(
  documents: StateDocumentStore,
  sandbox: WorkspacePlacementRecord | undefined,
  thread: ThreadPlacementReceipt,
  read: CodexHistoryRead,
): Promise<unknown | null> {
  const value = (await documents.read(DOCUMENT)) as (WorkspaceDirectoryCheckpoint & { entries: Preview[] }) | null;
  if (!value?.receipt || !Array.isArray(value.entries)) return null;
  const current = directoryCheckpoint(sandbox);
  // A verified restore can finish an already issued checkpoint page.
  const restored = isWorkspaceHistoryPreviewCursor(read) && current && current.snapshot === value.snapshot &&
    sandbox?.restoredFrom === value.snapshot && current.receipt.backend === value.receipt.backend;
  if (!restored && !matchesDirectoryCheckpoint(value, sandbox)) return null;
  const preview = value.entries.find((entry) => entry?.placement && sameThreadPlacement(entry.placement, thread));
  if (!preview) return null;
  const page = isCodexHistoryResult(
    {
      method: "thread/turns/list",
      params: {
        threadId: thread.threadId,
        cursor: null,
        limit: PAGE_LIMIT,
        sortDirection: "desc",
        itemsView: "full",
      },
    },
    preview.page,
  ) ? preview.page : undefined;
  if (read.method === "thread/read") {
    if (!read.params.includeTurns) {
      const pageRead = initialCodexTurnsRead(read.params);
      const initialPage = page && pageRead && await previewPage(value, thread, page, pageRead);
      const result = initialPage
        ? { ...preview.metadata, initialTurnsPage: initialPage }
        : preview.metadata;
      return isCodexHistoryResult(read, result) ? result : null;
    }
    if (page?.nextCursor !== null) return null;
    const result = { thread: { ...preview.metadata.thread, turns: [...page.data].reverse() } };
    return isCodexHistoryResult(read, result) ? result : null;
  }
  if (!page || read.method !== "thread/turns/list") return null;
  const result = await previewPage(value, thread, page, read);
  return isCodexHistoryResult(read, result) ? result : null;
}
