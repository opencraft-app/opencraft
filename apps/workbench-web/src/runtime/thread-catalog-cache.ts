import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { ClientResourceDefinition, ReadableClientResource } from "@opencraft/document-storage/client-resources";
import type { DocumentValue } from "@opencraft/document-storage";
import type { WorkbenchThread } from "@opencraft/workbench-runtime";

type CachedThread = {
  id: string; title: string; project: string; lineage: "root" | "fork" | "subagent";
  updatedAt: number; createdAt: number | null; pinned: boolean;
  parentThreadId: string | null; visibility: "visible" | "hidden";
};
export type CachedThreadCatalog = { rows: CachedThread[]; complete: boolean };
export const CACHED_THREAD_LIMIT = 300;

function object(value: DocumentValue): { readonly [key: string]: DocumentValue } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved thread catalog");
  return value as { readonly [key: string]: DocumentValue };
}
function text(value: DocumentValue | undefined, limit: number): string {
  if (typeof value !== "string" || value.length > limit) throw new Error("Invalid saved thread catalog text");
  return value;
}
function timestamp(value: DocumentValue | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid saved thread timestamp");
  return value;
}
export const threadCatalogResource: ClientResourceDefinition<CachedThreadCatalog> = {
  name: "thread-catalog", authority: "remote", version: 2,
  parse(value) {
    const catalog = object(value);
    if (typeof catalog.complete !== "boolean" || !Array.isArray(catalog.rows) || catalog.rows.length > CACHED_THREAD_LIMIT) throw new Error("Invalid saved thread catalog");
    const seen = new Set<string>();
    return { complete: catalog.complete, rows: catalog.rows.map(value => {
      const row = object(value);
      const id = text(row.id, 512);
      if (!id || seen.has(id) || !["root", "fork", "subagent"].includes(String(row.lineage)) || typeof row.pinned !== "boolean"
        || (row.visibility !== "visible" && row.visibility !== "hidden")) throw new Error("Invalid saved thread identity");
      seen.add(id);
      return { id, title: text(row.title, 512), project: text(row.project, 256), lineage: row.lineage as CachedThread["lineage"],
        updatedAt: timestamp(row.updatedAt), createdAt: row.createdAt === null ? null : timestamp(row.createdAt), pinned: row.pinned,
        parentThreadId: row.parentThreadId === null ? null : text(row.parentThreadId, 512), visibility: row.visibility };
    }) };
  },
};

/** No raw prompts, transport credentials, capabilities or active execution state. */
export function cacheThreadCatalog(rows: readonly WorkbenchThread[], complete: boolean): CachedThreadCatalog {
  return { complete: complete && rows.length <= CACHED_THREAD_LIMIT, rows: rows.slice(0, CACHED_THREAD_LIMIT).map(row => ({
    id: row.id, title: row.title.slice(0, 512), project: row.project.slice(0, 256), lineage: row.lineage,
    updatedAt: row.updatedAt, createdAt: row.createdAt ?? null, pinned: row.pinned === true,
    parentThreadId: row.parentThreadId ?? null, visibility: row.visibility ?? "visible",
  })) };
}
export function mergeCachedCatalogRows(fresh: readonly WorkbenchThread[], saved: CachedThreadCatalog | null, complete: boolean): WorkbenchThread[] {
  if (complete || !saved) return [...fresh];
  const ids = new Set(fresh.map(row => row.id));
  return [...fresh, ...restoreThreadCatalog(saved).filter(row => !ids.has(row.id))];
}
export function threadCatalogDisplayRows(fresh: readonly WorkbenchThread[] | undefined, saved: CachedThreadCatalog | null, complete: boolean) {
  const confirmed = new Set(fresh?.map(row => row.id));
  const rows = fresh === undefined ? restoreThreadCatalog(saved) : mergeCachedCatalogRows(fresh, saved, complete);
  return rows.map(thread => ({ thread, confirmed: confirmed.has(thread.id) }));
}
export function restoreThreadCatalog(value: CachedThreadCatalog | null, now = Date.now()): WorkbenchThread[] {
  return (value?.rows ?? []).map(({ createdAt, ...row }) => {
    const minutes = Math.max(0, Math.floor((now / 1000 - row.updatedAt) / 60));
    return { ...row, ...(createdAt === null ? {} : { createdAt }), status: "ready",
      time: minutes < 1 ? "Now" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d` };
  });
}

export function useClientResourceSnapshots<T>(resources: readonly ReadableClientResource<T>[]) {
  const store = useMemo(() => {
    let snapshot = resources.map(resource => resource.getSnapshot());
    return {
      read: () => {
        const next = resources.map(resource => resource.getSnapshot());
        if (next.some((value, index) => value !== snapshot[index])) snapshot = next;
        return snapshot;
      },
      subscribe: (listener: () => void) => {
        const stops = resources.map(resource => resource.subscribe(listener));
        return () => stops.forEach(stop => stop());
      },
    };
  }, [resources]);
  return useSyncExternalStore(useCallback(store.subscribe, [store]), store.read, store.read);
}
