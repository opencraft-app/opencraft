import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useIntl } from "@opencraft/i18n/react";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { NavigationList, NavigationGroup, NavigationItem } from "@opencraft/design-system-web/navigation";
import { AddIcon, ArrowLeftIcon, RefreshIcon, SearchIcon } from "@opencraft/design-system-web/action-icons";
import { SettingsNotice, SettingsTextInput } from "@opencraft/extension-react";
import type { OnboardingSnapshot } from "@opencraft/appserver-protocol";
import { groupWorkInMachines, workInAgentHosts, type AgentRuntimeAccess, type HostConnectionProfile } from "@opencraft/workbench-runtime";
import { useAppServerHosts } from "../runtime/appserver-runtime-context";
import { useAgentAvailability } from "../runtime/use-agent-availability";
import { readSettingsAgentDirectory, readSettingsAgentModels, type SettingsAgentDirectory } from "../runtime/settings-agent-directory";
import { machineName } from "../runtime/work-in-presentation";
import { AgentIdentityIcon, projectAgentDirectory } from "./agent-directory";
import { AgentOnboarding } from "./agent-onboarding";
import { PersonalMachineSetup } from "./personal-machine-setup";
import "./agent-configuration.scss";

const directoryKey = (scope: string, hostId: string) => ["settings-agent-directory", scope, hostId] as const;
type MachineRequest = Parameters<typeof PersonalMachineSetup>[0]["request"];
interface AgentConfigurationProps {
  readonly hostId: string;
  readonly active: boolean;
  readonly identityScope: string;
  readonly profiles: readonly HostConnectionProfile[];
  readonly platform: "web" | "electron";
  readonly access: Pick<AgentRuntimeAccess, "ensureReady" | "request">;
  readonly requestMachines?: MachineRequest;
  readonly preferences: { enabled(hostId: string, agent: string): boolean; setEnabled(hostId: string, agent: string, enabled: boolean): void; saving: boolean; failed: boolean };
  readonly onImported?: (hostId: string) => void | Promise<void>;
}

