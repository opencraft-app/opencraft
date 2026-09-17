import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";
import {
  getSidebarMaximumWidth,
  SIDEBAR_MINIMUM_WIDTH,
} from "./sidebar-resize-handle";

function boundedSidebarWidth(value: number): number {
  return Math.max(
    SIDEBAR_MINIMUM_WIDTH,
    Math.min(value, getSidebarMaximumWidth(Number.POSITIVE_INFINITY)),
  );
}

export function usePersistedSidebarWidth() {
  const preferences = useUiPreferencesRuntime();
  const snapshot = useSyncExternalStore(
    preferences.subscribe,
    preferences.getSnapshot,
    preferences.getSnapshot,
  );
  const storedWidth = boundedSidebarWidth(snapshot.values["shell.contextSidebarWidth"]);
  const [width, setWidth] = useState(storedWidth);

  useEffect(() => {
    if (storedWidth !== width) setWidth(storedWidth);
  }, [snapshot.revision]);

  const commit = useCallback((nextWidth: number, persist: boolean) => {
    const bounded = boundedSidebarWidth(nextWidth);
    setWidth(bounded);
    if (!persist) return;
    void preferences.set("shell.contextSidebarWidth", bounded).catch((error) => {
      console.error("Could not save sidebar width", error);
    });
  }, [preferences]);

  return { width, commit } as const;
}
