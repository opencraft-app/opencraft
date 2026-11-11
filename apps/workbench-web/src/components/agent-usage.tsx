import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useIntl } from "@opencraft/i18n/react";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { AgentBrandIcon, GaugeIcon, RefreshIcon, ChevronDownIcon, ChevronUpIcon } from "@opencraft/design-system-web/action-icons";
import type { AgentUsageSnapshot, AgentProviderUsage, AgentUsageWindow } from "@opencraft/appserver-protocol";
import { useAppServerHosts } from "../runtime/appserver-runtime-context";
import "./agent-usage.scss";

export function AgentUsage({ hostId, threadId, busy }: { hostId: string; threadId: string | null; busy: boolean }) {
  const { agentRuntimes, threadAttention } = useAppServerHosts();
  const subscribe = useCallback((listener: () => void) => agentRuntimes.subscribe(hostId, listener), [agentRuntimes, hostId]);
  const read = useCallback(() => agentRuntimes.getSnapshot(hostId).phase, [agentRuntimes, hostId]);
  const phase = useSyncExternalStore(subscribe, read, read);
  const scope = useSyncExternalStore(threadAttention.subscribe, () => threadAttention.getScope() ?? "anonymous");
  return <AgentUsageView key={JSON.stringify([hostId, scope])} hostId={hostId} scope={scope} threadId={threadId} busy={busy} connected={phase === "ready"}
    request={params => agentRuntimes.request(hostId, "opencraft/agents/usage", params)} />;
}
export function AgentUsageView({ hostId, scope = "fixture", threadId, busy, connected, request }: {
  hostId: string; scope?: string; threadId: string | null; busy: boolean; connected: boolean;
  request(params: { threadId?: string; force?: boolean }): Promise<AgentUsageSnapshot>;
}) {
  const intl = useIntl(), [open, setOpen] = useState(false), [provider, setProvider] = useState(() => threadId?.startsWith("cursor_") ? "cursor" : "codex");
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
