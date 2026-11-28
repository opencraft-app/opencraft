import { useQueryClient } from "@tanstack/react-query";
import { useIntl } from "@opencraft/i18n/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AgentProviderUsage, AgentUsageSnapshot, AgentUsageWindow } from "@opencraft/appserver-protocol";
import {
  TOKEN_USAGE_CONFIGURE,
  TOKEN_USAGE_EXTENSION,
  TOKEN_USAGE_QUERY,
  type TokenUsageSnapshot,
  type TokenUsageTurnDetail,
} from "@opencraft/appserver-protocol/token-usage";
import {
  TokenUsageDashboardSurface,
  ValdiSurface,
  type TokenUsageDashboardProps,
  type TokenUsageGatewaySection,
  type TokenUsageLedgerSection,
  type TokenUsageLocalSection,
} from "@opencraft/design-system-web/valdi";
import { useAppearanceTheme } from "../appearance-theme";
import {
  useAppServerHosts,
  useHostActiveThreadId,
  useHostExtensionCapability,
} from "../runtime/appserver-runtime-context";
import { requestMobileHaptic } from "../runtime/mobile-valdi-bridge";
import { buildUsageMachineOptions, type UsageMachineOption } from "./agent-usage-machines";
import { useValdiTouchDensity } from "./shell-navigation/valdi-sidebar-dock";
import { useWorkbenchPresentationActive } from "./workbench-presentation-activity";
import {
  buildActivityBars,
  buildActivityGrid,
  buildWeekdayLabels,
  compactTokens,
  dashboardMetrics,
  dateBeforeDays,
  formatDateInTimeZone,
  formatModelLabel,
  formatStateLabel,
  modelShare,
  parseModelGatewayBudgetSnapshot,
  resolveTokenUsageLedgerCapability,
  tokenUsageReplica,
  type ModelGatewayBudgetSnapshot,
} from "./token-usage-dashboard-data";
import "./valdi-surfaces.scss";

const MODEL_GATEWAY_ENDPOINT = "/__opencraft_model_gateway";
const DEFAULT_TIMEZONE =
  (typeof Intl !== "undefined" && Intl.DateTimeFormat().resolvedOptions().timeZone) || "UTC";

function formatCount(value: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale).format(BigInt(value));
  } catch {
    return value;
  }
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : null;
}

function isUnsupportedMethodError(error: unknown): boolean {
  if (errorCode(error) === -32601) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unsupported method|method not found|不支持该操作/iu.test(message);
}

export default function TokenUsageDashboard({
  hostId,
  onManageModels,
}: {
  readonly hostId: string;
  readonly onManageModels?: () => void;
}) {
  const intl = useIntl();
  const { agentRuntimes, threadAttention, hosts, profiles } = useAppServerHosts();
  const readScope = useCallback(() => threadAttention.getScope() ?? "anonymous", [threadAttention]);
  const accountScope = useSyncExternalStore(threadAttention.subscribe, readScope, readScope);
  const [selectedHostId, setSelectedHostId] = useState(hostId);

  useEffect(() => {
    setSelectedHostId(hostId);
  }, [hostId]);

  const hostIdsKey = hosts.map((h) => h.hostId).join("\0");
  const subscribeAllHosts = useCallback(
    (listener: () => void) => {
      const cleanups = hosts.map((h) => agentRuntimes.subscribe(h.hostId, listener));
      return () => {
        for (const cleanup of cleanups) cleanup();
      };
    },
    [agentRuntimes, hostIdsKey],
  );
  const readHostPhases = useCallback(
    () => hosts.map((h) => `${h.hostId}:${agentRuntimes.getSnapshot(h.hostId).phase}`).join("\0"),
    [agentRuntimes, hostIdsKey],
  );
  const hostPhases = useSyncExternalStore(subscribeAllHosts, readHostPhases, readHostPhases);

  const machines = useMemo<readonly UsageMachineOption[]>(
    () =>
      buildUsageMachineOptions({
        hosts,
        profiles,
        getPhase: (id) => agentRuntimes.getSnapshot(id).phase,
        localFallbackLabel: intl.formatMessage({ id: "agentUsage.localMachine", defaultMessage: "Local" }),
      }),
    [agentRuntimes, hostPhases, hosts, intl, profiles],
  );

  const effectiveHostId = machines.some((m) => m.hostId === selectedHostId) ? selectedHostId : hostId;
  const ledgerExtension = useHostExtensionCapability(effectiveHostId, TOKEN_USAGE_EXTENSION);
  const activeThreadId = useHostActiveThreadId(effectiveHostId);

  return (
    <TokenUsageDashboardView
      key={JSON.stringify([effectiveHostId, accountScope])}
      hostId={effectiveHostId}
      accountScope={accountScope}
      activeThreadId={activeThreadId}
      ledgerExtension={ledgerExtension}
      machines={machines.length > 1 ? machines : undefined}
      onSelectMachine={machines.length > 1 ? setSelectedHostId : undefined}
      onManageModels={onManageModels}
      agentRuntimes={agentRuntimes}
      locale={intl.locale}
    />
  );
}

