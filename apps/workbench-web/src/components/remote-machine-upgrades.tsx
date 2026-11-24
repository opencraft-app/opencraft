import { useState, useSyncExternalStore } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIntl } from "@opencraft/i18n/react";
import { Button } from "@opencraft/design-system-web/button";
import { DownloadIcon, ServerIcon } from "@opencraft/design-system-web/action-icons";
import type { OnboardingAgentSnapshot } from "@opencraft/appserver-protocol";
import { useAppServerHosts } from "../runtime/appserver-runtime-context";
import { useAsyncNotices } from "./async-notices";
import { AgentIdentityIcon } from "./agent-directory";
import "./remote-machine-upgrades.scss";

export function extractAgentSemver(versionText: string | null | undefined): [number, number, number] | null {
  if (!versionText) return null;
  const match = /(\d+)\.(\d+)\.(\d+)(?![0-9.])/u.exec(versionText);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function formatAgentVersionShort(versionText: string | null | undefined): string | null {
  const tuple = extractAgentSemver(versionText);
  if (tuple) return `v${tuple.join(".")}`;
  return versionText?.trim() || null;
}

export function isNewerSemver(latest: string | null | undefined, installed: string | null | undefined): boolean {
  const latestTuple = extractAgentSemver(latest);
  const installedTuple = extractAgentSemver(installed);
  if (!latestTuple || !installedTuple) return false;
  for (let i = 0; i < 3; i++) {
    if (latestTuple[i]! !== installedTuple[i]!) return latestTuple[i]! > installedTuple[i]!;
  }
  return false;
}

export function RemoteMachineUpgrades({ activeHostId }: { readonly activeHostId: string }) {
  const intl = useIntl();
  const notices = useAsyncNotices();
  const queryClient = useQueryClient();
  const { personalMachines, agentRuntimes, threadAttention, hosts } = useAppServerHosts();
  const scope = useSyncExternalStore(threadAttention.subscribe, () => threadAttention.getScope() ?? "anonymous");
  const [pendingMachineIds, setPendingMachineIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingAgentKeys, setPendingAgentKeys] = useState<ReadonlySet<string>>(new Set());

  const localHostId = hosts.find(host => host.kind === "local")?.hostId ?? hosts[0]?.hostId ?? null;

  const directoryQuery = useQuery({
    queryKey: ["personal-machines-upgrades", scope],
    enabled: personalMachines !== null,
    queryFn: () => personalMachines!.request({ action: "list" }),
    retry: false,
    staleTime: 5000,
    refetchInterval: query => {
      const machines = query.state.data?.machines ?? [];
      return machines.some(machine => machine.updating) ? 2500 : 12_000;
    },
    refetchOnWindowFocus: false,
  });

  const allOnlineMachines = (directoryQuery.data?.machines ?? []).filter(
    machine => machine.phase === "enrolled" && (machine.connected || machine.updating),
  );
  const activePersonalId = activeHostId.startsWith("personal:") ? activeHostId.slice("personal:".length) : null;
  const targetMachines = activePersonalId
    ? allOnlineMachines.filter(machine => machine.id === activePersonalId)
    : allOnlineMachines;

  const packageVersionsQuery = useQuery({
    queryKey: ["agent-package-versions", localHostId],
    enabled: localHostId !== null && targetMachines.some(machine => machine.connected),
    queryFn: () => agentRuntimes.request(localHostId!, "opencraft/agents/onboarding/package-versions", {}),
    retry: false,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

  const remoteAgentQueries = useQueries({
    queries: targetMachines.map(machine => {
      const remoteHostId = `personal:${machine.id}`;
      const hasProfile = hosts.some(host => host.hostId === remoteHostId);
      return {
        queryKey: ["remote-machine-agents", scope, machine.id],
        enabled: machine.connected && hasProfile,
        queryFn: () => agentRuntimes.request(remoteHostId, "opencraft/agents/onboarding/status", {}),
        retry: false,
        staleTime: 30_000,
        refetchInterval: (query: { state: { data?: { agents?: readonly OnboardingAgentSnapshot[] } } }) =>
          query.state.data?.agents?.some(agent => agent.activity?.phase === "running") ? 2500 : 60_000,
        refetchOnWindowFocus: false,
      };
    }),
  });

  const latestVersions = packageVersionsQuery.data?.versions ?? {};

  const upgradeMachine = async (machineId: string, machineName: string) => {
    if (!personalMachines || pendingMachineIds.has(machineId)) return;
    setPendingMachineIds(prev => new Set(prev).add(machineId));
    try {
      const updated = await personalMachines.request({ action: "update", id: machineId });
      queryClient.setQueryData(["personal-machines-upgrades", scope], updated);
      notices.info({
        key: `remote-machine-update:${machineId}`,
        message: intl.formatMessage(
          { id: "remoteUpgrade.companionStarted", defaultMessage: "Updating OpenCraft on {machine}…" },
          { machine: machineName },
        ),
      });
    } catch {
      notices.error({
        key: `remote-machine-update:${machineId}`,
        message: intl.formatMessage(
          { id: "remoteUpgrade.companionFailed", defaultMessage: "Could not update OpenCraft on {machine}." },
          { machine: machineName },
        ),
      });
    } finally {
      setPendingMachineIds(prev => {
        const next = new Set(prev);
        next.delete(machineId);
        return next;
      });
    }
  };

  const upgradeMachineAgents = async (machineId: string, machineName: string, agents: readonly OnboardingAgentSnapshot[]) => {
    const key = `agents:${machineId}`;
    if (pendingAgentKeys.has(key) || agents.length === 0) return;
    setPendingAgentKeys(prev => new Set(prev).add(key));
    const remoteHostId = `personal:${machineId}`;
    let failed = false;
    let latestSnapshot;
    try {
      for (const agent of agents) {
        try {
          try {
            latestSnapshot = await agentRuntimes.request(remoteHostId, "opencraft/agents/onboarding/act", {
              id: agent.id,
              action: "upgrade",
            });
          } catch {
            latestSnapshot = await agentRuntimes.request(remoteHostId, "opencraft/agents/onboarding/act", {
              id: agent.id,
              action: "install",
            });
          }
        } catch {
          failed = true;
        }
      }
      if (latestSnapshot) {
        queryClient.setQueryData(["remote-machine-agents", scope, machineId], latestSnapshot);
      } else {
        await queryClient.invalidateQueries({ queryKey: ["remote-machine-agents", scope, machineId] });
      }
      if (failed) {
        notices.error({
          key: `remote-agent-update:${machineId}`,
          message: intl.formatMessage(
            { id: "remoteUpgrade.agentsFailed", defaultMessage: "Could not update agents on {machine}." },
            { machine: machineName },
          ),
        });
      } else {
        notices.info({
          key: `remote-agent-update:${machineId}`,
          message: intl.formatMessage(
            { id: "remoteUpgrade.agentsStarted", defaultMessage: "Updating {agents} on {machine}…" },
            { agents: agents.map(agent => agent.displayName ?? agent.id).join(", "), machine: machineName },
          ),
        });
      }
    } finally {
      setPendingAgentKeys(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const machineEntries = targetMachines.flatMap((machine, index) => {
    const machineName = machine.name || machine.id.slice(0, 8);
    const companionUpdating = Boolean(machine.updating || pendingMachineIds.has(machine.id));
    const showCompanionPill = Boolean(machine.updateAvailable || companionUpdating);

    const agentSnapshot = remoteAgentQueries[index]?.data;
    const upgradableAgents = (agentSnapshot?.agents ?? []).filter(agent => {
      if (!agent.installed || !agent.canInstallPackage) return false;
      const upgrading = agent.activity?.phase === "running" && (agent.activity.kind === "install" || agent.activity.kind === "upgrade");
      if (upgrading) return true;
      return isNewerSemver(latestVersions[agent.id], agent.version);
    });

    if (!showCompanionPill && upgradableAgents.length === 0) return [];
    return [{ machine, machineName, companionUpdating, showCompanionPill, upgradableAgents }];
  });

  if (machineEntries.length === 0) return null;

  const showMachineTag = machineEntries.length > 1;

  return (
    <div
      className="remote-machine-upgrades"
      role="group"
      aria-label={intl.formatMessage({ id: "remoteUpgrade.groupLabel", defaultMessage: "Remote upgrades" })}
    >
      {machineEntries.map(({ machine, machineName, companionUpdating, showCompanionPill, upgradableAgents }) => {
        const companionTooltip = intl.formatMessage(
          companionUpdating
            ? { id: "remoteUpgrade.companionBusyLabel", defaultMessage: "Updating OpenCraft on {machine}…" }
            : { id: "remoteUpgrade.companionLabel", defaultMessage: "Update OpenCraft on {machine}" },
          { machine: machineName },
        );
        const agentsUpdating = pendingAgentKeys.has(`agents:${machine.id}`)
          || upgradableAgents.some(agent => agent.activity?.phase === "running" && (agent.activity.kind === "install" || agent.activity.kind === "upgrade"));
        const agentSummary = upgradableAgents
          .map(agent => {
            const name = agent.displayName ?? agent.id;
            const currentVer = formatAgentVersionShort(agent.version);
            const nextVer = latestVersions[agent.id];
            if (currentVer && nextVer) return `${name} (${currentVer} → v${nextVer})`;
            if (nextVer) return `${name} (v${nextVer})`;
            return name;
          })
          .join(", ");
        const agentsTooltip = intl.formatMessage(
          agentsUpdating
            ? { id: "remoteUpgrade.agentsBusyLabel", defaultMessage: "Updating {agents} on {machine}…" }
            : { id: "remoteUpgrade.agentsLabel", defaultMessage: "Update {agents} on {machine}" },
          { agents: agentSummary, machine: machineName },
        );

        return (
          <div key={machine.id} className="remote-machine-upgrades__strip" data-machine-id={machine.id}>
            {showMachineTag ? (
              <span className="remote-machine-upgrades__machine-tag" title={machineName}>
                <ServerIcon size={12} aria-hidden="true" />
                <span>{machineName}</span>
              </span>
            ) : null}
            <div className="remote-machine-upgrades__pills">
              {showCompanionPill ? (
                <Button
                  variant="outline"
                  size="sm"
                  density="compact"
                  contentLayout="row"
                  loading={companionUpdating}
                  disabled={!machine.connected}
                  aria-label={companionTooltip}
                  title={companionTooltip}
                  data-remote-upgrade="companion"
                  data-machine-id={machine.id}
                  onClick={() => { void upgradeMachine(machine.id, machineName); }}
                >
                  {companionUpdating ? null : <DownloadIcon size={13} aria-hidden="true" />}
                  <span>{intl.formatMessage({ id: "mobile.brand", defaultMessage: "OpenCraft" })}</span>
                </Button>
              ) : null}
              {upgradableAgents.length > 0 ? (
                <Button
                  variant="outline"
                  size="sm"
                  density="compact"
                  contentLayout="row"
                  loading={agentsUpdating}
                  disabled={!machine.connected}
                  aria-label={agentsTooltip}
                  title={agentsTooltip}
                  data-remote-upgrade="agents"
                  data-machine-id={machine.id}
                  onClick={() => { void upgradeMachineAgents(machine.id, machineName, upgradableAgents); }}
                >
                  {agentsUpdating ? null : <DownloadIcon size={13} aria-hidden="true" />}
                  <span className="remote-machine-upgrades__agent-icons">
                    {upgradableAgents.map(agent => (
                      <AgentIdentityIcon key={agent.id} id={agent.engineId ?? agent.id} size={14} />
                    ))}
                  </span>
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
