import { randomUUID } from "node:crypto";
import { parseThreadCatalogChange, THREAD_CATALOG_CHANGED, type ThreadCatalogChange } from "@opencraft/appserver-protocol";
import { ThreadDirectory, DirectorySnapshotPages, SNAPSHOT_CURSOR, type DirectoryMeasurement } from "@opencraft/app-host-server/thread-directory";
import type { ThreadListParams } from "@opencraft/appserver-protocol/generated/v2";
import { ThreadCatalog } from "./thread-catalog.js";

type Value = Record<string, any>;
export interface EngineDirectorySource {
  id: string;
  list(params: ThreadListParams): Promise<Value>;
  read(threadId: string): Promise<unknown>;
  owns(threadId: string): boolean;
}

/** Disposable per-admitted-reader projection. No execution lease or another reader's delegate is retained. */
export class EngineThreadDirectory {
  readonly partitions: Array<{ source: EngineDirectorySource; store: ThreadCatalog; directory: ThreadDirectory }>;
  #closed = false;
  readonly #epoch = randomUUID();
  readonly #snapshots = new DirectorySnapshotPages();
  constructor(sources: readonly EngineDirectorySource[], changed: (event?: ThreadCatalogChange) => void,
    measured?: (metric: DirectoryMeasurement & { engine: string }) => void) {
    this.partitions = sources.map(source => {
      const store = new ThreadCatalog();
      const directory = store.createProjection({
        measured: metric => measured?.({ ...metric, engine: source.id }),
        list: async params => {
          const page = await source.list(params);
          if (!Array.isArray(page.data) || page.data.some((row: Value) => typeof row.id !== "string" || !source.owns(row.id)))
            throw new Error("Directory source namespace mismatch");
          return page;
        },
        readMetadata: threadId => source.read(threadId),
        changed,
      });
      directory.start();
      return { source, store, directory };
    });
  }
  supports(params: Value): boolean {
    return this.partitions.length > 0 && this.partitions[0]!.directory.supports({ ...params, sortKey: params.sortKey ?? "updated_at" });
  }
  observe(method: string, params: unknown, result?: unknown, sourceId?: string): void {
    const event = method === THREAD_CATALOG_CHANGED ? parseThreadCatalogChange(params) : null;
    if (event?.change.type === "invalidate" || method === THREAD_CATALOG_CHANGED && !event) {
      for (const partition of this.partitions) if (!sourceId || partition.source.id === sourceId) void partition.directory.refresh().catch(() => {});
      return;
    }
    if (event?.change.type === "batch") {
      const changes = event.change.changes;
      for (const partition of this.partitions) {
        const filtered = changes.filter(change => partition.source.owns(change.type === "upsert" ? change.thread.id : change.threadId));
        if (filtered.length) partition.directory.observe(method, { ...event, change: { type: "batch", changes: filtered } });
      }
      return;
    }
    const change = event?.change;
    const id = (change ? change.type === "upsert" ? change.thread.id : change.threadId : undefined) ?? (result as Value)?.thread?.id ?? (params as Value)?.threadId ?? (params as Value)?.thread?.id;
    if (typeof id !== "string") return;
    for (const partition of this.partitions) if (partition.source.owns(id)) partition.directory.observe(method, params, result);
  }
  async list(params: Value): Promise<Value> {
    if (this.#closed) throw new Error("Directory reader closed");
    const query = { ...params, sortKey: params.sortKey ?? "updated_at" };
    let anchor: { updatedAt: number; id: string } | null = null;
    const versioned = typeof params.cursor === "string" && params.cursor.startsWith(SNAPSHOT_CURSOR);
    if (params.cursor != null && !versioned) {
      try {
        const value = JSON.parse(String(params.cursor).slice("opencraft-catalog-v1:".length));
        if (!Array.isArray(value) || value.length !== 4 || value[0] !== Number(params.archived === true) || value[1] !== this.#epoch || !Number.isFinite(value[2]) || typeof value[3] !== "string") throw Error();
        anchor = { updatedAt: value[2], id: value[3] };
      } catch { throw new Error("Invalid engine directory cursor"); }
    }
    // Sources reconcile independently. Once any source is available, a slow
    // sibling never delays known rows. The response explicitly carries coverage.
    const cold = this.partitions.filter(({ store }) => store.directoryState() == null);
    if (cold.length) {
      const jobs = cold.map(({ directory }) => directory.settled());
      const any = Promise.any(jobs).catch(() => undefined);
      if (cold.length === this.partitions.length)
        await Promise.race([Promise.allSettled(jobs), any.then(() => new Promise(resolve => setTimeout(resolve, 5)))]);
    }
    if (this.#closed) throw new Error("Directory reader closed");
    if (versioned) return this.#snapshots.list(params.cursor, params.archived === true, Number(params.limit ?? 100), () => {
      const coverage = this.partitions.map(({ directory }) => directory.coverage(params.archived === true));
      const failed = coverage.some(row => row.state === "error"), warming = coverage.some(row => row.coverage !== "complete");
      return { parts: this.partitions.map(({ directory }) => directory.snapshot(params.archived === true)),
        catalog: { state: failed ? "error" : warming ? "warming" : "ready", coverage: failed || warming ? "partial" : "complete" } };
    });
    const pages = await Promise.all(this.partitions.map(async ({ source, directory, store }) => {
      const state = store.directoryState();
      if (state == null) return { data: [], nextCursor: null, source: source.id, warming: !store.directoryFailed(), failed: store.directoryFailed() };
      const page = await directory.list({ ...query, cursor: anchor ? directory.cursor(params.archived === true, anchor) : null });
      return { ...page, source: source.id, warming: false, failed: page.catalog.state === "error" };
    }));
    const entries = pages.flatMap(page => page.data).sort((a, b) =>
      Number(b.recencyAt ?? b.updatedAt) - Number(a.recencyAt ?? a.updatedAt) || a.id.localeCompare(b.id));
    const limit = Number(params.limit ?? 100), data = entries.slice(0, limit), last = data.at(-1);
    const more = entries.length > limit || pages.some(page => page.nextCursor != null);
    const unavailableEngines = pages.filter(page => page.failed).map(page => page.source);
    const warming = pages.some(page => page.warming);
    return { data, nextCursor: more && last ? "opencraft-catalog-v1:" + JSON.stringify([params.archived === true ? 1 : 0, this.#epoch, last.recencyAt ?? last.updatedAt, last.id]) : null,
      backwardsCursor: null, unavailableEngines,
      catalog: { state: warming ? "warming" : unavailableEngines.length ? "error" : "ready", coverage: warming || unavailableEngines.length ? "partial" : "complete" } };
  }
  close(): void { if (this.#closed) return; this.#closed = true; this.#snapshots.clear(); for (const { store } of this.partitions) store.close(); }
}
