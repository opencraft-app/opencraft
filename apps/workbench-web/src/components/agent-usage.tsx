import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useIntl } from "@opencraft/i18n/react";
import { Button } from "@opencraft/design-system-web/button";
import { GaugeIcon, ChevronDownIcon, ChevronUpIcon } from "@opencraft/design-system-web/action-icons";
import type { AgentUsageSnapshot, AgentProviderUsage, AgentUsageWindow } from "@opencraft/appserver-protocol";
import { useAppearanceTheme } from "../appearance-theme";
import { useAppServerHosts } from "../runtime/appserver-runtime-context";
import { requestMobileHaptic } from "../runtime/mobile-valdi-bridge";
import { useValdiTouchDensity } from "../runtime/valdi-touch-density";
import "./agent-usage.scss";
import "./valdi-surfaces.scss";

const LazyValdiTokenUsage = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function TokenUsageMount({ viewModel }: { readonly viewModel: import("@opencraft/design-system-web/valdi").TokenUsageProps }) {
    return (
      <mod.ValdiSurface
        component={mod.TokenUsageSurface}
        viewModel={viewModel}
        className="valdi-token-usage-surface"
        data-testid="valdi-token-usage-surface"
      />
    );
  }
  return { default: TokenUsageMount };
});

export interface UsageMachineOption {
  readonly hostId: string;
  readonly label: string;
  readonly remote: boolean;
}

