import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IntlShape } from "@opencraft/i18n";
import { useIntl } from "@opencraft/i18n/react";
import { Button, DisclosureButton, IconButton } from "@opencraft/design-system-web/button";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import {
  AgentBrandIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ContextRingIcon,
  GaugeIcon,
  RefreshIcon,
  WarningIcon,
} from "@opencraft/design-system-web/action-icons";
import type {
  AgentConversationUsage,
  AgentProviderUsage,
  AgentTokenCounts,
  AgentUsageSnapshot,
  AgentUsageWindow,
} from "@opencraft/appserver-protocol";
import { useAppServerHosts } from "../runtime/appserver-runtime-context";
import "./agent-usage.scss";

export interface UsageMachineOption {
  readonly hostId: string;
  readonly label: string;
  readonly remote: boolean;
  readonly connected?: boolean;
  readonly detail?: string | null;
}

function sanitizeEndpointDetail(endpoint: string | null | undefined): string | null {
  if (!endpoint) return null;
  const trimmed = endpoint.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname.replace(/\/+$/u, "") : "";
    return `${parsed.host}${path}` || null;
  } catch {
    return trimmed.replace(/^[a-z]+:\/\//iu, "").replace(/[?#].*$/u, "").replace(/\/+$/u, "") || null;
  }
}

function formatCompactCount(intl: IntlShape, value: number | null | undefined): string {
  return value == null ? "—" : intl.formatNumber(value, { notation: "compact", maximumFractionDigits: 1 });
}

function computeCacheHitRatio(counts: AgentTokenCounts | null | undefined): number | null {
  if (!counts || counts.inputTokens == null || counts.inputTokens <= 0 || counts.cachedInputTokens == null) return null;
  if (counts.cachedInputTokens < 0 || counts.cachedInputTokens > counts.inputTokens) return null;
  return counts.cachedInputTokens / counts.inputTokens;
}

function formatProviderName(intl: IntlShape, id: string): string {
  return id === "codex"
    ? intl.formatMessage({ id: "onboard.agent.codex", defaultMessage: "Codex" })
    : id === "cursor"
      ? intl.formatMessage({ id: "onboard.agent.cursor", defaultMessage: "Cursor" })
      : id;
}

function formatWindowLabel(intl: IntlShape, window: AgentUsageWindow): string {
  if (window.kind === "plan") return intl.formatMessage({ id: "agentUsage.plan", defaultMessage: "Plan" });
  if (window.kind === "spend") {
    return window.scope === "team"
      ? intl.formatMessage({ id: "agentUsage.teamSpend", defaultMessage: "Team on-demand" })
      : intl.formatMessage({ id: "agentUsage.spend", defaultMessage: "On-demand" });
  }
  if (window.durationMinutes === null) return intl.formatMessage({ id: "agentUsage.limit", defaultMessage: "Limit" });
  return window.durationMinutes >= 1440
    ? intl.formatMessage({ id: "agentUsage.days", defaultMessage: "{count} days" }, { count: window.durationMinutes / 1440 })
    : intl.formatMessage({ id: "agentUsage.hours", defaultMessage: "{count} hours" }, { count: window.durationMinutes / 60 });
}

function formatShortWindowTag(intl: IntlShape, providerId: string, window: AgentUsageWindow): string {
  if (window.kind === "plan") return intl.formatMessage({ id: "agentUsage.planShort", defaultMessage: "Plan" });
  if (window.kind === "spend") return intl.formatMessage({ id: "agentUsage.spendShort", defaultMessage: "Spend" });
  if (window.durationMinutes === null) return formatProviderName(intl, providerId);
  return window.durationMinutes >= 1440
    ? intl.formatMessage({ id: "agentUsage.daysShort", defaultMessage: "{count}d" }, { count: Math.round(window.durationMinutes / 1440) })
    : intl.formatMessage({ id: "agentUsage.hoursShort", defaultMessage: "{count}h" }, { count: Math.round(window.durationMinutes / 60) });
}

