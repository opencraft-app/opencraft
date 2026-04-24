import { planCatalog } from "@/domain/plan-catalog";
import type {
  AuthSessionSnapshot,
  BillingSummary,
  Bot,
  BotChannelConfigResult,
  BotTerminalSession,
  BotRuntime,
  BotVersion,
  CurrentSubscription,
  Deployment,
  InviteCodeValidation,
  KnowledgeSource,
  ToolBinding,
  User,
  VerificationCodeRequest,
  WorkspaceMessage,
} from "@/domain/types";
import { createFakeRepositories } from "@/repositories/fake-repositories";
import type {
  AuthRepository,
  BotRepository,
  DashboardSnapshot,
  PlanRepository,
  Repositories,
  SettingsSnapshot,
  WorkspaceSnapshot,
} from "@/repositories/types";

interface SessionPayload {
  session: {
    user: User;
    authenticatedAt?: string;
    sessionToken?: string;
  };
}

interface ApiErrorPayload {
  code?: string;
  message?: string;
  retryAfterSeconds?: number;
}

interface CurrentSubscriptionPayload {
  hasSubscription: boolean;
  subscription?: {
    code: "free" | "lite" | "pro";
    status: "active" | "pending_payment" | "cancelled" | "expired";
    currentPeriodStart?: string;
    currentPeriodEnd?: string;
    updatedAt?: string;
    createdAt?: string;
  } | null;
}

interface APIEnvelope<T> {
  code: string;
  message: string;
  data: T;
  request_id?: string;
}

interface CtlInstancePayload {
  instance_id: string;
  sandbox_id?: string;
  status: string;
  created_at: string;
  timeout_at?: string;
}

interface CtlListInstancesPayload {
  total: number;
  page: number;
  page_size: number;
  items: CtlInstancePayload[];
}

interface CtlConfigureChannelPayload {
  status: string;
  channel: string;
  gateway_restarted: boolean;
  output?: string;
}

const AUTH_TOKEN_STORAGE_KEY = "lightclaw-auth-token-v1";
const OAUTH_SESSION_TOKEN_FRAGMENT_KEY = "session_token";
const HTTP_BOT_DRAFTS_STORAGE_KEY = "lightclaw-http-bot-drafts-v1";
const DEFAULT_INSTANCE_TIMEOUT_SECONDS = 60 * 60;
export const AUTH_UNAUTHORIZED_EVENT = "lightclaw:auth-unauthorized";

class RepositoryError extends Error {
  status: number;
  code?: string;
  retryAfterSeconds?: number;

  constructor(message: string, status: number, code?: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "RepositoryError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const resolveConfiguredAuthApiBaseUrl = () => {
  const configured = import.meta.env.VITE_AUTH_API_BASE_URL?.trim();

  if (configured && configured.length > 0) {
    if (configured.toLowerCase() === "mock") {
      return null;
    }
    return configured.replace(/\/$/, "");
  }

  if (typeof window !== "undefined") {
    const hostname = window.location.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return "http://localhost:8081";
    }
    if (
      hostname === "lightclaw.tech"
      || hostname === "www.lightclaw.tech"
      || hostname === "lightclaw.pages.dev"
      || hostname.endsWith(".lightclaw.pages.dev")
    ) {
      return "https://lightclaw.tech";
    }
  }

  return null;
};

const authStorage = () => {
  if (typeof globalThis === "undefined") {
    return null;
  }

  const storage = globalThis.localStorage;
  if (
    !storage
    || typeof storage.getItem !== "function"
    || typeof storage.setItem !== "function"
    || typeof storage.removeItem !== "function"
  ) {
    return null;
  }

  return storage;
};

export const readStoredAuthToken = (): string | null => {
  const storage = authStorage();
  if (!storage) {
    return null;
  }

  const value = storage.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim();
  return value ? value : null;
};

export const writeStoredAuthToken = (token?: string | null) => {
  const storage = authStorage();
  if (!storage) {
    return;
  }

  const normalized = token?.trim();
  if (!normalized) {
    storage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    return;
  }

  storage.setItem(AUTH_TOKEN_STORAGE_KEY, normalized);
};

const broadcastUnauthorized = () => {
  writeStoredAuthToken(null);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
  }
};

