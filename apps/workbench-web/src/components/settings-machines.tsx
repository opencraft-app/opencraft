import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowLeftIcon as ArrowLeft, CloudIcon as Cloud, LaptopIcon as Laptop, ServerIcon as Server } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import {
  SettingsActions,
  SettingsButton,
  SettingsGroup,
  SettingsListItem,
  SettingsNotice,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "@opencraft/extension-react";
import type { SettingsPageContribution } from "@opencraft/extension-contract";
import type { PersonalMachine, PersonalMachinesDirectory } from "@opencraft/appserver-protocol";
import type { WorkInMachine } from "@opencraft/workbench-runtime";
import { machineName, machineRole } from "../runtime/work-in-presentation";
import { useHostConnectionPhase, useMachineConnectionPhase } from "../runtime/appserver-runtime-context";
import type { PersonalMachinesController } from "../runtime/personal-machine-environment-source";
import type { OperationNotice } from "./notice-history";
import { ConnectionLabel, ConnectionStatus, TargetConnectionStatus } from "./target-connection-status";
import { executionEndpoint } from "./execution-endpoint";
import { machineSettingsSection } from "../runtime/settings-machine-route";

export const MachineConnectionsAvailable = createContext(true);

const EMPTY_SUBSCRIBE = () => () => {};
const NULL_DIRECTORY = () => null;

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

function personalMachineIdFor(machine: WorkInMachine): string | null {
  for (const host of machine.hosts) {
    if (host.hostId.startsWith("personal:")) {
      return host.hostId.slice("personal:".length);
    }
  }
  return null;
}

function findPersonalMachineEntry(
  directory: PersonalMachinesDirectory | null,
  machine: WorkInMachine,
): PersonalMachine | null {
  if (!directory) return null;
  const id = personalMachineIdFor(machine);
  if (id) return directory.machines.find((item) => item.id === id) ?? null;
  if (machine.identity) {
    return directory.machines.find((item) => item.machine?.machineId === machine.identity?.machineId) ?? null;
  }
  return null;
}

function usePersonalMachinesDirectory(controller?: PersonalMachinesController | null): PersonalMachinesDirectory | null {
  return useSyncExternalStore(
    controller ? controller.subscribe : EMPTY_SUBSCRIBE,
    controller ? controller.getDirectorySnapshot : NULL_DIRECTORY,
    controller ? controller.getDirectorySnapshot : NULL_DIRECTORY,
  );
}

function MachineIcon({ machine, platform }: { machine: WorkInMachine; platform: "web" | "electron" }) {
  const role = machineRole(machine, platform);
  const Icon = role === "local" ? Laptop : role === "cloud" ? Cloud : Server;
  return <Icon size={20} aria-hidden="true" />;
}

function MachineMetadata({
  machine,
  platform,
  personalEntry = null,
}: {
  machine: WorkInMachine;
  platform: "web" | "electron";
  personalEntry?: PersonalMachine | null;
}) {
  const intl = useIntl();
  const role = machineRole(machine, platform);
  const system = machine.identity?.platform;
  const updateState = personalEntry?.updating
    ? intl.formatMessage({ id: "settings.machines.personal.updating", defaultMessage: "Updating…" })
    : personalEntry?.connected && personalEntry.updateAvailable
      ? intl.formatMessage({ id: "settings.machines.personal.updateAvailable", defaultMessage: "Update available" })
      : null;
  return (
    <>
      {system === "macos"
        ? "macOS"
        : system === "linux"
          ? "Linux"
          : system === "windows"
            ? "Windows"
            : intl.formatMessage({ id: "workIn.unknownSystem", defaultMessage: "Unknown system" })}{" "}
      ·{" "}
      {role === "local"
        ? intl.formatMessage({ id: "settings.machines.local", defaultMessage: "Local" })
        : role === "cloud"
          ? intl.formatMessage({ id: "workIn.cloud", defaultMessage: "Cloud" })
          : intl.formatMessage({ id: "settings.machines.server", defaultMessage: "Server" })}
      {machine.resource ? <> · {intl.formatMessage(resourceMessages[machine.resource.phase])}</> : null}
      {updateState ? <> · {updateState}</> : null}
    </>
  );
}

function AgentStatus({ hostIds }: { hostIds: readonly string[] }) {
  const available = useContext(MachineConnectionsAvailable);
  return available ? <ObservedAgentStatus hostIds={hostIds} /> : <ConnectionLabel phase="idle" showLabel />;
}

function ObservedAgentStatus({ hostIds }: { hostIds: readonly string[] }) {
  const phase = useMachineConnectionPhase(hostIds);
  return <ConnectionLabel phase={phase} showLabel />;
}

function HostStatus({
  hostId,
  onRetry,
}: {
  hostId: string;
  onRetry?: (hostId: string) => Promise<void>;
}) {
  const available = useContext(MachineConnectionsAvailable);
  return available ? <ObservedHostStatus hostId={hostId} onRetry={onRetry} /> : <ConnectionLabel phase="idle" showLabel />;
}

function ObservedHostStatus({
  hostId,
  onRetry,
}: {
  hostId: string;
  onRetry?: (hostId: string) => Promise<void>;
}) {
  const intl = useIntl();
  const phase = useHostConnectionPhase(hostId);
  const [retrying, setRetrying] = useState(false);
  return (
    <>
      <TargetConnectionStatus hostId={hostId} showLabel />
      {phase === "error" && onRetry ? (
        <SettingsButton
          variant="quiet"
          loading={retrying}
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void onRetry(hostId).finally(() => setRetrying(false));
          }}
        >
          {intl.formatMessage({ id: "settings.machines.retryConnection", defaultMessage: "Retry connection" })}
        </SettingsButton>
      ) : null}
    </>
  );
}

