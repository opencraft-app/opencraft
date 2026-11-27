import { useIntl } from "@opencraft/i18n/react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AgentProviderUsage, AgentUsageSnapshot, AgentUsageWindow } from "@opencraft/appserver-protocol";
import { TOKEN_USAGE_CONFIGURE, TOKEN_USAGE_QUERY, type TokenUsageSnapshot, type TokenUsageTurnDetail } from "@opencraft/appserver-protocol/token-usage";
import { SettingsPageHeader } from "@opencraft/extension-react";
import { useAppearanceTheme } from "../appearance-theme";
import { useAppServerHosts } from "../runtime/appserver-runtime-context";
import { requestMobileHaptic } from "../runtime/mobile-valdi-bridge";
import { useValdiTouchDensity } from "./shell-navigation/valdi-sidebar-dock";
import { useWorkbenchPresentationActive } from "./workbench-presentation-activity";
import {
  compactTokens,
  dashboardMetrics,
  buildActivityGrid,
  buildActivityBars,
  modelShare,
  formatModelLabel,
  formatStateLabel,
} from "./token-usage-dashboard-data";
import "./valdi-surfaces.scss";

const LazyValdiTokenUsageDashboard = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function TokenUsageDashboardMount({
    viewModel,
  }: {
    readonly viewModel: import("@opencraft/design-system-web/valdi").TokenUsageDashboardProps;
  }) {
    return (
      <mod.ValdiSurface
        component={mod.TokenUsageDashboardSurface}
        viewModel={viewModel}
        className="valdi-token-usage-dashboard-surface"
        data-testid="valdi-token-usage-dashboard-surface"
      />
    );
  }
  return { default: TokenUsageDashboardMount };
});

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(Date.now());
}
function before(days: number) {
  const date = new Date(today() + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - days + 1);
  return date.toISOString().slice(0, 10);
}
function formatCount(value: string, locale: string) {
  try {
    return new Intl.NumberFormat(locale).format(BigInt(value));
  } catch {
    return value;
  }
}
function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? error.code : null;
}
function isUnsupportedMethodError(error: unknown): boolean {
  if (errorCode(error) === -32601) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unsupported method|method not found/iu.test(message);
}

export default function TokenUsageDashboard({ hostId }: { hostId: string }) {
  const intl = useIntl();
  const { agentRuntimes, threadAttention } = useAppServerHosts();
  const readScope = useCallback(() => threadAttention.getScope() ?? "anonymous", [threadAttention]);
  const accountScope = useSyncExternalStore(threadAttention.subscribe, readScope, readScope);
  return <TokenUsageDashboardView key={JSON.stringify([hostId, accountScope])} hostId={hostId} agentRuntimes={agentRuntimes} locale={intl.locale} />;
}

