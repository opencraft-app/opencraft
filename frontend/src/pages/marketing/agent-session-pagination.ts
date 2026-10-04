import { useCallback, useMemo, useRef, useState } from "react";

const PAGE_SIZE = 20;

interface TimedSession {
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

export function useAgentSessionPagination<T extends TimedSession>(
  sessions: readonly T[],
  hasMoreOnServer: boolean,
  loadMoreOnServer?: () => Promise<void>,
) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState(false);
  const generationRef = useRef(0);

  const orderedSessions = useMemo(() => [...sessions].sort((left, right) =>
    (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0),
  ), [sessions]);
  const visibleSessions = useMemo(() => orderedSessions.slice(0, visibleCount), [orderedSessions, visibleCount]);
  const hasMoreVisible = visibleCount < orderedSessions.length || hasMoreOnServer;

  const reset = useCallback(() => {
    generationRef.current += 1;
    setVisibleCount(PAGE_SIZE);
    setLoadingMore(false);
    setPageError(false);
  }, []);

  const showMore = async () => {
    if (loadingMore || !hasMoreVisible) return;
    const nextCount = visibleCount + PAGE_SIZE;
    if (nextCount <= sessions.length || !hasMoreOnServer) {
      setVisibleCount(nextCount);
      return;
    }
    if (!loadMoreOnServer) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    setPageError(false);
    try {
      await loadMoreOnServer();
      if (generation === generationRef.current) setVisibleCount(nextCount);
    } catch {
      if (generation === generationRef.current) setPageError(true);
    } finally {
      if (generation === generationRef.current) setLoadingMore(false);
    }
  };

  const collapse = () => {
    setVisibleCount((count) => Math.max(PAGE_SIZE, count - PAGE_SIZE));
    setPageError(false);
  };

  return {
    visibleSessions,
    hasMoreVisible,
    hasExpanded: visibleCount > PAGE_SIZE,
    loadingMore,
    pageError,
    showMore,
    collapse,
    reset,
  };
}
