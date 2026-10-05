import { useSyncExternalStore } from "react";
import { useUiPreferencesRuntime } from "./ui-preferences-runtime";

/** The installation preference chooses an intent, never a Host capability. */
export function useDefaultFollowUpAction() {
  const preferences = useUiPreferencesRuntime();
  const snapshot = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  return snapshot.values["chat.defaultFollowUpAction"];
}