export function TokenUsageDashboardView({
  hostId,
  agentRuntimes,
  locale = "zh-CN",
}: {
  hostId: string;
  agentRuntimes: ReturnType<typeof useAppServerHosts>["agentRuntimes"];
  locale?: string;
}) {
  const intl = useIntl();
  const appearance = useAppearanceTheme();
  const touch = useValdiTouchDensity();
  const zh = locale.toLowerCase().startsWith("zh");
  const copy = useCallback((cn: string, en: string) => (zh ? cn : en), [zh]);
  const count = useCallback((value: string) => formatCount(value, locale), [locale]);
  const modelLabel = useCallback((key: string) => formatModelLabel(key, copy), [copy]);
  const stateLabel = useCallback((state: string) => formatStateLabel(state, copy), [copy]);
  const active = useWorkbenchPresentationActive();
  const subscribe = useCallback((listener: () => void) => agentRuntimes.subscribe(hostId, listener), [agentRuntimes, hostId]);
  const read = useCallback(() => agentRuntimes.getSnapshot(hostId).phase, [agentRuntimes, hostId]);
  const connection = useSyncExternalStore(subscribe, read, read);

  const [range, setRange] = useState("7");
  const [from, setFrom] = useState(() => before(7));
  const [through, setThrough] = useState(today);
  const [scope, setScope] = useState("self");
  const [actorId, setActor] = useState("");
  const [actorName, setActorName] = useState("");
  const [modelKey, setModel] = useState("");
  const [view, setView] = useState("threads");
  const [threadId, setThread] = useState("");
  const [snapshot, setSnapshot] = useState<TokenUsageSnapshot | null>(null);
  const [localSnapshot, setLocalSnapshot] = useState<AgentUsageSnapshot | null>(null);
  const [localProvider, setLocalProvider] = useState("codex");
  const [ledgerUnsupported, setLedgerUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [narrow, setNarrow] = useState(() => (typeof window !== "undefined" ? window.innerWidth < 720 : false));

  const [activityMode, setActivityMode] = useState<"daily" | "weekly" | "cumulative">("daily");

  const generation = useRef(0);
  const revision = useRef(-1);
  const inFlight = useRef(false);
  const page = useRef<HTMLDivElement>(null);
  const [reservedHeight, setReservedHeight] = useState<number>();
  const pendingScroll = useRef<{ top: number } | null>(null);
  const summaryReturn = useRef<{ top: number; cursor: string | null; thread: string } | null>(null);
  const viewport = () => page.current?.closest<HTMLElement>(".settings-page__viewport") ?? null;

  useEffect(() => {
    const node = page.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number" && width > 0) setNarrow(width < 640);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const requestKey = JSON.stringify([hostId, from, through, scope, actorId, modelKey, view, threadId, connection]);
  const latestKey = useRef(requestKey);
  latestKey.current = requestKey;
  const [displayKey, setDisplayKey] = useState(requestKey);
  const visible = snapshot && displayKey === requestKey ? snapshot : null;

  useEffect(() => {
    const epoch = ++generation.current;
    revision.current = -1;
    setSnapshot(null);
    setError(null);
    setDisplayKey(requestKey);
    inFlight.current = false;
    return () => {
      if (generation.current === epoch) generation.current++;
    };
  }, [requestKey]);

  useEffect(() => {
    if (!active) return;
    const epoch = generation.current;
    const key = requestKey;
    let live = true;
    const loadLocalUsage = async (forceRefresh: boolean) => {
      try {
        const usage = await agentRuntimes.request(hostId, "opencraft/agents/usage", { force: forceRefresh });
        if (!live || epoch !== generation.current) return;
        setLocalSnapshot(usage);
        setError(null);
      } catch (localCause) {
        if (!live || epoch !== generation.current) return;
        setLocalSnapshot(null);
        if (isUnsupportedMethodError(localCause)) {
          setError(copy("此执行服务暂不支持 Token 统计。", "This Host does not support token statistics."));
        } else {
          setError(copy("刷新失败。显示的数据可能已过期，请重试。", "Refresh failed. Displayed usage may be stale. Try again."));
        }
      }
    };
    const load = async () => {
      if (!live || inFlight.current) return;
      inFlight.current = true;
      setLoading(true);
      try {
        if (ledgerUnsupported) {
          await loadLocalUsage(refresh > 0);
          return;
        }
        const result = await agentRuntimes.request(hostId, TOKEN_USAGE_QUERY, {
          from,
          through,
          scope,
          ...(scope === "team" && actorId ? { actorId } : {}),
          ...(modelKey ? { modelKey } : {}),
          view: threadId ? "turns" : view,
          ...(threadId ? { threadId } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 50,
        });
        if (!live || epoch !== generation.current || latestKey.current !== key) return;
        if (result.snapshotRevision < revision.current) return;
        revision.current = result.snapshotRevision;
        setSnapshot(result);
        setLocalSnapshot(null);
        setDisplayKey(key);
        setError(null);
      } catch (cause) {
        if (!live || epoch !== generation.current || latestKey.current !== key) return;
        const code = errorCode(cause);
        if (code === 401 || code === 403) {
          setSnapshot(null);
          setError(code === 401 ? copy("请登录后查看用量。", "Sign in to view usage.") : copy("当前身份无权查看此范围。", "You cannot view this usage scope."));
        } else if (code === 409) {
          setCursor(null);
          setRefresh((n) => n + 1);
          setError(copy("数据已更新，正在重取第一页。", "Usage changed. Reloading the first page."));
        } else {
          try {
            const usage = await agentRuntimes.request(hostId, "opencraft/agents/usage", { force: refresh > 0 });
            if (!live || epoch !== generation.current) return;
            setSnapshot(null);
            setLedgerUnsupported(true);
            setLocalSnapshot(usage);
            setError(null);
          } catch {
            if (!live || epoch !== generation.current || latestKey.current !== key) return;
            if (isUnsupportedMethodError(cause)) {
              setSnapshot(null);
              setError(copy("此执行服务暂不支持 Token 统计。", "This Host does not support token statistics."));
            } else {
              setError(copy("刷新失败。显示的数据可能已过期，请重试。", "Refresh failed. Displayed usage may be stale. Try again."));
            }
          }
        }
      } finally {
        if (live && epoch === generation.current) {
          inFlight.current = false;
          setLoading(false);
        }
      }
    };
    void load();
    const timer = cursor ? null : setInterval(() => void load(), ledgerUnsupported ? 30_000 : 5_000);
    return () => {
      live = false;
      if (timer) clearInterval(timer);
      inFlight.current = false;
    };
  }, [agentRuntimes, requestKey, hostId, from, through, scope, actorId, modelKey, view, threadId, cursor, refresh, active, ledgerUnsupported, copy]);

  const configure = useCallback(async (enabled: boolean) => {
    if (loading) return;
    const epoch = generation.current;
    const key = latestKey.current;
    const current = () => epoch === generation.current && key === latestKey.current;
    setLoading(true);
    try {
      await agentRuntimes.request(hostId, TOKEN_USAGE_CONFIGURE, { enabled });
      if (!current()) return;
      setCursor(null);
      setRefresh((n) => n + 1);
    } catch {
      if (current()) setError(copy("计量设置未能保存，请重试。", "Could not save collection settings. Try again."));
    } finally {
      if (current()) setLoading(false);
    }
  }, [agentRuntimes, copy, hostId, loading]);

  useLayoutEffect(() => {
    if (reservedHeight !== undefined && pendingScroll.current) {
      const owner = viewport();
      if (owner) owner.scrollTop = pendingScroll.current.top;
    }
  }, [requestKey, reservedHeight]);

  useLayoutEffect(() => {
    if (!visible || loading || !pendingScroll.current) return;
    if (reservedHeight !== undefined) {
      setReservedHeight(undefined);
      return;
    }
    const position = pendingScroll.current;
    pendingScroll.current = null;
    const owner = viewport();
    if (owner) owner.scrollTop = position.top;
  }, [visible, loading, reservedHeight]);

  const change = useCallback((action: () => void, nextCursor: string | null = null) => {
    generation.current++;
    inFlight.current = false;
    setReservedHeight(page.current?.getBoundingClientRect().height);
    pendingScroll.current = { top: viewport()?.scrollTop ?? 0 };
    setLoading(true);
    action();
    setCursor(nextCursor);
  }, []);

  const selectRange = useCallback((value: string) => {
    setRange(value);
    if (value === "7" || value === "30") {
      change(() => {
        setFrom(before(Number(value)));
        setThrough(today());
      });
    }
  }, [change]);

  const openThread = useCallback((id: string) => {
    summaryReturn.current = { top: viewport()?.scrollTop ?? 0, cursor, thread: id };
    change(() => setThread(id));
  }, [change, cursor]);

  const returnToSummary = useCallback(() => {
    const saved = summaryReturn.current;
    change(() => setThread(""), saved?.cursor ?? null);
    if (saved) pendingScroll.current = { top: saved.top };
  }, [change]);

  const choosePerson = useCallback((id: string, name: string) =>
    change(() => {
      setActor(id);
      setActorName(name);
      setView("threads");
      setThread("");
    }), [change]);

  const handleHaptic = useCallback((style: string) => {
    requestMobileHaptic(style === "warning" ? "warning" : style === "light" ? "light" : "selection");
  }, []);

  const handleRefresh = useCallback(() => {
    setCursor(null);
    setRefresh((n) => n + 1);
  }, []);

  const providerName = useCallback((id: string) =>
    id === "codex" ? intl.formatMessage({ id: "onboard.agent.codex", defaultMessage: "Codex" })
      : id === "cursor" ? intl.formatMessage({ id: "onboard.agent.cursor", defaultMessage: "Cursor" }) : id, [intl]);

  const windowLabel = useCallback((window: AgentUsageWindow) => window.kind === "plan"
    ? intl.formatMessage({ id: "agentUsage.plan", defaultMessage: "Plan" })
    : window.kind === "spend"
      ? (window.scope === "team"
          ? intl.formatMessage({ id: "agentUsage.teamSpend", defaultMessage: "Team on-demand" })
          : intl.formatMessage({ id: "agentUsage.spend", defaultMessage: "On-demand" }))
      : window.durationMinutes === null
        ? intl.formatMessage({ id: "agentUsage.limit", defaultMessage: "Limit" })
        : window.durationMinutes >= 1440
          ? intl.formatMessage({ id: "agentUsage.days", defaultMessage: "{count} days" }, { count: window.durationMinutes / 1440 })
          : intl.formatMessage({ id: "agentUsage.hours", defaultMessage: "{count} hours" }, { count: window.durationMinutes / 60 }), [intl]);

  const providerNotice = useCallback((value: AgentProviderUsage) => intl.formatMessage(value.status === "signedOut"
    ? { id: "agentUsage.signIn", defaultMessage: "Sign in to this Agent to view its limits." }
    : value.status === "expired" ? { id: "agentUsage.expired", defaultMessage: "The Agent sign-in has expired. Sign in again." }
      : { id: "agentUsage.unavailable", defaultMessage: "Could not refresh. Previously reported usage is shown when available." }), [intl]);

  const localUsageSection = useMemo((): import("@opencraft/design-system-web/valdi").TokenUsageLocalSection | undefined => {
    if (!localSnapshot) return undefined;
    const activeProvider = localSnapshot.providers.find(item => item.id === localProvider) ?? localSnapshot.providers[0];
    const providerList = (localSnapshot.providers.length ? localSnapshot.providers : [{ id: "codex" }, { id: "cursor" }]).map(item => ({
      id: item.id,
      title: providerName(item.id),
    }));
    const unknownText = intl.formatMessage({ id: "agentUsage.unknown", defaultMessage: "Not reported" });
    const statusMessage = activeProvider && activeProvider.status !== "ok"
      ? providerNotice(activeProvider)
      : activeProvider?.status === "ok" && activeProvider.windows.length === 0
        ? intl.formatMessage({ id: "agentUsage.noLimits", defaultMessage: "This plan does not report usage limits." })
        : undefined;
    const windows = (activeProvider?.windows ?? []).map((win, index) => ({
      id: String(index),
      label: windowLabel(win),
      progress: Math.min(1, Math.max(0, win.usedPercent / 100)),
      percentText: intl.formatNumber(win.usedPercent / 100, { style: "percent", maximumFractionDigits: 0 }),
      resetText: win.resetsAt
        ? intl.formatMessage(
            { id: "agentUsage.resets", defaultMessage: "Resets {time}" },
            { time: intl.formatDate(win.resetsAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) },
          )
        : unknownText,
      costText: win.cost
        ? `${intl.formatNumber(win.cost.usedCents / 100, { style: "currency", currency: win.cost.currency })} / ${intl.formatNumber(win.cost.limitCents / 100, { style: "currency", currency: win.cost.currency })}`
        : undefined,
      warning: win.usedPercent >= 80,
    }));
    const observedAt = activeProvider?.observedAt ?? localSnapshot.readAt;
    return {
      providerLabel: intl.formatMessage({ id: "agentUsage.providers", defaultMessage: "Usage provider" }),
      providers: providerList,
      selectedProviderId: activeProvider?.id ?? localProvider,
      planText: activeProvider?.plan ?? undefined,
      accountText: activeProvider?.account ?? undefined,
      quotaGroupTitle: copy("本机 Agent 额度", "Local Agent quota"),
      quotaGroupDescription: copy("实时读取本机已登录 Agent 的套餐与用量窗口。", "Live plan and usage windows from signed-in local Agents."),
      statusMessage,
      windows,
      conversationGroupTitle: intl.formatMessage({ id: "agentUsage.current", defaultMessage: "This conversation" }),
      conversationFallback: intl.formatMessage({ id: "agentUsage.openConversation", defaultMessage: "Open a conversation to view its usage." }),
      metrics: [],
      observedAtText: observedAt
        ? intl.formatMessage({ id: "agentUsage.readAt", defaultMessage: "Read at {time}" }, { time: intl.formatTime(observedAt, { hour: "numeric", minute: "2-digit" }) })
        : undefined,
      onSelectProvider: setLocalProvider,
    };
  }, [copy, intl, localProvider, localSnapshot, providerName, providerNotice, windowLabel]);

  const ledgerSection = useMemo((): import("@opencraft/design-system-web/valdi").TokenUsageLedgerSection | undefined => {
    if (ledgerUnsupported && !visible) return undefined;
    const modelOptions = [
      { id: "", title: copy("全部模型", "All models") },
      ...(visible?.models ?? []).map((m) => ({ id: m.key, title: modelLabel(m.key) })),
      ...(modelKey && !(visible?.models ?? []).some((m) => m.key === modelKey) ? [{ id: modelKey, title: modelLabel(modelKey) }] : []),
    ];
    const scopeOptions = [
      { id: "self", title: copy("我的用量", "My usage") },
      ...(visible?.canQueryTeam || scope === "team" ? [{ id: "team", title: copy("团队用量", "Team usage") }] : []),
    ];
    const rangeOptions = [
      { id: "7", title: copy("近 7 日", "Last 7 days") },
      { id: "30", title: copy("近 30 日", "Last 30 days") },
      { id: "custom", title: copy("自定义", "Custom") },
    ];
    const metrics = visible ? dashboardMetrics(visible) : null;
    const grid = visible ? buildActivityGrid(visible.daily, from, through, locale) : null;
    const bars = visible ? buildActivityBars(visible.daily, from, through, activityMode === "cumulative" ? "cumulative" : "weekly", locale) : [];
    const maxBar = bars.reduce((n, b) => (BigInt(b.tokens) > n ? BigInt(b.tokens) : n), 0n);
    const details = visible?.view === "turns" ? (visible.rows as TokenUsageTurnDetail[]) : null;
    const lastSource = visible?.coverage?.lastSourceSuccessAt ?? visible?.diagnostics?.lastSourceSuccessAt ?? null;
    const summaryTitle = scope === "self"
      ? copy("我的分摊用量", "My allocated usage")
      : actorId
        ? copy(`${actorName} 的分摊用量`, `${actorName}’s allocated usage`)
        : copy("团队用量", "Team usage");
    const detailTitle = threadId
      ? copy("会话的轮次明细", "Conversation turn details")
      : view === "threads"
        ? copy("会话汇总", "Conversations")
        : view === "actors"
          ? copy("人员汇总", "People")
          : copy("轮次明细", "Turn details");

    return {
      scopeLabel: copy("用量范围", "Scope"),
      scopeValue: scope,
      scopeOptions,
      rangeLabel: copy("时间范围", "Range"),
      rangeValue: range,
      rangeOptions,
      customRange: range === "custom" ? {
        fromLabel: copy("开始日", "From"),
        fromValue: from,
        throughLabel: copy("结束日", "Through"),
        throughValue: through,
        onChangeFrom: (val) => { setRange("custom"); change(() => setFrom(val)); },
        onChangeThrough: (val) => { setRange("custom"); change(() => setThrough(val)); },
      } : undefined,
      modelLabel: copy("模型", "Model"),
      modelValue: modelKey,
      modelOptions,
      summaryTitle: visible ? summaryTitle : undefined,
      summarySubtitle: visible ? copy("按轮次参与人均分 · 按轮次开始日统计 · Asia/Shanghai", "Shared equally by turn participants · Grouped by turn start date · Asia/Shanghai") : undefined,
      partialBadge: visible?.coverage.partial ? copy("部分数据", "Partial data") : undefined,
      summaryMeta: visible ? copy(`${visible.summary.threads ?? "—"} 个会话 · ${visible.summary.turns} 个轮次`, `${visible.summary.threads ?? "—"} conversations · ${visible.summary.turns} turns`) : undefined,
      metrics: metrics ? [
        { id: "settled", value: compactTokens(metrics.settled, locale), label: copy("已结算 Token", "Settled tokens"), detail: copy(`所选范围总量 ${count(metrics.total)}`, `Total in range ${count(metrics.total)}`) },
        { id: "peak", value: compactTokens(metrics.peak, locale), label: copy("单日峰值", "Peak tokens"), detail: metrics.peakDay ?? "—" },
        { id: "turns", value: metrics.settledTurns === null ? "—" : count(String(metrics.settledTurns)), label: copy("已结算轮次", "Settled turns"), detail: copy(`共 ${visible!.summary.turns} 轮`, `${visible!.summary.turns} turns total`) },
        { id: "longest", value: String(metrics.longestStreak), label: copy("最长连续活跃天数", "Longest streak"), detail: copy("天", "days") },
        { id: "current", value: String(metrics.currentStreak), label: copy("当前连续活跃天数", "Current streak"), detail: copy("天", "days") },
      ] : undefined,
      activityTitle: visible ? copy("Token 活跃度", "Token activity") : undefined,
      activitySubtitle: visible ? copy("按轮次开始日统计", "Grouped by turn start date") : undefined,
      activityMode,
      activityModeOptions: [
        { id: "daily", title: copy("按日", "Daily") },
        { id: "weekly", title: copy("按周", "Weekly") },
        { id: "cumulative", title: copy("累计", "Cumulative") },
      ],
      weekdayLabels: zh ? ["一", "", "三", "", "五", "", "日"] : ["Mon", "", "Wed", "", "Fri", "", "Sun"],
      heatmapWeeks: grid ? grid.columns.map((week, i) => ({
        key: `w-${i}`,
        monthLabel: grid.monthLabels.find((x) => x.index === i)?.label,
        cells: week.map((cell) => ({
          date: cell.date,
          level: cell.level,
          outside: cell.state === "outside",
          summaryText: `${cell.date} · ${count(cell.tokens)} ${copy("Token", "tokens")} · ${cell.turns} ${copy("轮", "turns")}`,
        })),
      })) : undefined,
      defaultCellHint: copy("选择方格查看当日用量", "Choose a cell for daily usage"),
      bars: bars.map((b) => ({
        key: b.key,
        label: b.label,
        progress: maxBar === 0n ? 0 : Number((BigInt(b.tokens) * 1000n) / maxBar) / 1000,
        valueText: compactTokens(b.tokens, locale),
      })),
      modelSectionTitle: visible ? copy("模型用量", "Usage by model") : undefined,
      modelEmptyText: copy("该范围暂无模型用量记录。", "No model usage in this range."),
      modelCards: visible?.models.map((m) => ({
        key: m.key,
        label: modelLabel(m.key),
        tokensText: compactTokens(m.tokens, locale),
        turnsText: `${m.turns} ${copy("轮", "turns")}`,
        progress: modelShare(m.tokens, visible.summary.tokens) / 100,
      })),
      detailTitle: visible ? detailTitle : undefined,
      detailEmptyText: copy("该筛选范围暂无记录。", "No records match these filters."),
      backToSummaryLabel: threadId ? copy("返回汇总", "Back to summary") : undefined,
      viewLabel: copy("列表", "View"),
      viewValue: view,
      viewOptions: [
        { id: "threads", title: copy("会话汇总", "Conversations") },
        { id: "turns", title: copy("轮次明细", "Turn details") },
        ...(visible?.canQueryTeam ? [{ id: "actors", title: copy("人员汇总", "People") }] : []),
      ],
      clearActorLabel: actorId ? copy("清除人员筛选", "Clear person filter") : undefined,
      rows: visible && !details ? visible.rows.flatMap((row) => ("key" in row ? [{
        key: row.key,
        title: view === "actors" ? (row.label ?? copy("未知人员", "Unknown person")) : row.key,
        tokensText: compactTokens(row.tokens, locale),
        turnsText: `${row.turns} ${copy("轮", "turns")}`,
        interactive: view === "threads" || view === "actors",
      }] : [])) : undefined,
      turnRows: details?.map((t) => ({
        key: t.turnId,
        title: t.turnId,
        subtitle: `${new Date(t.startedAt).toLocaleString(locale)} · ${stateLabel(t.allocationState)}`,
        detail: copy(
          `分摊 ${count(t.allocatedTokens)} · 原始 ${t.rawTokens === null ? "未知" : count(t.rawTokens)} · ${t.participantCount} 人`,
          `Allocated ${count(t.allocatedTokens)} · Raw ${t.rawTokens === null ? "Unknown" : count(t.rawTokens)} · ${t.participantCount} participants`,
        ),
      })),
      nextPageLabel: visible?.nextCursor ? copy("下一页", "Next page") : undefined,
      firstPageLabel: cursor ? copy("回到第一页", "First page") : undefined,
      diagnosticsTitle: visible ? copy("高级账本与采集诊断", "Advanced ledger & collection diagnostics") : undefined,
      diagnosticsToggleLabel: copy("查看运行诊断", "View runtime diagnostics"),
      collectionStatusText: visible ? (visible.coverage.enabled ? copy("计量运行中", "Collection active") : copy("计量已暂停", "Collection paused")) : undefined,
      collectionActionLabel: visible?.canConfigure ? (visible.coverage.enabled ? copy("暂停计量", "Pause collection") : copy("启用计量", "Enable collection")) : undefined,
      diagnosticsLines: visible ? [
        `${copy("采集始于", "Collection began")} ${new Date(visible.coverage.enabledAt).toLocaleString(locale)}`,
        `${copy("最近成功采集", "Last successful collection")}: ${lastSource === null ? copy("暂无成功记录", "No successful collection yet") : new Date(lastSource).toLocaleString(locale)}`,
        copy(`修订 ${visible.snapshotRevision} · 截至 ${new Date(visible.asOf).toLocaleString(locale)} · ${visible.timezone} · ${visible.policyVersion}`, `Revision ${visible.snapshotRevision} · As of ${new Date(visible.asOf).toLocaleString(locale)} · ${visible.timezone} · ${visible.policyVersion}`),
        copy(`未知模型轮次 ${visible.coverage.unknownModelTurns}`, `${visible.coverage.unknownModelTurns} turns with unknown model`),
      ] : undefined,
      diagnosticsPartialNotice: visible?.coverage.partial ? copy(
        `部分数据尚未齐全：${visible.coverage.missingUsage} 个轮次用量不完整，${visible.coverage.openGapIncidents ?? visible.coverage.openGaps} 个未恢复缺口（${visible.coverage.openGaps} 条失败记录）。`,
        `Partial coverage: ${visible.coverage.missingUsage} turns have incomplete usage; ${visible.coverage.openGapIncidents ?? visible.coverage.openGaps} open gaps (${visible.coverage.openGaps} gap records).`,
      ) : undefined,
      categoryStats: visible ? [
        { label: copy("已结算", "Settled"), value: count(visible.summary.categories.settled ?? "0") },
        { label: copy("暂定", "Provisional"), value: count(visible.summary.categories.provisional ?? "0") },
        { label: copy("待归属", "Pending attribution"), value: count(visible.summary.categories.pending ?? "0") },
        { label: copy("系统", "System"), value: count(visible.summary.categories.system ?? "0") },
        { label: copy("未知", "Unknown"), value: count(visible.summary.categories.unknown ?? "0") },
      ] : undefined,
      onChangeScope: (nextScope) => change(() => { setScope(nextScope); setActor(""); setActorName(""); }),
      onChangeRange: selectRange,
      onChangeModel: (val) => change(() => setModel(val)),
      onChangeActivityMode: (mode) => setActivityMode(mode as typeof activityMode),
      onChangeView: (val) => change(() => setView(val)),
      onSelectRow: (key) => {
        if (view === "threads") openThread(key);
        else if (view === "actors") {
          const row = visible?.rows.find((r) => "key" in r && r.key === key);
          choosePerson(key, (row && "label" in row ? row.label : undefined) ?? copy("未知人员", "Unknown person"));
        }
      },
      onBackToSummary: returnToSummary,
      onClearActor: () => choosePerson("", ""),
      onNextPage: () => { if (visible?.nextCursor) change(() => {}, visible.nextCursor); },
      onFirstPage: () => change(() => {}),
      onToggleCollection: () => { if (visible) void configure(!visible.coverage.enabled); },
    };
  }, [
    activityMode, actorId, actorName, change, choosePerson, configure, copy, count, cursor, from, ledgerUnsupported,
    locale, modelKey, modelLabel, openThread, range, returnToSummary, scope, selectRange, stateLabel, threadId, through,
    view, visible, zh,
  ]);

  const title = copy("Token 用量", "Token usage");
  const subtitle = ledgerUnsupported
    ? copy("查看当前执行主机上的 Agent 套餐额度与会话用量。", "Inspect Agent quota windows and session usage on the active host.")
    : copy("按轮次参与人均分 · 按轮次开始日统计 · Asia/Shanghai", "Shared equally by turn participants · Grouped by turn start date · Asia/Shanghai");

  const viewModel = useMemo(
    (): import("@opencraft/design-system-web/valdi").TokenUsageDashboardProps => ({
      dark: appearance.resolvedTheme === "dark",
      touch,
      narrow,
      title,
      subtitle,
      refreshLabel: copy("刷新", "Refresh"),
      loading,
      loadingText: copy("正在读取用量…", "Loading usage…"),
      errorMessage: error ?? undefined,
      localUsage: localUsageSection,
      ledger: ledgerSection,
      onRefresh: handleRefresh,
      onHaptic: handleHaptic,
    }),
    [appearance.resolvedTheme, copy, error, handleHaptic, handleRefresh, ledgerSection, loading, localUsageSection, narrow, subtitle, title, touch],
  );

  return (
    <div ref={page} className="valdi-token-usage-dashboard-host" aria-busy={loading} style={{ minHeight: reservedHeight }}>
      <Suspense fallback={<SettingsPageHeader title={title} description={subtitle} />}>
        <LazyValdiTokenUsageDashboard viewModel={viewModel} />
      </Suspense>
    </div>
  );
}
