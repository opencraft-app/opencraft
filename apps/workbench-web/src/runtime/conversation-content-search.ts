import type { AppServerProtocolResourcePort } from "@opencraft/workbench-runtime";
import type { Thread } from "@opencraft/appserver-protocol/generated/v2";
/** Ephemeral, Server-owned text queries. No transcript mirror or local index. */
export interface ConversationSearchRow {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly connectionHostId: string;
  readonly serverOrigin: { readonly label: string };
  readonly interactionAvailable?: boolean;
  readonly snippet?: string;
  readonly searchTerm?: string;
}

export interface ConversationSearchSource {
  /** Includes recipe, authorization and connection incarnation. */
  readonly key: string;
  readonly hostId: string;
  readonly label: string;
  readonly available: boolean;
  readonly supported?: boolean;
  search(term: string, cursor: string | null, signal: AbortSignal): Promise<{
    readonly matches: readonly ConversationSearchRow[];
    readonly nextCursor: string | null;
  }>;
  locate(term: string, threadId: string, signal: AbortSignal): Promise<{ turnId: string; itemId: string } | null>;
}

export function mergeConversationSearchResults(titles: readonly ConversationSearchRow[], bodies: readonly ConversationSearchRow[]) {
  const rows = new Map(titles.map(row => [JSON.stringify([row.connectionHostId, row.id]), row]));
  for (const row of bodies) rows.set(JSON.stringify([row.connectionHostId, row.id]), row);
  return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function isUnsupportedSearch(error: unknown): boolean {
  const rpc = error as { code?: unknown; message?: string };
  return rpc?.code === -32601 || (rpc?.code === -32603
    && /^Method not supported by OpenCraft DSH host: thread\/search/.test(rpc.message ?? ""));
}

/** Native substring scans can traverse the complete history. Keep their bounded
 * deadline separate from foreground metadata RPCs (normally 30 seconds). */
const CONTENT_SEARCH_TIMEOUT_MS = 120_000;

/** At most one native scan per source. Obsolete queued queries never execute. */
export function serializeContentSearch() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> => {
    const operation = tail.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      const result = await read();
      signal.throwIfAborted();
      return result;
    });
    tail = operation;
    return operation;
  };
}

export function createAppServerContentSearchSource(input: {
  readonly key: string; readonly hostId: string; readonly label: string;
  readonly available: boolean; readonly supported: boolean;
  readonly assertCurrent: () => void;
  readonly protocol: AppServerProtocolResourcePort;
  readonly project: (thread: Thread) => ConversationSearchRow;
}): ConversationSearchSource {
  const serialize = serializeContentSearch();
  return { key: input.key, hostId: input.hostId, label: input.label, available: input.available, supported: input.supported,
    search: (term, cursor, signal) => serialize(signal, async () => {
      input.assertCurrent();
      const result = await input.protocol.request("thread/search", { searchTerm: term, cursor, limit: 30,
        archived: false, sortKey: "updated_at", sortDirection: "desc" }, { timeoutMs: CONTENT_SEARCH_TIMEOUT_MS });
      input.assertCurrent();
      return { matches: result.data.map(match => ({ ...input.project(match.thread), snippet: match.snippet, searchTerm: term })), nextCursor: result.nextCursor };
    }),
    locate: (term, threadId, signal) => serialize(signal, async () => {
      input.assertCurrent();
      const page = await input.protocol.request("thread/searchOccurrences", { threadId, searchTerm: term, limit: 1 }, { timeoutMs: CONTENT_SEARCH_TIMEOUT_MS });
      input.assertCurrent();
      return page.data[0] ?? null;
    }),
  };
}