export function AgentUsage({ hostId, threadId, busy }: { hostId: string; threadId: string | null; busy: boolean }) {
  const intl = useIntl();
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
      const label = host.kind === "local"
        ? (profile?.machineIdentity?.name || intl.formatMessage({ id: "agentUsage.localMachine", defaultMessage: "Local" }))
        : (profile?.machineIdentity?.name || profile?.displayName || host.label);
      items.push({ hostId: host.hostId, label, remote });
    }
    return items;
  }, [hosts, profiles, intl]);

  const effectiveHostId = machines.some(item => item.hostId === selectedHostId) ? selectedHostId : hostId;
  const subscribe = useCallback((listener: () => void) => agentRuntimes.subscribe(effectiveHostId, listener), [agentRuntimes, effectiveHostId]);
  const read = useCallback(() => agentRuntimes.getSnapshot(effectiveHostId).phase, [agentRuntimes, effectiveHostId]);
  const phase = useSyncExternalStore(subscribe, read, read);
  return (
    <AgentUsageView
      key={JSON.stringify([hostId, scope])}
      hostId={effectiveHostId}
      scope={scope}
      threadId={effectiveHostId === hostId ? threadId : null}
      busy={effectiveHostId === hostId ? busy : false}
      connected={phase === "ready"}
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
  const intl = useIntl(), [open, setOpen] = useState(false), [provider, setProvider] = useState(() => threadId?.startsWith("cursor_") ? "cursor" : "codex");
  const appearance = useAppearanceTheme();
  const touch = useValdiTouchDensity();
  const manualProvider = useRef(false);
  const force = useRef(false), previousBusy = useRef(busy);
  const query = useQuery({ queryKey: ["agent-usage", hostId, scope, threadId], enabled: connected,
    queryFn: () => { const fresh = force.current; force.current = false; return request({ ...(threadId ? { threadId } : {}), force: fresh }); },
    retry: false, staleTime: 30_000, refetchInterval: open ? 30_000 : false, refetchOnWindowFocus: false });
  useEffect(() => { if (previousBusy.current && !busy && connected) void query.refetch(); previousBusy.current = busy; }, [busy, connected, query.refetch]);
  useEffect(() => { if (!manualProvider.current && threadId) setProvider(threadId.startsWith("cursor_") ? "cursor" : "codex"); }, [threadId]);
  const data = query.data, current = data?.conversation;
  const count = useCallback((value: number | null | undefined) => value == null ? "—" : intl.formatNumber(value, { notation: "compact", maximumFractionDigits: 1 }), [intl]);
  const unknown = intl.formatMessage({ id: "agentUsage.unknown", defaultMessage: "Not reported" });
  const title = intl.formatMessage({ id: "agentUsage.title", defaultMessage: "Token usage" });
  const providerName = useCallback((id: string) => id === "codex" ? intl.formatMessage({ id: "onboard.agent.codex", defaultMessage: "Codex" })
    : id === "cursor" ? intl.formatMessage({ id: "onboard.agent.cursor", defaultMessage: "Cursor" }) : id, [intl]);
  const label = intl.formatMessage({ id: "agentUsage.current", defaultMessage: "This conversation" });
  const active = data?.providers.find(item => item.id === provider) ?? data?.providers[0];
  const context = current?.context;
  const percent = context ? context.usedTokens / context.limitTokens * 100 : null;
  const observedAt = active?.observedAt ?? current?.observedAt ?? data?.readAt;
  const refresh = useCallback(() => { force.current = true; void query.refetch(); }, [query.refetch]);
  const windowLabel = useCallback((window: AgentUsageWindow) => window.kind === "plan"
    ? intl.formatMessage({ id: "agentUsage.plan", defaultMessage: "Plan" }) : window.kind === "spend"
      ? window.scope === "team" ? intl.formatMessage({ id: "agentUsage.teamSpend", defaultMessage: "Team on-demand" }) : intl.formatMessage({ id: "agentUsage.spend", defaultMessage: "On-demand" }) : window.durationMinutes === null
        ? intl.formatMessage({ id: "agentUsage.limit", defaultMessage: "Limit" }) : window.durationMinutes >= 1440
          ? intl.formatMessage({ id: "agentUsage.days", defaultMessage: "{count} days" }, { count: window.durationMinutes / 1440 })
          : intl.formatMessage({ id: "agentUsage.hours", defaultMessage: "{count} hours" }, { count: window.durationMinutes / 60 }), [intl]);
  const notice = useCallback((value: AgentProviderUsage) => intl.formatMessage(value.status === "signedOut"
    ? { id: "agentUsage.signIn", defaultMessage: "Sign in to this Agent to view its limits." }
    : value.status === "expired" ? { id: "agentUsage.expired", defaultMessage: "The Agent sign-in has expired. Sign in again." }
      : { id: "agentUsage.unavailable", defaultMessage: "Could not refresh. Previously reported usage is shown when available." }), [intl]);
  const summary = context
    ? `${count(context.usedTokens)} / ${count(context.limitTokens)}`
    : current?.total
      ? count(current.total.totalTokens)
      : "—";
  const statusMessage = query.isPending && connected
    ? intl.formatMessage({ id: "agentUsage.loading", defaultMessage: "Reading usage…" })
    : query.isError || !connected
      ? intl.formatMessage({ id: "agentUsage.failed", defaultMessage: "Could not refresh usage. Try again when connected." })
      : active && active.status !== "ok"
        ? notice(active)
        : active?.status === "ok" && active.windows.length === 0
          ? intl.formatMessage({ id: "agentUsage.noLimits", defaultMessage: "This plan does not report usage limits." })
          : undefined;

  const providerList = useMemo(
    () =>
      (data?.providers ?? [{ id: "codex" }, { id: "cursor" }]).map((item) => ({
        id: item.id,
        title: providerName(item.id),
      })),
    [data?.providers],
  );

  const windows = useMemo(
    () =>
      (active?.windows ?? []).map((win, index) => ({
        id: String(index),
        label: windowLabel(win),
        progress: Math.min(1, Math.max(0, win.usedPercent / 100)),
        percentText: intl.formatNumber(win.usedPercent / 100, { style: "percent", maximumFractionDigits: 0 }),
        resetText: win.resetsAt
          ? intl.formatMessage(
              { id: "agentUsage.resets", defaultMessage: "Resets {time}" },
              { time: intl.formatDate(win.resetsAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) },
            )
          : unknown,
        costText: win.cost
          ? `${intl.formatNumber(win.cost.usedCents / 100, { style: "currency", currency: win.cost.currency })} / ${intl.formatNumber(win.cost.limitCents / 100, { style: "currency", currency: win.cost.currency })}`
          : undefined,
        warning: win.usedPercent >= 80,
      })),
    [active?.windows, intl, unknown, windowLabel],
  );

  const metrics = useMemo(
    () =>
      current?.total
        ? [
            { label: intl.formatMessage({ id: "agentUsage.total", defaultMessage: "Total tokens" }), value: count(current.total.totalTokens) },
            { label: intl.formatMessage({ id: "agentUsage.input", defaultMessage: "Input" }), value: count(current.total.inputTokens) },
            { label: intl.formatMessage({ id: "agentUsage.cached", defaultMessage: "Cached input" }), value: count(current.total.cachedInputTokens) },
            { label: intl.formatMessage({ id: "agentUsage.output", defaultMessage: "Output" }), value: count(current.total.outputTokens) },
            { label: intl.formatMessage({ id: "agentUsage.reasoning", defaultMessage: "Reasoning output" }), value: count(current.total.reasoningOutputTokens) },
            { label: intl.formatMessage({ id: "agentUsage.lastRequest", defaultMessage: "Last request" }), value: count(current.last?.totalTokens ?? null) },
          ]
        : [],
    [count, current?.last?.totalTokens, current?.total, intl],
  );

  const machineOptions = useMemo(
    () => machines?.map((m) => ({ id: m.hostId, title: m.label })),
    [machines],
  );

  const handleToggleOpen = useCallback(() => setOpen((value) => !value), []);
  const handleSelectProvider = useCallback((id: string) => {
    manualProvider.current = true;
    setProvider(id);
  }, []);
  const handleSelectMachine = useMemo(
    () => (onSelectMachine ? (id: string) => onSelectMachine(id) : undefined),
    [onSelectMachine],
  );
  const handleHaptic = useCallback((style: string) => {
    requestMobileHaptic(style === "warning" ? "warning" : style === "light" ? "light" : "selection");
  }, []);

  const viewModel = useMemo(
    (): import("@opencraft/design-system-web/valdi").TokenUsageProps => ({
      dark: appearance.resolvedTheme === "dark",
      touch,
      open,
      title,
      summary,
      machineLabel: intl.formatMessage({ id: "agentUsage.machineSelector", defaultMessage: "Machine" }),
      machines: machineOptions,
      selectedMachineId: selectedMachineHostId,
      providerLabel: intl.formatMessage({ id: "agentUsage.providers", defaultMessage: "Usage provider" }),
      providers: providerList,
      selectedProviderId: active?.id ?? provider,
      planText: active?.plan ?? undefined,
      accountText: active?.account ?? undefined,
      refreshLabel: intl.formatMessage({ id: "agentUsage.refresh", defaultMessage: "Refresh usage" }),
      refreshDisabled: !connected || query.isFetching,
      statusMessage,
      windows,
      conversationHeading: label,
      conversationProvider: current ? providerName(current.providerId) : undefined,
      contextLabel: context ? intl.formatMessage({ id: "agentUsage.context", defaultMessage: "Context window" }) : undefined,
      contextDetail: context ? `${summary} (${intl.formatNumber(percent! / 100, { style: "percent", maximumFractionDigits: 1 })})` : undefined,
      contextProgress: context ? Math.min(1, Math.max(0, context.usedTokens / context.limitTokens)) : undefined,
      conversationFallback: !context
        ? (threadId ? unknown : intl.formatMessage({ id: "agentUsage.openConversation", defaultMessage: "Open a conversation to view its usage." }))
        : undefined,
      metrics,
      observedAtText: observedAt
        ? intl.formatMessage({ id: "agentUsage.readAt", defaultMessage: "Read at {time}" }, { time: intl.formatTime(observedAt, { hour: "numeric", minute: "2-digit" }) })
        : undefined,
      onToggleOpen: handleToggleOpen,
      onSelectMachine: handleSelectMachine,
      onSelectProvider: handleSelectProvider,
      onRefresh: refresh,
      onHaptic: handleHaptic,
    }),
    [
      active?.account,
      active?.id,
      active?.plan,
      appearance.resolvedTheme,
      connected,
      context,
      current,
      handleHaptic,
      handleSelectMachine,
      handleSelectProvider,
      handleToggleOpen,
      intl,
      label,
      machineOptions,
      metrics,
      observedAt,
      open,
      percent,
      provider,
      providerList,
      query.isFetching,
      refresh,
      selectedMachineHostId,
      statusMessage,
      summary,
      threadId,
      title,
      touch,
      unknown,
      windows,
    ],
  );

  if (query.error && (query.error as { code?: unknown }).code === -32601) return null;

  const fallbackDisclosure = (
    <Button variant="ghost" size="accessory" className="agent-usage__disclosure" contentLayout="row" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <GaugeIcon size={16} aria-hidden="true" /><span>{title}</span>
      <span className="agent-usage__summary">{summary}</span>
      {open ? <ChevronDownIcon size={14} aria-hidden="true" /> : <ChevronUpIcon size={14} aria-hidden="true" />}
    </Button>
  );

  return (
    <section
      className="agent-usage"
      aria-label={title}
      data-agent-usage=""
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <Suspense fallback={fallbackDisclosure}>
        <LazyValdiTokenUsage viewModel={viewModel} />
      </Suspense>
    </section>
  );
}
