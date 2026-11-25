import type { ThreadListParams } from "@opencraft/appserver-protocol";
import type { StateDocumentStore } from "@opencraft/document-storage/state";
import { sealedText } from "@opencraft/secret-storage/sealed";
import { recordSealer, type RecordSealer } from "@opencraft/secret-storage/sealed-records";

export const CODEX_THREAD_LIST_PATH = "/__opencraft_internal/codex-thread-list";
const MAX_PAGE_SIZE = 100;
const MAX_NATIVE_CURSOR = 2048;
const utf8 = new TextEncoder();

export function parseCodexThreadList(value: unknown) {
  if (value === undefined) value = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { cursor, limit, archived, sortKey, sortDirection, searchTerm, useStateDbOnly } =
    value as Partial<ThreadListParams>;
  if (
    Object.keys(value).some(
      (key) =>
        !["cursor", "limit", "archived", "sortKey", "sortDirection", "searchTerm", "useStateDbOnly"].includes(key),
    ) ||
    (cursor != null &&
      (typeof cursor !== "string" || !cursor || cursor.length > 4096 || /[\x00-\x1f\x7f]/u.test(cursor))) ||
    (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)) ||
    (archived != null && typeof archived !== "boolean") ||
    (sortKey != null && !["created_at", "updated_at", "recency_at", "section_position"].includes(sortKey)) ||
    (sortDirection != null && sortDirection !== "asc" && sortDirection !== "desc") ||
    (searchTerm != null && (typeof searchTerm !== "string" || searchTerm.length > 256)) ||
    (useStateDbOnly != null && typeof useStateDbOnly !== "boolean")
  )
    return null;
  const sort = sortKey ?? "created_at";
  return {
    cursor: cursor ?? null,
    limit: limit ?? 30,
    archived: archived ?? false,
    sortKey: sort,
    sortDirection: sortDirection ?? (sort === "section_position" ? "asc" : "desc"),
    searchTerm: searchTerm || null,
    useStateDbOnly: useStateDbOnly ?? false,
  } satisfies ThreadListParams;
}

export function parseCodexThreadPage(value: unknown, sealed = false) {
  const page = value as { data?: unknown; nextCursor?: unknown; backwardsCursor?: unknown } | null;
  if (
    !Array.isArray(page?.data) ||
    page.data.length > MAX_PAGE_SIZE ||
    !validCursor(page.nextCursor, sealed) ||
    !validCursor(page.backwardsCursor, sealed)
  )
    return null;
  return { data: page.data as unknown[], nextCursor: page.nextCursor, backwardsCursor: page.backwardsCursor };
}

function validCursor(value: unknown, sealed = false): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !value) return false;
  return utf8.encode(value).byteLength <= (sealed ? 4096 : MAX_NATIVE_CURSOR);
}

export async function codexThreadCursorSealer(documents: StateDocumentStore): Promise<RecordSealer> {
  const key = await documents.update("cursor-key", (current) => {
    if (typeof current === "string") return { result: current };
    if (current !== null) throw new Error("Invalid Codex directory key");
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const configured = "directory." + sealedText.encode(raw);
    raw.fill(0);
    return { result: configured, next: configured };
  });
  return recordSealer(key);
}

// Native cursors can identify a row filtered out by the current viewer's ACL.
// Keep the native position opaque and bind it to this login and query.
export function openCodexThreadCursor(cursor: string, sealer: RecordSealer, scope: string): string | null {
  try {
    const decoded = sealer.unseal(scope, cursor);
    return validCursor(decoded) ? decoded : null;
  } catch {
    return null;
  }
}
