import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { useSession } from "@/contexts/session-context";
import { useRepositories } from "@/contexts/repository-context";
import type { Bot, BotSiblingsUnknownReason, Pass } from "@/domain/types";
import {
  createBotIdentity,
  normalizeBotLifecycle,
  projectBotCatalog,
} from "@lightvela/agent-core";
import { isUpgradeDelivered, readUpgradeReturn, upgradeReturnKey, UPGRADE_RETURN_QUERY, UPGRADE_POLL_INTERVAL_MS, UPGRADE_RECOVERY_TIMEOUT_MS, type PaidUpgradeCheckout } from "@/lib/upgrade-checkout";
import { isGlobal } from "@/lib/region";
import { summarizePassCredits } from "@/lib/pass-credits";
import { resolveBotQuotaPerAgent } from "@/lib/bot-quota";
import { readStoredAuthToken } from "@/repositories/http-repositories";

export { resolveBotQuotaPerAgent } from "@/lib/bot-quota";

/* ─── Types ─── */

export interface OpenClawBot {
  id: string;
  instanceId?: string;
  profileId?: string;
  isDefault?: boolean;
  gatewayRunning?: boolean;
  siblingsUnknown?: BotSiblingsUnknownReason;
  description?: string;
  createdFrom?: "blank" | "clone";
  sourceBotId?: string;
  weixinOwner?: Bot["weixinOwner"];
  whatsAppOwner?: Bot["whatsAppOwner"];
  name: string;
  personality: string;
  personalityEmoji: string;
  intro: string;
  soulTemplateId?: string;
  status: "running" | "paused" | "draft" | "provisioning" | "failed" | "deleting";
  createdAt: string;
  connectedChannels: ("wechat" | "qq")[];
  installedSkills: string[];
}

export interface OpenClawUser {
  nickname: string;
  avatarUrl: string;
  phone?: string;
  email?: string;
  plan: {
    name: string;
    tier: "free" | "plus" | "pro";
    trialDays: number;
    aiCredits: number;
    usedCredits: number;
    totalRequests: number;
    maxBots: number;
  };
}

interface OpenClawContextValue {
  isLoggedIn: boolean;
  isSubscribed: boolean;
  user: OpenClawUser;
  bots: OpenClawBot[];
  instanceDiscovery: {
    readonly accountId: string;
    readonly items: readonly { instanceId: string; running: boolean }[];
    isCurrent(): boolean;
  } | null;
  botsLoading: boolean;
  /** 当前账号的 Bot 列表已从服务端成功读取，空数组才可信。 */
  hasResolvedBots: boolean;
  /** Latest list read failed; an empty array is not proof of an empty account. */
  botsError: boolean;
  /** 当前用户的权益最新快照（来自 GET /v1/passes） */
  activePass: Pass | null;
  /** 升级中的权益；直到服务端恢复 active 且 Bot 快照刷新后才清除。 */
  modifyingPass: Pass | null;
  passUpgradeFailed: boolean;
  passUpgradePaused: boolean;
  passUpgradeRefreshing: boolean;
  returningUpgrade: boolean;
  retryPassUpgrade: () => Promise<void>;
  passesLoading: boolean;
  /** 套餐查询失败或超时；不代表支付失败或套餐正在升级。 */
  passesError: boolean;
  /**
   * 权益快照是否已经解析完成（GET /v1/passes 至少成功返回过一次）。
   * 登录成功后的分流必须等它就绪，避免把已订阅用户按未订阅带到订阅页。
   */
  hasResolvedPasses: boolean;
  /** 用户最新的 pass（即使已过期），用于定价页匹配"当前订阅"套餐 */
  latestPass: Pass | null;
  login: () => void;
  logout: () => void;
  subscribe: () => void;
  /** 重新拉取 /v1/passes 并更新 activePass / isSubscribed */
  refreshPasses: () => Promise<void>;
  /** Payment is confirmed; show upgrading immediately while server delivery catches up. */
  beginPassUpgrade: (pass: Pass, checkout: PaidUpgradeCheckout) => void;
  updateUser: (updates: Partial<OpenClawUser>) => void;
  addBot: (bot: Omit<OpenClawBot, "id" | "instanceId" | "profileId" | "isDefault" | "createdAt" | "connectedChannels" | "installedSkills"> & {
    createMode?: "blank" | "clone";
    sourceBotId?: string;
    initialSoul?: string;
  }) => Promise<OpenClawBot>;
  updateBot: (botId: string, updates: Partial<OpenClawBot>) => void;
  deleteBot: (botId: string) => Promise<void>;
  refreshBots: () => Promise<void>;
}