export const bootstrapStoredAuthTokenFromLocation = () => {
  if (typeof window === "undefined") {
    return;
  }

  const rawFragment = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!rawFragment) {
    return;
  }

  const fragment = new URLSearchParams(rawFragment);
  const sessionToken = fragment.get(OAUTH_SESSION_TOKEN_FRAGMENT_KEY)?.trim();
  if (!sessionToken) {
    return;
  }

  writeStoredAuthToken(sessionToken);
  fragment.delete(OAUTH_SESSION_TOKEN_FRAGMENT_KEY);

  const cleanedFragment = fragment.toString();
  const cleanedURL = `${window.location.pathname}${window.location.search}${cleanedFragment ? `#${cleanedFragment}` : ""}`;
  window.history.replaceState(window.history.state, "", cleanedURL);
};

const mapSession = (payload: SessionPayload): AuthSessionSnapshot => ({
  user: payload.session.user,
  currentSubscription: null,
  authenticatedAt: payload.session.authenticatedAt,
  sessionToken: payload.session.sessionToken,
});

const buildUrl = (baseUrl: string, path: string) => `${baseUrl}${path}`;

const mapSubscriptionCodeToTier = (code: "free" | "lite" | "pro"): CurrentSubscription["tier"] => {
  switch (code) {
    case "lite":
      return "plus";
    case "pro":
      return "max";
    case "free":
    default:
      return "free";
  }
};

const mapTierToSubscriptionCode = (tier: CurrentSubscription["tier"]): "free" | "lite" | "pro" => {
  switch (tier) {
    case "plus":
      return "lite";
    case "max":
      return "pro";
    case "free":
    default:
      return "free";
  }
};

const mapCurrentSubscription = (payload: CurrentSubscriptionPayload): CurrentSubscription | null => {
  if (!payload.hasSubscription || !payload.subscription) {
    return null;
  }

  return {
    tier: mapSubscriptionCodeToTier(payload.subscription.code),
    code: payload.subscription.code,
    status: payload.subscription.status,
    currentPeriodStart: payload.subscription.currentPeriodStart,
    currentPeriodEnd: payload.subscription.currentPeriodEnd,
    createdAt: payload.subscription.createdAt,
    updatedAt: payload.subscription.updatedAt,
  };
};

const resolveAPIURL = (baseUrl: string, path: string) => {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return buildUrl(baseUrl, path);
};

const parseApiError = async (response: Response): Promise<RepositoryError> => {
  let payload: ApiErrorPayload | null = null;

  try {
    payload = (await response.json()) as ApiErrorPayload;
  } catch {
    payload = null;
  }

  const message = payload?.message?.trim() || `请求失败（${response.status}）`;
  return new RepositoryError(message, response.status, payload?.code, payload?.retryAfterSeconds);
};

const request = async <T>(
  baseUrl: string,
  path: string,
  init?: Omit<RequestInit, "body"> & { body?: unknown; suppressUnauthorizedBroadcast?: boolean },
): Promise<T> => {
  const headers = new Headers(init?.headers);
  const body = init?.body;
  const suppressUnauthorizedBroadcast = init?.suppressUnauthorizedBroadcast === true;

  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  const authToken = readStoredAuthToken();
  if (authToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(baseUrl, path), {
      credentials: "include",
      ...init,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new RepositoryError("认证服务不可用，请先启动 Go auth 服务。", 0, "network_error");
  }

  if (!response.ok) {
    if (response.status === 401 && !suppressUnauthorizedBroadcast) {
      broadcastUnauthorized();
    }
    throw await parseApiError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = (await response.json()) as T;
  const maybeSession = payload as SessionPayload;
  const sessionToken = maybeSession?.session?.sessionToken?.trim();
  if (sessionToken) {
    writeStoredAuthToken(sessionToken);
  }
  return payload;
};

const requestEnvelope = async <T>(
  baseUrl: string,
  path: string,
  init?: Omit<RequestInit, "body"> & { body?: unknown },
): Promise<T> => {
  const payload = await request<APIEnvelope<T>>(baseUrl, path, init);
  return payload.data;
};

const requestMultipart = async <T>(
  baseUrl: string,
  path: string,
  file: File,
): Promise<T> => {
  const formData = new FormData();
  formData.append("file", file);

  const headers = new Headers();
  const authToken = readStoredAuthToken();
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(baseUrl, path), {
      method: "PUT",
      credentials: "include",
      headers,
      body: formData,
    });
  } catch {
    throw new RepositoryError("认证服务不可用，请先启动 Go auth 服务。", 0, "network_error");
  }

  if (!response.ok) {
    if (response.status === 401) {
      broadcastUnauthorized();
    }
    throw await parseApiError(response);
  }

  return (await response.json()) as T;
};

