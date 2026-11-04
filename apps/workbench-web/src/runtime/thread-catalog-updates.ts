import { threadDirectoryIncomplete, parseThreadCatalogSnapshot } from "@opencraft/appserver-protocol";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { ThreadListResponse } from "@opencraft/appserver-protocol/generated/v2";
import type { ThreadCatalogChange, ThreadCatalogFact } from "@opencraft/appserver-protocol";

type Fact = { readonly sequence: number; readonly source: string; readonly revision: number; readonly change: ThreadCatalogFact };
const journals = new WeakMap<QueryClient, Map<string, ThreadCatalogUpdates>>();
const boundary = "__opencraftCatalogReadBoundary";

/** Unacknowledged Server facts over a paged snapshot, scoped by the complete query key. */
export class ThreadCatalogUpdates {
  private sequence = 0;
  private readonly sources = new Map<string, number>();
  private readonly facts = new Map<string, Fact>();
  private readonly listeners = new Set<() => void>();
  private projected: { base: ThreadListResponse | undefined; sequence: number; value: ThreadListResponse | undefined } | undefined;
  private versioned = false;
  enabled = false;
  constructor(readonly hostId: string) {}
  getSnapshot = () => this.sequence;
  configureVersioned(value: boolean): void { this.versioned = value; }
  get hasPending(): boolean { return this.facts.size > 0; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  receive(event: ThreadCatalogChange): void {
    if (!this.enabled || event.revision <= (this.sources.get(event.source) ?? 0)) return;
    // A certified directory supplies the canonical status/title stream too.
    // Legacy duplicate publishers must not overwrite its newer facts.
    if (this.versioned && event.authority !== "directory" && !event.source.startsWith("access:")) return;
    this.sources.set(event.source, event.revision);
    // A reconnect gets its own publisher incarnation; source IDs are not durable cursors.
    if (this.sources.size > 32) this.sources.delete(this.sources.keys().next().value!);
    const change = event.change;
    if (change.type === "invalidate") return;
    for (const fact of change.type === "batch" ? change.changes : [change]) this.receiveFact(event, fact);
    for (const listener of this.listeners) listener();
  }
  private receiveFact(event: ThreadCatalogChange, change: ThreadCatalogFact): void {
    const id = change.type === "upsert" ? change.thread.id : change.threadId;
    const previous = this.facts.get(id)?.change;
    let merged = change;
    if (change.type === "patch") {
      if (previous?.type === "remove") return;
      if (previous?.type === "upsert") merged = { type: "upsert", thread: { ...previous.thread,
        ...(change.name === undefined ? {} : { name: change.name }), ...(change.status === undefined ? {} : { status: change.status }) } };
      else if (previous?.type === "patch") merged = { ...previous, ...change };
    }
    this.facts.set(id, { sequence: ++this.sequence, source: event.source, revision: event.revision, change: merged });
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

  acknowledge(data: ThreadListResponse | undefined, complete = false): void {
    complete = complete && !threadDirectoryIncomplete(data);
    const snapshot = parseThreadCatalogSnapshot(data);
    const checkpoints = new Map(snapshot?.checkpoints.map(point => [point.source, point.revision]) ?? []);
    const at = (data as unknown as Record<string, unknown> | undefined)?.[boundary];
    if (typeof at !== "number") return;
    const raw = (data as ThreadListResponse & { __opencraftCatalogRawRows?: ThreadListResponse["data"] })?.__opencraftCatalogRawRows ?? data!.data;
    const rows = new Map(raw.map(row => [row.id, row]));
    let changed = false;
    for (const [id, fact] of this.facts) {
      if (fact.sequence > at) continue;
      const row = rows.get(id), change = fact.change;
      const checkpoint = checkpoints.get(fact.source);
      // Matching versions prove ordering; complete replacement also retires
      // facts from a previous publisher incarnation. A partial page cannot
      // acknowledge an absent row, even when its version is newer.
      const certified = !!snapshot && (complete || !!row) && !fact.source.startsWith("access:")
        && (checkpoint === undefined ? complete : fact.revision <= checkpoint);
      // A read boundary is not evidence that a paged snapshot contains a fact.
      // Retire only facts observed in the raw Server snapshot, never a locally
      // materialized overlay. Unloaded rows must retain their live patches.
      const covered = change.type === "remove" ? complete && !row
        : !!row && Object.entries(change.type === "upsert" ? change.thread : {
          ...(change.name === undefined ? {} : { name: change.name }),
          ...(change.status === undefined ? {} : { status: change.status }),
        }).every(([key, value]) => JSON.stringify((row as unknown as Record<string, unknown>)[key]) === JSON.stringify(value));
      if (snapshot ? certified : covered) { this.facts.delete(id); changed = true; }
    }
    if (complete) {
      this.versioned = !!snapshot;
      for (const point of snapshot?.checkpoints ?? [])
        this.sources.set(point.source, Math.max(point.revision, this.sources.get(point.source) ?? 0));
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
export function configureThreadCatalogUpdates(client: QueryClient, hostId: string, versioned: boolean): void {
  for (const journal of journals.get(client)?.values() ?? []) if (journal.hostId === hostId) journal.configureVersioned(versioned);
}

/** Only active paged readers own the live-fact overlay; legacy projections keep
 * their existing invalidation/recovery contract. */
export function hasThreadCatalogUpdates(client: QueryClient, key: QueryKey): boolean {
  return journals.get(client)?.get(JSON.stringify(key))?.enabled === true;
}
