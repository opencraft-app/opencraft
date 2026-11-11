import { agentAvailabilityScope, isAgentEnabled, setAgentEnabled } from "./agent-availability";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useAppServerHosts } from "./appserver-runtime-context";
import { useUiPreferencesRuntime } from "./ui-preferences-runtime";

/** A presentation filter for new conversations; never an execution permission. */
export function useAgentAvailability() {
  const application = useAppServerHosts();
  const preferences = useUiPreferencesRuntime();
  const snapshot = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  const readAccount = useCallback(() => application.threadAttention.getScope() ?? "anonymous", [application]);
  const account = useSyncExternalStore(application.threadAttention.subscribe, readAccount, readAccount);
  const display = useSyncExternalStore(application.displayContinuity.subscribe, application.displayContinuity.getScope, application.displayContinuity.getScope);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const enabled = (hostId: string, agentId: string) => isAgentEnabled(snapshot.values["chat.agentAvailability"], agentAvailabilityScope(display, account, hostId), agentId);
  const setEnabled = async (hostId: string, agentId: string, enabled: boolean) => {
    setSaving(true); setFailed(false);
    const key = agentAvailabilityScope(display, account, hostId);
    try {
      await setAgentEnabled(preferences, key, agentId, enabled, () => readAccount() === account && application.displayContinuity.getScope() === display);
    } catch { setFailed(true); }
    finally { setSaving(false); }
  };
  return { enabled, setEnabled, saving, failed };
}

export type AgentAvailabilityController = ReturnType<typeof useAgentAvailability>;
