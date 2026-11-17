import { MachineAgentManagement } from "./agent-management";
import { createContext, useContext, useEffect, useState } from "react";
import { ArrowLeftIcon as ArrowLeft, CloudIcon as Cloud, LaptopIcon as Laptop, ServerIcon as Server } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsButton, SettingsGroup, SettingsListItem, SettingsPageHeader, SettingsRow, SettingsSection } from "@opencraft/extension-react";
import type { SettingsPageContribution } from "@opencraft/extension-contract";
import type { WorkInMachine } from "@opencraft/workbench-runtime";
import { machineName, machineRole } from "../runtime/work-in-presentation";
import { useAppServerHosts, useHostConnectionPhase, useMachineConnectionPhase } from "../runtime/appserver-runtime-context";
import { ConnectionLabel, ConnectionStatus, TargetConnectionStatus } from "./target-connection-status";
import { executionEndpoint } from "./execution-endpoint";
import { machineSettingsSection } from "../runtime/settings-machine-route";

export const MachineConnectionsAvailable = createContext(true);

const resourceMessages = {
  creating: { id: "settings.machines.resource.creating", defaultMessage: "Creating resource" },
  active: { id: "settings.machines.resource.active", defaultMessage: "Resource active" },
  suspending: { id: "settings.machines.resource.suspending", defaultMessage: "Suspending" },
  suspended: { id: "settings.machines.resource.suspended", defaultMessage: "Suspended" },
  resuming: { id: "settings.machines.resource.resuming", defaultMessage: "Resuming" },
  removing: { id: "settings.machines.resource.removing", defaultMessage: "Removing resource" },
  destroyed: { id: "settings.machines.resource.destroyed", defaultMessage: "Resource removed" },
  failed: { id: "settings.machines.resource.failed", defaultMessage: "Resource failed" },
  unknown: { id: "settings.machines.resource.unknown", defaultMessage: "Unknown resource state" },
};

function MachineIcon({ machine, platform }: { machine: WorkInMachine; platform: "web" | "electron" }) {
  const role = machineRole(machine, platform);
  const Icon = role === "local" ? Laptop : role === "cloud" ? Cloud : Server;
  return <Icon size={20} aria-hidden="true" />;
}

function MachineMetadata({ machine, platform }: { machine: WorkInMachine; platform: "web" | "electron" }) {
  const intl = useIntl();
  const role = machineRole(machine, platform);
  const system = machine.identity?.platform;
  return <>{system === "macos" ? "macOS" : system === "linux" ? "Linux" : system === "windows" ? "Windows" : intl.formatMessage({ id: "workIn.unknownSystem", defaultMessage: "Unknown system" })} · {role === "local"
    ? intl.formatMessage({ id: "settings.machines.local", defaultMessage: "Local" })
    : role === "cloud" ? intl.formatMessage({ id: "workIn.cloud", defaultMessage: "Cloud" })
    : intl.formatMessage({ id: "settings.machines.server", defaultMessage: "Server" })}{machine.resource ? <> · {intl.formatMessage(resourceMessages[machine.resource.phase])}</> : null}</>;
}

function AgentStatus({ hostIds }: { hostIds: readonly string[] }) {
  const available = useContext(MachineConnectionsAvailable);
  return available ? <ObservedAgentStatus hostIds={hostIds} /> : <ConnectionLabel phase="idle" showLabel />;
}

function ObservedAgentStatus({ hostIds }: { hostIds: readonly string[] }) {
  const phase = useMachineConnectionPhase(hostIds);
  return <ConnectionLabel phase={phase} showLabel />;
}

function HostStatus({ hostId }: { hostId: string }) {
  const available = useContext(MachineConnectionsAvailable);
  return available ? <TargetConnectionStatus hostId={hostId} showLabel /> : <ConnectionLabel phase="idle" showLabel />;
}

function MachineAgents({ hostId }: { hostId: string }) {
  const intl = useIntl();
  const phase = useHostConnectionPhase(hostId);
  const [opened, setOpened] = useState(phase === "ready");
  useEffect(() => { if (phase === "ready") setOpened(true); }, [phase]);
  return opened || phase === "ready" ? <MachineAgentManagement hostId={hostId} />
    : <SettingsSection title={intl.formatMessage({ id: "settings.machines.agents", defaultMessage: "Agent" })}
        description={intl.formatMessage({ id: "settings.machines.agentsAfterConnection", defaultMessage: "Connect to load the agents on this machine." })} />;
}

