import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { InfiniteQueryObserver, notifyManager, useQueryClient,
  type InfiniteData, type DefaultedInfiniteQueryObserverOptions, type InfiniteQueryObserverOptions, type InfiniteQueryObserverResult } from "@tanstack/react-query";
import type { ThreadListResponse } from "@opencraft/appserver-protocol/generated/v2";
import { isHostThreadCatalogUnavailableError, readHostThreadCatalog } from "./host-thread-catalog";
import { mergeThreadCatalogPages, sidebarThreadCatalogQueryKey } from "./thread-catalog-query";
import { beginObservedOperation } from "./observability";
import { retryQuery } from "./workbench-application-services";
import { reportRuntimeError } from "../runtime-error-reporting";

type CatalogQuery = Omit<Parameters<typeof readHostThreadCatalog>[0], "signal" | "onInitialPage" | "pageCursor"> & {
  readonly enabled: boolean;
  readonly queryKey: ReturnType<typeof sidebarThreadCatalogQueryKey>;
};
type Key = CatalogQuery["queryKey"];
type Observer = InfiniteQueryObserver<ThreadListResponse, Error, ThreadListResponse, Key, string | null>;
type Result = InfiniteQueryObserverResult<ThreadListResponse, Error>;
type Options = InfiniteQueryObserverOptions<ThreadListResponse, Error, ThreadListResponse, Key, string | null>;

/** A connection owner drives recovery of an unreadable Host. */
export function retryHostThreadCatalogQuery(failureCount: number, error: unknown): boolean {
  return isHostThreadCatalogUnavailableError(error) ? false : retryQuery(failureCount, error);
}

function projectPages(value: InfiniteData<ThreadListResponse, string | null>): ThreadListResponse {
  return { ...value.pages[0]!, data: mergeThreadCatalogPages(value.pages), nextCursor: value.pages.at(-1)?.nextCursor ?? null };
}

/** TanStack exposes useInfiniteQuery for one source, but no useInfiniteQueries.
 * Compose its public observers for a dynamic Host set. Only observer handles
 * live here; successful pages, retries and cancellation belong to QueryClient. */
export function useHostThreadCatalogQueries(inputs: readonly CatalogQuery[]) {
  const client = useQueryClient();
  const pool = useMemo(() => new Map<string, Observer>(), [client]);
  const measures = useMemo(() => new Map<Observer, ReturnType<typeof beginObservedOperation>>(), [client]);
  const scope = JSON.stringify(inputs.map(input => input.queryKey));
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
      queryKey: input.queryKey, enabled: input.enabled, initialPageParam: null,
      queryFn: async ({ signal, pageParam }) => {
        const page = await readHostThreadCatalog({ ...input, signal, pageCursor: pageParam });
        const previous = client.getQueryData<InfiniteData<ThreadListResponse, string | null>>(input.queryKey);
        const position = previous?.pageParams.indexOf(pageParam) ?? -1;
        const appending = client.getQueryState(input.queryKey)?.fetchMeta?.fetchMore?.direction === "forward";
        const prefix = !appending ? [] : position < 0 ? previous?.pageParams ?? [] : previous!.pageParams.slice(0, position + 1);
        if (page.nextCursor != null && (page.nextCursor === pageParam || prefix.includes(page.nextCursor))) {
          throw new Error("Repeated thread catalog cursor");
        }
        return page;
      },
      getNextPageParam: last => last.nextCursor ?? null,
      select: projectPages, staleTime: 30_000, retry: retryHostThreadCatalogQuery,
    };
  }
  const configured = inputs.map(input => {
    const value = options(input);
    const defaulted = client.defaultQueryOptions(value) as DefaultedInfiniteQueryObserverOptions<ThreadListResponse, Error, ThreadListResponse, Key, string | null>;
    defaulted._optimisticResults = "optimistic";
    return defaulted;
  });
  const optimistic = observers.map((observer, index) => observer.getOptimisticResult(configured[index]!));
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
      if (finish && (!inputs[index]!.enabled || result.isError || (!result.isFetching && !result.hasNextPage && result.data))) {
        finish(!inputs[index]!.enabled ? "aborted" : result.isError ? "failed" : "ok", { count: result.data?.data.length ?? 0 });
        measures.delete(observer);
      }
      if (inputs[index]!.enabled && result.isError && !isHostThreadCatalogUnavailableError(result.error)) {
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
  return optimistic.map((result, index) => ({ ...result, dataRevision: observers[index]!.getCurrentQuery().state.dataUpdateCount }));
}
