import { threadDirectoryIncomplete, threadDirectoryFailed, parseThreadCatalogSnapshot, isCatalogSnapshotExpired } from "@opencraft/appserver-protocol";
import { observeCatalogQueries, noteCatalogCause, catalogPageTrace } from "./catalog-request-observation";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { InfiniteQueryObserver, notifyManager, useQueryClient,
  type InfiniteData, type DefaultedInfiniteQueryObserverOptions, type InfiniteQueryObserverOptions, type InfiniteQueryObserverResult } from "@tanstack/react-query";
import type { ThreadListResponse } from "@opencraft/appserver-protocol/generated/v2";
import { isHostThreadCatalogUnavailableError, readHostThreadCatalog } from "./host-thread-catalog";
import { mergeThreadCatalogPages, sidebarThreadCatalogQueryKey } from "./thread-catalog-query";
import { beginObservedOperation } from "./observability";
import { retryQuery } from "./workbench-application-services";
import { reportRuntimeError } from "../runtime-error-reporting";
import { threadCatalogUpdates } from "./thread-catalog-updates";
import { startCatalogReturnRecovery } from "./catalog-return-recovery";

type CatalogQuery = Omit<Parameters<typeof readHostThreadCatalog>[0], "signal" | "onInitialPage" | "pageCursor"> & {
  readonly enabled: boolean;
  readonly queryKey: ReturnType<typeof sidebarThreadCatalogQueryKey>;
};
type Key = CatalogQuery["queryKey"];
type Observer = InfiniteQueryObserver<ThreadListResponse, Error, ThreadListResponse, Key, string | null>;
type Result = InfiniteQueryObserverResult<ThreadListResponse, Error>;
type Options = InfiniteQueryObserverOptions<ThreadListResponse, Error, ThreadListResponse, Key, string | null>;
const directoryFailure = new Error("Conversation directory refresh failed");

/** A connection owner drives recovery of an unreadable Host. */
export function retryHostThreadCatalogQuery(failureCount: number, error: unknown): boolean {
  return isHostThreadCatalogUnavailableError(error) || isCatalogSnapshotExpired(error) ? false : retryQuery(failureCount, error);
}

export function projectThreadCatalogPages(value: InfiniteData<ThreadListResponse, string | null>): ThreadListResponse {
  const snapshot = parseThreadCatalogSnapshot(value.pages[0]);
  if (snapshot && value.pages.some(page => JSON.stringify(parseThreadCatalogSnapshot(page)) !== JSON.stringify(snapshot)))
    throw new Error("Conversation catalog snapshot changed; retry from the first page");
  const partial = value.pages.find(threadDirectoryIncomplete) as (ThreadListResponse & { catalog?: unknown }) | undefined;
  const result = { ...value.pages[0]!, ...(partial?.catalog ? { catalog: partial.catalog } : {}),
    data: mergeThreadCatalogPages(value.pages), nextCursor: value.pages.at(-1)?.nextCursor ?? null };
  if (snapshot) {
    const decoration = (value.pages[0] as ThreadListResponse & { catalogDecorations?: { pins?: ThreadListResponse["data"]; provisional?: ThreadListResponse["data"] } }).catalogDecorations;
    const raw = result.data;
    const pins = new Set(decoration?.pins?.map(row => row.id) ?? []);
    const displayed = new Map(raw.map(row => [row.id, { ...row, pinned: pins.has(row.id) }]));
    if (result.nextCursor !== null || partial) for (const row of [...decoration?.pins ?? [], ...decoration?.provisional ?? []])
      if (!displayed.has(row.id)) displayed.set(row.id, { ...row, pinned: pins.has(row.id) });
    result.data = [...displayed.values()].sort((a, b) => (b.recencyAt ?? b.updatedAt) - (a.recencyAt ?? a.updatedAt) || a.id.localeCompare(b.id));
    Object.assign(result, { __opencraftCatalogRawRows: raw });
  }
  return result;
}

/** TanStack exposes useInfiniteQuery for one source, but no useInfiniteQueries.
 * Compose its public observers for a dynamic Host set. Only observer handles
 * live here; successful pages, retries and cancellation belong to QueryClient. */
