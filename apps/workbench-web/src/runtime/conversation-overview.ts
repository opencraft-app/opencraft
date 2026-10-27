import type { AppServerClient } from "@opencraft/appserver-client";
import type { Thread, ThreadListResponse } from "@opencraft/appserver-protocol/generated/v2";
import type { ThreadParticipationContribution } from "@opencraft/extension-react";
import type { ConversationOverviewPort, ConversationOverviewSnapshot, OverviewConversation, OverviewState } from "@opencraft/plugin-tasks/conversation-overview";

type LatestTurn = { status: string; completedAt: number | null };
export function overviewState(thread: Thread, latest: LatestTurn | null | undefined): OverviewState {
  if (!thread.status || typeof thread.status !== "object") return "unknown";
  if (thread.status.type === "active") return thread.status.activeFlags.some(flag => flag === "waitingOnApproval" || flag === "waitingOnUserInput") ? "waiting" : "running";
  if (thread.status.type === "systemError") return "failed";
  if ((thread.status.type !== "idle" && thread.status.type !== "notLoaded") || latest === undefined) return "unknown";
  if (latest === null) return "empty";
  if (latest.status === "completed") return "completed";
  if (latest.status === "failed") return "failed";
  if (latest.status === "interrupted") return "interrupted";
  return "unknown";
}
async function pool<T>(items: readonly T[], signal: AbortSignal, consume: (item: T) => Promise<void>) {
  let next = 0;
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) { signal.throwIfAborted(); await consume(items[next++]!); }
  }));
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
}
/** No retained cross-account cache. All reads are cancellable and connection-fenced. */
export function createConversationOverviewPort(options: {
  getClient(hostId: string): AppServerClient | null;
  participation(): ThreadParticipationContribution | null;
}): ConversationOverviewPort {
  return { async read(sources, signal, progress) {
    const result: ConversationOverviewSnapshot = { asOf: Date.now(), conversations: [], sources: [] };
    const rows: OverviewConversation[] = [], coverage: ConversationOverviewSnapshot["sources"][number][] = [];
    let count = 0;
    // Serialize sources so all expensive latest-turn reads share a four-request bound.
    for (const source of new Map(sources.map(value => [value.id, value])).values()) {
      signal.throwIfAborted();
      const status = { ...source, catalog: "complete" as "complete" | "partial" | "error", pins: false, people: false, unknownTurns: 0 };
      coverage.push(status);
      const client = options.getClient(source.id), generation = client?.connectionGeneration;
      if (!client || !client.initializeResult) { status.catalog = "error"; continue; }
      const check = () => { signal.throwIfAborted(); if (options.getClient(source.id) !== client || client.connectionGeneration !== generation) throw new Error("Conversation source changed"); };
      const request: AppServerClient["request"] = async (method, params, requestOptions) => {
        check();
        const response = await client.request(method, params, { ...requestOptions, signal, priority: "background", timeoutMs: 15000 });
        check(); return response;
      };
      const catalog = new Map<string, { thread: Thread; archived: boolean }>();
      for (const archived of [false, true]) {
        let cursor: string | null = null;
        const cursors = new Set<string>();
        try {
          do {
            const page: ThreadListResponse = await request("thread/list", { archived, cursor, limit: 100, sortKey: "created_at", sortDirection: "asc" });
            for (const thread of page.data) if (!thread.ephemeral) catalog.set(thread.id, { thread, archived });
            cursor = page.nextCursor;
            if (cursor && cursors.has(cursor)) throw new Error("Repeated directory cursor");
            if (cursor) cursors.add(cursor);
            progress(count + catalog.size);
          } while (cursor);
        } catch { signal.throwIfAborted(); status.catalog = catalog.size ? "partial" : "error"; }
      }
      if (status.catalog !== "complete" && catalog.size) status.catalog = "partial";
      const pinned = new Set<string>();
      try {
        const pins = await request("opencraft/thread-pins/list", {});
        status.pins = pins.supported;
        for (const thread of pins.data) {
          pinned.add(thread.id);
          if (!catalog.has(thread.id)) catalog.set(thread.id, { thread, archived: false });
        }
      } catch { signal.throwIfAborted(); }
      const sourceRows: OverviewConversation[] = [];
      try {
        await pool([...catalog.values()], signal, async ({ thread, archived }) => {
          let latest: LatestTurn | null | undefined;
          try {
            const entry = (await request("thread/turns/list", { threadId: thread.id, cursor: null, limit: 1, sortDirection: "desc", itemsView: "notLoaded" })).data[0];
            if (!entry) latest = null;
            else if (typeof entry.status === "string") latest = { status: entry.status, completedAt: typeof entry.completedAt === "number" && Number.isFinite(entry.completedAt) ? entry.completedAt : null };
            else throw new Error("Missing latest-turn status");
          }
          catch { signal.throwIfAborted(); status.unknownTurns++; }
          sourceRows.push({ hostId: source.id, id: thread.id, title: thread.name?.trim() || thread.preview?.trim() || thread.id,
            project: thread.cwd, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
            archived, pinned: status.pins ? pinned.has(thread.id) : null, state: overviewState(thread, latest),
            completedAt: latest?.status === "completed" ? latest.completedAt : null, participants: null, creator: null });
          progress(++count);
        });
        const participation = options.participation();
        if (participation) for (let offset = 0; offset < sourceRows.length; offset += 100) {
          try {
            check(); const batch = sourceRows.slice(offset, offset + 100);
            const people = await participation.read(source.id, batch.map(row => row.id), signal); check();
            if (participation !== options.participation()) throw new Error("Participation provider changed");
            const indexed = new Map(people.map(row => [row.threadId, row]));
            for (const row of batch) { const entry = indexed.get(row.id); if (entry && !entry.pending) { row.participants = [...new Set(entry.participants)]; row.creator = entry.creator; } }
          } catch { signal.throwIfAborted(); }
        }
        status.people = sourceRows.length > 0 && sourceRows.every(row => row.participants !== null);
        check(); rows.push(...sourceRows);
      } catch { signal.throwIfAborted(); status.catalog = "error"; }
    }
    return { ...result, asOf: Date.now(), conversations: rows, sources: coverage };
  } };
}
