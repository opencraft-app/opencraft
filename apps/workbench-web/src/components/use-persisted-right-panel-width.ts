import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";
import { useMotionValue } from "motion/react";
import { useUiPreferencesRuntime } from "../runtime/ui-preferences-runtime";

/** Installation preference is distinct from live drag geometry and default layout. */
export function usePersistedRightPanelWidth() {
  const preferences = useUiPreferencesRuntime();
  const snapshot = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  const stored = snapshot.values["shell.rightPanelWidth"].ratio;
  const ratio = useMotionValue<number | null>(stored);
  useLayoutEffect(() => {
    ratio.set(stored);
  }, [ratio, stored]);
  const commit = useCallback(
    (value: number | null) => {
      ratio.set(value);
      void preferences.set("shell.rightPanelWidth", { ratio: value }).catch((error) => {
        console.error("Could not save panel width", error);
      });
    },
    [preferences, ratio],
  );
  return { ratio, commit };
}