const fetchCurrentSubscription = async (baseUrl: string): Promise<CurrentSubscription | null> => {
  try {
    const payload = await request<CurrentSubscriptionPayload>(baseUrl, "/subscriptions/current", {
      method: "GET",
    });
    return mapCurrentSubscription(payload);
  } catch (error) {
    if (error instanceof RepositoryError && (error.status === 401 || error.status === 404)) {
      return null;
    }
    throw error;
  }
};

type BotDraft = Partial<Pick<Bot, "name" | "status" | "mission" | "scenario" | "template" | "type">>;

const defaultBillingSummary: BillingSummary = {
  tier: "free",
  monthCost: 0,
  budgetLimit: 29,
  estimatedMonthEnd: 12,
  tokenSpend: 0,
  runMinutes: 0,
};

const defaultRuntimeForBot = (botId: string): BotRuntime => ({
  botId,
  health: "healthy",
  latencyMs: 420,
  throughputPerMinute: 32,
  lastHeartbeatAt: new Date().toISOString(),
  activeSessions: 1,
  tokenUsage: 0,
});

const defaultVersionsForBot = (botId: string): BotVersion[] => [
  {
    id: `ver_${botId}_current`,
    botId,
    label: "runtime-current",
    createdAt: new Date().toISOString(),
    actor: "ctl",
    notes: "当前由 ctl 实例托管。",
    rollbackAvailable: false,
  },
];

const defaultTools: ToolBinding[] = [
  {
    id: "tool_terminal",
    name: "终端控制台",
    provider: "native",
    enabled: true,
    lastRunAt: new Date().toISOString(),
  },
];

const defaultKnowledgeSources: KnowledgeSource[] = [
  {
    id: "knowledge_runtime",
    name: "实例运行态",
    type: "docs",
    status: "ready",
    updatedAt: new Date().toISOString(),
  },
];

const readBotDrafts = (): Record<string, BotDraft> => {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(HTTP_BOT_DRAFTS_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, BotDraft>;
    return parsed ?? {};
  } catch {
    return {};
  }
};

const writeBotDrafts = (drafts: Record<string, BotDraft>) => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(HTTP_BOT_DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
};

const mapInstanceStatusToBotStatus = (status: string): Bot["status"] => {
  switch (status) {
    case "Paused":
      return "paused";
    case "Running":
      return "active";
    default:
      return "draft";
  }
};

const projectInstanceToBot = (instance: CtlInstancePayload, draft?: BotDraft): Bot => {
  const suffix = instance.instance_id.slice(-6);
  return {
    id: instance.instance_id,
    sandboxId: instance.sandbox_id,
    name: draft?.name?.trim() || `Bot ${suffix}`,
    type: draft?.type || "ops",
    template: draft?.template?.trim() || "OpenClaw Runtime",
    mission: draft?.mission?.trim() || "管理并操作一台运行中的实例",
    scenario: draft?.scenario?.trim() || "实例工作台",
    createdAt: instance.created_at,
    status: draft?.status || mapInstanceStatusToBotStatus(instance.status),
  };
};

