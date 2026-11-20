import { replaceEqualDeep, type InfiniteData, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { ThreadListResponse } from "@opencraft/appserver-protocol/generated/v2";
import type { ThreadCatalogChange, ThreadCatalogFact } from "@opencraft/appserver-protocol";

import { mergeThreadCatalogPages } from "./thread-catalog-query";
import { withTurnRecency } from "./thread-catalog-recency";

type Fact = { readonly sequence: number; readonly change: ThreadCatalogFact };
const journals = new WeakMap<QueryClient, Map<string, ThreadCatalogUpdates>>();
const boundary = "__opencraftCatalogReadEvidence";
class ReadToken {}
type ReadEvidence = { readonly startedAt: number; readonly rows: readonly ThreadListResponse["data"][number][] };
const sameStatus = (a: ThreadListResponse["data"][number]["status"], b: typeof a) =>
  a.type === b.type && (a.type !== "active" || (b.type === "active"
    && [...a.activeFlags].sort().join(":") === [...b.activeFlags].sort().join(":")));

/** Unacknowledged Server facts over a paged snapshot, scoped by the complete query key. */
export class ThreadCatalogUpdates {
  private sequence = 0;
  // Only native reads carry acknowledgement evidence. Cache materialization and
  // select/project results cannot certify their own event overlays.
  private readonly reads = new WeakMap<ReadToken, ReadEvidence>();
  private readonly projections = new WeakSet<ThreadListResponse>();
  private readonly materialized = new WeakMap<object, number>();
  private readonly sources = new Map<string, number>();
  private readonly facts = new Map<string, Fact>();
  // Minimum activity clocks from native Turn events, not a second directory.
  // A metadata index may lag a live Turn even on reads begun after the event.
  private readonly activity = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private projected: { base: ThreadListResponse | undefined; sequence: number; value: ThreadListResponse | undefined } | undefined;
  enabled = false;
  constructor(readonly hostId: string) {}
  getSnapshot = () => this.sequence;
  get hasPending(): boolean { return this.facts.size > 0; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  receive(event: ThreadCatalogChange): void {
    if (!this.enabled || event.revision <= (this.sources.get(event.source) ?? 0)) return;
    this.sources.set(event.source, event.revision);
    // A reconnect gets its own publisher incarnation; source IDs are not durable cursors.
    if (this.sources.size > 32) this.sources.delete(this.sources.keys().next().value!);
    const change = event.change;
    if (change.type === "invalidate") return;
    // A batch carries one publisher revision; apply its facts in order, notify once.
    for (const fact of change.type === "batch" ? change.changes : [change]) this.receiveFact(fact);
    for (const listener of this.listeners) listener();
  }
  private receiveFact(change: ThreadCatalogFact): void {
    const id = change.type === "upsert" ? change.thread.id : change.threadId;
    if (change.type === "remove") this.activity.delete(id);
    const previous = this.facts.get(id)?.change;
    let merged = change;
    if (change.type === "patch") {
      if (previous?.type === "remove") return;
      if (previous?.type === "upsert") merged = { type: "upsert", thread: { ...previous.thread,
        ...(change.name === undefined ? {} : { name: change.name }), ...(change.status === undefined ? {} : { status: change.status }) } };
      else if (previous?.type === "patch") merged = { ...previous, ...change };
    }
    this.facts.set(id, { sequence: ++this.sequence, change: merged });
  }
  observeTurnStart(threadId: string, startedAt: number): void {
    if (!this.enabled || !threadId || threadId.length > 4096 || !Number.isFinite(startedAt) || startedAt < 0 || startedAt <= (this.activity.get(threadId) ?? -1)
      || this.facts.get(threadId)?.change.type === "remove") return;
    this.activity.set(threadId, startedAt);
    ++this.sequence;
    for (const listener of this.listeners) listener();
  }
  /** Only an actual native first page can confirm a clock. Tail duplicates and
   * materialized client projections must not acknowledge their own overlay. */
  reconcileRecency(page: ThreadListResponse, firstPage: boolean): ThreadListResponse {
    for (const row of page.data) {
      const minimum = this.activity.get(row.id);
      if (firstPage && minimum !== undefined && (row.recencyAt ?? row.updatedAt) >= minimum) this.activity.delete(row.id);
    }
    return { ...page, data: page.data.map(row => {
      const minimum = this.activity.get(row.id);
      return minimum === undefined ? row : withTurnRecency(row, minimum);
    }) };
  }
  project(base: ThreadListResponse | undefined): ThreadListResponse | undefined {
    if (!this.facts.size && !this.activity.size) return base;
    if (this.projected && this.projected.base === base && this.projected.sequence === this.sequence) return this.projected.value;
    const rows = new Map(mergeThreadCatalogPages([{ data: base?.data ?? [] }]).map(row => [row.id, row]));
    for (const [id, { change }] of this.facts) {
      if (change.type === "upsert") rows.set(id, { ...rows.get(id), ...change.thread });
      else if (change.type === "remove") rows.delete(id);
      else {
        const old = rows.get(id);
        if (old) rows.set(id, { ...old, ...(change.name === undefined ? {} : { name: change.name }),
          ...(change.status === undefined ? {} : { status: change.status }) });
      }
    }
    for (const [id, minimum] of this.activity) {
      const row = rows.get(id);
      if (row) rows.set(id, withTurnRecency(row, minimum));
    }
    if (!base && !rows.size) return undefined;
    const value = { ...base, data: [...rows.values()].sort((a, b) => (b.recencyAt ?? b.updatedAt) - (a.recencyAt ?? a.updatedAt) || a.id.localeCompare(b.id)),
      nextCursor: base?.nextCursor ?? null } as ThreadListResponse;
    this.projections.add(value);
    this.projected = { base, sequence: this.sequence, value };
    return value;
  }
  /** A healed logical connection starts a new observation window. Old events
   * cannot order mutations missed while disconnected; the next admitted native
   * read owns catch-up. Existing cached display is materialized before retiring. */
  retireConnection(): void {
    this.facts.clear(); this.sources.clear(); this.projected = undefined;
    ++this.sequence;
    for (const listener of this.listeners) listener();
  }
  markRead(page: ThreadListResponse, startedAt: number): ThreadListResponse {
    const token = new ReadToken();
    const value = { ...page, [boundary]: token };
    // Non-plain token identity survives Query's structural sharing; evidence is
    // private and captured BEFORE any client projection or cache write.
    if (!this.projections.has(page)) this.reads.set(token, { startedAt, rows: structuredClone(page.data) });
    return value;
  }
  materialize(data: InfiniteData<ThreadListResponse, string | null> | undefined): typeof data {
    if (!data?.pages.length || !this.facts.size || this.materialized.get(data) === this.sequence) return data;
    const base = { ...data.pages[0]!, data: mergeThreadCatalogPages(data.pages) };
    const projected = this.project(base)!;
    const rows = new Map(projected.data.map(row => [row.id, row]));
    const existing = new Set(base.data.map(row => row.id));
    const added = projected.data.filter(row => !existing.has(row.id));
    const value = { ...data, pages: data.pages.map((page, index) => {
      const value = { ...page, data: [...(index === 0 ? added : []),
        ...page.data.flatMap(row => rows.has(row.id) ? [rows.get(row.id)!] : [])] };
      this.projections.add(value);
      return value;
    }) };
    const stable = replaceEqualDeep(data, value);
    this.materialized.set(stable, this.sequence);
    return stable;
  }
  acknowledge(data: ThreadListResponse | InfiniteData<ThreadListResponse, string | null> | undefined): void {
    if (!data) return;
    const pages = "pages" in data ? data.pages : [data];
    const witnesses = pages.map(page => {
      const token = (page as ThreadListResponse & { [boundary]?: ReadToken })[boundary];
      return token ? this.reads.get(token) : undefined;
    });
    const nativeRows = new Map<string, { row: ThreadListResponse["data"][number]; startedAt: number }>();
    for (const read of witnesses) if (read) for (const row of read.rows) {
      if (!nativeRows.has(row.id)) nativeRows.set(row.id, { row, startedAt: read.startedAt });
    }
    // A partial/warming aggregate or one page's absence is never a tombstone.
    const complete = pages.length > 0 && pages.at(-1)!.nextCursor == null
      && (!("pages" in data) || data.pageParams[0] === null)
      && pages.every((page, index) => {
        const metadata = (page as ThreadListResponse & { catalog?: { state: string; coverage: string } }).catalog;
        return witnesses[index] !== undefined && (!metadata || (metadata.coverage === "complete" && metadata.state !== "warming" && metadata.state !== "error"));
      });
    let changed = false;
    for (const [id, fact] of this.facts) {
      const eligible = witnesses.filter((read): read is ReadEvidence => read !== undefined && read.startedAt >= fact.sequence);
      const change = fact.change;
      const confirmed = change.type === "remove"
        ? complete && eligible.length === pages.length && eligible.every(read => read.rows.every(row => row.id !== id))
        : (() => {
          const witness = nativeRows.get(id);
          if (!witness || witness.startedAt < fact.sequence) return false;
          const { row } = witness;
          if (change.type === "patch") return (change.name === undefined || row.name === change.name)
            && (change.status === undefined || sameStatus(row.status, change.status));
          return row.name === change.thread.name && sameStatus(row.status, change.thread.status)
            && row.updatedAt >= change.thread.updatedAt;
        })();
      if (confirmed) { this.facts.delete(id); changed = true; }
    }
    if (changed) { ++this.sequence; for (const listener of this.listeners) listener(); }
  }
}

export function threadCatalogUpdates(client: QueryClient, key: QueryKey, hostId: string): ThreadCatalogUpdates {
  let map = journals.get(client);
  if (!map) { map = new Map(); journals.set(client, map); }
  const identity = JSON.stringify(key);
  let value = map.get(identity);
  if (!value) { value = new ThreadCatalogUpdates(hostId); map.set(identity, value); }
  return value;
}
export function receiveThreadCatalogChange(client: QueryClient, hostId: string, event: ThreadCatalogChange): void {
  for (const journal of journals.get(client)?.values() ?? []) if (journal.hostId === hostId) journal.receive(event);
}

/** Activity belongs to each admitted catalog scope, including cold reads.
 * Clocks never create directory entries; project waits for a native row. */
export function receiveThreadCatalogTurnStart(client: QueryClient, hostId: string, threadId: string, startedAt: number): void {
  for (const journal of journals.get(client)?.values() ?? []) if (journal.hostId === hostId) journal.observeTurnStart(threadId, startedAt);
}

/** Called by the existing Host connection recovery owner, not by a View mount. */
export function retireThreadCatalogConnection(client: QueryClient, hostId: string): void {
  for (const [identity, journal] of journals.get(client) ?? []) {
    if (journal.hostId !== hostId) continue;
    const key: QueryKey = JSON.parse(identity);
    const raw = client.getQueryData<InfiniteData<ThreadListResponse, string | null>>(key);
    const materialized = journal.materialize(raw);
    if (journal.enabled && materialized !== raw) client.setQueryData(key, materialized);
    // The hook may still be disabled from the reconnecting phase when this
    // owner's ready callback runs. Retire observations even before React paints.
    journal.retireConnection();
  }
}
