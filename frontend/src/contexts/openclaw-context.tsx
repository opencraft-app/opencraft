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
import type { Bot, Pass } from "@/domain/types";

/* ─── Types ─── */

export interface OpenClawBot {
  id: string;
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
  botsLoading: boolean;
  /** 当前用户的权益最新快照（来自 GET /v1/passes） */
  activePass: Pass | null;
  login: () => void;
  logout: () => void;
  subscribe: () => void;
  /** 重新拉取 /v1/passes 并更新 activePass / isSubscribed */
  refreshPasses: () => Promise<void>;
  updateUser: (updates: Partial<OpenClawUser>) => void;
  addBot: (bot: Omit<OpenClawBot, "id" | "createdAt" | "connectedChannels" | "installedSkills">) => Promise<OpenClawBot>;
  updateBot: (botId: string, updates: Partial<OpenClawBot>) => void;
  deleteBot: (botId: string) => Promise<void>;
  refreshBots: () => Promise<void>;
}

/* ─── Helpers ─── */

/** Map a backend Bot to the frontend OpenClawBot shape */
const mapBotToOpenClawBot = (bot: Bot, channels?: ("wechat" | "qq")[]): OpenClawBot => ({
  id: bot.id,
  name: bot.name,
  personality: bot.template || "默认设定",
  personalityEmoji: "✨",
  intro: bot.mission || "",
  status: bot.status === "active"
    ? "running"
    : bot.status === "paused"
      ? "paused"
      : bot.status === "provisioning"
        ? "provisioning"
        : bot.status === "failed"
          ? "failed"
          : bot.status === "deleting"
            ? "deleting"
            : "draft",
  createdAt: bot.createdAt,
  connectedChannels: channels ?? [],
  installedSkills: [],
});

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

const defaultPlan: OpenClawUser["plan"] = {
  name: "体验版",
  tier: "free",
  trialDays: 7,
  aiCredits: 1000,
  usedCredits: 0,
  totalRequests: 0,
  maxBots: 1,
};

const defaultUser: OpenClawUser = {
  nickname: "用户",
  avatarUrl: DEFAULT_AVATAR_URL,
  plan: defaultPlan,
};

const OpenClawContext = createContext<OpenClawContextValue | null>(null);

/* ─── Provider ─── */

export const OpenClawProvider = ({ children }: PropsWithChildren) => {
  const { isAuthenticated, session, signOut: sessionSignOut } = useSession();
  const repositories = useRepositories();

  const [isSubscribed, setIsSubscribed] = useState(false);
  const [activePass, setActivePass] = useState<Pass | null>(null);
  const [bots, setBots] = useState<OpenClawBot[]>([]);
  const [botsLoading, setBotsLoading] = useState(false);
  const fetchedRef = useRef(false);

  /* ── 从后端订阅状态同步 isSubscribed ── */
  useEffect(() => {
    if (session.currentSubscription?.status === "active") {
      setIsSubscribed(true);
    } else if (session.currentSubscription && session.currentSubscription.status !== "active") {
      setIsSubscribed(false);
    }
  }, [session.currentSubscription]);

  /* ── 拉取 /v1/passes 更新 activePass；如果存在未过期权益，同时设置 isSubscribed ── */
  const refreshPasses = useCallback(async () => {
    try {
      const passes = await repositories.plans.listMyPasses();
      const now = Date.now();
      const active = passes.find((p) => !p.deleted_time && new Date(p.expired_time).getTime() > now) ?? null;
      setActivePass(active);
      setIsSubscribed(Boolean(active));
    } catch {
      /* 接口失败不阻断其他流程，保持现有状态 */
    }
  }, [repositories.plans]);

  /* ── Derive user from session instead of manual sync ── */
  const user = useMemo<OpenClawUser>(() => {
    if (!isAuthenticated || !session.user) {
      return defaultUser;
    }
    /**
     * 积分来源统一为 /v1/passes：
     *   aiCredits   = activePass.credit_total
     *   usedCredits = credit_total - credit_available
     * 没有活跃 pass 时保持 defaultPlan 的默认值。
     */
    const planFromPass = activePass ? {
      name: activePass.bundle_name || defaultPlan.name,
      aiCredits: activePass.credit_total,
      usedCredits: Math.max(0, activePass.credit_total - activePass.credit_available),
    } : null;

    return {
      nickname: session.user.name || defaultUser.nickname,
      avatarUrl: session.user.avatarUrl || DEFAULT_AVATAR_URL,
      phone: session.user.phone,
      email: session.user.email,
      plan: {
        ...defaultPlan,
        ...(planFromPass ?? {}),
      },
    };
  }, [isAuthenticated, session.user, activePass]);

  /* ── Load bots from backend, then fetch openclaw config to restore channel status ── */
  const refreshBots = useCallback(async () => {
    setBotsLoading(true);
    try {
      const snapshot = await repositories.bots.getDashboardSnapshot("live");
      const mappedBots = snapshot.bots.map((bot) => mapBotToOpenClawBot(bot));
      setBots(mappedBots);

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
      /* silently ignore – bots stay as-is */
    } finally {
      setBotsLoading(false);
    }
  }, [repositories.bots]);

  /* ── Fetch bots & passes once on login ── */
  useEffect(() => {
    if (isAuthenticated && session.user) {
      if (!fetchedRef.current) {
        fetchedRef.current = true;
        void refreshBots();
        void refreshPasses();
      }
    } else if (!isAuthenticated && session.authReady) {
      setIsSubscribed(false);
      setActivePass(null);
      setBots([]);
      fetchedRef.current = false;
    }
  }, [isAuthenticated, session.authReady, session.user, refreshBots, refreshPasses]);

  /* login() is a no-op now — isLoggedIn is derived from isAuthenticated */
  const login = useCallback(() => {
    /* intentionally empty: login state is driven by SessionContext */
  }, []);

  const logout = useCallback(() => {
    setIsSubscribed(false);
    setActivePass(null);
    setBots([]);
    fetchedRef.current = false;
    void sessionSignOut();
  }, [sessionSignOut]);

  const subscribe = useCallback(() => {
    setIsSubscribed(true);
  }, []);

  const updateUser = useCallback((_updates: Partial<OpenClawUser>) => {
    /* User fields are now derived from session — profile updates go through SessionContext.updateProfile */
  }, []);

  const addBot = useCallback(
    async (bot: Omit<OpenClawBot, "id" | "createdAt" | "connectedChannels" | "installedSkills">): Promise<OpenClawBot> => {
      /* Call real backend to create an instance */
      const created = await repositories.bots.createBot({
        name: bot.name,
        soulTemplateId: bot.soulTemplateId || undefined,
      });

      /* Persist personality/intro as draft metadata via updateBotProfile */
      await repositories.bots.updateBotProfile(created.id, {
        name: bot.name,
        template: bot.personality,
        mission: bot.intro || undefined,
      });

      const openClawBot: OpenClawBot = {
        id: created.id,
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
      isLoggedIn: isAuthenticated,
      isSubscribed,
      user,
      bots,
      botsLoading,
      activePass,
      login,
      logout,
      subscribe,
      refreshPasses,
      updateUser,
      addBot,
      updateBot,
      deleteBot,
      refreshBots,
    }),
    [isAuthenticated, isSubscribed, user, bots, botsLoading, activePass, login, logout, subscribe, refreshPasses, updateUser, addBot, updateBot, deleteBot, refreshBots],
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
