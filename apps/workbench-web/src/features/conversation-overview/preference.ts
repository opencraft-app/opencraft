import { useSyncExternalStore } from "react";
import { useUiPreferencesRuntime } from "../../runtime/ui-preferences-runtime";

export function useConversationOverviewEnabled() {
  const preferences = useUiPreferencesRuntime();
  return useSyncExternalStore(preferences.subscribe, preferences.getSnapshot).values["sidebar.conversationOverview"];
}