function MachineStatus({ machine }: { machine: WorkInMachine }) {
  const available = useContext(MachineConnectionsAvailable);
  const presence = machine.hosts.map((host) => host.machinePresence).filter((value) => value !== undefined);
  if (presence.includes("online")) return <MachinePhaseStatus phase="ready" />;
  if (presence.length > 0 && presence.length === machine.hosts.length && presence.every((value) => value === "offline")) {
    return <MachinePhaseStatus phase="offline" />;
  }
  return available ? <ObservedMachineStatus machine={machine} /> : <MachinePhaseStatus phase="idle" />;
}

function ObservedMachineStatus({ machine }: { machine: WorkInMachine }) {
  const phase = useMachineConnectionPhase(machine.hosts.map((host) => host.hostId));
  return <MachinePhaseStatus phase={phase} />;
}

function MachinePhaseStatus({ phase }: { phase: string }) {
  const intl = useIntl();
  const label = intl.formatMessage(
    phase === "ready"
      ? { id: "workIn.online", defaultMessage: "Online" }
      : phase === "idle"
        ? { id: "settings.connection.notStarted", defaultMessage: "Not started" }
        : { id: "workIn.offline", defaultMessage: "Offline" },
  );
  return (
    <span className="environment-connection-label">
      <ConnectionStatus phase={phase === "offline" ? "idle" : phase} />
      <span>{label}</span>
    </span>
  );
}

export function SettingsMachineIdentity({
  machine,
  platform,
  onSectionChange,
  detail = false,
  personalEntry = null,
}: {
  machine: WorkInMachine;
  platform: "web" | "electron";
  onSectionChange: (section: string) => void;
  detail?: boolean;
  personalEntry?: PersonalMachine | null;
}) {
  const intl = useIntl();
  return (
    <header className="settings-machine-identity">
      {!detail ? (
        <span className="settings-machine-usage">
          {intl.formatMessage({ id: "settings.machines.usedFor", defaultMessage: "Used for" })}
          <span className="settings-machine-usage__tag">{machineName(machine, platform, intl)}</span>
        </span>
      ) : null}
      <SettingsButton variant="quiet" onClick={() => onSectionChange(detail ? "machines" : machineSettingsSection(machine))}>
        <ArrowLeft size={14} />
        {detail ? intl.formatMessage({ id: "settings.machines.title", defaultMessage: "Machines" }) : machineName(machine, platform, intl)}
      </SettingsButton>
      {detail ? (
        <div className="settings-machine-identity__subject">
          <span className="settings-machine-identity__icon">
            <MachineIcon machine={machine} platform={platform} />
          </span>
          <div>
            <h1>{machineName(machine, platform, intl)}</h1>
            <div className="settings-machine-metadata">
              <MachineMetadata machine={machine} platform={platform} personalEntry={personalEntry} />
            </div>
          </div>
          <MachineStatus machine={machine} />
        </div>
      ) : null}
    </header>
  );
}