const createHttpBotRepository = (baseUrl: string): BotRepository => {
  const messageStore = new Map<string, WorkspaceMessage[]>();

  const seedMessagesFor = (botId: string) => {
    if (messageStore.has(botId)) {
      return;
    }

    messageStore.set(botId, [
      {
        id: `msg_${botId}_sys`,
        role: "system",
        text: "这个工作台现在绑定到底层 ctl 实例。后续命令与日志能力会直接围绕实例运行态展开。",
        createdAt: new Date().toISOString(),
      },
      {
        id: `msg_${botId}_assistant`,
        role: "assistant",
        text: "实例已就绪。你可以先在这里做对话式测试，后续再把真实终端和日志接进来。",
        createdAt: new Date().toISOString(),
      },
    ]);
  };

  const listBots = async (): Promise<Bot[]> => {
    const response = await requestEnvelope<CtlListInstancesPayload>(baseUrl, "/v1/instances", {
      method: "GET",
    });
    const drafts = readBotDrafts();
    return response.items.map((instance) => projectInstanceToBot(instance, drafts[instance.instance_id]));
  };

  const getBotByID = async (botId: string): Promise<Bot> => {
    const instance = await requestEnvelope<CtlInstancePayload>(baseUrl, `/v1/instances/${encodeURIComponent(botId)}`, {
      method: "GET",
    });
    const drafts = readBotDrafts();
    return projectInstanceToBot(instance, drafts[instance.instance_id]);
  };

  const mapChannelConfigResult = (payload: CtlConfigureChannelPayload): BotChannelConfigResult => ({
    status: payload.status,
    channel: payload.channel,
    gatewayRestarted: payload.gateway_restarted,
    output: payload.output,
  });

  return {
    async getDashboardSnapshot() {
      const bots = await listBots();
      const primaryBot = bots[0] ?? null;

      return {
        runtime: primaryBot ? defaultRuntimeForBot(primaryBot.id) : null,
        alerts: [],
        bots,
        deployments: bots.map((bot) => ({
          id: `dep_${bot.id}`,
          botId: bot.id,
          environment: "production",
          region: "ap-beijing",
          status: bot.status === "paused" ? "queued" : bot.status === "active" ? "running" : "failed",
          updatedAt: new Date().toISOString(),
        }) satisfies Deployment),
        releases: primaryBot ? defaultVersionsForBot(primaryBot.id) : [],
        billing: defaultBillingSummary,
      } satisfies DashboardSnapshot;
    },

    async createBot(input) {
      const created = await requestEnvelope<CtlInstancePayload>(baseUrl, "/v1/instances", {
        method: "POST",
        body: {
          timeout: DEFAULT_INSTANCE_TIMEOUT_SECONDS,
        },
      });

      const drafts = readBotDrafts();
      drafts[created.instance_id] = {
        name: input?.name?.trim() || undefined,
      };
      writeBotDrafts(drafts);

      return projectInstanceToBot(created, drafts[created.instance_id]);
    },

    async destroyBot(botId) {
      await requestEnvelope<CtlInstancePayload>(baseUrl, `/v1/instances/${encodeURIComponent(botId)}`, {
        method: "DELETE",
      });

      const drafts = readBotDrafts();
      if (drafts[botId]) {
        delete drafts[botId];
        writeBotDrafts(drafts);
      }
      messageStore.delete(botId);
    },

    async updateBotProfile(botId, patch) {
      const drafts = readBotDrafts();
      drafts[botId] = {
        ...(drafts[botId] ?? {}),
        ...patch,
      };
      writeBotDrafts(drafts);
      return getBotByID(botId);
    },

    async getWorkspaceSnapshot(botId) {
      const bot = await getBotByID(botId);
      seedMessagesFor(bot.id);
      return {
        bot,
        runtime: defaultRuntimeForBot(bot.id),
        messages: messageStore.get(bot.id) ?? [],
        quickActions: ["检查运行态", "查看日志", "继续调试"],
      } satisfies WorkspaceSnapshot;
    },

    async sendWorkspaceMessage(botId, text) {
      const bot = await getBotByID(botId);
      seedMessagesFor(bot.id);
      const existing = messageStore.get(bot.id) ?? [];
      const next: WorkspaceMessage[] = [
        ...existing,
        {
          id: `msg_${Date.now()}_user`,
          role: "user",
          text,
          createdAt: new Date().toISOString(),
        },
        {
          id: `msg_${Date.now()}_assistant`,
          role: "assistant",
          text: "这条消息已经记录到前端工作台。后续会接到真实的实例调试链路。",
          createdAt: new Date().toISOString(),
        },
      ];
      messageStore.set(bot.id, next);
      return next;
    },

    async getSettingsSnapshot(botId) {
      const bot = await getBotByID(botId);
      return {
        bot,
        versions: defaultVersionsForBot(bot.id),
        tools: defaultTools,
        knowledge: defaultKnowledgeSources,
        auditEvents: [],
        billing: defaultBillingSummary,
      } satisfies SettingsSnapshot;
    },

    async getTerminalSession(botId) {
      const instance = await requestEnvelope<CtlInstancePayload>(baseUrl, `/v1/instances/${encodeURIComponent(botId)}`, {
        method: "GET",
      });
      const sandboxId = instance.sandbox_id?.trim();
      if (!sandboxId) {
        throw new RepositoryError("这个 Bot 还没有绑定沙箱，暂时无法打开终端。", 409, "sandbox_missing");
      }

      return request<BotTerminalSession>(baseUrl, `/sandboxes/${encodeURIComponent(sandboxId)}/tat/session`, {
        method: "POST",
      });
    },

    async configureQQChannel(botId, input) {
      const appId = input.appId.trim();
      const appSecret = input.appSecret.trim();
      if (!appId || !appSecret) {
        throw new RepositoryError("QQ App ID 和 App Secret 不能为空。", 400, "invalid_channel_config");
      }

      const payload = await requestEnvelope<CtlConfigureChannelPayload>(baseUrl, `/v1/instances/${encodeURIComponent(botId)}/channels/config`, {
        method: "POST",
        body: {
          channel: "qqbot",
          token: `${appId}:${appSecret}`,
          account: input.account?.trim() || undefined,
        },
      });

      return mapChannelConfigResult(payload);
    },
  };
};