/** Opening a machine is explicit demand; the shared runtime still owns the connection. */
function MachineConnection({ hostId }: { hostId: string }) {
  const available = useContext(MachineConnectionsAvailable);
  return available ? <ObservedMachineConnection key={hostId} hostId={hostId} /> : <ConnectionLabel phase="idle" showLabel />;
}

function ObservedMachineConnection({ hostId }: { hostId: string }) {
  const intl = useIntl();
  const { agentRuntimes } = useAppServerHosts();
  const phase = useHostConnectionPhase(hostId);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<"connecting" | "ready" | "error">("connecting");
  useEffect(() => {
    let current = true;
    setResult("connecting");
    void agentRuntimes.ensureReady(hostId).then(() => {
      if (current) setResult("ready");
    }, () => {
      if (current) setResult("error");
    });
    // Do not disconnect a shared runtime or publish a late result after route exit.
    return () => { current = false; };
  }, [agentRuntimes, hostId, attempt]);
  return <>
    {phase === "ready" ? <TargetConnectionStatus hostId={hostId} showLabel />
      : result === "connecting" && phase === "idle" ? <ConnectionLabel phase="connecting" showLabel />
      : result === "error" ? <ConnectionLabel phase="error" showLabel /> : <TargetConnectionStatus hostId={hostId} showLabel />}
    {phase !== "ready" && (result === "error" || phase === "error") ? <SettingsButton variant="quiet" loading={result === "connecting"} onClick={() => setAttempt(value => value + 1)}>{intl.formatMessage({ id: "settings.machines.retryConnection", defaultMessage: "Retry connection" })}</SettingsButton> : null}
  </>;
}

function MachineStatus({ machine }: { machine: WorkInMachine }) {
  const available = useContext(MachineConnectionsAvailable);
  // Enrollment control presence is independent of this browser's lazy Host session.
  const presence = machine.hosts.map(host => host.machinePresence);
  if (presence.includes("online")) return <MachinePhaseStatus phase="ready" />;
  if (presence.length > 0 && presence.every(value => value === "offline")) return <MachinePhaseStatus phase="offline" />;
  return available ? <ObservedMachineStatus machine={machine} /> : <MachinePhaseStatus phase="idle" />;
}

function ObservedMachineStatus({ machine }: { machine: WorkInMachine }) {
  const phase = useMachineConnectionPhase(machine.hosts.map(host => host.hostId));
  return <MachinePhaseStatus phase={phase} />;
}

function MachinePhaseStatus({ phase }: { phase: string }) {
  const intl = useIntl();
  const label = intl.formatMessage(phase === "ready"
    ? { id: "workIn.online", defaultMessage: "Online" }
    : phase === "idle" ? { id: "settings.connection.notConnected", defaultMessage: "Not connected" }
    : { id: "workIn.offline", defaultMessage: "Offline" });
  return <span className="environment-connection-label"><ConnectionStatus phase={phase === "offline" ? "idle" : phase} label={label} /><span>{label}</span></span>;
}

export function SettingsMachineIdentity({ machine, platform, onSectionChange, detail = false }: {
  machine: WorkInMachine; platform: "web" | "electron"; onSectionChange: (section: string) => void; detail?: boolean;
}) {
  const intl = useIntl();
  return <header className="settings-machine-identity">
    {!detail ? <span className="settings-machine-usage">{intl.formatMessage({ id: "settings.machines.usedFor", defaultMessage: "Used for" })}<span className="settings-machine-usage__tag">{machineName(machine, platform, intl)}</span></span> : null}
    <SettingsButton variant="quiet" onClick={() => onSectionChange(detail ? "machines" : machineSettingsSection(machine))}>
      <ArrowLeft size={14} />{detail ? intl.formatMessage({ id: "settings.machines.title", defaultMessage: "Machines" }) : machineName(machine, platform, intl)}
    </SettingsButton>
    {detail ? <div className="settings-machine-identity__subject">
      <span className="settings-machine-identity__icon"><MachineIcon machine={machine} platform={platform} /></span>
      <div><h1>{machineName(machine, platform, intl)}</h1><div className="settings-machine-metadata"><MachineMetadata machine={machine} platform={platform} /></div></div>
      <MachineStatus machine={machine} />
    </div> : null}
  </header>;
}

