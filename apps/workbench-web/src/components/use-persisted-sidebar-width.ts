import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";
import {
  getSidebarMaximumWidth,
  sidebarWidthMetrics,
} from "./sidebar-resize-handle";

function boundedSidebarWidth(value: number, unified: boolean): number {
  return Math.max(
    sidebarWidthMetrics(unified).minimumWidth,
    Math.min(value, getSidebarMaximumWidth(Number.POSITIVE_INFINITY, unified)),
  );
}

export function usePersistedSidebarWidth(unified = false) {
  const preferences = useUiPreferencesRuntime();
  const snapshot = useSyncExternalStore(
    preferences.subscribe,
    preferences.getSnapshot,
    preferences.getSnapshot,
  );
  const storedWidth = boundedSidebarWidth(snapshot.storedRevisions["shell.contextSidebarWidth"]
    ? snapshot.values["shell.contextSidebarWidth"] : sidebarWidthMetrics(unified).defaultWidth, unified);
  const [width, setWidth] = useState(storedWidth);

  useEffect(() => {
    if (storedWidth !== width) setWidth(storedWidth);
  }, [storedWidth]);

  const commit = useCallback((nextWidth: number, persist: boolean) => {
    const bounded = boundedSidebarWidth(nextWidth, unified);
    setWidth(bounded);
    if (!persist) return;
    void preferences.set("shell.contextSidebarWidth", bounded).catch((error) => {
      console.error("Could not save sidebar width", error);
    });
  }, [preferences, unified]);

  return { width, commit } as const;
}
