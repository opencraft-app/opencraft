import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useIntl } from "@opencraft/i18n/react";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { AgentBrandIcon, DownloadIcon, GaugeIcon, LaptopIcon, RefreshIcon, ChevronDownIcon, ChevronUpIcon, ServerIcon } from "@opencraft/design-system-web/action-icons";
import type { AgentUsageSnapshot, AgentProviderUsage, AgentUsageWindow, OnboardingSnapshot } from "@opencraft/appserver-protocol";
import { useAppServerHosts } from "../runtime/appserver-runtime-context";
import { formatAgentVersionShort, isNewerSemver } from "./remote-machine-upgrades";
import "./agent-usage.scss";

export interface UsageMachineOption {
  readonly hostId: string;
  readonly label: string;
  readonly remote: boolean;
  readonly online: boolean;
}

export function AgentUsage({ hostId, threadId, busy }: { hostId: string; threadId: string | null; busy: boolean }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const { agentRuntimes, threadAttention, profiles, hosts } = useAppServerHosts();
  const scope = useSyncExternalStore(threadAttention.subscribe, () => threadAttention.getScope() ?? "anonymous");
  const [selectedHostId, setSelectedHostId] = useState(hostId);
  useEffect(() => { setSelectedHostId(hostId); }, [hostId]);

  const machines = useMemo<readonly UsageMachineOption[]>(() => {
    const items: UsageMachineOption[] = [];
    for (const host of hosts) {
      const profile = profiles.find(entry => entry.hostId === host.hostId);
      if (profile && !profile.enabled) continue;
      const remote = host.kind !== "local";
      const online = !remote || profile?.machinePresence !== "offline";
      if (remote && !online && host.hostId !== hostId) continue;
      const label = host.kind === "local"
        ? (profile?.machineIdentity?.name
          ? `${intl.formatMessage({ id: "agentUsage.localMachine", defaultMessage: "Local" })} · ${profile.machineIdentity.name}`
          : intl.formatMessage({ id: "agentUsage.localMachine", defaultMessage: "Local" }))
        : (profile?.machineIdentity?.name || profile?.displayName || host.label);
      items.push({ hostId: host.hostId, label, remote, online });
    }
    return items;
  }, [hosts, profiles, hostId, intl]);

  const effectiveHostId = machines.some(item => item.hostId === selectedHostId) ? selectedHostId : hostId;
  const effectiveRemote = machines.find(item => item.hostId === effectiveHostId)?.remote ?? effectiveHostId !== "local";
  const localHostId = hosts.find(host => host.kind === "local")?.hostId ?? hostId;

  const subscribe = useCallback((listener: () => void) => agentRuntimes.subscribe(effectiveHostId, listener), [agentRuntimes, effectiveHostId]);
  const read = useCallback(() => agentRuntimes.getSnapshot(effectiveHostId).phase, [agentRuntimes, effectiveHostId]);
  const phase = useSyncExternalStore(subscribe, read, read);

  const selectedOnline = machines.find(item => item.hostId === effectiveHostId)?.online ?? true;
  const connected = effectiveRemote ? selectedOnline : phase === "ready";
  const targetThreadId = effectiveHostId === hostId ? threadId : null;

  const onboardingQuery = useQuery({
    queryKey: ["agent-usage-onboarding", effectiveHostId, scope],
    enabled: connected,
    queryFn: () => agentRuntimes.request(effectiveHostId, "opencraft/agents/onboarding/status", {}),
    retry: false,
    staleTime: 30_000,
    refetchInterval: query => query.state.data?.agents?.some(agent => agent.activity?.phase === "running") ? 2500 : false,
    refetchOnWindowFocus: false,
  });

  const packageVersionsQuery = useQuery({
    queryKey: ["agent-package-versions", localHostId],
    enabled: localHostId !== null,
    queryFn: () => agentRuntimes.request(localHostId, "opencraft/agents/onboarding/package-versions", {}),
    retry: false,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

  const upgradeCli = async (agentId: "codex" | "cursor") => {
    let result: OnboardingSnapshot;
    try {
      result = await agentRuntimes.request(effectiveHostId, "opencraft/agents/onboarding/act", { id: agentId, action: "upgrade" });
    } catch {
      result = await agentRuntimes.request(effectiveHostId, "opencraft/agents/onboarding/act", { id: agentId, action: "install" });
    }
    queryClient.setQueryData(["agent-usage-onboarding", effectiveHostId, scope], result);
  };

  return (
    <AgentUsageView
      key={scope}
      hostId={effectiveHostId}
      scope={scope}
      threadId={targetThreadId}
      busy={effectiveHostId === hostId ? busy : false}
      connected={connected}
      remoteHost={effectiveRemote}
      machines={machines.length > 1 ? machines : undefined}
      selectedMachineHostId={effectiveHostId}
      onSelectMachine={setSelectedHostId}
      onboarding={onboardingQuery.data}
      latestVersions={packageVersionsQuery.data?.versions}
      onUpgradeAgent={upgradeCli}
      request={params => agentRuntimes.request(effectiveHostId, "opencraft/agents/usage", params)}
    />
  );
}

export function AgentUsageView({
  hostId,
  scope = "fixture",
  threadId,
  busy,
  connected,
  remoteHost = false,
  machines,
  selectedMachineHostId,
  onSelectMachine,
  onboarding,
  latestVersions,
  onUpgradeAgent,
  request,
}: {
  hostId: string;
  scope?: string;
  threadId: string | null;
  busy: boolean;
  connected: boolean;
  remoteHost?: boolean;
  machines?: readonly UsageMachineOption[];
  selectedMachineHostId?: string;
  onSelectMachine?: (hostId: string) => void;
  onboarding?: OnboardingSnapshot;
  latestVersions?: Readonly<Record<string, string | null>>;
  onUpgradeAgent?: (id: "codex" | "cursor") => Promise<void>;
  request(params: { threadId?: string; force?: boolean }): Promise<AgentUsageSnapshot>;
}) {
  const intl = useIntl(), [open, setOpen] = useState(false), [provider, setProvider] = useState(() => threadId?.startsWith("cursor_") ? "cursor" : "codex");
  const [upgradingId, setUpgradingId] = useState<string | null>(null);
  const manualProvider = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null), panelId = useId();
  const force = useRef(false), previousBusy = useRef(busy);
  const query = useQuery({ queryKey: ["agent-usage", hostId, scope, threadId], enabled: connected,
    queryFn: () => { const fresh = force.current; force.current = false; return request({ ...(threadId ? { threadId } : {}), force: fresh }); },
    retry: false, staleTime: 30_000, refetchInterval: open ? 30_000 : false, refetchOnWindowFocus: false });
  useEffect(() => { if (previousBusy.current && !busy && connected) void query.refetch(); previousBusy.current = busy; }, [busy, connected, query.refetch]);
  useEffect(() => { if (!manualProvider.current && threadId) setProvider(threadId.startsWith("cursor_") ? "cursor" : "codex"); }, [threadId]);
  const data = query.data, current = data?.conversation;
  const count = (value: number | null | undefined) => value == null ? "—" : intl.formatNumber(value, { notation: "compact", maximumFractionDigits: 1 });
  const unknown = intl.formatMessage({ id: "agentUsage.unknown", defaultMessage: "Not reported" });
  const title = intl.formatMessage({ id: "agentUsage.title", defaultMessage: "Token usage" });
  const providerName = (id: string) => id === "codex" ? intl.formatMessage({ id: "onboard.agent.codex", defaultMessage: "Codex" })
    : id === "cursor" ? intl.formatMessage({ id: "onboard.agent.cursor", defaultMessage: "Cursor" }) : id;
  const label = intl.formatMessage({ id: "agentUsage.current", defaultMessage: "This conversation" });
  const active = data?.providers.find(item => item.id === provider) ?? data?.providers[0];
  const activeId = (active?.id ?? provider) as "codex" | "cursor";
  const onboardingEntry = onboarding?.agents.find(agent => agent.id === activeId);
  const accountEmail = active?.account ?? onboardingEntry?.account ?? null;
  const cliVersion = formatAgentVersionShort(onboardingEntry?.version);
  const latestCliVersion = latestVersions?.[activeId] ?? null;
  const cliHasUpdate = Boolean(onboardingEntry?.installed && onboardingEntry.canInstallPackage && isNewerSemver(latestCliVersion, onboardingEntry.version));
  const cliBusy = upgradingId === activeId
    || (onboardingEntry?.activity?.phase === "running" && (onboardingEntry.activity.kind === "install" || onboardingEntry.activity.kind === "upgrade"));

  const context = current?.context;
  const percent = context ? context.usedTokens / context.limitTokens * 100 : null;
  const observedAt = active?.observedAt ?? current?.observedAt ?? data?.readAt;
  const refresh = () => { force.current = true; void query.refetch(); };
  const windowLabel = (window: AgentUsageWindow) => window.kind === "plan"
    ? intl.formatMessage({ id: "agentUsage.plan", defaultMessage: "Plan" }) : window.kind === "spend"
      ? window.scope === "team" ? intl.formatMessage({ id: "agentUsage.teamSpend", defaultMessage: "Team on-demand" }) : intl.formatMessage({ id: "agentUsage.spend", defaultMessage: "On-demand" }) : window.durationMinutes === null
        ? intl.formatMessage({ id: "agentUsage.limit", defaultMessage: "Limit" }) : window.durationMinutes >= 1440
          ? intl.formatMessage({ id: "agentUsage.days", defaultMessage: "{count} days" }, { count: window.durationMinutes / 1440 })
          : intl.formatMessage({ id: "agentUsage.hours", defaultMessage: "{count} hours" }, { count: window.durationMinutes / 60 });
  const notice = (value: AgentProviderUsage) => intl.formatMessage(value.status === "signedOut"
    ? { id: "agentUsage.signIn", defaultMessage: "Sign in to this Agent to view its limits." }
    : value.status === "expired" ? { id: "agentUsage.expired", defaultMessage: "The Agent sign-in has expired. Sign in again." }
      : { id: "agentUsage.unavailable", defaultMessage: "Could not refresh. Previously reported usage is shown when available." });
  if (query.error && (query.error as { code?: unknown }).code === -32601) return null;
  return <section className="agent-usage" aria-label={title} data-agent-usage="" onKeyDown={event => {
    if (open && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <Button ref={trigger} variant="ghost" size="accessory" className="agent-usage__disclosure" contentLayout="row" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <GaugeIcon size={16} aria-hidden="true" /><span>{title}</span>
      <span className="agent-usage__summary" title={context ? intl.formatMessage({ id: "agentUsage.context", defaultMessage: "Context window" }) : label}>{context ? `${count(context.usedTokens)} / ${count(context.limitTokens)}` : current?.total ? count(current.total.totalTokens) : "—"}</span>
      {open ? <ChevronDownIcon size={14} aria-hidden="true" /> : <ChevronUpIcon size={14} aria-hidden="true" />}
    </Button>
    {open ? <div className="agent-usage__content">
      {machines && machines.length > 1 && onSelectMachine ? (
        <div className="agent-usage__machines" role="group" aria-label={intl.formatMessage({ id: "agentUsage.machineSelector", defaultMessage: "Machine" })}>
          {machines.map(machine => (
            <Button
              key={machine.hostId}
              size="sm"
              density="compact"
              contentLayout="row"
              variant={selectedMachineHostId === machine.hostId ? "outline" : "ghost"}
              aria-pressed={selectedMachineHostId === machine.hostId}
              onClick={() => onSelectMachine(machine.hostId)}
            >
              {machine.remote ? <ServerIcon size={12} aria-hidden="true" /> : <LaptopIcon size={12} aria-hidden="true" />}
              <span>{machine.label}</span>
            </Button>
          ))}
        </div>
      ) : null}
      <div className="agent-usage__header">
        <div role="tablist" aria-label={intl.formatMessage({ id: "agentUsage.providers", defaultMessage: "Usage provider" })}>
          {(data?.providers ?? [{ id: "codex" }, { id: "cursor" }]).map((item, index, list) => <IconButton key={item.id} size="accessory" variant={provider === item.id ? "outline" : "ghost"}
            role="tab" id={`${panelId}-${item.id}`} aria-controls={panelId} aria-selected={provider === item.id} title={providerName(item.id)} aria-label={providerName(item.id)} tabIndex={provider === item.id ? 0 : -1}
            onClick={() => { manualProvider.current = true; setProvider(item.id); }} onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + list.length) % list.length;
              manualProvider.current = true; setProvider(list[next]!.id); (event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[next])?.focus();
            }}><AgentBrandIcon agent={item.id === "codex" ? "codex" : "cursor"} /></IconButton>)}
        </div>
        <span>{active?.plan}</span>
        <IconButton size="accessory" variant="ghost" disabled={!connected || query.isFetching} aria-label={intl.formatMessage({ id: "agentUsage.refresh", defaultMessage: "Refresh usage" })}
          aria-busy={query.isFetching} onClick={refresh}><RefreshIcon size={15} aria-hidden="true" /></IconButton>
      </div>
      {(accountEmail || cliVersion || (remoteHost && active?.status === "ok" && !accountEmail) || (cliHasUpdate && onUpgradeAgent)) ? (
        <div className="agent-usage__identity">
          {accountEmail ? (
            <div className="agent-usage__account" title={accountEmail}>{accountEmail}</div>
          ) : remoteHost && active?.status === "ok" ? (
            <div className="agent-usage__account">{intl.formatMessage({ id: "agentUsage.accountAfterPluginUpdate", defaultMessage: "Update OpenCraft service to show account" })}</div>
          ) : null}
          {(cliVersion || ((cliHasUpdate || (remoteHost && onboardingEntry?.installed && onboardingEntry.canInstallPackage)) && onUpgradeAgent)) ? (
            <div className="agent-usage__version-row">
              <span>{cliVersion ? `${providerName(activeId)} ${cliVersion}` : providerName(activeId)}</span>
              {(cliHasUpdate || (remoteHost && onboardingEntry?.installed && onboardingEntry.canInstallPackage)) && onUpgradeAgent ? (
                <Button
                  size="sm"
                  density="compact"
                  variant="outline"
                  contentLayout="row"
                  loading={Boolean(cliBusy)}
                  disabled={!connected}
                  onClick={() => {
                    setUpgradingId(activeId);
                    void onUpgradeAgent(activeId).finally(() => setUpgradingId(null));
                  }}
                >
                  {cliBusy ? null : <DownloadIcon size={12} aria-hidden="true" />}
                  <span>
                    {cliHasUpdate && latestCliVersion
                      ? intl.formatMessage({ id: "agentUsage.upgradeCliTo", defaultMessage: "Update to v{version}" }, { version: latestCliVersion })
                      : intl.formatMessage({ id: "remoteUpgrade.agentButton", defaultMessage: "Update {agent}" }, { agent: providerName(activeId) })}
                  </span>
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="agent-usage__provider" role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${provider}`}>
        {query.isPending && connected ? <p role="status">{intl.formatMessage({ id: "agentUsage.loading", defaultMessage: "Reading usage…" })}</p> : null}
        {query.isError || !connected ? <p role="status">{intl.formatMessage({ id: "agentUsage.failed", defaultMessage: "Could not refresh usage. Try again when connected." })}</p> : null}
        {active && active.status !== "ok" ? <p role="status">{notice(active)}</p> : null}
        {active?.status === "ok" && active.windows.length === 0 ? <p>{intl.formatMessage({ id: "agentUsage.noLimits", defaultMessage: "This plan does not report usage limits." })}</p> : null}
        {active?.windows.map((window, index) => <div className="agent-usage__window" key={index}>
          <span>{windowLabel(window)}</span><progress max={100} value={Math.min(100, window.usedPercent)} aria-label={windowLabel(window)} data-warning={window.usedPercent >= 80 || undefined} />
          <span>{intl.formatNumber(window.usedPercent / 100, { style: "percent", maximumFractionDigits: 0 })}</span>
          <small>{window.resetsAt ? intl.formatMessage({ id: "agentUsage.resets", defaultMessage: "Resets {time}" }, { time: intl.formatDate(window.resetsAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) }) : unknown}</small>
          {window.cost ? <small>{intl.formatNumber(window.cost.usedCents / 100, { style: "currency", currency: window.cost.currency })} / {intl.formatNumber(window.cost.limitCents / 100, { style: "currency", currency: window.cost.currency })}</small> : null}
        </div>)}
      </div>
      <div className="agent-usage__conversation">
        <h4>{label}{current ? <small>{providerName(current.providerId)}</small> : null}</h4>
        {context ? <><div className="agent-usage__context"><span>{count(context.usedTokens)} / {count(context.limitTokens)}</span><span>{intl.formatNumber(percent! / 100, { style: "percent", maximumFractionDigits: 1 })}</span></div>
          <progress max={context.limitTokens} value={Math.min(context.usedTokens, context.limitTokens)} aria-label={intl.formatMessage({ id: "agentUsage.context", defaultMessage: "Context window" })} /></> : <p>{threadId ? unknown : intl.formatMessage({ id: "agentUsage.openConversation", defaultMessage: "Open a conversation to view its usage." })}</p>}
        {current?.total ? <dl>{([
          [intl.formatMessage({ id: "agentUsage.total", defaultMessage: "Total tokens" }), current.total.totalTokens],
          [intl.formatMessage({ id: "agentUsage.input", defaultMessage: "Input" }), current.total.inputTokens],
          [intl.formatMessage({ id: "agentUsage.cached", defaultMessage: "Cached input" }), current.total.cachedInputTokens],
          [intl.formatMessage({ id: "agentUsage.output", defaultMessage: "Output" }), current.total.outputTokens],
          [intl.formatMessage({ id: "agentUsage.reasoning", defaultMessage: "Reasoning output" }), current.total.reasoningOutputTokens],
          [intl.formatMessage({ id: "agentUsage.lastRequest", defaultMessage: "Last request" }), current.last?.totalTokens ?? null],
        ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{count(value)}</dd></div>)}</dl> : null}
        {observedAt ? <small>{intl.formatMessage({ id: "agentUsage.readAt", defaultMessage: "Read at {time}" }, { time: intl.formatTime(observedAt, { hour: "numeric", minute: "2-digit" }) })}</small> : null}
      </div>
    </div> : null}
  </section>;
}