export function SettingsMachines({
  machines,
  platform,
  onSectionChange,
  personalMachines = null,
  reportError,
}: {
  machines: readonly WorkInMachine[];
  platform: "web" | "electron";
  onSectionChange: (section: string) => void;
  personalMachines?: PersonalMachinesController | null;
  reportError?: (notice: OperationNotice) => void;
}) {
  const intl = useIntl();
  const directory = usePersonalMachinesDirectory(personalMachines);
  const [command, setCommand] = useState("");
  const [copied, setCopied] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const runAction = async (key: string, operation: () => Promise<void>) => {
    if (busyKey !== null) return;
    setBusyKey(key);
    try {
      await operation();
    } catch {
      reportError?.({
        key: `personal-machines:${key}`,
        message: intl.formatMessage({ id: "loginAdmission.error.generic", defaultMessage: "Couldn't complete the request. Try again." }),
      });
    } finally {
      setBusyKey(null);
    }
  };

  const pendingMachines = directory?.machines.filter((item) => item.phase === "pending") ?? [];

  return (
    <>
      <SettingsPageHeader title={intl.formatMessage({ id: "settings.machines.title", defaultMessage: "Machines" })} />
      {[false, true].map((cloud) => {
        const group = machines.filter((machine) => machine.cloud === cloud);
        const rows = (
          <SettingsGroup>
            {group.map((machine) => {
              const entry = findPersonalMachineEntry(directory, machine);
              return (
                <SettingsListItem
                  key={machine.id}
                  icon={<MachineIcon machine={machine} platform={platform} />}
                  label={machineName(machine, platform, intl)}
                  description={<MachineMetadata machine={machine} platform={platform} personalEntry={entry} />}
                  metadata={<MachineStatus machine={machine} />}
                  actions={
                    <>
                      {personalMachines && entry?.connected && (entry.updateAvailable || entry.updating) ? (
                        <SettingsButton
                          variant="secondary"
                          loading={Boolean(entry.updating) || busyKey === `update:${entry.id}`}
                          disabled={busyKey !== null || Boolean(entry.updating)}
                          onClick={() =>
                            void runAction(`update:${entry.id}`, async () => {
                              await personalMachines.command({ action: "update", id: entry.id });
                            })
                          }
                        >
                          {intl.formatMessage({ id: "settings.machines.personal.updateNow", defaultMessage: "Update" })}
                        </SettingsButton>
                      ) : null}
                      <SettingsButton variant="quiet" onClick={() => onSectionChange(machineSettingsSection(machine))}>
                        {intl.formatMessage({ id: "settings.machines.open", defaultMessage: "Open" })}
                      </SettingsButton>
                    </>
                  }
                />
              );
            })}
          </SettingsGroup>
        );
        return group.length ? (
          cloud ? (
            <SettingsSection key="cloud" title={intl.formatMessage({ id: "workIn.cloud", defaultMessage: "Cloud" })}>
              {rows}
            </SettingsSection>
          ) : (
            <div key="machines">{rows}</div>
          )
        ) : null;
      })}
      {machines.length === 0 && pendingMachines.length === 0 ? (
        <SettingsSection title={intl.formatMessage({ id: "settings.machines.empty", defaultMessage: "No machines" })} />
      ) : null}
      {personalMachines && directory ? (
        <SettingsSection
          title={intl.formatMessage({ id: "settings.machines.personal.sectionTitle", defaultMessage: "Personal machines" })}
          description={intl.formatMessage({
            id: "settings.machines.personal.sectionDescription",
            defaultMessage: "Connect your own Mac or Linux machines over a reverse relay without opening inbound ports.",
          })}
          action={
            directory.enrollmentOrigin ? (
              <SettingsButton
                variant="secondary"
                loading={busyKey === "create"}
                disabled={busyKey !== null}
                onClick={() =>
                  void runAction("create", async () => {
                    const result = await personalMachines.command({ action: "create" });
                    setCommand(result.command ?? "");
                    setCopied(false);
                  })
                }
              >
                {intl.formatMessage({ id: "settings.machines.personal.add", defaultMessage: "Add machine" })}
              </SettingsButton>
            ) : undefined
          }
        >
          {!directory.enrollmentOrigin ? (
            <SettingsNotice>
              {intl.formatMessage({
                id: "settings.machines.personal.noEntrance",
                defaultMessage: "Remote enrollment entrance is not configured on this server yet.",
              })}
            </SettingsNotice>
          ) : null}
          {command ? (
            <SettingsGroup>
              <SettingsRow
                layout="stacked"
                controlWidth="wide"
                label={intl.formatMessage({ id: "settings.machines.personal.add", defaultMessage: "Add machine" })}
                description={intl.formatMessage({
                  id: "settings.machines.personal.commandHint",
                  defaultMessage: "Run this private command on the remote machine within 15 minutes. Do not share it.",
                })}
              >
                <pre className="settings-laboratory-code">
                  <code>{command}</code>
                </pre>
                <SettingsActions align="start">
                  <SettingsButton
                    variant="secondary"
                    disabled={busyKey !== null}
                    onClick={() =>
                      void runAction("copy", async () => {
                        await navigator.clipboard.writeText(command);
                        setCopied(true);
                      })
                    }
                  >
                    {intl.formatMessage(
                      copied
                        ? { id: "settings.machines.personal.copied", defaultMessage: "Copied" }
                        : { id: "settings.machines.personal.copy", defaultMessage: "Copy command" },
                    )}
                  </SettingsButton>
                </SettingsActions>
              </SettingsRow>
            </SettingsGroup>
          ) : null}
          {pendingMachines.length > 0 ? (
            <SettingsGroup>
              {pendingMachines.map((pending) => (
                <SettingsListItem
                  key={pending.id}
                  icon={<Server size={20} aria-hidden="true" />}
                  label={
                    pending.name
                    || intl.formatMessage({ id: "settings.machines.personal.pending", defaultMessage: "Waiting for connection" })
                  }
                  description={intl.formatMessage({
                    id: "settings.machines.personal.pending",
                    defaultMessage: "Waiting for connection",
                  })}
                  metadata={<MachinePhaseStatus phase="idle" />}
                  actions={
                    <SettingsButton
                      variant="quiet"
                      loading={busyKey === `revoke:${pending.id}`}
                      disabled={busyKey !== null}
                      onClick={() =>
                        void runAction(`revoke:${pending.id}`, async () => {
                          await personalMachines.command({ action: "revoke", id: pending.id });
                          setCommand("");
                        })
                      }
                    >
                      {intl.formatMessage({ id: "settings.machines.personal.revoke", defaultMessage: "Revoke" })}
                    </SettingsButton>
                  }
                />
              ))}
            </SettingsGroup>
          ) : null}
        </SettingsSection>
      ) : null}
    </>
  );
}