export function TokenUsageDashboardView({
  hostId,
  accountScope = "anonymous",
  activeThreadId = null,
  ledgerExtension,
  machines,
  onSelectMachine,
  onManageModels,
  agentRuntimes,
  locale = "zh-CN",
  fetcher = globalThis.fetch,
}: {
  readonly hostId: string;
  readonly accountScope?: string;
  readonly activeThreadId?: string | null;
  readonly ledgerExtension?: Readonly<Record<string, unknown>> | null;
  readonly machines?: readonly UsageMachineOption[];
  readonly onSelectMachine?: (hostId: string) => void;
  readonly onManageModels?: () => void;
  readonly agentRuntimes: ReturnType<typeof useAppServerHosts>["agentRuntimes"];
  readonly locale?: string;
  readonly fetcher?: typeof fetch;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const appearance = useAppearanceTheme();
  const touch = useValdiTouchDensity();
  const active = useWorkbenchPresentationActive();

  const subscribe = useCallback(
    (listener: () => void) => agentRuntimes.subscribe(hostId, listener),
    [agentRuntimes, hostId],
  );
  const read = useCallback(() => agentRuntimes.getSnapshot(hostId).phase, [agentRuntimes, hostId]);
  const connection = useSyncExternalStore(subscribe, read, read);

  const capability = useMemo(() => resolveTokenUsageLedgerCapability(ledgerExtension), [ledgerExtension]);
  const effectiveTimeZone = capability.timezone ?? DEFAULT_TIMEZONE;

  const [range, setRange] = useState("7");
  const [from, setFrom] = useState(() => dateBeforeDays(7, effectiveTimeZone));
  const [through, setThrough] = useState(() => formatDateInTimeZone(effectiveTimeZone));
  const [scope, setScope] = useState("self");
  const [actorId, setActor] = useState("");
  const [actorName, setActorName] = useState("");
  const [modelKey, setModel] = useState("");
  const [view, setView] = useState("threads");
  const [threadId, setThread] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [activityMode, setActivityMode] = useState<"daily" | "weekly" | "cumulative">("daily");
  const [localProvider, setLocalProvider] = useState(() =>
    activeThreadId?.startsWith("cursor_") ? "cursor" : "codex",
  );
  const [narrow, setNarrow] = useState(() => (typeof window !== "undefined" ? window.innerWidth < 720 : false));

  const queryKey = JSON.stringify([hostId, from, through, scope, actorId, modelKey, view, threadId, cursor ?? ""]);

  // Hydrate initial local usage synchronously from replica or existing sidebar TanStack Query cache.
  const initialLocalUsage = useMemo((): AgentUsageSnapshot | null => {
    const fromReplica = tokenUsageReplica.readLocalUsage(accountScope, hostId);
    if (fromReplica) return fromReplica;
    const cachedQueries = queryClient.getQueriesData<AgentUsageSnapshot>({
      queryKey: ["agent-usage", hostId, accountScope],
    });
    for (const [, data] of cachedQueries) {
      if (data) {
        tokenUsageReplica.writeLocalUsage(accountScope, hostId, data);
        return data;
      }
    }
    return null;
  }, [accountScope, hostId, queryClient]);

  const [ledgerSnapshot, setLedgerSnapshot] = useState<TokenUsageSnapshot | null>(() =>
    tokenUsageReplica.readLedger(accountScope, hostId, queryKey),
  );
  const [localSnapshot, setLocalSnapshot] = useState<AgentUsageSnapshot | null>(initialLocalUsage);
  const [gatewaySnapshot, setGatewaySnapshot] = useState<ModelGatewayBudgetSnapshot | null>(
    () => tokenUsageReplica.readGateway(accountScope) ?? null,
  );
  const [fallbackLedgerUnsupported, setFallbackLedgerUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const page = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const summaryReturn = useRef<{ cursor: string | null; thread: string } | null>(null);

  const ledgerUnsupported = (capability.settled && !capability.supported) || fallbackLedgerUnsupported;

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

  // Revalidate Model Gateway budget in parallel when available on same-origin Hub.
  useEffect(() => {
    if (!active || typeof fetcher !== "function") return;
    let live = true;
    const loadGateway = async () => {
      try {
        const response = await fetcher(MODEL_GATEWAY_ENDPOINT, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!live) return;
        if (!response.ok) {
          if (response.status === 404 || response.status === 403) {
            tokenUsageReplica.writeGateway(accountScope, null);
            setGatewaySnapshot(null);
          }
          return;
        }
        const parsed = parseModelGatewayBudgetSnapshot(await response.json());
        if (!live) return;
        tokenUsageReplica.writeGateway(accountScope, parsed);
        setGatewaySnapshot(parsed);
      } catch {
        /* Model gateway is optional in standalone direct profiles. */
      }
    };
    void loadGateway();
    return () => {
      live = false;
    };
  }, [accountScope, active, fetcher, refresh]);

  // Stale-while-revalidate Host usage / ledger without clearing previous snapshot on filter change.
  useEffect(() => {
    if (!active) return;
    // If capability is still unknown because handshake has not completed yet, wait for ready phase.
    if (!capability.settled && connection !== "ready" && ledgerExtension !== undefined) return;

    const epoch = ++generation.current;
    inFlight.current = false;
    let live = true;

    const cachedForKey = tokenUsageReplica.readLedger(accountScope, hostId, queryKey);
    if (cachedForKey && !ledgerUnsupported) {
      setLedgerSnapshot(cachedForKey);
    }

    const loadLocalUsage = async (forceRefresh: boolean) => {
      try {
        const usage = await agentRuntimes.request(hostId, "opencraft/agents/usage", {
          ...(activeThreadId ? { threadId: activeThreadId } : {}),
          force: forceRefresh,
        });
        if (!live || epoch !== generation.current) return;
        tokenUsageReplica.writeLocalUsage(accountScope, hostId, usage);
        setLocalSnapshot(usage);
        setError(null);
      } catch (localCause) {
        if (!live || epoch !== generation.current) return;
        if (isUnsupportedMethodError(localCause)) {
          setError(
            intl.formatMessage({
              id: "tokenUsage.errorUnsupported",
              defaultMessage: "This Host does not support token statistics.",
            }),
          );
        } else {
          setError(
            intl.formatMessage({
              id: "tokenUsage.errorRefreshFailed",
              defaultMessage: "Refresh failed. Displayed usage may be stale. Try again.",
            }),
          );
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
        if (!live || epoch !== generation.current) return;
        tokenUsageReplica.writeLedger(accountScope, hostId, queryKey, result);
        setLedgerSnapshot(result);
        setError(null);
      } catch (cause) {
        if (!live || epoch !== generation.current) return;
        const code = errorCode(cause);
        if (code === 401 || code === 403) {
          setError(
            code === 401
              ? intl.formatMessage({
                  id: "tokenUsage.errorSignInRequired",
                  defaultMessage: "Sign in to view usage.",
                })
              : intl.formatMessage({
                  id: "tokenUsage.errorForbiddenScope",
                  defaultMessage: "You cannot view this usage scope.",
                }),
          );
        } else if (code === 409) {
          setCursor(null);
          setRefresh((n) => n + 1);
          setError(
            intl.formatMessage({
              id: "tokenUsage.errorReloadingFirstPage",
              defaultMessage: "Usage changed. Reloading the first page.",
            }),
          );
        } else if (isUnsupportedMethodError(cause)) {
          setFallbackLedgerUnsupported(true);
          await loadLocalUsage(refresh > 0);
        } else {
          setError(
            intl.formatMessage({
              id: "tokenUsage.errorRefreshFailed",
              defaultMessage: "Refresh failed. Displayed usage may be stale. Try again.",
            }),
          );
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
  }, [
    accountScope,
    active,
    activeThreadId,
    actorId,
    agentRuntimes,
    capability.settled,
    connection,
    cursor,
    from,
    hostId,
    intl,
    ledgerExtension,
    ledgerUnsupported,
    modelKey,
    queryKey,
    refresh,
    scope,
    threadId,
    through,
    view,
  ]);

  const configure = useCallback(
    async (enabled: boolean) => {
      if (loading) return;
      const epoch = generation.current;
      setLoading(true);
      try {
        await agentRuntimes.request(hostId, TOKEN_USAGE_CONFIGURE, { enabled });
        if (epoch !== generation.current) return;
        setCursor(null);
        setRefresh((n) => n + 1);
      } catch {
        if (epoch === generation.current) {
          setError(
            intl.formatMessage({
              id: "tokenUsage.errorSaveSettingsFailed",
              defaultMessage: "Could not save collection settings. Try again.",
            }),
          );
        }
      } finally {
        if (epoch === generation.current) setLoading(false);
      }
    },
    [agentRuntimes, hostId, intl, loading],
  );

  const change = useCallback((action: () => void, nextCursor: string | null = null) => {
    action();
    setCursor(nextCursor);
  }, []);

  const selectRange = useCallback(
    (value: string) => {
      setRange(value);
      if (value === "7" || value === "30") {
        change(() => {
          setFrom(dateBeforeDays(Number(value), effectiveTimeZone));
          setThrough(formatDateInTimeZone(effectiveTimeZone));
        });
      }
    },
    [change, effectiveTimeZone],
  );

  const openThread = useCallback(
    (id: string) => {
      summaryReturn.current = { cursor, thread: id };
      change(() => setThread(id));
    },
    [change, cursor],
  );

  const returnToSummary = useCallback(() => {
    const saved = summaryReturn.current;
    change(() => setThread(""), saved?.cursor ?? null);
  }, [change]);

  const choosePerson = useCallback(
    (id: string, name: string) =>
      change(() => {
        setActor(id);
        setActorName(name);
        setView("threads");
        setThread("");
      }),
    [change],
  );

  const handleHaptic = useCallback((style: string) => {
    requestMobileHaptic(style === "warning" ? "warning" : style === "light" ? "light" : "selection");
  }, []);

  const handleRefresh = useCallback(() => {
    setCursor(null);
    setRefresh((n) => n + 1);
  }, []);

  const count = useCallback((value: string) => formatCount(value, locale), [locale]);
  const compactNumber = useCallback(
    (value: number | null | undefined) =>
      value == null ? "—" : intl.formatNumber(value, { notation: "compact", maximumFractionDigits: 1 }),
    [intl],
  );

  const unknownProviderText = intl.formatMessage({
    id: "tokenUsage.unknownProvider",
    defaultMessage: "Unknown provider",
  });
  const unknownModelText = intl.formatMessage({
    id: "tokenUsage.unknownModel",
    defaultMessage: "Unknown model",
  });
  const modelLabel = useCallback(
    (key: string) => formatModelLabel(key, { unknownProvider: unknownProviderText, unknownModel: unknownModelText }),
    [unknownModelText, unknownProviderText],
  );

  const stateMap = useMemo(
    () => ({
      settled: intl.formatMessage({ id: "tokenUsage.stateSettled", defaultMessage: "Settled" }),
      provisional: intl.formatMessage({ id: "tokenUsage.stateProvisional", defaultMessage: "Provisional" }),
      pending: intl.formatMessage({ id: "tokenUsage.statePending", defaultMessage: "Pending attribution" }),
      system: intl.formatMessage({ id: "tokenUsage.stateSystem", defaultMessage: "System" }),
      unknown: intl.formatMessage({ id: "tokenUsage.stateUnknown", defaultMessage: "Unknown" }),
    }),
    [intl],
  );
  const stateLabel = useCallback((state: string) => formatStateLabel(state, stateMap), [stateMap]);

  const providerName = useCallback(
    (id: string) =>
      id === "codex"
        ? intl.formatMessage({ id: "onboard.agent.codex", defaultMessage: "Codex" })
        : id === "cursor"
          ? intl.formatMessage({ id: "onboard.agent.cursor", defaultMessage: "Cursor" })
          : id,
    [intl],
  );

  const windowLabel = useCallback(
    (window: AgentUsageWindow) =>
      window.kind === "plan"
        ? intl.formatMessage({ id: "agentUsage.plan", defaultMessage: "Plan" })
        : window.kind === "spend"
          ? window.scope === "team"
            ? intl.formatMessage({ id: "agentUsage.teamSpend", defaultMessage: "Team on-demand" })
            : intl.formatMessage({ id: "agentUsage.spend", defaultMessage: "On-demand" })
          : window.durationMinutes === null
            ? intl.formatMessage({ id: "agentUsage.limit", defaultMessage: "Limit" })
            : window.durationMinutes >= 1440
              ? intl.formatMessage(
                  { id: "agentUsage.days", defaultMessage: "{count} days" },
                  { count: window.durationMinutes / 1440 },
                )
              : intl.formatMessage(
                  { id: "agentUsage.hours", defaultMessage: "{count} hours" },
                  { count: window.durationMinutes / 60 },
                ),
    [intl],
  );

  const providerNotice = useCallback(
    (value: AgentProviderUsage) =>
      intl.formatMessage(
        value.status === "signedOut"
          ? { id: "agentUsage.signIn", defaultMessage: "Sign in to this Agent to view its limits." }
          : value.status === "expired"
            ? { id: "agentUsage.expired", defaultMessage: "The Agent sign-in has expired. Sign in again." }
            : {
                id: "agentUsage.unavailable",
                defaultMessage: "Could not refresh. Previously reported usage is shown when available.",
              },
      ),
    [intl],
  );

  const localUsageSection = useMemo((): TokenUsageLocalSection | undefined => {
    if (!localSnapshot) return undefined;
    const activeProvider =
      localSnapshot.providers.find((item) => item.id === localProvider) ?? localSnapshot.providers[0];
    const providerList = (
      localSnapshot.providers.length ? localSnapshot.providers : [{ id: "codex" }, { id: "cursor" }]
    ).map((item) => ({
      id: item.id,
      title: providerName(item.id),
    }));
    const unknownText = intl.formatMessage({ id: "agentUsage.unknown", defaultMessage: "Not reported" });
    const statusMessage =
      activeProvider && activeProvider.status !== "ok"
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
            {
              time: intl.formatDate(win.resetsAt, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              }),
            },
          )
        : unknownText,
      costText: win.cost
        ? `${intl.formatNumber(win.cost.usedCents / 100, { style: "currency", currency: win.cost.currency })} / ${intl.formatNumber(win.cost.limitCents / 100, { style: "currency", currency: win.cost.currency })}`
        : undefined,
      warning: win.usedPercent >= 80,
    }));

    const conversation = localSnapshot.conversation ?? null;
    const context = conversation?.context ?? null;
    const contextPercent = context && context.limitTokens > 0 ? context.usedTokens / context.limitTokens : undefined;
    const conversationMetrics = conversation?.total
      ? [
          {
            label: intl.formatMessage({ id: "agentUsage.total", defaultMessage: "Total tokens" }),
            value: compactNumber(conversation.total.totalTokens),
          },
          {
            label: intl.formatMessage({ id: "agentUsage.input", defaultMessage: "Input" }),
            value: compactNumber(conversation.total.inputTokens),
          },
          {
            label: intl.formatMessage({ id: "agentUsage.cached", defaultMessage: "Cached input" }),
            value: compactNumber(conversation.total.cachedInputTokens),
          },
          {
            label: intl.formatMessage({ id: "agentUsage.output", defaultMessage: "Output" }),
            value: compactNumber(conversation.total.outputTokens),
          },
          {
            label: intl.formatMessage({ id: "agentUsage.reasoning", defaultMessage: "Reasoning output" }),
            value: compactNumber(conversation.total.reasoningOutputTokens),
          },
          {
            label: intl.formatMessage({ id: "agentUsage.lastRequest", defaultMessage: "Last request" }),
            value: compactNumber(conversation.last?.totalTokens ?? null),
          },
        ]
      : [];

    const observedAt = activeProvider?.observedAt ?? conversation?.observedAt ?? localSnapshot.readAt;
    return {
      machineLabel: machines
        ? intl.formatMessage({ id: "agentUsage.machineSelector", defaultMessage: "Machine" })
        : undefined,
      machines: machines?.map((m) => ({ id: m.hostId, title: m.label })),
      selectedMachineId: machines ? hostId : undefined,
      onSelectMachine,
      providerLabel: intl.formatMessage({ id: "agentUsage.providers", defaultMessage: "Usage provider" }),
      providers: providerList,
      selectedProviderId: activeProvider?.id ?? localProvider,
      planText: activeProvider?.plan ?? undefined,
      accountText: activeProvider?.account ?? undefined,
      quotaGroupTitle: intl.formatMessage({
        id: "tokenUsage.localQuotaTitle",
        defaultMessage: "Local Agent quota",
      }),
      quotaGroupDescription: intl.formatMessage({
        id: "tokenUsage.localQuotaDescription",
        defaultMessage: "Live plan and usage windows from signed-in local Agents.",
      }),
      statusMessage,
      windows,
      conversationGroupTitle: intl.formatMessage({ id: "agentUsage.current", defaultMessage: "This conversation" }),
      conversationProvider: conversation ? providerName(conversation.providerId) : undefined,
      contextLabel: context
        ? intl.formatMessage({ id: "agentUsage.context", defaultMessage: "Context window" })
        : undefined,
      contextDetail:
        context && contextPercent !== undefined
          ? `${compactNumber(context.usedTokens)} / ${compactNumber(context.limitTokens)} (${intl.formatNumber(contextPercent, { style: "percent", maximumFractionDigits: 1 })})`
          : undefined,
      contextProgress: contextPercent !== undefined ? Math.min(1, Math.max(0, contextPercent)) : undefined,
      conversationFallback:
        !context && conversationMetrics.length === 0
          ? activeThreadId
            ? unknownText
            : intl.formatMessage({
                id: "agentUsage.openConversation",
                defaultMessage: "Open a conversation to view its usage.",
              })
          : undefined,
      metrics: conversationMetrics,
      observedAtText: observedAt
        ? intl.formatMessage(
            { id: "agentUsage.readAt", defaultMessage: "Read at {time}" },
            { time: intl.formatTime(observedAt, { hour: "numeric", minute: "2-digit" }) },
          )
        : undefined,
      onSelectProvider: setLocalProvider,
    };
  }, [
    activeThreadId,
    compactNumber,
    hostId,
    intl,
    localProvider,
    localSnapshot,
    machines,
    onSelectMachine,
    providerName,
    providerNotice,
    windowLabel,
  ]);

  const gatewayBudgetSection = useMemo((): TokenUsageGatewaySection | undefined => {
    if (!gatewaySnapshot) return undefined;
    const platformCap = gatewaySnapshot.limit?.monthlyTokens ?? null;
    const personalCap = gatewaySnapshot.personalLimit.monthlyTokens;
    const effectiveCap =
      platformCap !== null && personalCap !== null
        ? Math.min(platformCap, personalCap)
        : (personalCap ?? platformCap);
    const committed = gatewaySnapshot.usedTokens + gatewaySnapshot.heldTokens;
    const progress =
      effectiveCap !== null && effectiveCap > 0 ? Math.min(1, Math.max(0, committed / effectiveCap)) : undefined;

    const enabledConnections = (gatewaySnapshot.directory ?? []).filter((c) => c.enabled);
    const enabledModelCount = enabledConnections.reduce(
      (sum, conn) => sum + conn.models.filter((m) => m.enabled).length,
      0,
    );

    const requestStateLabel = (state: string) => {
      switch (state) {
        case "settled":
          return intl.formatMessage({ id: "tokenUsage.gatewayReqStateSettled", defaultMessage: "Settled" });
        case "dispatched":
          return intl.formatMessage({ id: "tokenUsage.gatewayReqStateDispatched", defaultMessage: "In flight" });
        case "reserved":
          return intl.formatMessage({ id: "tokenUsage.gatewayReqStateReserved", defaultMessage: "Reserved" });
        case "released":
          return intl.formatMessage({ id: "tokenUsage.gatewayReqStateReleased", defaultMessage: "Released" });
        default:
          return intl.formatMessage({
            id: "tokenUsage.gatewayReqStateUnknown",
            defaultMessage: "Pending reconciliation",
          });
      }
    };

    const recentRequests = (gatewaySnapshot.requests ?? []).slice(0, 8).map((req) => {
      const modelDisplay = req.model.startsWith("configured/")
        ? decodeURIComponent(req.model.slice("configured/".length))
        : req.model;
      const detail =
        req.input_tokens != null && req.output_tokens != null
          ? intl.formatMessage(
              { id: "tokenUsage.gatewayReqTokensIo", defaultMessage: "In {input} · Out {output}" },
              {
                input: compactTokens(String(req.input_tokens), locale),
                output: compactTokens(String(req.output_tokens), locale),
              },
            )
          : req.actual != null
            ? intl.formatMessage(
                { id: "tokenUsage.gatewayReqTokensActual", defaultMessage: "{tokens} tokens" },
                { tokens: compactTokens(String(req.actual), locale) },
              )
            : intl.formatMessage(
                { id: "tokenUsage.gatewayReqTokensReserved", defaultMessage: "Reserved {tokens}" },
                { tokens: compactTokens(String(req.reserved), locale) },
              );
      return {
        id: req.id,
        title: modelDisplay,
        subtitle: `${new Date(req.created_at).toLocaleString(locale)} · ${requestStateLabel(req.state)}`,
        detail,
      };
    });

    const activeSlots = gatewaySnapshot.activeRequests ?? 0;
    const concurrencyLimit = gatewaySnapshot.limit?.concurrency ?? null;

    return {
      title: intl.formatMessage({
        id: "tokenUsage.gatewayTitle",
        defaultMessage: "Model gateway & monthly budget",
      }),
      subtitle: intl.formatMessage(
        {
          id: "tokenUsage.gatewaySubtitle",
          defaultMessage: "Period {period} (UTC) · Metered personal and team model requests",
        },
        { period: gatewaySnapshot.period },
      ),
      budgetLabel:
        effectiveCap !== null
          ? intl.formatMessage({ id: "tokenUsage.gatewayBudgetBarLabel", defaultMessage: "Monthly budget usage" })
          : undefined,
      budgetDetail:
        effectiveCap !== null
          ? intl.formatMessage(
              {
                id: "tokenUsage.gatewayBudgetBarDetail",
                defaultMessage: "{used} used · {held} reserved of {limit}",
              },
              {
                used: compactTokens(String(gatewaySnapshot.usedTokens), locale),
                held: compactTokens(String(gatewaySnapshot.heldTokens), locale),
                limit: compactTokens(String(effectiveCap), locale),
              },
            )
          : undefined,
      budgetProgress: progress,
      budgetWarning: progress !== undefined && progress >= 0.8,
      statusMessage:
        effectiveCap === null
          ? intl.formatMessage({
              id: "tokenUsage.gatewayNoLimitNotice",
              defaultMessage:
                "No monthly token cap configured for this period. Settled and reserved gateway requests are still metered below.",
            })
          : undefined,
      metrics: [
        {
          id: "gw-settled",
          value: compactTokens(String(gatewaySnapshot.usedTokens), locale),
          label: intl.formatMessage({ id: "tokenUsage.gatewaySettledLabel", defaultMessage: "Settled" }),
          detail: intl.formatMessage(
            { id: "tokenUsage.gatewaySettledDetail", defaultMessage: "Completed requests in {period}" },
            { period: gatewaySnapshot.period },
          ),
        },
        {
          id: "gw-held",
          value: compactTokens(String(gatewaySnapshot.heldTokens), locale),
          label: intl.formatMessage({ id: "tokenUsage.gatewayHeldLabel", defaultMessage: "Reserved" }),
          detail:
            concurrencyLimit !== null
              ? intl.formatMessage(
                  {
                    id: "tokenUsage.gatewayHeldWithLimitDetail",
                    defaultMessage: "{active} / {concurrency} active slots",
                  },
                  { active: activeSlots, concurrency: concurrencyLimit },
                )
              : intl.formatMessage(
                  { id: "tokenUsage.gatewayHeldDetail", defaultMessage: "{active} active slots" },
                  { active: activeSlots },
                ),
        },
        {
          id: "gw-cap",
          value:
            effectiveCap !== null
              ? compactTokens(String(effectiveCap), locale)
              : intl.formatMessage({ id: "tokenUsage.gatewayNoCeilingValue", defaultMessage: "Uncapped" }),
          label: intl.formatMessage({ id: "tokenUsage.gatewayCeilingLabel", defaultMessage: "Effective cap" }),
          detail:
            personalCap !== null && (platformCap === null || personalCap <= platformCap)
              ? intl.formatMessage({
                  id: "tokenUsage.gatewayCeilingPersonalDetail",
                  defaultMessage: "Personal ceiling active",
                })
              : intl.formatMessage({
                  id: "tokenUsage.gatewayCeilingPlatformDetail",
                  defaultMessage: "Platform policy",
                }),
        },
        {
          id: "gw-models",
          value: String(enabledModelCount),
          label: intl.formatMessage({ id: "tokenUsage.gatewayModelsLabel", defaultMessage: "Gateway models" }),
          detail: intl.formatMessage(
            { id: "tokenUsage.gatewayModelsDetail", defaultMessage: "{providers} connections enabled" },
            { providers: enabledConnections.length },
          ),
        },
      ],
      requestsTitle: intl.formatMessage({
        id: "tokenUsage.gatewayRequestsTitle",
        defaultMessage: "Recent gateway requests",
      }),
      requestsEmptyText: intl.formatMessage({
        id: "tokenUsage.gatewayRequestsEmpty",
        defaultMessage: "No metered gateway requests in this period yet.",
      }),
      requests: recentRequests,
      manageModelsLabel: onManageModels
        ? intl.formatMessage({ id: "tokenUsage.gatewayManageModels", defaultMessage: "Manage models" })
        : undefined,
      onManageModels,
    };
  }, [gatewaySnapshot, intl, locale, onManageModels]);

  const visible = ledgerUnsupported ? null : ledgerSnapshot;

  const ledgerSection = useMemo((): TokenUsageLedgerSection | undefined => {
    if (ledgerUnsupported && !visible) return undefined;
    const modelOptions = [
      { id: "", title: intl.formatMessage({ id: "tokenUsage.allModels", defaultMessage: "All models" }) },
      ...(visible?.models ?? []).map((m) => ({ id: m.key, title: modelLabel(m.key) })),
      ...(modelKey && !(visible?.models ?? []).some((m) => m.key === modelKey)
        ? [{ id: modelKey, title: modelLabel(modelKey) }]
        : []),
    ];
    const scopeOptions = [
      { id: "self", title: intl.formatMessage({ id: "tokenUsage.scopeSelf", defaultMessage: "My usage" }) },
      ...(visible?.canQueryTeam || scope === "team"
        ? [{ id: "team", title: intl.formatMessage({ id: "tokenUsage.scopeTeam", defaultMessage: "Team usage" }) }]
        : []),
    ];
    const rangeOptions = [
      { id: "7", title: intl.formatMessage({ id: "tokenUsage.range7d", defaultMessage: "Last 7 days" }) },
      { id: "30", title: intl.formatMessage({ id: "tokenUsage.range30d", defaultMessage: "Last 30 days" }) },
      { id: "custom", title: intl.formatMessage({ id: "tokenUsage.rangeCustom", defaultMessage: "Custom" }) },
    ];
    const displayTz = visible?.timezone ?? effectiveTimeZone;
    const metrics = visible ? dashboardMetrics(visible, formatDateInTimeZone(displayTz)) : null;
    const grid = visible ? buildActivityGrid(visible.daily, from, through, locale) : null;
    const bars = visible
      ? buildActivityBars(visible.daily, from, through, activityMode === "cumulative" ? "cumulative" : "weekly", locale)
      : [];
    const maxBar = bars.reduce((n, b) => (BigInt(b.tokens) > n ? BigInt(b.tokens) : n), 0n);
    const details = visible?.view === "turns" ? (visible.rows as TokenUsageTurnDetail[]) : null;
    const lastSource = visible?.coverage?.lastSourceSuccessAt ?? visible?.diagnostics?.lastSourceSuccessAt ?? null;
    const summaryTitle =
      scope === "self"
        ? intl.formatMessage({ id: "tokenUsage.summarySelf", defaultMessage: "My allocated usage" })
        : actorId
          ? intl.formatMessage(
              { id: "tokenUsage.summaryActor", defaultMessage: "{actor}’s allocated usage" },
              { actor: actorName },
            )
          : intl.formatMessage({ id: "tokenUsage.scopeTeam", defaultMessage: "Team usage" });
    const detailTitle = threadId
      ? intl.formatMessage({ id: "tokenUsage.detailTurnThread", defaultMessage: "Conversation turn details" })
      : view === "threads"
        ? intl.formatMessage({ id: "tokenUsage.detailConversations", defaultMessage: "Conversations" })
        : view === "actors"
          ? intl.formatMessage({ id: "tokenUsage.detailPeople", defaultMessage: "People" })
          : intl.formatMessage({ id: "tokenUsage.detailTurns", defaultMessage: "Turn details" });
    const daysUnit = intl.formatMessage({ id: "tokenUsage.unitDays", defaultMessage: "days" });
    const unknownPersonLabel = intl.formatMessage({
      id: "tokenUsage.unknownPerson",
      defaultMessage: "Unknown person",
    });

    return {
      scopeLabel: intl.formatMessage({ id: "tokenUsage.filterScope", defaultMessage: "Scope" }),
      scopeValue: scope,
      scopeOptions,
      rangeLabel: intl.formatMessage({ id: "tokenUsage.filterRange", defaultMessage: "Range" }),
      rangeValue: range,
      rangeOptions,
      customRange:
        range === "custom"
          ? {
              fromLabel: intl.formatMessage({ id: "tokenUsage.filterFrom", defaultMessage: "From" }),
              fromValue: from,
              throughLabel: intl.formatMessage({ id: "tokenUsage.filterThrough", defaultMessage: "Through" }),
              throughValue: through,
              onChangeFrom: (val) => {
                setRange("custom");
                change(() => setFrom(val));
              },
              onChangeThrough: (val) => {
                setRange("custom");
                change(() => setThrough(val));
              },
            }
          : undefined,
      modelLabel: intl.formatMessage({ id: "tokenUsage.filterModel", defaultMessage: "Model" }),
      modelValue: modelKey,
      modelOptions,
      summaryTitle: visible ? summaryTitle : undefined,
      summarySubtitle: visible
        ? intl.formatMessage(
            {
              id: "tokenUsage.subtitleLedger",
              defaultMessage: "Shared equally by turn participants · Grouped by turn start date · {timezone}",
            },
            { timezone: displayTz },
          )
        : undefined,
      partialBadge: visible?.coverage.partial
        ? intl.formatMessage({ id: "tokenUsage.partialData", defaultMessage: "Partial data" })
        : undefined,
      summaryMeta: visible
        ? intl.formatMessage(
            { id: "tokenUsage.summaryMeta", defaultMessage: "{threads} conversations · {turns} turns" },
            { threads: String(visible.summary.threads ?? "—"), turns: visible.summary.turns },
          )
        : undefined,
      metrics: metrics
        ? [
            {
              id: "settled",
              value: compactTokens(metrics.settled, locale),
              label: intl.formatMessage({ id: "tokenUsage.metricSettled", defaultMessage: "Settled tokens" }),
              detail: intl.formatMessage(
                { id: "tokenUsage.metricSettledDetail", defaultMessage: "Total in range {total}" },
                { total: count(metrics.total) },
              ),
            },
            {
              id: "peak",
              value: compactTokens(metrics.peak, locale),
              label: intl.formatMessage({ id: "tokenUsage.metricPeak", defaultMessage: "Peak tokens" }),
              detail: metrics.peakDay ?? "—",
            },
            {
              id: "turns",
              value: metrics.settledTurns === null ? "—" : count(String(metrics.settledTurns)),
              label: intl.formatMessage({ id: "tokenUsage.metricTurns", defaultMessage: "Settled turns" }),
              detail: intl.formatMessage(
                { id: "tokenUsage.metricTurnsDetail", defaultMessage: "{turns} turns total" },
                { turns: visible!.summary.turns },
              ),
            },
            {
              id: "longest",
              value: String(metrics.longestStreak),
              label: intl.formatMessage({ id: "tokenUsage.metricLongestStreak", defaultMessage: "Longest streak" }),
              detail: daysUnit,
            },
            {
              id: "current",
              value: String(metrics.currentStreak),
              label: intl.formatMessage({ id: "tokenUsage.metricCurrentStreak", defaultMessage: "Current streak" }),
              detail: daysUnit,
            },
          ]
        : undefined,
      activityTitle: visible
        ? intl.formatMessage({ id: "tokenUsage.activityTitle", defaultMessage: "Token activity" })
        : undefined,
      activitySubtitle: visible
        ? intl.formatMessage({ id: "tokenUsage.activitySubtitle", defaultMessage: "Grouped by turn start date" })
        : undefined,
      activityMode,
      activityModeOptions: [
        { id: "daily", title: intl.formatMessage({ id: "tokenUsage.modeDaily", defaultMessage: "Daily" }) },
        { id: "weekly", title: intl.formatMessage({ id: "tokenUsage.modeWeekly", defaultMessage: "Weekly" }) },
        {
          id: "cumulative",
          title: intl.formatMessage({ id: "tokenUsage.modeCumulative", defaultMessage: "Cumulative" }),
        },
      ],
      weekdayLabels: buildWeekdayLabels(locale),
      heatmapWeeks: grid
        ? grid.columns.map((week, i) => ({
            key: `w-${i}`,
            monthLabel: grid.monthLabels.find((x) => x.index === i)?.label,
            cells: week.map((cell) => ({
              date: cell.date,
              level: cell.level,
              outside: cell.state === "outside",
              summaryText: intl.formatMessage(
                { id: "tokenUsage.cellSummary", defaultMessage: "{date} · {tokens} tokens · {turns} turns" },
                { date: cell.date, tokens: count(cell.tokens), turns: cell.turns },
              ),
            })),
          }))
        : undefined,
      defaultCellHint: intl.formatMessage({
        id: "tokenUsage.defaultCellHint",
        defaultMessage: "Choose a cell for daily usage",
      }),
      bars: bars.map((b) => ({
        key: b.key,
        label: b.label,
        progress: maxBar === 0n ? 0 : Number((BigInt(b.tokens) * 1000n) / maxBar) / 1000,
        valueText: compactTokens(b.tokens, locale),
      })),
      modelSectionTitle: visible
        ? intl.formatMessage({ id: "tokenUsage.modelSectionTitle", defaultMessage: "Usage by model" })
        : undefined,
      modelEmptyText: intl.formatMessage({
        id: "tokenUsage.modelEmpty",
        defaultMessage: "No model usage in this range.",
      }),
      modelCards: visible?.models.map((m) => ({
        key: m.key,
        label: modelLabel(m.key),
        tokensText: compactTokens(m.tokens, locale),
        turnsText: intl.formatMessage(
          { id: "tokenUsage.turnsCount", defaultMessage: "{turns} turns" },
          { turns: m.turns },
        ),
        progress: modelShare(m.tokens, visible.summary.tokens) / 100,
      })),
      detailTitle: visible ? detailTitle : undefined,
      detailEmptyText: intl.formatMessage({
        id: "tokenUsage.detailEmpty",
        defaultMessage: "No records match these filters.",
      }),
      backToSummaryLabel: threadId
        ? intl.formatMessage({ id: "tokenUsage.backToSummary", defaultMessage: "Back to summary" })
        : undefined,
      viewLabel: intl.formatMessage({ id: "tokenUsage.viewLabel", defaultMessage: "View" }),
      viewValue: view,
      viewOptions: [
        {
          id: "threads",
          title: intl.formatMessage({ id: "tokenUsage.detailConversations", defaultMessage: "Conversations" }),
        },
        {
          id: "turns",
          title: intl.formatMessage({ id: "tokenUsage.detailTurns", defaultMessage: "Turn details" }),
        },
        ...(visible?.canQueryTeam
          ? [{ id: "actors", title: intl.formatMessage({ id: "tokenUsage.detailPeople", defaultMessage: "People" }) }]
          : []),
      ],
      clearActorLabel: actorId
        ? intl.formatMessage({ id: "tokenUsage.clearActor", defaultMessage: "Clear person filter" })
        : undefined,
      rows:
        visible && !details
          ? visible.rows.flatMap((row) =>
              "key" in row
                ? [
                    {
                      key: row.key,
                      title: view === "actors" ? (row.label ?? unknownPersonLabel) : row.key,
                      tokensText: compactTokens(row.tokens, locale),
                      turnsText: intl.formatMessage(
                        { id: "tokenUsage.turnsCount", defaultMessage: "{turns} turns" },
                        { turns: row.turns },
                      ),
                      interactive: view === "threads" || view === "actors",
                    },
                  ]
                : [],
            )
          : undefined,
      turnRows: details?.map((t) => ({
        key: t.turnId,
        title: t.turnId,
        subtitle: `${new Date(t.startedAt).toLocaleString(locale)} · ${stateLabel(t.allocationState)}`,
        detail: intl.formatMessage(
          {
            id: "tokenUsage.turnDetailMeta",
            defaultMessage: "Allocated {allocated} · Raw {raw} · {participants} participants",
          },
          {
            allocated: count(t.allocatedTokens),
            raw: t.rawTokens === null ? stateMap.unknown : count(t.rawTokens),
            participants: t.participantCount,
          },
        ),
      })),
      nextPageLabel: visible?.nextCursor
        ? intl.formatMessage({ id: "tokenUsage.nextPage", defaultMessage: "Next page" })
        : undefined,
      firstPageLabel: cursor
        ? intl.formatMessage({ id: "tokenUsage.firstPage", defaultMessage: "First page" })
        : undefined,
      diagnosticsTitle: visible
        ? intl.formatMessage({
            id: "tokenUsage.diagnosticsTitle",
            defaultMessage: "Advanced ledger & collection diagnostics",
          })
        : undefined,
      diagnosticsToggleLabel: intl.formatMessage({
        id: "tokenUsage.diagnosticsToggle",
        defaultMessage: "View runtime diagnostics",
      }),
      collectionStatusText: visible
        ? visible.coverage.enabled
          ? intl.formatMessage({ id: "tokenUsage.collectionActive", defaultMessage: "Collection active" })
          : intl.formatMessage({ id: "tokenUsage.collectionPaused", defaultMessage: "Collection paused" })
        : undefined,
      collectionActionLabel: visible?.canConfigure
        ? visible.coverage.enabled
          ? intl.formatMessage({ id: "tokenUsage.pauseCollection", defaultMessage: "Pause collection" })
          : intl.formatMessage({ id: "tokenUsage.enableCollection", defaultMessage: "Enable collection" })
        : undefined,
      diagnosticsLines: visible
        ? [
            intl.formatMessage(
              { id: "tokenUsage.diagBegan", defaultMessage: "Collection began {time}" },
              { time: new Date(visible.coverage.enabledAt).toLocaleString(locale) },
            ),
            intl.formatMessage(
              { id: "tokenUsage.diagLastSuccess", defaultMessage: "Last successful collection: {time}" },
              {
                time:
                  lastSource === null
                    ? intl.formatMessage({
                        id: "tokenUsage.diagNoSuccessYet",
                        defaultMessage: "No successful collection yet",
                      })
                    : new Date(lastSource).toLocaleString(locale),
              },
            ),
            intl.formatMessage(
              {
                id: "tokenUsage.diagRevisionMeta",
                defaultMessage: "Revision {revision} · As of {time} · {timezone} · {policy}",
              },
              {
                revision: visible.snapshotRevision,
                time: new Date(visible.asOf).toLocaleString(locale),
                timezone: visible.timezone,
                policy: visible.policyVersion,
              },
            ),
            intl.formatMessage(
              { id: "tokenUsage.diagUnknownModels", defaultMessage: "{count} turns with unknown model" },
              { count: visible.coverage.unknownModelTurns },
            ),
          ]
        : undefined,
      diagnosticsPartialNotice: visible?.coverage.partial
        ? intl.formatMessage(
            {
              id: "tokenUsage.diagPartialNotice",
              defaultMessage:
                "Partial coverage: {missing} turns have incomplete usage; {incidents} open gaps ({gaps} gap records).",
            },
            {
              missing: visible.coverage.missingUsage,
              incidents: visible.coverage.openGapIncidents ?? visible.coverage.openGaps,
              gaps: visible.coverage.openGaps,
            },
          )
        : undefined,
      categoryStats: visible
        ? [
            { label: stateMap.settled, value: count(visible.summary.categories.settled ?? "0") },
            { label: stateMap.provisional, value: count(visible.summary.categories.provisional ?? "0") },
            { label: stateMap.pending, value: count(visible.summary.categories.pending ?? "0") },
            { label: stateMap.system, value: count(visible.summary.categories.system ?? "0") },
            { label: stateMap.unknown, value: count(visible.summary.categories.unknown ?? "0") },
          ]
        : undefined,
      onChangeScope: (nextScope) =>
        change(() => {
          setScope(nextScope);
          setActor("");
          setActorName("");
        }),
      onChangeRange: selectRange,
      onChangeModel: (val) => change(() => setModel(val)),
      onChangeActivityMode: (mode) => setActivityMode(mode as typeof activityMode),
      onChangeView: (val) => change(() => setView(val)),
      onSelectRow: (key) => {
        if (view === "threads") openThread(key);
        else if (view === "actors") {
          const row = visible?.rows.find((r) => "key" in r && r.key === key);
          choosePerson(key, (row && "label" in row ? row.label : undefined) ?? unknownPersonLabel);
        }
      },
      onBackToSummary: returnToSummary,
      onClearActor: () => choosePerson("", ""),
      onNextPage: () => {
        if (visible?.nextCursor) change(() => {}, visible.nextCursor);
      },
      onFirstPage: () => change(() => {}),
      onToggleCollection: () => {
        if (visible) void configure(!visible.coverage.enabled);
      },
    };
  }, [
    activityMode,
    actorId,
    actorName,
    change,
    choosePerson,
    configure,
    count,
    cursor,
    effectiveTimeZone,
    from,
    intl,
    ledgerUnsupported,
    locale,
    modelKey,
    modelLabel,
    openThread,
    range,
    returnToSummary,
    scope,
    selectRange,
    stateLabel,
    stateMap,
    threadId,
    through,
    view,
    visible,
  ]);

  const title = intl.formatMessage({ id: "tokenUsage.title", defaultMessage: "Token usage" });
  const subtitle = ledgerUnsupported
    ? intl.formatMessage({
        id: "tokenUsage.subtitleLocal",
        defaultMessage: "Inspect Agent quota windows, gateway budgets, and session usage on the active host.",
      })
    : intl.formatMessage(
        {
          id: "tokenUsage.subtitleLedger",
          defaultMessage: "Shared equally by turn participants · Grouped by turn start date · {timezone}",
        },
        { timezone: visible?.timezone ?? effectiveTimeZone },
      );

  const viewModel = useMemo(
    (): TokenUsageDashboardProps => ({
      dark: appearance.resolvedTheme === "dark",
      touch,
      narrow,
      title,
      subtitle,
      refreshLabel: intl.formatMessage({ id: "tokenUsage.refresh", defaultMessage: "Refresh" }),
      loading,
      errorMessage: error ?? undefined,
      localUsage: localUsageSection,
      gatewayBudget: gatewayBudgetSection,
      ledger: ledgerSection,
      onRefresh: handleRefresh,
      onHaptic: handleHaptic,
    }),
    [
      appearance.resolvedTheme,
      error,
      gatewayBudgetSection,
      handleHaptic,
      handleRefresh,
      intl,
      ledgerSection,
      loading,
      localUsageSection,
      narrow,
      subtitle,
      title,
      touch,
    ],
  );

  return (
    <div ref={page} className="valdi-token-usage-dashboard-host" aria-busy={loading}>
      <ValdiSurface
        component={TokenUsageDashboardSurface}
        viewModel={viewModel}
        className="valdi-token-usage-dashboard-surface"
        data-testid="valdi-token-usage-dashboard-surface"
      />
    </div>
  );
}
