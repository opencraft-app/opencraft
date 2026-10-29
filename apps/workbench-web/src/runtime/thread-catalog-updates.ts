import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import type { ThreadListResponse } from "@opencraft/appserver-protocol/generated/v2";
import type { ThreadCatalogChange, ThreadCatalogMutation } from "@opencraft/appserver-protocol";

type Fact = { readonly sequence: number; readonly change: Exclude<ThreadCatalogMutation, { type: "invalidate" }> };
const journals = new WeakMap<QueryClient, Map<string, ThreadCatalogUpdates>>();
const boundary = "__opencraftCatalogReadBoundary";

/** Unacknowledged Server facts over a paged snapshot, scoped by the complete query key. */
export class ThreadCatalogUpdates {
  private sequence = 0;
  private readonly sources = new Map<string, number>();
  private readonly facts = new Map<string, Fact>();
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
    const id = change.type === "upsert" ? change.thread.id : change.threadId;
    const previous = this.facts.get(id)?.change;
    let merged = change;
    if (change.type === "patch") {
      if (previous?.type === "remove") return;
      if (previous?.type === "upsert") merged = { type: "upsert", thread: { ...previous.thread,
        ...(change.name === undefined ? {} : { name: change.name }), ...(change.status === undefined ? {} : { status: change.status }) } };
      else if (previous?.type === "patch") merged = { ...previous, ...change };
    }
    this.facts.set(id, { sequence: ++this.sequence, change: merged });
    for (const listener of this.listeners) listener();
  }
  project(base: ThreadListResponse | undefined): ThreadListResponse | undefined {
    if (!this.facts.size) return base;
    if (this.projected && this.projected.base === base && this.projected.sequence === this.sequence) return this.projected.value;
    const rows = new Map((base?.data ?? []).map(row => [row.id, row]));
    for (const [id, { change }] of this.facts) {
      if (change.type === "upsert") rows.set(id, { ...rows.get(id), ...change.thread });
      else if (change.type === "remove") rows.delete(id);
      else {
        const old = rows.get(id);
        if (old) rows.set(id, { ...old, ...(change.name === undefined ? {} : { name: change.name }),
          ...(change.status === undefined ? {} : { status: change.status }) });
      }
    }
    if (!base && !rows.size) return undefined;
    const value = { ...base, data: [...rows.values()].sort((a, b) => (b.recencyAt ?? b.updatedAt) - (a.recencyAt ?? a.updatedAt) || a.id.localeCompare(b.id)),
      nextCursor: base?.nextCursor ?? null } as ThreadListResponse;
    this.projected = { base, sequence: this.sequence, value };
    return value;
  }
  markRead(page: ThreadListResponse, startedAt: number): ThreadListResponse {
    return { ...page, [boundary]: startedAt } as ThreadListResponse;
  }
  materialize(data: InfiniteData<ThreadListResponse, string | null> | undefined): typeof data {
    if (!data?.pages.length || !this.facts.size) return data;
    const base = { ...data.pages[0]!, data: data.pages.flatMap(page => page.data) };
    const projected = this.project(base)!;
    const rows = new Map(projected.data.map(row => [row.id, row]));
    const existing = new Set(base.data.map(row => row.id));
    const added = projected.data.filter(row => !existing.has(row.id));
    return { ...data, pages: data.pages.map((page, index) => ({ ...page,
      data: [...(index === 0 ? added : []), ...page.data.flatMap(row => rows.has(row.id) ? [rows.get(row.id)!] : [])],
    })) };
  }
  acknowledge(data: ThreadListResponse | undefined): void {
    const at = (data as unknown as Record<string, unknown> | undefined)?.[boundary];
    if (typeof at !== "number") return;
    let changed = false;
    for (const [id, fact] of this.facts) if (fact.sequence <= at) { this.facts.delete(id); changed = true; }
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
