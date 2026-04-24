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
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import { fetchUsage } from "@/repositories/http-repositories";
import type { Bot } from "@/domain/types";

/* ─── Types ─── */

export interface OpenClawBot {
  id: string;
  name: string;
  personality: string;
  personalityEmoji: string;
  intro: string;
  soulTemplateId?: string;
  status: "running" | "paused" | "draft";
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
  login: () => void;
  logout: () => void;
  subscribe: () => void;
  updateUser: (updates: Partial<OpenClawUser>) => void;
  addBot: (bot: Omit<OpenClawBot, "id" | "createdAt" | "connectedChannels" | "installedSkills">) => Promise<OpenClawBot>;
  updateBot: (botId: string, updates: Partial<OpenClawBot>) => void;
  deleteBot: (botId: string) => Promise<void>;
  refreshBots: () => Promise<void>;
}

/* ─── Helpers ─── */

/** Map a backend Bot to the frontend OpenClawBot shape */
const mapBotToOpenClawBot = (bot: Bot): OpenClawBot => ({
  id: bot.id,
  name: bot.name,
  personality: bot.template || "默认设定",
  personalityEmoji: "✨",
  intro: bot.mission || "",
  status: bot.status === "active" ? "running" : bot.status === "paused" ? "paused" : "draft",
  createdAt: bot.createdAt,
  connectedChannels: [],
  installedSkills: [],
});

/* ─── Default ─── */

const DEFAULT_AVATAR_URL = "https://cloudcache.tencent-cloud.com/qcloud/ui/static/other_external_resource/8f6347f3-5b3f-4dfb-844d-bb2501cb9e3d.png";

const defaultPlan: OpenClawUser["plan"] = {
  name: "体验版",
  tier: "free",
  trialDays: 7,
  aiCredits: 1000,
  usedCredits: 0,
  totalRequests: 0,
  maxBots: 2,
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
  const [usageCredits, setUsageCredits] = useState<{ aiCredits: number; usedCredits: number; totalRequests: number } | null>(null);
  const [bots, setBots] = useState<OpenClawBot[]>([]);
  const [botsLoading, setBotsLoading] = useState(false);
  const fetchedRef = useRef(false);

  /* ── 从后端订阅状态同步 isSubscribed ── */
  useEffect(() => {
    if (session.currentSubscription?.status === "active") {
      setIsSubscribed(true);
    }
  }, [session.currentSubscription]);

  /* ── Derive user from session instead of manual sync ── */
  const user = useMemo<OpenClawUser>(() => {
    if (!isAuthenticated || !session.user) {
      return defaultUser;
    }
    return {
      nickname: session.user.name || defaultUser.nickname,
      avatarUrl: session.user.avatarUrl || DEFAULT_AVATAR_URL,
      phone: session.user.phone,
      email: session.user.email,
      plan: {
        ...defaultPlan,
        ...(usageCredits ? { aiCredits: usageCredits.aiCredits, usedCredits: usageCredits.usedCredits, totalRequests: usageCredits.totalRequests } : {}),
      },
    };
  }, [isAuthenticated, session.user, usageCredits]);

  /* ── Load bots from backend ── */
  const refreshBots = useCallback(async () => {
    setBotsLoading(true);
    try {
      const snapshot = await repositories.bots.getDashboardSnapshot("live");
      setBots(snapshot.bots.map(mapBotToOpenClawBot));
    } catch {
      /* silently ignore – bots stay as-is */
    } finally {
      setBotsLoading(false);
    }
  }, [repositories.bots]);

  /* ── Fetch bots & usage once on login ── */
  useEffect(() => {
    if (isAuthenticated && session.user) {
      if (!fetchedRef.current) {
        fetchedRef.current = true;
        void refreshBots();

        const baseUrl = resolveConfiguredAuthApiBaseUrl();
        if (baseUrl) {
          fetchUsage(baseUrl).then((usage) => {
            setUsageCredits({ aiCredits: usage.totalCredits, usedCredits: usage.usedCredits, totalRequests: usage.totalRequests });
          }).catch(() => { /* silently ignore usage fetch errors */ });
        }
      }
    } else if (!isAuthenticated && session.authReady) {
      setIsSubscribed(false);
      setUsageCredits(null);
      setBots([]);
      fetchedRef.current = false;
    }
  }, [isAuthenticated, session.authReady, session.user, refreshBots]);

  /* login() is a no-op now — isLoggedIn is derived from isAuthenticated */
  const login = useCallback(() => {
    /* intentionally empty: login state is driven by SessionContext */
  }, []);

  const logout = useCallback(() => {
    setIsSubscribed(false);
    setUsageCredits(null);
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
        status: bot.status === "running" ? "running" : bot.status === "paused" ? "paused" : "draft",
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
      login,
      logout,
      subscribe,
      updateUser,
      addBot,
      updateBot,
      deleteBot,
      refreshBots,
    }),
    [isAuthenticated, isSubscribed, user, bots, botsLoading, login, logout, subscribe, updateUser, addBot, updateBot, deleteBot, refreshBots],
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
