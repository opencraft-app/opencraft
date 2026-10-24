import { useInsertionEffect, useRef } from "react";
import { useStableEvent } from "@opencraft/react-runtime";
import {
  TurnHistoryBackfillCoordinator,
  type TurnHistoryPageResult,
  type TurnViewportMetrics,
} from "@opencraft/timeline-virtualizer";

export interface UseTurnHistoryBackfillOptions {
  /** Semantic history owner. Changing it invalidates an in-flight drain. */
  readonly historyKey: string | null;
  readonly loadPage?: () => TurnHistoryPageResult | Promise<TurnHistoryPageResult>;
  readonly readMetrics: () => TurnViewportMetrics | null;
  readonly afterLayout: () => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export interface TurnHistoryBackfillHandle {
  /** Stable single-flight command. */
  readonly request: () => Promise<void>;
  /** Ends the current layout owner's generation. */
  readonly invalidate: () => void;
}

export function useTurnHistoryBackfill({
  historyKey,
  loadPage,
  readMetrics,
  afterLayout,
  onError,
}: UseTurnHistoryBackfillOptions): TurnHistoryBackfillHandle {
  const readMetricsEvent = useStableEvent(readMetrics);
  const afterLayoutEvent = useStableEvent(afterLayout);
  const loadPageEvent = useStableEvent(() => loadPage?.() ?? "stop");
  const isEnabledEvent = useStableEvent(() => loadPage !== undefined);
  const onErrorEvent = useStableEvent((error: unknown) => onError?.(error));
  const coordinatorRef = useRef<TurnHistoryBackfillCoordinator | null>(null);

  if (coordinatorRef.current === null) {
    coordinatorRef.current = new TurnHistoryBackfillCoordinator({
      afterLayout: afterLayoutEvent,
      isEnabled: isEnabledEvent,
      loadPage: loadPageEvent,
      onError: onErrorEvent,
      readMetrics: readMetricsEvent,
    });
  }
  const coordinator = coordinatorRef.current;
  const handleRef = useRef<TurnHistoryBackfillHandle | null>(null);
  if (handleRef.current === null) {
    handleRef.current = {
      invalidate: () => coordinator.invalidate(),
      request: coordinator.request,
    };
  }

  useInsertionEffect(() => {
    coordinator.invalidate();
    return () => coordinator.invalidate();
  }, [coordinator, historyKey]);

  return handleRef.current;
}
