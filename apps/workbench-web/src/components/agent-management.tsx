import { useAppServerHosts, useAppServerHostSnapshot, useComposerCatalog } from "../runtime/appserver-runtime-context";
import { useAgentAvailability } from "../runtime/use-agent-availability";
import { AgentOnboarding, type AgentOnboardingProps } from "./agent-onboarding";

export function HostAgentOnboarding(props: Pick<AgentOnboardingProps, "presentation" | "onFinish" | "onClose" | "onUseModels">) {
  const { hostId } = useAppServerHostSnapshot();
  const hosts = useAppServerHosts();
  const catalog = useComposerCatalog(null);
  const availability = useAgentAvailability();
  return <AgentOnboarding hostId={hostId}
      {...props} request={(method, params) => hosts.agentRuntimes.request(hostId, method, params)}
      catalogModels={catalog.models.flatMap(model => model.agentId ? [{ agentId: model.agentId, agentLabel: model.agentLabel ?? undefined, id: model.model, name: model.displayName, isDefault: model.isDefault }] : [])}
      onRefreshModels={catalog.retryModels} catalogError={!!catalog.modelError}
      agentPreferences={{ enabled: id => availability.enabled(hostId, id), setEnabled: (id, enabled) => { void availability.setEnabled(hostId, id, enabled); }, saving: availability.saving, failed: availability.failed }} />;
}

export function AgentManagement() { return <HostAgentOnboarding presentation="settings" />; }
