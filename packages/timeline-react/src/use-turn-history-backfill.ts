import { useEffect, useInsertionEffect, useRef } from "react";
import { useStableEvent } from "@opencraft/react-runtime";
import {
  TurnHistoryBackfillCoordinator,
  type TurnHistoryBackfillDiagnostic,
  type TurnHistoryPageResult,
  type TurnHistoryPagination,
  type TurnViewportMetrics,
} from "@opencraft/timeline-virtualizer";

export interface UseTurnHistoryBackfillOptions {
  /** Semantic history owner. Changing it invalidates an in-flight drain. */
  readonly historyKey: string | null;
  readonly pagination: TurnHistoryPagination | null;
  readonly loadPage?: () => TurnHistoryPageResult | Promise<TurnHistoryPageResult>;
  readonly readMetrics: () => TurnViewportMetrics | null;
  readonly readVisibleHistoryGap?: () => string | null;
  readonly afterLayout: () => Promise<void>;
  readonly onError?: (error: unknown) => void;
  readonly onDiagnostic?: (event: TurnHistoryBackfillDiagnostic) => void;
}

export interface TurnHistoryBackfillHandle {
  /** Stable single-flight command. */
  readonly request: () => Promise<void>;
  /** Explicit user retry of a stopped frontier. */
  readonly retry: () => Promise<void>;
  /** Ends the current layout owner's generation. */
  readonly invalidate: () => void;
}

export function useTurnHistoryBackfill({
  historyKey,
  pagination,
  loadPage,
  readMetrics,
  readVisibleHistoryGap,
  afterLayout,
  onError,
  onDiagnostic,
}: UseTurnHistoryBackfillOptions): TurnHistoryBackfillHandle {
  const readPaginationEvent = useStableEvent(() => pagination);
  const enabled = loadPage !== undefined;
  const readMetricsEvent = useStableEvent(readMetrics);
  const readVisibleHistoryGapEvent = useStableEvent(() => readVisibleHistoryGap?.() ?? null);
  const afterLayoutEvent = useStableEvent(afterLayout);
  const loadPageEvent = useStableEvent(() => loadPage === undefined ? "stop" : loadPage());
  const isEnabledEvent = useStableEvent(() => loadPage !== undefined);
  const onErrorEvent = useStableEvent((error: unknown) => onError?.(error));
  const onDiagnosticEvent = useStableEvent((event: TurnHistoryBackfillDiagnostic) => onDiagnostic?.(event));
  const coordinatorRef = useRef<TurnHistoryBackfillCoordinator | null>(null);

  if (coordinatorRef.current === null) {
    coordinatorRef.current = new TurnHistoryBackfillCoordinator({
      afterLayout: afterLayoutEvent,
      isEnabled: isEnabledEvent,
      loadPage: loadPageEvent,
      onError: onErrorEvent,
      readMetrics: readMetricsEvent,
      readPagination: readPaginationEvent,
      readVisibleHistoryGap: readVisibleHistoryGapEvent,
      onDiagnostic: onDiagnosticEvent,
    });
  }
  const coordinator = coordinatorRef.current;
  const handleRef = useRef<TurnHistoryBackfillHandle | null>(null);
  if (handleRef.current === null) {
    handleRef.current = {
      invalidate: () => coordinator.invalidate(),
      request: coordinator.request,
      retry: coordinator.retry,
    };
  }

  useInsertionEffect(() => {
    coordinator.invalidate();
    return () => coordinator.invalidate();
  }, [coordinator, historyKey, enabled]);

  // Readiness and page settlement are domain changes even when DOM size is stable.
  useEffect(() => {
    if (enabled) void coordinator.request();
  }, [coordinator, historyKey, enabled, pagination?.cursor, pagination?.hasOlder, pagination?.loading]);

  return handleRef.current;
}
