import type { DshHistoryEntry } from "./dsh-client.js";

export interface NativeWindow { events: DshHistoryEntry[]; hasMore: boolean; projections?: any }
export function historyCursor(threadId: string, beforeSeq?: number): string {
  return encodeURIComponent(JSON.stringify({ version: 2, kind: "dsh-turns", threadId, beforeSeq: beforeSeq ?? null }));
}
export function historyBoundary(threadId: string, cursor: unknown): number | undefined {
  if (cursor == null) return undefined;
  let value: any;
  try { value = JSON.parse(decodeURIComponent(String(cursor))); } catch { throw new Error("Invalid DSH history cursor"); }
  if (value.version !== 2 || value.kind !== "dsh-turns" || value.threadId !== threadId ||
      (value.beforeSeq !== null && (!Number.isSafeInteger(value.beforeSeq) || value.beforeSeq < 0))) throw new Error("Invalid DSH history cursor");
  return value.beforeSeq ?? undefined;
}

/** Read until the requested complete Turn starts are covered, never drain older history. */
export async function readTurnWindow(
  fetchPage: (before?: number) => Promise<NativeWindow>, before: number | undefined, limit: number,
): Promise<NativeWindow & { nextBefore?: number }> {
  const chunks: DshHistoryEntry[][] = [];
  let projections: any;
  let starts = 0;
  for (;;) {
    const page = await fetchPage(before);
    if (chunks.length === 0) projections = page.projections;
    const rows = page.events;
    const first = rows[0]?.event.seq;
    if (rows.some((entry, i) => !Number.isSafeInteger(entry.event.seq) ||
      (i > 0 && entry.event.seq <= rows[i - 1]!.event.seq) || (before !== undefined && entry.event.seq >= before)))
      throw new Error("Native history order made no progress");
    if (page.hasMore && (first === undefined || (before !== undefined && first >= before))) throw new Error("Native history cursor made no progress");
    chunks.unshift(rows);
    starts += rows.filter(entry => entry.event.type === "turn/start").length;
    if (starts >= limit || !page.hasMore) {
      const all = chunks.flat();
      const indices = all.flatMap((entry, i) => entry.event.type === "turn/start" ? [i] : []);
      const begin = indices[Math.max(0, indices.length - limit)] ?? 0;
      const events = all.slice(begin);
      const hasMore = indices.length > limit || page.hasMore;
      return { events, hasMore, projections, ...(hasMore && events[0] ? { nextBefore: events[0].event.seq } : {}) };
    }
    before = first;
  }
}
