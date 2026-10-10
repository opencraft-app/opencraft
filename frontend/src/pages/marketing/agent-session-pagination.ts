import { useCallback, useMemo, useRef, useState } from "react";

interface TimedSession {
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly pinned?: boolean;
}

export function useAgentSessionPagination<T extends TimedSession>(
  sessions: readonly T[],
  hasMoreOnServer: boolean,
  loadMoreOnServer?: () => Promise<void>,
  pageSize = 20,
) {
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState(false);
  const generationRef = useRef(0);

  const pinnedSessions = useMemo(() => sessions.filter((session) => session.pinned === true), [sessions]);
  const orderedSessions = useMemo(() => sessions.filter((session) => session.pinned !== true).sort((left, right) =>
    (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0),
  ), [sessions]);
  const visibleSessions = useMemo(() => [...pinnedSessions, ...orderedSessions.slice(0, visibleCount)], [pinnedSessions, orderedSessions, visibleCount]);
  const hasMoreVisible = visibleCount < orderedSessions.length || hasMoreOnServer;

  const reset = useCallback(() => {
    generationRef.current += 1;
    setVisibleCount(pageSize);
    setLoadingMore(false);
    setPageError(false);
  }, [pageSize]);

  const showMore = async () => {
    if (loadingMore || !hasMoreVisible) return;
    const nextCount = visibleCount + pageSize;
    if (nextCount <= orderedSessions.length || !hasMoreOnServer) {
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
    setVisibleCount((count) => Math.max(pageSize, count - pageSize));
    setPageError(false);
  };

  return {
    visibleSessions,
    pinnedCount: pinnedSessions.length,
    hasMoreVisible,
    hasExpanded: visibleCount > pageSize,
    loadingMore,
    pageError,
    showMore,
    collapse,
    reset,
  };
}