export function SettingsMachine({
  machine,
  pages,
  platform,
  onSectionChange,
  personalMachines = null,
  renderAgentManagement,
  onRetryConnection,
  reportError,
}: {
  machine: WorkInMachine;
  pages: readonly SettingsPageContribution[];
  platform: "web" | "electron";
  onSectionChange: (section: string) => void;
  personalMachines?: PersonalMachinesController | null;
  renderAgentManagement?: (hostId: string) => ReactNode;
  onRetryConnection?: (hostId: string) => Promise<void>;
  reportError?: (notice: OperationNotice) => void;
}) {
  const intl = useIntl();
  const directory = usePersonalMachinesDirectory(personalMachines);
  const personalEntry = findPersonalMachineEntry(directory, machine);
  const personalHost = machine.hosts.find((host) => host.hostId.startsWith("personal:")) ?? null;
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [copiedUpdate, setCopiedUpdate] = useState(false);

  const runAction = async (key: string, operation: () => Promise<void>) => {
    if (busyKey !== null) return;
    setBusyKey(key);
    try {
      await operation();
    } catch {
      reportError?.({
        key: `personal-machine:${machine.id}:${key}`,
        message: intl.formatMessage({ id: "loginAdmission.error.generic", defaultMessage: "Couldn't complete the request. Try again." }),
      });
    } finally {
      setBusyKey(null);
    }
  };

  // Agent identity is reported by the Host. Unknown Agents retain their Host name.
  const priority = (agent: string) => (agent === "OpenCraft" ? 0 : agent === "Codex" ? 1 : 2);
  const agents = [...new Set(machine.hosts.map((host) => host.agent ?? `host:${host.hostId}`))].sort((a, b) => priority(a) - priority(b));
  const connections = [...machine.hosts].sort((a, b) => priority(a.agent ?? "") - priority(b.agent ?? ""));

  return (
    <>
      <SettingsMachineIdentity
        machine={machine}
        platform={platform}
        onSectionChange={onSectionChange}
        detail
        personalEntry={personalEntry}
      />
      <SettingsSection title={intl.formatMessage({ id: "settings.machines.agents", defaultMessage: "Agent" })}>
        <SettingsGroup>
          {agents.map((agent) => {
            const hosts = machine.hosts.filter((host) => (host.agent ?? `host:${host.hostId}`) === agent);
            const agentPages = pages.filter((page) => hosts.some((host) => host.hostId === page.targetHostId));
            return (
              <SettingsRow key={agent} label={hosts[0]!.agent ?? hosts[0]!.displayName}>
                <div className="settings-machine-agent-actions">
                  <AgentStatus hostIds={hosts.map((host) => host.hostId)} />
                  {agentPages.map((page) => (
                    <SettingsButton key={page.id} variant="quiet" onClick={() => onSectionChange(page.id)}>
                      {page.title}
                    </SettingsButton>
                  ))}
                </div>
              </SettingsRow>
            );
          })}
        </SettingsGroup>
        {personalHost && personalEntry?.connected && renderAgentManagement ? renderAgentManagement(personalHost.hostId) : null}
      </SettingsSection>
      <SettingsSection title={intl.formatMessage({ id: "settings.machines.connections", defaultMessage: "Connections" })}>
        <SettingsGroup>
          {connections.map((host) => (
            <SettingsRow key={host.hostId} label={host.agent ?? host.displayName}>
              <div className="settings-machine-connection">
                <span className="settings-execution-endpoint" title={executionEndpoint(host, window.location.href)}>
                  {executionEndpoint(host, window.location.href)}
                </span>
                <HostStatus hostId={host.hostId} onRetry={onRetryConnection} />
              </div>
            </SettingsRow>
          ))}
        </SettingsGroup>
      </SettingsSection>
      {personalMachines && personalEntry ? (
        <SettingsSection
          title={intl.formatMessage({ id: "settings.machines.personal.accessTitle", defaultMessage: "Access" })}
          description={intl.formatMessage({
            id: "settings.machines.personal.accessDescription",
            defaultMessage: "Revoking disconnects this machine immediately and leaves its local files and conversations untouched.",
          })}
        >
          <SettingsGroup>
            {personalEntry.connected && (personalEntry.updateAvailable || personalEntry.updating || personalEntry.updateCommand) ? (
              <SettingsRow
                label={intl.formatMessage({ id: "settings.machines.personal.updateAvailable", defaultMessage: "Update available" })}
              >
                <SettingsActions>
                  {personalEntry.updateAvailable || personalEntry.updating ? (
                    <SettingsButton
                      variant="secondary"
                      loading={Boolean(personalEntry.updating) || busyKey === "update"}
                      disabled={busyKey !== null || Boolean(personalEntry.updating)}
                      onClick={() =>
                        void runAction("update", async () => {
                          await personalMachines.command({ action: "update", id: personalEntry.id });
                        })
                      }
                    >
                      {intl.formatMessage({ id: "settings.machines.personal.updateNow", defaultMessage: "Update" })}
                    </SettingsButton>
                  ) : null}
                  {personalEntry.updateCommand ? (
                    <SettingsButton
                      variant="quiet"
                      disabled={busyKey !== null}
                      onClick={() =>
                        void runAction("copy-update", async () => {
                          await navigator.clipboard.writeText(personalEntry.updateCommand!);
                          setCopiedUpdate(true);
                        })
                      }
                    >
                      {intl.formatMessage(
                        copiedUpdate
                          ? { id: "settings.machines.personal.copied", defaultMessage: "Copied" }
                          : { id: "settings.machines.personal.copyUpdate", defaultMessage: "Copy update command" },
                      )}
                    </SettingsButton>
                  ) : null}
                </SettingsActions>
              </SettingsRow>
            ) : null}
            <SettingsRow label={intl.formatMessage({ id: "settings.machines.personal.revoke", defaultMessage: "Revoke" })}>
              <SettingsButton
                variant="danger"
                loading={busyKey === "revoke"}
                disabled={busyKey !== null}
                onClick={() =>
                  void runAction("revoke", async () => {
                    await personalMachines.command({ action: "revoke", id: personalEntry.id });
                    onSectionChange("machines");
                  })
                }
              >
                {intl.formatMessage({ id: "settings.machines.personal.revoke", defaultMessage: "Revoke" })}
              </SettingsButton>
            </SettingsRow>
          </SettingsGroup>
        </SettingsSection>
      ) : null}
    </>
  );
}
