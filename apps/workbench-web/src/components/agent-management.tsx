import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppServerHosts, useAppServerHostSnapshot, useComposerCatalog } from "../runtime/appserver-runtime-context";
import { useAgentAvailability } from "../runtime/use-agent-availability";
import { AgentOnboarding, type AgentOnboardingProps } from "./agent-onboarding";

export function HostAgentOnboarding(props: Pick<AgentOnboardingProps, "presentation" | "onFinish" | "onClose" | "onUseModels" | "onImported">) {
  const { hostId } = useAppServerHostSnapshot();
  const hosts = useAppServerHosts();
  const query = useQueryClient();
  const readAccount = useCallback(() => hosts.threadAttention.getScope() ?? "anonymous", [hosts]);
  const account = useSyncExternalStore(hosts.threadAttention.subscribe, readAccount, readAccount);
  const display = useSyncExternalStore(hosts.displayContinuity.subscribe, hosts.displayContinuity.getScope, hosts.displayContinuity.getScope);
  const catalog = useComposerCatalog(null);
  const availability = useAgentAvailability();
  return <AgentOnboarding hostId={hostId} identityScope={JSON.stringify([account, display])}
      {...props} onImported={async () => { await query.invalidateQueries({ queryKey: ["appserver", hostId, "threads"] }); if (readAccount() === account && hosts.displayContinuity.getScope() === display) await props.onImported?.(); }} request={(method, params) => hosts.agentRuntimes.request(hostId, method, params)}
      catalogModels={catalog.models.flatMap(model => model.agentId ? [{ agentId: model.agentId, agentLabel: model.agentLabel ?? undefined, id: model.model, name: model.displayName, isDefault: model.isDefault }] : [])}
      onRefreshModels={catalog.retryModels} catalogError={!!catalog.modelError}
      agentPreferences={{ enabled: id => availability.enabled(hostId, id), setEnabled: (id, enabled) => { void availability.setEnabled(hostId, id, enabled); }, saving: availability.saving, failed: availability.failed }} />;
}

export function AgentManagement() { return <HostAgentOnboarding presentation="settings" />; }