const createHttpAuthRepository = (baseUrl: string): AuthRepository => ({
  async signInWithCode(input) {
    const response = await request<SessionPayload>(baseUrl, "/auth/sms/verify", {
      method: "POST",
      body: input,
    });
    return mapSession(response);
  },
  async sendVerificationCode(input: VerificationCodeRequest) {
    return request<{ cooldownSeconds: number }>(baseUrl, "/auth/sms/send", {
      method: "POST",
      body: input,
    });
  },
  async prepareInviteCode(code: string) {
    await request<void>(baseUrl, "/auth/invite/prepare", {
      method: "POST",
      body: { code },
    });
  },
  async signUpWithCode(input) {
    const response = await request<SessionPayload>(baseUrl, "/auth/sms/verify", {
      method: "POST",
      body: input,
    });
    return mapSession(response);
  },
  async validateInviteCode(code: string) {
    return request<InviteCodeValidation>(baseUrl, "/auth/invite/validate", {
      method: "POST",
      body: { code },
    });
  },
  async getSession() {
    try {
      const response = await request<SessionPayload>(baseUrl, "/auth/session", {
        method: "GET",
        suppressUnauthorizedBroadcast: true,
      });
      const session = mapSession(response);
      const currentSubscription = await fetchCurrentSubscription(baseUrl);
      return {
        ...session,
        currentSubscription,
      };
    } catch (error) {
      if (error instanceof RepositoryError && error.status === 401) {
        writeStoredAuthToken(null);
        return null;
      }
      throw error;
    }
  },
  async getProfile() {
    const response = await request<{ user: User }>(baseUrl, "/auth/profile", {
      method: "GET",
    });
    return response.user;
  },
  async updateProfile(input) {
    const response = await request<{ user: User }>(baseUrl, "/auth/profile", {
      method: "PUT",
      body: input,
    });
    return response.user;
  },
  async uploadAvatar(file) {
    const response = await requestMultipart<{ user: User }>(baseUrl, "/auth/profile/avatar", file);
    return response.user;
  },
  async deleteAccount() {
    try {
      await request<void>(baseUrl, "/auth/profile", {
        method: "DELETE",
      });
    } finally {
      writeStoredAuthToken(null);
    }
  },
  getOAuthStartUrl(provider) {
    if (provider === "qq") {
      return buildUrl(baseUrl, "/auth/oauth/qq/start");
    }
    return null;
  },
  async signInAsGuest() {
    const response = await request<SessionPayload>(baseUrl, "/auth/guest", {
      method: "POST",
    });
    return mapSession(response);
  },
  async signOut() {
    try {
      await request<void>(baseUrl, "/auth/session", {
        method: "DELETE",
      });
    } catch (error) {
      if (!(error instanceof RepositoryError) || (error.status !== 401 && error.status !== 403)) {
        throw error;
      }
    } finally {
      writeStoredAuthToken(null);
    }
  },
});

const createHttpPlanRepository = (baseUrl: string): PlanRepository => ({
  async getCurrentSubscription() {
    return fetchCurrentSubscription(baseUrl);
  },
  async getPlanPreview() {
    const currentSubscription = await fetchCurrentSubscription(baseUrl);
    return {
      currentCandidate: currentSubscription?.tier ?? "free",
      plans: planCatalog,
      confirmationNeeded: currentSubscription?.status !== "active",
    };
  },
  async updateSubscription(tier) {
    const payload = await request<{
      mode?: "active" | "payment_required";
      code: "free" | "lite" | "pro";
      subscription?: CurrentSubscriptionPayload["subscription"];
    }>(baseUrl, "/subscriptions/checkout", {
      method: "POST",
      body: { code: mapTierToSubscriptionCode(tier) },
    });

    return mapCurrentSubscription({
      hasSubscription: Boolean(payload.subscription),
      subscription: payload.subscription ?? null,
    });
  },
});

export const createHttpRepositories = (baseUrl: string): Repositories => {
  bootstrapStoredAuthTokenFromLocation();
  return {
    ...createFakeRepositories(),
    auth: createHttpAuthRepository(baseUrl),
    plans: createHttpPlanRepository(baseUrl),
    bots: createHttpBotRepository(baseUrl),
  };
};

export const createRepositories = (): Repositories => {
  const authApiBaseUrl = resolveConfiguredAuthApiBaseUrl();

  if (!authApiBaseUrl) {
    return createFakeRepositories();
  }

  return createHttpRepositories(authApiBaseUrl);
};

export { RepositoryError };
export { resolveAPIURL };
