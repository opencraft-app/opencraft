import { useSyncExternalStore } from "react";
import { useUiPreferencesRuntime } from "./ui-preferences-runtime";

export function useOpenPagesInRightPanel(): boolean {
  const preferences = useUiPreferencesRuntime();
  const snapshot = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  return snapshot.values["chat.openPagesInRightPanel"];
}