/* ─── Helpers ─── */

/** Map a backend Bot to the frontend OpenClawBot shape */
const mapBotToOpenClawBot = (bot: Bot, channels?: ("wechat" | "qq")[]): OpenClawBot => {
  const identity = createBotIdentity({
    botId: bot.id,
    instanceId: bot.instanceId,
    profileId: bot.profileId,
    isDefault: bot.isDefault ?? true,
  });
  return {
    id: identity.botId,
    instanceId: identity.instanceId,
    profileId: identity.profileId,
    isDefault: identity.isDefault,
    gatewayRunning: bot.gatewayRunning,
    siblingsUnknown: bot.siblingsUnknown,
    description: bot.description,
    createdFrom: bot.createdFrom,
    sourceBotId: bot.sourceBotId,
    weixinOwner: bot.weixinOwner,
    whatsAppOwner: bot.whatsAppOwner,
    name: bot.name,
    personality: bot.template || "默认设定",
    personalityEmoji: "✨",
    intro: bot.mission || "",
    status: normalizeBotLifecycle(bot.status),
    createdAt: bot.createdAt,
    connectedChannels: channels ?? [],
    installedSkills: [],
  };
};

// NOTE: parseChannelsFromConfig 暂时注释，待通道探测功能恢复后启用
// const parseChannelsFromConfig = (configOutput: string): ("wechat" | "qq")[] => {
//   try {
//     const config = JSON.parse(configOutput);
//     const channels: ("wechat" | "qq")[] = [];
//     if (config?.channels && typeof config.channels === "object") {
//       for (const [key, channel] of Object.entries(config.channels)) {
//         const keyLower = key.toLowerCase();
//         const ch = channel as Record<string, unknown> | null;
//         if (keyLower.includes("qq") || keyLower.includes("qqbot")) {
//           if (ch && ch.appId && (ch.appSecret || ch.clientSecret)) {
//             if (!channels.includes("qq")) channels.push("qq");
//           }
//         }
//         if (keyLower.includes("wechat") || keyLower.includes("weixin") || keyLower.includes("wechaty")) {
//           if (!channels.includes("wechat")) channels.push("wechat");
//         }
//       }
//     }
//     return channels;
//   } catch {
//     return [];
//   }
// };

/* ─── Default ─── */

const DEFAULT_AVATAR_URL = "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/8f6347f3-5b3f-4dfb-844d-bb2501cb9e3d.png";
const LOCAL_PREVIEW_AUTH_ENABLED =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_LOCAL_PREVIEW_AUTH === "1")
  || (typeof process !== "undefined" && process.env.VITE_LOCAL_PREVIEW_AUTH === "1")
  || import.meta.env?.VITE_LOCAL_PREVIEW_AUTH === "1";
const LOCAL_PREVIEW_BOT_ID = "bot_local_preview";

const defaultPlan: OpenClawUser["plan"] = {
  name: "体验版",
  tier: "free",
  trialDays: 7,
  aiCredits: 1000,
  usedCredits: 0,
  totalRequests: 0,
  maxBots: 1,
};

export const resolveBotQuotaForPassState = (
  pass: Pick<Pass, "bundle_id"> | null,
  hasResolvedPasses: boolean,
): number => {
  if (pass) return resolveBotQuotaPerAgent(pass);
  return hasResolvedPasses ? 1 : 0;
};

const defaultUser: OpenClawUser = {
  nickname: "用户",
  avatarUrl: DEFAULT_AVATAR_URL,
  plan: defaultPlan,
};