function findTightestQuota(
  intl: IntlShape,
  snapshot: AgentUsageSnapshot | undefined,
): { readonly label: string; readonly percent: number } | null {
  if (!snapshot) return null;
  let tightest: { label: string; percent: number } | null = null;
  for (const provider of snapshot.providers) {
    if (provider.status !== "ok") continue;
    for (const window of provider.windows) {
      if (!tightest || window.usedPercent > tightest.percent) {
        tightest = {
          label: formatShortWindowTag(intl, provider.id, window),
          percent: window.usedPercent,
        };
      }
    }
  }
  return tightest;
}

function useAgentUsageSnapshot({
  hostId,
  scope,
  threadId,
  busy,
  connected,
  activePolling,
  request,
}: {
  hostId: string;
  scope: string;
  threadId: string | null;
  busy: boolean;
  connected: boolean;
  activePolling: boolean;
  request(params: { threadId?: string; force?: boolean }): Promise<AgentUsageSnapshot>;
}) {
  const force = useRef(false);
  const previousBusy = useRef(busy);
  const query = useQuery({
    queryKey: ["agent-usage", hostId, scope, threadId],
    enabled: connected,
    queryFn: () => {
      const fresh = force.current;
      force.current = false;
      return request({ ...(threadId ? { threadId } : {}), force: fresh });
    },
    retry: false,
    staleTime: 30_000,
    refetchInterval: activePolling ? 30_000 : false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (previousBusy.current && !busy && connected) void query.refetch();
    previousBusy.current = busy;
  }, [busy, connected, query.refetch]);
  const refresh = useCallback(() => {
    force.current = true;
    void query.refetch();
  }, [query.refetch]);
  const unsupported = Boolean(query.error && (query.error as { code?: unknown }).code === -32601);
  return { query, refresh, unsupported };
}