export function SettingsMachines({ machines, platform, onSectionChange }: {
  machines: readonly WorkInMachine[]; platform: "web" | "electron"; onSectionChange: (section: string) => void;
}) {
  const intl = useIntl();
  return <>
    <SettingsPageHeader title={intl.formatMessage({ id: "settings.machines.title", defaultMessage: "Machines" })} />
    {[false, true].map(cloud => {
      const group = machines.filter(machine => machine.cloud === cloud);
      const rows = <SettingsGroup>{group.map(machine => <SettingsListItem key={machine.id}
          icon={<MachineIcon machine={machine} platform={platform} />}
          label={machineName(machine, platform, intl)}
          description={<MachineMetadata machine={machine} platform={platform} />}
          metadata={<MachineStatus machine={machine} />}
          actions={<SettingsButton variant="quiet" onClick={() => onSectionChange(machineSettingsSection(machine))}>{intl.formatMessage({ id: "settings.machines.open", defaultMessage: "Open" })}</SettingsButton>} />)}</SettingsGroup>;
      return group.length ? cloud
        ? <SettingsSection key="cloud" title={intl.formatMessage({ id: "workIn.cloud", defaultMessage: "Cloud" })}>{rows}</SettingsSection>
        : <div key="machines">{rows}</div>
        : null;
    })}
    {machines.length === 0 ? <SettingsSection title={intl.formatMessage({ id: "settings.machines.empty", defaultMessage: "No machines" })} /> : null}
  </>;
}

export function SettingsMachine({ machine, pages, platform, onSectionChange }: {
  machine: WorkInMachine; pages: readonly SettingsPageContribution[]; platform: "web" | "electron"; onSectionChange: (section: string) => void;
}) {
  const intl = useIntl();
  const available = useContext(MachineConnectionsAvailable);
  const managedHost = machine.hosts.find(host => host.machinePresence !== undefined);
  // Agent identity is reported by the Host. Unknown Agents retain their Host name.
  const priority = (agent: string) => agent === "OpenCraft" ? 0 : agent === "Codex" ? 1 : 2;
  const agents = [...new Set(machine.hosts.map(host => host.agent ?? `host:${host.hostId}`))].sort((a, b) => priority(a) - priority(b));
  const connections = [...machine.hosts].sort((a, b) => priority(a.agent ?? "") - priority(b.agent ?? ""));
  return <>
    <SettingsMachineIdentity machine={machine} platform={platform} onSectionChange={onSectionChange} detail />
    {available && managedHost ? <MachineAgents key={managedHost.hostId} hostId={managedHost.hostId} /> : <SettingsSection title={intl.formatMessage({ id: "settings.machines.agents", defaultMessage: "Agent" })}><SettingsGroup>{agents.map(agent => {
      const hosts = machine.hosts.filter(host => (host.agent ?? `host:${host.hostId}`) === agent);
      const agentPages = pages.filter(page => hosts.some(host => host.hostId === page.targetHostId));
      return <SettingsRow key={agent} label={hosts[0]!.agent ?? hosts[0]!.displayName}>
        <div className="settings-machine-agent-actions">
          <AgentStatus hostIds={hosts.map(host => host.hostId)} />
          {agentPages.map(page => <SettingsButton key={page.id} variant="quiet" onClick={() => onSectionChange(page.id)}>{page.title}</SettingsButton>)}
        </div>
      </SettingsRow>;
    })}</SettingsGroup></SettingsSection>}
    <SettingsSection title={intl.formatMessage({ id: "settings.machines.connections", defaultMessage: "Connections" })}>
      <SettingsGroup>{connections.map(host => <SettingsRow key={host.hostId} label={host.agent ?? host.displayName}>
        <div className="settings-machine-connection">{host.machinePresence !== undefined
          ? <span className="settings-execution-endpoint">{intl.formatMessage({ id: "settings.machines.viaServer", defaultMessage: "Via current Server" })}</span>
          : <span className="settings-execution-endpoint" title={executionEndpoint(host, window.location.href)}>{executionEndpoint(host, window.location.href)}</span>}{host.machinePresence !== undefined ? <MachineConnection hostId={host.hostId} /> : <HostStatus hostId={host.hostId} />}</div>
      </SettingsRow>)}</SettingsGroup>
    </SettingsSection>
  </>;
}
