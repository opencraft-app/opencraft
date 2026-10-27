import { useSyncExternalStore } from "react";
import { useUiPreferencesRuntime } from "./ui-preferences-runtime";

export function useVoiceInputPreference() {
  const preferences = useUiPreferencesRuntime();
  const snapshot = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  return { provider: snapshot.values["voice.inputProvider"],
    setProvider: (value: "auto" | "system" | "hunyuan") => preferences.set("voice.inputProvider", value) };
}