export function AgentUsage({ hostId, threadId, busy }: { hostId: string; threadId: string | null; busy: boolean }) {
  const intl = useIntl();
  const { agentRuntimes, threadAttention, profiles, hosts } = useAppServerHosts();
  const scope = useSyncExternalStore(threadAttention.subscribe, () => threadAttention.getScope() ?? "anonymous");
  const [selectedHostId, setSelectedHostId] = useState(hostId);
  useEffect(() => { setSelectedHostId(hostId); }, [hostId]);

  const hostIdsKey = hosts.map(host => host.hostId).join("\0");
  const subscribeAllHosts = useCallback((listener: () => void) => {
    const cleanups = hosts.map(host => agentRuntimes.subscribe(host.hostId, listener));
    return () => { for (const cleanup of cleanups) cleanup(); };
  }, [agentRuntimes, hostIdsKey]);
  const readHostPhases = useCallback(
    () => hosts.map(host => `${host.hostId}:${agentRuntimes.getSnapshot(host.hostId).phase}`).join("\0"),
    [agentRuntimes, hostIdsKey],
  );
  const hostPhases = useSyncExternalStore(subscribeAllHosts, readHostPhases, readHostPhases);

  const machines = useMemo<readonly UsageMachineOption[]>(() => {
    const items: UsageMachineOption[] = [];
    for (const host of hosts) {
      const profile = profiles.find(entry => entry.hostId === host.hostId);
      if (profile && !profile.enabled) continue;
      const phase = agentRuntimes.getSnapshot(host.hostId).phase;
      const remote = host.kind !== "local";
      const label = host.kind === "local"
        ? (profile?.machineIdentity?.name || intl.formatMessage({ id: "agentUsage.localMachine", defaultMessage: "Local" }))
        : (profile?.machineIdentity?.name || profile?.displayName || host.label);
      const detail = sanitizeEndpointDetail(profile?.transportEndpoint)
        || profile?.executionLocation
        || (profile?.displayName && profile.displayName !== label ? profile.displayName : null)
        || host.hostId;
      items.push({ hostId: host.hostId, label, remote, connected: phase === "ready", detail });
    }
    return items;
  }, [hosts, profiles, agentRuntimes, intl, hostPhases]);

  if (machines.length === 0) return null;

  const effectiveHostId = machines.some(item => item.hostId === selectedHostId) ? selectedHostId : hostId;
  const effectivePhase = agentRuntimes.getSnapshot(effectiveHostId).phase;
  return (
    <AgentUsageView
      key={JSON.stringify([hostId, scope])}
      hostId={effectiveHostId}
      scope={scope}
      threadId={effectiveHostId === hostId ? threadId : null}
      busy={effectiveHostId === hostId ? busy : false}
      connected={effectivePhase === "ready"}
      machines={machines.length > 1 ? machines : undefined}
      selectedMachineHostId={effectiveHostId}
      onSelectMachine={setSelectedHostId}
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
  machines,
  selectedMachineHostId,
  onSelectMachine,
  request,
}: {
  hostId: string;
  scope?: string;
  threadId: string | null;
  busy: boolean;
  connected: boolean;
  machines?: readonly UsageMachineOption[];
  selectedMachineHostId?: string;
  onSelectMachine?: (hostId: string) => void;
  request(params: { threadId?: string; force?: boolean }): Promise<AgentUsageSnapshot>;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState(() => (threadId?.startsWith("cursor_") ? "cursor" : "codex"));
  const manualProvider = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const { query, refresh, unsupported } = useAgentUsageSnapshot({
    hostId,
    scope,
    threadId,
    busy,
    connected,
    activePolling: open,
    request,
  });

  useEffect(() => {
    if (!manualProvider.current && threadId) setProvider(threadId.startsWith("cursor_") ? "cursor" : "codex");
  }, [threadId]);

  const data = query.data;
  const unknown = intl.formatMessage({ id: "agentUsage.unknown", defaultMessage: "Not reported" });
  const title = intl.formatMessage({ id: "agentUsage.quotaTitle", defaultMessage: "Agent limits" });
  const active = data?.providers.find(item => item.id === provider) ?? data?.providers[0];
  const tightest = connected ? findTightestQuota(intl, data) : null;
  const observedAt = active?.observedAt ?? data?.readAt;

  const duplicateMachineNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const machine of machines ?? []) counts.set(machine.label, (counts.get(machine.label) ?? 0) + 1);
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
  }, [machines]);

  const selectedMachine = machines?.find(item => item.hostId === (selectedMachineHostId ?? hostId));

  const notice = (value: AgentProviderUsage) => intl.formatMessage(
    value.status === "signedOut"
      ? { id: "agentUsage.signIn", defaultMessage: "Sign in to this Agent to view its limits." }
      : value.status === "expired"
        ? { id: "agentUsage.expired", defaultMessage: "The Agent sign-in has expired. Sign in again." }
        : { id: "agentUsage.unavailable", defaultMessage: "Could not refresh. Previously reported usage is shown when available." },
  );

  if (unsupported) return null;

  const summaryText = !connected
    ? intl.formatMessage({ id: "agentUsage.disconnected", defaultMessage: "Disconnected" })
    : tightest
      ? `${tightest.label} ${intl.formatNumber(tightest.percent / 100, { style: "percent", maximumFractionDigits: 0 })}`
      : "—";

  const showOfflineEmpty = !connected && !data;

  return (
    <section
      className="agent-usage"
      aria-label={title}
      data-agent-usage=""
      onKeyDown={event => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <Button
        ref={trigger}
        variant="ghost"
        size="accessory"
        className="agent-usage__disclosure"
        contentLayout="row"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <GaugeIcon size={16} aria-hidden="true" />
        <span>{title}</span>
        <span
          className="agent-usage__summary"
          data-warning={tightest && tightest.percent >= 80 ? "true" : undefined}
          data-offline={!connected ? "true" : undefined}
        >
          {summaryText}
        </span>
        {open ? <ChevronDownIcon size={14} aria-hidden="true" /> : <ChevronUpIcon size={14} aria-hidden="true" />}
      </Button>

      {open ? (
        <div className="agent-usage__content">
          {machines && machines.length > 1 && onSelectMachine ? (
            <div className="agent-usage__machine-tabs" role="tablist" aria-label={intl.formatMessage({ id: "agentUsage.machineSelector", defaultMessage: "Machine" })}>
              {machines.map((machine, index, list) => {
                const selected = (selectedMachineHostId ?? hostId) === machine.hostId;
                const duplicated = duplicateMachineNames.has(machine.label);
                const secondary = duplicated && machine.detail
                  ? machine.detail
                  : machine.remote
                    ? intl.formatMessage({ id: "agentUsage.remoteMachine", defaultMessage: "Remote" })
                    : intl.formatMessage({ id: "agentUsage.localMachine", defaultMessage: "Local" });
                const accessibleTitle = duplicated && machine.detail ? `${machine.label} (${machine.detail})` : machine.label;
                return (
                  <Button
                    key={machine.hostId}
                    size="sm"
                    variant={selected ? "secondary" : "ghost"}
                    contentLayout="row"
                    className="agent-usage__machine-tab"
                    data-selected={selected ? "true" : undefined}
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    title={accessibleTitle}
                    onClick={() => onSelectMachine(machine.hostId)}
                    onKeyDown={event => {
                      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                      event.preventDefault();
                      const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
                      const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : (index + delta + list.length) % list.length;
                      onSelectMachine(list[next]!.hostId);
                      event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
                    }}
                  >
                    {machine.connected !== undefined ? (
                      <span className="agent-usage__status-dot" data-offline={!machine.connected || undefined} aria-hidden="true" />
                    ) : null}
                    <span className="agent-usage__machine-copy">
                      <span className="agent-usage__machine-name">{machine.label}</span>
                      <span className="agent-usage__machine-badge">{secondary}</span>
                    </span>
                  </Button>
                );
              })}
            </div>
          ) : null}

          {showOfflineEmpty ? (
            <div className="agent-usage__offline" role="status">
              <div className="agent-usage__offline-copy">
                <strong>
                  {selectedMachine
                    ? intl.formatMessage({ id: "agentUsage.machineOffline", defaultMessage: "{machine} is disconnected" }, { machine: selectedMachine.label })
                    : intl.formatMessage({ id: "agentUsage.disconnected", defaultMessage: "Disconnected" })}
                </strong>
                <span>{intl.formatMessage({ id: "agentUsage.failed", defaultMessage: "Could not refresh usage. Try again when connected." })}</span>
              </div>
              <IconButton
                size="accessory"
                variant="ghost"
                disabled
                aria-label={intl.formatMessage({ id: "agentUsage.refresh", defaultMessage: "Refresh usage" })}
              >
                <RefreshIcon size={15} aria-hidden="true" />
              </IconButton>
            </div>
          ) : (
            <>
              <div className="agent-usage__header">
                <div className="agent-usage__tabs" role="tablist" aria-label={intl.formatMessage({ id: "agentUsage.providers", defaultMessage: "Usage provider" })}>
                  {(data?.providers ?? [{ id: "codex" as const }, { id: "cursor" as const }]).map((item, index, list) => {
                    const selected = provider === item.id;
                    const label = formatProviderName(intl, item.id);
                    return (
                      <Button
                        key={item.id}
                        size="sm"
                        variant={selected ? "secondary" : "ghost"}
                        className="agent-usage__provider-tab"
                        data-selected={selected ? "true" : undefined}
                        role="tab"
                        id={`${panelId}-${item.id}`}
                        aria-controls={panelId}
                        aria-selected={selected}
                        title={label}
                        aria-label={label}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => { manualProvider.current = true; setProvider(item.id); }}
                        onKeyDown={event => {
                          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                          event.preventDefault();
                          const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + list.length) % list.length;
                          manualProvider.current = true;
                          setProvider(list[next]!.id);
                          event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
                        }}
                      >
                        <AgentBrandIcon agent={item.id === "codex" ? "codex" : "cursor"} />
                        <span>{label}</span>
                      </Button>
                    );
                  })}
                </div>
                <IconButton
                  size="accessory"
                  variant="ghost"
                  disabled={!connected || query.isFetching}
                  aria-label={intl.formatMessage({ id: "agentUsage.refresh", defaultMessage: "Refresh usage" })}
                  aria-busy={query.isFetching}
                  onClick={refresh}
                >
                  <RefreshIcon size={15} aria-hidden="true" />
                </IconButton>
              </div>

              {active?.plan || active?.account ? (
                <div className="agent-usage__account-row">
                  {active.plan ? <span className="agent-usage__plan-badge">{active.plan}</span> : null}
                  {active.account ? <small className="agent-usage__account" title={active.account}>{active.account}</small> : null}
                </div>
              ) : null}

              <div className="agent-usage__provider" role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${provider}`}>
                {query.isPending && connected ? <p role="status">{intl.formatMessage({ id: "agentUsage.loading", defaultMessage: "Reading usage…" })}</p> : null}
                {query.isError || !connected ? <p role="status">{intl.formatMessage({ id: "agentUsage.failed", defaultMessage: "Could not refresh usage. Try again when connected." })}</p> : null}
                {active && active.status !== "ok" ? <p role="status">{notice(active)}</p> : null}
                {active?.status === "ok" && active.windows.length === 0 ? <p>{intl.formatMessage({ id: "agentUsage.noLimits", defaultMessage: "This plan does not report usage limits." })}</p> : null}
                {active?.windows.map((window, index) => (
                  <div className="agent-usage__window" key={index}>
                    <span>{formatWindowLabel(intl, window)}</span>
                    <progress
                      max={100}
                      value={Math.min(100, window.usedPercent)}
                      aria-label={formatWindowLabel(intl, window)}
                      data-warning={window.usedPercent >= 80 || undefined}
                    />
                    <span className="agent-usage__window-percent" data-warning={window.usedPercent >= 80 || undefined}>
                      {intl.formatNumber(window.usedPercent / 100, { style: "percent", maximumFractionDigits: 0 })}
                    </span>
                    <small>
                      {window.resetsAt
                        ? intl.formatMessage({ id: "agentUsage.resets", defaultMessage: "Resets {time}" }, {
                          time: intl.formatDate(window.resetsAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
                        })
                        : unknown}
                    </small>
                    {window.cost ? (
                      <small className="agent-usage__window-cost">
                        {intl.formatNumber(window.cost.usedCents / 100, { style: "currency", currency: window.cost.currency })} / {intl.formatNumber(window.cost.limitCents / 100, { style: "currency", currency: window.cost.currency })}
                      </small>
                    ) : null}
                  </div>
                ))}
                {observedAt ? (
                  <small className="agent-usage__read-at">
                    {intl.formatMessage({ id: "agentUsage.readAt", defaultMessage: "Read at {time}" }, {
                      time: intl.formatTime(observedAt, { hour: "numeric", minute: "2-digit" }),
                    })}
                  </small>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function ConversationContextUsage({
  hostId,
  threadId,
  busy,
  portalContainer,
  onOpenTokenUsage,
}: {
  readonly hostId: string;
  readonly threadId: string | null;
  readonly busy: boolean;
  readonly portalContainer?: HTMLElement | null;
  readonly onOpenTokenUsage?: () => void;
}) {
  const { agentRuntimes, threadAttention } = useAppServerHosts();
  const scope = useSyncExternalStore(threadAttention.subscribe, () => threadAttention.getScope() ?? "anonymous");
  const subscribe = useCallback((listener: () => void) => agentRuntimes.subscribe(hostId, listener), [agentRuntimes, hostId]);
  const read = useCallback(() => agentRuntimes.getSnapshot(hostId).phase, [agentRuntimes, hostId]);
  const phase = useSyncExternalStore(subscribe, read, read);

  if (!threadId) return null;

  return (
    <ConversationContextUsageView
      key={JSON.stringify([hostId, scope, threadId])}
      hostId={hostId}
      scope={scope}
      threadId={threadId}
      busy={busy}
      connected={phase === "ready"}
      portalContainer={portalContainer}
      onOpenTokenUsage={onOpenTokenUsage}
      request={params => agentRuntimes.request(hostId, "opencraft/agents/usage", params)}
    />
  );
}

export function ConversationContextUsageView({
  hostId,
  scope = "fixture",
  threadId,
  busy,
  connected,
  portalContainer,
  onOpenTokenUsage,
  request,
}: {
  readonly hostId: string;
  readonly scope?: string;
  readonly threadId: string | null;
  readonly busy: boolean;
  readonly connected: boolean;
  readonly portalContainer?: HTMLElement | null;
  readonly onOpenTokenUsage?: () => void;
  request(params: { threadId?: string; force?: boolean }): Promise<AgentUsageSnapshot>;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const { query, unsupported } = useAgentUsageSnapshot({
    hostId,
    scope,
    threadId,
    busy,
    connected: connected && threadId !== null,
    activePolling: open,
    request,
  });

  if (unsupported || !threadId) return null;
  const current: AgentConversationUsage | null = query.data?.conversation ?? null;
  const context = current?.context ?? null;
  if (!context && !current?.total) return null;

  const percent = context && context.limitTokens > 0 ? (context.usedTokens / context.limitTokens) * 100 : null;
  const warning = percent !== null && percent >= 80;
  const count = (value: number | null | undefined) => formatCompactCount(intl, value);
  const contextLabel = intl.formatMessage({ id: "agentUsage.context", defaultMessage: "Context window" });
  const percentText = percent !== null
    ? intl.formatNumber(percent / 100, { style: "percent", maximumFractionDigits: 0 })
    : count(current?.total?.totalTokens);
  const triggerTitle = context
    ? `${contextLabel} · ${count(context.usedTokens)} / ${count(context.limitTokens)} (${percentText})`
    : `${intl.formatMessage({ id: "agentUsage.total", defaultMessage: "Total tokens" })} · ${percentText}`;

  const totalCacheRatio = computeCacheHitRatio(current?.total);
  const lastCacheRatio = computeCacheHitRatio(current?.last);
  const formatHitRate = (ratio: number) => intl.formatNumber(ratio, { style: "percent", maximumFractionDigits: 1 });
  const lastRequestValue = current?.last?.totalTokens != null && lastCacheRatio !== null
    ? intl.formatMessage(
      { id: "agentUsage.lastCacheHit", defaultMessage: "{tokens} ({rate} cached)" },
      { tokens: count(current.last.totalTokens), rate: formatHitRate(lastCacheRatio) },
    )
    : count(current?.last?.totalTokens);

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <DisclosureButton
          size="accessory"
          className="agent-context__trigger"
          aria-label={triggerTitle}
          title={triggerTitle}
          data-agent-context-trigger=""
        >
          <span className="agent-context__trigger-value" data-warning={warning || undefined}>
            {percent !== null ? <ContextRingIcon percent={percent} size={15} aria-hidden="true" /> : null}
            <span>{percentText}</span>
          </span>
        </DisclosureButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={portalContainer ?? undefined}>
        <DropdownMenu.Content
          className="agent-context__popover"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          data-agent-context-popover=""
          onCloseAutoFocus={event => {
            // Keep composer focus undisturbed when closing via outside click.
            event.preventDefault();
          }}
        >
          {context ? (
            <div className="agent-context__section">
              <div className="agent-context__head">
                <span className="agent-context__title">{contextLabel}</span>
                <span className="agent-context__provider">{formatProviderName(intl, current!.providerId)}</span>
              </div>
              <p className="agent-context__subtitle">
                {intl.formatMessage({ id: "agentUsage.contextSubtitle", defaultMessage: "Active model memory before compaction" })}
              </p>
              <div className="agent-context__meter">
                <div className="agent-context__meter-row">
                  <strong data-warning={warning || undefined}>
                    {count(context.usedTokens)} / {count(context.limitTokens)}
                  </strong>
                  <span>
                    {intl.formatMessage({ id: "agentUsage.contextRemaining", defaultMessage: "{remaining} left" }, {
                      remaining: count(Math.max(0, context.limitTokens - context.usedTokens)),
                    })}
                  </span>
                </div>
                <progress
                  max={context.limitTokens}
                  value={Math.min(context.usedTokens, context.limitTokens)}
                  aria-label={contextLabel}
                  data-warning={warning || undefined}
                />
                {warning ? (
                  <p className="agent-context__warning" role="status">
                    <WarningIcon size={13} aria-hidden="true" />
                    <span>{intl.formatMessage({ id: "agentUsage.contextWarning", defaultMessage: "Approaching context limit; older turns may compact soon." })}</span>
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="agent-context__section agent-context__section--tokens">
            <div className="agent-context__section-head">
              <div className="agent-context__section-label">
                {intl.formatMessage({ id: "agentUsage.sessionTokens", defaultMessage: "Session cumulative tokens" })}
              </div>
              {totalCacheRatio !== null ? (
                <span className="agent-context__cache-rate" data-strong={totalCacheRatio >= 0.5 || undefined}>
                  {intl.formatMessage(
                    { id: "agentUsage.cacheHitRate", defaultMessage: "Cache hit {rate}" },
                    { rate: formatHitRate(totalCacheRatio) },
                  )}
                </span>
              ) : null}
            </div>
            {current?.total ? (
              <dl className="agent-context__dl">
                {([
                  [intl.formatMessage({ id: "agentUsage.total", defaultMessage: "Total tokens" }), count(current.total.totalTokens)],
                  [intl.formatMessage({ id: "agentUsage.input", defaultMessage: "Input" }), count(current.total.inputTokens)],
                  [intl.formatMessage({ id: "agentUsage.cached", defaultMessage: "Cached input" }), count(current.total.cachedInputTokens)],
                  [intl.formatMessage({ id: "agentUsage.output", defaultMessage: "Output" }), count(current.total.outputTokens)],
                  [intl.formatMessage({ id: "agentUsage.reasoning", defaultMessage: "Reasoning output" }), count(current.total.reasoningOutputTokens)],
                  [intl.formatMessage({ id: "agentUsage.lastRequest", defaultMessage: "Last request" }), lastRequestValue],
                ] as const).map(([rowLabel, value]) => (
                  <div key={rowLabel}>
                    <dt>{rowLabel}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="agent-context__note">
                {intl.formatMessage(
                  { id: "agentUsage.noTokenBreakdown", defaultMessage: "{agent} reports context window only, without cumulative token breakdown." },
                  { agent: formatProviderName(intl, current!.providerId) },
                )}
              </p>
            )}
          </div>

          {onOpenTokenUsage ? (
            <div className="agent-context__footer">
              <Button
                variant="ghost"
                size="sm"
                contentLayout="row"
                className="agent-context__settings-link"
                onClick={() => {
                  setOpen(false);
                  onOpenTokenUsage();
                }}
              >
                <span className="agent-context__settings-label">
                  {intl.formatMessage({ id: "agentUsage.viewAllTokenUsage", defaultMessage: "View all token usage in Settings" })}
                </span>
                <ChevronRightIcon size={14} aria-hidden="true" />
              </Button>
            </div>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
