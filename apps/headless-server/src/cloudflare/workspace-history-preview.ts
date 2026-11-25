import type { StateDocumentStore } from "@opencraft/document-storage/state";
import type { WorkspacePlacementRecord } from "@opencraft/sandbox";
import {
  CODEX_HISTORY_PREVIEW_PAGE_LIMIT as PAGE_LIMIT,
  initialCodexTurnsRead,
  isCodexHistoryResult,
  type CodexHistoryRead,
} from "./codex-thread-read.js";
import { directoryCheckpoint, matchesDirectoryCheckpoint } from "./workspace-directory-checkpoint.js";
import { sameThreadPlacement, type ThreadPlacementReceipt } from "./thread-placement.js";

export const WORKSPACE_HISTORY_PREVIEW_THREADS = 4;
const MAX_BYTES = 96 * 1024;
const DOCUMENT = "codex-history-preview";
type Page = { data: unknown[]; nextCursor: string | null; backwardsCursor: string | null };
type Preview = {
  placement: ThreadPlacementReceipt;
  metadata: { thread: Record<string, unknown> };
  page: Page;
};

export async function captureWorkspaceHistory(
  placement: ThreadPlacementReceipt,
  read: (read: CodexHistoryRead) => Promise<unknown>,
): Promise<Preview | null> {
  const threadId = placement.threadId;
  const metadataRead = { method: "thread/read", params: { threadId, includeTurns: false } } as const;
  const pageRead = {
    method: "thread/turns/list",
    params: {
      threadId,
      cursor: null,
      limit: PAGE_LIMIT,
      sortDirection: "desc",
      itemsView: "full",
    },
  } as const;
  const [metadata, page] = await Promise.all([read(metadataRead), read(pageRead)]);
  if (!isCodexHistoryResult(metadataRead, metadata) || !isCodexHistoryResult(pageRead, page)) return null;
  const thread = (metadata as Preview["metadata"]).thread;
  if (
    typeof thread.status !== "object" ||
    thread.status === null ||
    !["idle", "notLoaded"].includes(String((thread.status as { type?: unknown }).type))
  )
    return null;
  return { placement, metadata: { thread }, page: page as Page };
}

export async function recordWorkspaceHistory(
  documents: StateDocumentStore,
  placement: WorkspacePlacementRecord,
  previews: readonly Preview[],
) {
  const checkpoint = directoryCheckpoint(placement);
  if (!checkpoint) return;
  const encoder = new TextEncoder();
  const entries: Preview[] = [];
  for (const preview of previews) {
    const candidate = { ...checkpoint, entries: [...entries, preview] };
    if (encoder.encode(JSON.stringify(candidate)).byteLength <= MAX_BYTES) entries.push(preview);
  }
  await documents.update(DOCUMENT, () => ({ result: undefined, next: { ...checkpoint, entries } }));
}

export async function readWorkspaceHistory(
  documents: StateDocumentStore,
  sandbox: WorkspacePlacementRecord | undefined,
  thread: ThreadPlacementReceipt,
  read: CodexHistoryRead,
): Promise<unknown | null> {
  const value = (await documents.read(DOCUMENT)) as { entries?: Preview[] } | null;
  if (!matchesDirectoryCheckpoint(value, sandbox) || !Array.isArray(value?.entries)) return null;
  const preview = value.entries.find((entry) => entry?.placement && sameThreadPlacement(entry.placement, thread));
  if (
    !preview ||
    !isCodexHistoryResult(
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
    )
  )
    return null;
  if (read.method === "thread/read") {
    if (!read.params.includeTurns) {
      const pageRead = initialCodexTurnsRead(read.params);
      const result =
        pageRead && isCodexHistoryResult(pageRead, preview.page)
          ? { ...preview.metadata, initialTurnsPage: preview.page }
          : preview.metadata;
      return isCodexHistoryResult(read, result) ? result : null;
    }
    if (preview.page?.nextCursor !== null) return null;
    const result = { thread: { ...preview.metadata.thread, turns: [...preview.page.data].reverse() } };
    return isCodexHistoryResult(read, result) ? result : null;
  }
  if (
    read.method !== "thread/turns/list" ||
    read.params.cursor !== null ||
    read.params.sortDirection !== "desc" ||
    read.params.itemsView !== "full" ||
    read.params.limit > PAGE_LIMIT ||
    read.params.limit < preview.page.data.length
  )
    return null;
  return isCodexHistoryResult(read, preview.page) ? preview.page : null;
}
