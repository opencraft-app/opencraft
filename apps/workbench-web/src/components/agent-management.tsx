import { useQuery } from "@tanstack/react-query";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsButton, SettingsGroup, SettingsNotice, SettingsRow, SettingsSection, SettingsSwitch } from "@opencraft/extension-react";
import { useAppServerHosts, useAppServerHostSnapshot, useComposerCatalog } from "../runtime/appserver-runtime-context";
import { useAgentAvailability, type AgentAvailabilityController } from "../runtime/use-agent-availability";

export function AgentManagement({ connected = true, excludedAgentIds = [], availability: sharedAvailability }: { readonly connected?: boolean; readonly excludedAgentIds?: readonly string[]; readonly availability?: AgentAvailabilityController }) {
  const intl = useIntl();
  const { hostId } = useAppServerHostSnapshot();
  const hosts = useAppServerHosts();
  const catalog = useComposerCatalog(null);
  const ownAvailability = useAgentAvailability();
  const availability = sharedAvailability ?? ownAvailability;
  const status = useQuery({
    queryKey: ["agent-onboarding", hostId], retry: false, enabled: connected,
    queryFn: () => hosts.agentRuntimes.request(hostId, "opencraft/agents/onboarding/status", {}),
  });
  const agents = new Map(catalog.models.map(model => [model.agentId ?? "host", { id: model.agentId ?? "host", label: model.agentLabel ?? hosts.hosts.find(host => host.hostId === hostId)?.label ?? hostId, description: "" }]));
  for (const id of excludedAgentIds) agents.delete(id);
  if (connected) for (const agent of status.data?.agents ?? []) {
    const id = agent.engineId ?? agent.id;
    const label = { codex: "Codex", cursor: "Cursor", claude: "Claude", codebuddy: "CodeBuddy" }[agent.id];
    const description = !agent.installed
      ? intl.formatMessage({ id: "onboard.agent.notInstalled", defaultMessage: "Not installed" })
      : agent.authenticated === true ? intl.formatMessage({ id: "onboard.agent.signedIn", defaultMessage: "Signed in" })
      : agent.authenticated === false ? intl.formatMessage({ id: "onboard.agent.signInNeeded", defaultMessage: "Installed · not signed in" })
      : intl.formatMessage({ id: "onboard.agent.unknown", defaultMessage: "Couldn't check this agent" });
    agents.set(id, { id, label, description });
  }
  return <SettingsSection title={intl.formatMessage({ id: "composer.agent.label", defaultMessage: "Agent" })}
    description={intl.formatMessage({ id: "settings.agents.description", defaultMessage: "Choose which agents appear in new chats on this device. Existing conversations keep their agent." })}>
    <SettingsGroup>{[...agents.values()].map(agent => <SettingsRow key={agent.id} label={agent.label} description={agent.description || undefined} controlWidth="compact">
      <SettingsSwitch label={agent.label} checked={availability.enabled(hostId, agent.id)} disabled={availability.saving}
        onCheckedChange={checked => { void availability.setEnabled(hostId, agent.id, checked); }} />
    </SettingsRow>)}</SettingsGroup>
    {catalog.modelError || status.isError ? <SettingsNotice>{intl.formatMessage({ id: "settings.agents.loadFailed", defaultMessage: "Some agents could not be checked. Try checking again." })}<SettingsButton onClick={() => { catalog.retryModels(); void status.refetch(); }}>{intl.formatMessage({ id: "onboard.agent.recheck", defaultMessage: "Check again" })}</SettingsButton></SettingsNotice> : null}
    {availability.failed ? <SettingsNotice tone="error">{intl.formatMessage({ id: "settings.chat.saveError", defaultMessage: "Could not save your preference. Please try again." })}</SettingsNotice> : null}
    {connected ? <SettingsButton onClick={() => window.dispatchEvent(new CustomEvent("opencraft:replay-agent-onboarding", { detail: { presentation: "sheet" } }))}>{intl.formatMessage({ id: "settings.agents.connect", defaultMessage: "Install or sign in to an agent…" })}</SettingsButton> : null}
  </SettingsSection>;
}
