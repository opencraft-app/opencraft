import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppServerHosts, useAppServerHostSnapshot, useComposerCatalog } from "../runtime/appserver-runtime-context";
import { useAgentAvailability } from "../runtime/use-agent-availability";
import { AgentOnboarding, type AgentOnboardingProps } from "./agent-onboarding";

export function HostAgentOnboarding({ targetHostId, ...props }: Pick<AgentOnboardingProps, "presentation" | "onFinish" | "onClose" | "onUseModels" | "onImported"> & { targetHostId?: string }) {
  const snapshot = useAppServerHostSnapshot();
  const hostId = targetHostId ?? snapshot.hostId;
  const hosts = useAppServerHosts();
  const query = useQueryClient();
  const readAccount = useCallback(() => hosts.threadAttention.getScope() ?? "anonymous", [hosts]);
  const account = useSyncExternalStore(hosts.threadAttention.subscribe, readAccount, readAccount);
  const display = useSyncExternalStore(hosts.displayContinuity.subscribe, hosts.displayContinuity.getScope, hosts.displayContinuity.getScope);
  const catalog = useComposerCatalog(null);
  const availability = useAgentAvailability();
  const catalogModels = hostId === snapshot.hostId
    ? catalog.models.flatMap(model => model.agentId ? [{ agentId: model.agentId, agentLabel: model.agentLabel ?? undefined, id: model.model, name: model.displayName, isDefault: model.isDefault }] : [])
    : [];
  return <AgentOnboarding hostId={hostId} identityScope={JSON.stringify([account, display])}
      {...props} onImported={async () => { await query.invalidateQueries({ queryKey: ["appserver", hostId, "threads"] }); if (readAccount() === account && hosts.displayContinuity.getScope() === display) await props.onImported?.(); }} request={(method, params) => hosts.agentRuntimes.request(hostId, method, params)}
      catalogModels={catalogModels}
      onRefreshModels={hostId === snapshot.hostId ? catalog.retryModels : undefined} catalogError={hostId === snapshot.hostId && !!catalog.modelError}
      agentPreferences={{ enabled: id => availability.enabled(hostId, id), setEnabled: (id, enabled) => { void availability.setEnabled(hostId, id, enabled); }, saving: availability.saving, failed: availability.failed }} />;
}

export function AgentManagement() { return <HostAgentOnboarding presentation="settings" />; }
export function MachineAgentManagement({ hostId }: { readonly hostId: string }) { return <HostAgentOnboarding targetHostId={hostId} presentation="settings" />; }