/** The platform supplies real Host transports; this browser owns only selection. */
export function AgentConfigurationBrowser({ hostId, active, identityScope, profiles, platform, access, requestMachines, preferences, onImported }: AgentConfigurationProps) {
  const intl = useIntl(), queryClient = useQueryClient();
  const [selection, setSelection] = useState<{ hostId: string; agentId: string } | null>(null);
  const [pendingHost, setPendingHost] = useState<string | null>(null);
  const [view, setView] = useState<"browse" | "remote">("browse");
  const [query, setQuery] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigation = useRef<HTMLElement>(null), back = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null), returning = useRef(false);
  const machines = useMemo(() => groupWorkInMachines(profiles.filter(profile => profile.enabled)), [profiles]);
  const sources = machines.flatMap(machine => workInAgentHosts(machine, hostId).map(profile => ({ profile,
    machine: machine.identity ? machineName(machine, platform, intl) : profile.displayName, remote: profile.hostKind !== "local" && profile.hostKind !== "durable" })));
  const directories = useQueries({ queries: sources.map(({ profile }) => ({
    queryKey: directoryKey(identityScope, profile.hostId), enabled: active && profile.machinePresence !== "offline",
    staleTime: 30_000, retry: false,
    queryFn: ({ signal }: { signal: AbortSignal }) => readSettingsAgentDirectory(access, profile.hostId, signal),
  })) });
  const modelDirectories = useQueries({ queries: sources.map(({ profile }) => ({
    queryKey: ["settings-agent-models", identityScope, profile.hostId],
    enabled: active && profile.hostId === hostId && profile.machinePresence !== "offline", staleTime: 30_000, retry: false,
    queryFn: ({ signal }: { signal: AbortSignal }) => readSettingsAgentModels(access, profile.hostId, signal),
  })) });
  const entries = sources.flatMap((source, index) => {
    const data = { native: directories[index]?.data?.native ?? null, models: modelDirectories[index]?.data ?? [] };
    return projectAgentDirectory(data.models, data.native?.agents ?? [], id => id)
      .map(agent => ({ ...source, agent, data, directory: directories[index] }));
  });
  const requested = selection ?? (() => {
    const first = entries.find(entry => entry.profile.hostId === (pendingHost ?? hostId)) ?? (pendingHost ? undefined : entries[0]);
    return first ? { hostId: first.profile.hostId, agentId: first.agent.id } : null;
  })();
  useEffect(() => {
    if (selection === null && requested !== null) { setSelection(requested); setPendingHost(null); }
  }, [selection, requested?.hostId, requested?.agentId]);
  const selected = entries.find(entry => entry.profile.hostId === requested?.hostId && entry.agent.id === requested.agentId);
  const offline = selected?.profile.machinePresence === "offline";
  const receiveStatus = useCallback((native: OnboardingSnapshot) => {
    if (!requested) return;
    queryClient.setQueryData<SettingsAgentDirectory>(directoryKey(identityScope, requested.hostId), old => old ? { ...old, native } : { native, models: [] });
  }, [identityScope, requested?.hostId, queryClient]);
  const imported = useCallback(async () => { if (requested) await onImported?.(requested.hostId); }, [requested?.hostId, onImported]);
  const remoteLabel = intl.formatMessage({ id: "settings.agents.remote", defaultMessage: "Remote" });
  const agentLabel = intl.formatMessage({ id: "composer.agent.label", defaultMessage: "Agent" });
  const title = intl.formatMessage({ id: "settings.configuration.agents", defaultMessage: "Agent configuration" });
  const choose = (next: { hostId: string; agentId: string }) => { if (busy) return; setSelection(next); setPendingHost(null); setView("browse"); setDetailOpen(true); };
  useLayoutEffect(() => {
    if (detailOpen && navigation.current && getComputedStyle(navigation.current).display === "none") back.current?.focus({ preventScroll: true });
    else if (!detailOpen && returning.current) { returning.current = false; opener.current?.focus({ preventScroll: true }); }
  }, [detailOpen, view, requested?.hostId, requested?.agentId]);
  const navigationContent = <>
    <div className="agent-configuration__search">
      <SearchIcon size={16} aria-hidden="true" />
      <SettingsTextInput value={query} aria-label={intl.formatMessage({ id: "settings.agents.search", defaultMessage: "Search agents" })}
        placeholder={intl.formatMessage({ id: "settings.agents.search", defaultMessage: "Search agents" })} onChange={event => setQuery(event.currentTarget.value)} />
      <IconButton size="accessory" variant="ghost" disabled={busy} aria-label={intl.formatMessage({ id: "personalMachines.connect", defaultMessage: "Connect remote machine" })}
        title={intl.formatMessage({ id: "personalMachines.connect", defaultMessage: "Connect remote machine" })}
        onClick={event => { opener.current = event.currentTarget; setView("remote"); setDetailOpen(true); }}><AddIcon size={16} /></IconButton>
    </div>
    <NavigationList label={title}>
      {sources.map((source, index) => {
        const rows = entries.filter(entry => entry.profile.hostId === source.profile.hostId && `${entry.agent.label} ${source.machine}`.toLocaleLowerCase(intl.locale).includes(query.trim().toLocaleLowerCase(intl.locale)));
        const directory = directories[index];
        if (!rows.length && query.trim()) return null;
        return <NavigationGroup key={source.profile.hostId} className="agent-configuration__group">
          <div className="agent-configuration__device">{source.machine}</div>
          {rows.map(entry => <NavigationItem key={entry.agent.id} disabled={busy} aria-current={view === "browse" && entry === selected ? "page" : undefined}
            onClick={event => { opener.current = event.currentTarget; choose({ hostId: source.profile.hostId, agentId: entry.agent.id }); }}>
            <AgentIdentityIcon id={entry.agent.id} /><span className="agent-configuration__name">{entry.agent.label}{entry.agent.native?.installed === false ? <small>{intl.formatMessage({ id: "onboard.agent.notInstalled", defaultMessage: "Not installed" })}</small> : null}</span>
            {source.remote ? <small className="agent-configuration__remote">{remoteLabel}</small> : null}
          </NavigationItem>)}
          {rows.length > 0 && directory?.isError ? <div className="agent-configuration__directory-state" role="status">{intl.formatMessage({ id: "settings.agents.directoryFailed", defaultMessage: "Could not load agents on this device." })}
            <IconButton size="accessory" variant="ghost" aria-label={intl.formatMessage({ id: "welcome.retry", defaultMessage: "Retry" })} onClick={() => { void directory.refetch(); }}><RefreshIcon size={14} /></IconButton>
          </div> : null}
          {!rows.length && !query ? <div className="agent-configuration__directory-state" role="status">{intl.formatMessage(source.profile.machinePresence === "offline"
            ? { id: "personalMachines.offline", defaultMessage: "Offline" }
            : directory?.isFetching ? { id: "composer.agent.loading", defaultMessage: "Loading agents…" }
            : directory?.isError ? { id: "settings.agents.directoryFailed", defaultMessage: "Could not load agents on this device." }
            : { id: "settings.agents.directoryEmpty", defaultMessage: "No agents found on this device." })}
            {directory?.isError ? <IconButton size="accessory" variant="ghost" aria-label={intl.formatMessage({ id: "welcome.retry", defaultMessage: "Retry" })} onClick={() => { void directory.refetch(); }}><RefreshIcon size={14} /></IconButton> : null}
          </div> : null}
        </NavigationGroup>;
      })}
      {view === "remote" ? <NavigationItem aria-current="page" disabled={busy} onClick={() => setDetailOpen(true)}><AddIcon size={18} />{intl.formatMessage({ id: "personalMachines.connect", defaultMessage: "Connect remote machine" })}</NavigationItem> : null}
      {query.trim() && !entries.some(entry => `${entry.agent.label} ${entry.machine}`.toLocaleLowerCase(intl.locale).includes(query.trim().toLocaleLowerCase(intl.locale))) ? <p className="agent-configuration__directory-state" role="status">{intl.formatMessage({ id: "settings.agents.noResults", defaultMessage: "No matching agents." })}</p> : null}
    </NavigationList>
  </>;
  return <div className="agent-configuration" data-detail-open={detailOpen}>
    <aside ref={navigation} className="agent-configuration__navigation">{navigationContent}</aside>
    <div className="agent-configuration__main">
      <div className="agent-configuration__mobile-back"><Button ref={back} variant="ghost" size="sm" contentLayout="row" disabled={busy} onClick={() => { returning.current = true; setDetailOpen(false); }}><ArrowLeftIcon size={16} />{agentLabel}</Button></div>
      <div className="agent-configuration__detail">
        {view === "remote" ? <><h3>{intl.formatMessage({ id: "personalMachines.connect", defaultMessage: "Connect remote machine" })}</h3>
          {requestMachines ? <PersonalMachineSetup enabled={active} scope={identityScope} request={requestMachines} onBusyChange={setBusy} onSelectMachine={id => { setPendingHost(id); setSelection(null); setView("browse"); }} />
            : <SettingsNotice>{intl.formatMessage({ id: "personalMachines.unavailable", defaultMessage: "Remote machine setup is unavailable on this connection. Switch to your local OpenCraft or retry." })}</SettingsNotice>}
        </> : selected ? <>
          <p className="agent-configuration__location">{selected.machine}{selected.remote ? ` · ${remoteLabel}` : ""}</p>
          {offline ? <SettingsNotice>{intl.formatMessage({ id: "settings.agents.offline", defaultMessage: "This device is offline. Reconnect to configure its agents or import conversations." })}</SettingsNotice> : null}
          <div inert={offline || !active || undefined}>
            <AgentOnboarding key={`${identityScope}:${selected.profile.hostId}:${selected.agent.id}`} hostId={selected.profile.hostId} identityScope={identityScope}
              presentation="settings" selectedAgentId={selected.agent.id} enabled={active && !offline} showRemoteEntry={false}
              request={(method, params) => access.request(selected.profile.hostId, method, params)} catalogModels={selected.data?.models}
              onStatusChange={receiveStatus} onBusyChange={setBusy} onImported={imported}
              agentPreferences={{ enabled: id => preferences.enabled(selected.profile.hostId, id), setEnabled: (id, value) => preferences.setEnabled(selected.profile.hostId, id, value), saving: preferences.saving, failed: preferences.failed }} />
          </div>
        </> : <p role="status">{intl.formatMessage(pendingHost ? { id: "composer.agent.loading", defaultMessage: "Loading agents…" } : { id: "settings.agents.select", defaultMessage: "Select an agent to configure it or import conversations." })}</p>}
      </div>
    </div>
  </div>;
}

/** Account/display and execution capabilities remain with the existing owners. */
export function HostAgentConfiguration({ hostId, active, platform }: { readonly hostId: string; readonly active: boolean; readonly platform: "web" | "electron" }) {
  const hosts = useAppServerHosts(), query = useQueryClient(), preferences = useAgentAvailability();
  const readAccount = useCallback(() => hosts.threadAttention.getScope() ?? "anonymous", [hosts]);
  const account = useSyncExternalStore(hosts.threadAttention.subscribe, readAccount, readAccount);
  const display = useSyncExternalStore(hosts.displayContinuity.subscribe, hosts.displayContinuity.getScope, hosts.displayContinuity.getScope);
  const identityScope = JSON.stringify([account, display]);
  const imported = useCallback(async (id: string) => { await query.invalidateQueries({ queryKey: ["appserver", id, "threads"] }); }, [query]);
  return <AgentConfigurationBrowser key={identityScope} hostId={hostId} active={active} identityScope={identityScope} profiles={hosts.profiles}
    platform={platform} access={hosts.agentRuntimes} preferences={preferences} onImported={imported}
    requestMachines={hosts.personalMachines ? command => hosts.personalMachines!.request(command) : undefined} />;
}