export function useHostThreadCatalogQueries(inputs: readonly CatalogQuery[]) {
  const client = useQueryClient();
  useEffect(() => startCatalogReturnRecovery(client), [client]);
  observeCatalogQueries(client);
  const pool = useMemo(() => new Map<string, Observer>(), [client]);
  const measures = useMemo(() => new Map<Observer, ReturnType<typeof beginObservedOperation>>(), [client]);
  const scope = JSON.stringify(inputs.map(input => input.queryKey));
  const updates = useMemo(() => inputs.map(input => threadCatalogUpdates(client, input.queryKey, input.profile.hostId)), [client, scope]);
  updates.forEach((update, index) => { update.enabled = inputs[index]!.enabled; });
  const liveStore = useMemo(() => ({
    read: () => updates.map(update => update.getSnapshot()).join(":"),
    subscribe: (listener: () => void) => { const remove = updates.map(update => update.subscribe(listener)); return () => remove.forEach(stop => stop()); },
  }), [updates]);
  useSyncExternalStore(liveStore.subscribe, liveStore.read, liveStore.read);
  const enabledSignature = inputs.map(input => input.enabled).join(":");
  useEffect(() => {
    updates.forEach((update, index) => { update.enabled = inputs[index]!.enabled; });
    return () => { updates.forEach(update => { update.enabled = false; }); };
  }, [updates, enabledSignature]);
  const observers = useMemo(() => inputs.map(input => {
    const key = JSON.stringify(input.queryKey);
    let observer = pool.get(key);
    if (!observer) {
      observer = new InfiniteQueryObserver(client, options(input));
      pool.set(key, observer);
    }
    return observer;
  }), [client, pool, scope]);
  function options(input: CatalogQuery): Options {
    return {
      queryKey: input.queryKey, meta:{requestCaller:"sidebar-catalog"}, enabled: input.enabled, initialPageParam: null,
      queryFn: async ({ signal, pageParam }) => {
        const updates = threadCatalogUpdates(client, input.queryKey, input.profile.hostId);
        const startedAt = updates.getSnapshot();
        const previous = client.getQueryData<InfiniteData<ThreadListResponse, string | null>>(input.queryKey);
        const appending = client.getQueryState(input.queryKey)?.fetchMeta?.fetchMore?.direction === "forward";
        const projected = pageParam == null && previous?.pages.length && !appending ? projectThreadCatalogPages(previous) : undefined;
        const recoveryBase = projected ? { ...projected, data: (projected as ThreadListResponse & { __opencraftCatalogRawRows?: ThreadListResponse["data"] }).__opencraftCatalogRawRows ?? projected.data } : undefined;
        const page = await readHostThreadCatalog({ ...input, signal, pageCursor: pageParam, recoveryBase, trace:catalogPageTrace(client,input.queryKey,pageParam) });
        const position = previous?.pageParams.indexOf(pageParam) ?? -1;
        const prefix = !appending ? [] : position < 0 ? previous?.pageParams ?? [] : previous!.pageParams.slice(0, position + 1);
        if (page.nextCursor != null && (page.nextCursor === pageParam || prefix.includes(page.nextCursor))) {
          throw new Error("Repeated thread catalog cursor");
        }
        return updates.markRead(page, startedAt);
      },
      getNextPageParam: last => last.nextCursor ?? null,
      select: projectThreadCatalogPages, staleTime: 30_000, retry: retryHostThreadCatalogQuery,
      refetchInterval: query => query.state.data?.pages.some(threadDirectoryIncomplete)
        ? query.state.data.pages.some(threadDirectoryFailed) ? 30_000 : 2000 : false,
    };
  }
  const configured = inputs.map(input => {
    const value = options(input);
    const defaulted = client.defaultQueryOptions(value) as DefaultedInfiniteQueryObserverOptions<ThreadListResponse, Error, ThreadListResponse, Key, string | null>;
    defaulted._optimisticResults = "optimistic";
    return defaulted;
  });
  const optimistic = observers.map((observer, index) => observer.getOptimisticResult(configured[index]!));
  const snapshotRestarts = useRef(new WeakMap<Observer, { at: number; count: number }>());
  useEffect(() => {
    optimistic.forEach((result, index) => {
      if (!inputs[index]!.enabled || !result.isError || result.isFetching || !isCatalogSnapshotExpired(result.error)) return;
      const observer = observers[index]!, now = performance.now(), prior = snapshotRestarts.current.get(observer);
      const count = prior && now - prior.at < 60_000 ? prior.count : 0;
      if (count >= 2) return; // Bounded recovery; a busy/failed owner retains ordinary Retry.
      snapshotRestarts.current.set(observer, { at: now, count: count + 1 });
      const key = inputs[index]!.queryKey;
      const previous = client.getQueryData<InfiniteData<ThreadListResponse, string | null>>(key);
      notifyManager.batch(() => {
        if (previous?.pages.length) client.setQueryData(key, { pages: [{ ...previous.pages[0],
          data: mergeThreadCatalogPages(previous.pages), nextCursor: null,
          catalog: { state: "syncing", coverage: "partial" } }], pageParams: [null] });
        void observer.refetch({ cancelRefetch: false });
      });
    });
  });
  useEffect(() => {
    optimistic.forEach((result, index) => {
      if (result.isFetching || !result.isSuccess) return;
      const update = updates[index]!;
      // Query data contains only raw Server pages. Live facts are projected at
      // presentation time and cannot acknowledge themselves through this cache.
      update.acknowledge(result.data, !result.hasNextPage && !threadDirectoryIncomplete(result.data));
    });
  });
  const store = useMemo(() => {
    let snapshot: Result[] = [];
    return {
      read: () => {
        const next = observers.map(observer => observer.getCurrentResult());
        if (next.length !== snapshot.length || next.some((result, index) => result !== snapshot[index])) snapshot = next;
        return snapshot;
      },
      subscribe: (listener: () => void) => {
        const remove = observers.map(observer => observer.subscribe(notifyManager.batchCalls(listener)));
        observers.forEach(observer => observer.updateResult());
        return () => remove.forEach(stop => stop());
      },
    };
  }, [observers]);
  useSyncExternalStore(store.subscribe, store.read, store.read);
  useEffect(() => {
    observers.forEach((observer, index) => observer.setOptions(configured[index]!));
    const active = new Set(inputs.map(input => JSON.stringify(input.queryKey)));
    for (const key of pool.keys()) if (!active.has(key)) pool.delete(key);
  });
  // Navigation can render each successful page immediately. Continue the
  // metadata index independently of rendering, so old titles remain searchable.
  // Stop on failure; an explicit retry/refetch owns recovery, never a render loop.
  useEffect(() => {
    optimistic.forEach((result, index) => {
      if (inputs[index]!.enabled && result.hasNextPage && !result.isFetching && !result.isError) {
        noteCatalogCause(client,{queryKey:inputs[index]!.queryKey,exact:true},"auto-next-page");
        void observers[index]!.fetchNextPage({ cancelRefetch: false });
      }
    });
  });
  const reportedCatalogErrors = useRef(new Set<string>());
  useEffect(() => {
    observers.forEach((observer, index) => {
      const result = optimistic[index]!;
      if (inputs[index]!.enabled && result.isFetching && !measures.has(observer)) {
        measures.set(observer, beginObservedOperation("catalog_complete"));
      }
      const finish = measures.get(observer);
      const failed = result.isError || threadDirectoryFailed(result.data);
      if (finish && (!inputs[index]!.enabled || failed || (!result.isFetching && !result.hasNextPage && result.data && !threadDirectoryIncomplete(result.data)))) {
        finish(!inputs[index]!.enabled ? "aborted" : failed ? "failed" : "ok", { count: result.data?.data.length ?? 0 });
        measures.delete(observer);
      }
      if (inputs[index]!.enabled && result.isError && !isHostThreadCatalogUnavailableError(result.error) && !isCatalogSnapshotExpired(result.error)) {
        const token = `${JSON.stringify(inputs[index]!.queryKey)}:${result.error instanceof Error ? result.error.message : String(result.error)}`;
        if (!reportedCatalogErrors.current.has(token)) {
          reportedCatalogErrors.current.add(token);
          reportRuntimeError(result.error, "thread-catalog-load");
        }
      }
    });
    for (const [observer, finish] of measures) if (!observers.includes(observer)) { finish("aborted"); measures.delete(observer); }
  });
  useEffect(() => () => { for (const finish of measures.values()) finish("aborted"); measures.clear(); }, [measures]);
  return optimistic.map((result, index) => ({ ...result,
    status: threadDirectoryFailed(result.data) ? "error" as const : result.status,
    error: result.error ?? (threadDirectoryFailed(result.data) ? directoryFailure : null),
    isSuccess: result.isSuccess && !threadDirectoryFailed(result.data),
    isError: result.isError || threadDirectoryFailed(result.data),
    isLoading: result.isLoading || (!threadDirectoryFailed(result.data) && threadDirectoryIncomplete(result.data) && result.data?.data.length === 0),
    isFetching: result.isFetching || (!threadDirectoryFailed(result.data) && threadDirectoryIncomplete(result.data)),
    data: updates[index]!.project(result.data),
    hasNextPage: result.data === undefined && updates[index]!.project(undefined) !== undefined ? true : result.hasNextPage,
    dataRevision: observers[index]!.getCurrentQuery().state.dataUpdateCount + updates[index]!.getSnapshot(),
  }));
}