const buildLocalPreviewBot = (): OpenClawBot => ({
  id: LOCAL_PREVIEW_BOT_ID,
  instanceId: LOCAL_PREVIEW_BOT_ID,
  profileId: "main",
  isDefault: true,
  name: "我的Hermes",
  personality: "通用对话模板",
  personalityEmoji: "✨",
  intro: "本地预览 Agent 控制台",
  status: "running",
  createdAt: new Date().toISOString(),
  connectedChannels: [],
  installedSkills: [],
});

const OpenClawContext = createContext<OpenClawContextValue | null>(null);

/* ─── Provider ─── */

export const OpenClawProvider = ({ children }: PropsWithChildren) => {
  const { isAuthenticated, session, signOut: sessionSignOut } = useSession();
  const repositories = useRepositories();
  const effectiveIsAuthenticated = isAuthenticated || LOCAL_PREVIEW_AUTH_ENABLED;
  const [instanceDiscovery, setInstanceDiscovery] = useState<OpenClawContextValue["instanceDiscovery"]>(null);

  const [isSubscribed, setIsSubscribed] = useState(false);
  const [activePass, setActivePass] = useState<Pass | null>(null);
  const [modifyingPass, setModifyingPass] = useState<Pass | null>(null);
  const [passUpgradeFailed, setPassUpgradeFailed] = useState(false);
  const [passUpgradePaused, setPassUpgradePaused] = useState(false);
  const [passUpgradeRefreshing, setPassUpgradeRefreshing] = useState(false);
  const upgradePausedRef = useRef(false);
  const upgradeIssueTimer = useRef<number | undefined>(undefined);
  const upgradeRetry = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const [returningUpgrade, setReturningUpgrade] = useState(false);
  const modifyingPassRef = useRef<Pass | null>(null);
  const paidUpgradeRef = useRef<PaidUpgradeCheckout | null>(null);
  const passRefreshGeneration = useRef(0);
  const passRefreshInFlight = useRef(new Map<string, { promise: Promise<void>; queued?: Promise<void> }>());
  const botRefreshGeneration = useRef(0);
  const passUserIdRef = useRef(session.user?.id);
  passUserIdRef.current = session.user?.id;
  const [passesLoading, setPassesLoading] = useState(true);
  const [passesError, setPassesError] = useState(false);
  const [latestPass, setLatestPass] = useState<Pass | null>(null);
  const [hasResolvedPasses, setHasResolvedPasses] = useState(false);
  const [bots, setBots] = useState<OpenClawBot[]>([]);
  const [botsLoading, setBotsLoading] = useState(false);
  const [hasResolvedBots, setHasResolvedBots] = useState(false);
  const [botsError, setBotsError] = useState(false);
  const fetchedRef = useRef(false);

  const clearUpgradeIssue = useCallback(() => {
    window.clearTimeout(upgradeIssueTimer.current);
    upgradeIssueTimer.current = undefined;
    upgradePausedRef.current = false;
    setPassUpgradePaused(false);
    setPassesError(false);
  }, []);

  const trackPassQuery = useCallback((userId: string | undefined, generation: number, upgrading: boolean) => {
    if (upgradeIssueTimer.current !== undefined || upgradePausedRef.current) return;
    upgradeIssueTimer.current = window.setTimeout(() => {
      upgradeIssueTimer.current = undefined;
      if (passUserIdRef.current !== userId || passRefreshGeneration.current !== generation) return;
      // Retire a stuck read so a manual retry can start independently. Its late
      // response and queued refreshes must not change the recovered state.
      passRefreshGeneration.current += 1;
      passRefreshInFlight.current.delete(JSON.stringify([userId, generation]));
      upgradeRetry.current = null;
      setPassUpgradeRefreshing(false);
      upgradePausedRef.current = true;
      setPassUpgradePaused(upgrading);
      setPassesError(!upgrading);
    }, UPGRADE_RECOVERY_TIMEOUT_MS);
  }, []);

  useEffect(() => () => {
    window.clearTimeout(upgradeIssueTimer.current);
    upgradeIssueTimer.current = undefined;
    passRefreshGeneration.current += 1;
    botRefreshGeneration.current += 1;
    passRefreshInFlight.current.clear();
    upgradeRetry.current = null;
    // StrictMode replays effects on mount; the replay must fetch a fresh scope.
    fetchedRef.current = false;
  }, []);

  const beginPassUpgrade = useCallback((pass: Pass, checkout: PaidUpgradeCheckout) => {
    if (pass.user_id !== passUserIdRef.current) return;
    clearUpgradeIssue();
    upgradeRetry.current = null;
    setPassUpgradeRefreshing(false);
    const waiting = { ...pass, status: "modifying" };
    passRefreshGeneration.current += 1;
    paidUpgradeRef.current = checkout;
    setPassUpgradeFailed(false);
    modifyingPassRef.current = waiting;
    setModifyingPass(waiting);
    setActivePass(waiting);
    setLatestPass(waiting);
    setIsSubscribed(true);
  }, [clearUpgradeIssue]);

  /* ── 从后端订阅状态同步 isSubscribed ── */
  useEffect(() => {
    if (session.currentSubscription?.status === "active") {
      setIsSubscribed(true);
    } else if (session.currentSubscription) {
      setIsSubscribed(false);
    }
  }, [session.currentSubscription]);

  /* ── 拉取 /v1/passes 更新 activePass；如果存在未过期权益，同时设置 isSubscribed ── */
  const fetchPasses = useCallback(async (userId: string | undefined, generation: number) => {
    if (passUserIdRef.current !== userId || passRefreshGeneration.current !== generation) return;
    let waitingForReturn = false;
    let queryFailed = false;
    try {
      const returned = isGlobal && userId && !paidUpgradeRef.current && window.location.pathname.replace(/\/$/, "") === "/agents"
        ? readUpgradeReturn(window.localStorage, userId, window.location.search) : null;
      waitingForReturn = Boolean(returned);
      setReturningUpgrade(waitingForReturn);
      // Reset only after a usable response. Missing data and transport failures
      // share one bounded recovery window; healthy modifying has no time limit.
      // Also bound the initial read: Agents cannot show Bots before checking Pass state.
      trackPassQuery(userId, generation, Boolean(returned || modifyingPassRef.current));
      const passes = await repositories.plans.listMyPasses();
      if (passUserIdRef.current !== userId || generation !== passRefreshGeneration.current) return;
      if (returned) {
        const source = passes.find((pass) => pass.pass_id === returned.passId && pass.user_id === userId && !pass.deleted_time);
        if (!source) return;
        // A return URL is only a checkout hint. Keep Bots hidden while verifying the order.
        const waiting = { ...source, status: "modifying" };
        paidUpgradeRef.current = returned;
        modifyingPassRef.current = waiting;
        setModifyingPass(waiting);
        setActivePass(waiting);
        setLatestPass(waiting);
        setIsSubscribed(true);
        waitingForReturn = false;
        setReturningUpgrade(false);
      }
      const modifying = passes.find((pass) => pass.status === "modifying" && !pass.deleted_time) ?? null;
      const previous = modifyingPassRef.current;
      const paidCheckout = paidUpgradeRef.current;
      const order = paidCheckout ? await repositories.plans.getOrderStatus(paidCheckout.dealName) : null;
      if (passUserIdRef.current !== userId || generation !== passRefreshGeneration.current) return;
      if (paidCheckout && order) {
        if (order.deal_name !== paidCheckout.dealName || order.order_type !== "modify") return;
        const failed = order.status === "failed" || order.status === "cancelled";
        setPassUpgradeFailed(failed);
        if (failed) {
          clearUpgradeIssue();
          // The order service returns local terminal states without querying upstream.
          if (order.local_status === "cancelled" || order.local_status === "payment_failed" || order.local_status === "provision_failed") {
            upgradePausedRef.current = true;
            setPassUpgradePaused(true);
          }
          return;
        }
      }
      if (previous && !modifying) {
        // A missing response or a future expiry does not prove upgrade completion.
        const completed = passes.find((pass) => pass.pass_id === previous.pass_id);
        if (completed?.status !== "active") return;
        if (paidCheckout) {
          if (!order) return;
          if (!isUpgradeDelivered(order, completed, previous.pass_id, paidCheckout.targetBundleId)) {
            clearUpgradeIssue();
            return;
          }
        }
        const botGeneration = ++botRefreshGeneration.current;
        const snapshot = await repositories.bots.getDashboardSnapshot("live");
        if (passUserIdRef.current !== userId || generation !== passRefreshGeneration.current || botGeneration !== botRefreshGeneration.current) return;
        setBots(snapshot.bots.map((bot) => mapBotToOpenClawBot(bot)));
        setBotsLoading(false);
        if (paidCheckout && userId) {
          try {
            window.localStorage.removeItem(upgradeReturnKey(userId, paidCheckout.dealName));
            const url = new URL(window.location.href);
            if (url.searchParams.get(UPGRADE_RETURN_QUERY) === paidCheckout.dealName) {
              url.searchParams.delete(UPGRADE_RETURN_QUERY);
              window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
            }
          } catch { /* Cleanup must not prevent displaying a delivered upgrade. */ }
        }
        paidUpgradeRef.current = null;
      }
      clearUpgradeIssue();
      modifyingPassRef.current = modifying;
      setModifyingPass(modifying);
      const now = Date.now();
      // Keep expired modifying visible for recovery; this is not usable entitlement.
      const active = passes.find((p) => !p.deleted_time && new Date(p.expired_time).getTime() > now) ?? modifying;
      setActivePass(active);
      setIsSubscribed(Boolean(active));
      setHasResolvedPasses(true);
      // 保存最新的 pass（即使已过期），用于定价页匹配"当前订阅"套餐
      const latest = passes
        .filter((p) => !p.deleted_time)
        .sort((a, b) => new Date(b.expired_time).getTime() - new Date(a.expired_time).getTime())[0] ?? null;
      setLatestPass(latest);
    } catch {
      /* 接口失败不阻断其他流程，保持现有状态 */
      queryFailed = true;
      if (passUserIdRef.current === userId && generation === passRefreshGeneration.current
        && !waitingForReturn && !modifyingPassRef.current) {
        clearUpgradeIssue();
        setPassesError(true);
      }
    } finally {
      // Failed reads cannot complete the initial Pass check and expose Bots.
      if (!queryFailed && passUserIdRef.current === userId && generation === passRefreshGeneration.current) setPassesLoading(waitingForReturn);
    }
  }, [repositories.plans, repositories.bots, clearUpgradeIssue, trackPassQuery]);

  const requestPassRefresh = useCallback(function request(reason: "manual" | "poll"): Promise<void> {
    if (reason === "poll" && upgradePausedRef.current) return Promise.resolve();
    const userId = passUserIdRef.current;
    const generation = passRefreshGeneration.current;
    const key = JSON.stringify([userId, generation]);
    const inFlight = passRefreshInFlight.current.get(key);
    if (inFlight) {
      if (reason === "poll") return inFlight.promise;
      // Manual callers await one trailing read; rapid clicks share that promise.
      inFlight.queued ??= inFlight.promise.then(() => {
        if (passUserIdRef.current !== userId || passRefreshGeneration.current !== generation) return;
        return request("manual");
      });
      return inFlight.queued;
    }
    const job = { promise: Promise.resolve().then(() => fetchPasses(userId, generation)) };
    passRefreshInFlight.current.set(key, job);
    job.promise = job.promise.finally(() => {
      if (passRefreshInFlight.current.get(key) === job) passRefreshInFlight.current.delete(key);
    });
    return job.promise;
  }, [fetchPasses]);

  const refreshPasses = useCallback(() => {
    if (upgradePausedRef.current) clearUpgradeIssue();
    setPassesError(false);
    return requestPassRefresh("manual");
  }, [clearUpgradeIssue, requestPassRefresh]);
  const retryPassUpgrade = useCallback((): Promise<void> => {
    const userId = passUserIdRef.current;
    const generation = passRefreshGeneration.current;
    const key = JSON.stringify([userId, generation]);
    if (upgradeRetry.current?.key === key) return upgradeRetry.current.promise;
    clearUpgradeIssue();
    setPassUpgradeRefreshing(true);
    const retry = { key, promise: refreshPasses().finally(() => {
      if (upgradeRetry.current !== retry) return;
      upgradeRetry.current = null;
      if (passUserIdRef.current === userId && passRefreshGeneration.current === generation) setPassUpgradeRefreshing(false);
    }) };
    upgradeRetry.current = retry;
    return retry.promise;
  }, [clearUpgradeIssue, refreshPasses]);

  useEffect(() => {
    if ((!modifyingPass && !returningUpgrade) || passUpgradePaused) return;
    const timer = window.setInterval(() => { void requestPassRefresh("poll"); }, UPGRADE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [modifyingPass?.pass_id, returningUpgrade, passUpgradePaused, requestPassRefresh]);

  /* ── Derive user from session instead of manual sync ── */
  const user = useMemo<OpenClawUser>(() => {
    if (!effectiveIsAuthenticated || !session.user) {
      return defaultUser;
    }
    /**
     * 积分来源统一为 /v1/passes：
     *   aiCredits / usedCredits 包含套餐和赠送积分，使用与侧栏相同的汇总口径。
     * 没有活跃 pass 时保持 defaultPlan 的默认值。
     */
    const passCredits = activePass ? summarizePassCredits(activePass) : null;
    const planFromPass = activePass && passCredits ? {
      name: activePass.bundle_name || defaultPlan.name,
      aiCredits: passCredits.total,
      usedCredits: passCredits.used,
    } : null;

    return {
      nickname: session.user.name || defaultUser.nickname,
      avatarUrl: session.user.avatarUrl || DEFAULT_AVATAR_URL,
      phone: session.user.phone,
      email: session.user.email,
      plan: {
        ...defaultPlan,
        ...(planFromPass ?? {}),
        maxBots: resolveBotQuotaForPassState(activePass, hasResolvedPasses),
      },
    };
  }, [activePass, effectiveIsAuthenticated, hasResolvedPasses, session.user]);

  /* ── Load bots from backend, then fetch openclaw config to restore channel status ── */
  const refreshBots = useCallback(async () => {
    const generation = ++botRefreshGeneration.current;
    const accountId = session.user?.id;
    const token = readStoredAuthToken();
    const isCurrent = () => generation === botRefreshGeneration.current && readStoredAuthToken() === token;
    setInstanceDiscovery(null);
    setBotsLoading(true);
    try {
      const snapshot = await repositories.bots.getDashboardSnapshot("live", {
        onInstances: items => {
          if (accountId && token && isCurrent()) setInstanceDiscovery({ accountId, items, isCurrent });
        },
      });
      if (generation !== botRefreshGeneration.current) return;
      const mappedBots = projectBotCatalog(snapshot.bots)
        .map(({ source }) => mapBotToOpenClawBot(source));
      setBots(mappedBots);
      setHasResolvedBots(true);
      setBotsError(false);

      /* 对每个 bot 尝试获取 openclaw 配置，恢复通道状态 */
      /* 目前代码适配hermes， openclaw_config暂不进行查询 */
      // for (const bot of mappedBots) {
      //   try {
      //     const result = await repositories.bots.execDebugCommand(bot.id, "openclaw_config");
      //     console.log("[CHANNEL-DEBUG] execDebugCommand result for", bot.id, ":", result.status, result.exitCode);
      //     if (result.status === "SUCCESS" && result.output) {
      //       console.log("[CHANNEL-DEBUG] raw output (first 500 chars):", result.output.substring(0, 500));
      //       try {
      //         const parsed = JSON.parse(result.output);
      //         console.log("[CHANNEL-DEBUG] parsed channels keys:", parsed?.channels ? Object.keys(parsed.channels) : "no channels field");
      //         console.log("[CHANNEL-DEBUG] parsed channels:", JSON.stringify(parsed?.channels, null, 2)?.substring(0, 500));
      //       } catch {
      //         console.log("[CHANNEL-DEBUG] failed to parse output as JSON");
      //       }
      //       const channels = parseChannelsFromConfig(result.output);
      //       console.log("[CHANNEL-DEBUG] resolved channels:", channels);
      //       if (channels.length > 0) {
      //         setBots((prev) =>
      //           prev.map((b) => (b.id === bot.id ? { ...b, connectedChannels: channels } : b)),
      //         );
      //       }
      //     }
      //   } catch (err) {
      //     console.log("[CHANNEL-DEBUG] execDebugCommand failed for", bot.id, ":", err);
      //     /* 获取配置失败不影响主流程 */
      //   }
      // }
    } catch {
      if (generation === botRefreshGeneration.current) setInstanceDiscovery(null);
      if (generation === botRefreshGeneration.current) setBotsError(true);
      if (generation === botRefreshGeneration.current && LOCAL_PREVIEW_AUTH_ENABLED) {
        setBots((prev) => (prev.length > 0 ? prev : [buildLocalPreviewBot()]));
      }
    } finally {
      if (generation === botRefreshGeneration.current) setBotsLoading(false);
    }
  }, [repositories.bots, session.user?.id]);

  /* ── Fetch bots & passes once on login ── */
  const fetchedUserIdRef = useRef(session.user?.id);
  useEffect(() => {
    if (fetchedUserIdRef.current === session.user?.id) return;
    fetchedUserIdRef.current = session.user?.id;
    passRefreshGeneration.current += 1;
    passRefreshInFlight.current.clear();
    botRefreshGeneration.current += 1;
    modifyingPassRef.current = null;
    paidUpgradeRef.current = null;
    upgradeRetry.current = null;
    clearUpgradeIssue();
    setPassUpgradeRefreshing(false);
    setPassUpgradeFailed(false);
    setReturningUpgrade(false);
    setModifyingPass(null);
    setActivePass(null);
    setLatestPass(null);
    setHasResolvedPasses(false);
    setIsSubscribed(false);
    setBots([]);
    setInstanceDiscovery(null);
    setHasResolvedBots(false);
    setBotsError(false);
    setPassesLoading(Boolean(session.user));
    fetchedRef.current = false;
  }, [session.user?.id, clearUpgradeIssue]);

  useEffect(() => {
    if (LOCAL_PREVIEW_AUTH_ENABLED && session.authReady) {
      if (!fetchedRef.current) {
        fetchedRef.current = true;
        void refreshBots();
        void refreshPasses();
      }
    } else if (isAuthenticated && session.user) {
      if (!fetchedRef.current) {
        fetchedRef.current = true;
        void refreshBots();
        void refreshPasses();
      }
    } else if (!isAuthenticated && session.authReady) {
      clearUpgradeIssue();
      passRefreshGeneration.current += 1;
      botRefreshGeneration.current += 1;
      upgradeRetry.current = null;
      setPassUpgradeRefreshing(false);
      setIsSubscribed(false);
      setActivePass(null);
      setModifyingPass(null);
      setPassUpgradeFailed(false);
      setReturningUpgrade(false);
      modifyingPassRef.current = null;
      paidUpgradeRef.current = null;
      setPassesLoading(false);
      setLatestPass(null);
      setHasResolvedPasses(false);
      setBots([]);
      setInstanceDiscovery(null);
      setHasResolvedBots(false);
      setBotsError(false);
      fetchedRef.current = false;
    }
  }, [isAuthenticated, session.authReady, session.user, refreshBots, refreshPasses, clearUpgradeIssue]);

  /* login() is a no-op now — isLoggedIn is derived from isAuthenticated */
  const login = useCallback(() => {
    /* intentionally empty: login state is driven by SessionContext */
  }, []);

  const logout = useCallback(() => {
    clearUpgradeIssue();
    passRefreshGeneration.current += 1;
    passRefreshInFlight.current.clear();
    botRefreshGeneration.current += 1;
    upgradeRetry.current = null;
    setPassUpgradeRefreshing(false);
    setIsSubscribed(false);
    setActivePass(null);
    setModifyingPass(null);
    setPassUpgradeFailed(false);
    setReturningUpgrade(false);
    modifyingPassRef.current = null;
    paidUpgradeRef.current = null;
    setLatestPass(null);
    setHasResolvedPasses(false);
    setBots([]);
    setHasResolvedBots(false);
    setBotsError(false);
    fetchedRef.current = false;
    void sessionSignOut();
  }, [sessionSignOut, clearUpgradeIssue]);

  const subscribe = useCallback(() => {
    setIsSubscribed(true);
  }, []);

  const updateUser = useCallback((_updates: Partial<OpenClawUser>) => {
    /* User fields are now derived from session — profile updates go through SessionContext.updateProfile */
  }, []);

  const addBot = useCallback(
    async (bot: Omit<OpenClawBot, "id" | "instanceId" | "profileId" | "isDefault" | "createdAt" | "connectedChannels" | "installedSkills"> & {
      createMode?: "blank" | "clone";
      sourceBotId?: string;
      initialSoul?: string;
    }): Promise<OpenClawBot> => {
      const created = await repositories.bots.createBot({
        name: bot.name,
        description: bot.description,
        soulTemplateId: bot.soulTemplateId || undefined,
        createMode: bot.createMode,
        sourceBotId: bot.sourceBotId,
        initialSoul: bot.initialSoul,
      });
      const isInitialInstanceCreation = created.id === (created.instanceId ?? created.id);

      // A newly created instance is still provisioning. Profile reads must wait until it is Running.
      if (!isInitialInstanceCreation) {
        await repositories.bots.updateBotProfile(created.id, {
          template: bot.personality,
          mission: bot.intro || undefined,
        });
      }

      const openClawBot: OpenClawBot = {
        id: created.id,
        instanceId: created.instanceId ?? created.id,
        profileId: created.profileId ?? "main",
        isDefault: created.isDefault ?? true,
        description: created.description,
        createdFrom: created.createdFrom,
        sourceBotId: created.sourceBotId,
        name: bot.name,
        personality: bot.personality,
        personalityEmoji: bot.personalityEmoji,
        intro: bot.intro,
        status: mapBotToOpenClawBot(created).status,
        createdAt: created.createdAt,
        connectedChannels: [],
        installedSkills: [],
      };

      setBots((prev) => [...prev, openClawBot]);
      return openClawBot;
    },
    [repositories.bots],
  );

  const updateBot = useCallback((botId: string, updates: Partial<OpenClawBot>) => {
    setBots((prev) => prev.map((b) => (b.id === botId ? { ...b, ...updates } : b)));
  }, []);

  const deleteBot = useCallback(async (botId: string) => {
    /* Call real backend to destroy the instance */
    await repositories.bots.destroyBot(botId);
    setBots((prev) => prev.filter((b) => b.id !== botId));
  }, [repositories.bots]);

  const value = useMemo<OpenClawContextValue>(
    () => ({
      isLoggedIn: effectiveIsAuthenticated,
      isSubscribed,
      user,
      bots,
      instanceDiscovery: instanceDiscovery && instanceDiscovery.accountId === session.user?.id && instanceDiscovery.isCurrent() ? instanceDiscovery : null,
      botsLoading,
      hasResolvedBots: hasResolvedBots && fetchedUserIdRef.current === session.user?.id,
      botsError,
      activePass,
      modifyingPass,
      passUpgradeFailed,
      passUpgradePaused,
      passUpgradeRefreshing,
      returningUpgrade,
      retryPassUpgrade,
      passesLoading,
      passesError,
      hasResolvedPasses: hasResolvedPasses && fetchedUserIdRef.current === session.user?.id,
      latestPass,
      login,
      logout,
      subscribe,
      refreshPasses,
      beginPassUpgrade,
      updateUser,
      addBot,
      updateBot,
      deleteBot,
      refreshBots,
    }),
    [effectiveIsAuthenticated, isSubscribed, user, bots, instanceDiscovery, botsLoading, hasResolvedBots, botsError, activePass, modifyingPass, passUpgradeFailed, passUpgradePaused, passUpgradeRefreshing, returningUpgrade, retryPassUpgrade, passesLoading, passesError, hasResolvedPasses, latestPass, login, logout, subscribe, refreshPasses, beginPassUpgrade, updateUser, addBot, updateBot, deleteBot, refreshBots, session.user?.id],
  );

  return <OpenClawContext value={value}>{children}</OpenClawContext>;
};

export const useOpenClaw = () => {
  const context = useContext(OpenClawContext);
  if (!context) {
    throw new Error("useOpenClaw must be used within OpenClawProvider");
  }
  return context;
};
