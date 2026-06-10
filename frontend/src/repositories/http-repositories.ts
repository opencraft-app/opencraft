import { planCatalog } from "@/domain/plan-catalog";
import { resolveConfiguredAuthApiBaseUrl } from "@/lib/auth-api-base";
import type {
  AuthSessionSnapshot,
  BillingSummary,
  Bot,
  BotBornCard,
  BotChannelConfigResult,
  BotTerminalSession,
  BotRuntime,
  BotVersion,
  Bundle,
  CurrentSubscription,
  Deployment,
  InviteCodeValidation,
  KnowledgeSource,
  Pass,
  ToolBinding,
  User,
  WeixinLoginSession,
  WorkspaceMessage,
} from "@/domain/types";
import { createFakeRepositories } from "@/repositories/fake-repositories";
import type {
  AuthRepository,
  BotRepository,
  DashboardSnapshot,
  PlanRepository,
  RealnameVerifyResult,
  Repositories,
  SettingsSnapshot,
  TatDeviceBindResult,
  WorkspaceSnapshot,
} from "@/repositories/types";

interface SessionPayload {
  session: {
    user: User;
    impersonated?: boolean;
    authenticatedAt?: string;
    sessionToken?: string;
  };
}

interface ApiErrorPayload {
  code?: string;
  error?: string;
  message?: string;
  request_id?: string;
  requestId?: string;
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

interface TatDeviceBindPayload {
  status: string;
  ticket: string;
  callback_url: string;
  redirect_url: string;
  expires_at: string;
  registration_code?: string | null;
  registration?: {
    region: string;
    register_code_id: string;
    register_code_value: string;
    request_id: string;
  };
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

interface CtlBotBornCardPayload {
  instance_id: string;
  user_id: string;
  sandbox_id?: string;
  status: string;
  created_at: string;
  updated_at: string;
  timeout_at?: string;
  born_date_for_china: string;
  born_number_for_china: number;
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
  impersonated: payload.session.impersonated === true,
  authenticatedAt: payload.session.authenticatedAt,
  sessionToken: payload.session.sessionToken,
});

const buildUrl = (baseUrl: string, path: string) => `${baseUrl}${path}`;

const configuredOAuthRelayIssuerBaseURL = (): string | null => {
  const configured = import.meta.env.VITE_OAUTH_RELAY_ISSUER_BASE_URL?.trim();
  if (!configured) {
    return null;
  }
  return configured.replace(/\/$/, "");
};

const currentOAuthReturnTo = (): string | null => {
  if (typeof window === "undefined" || !window.location) {
    return null;
  }

  const { protocol, host, hostname, pathname, search, hash } = window.location;
  const normalizedProtocol = protocol?.trim().toLowerCase();
  const normalizedHost = host?.trim() || hostname?.trim();
  if (!normalizedProtocol || !normalizedHost) {
    return null;
  }
  if (normalizedProtocol !== "http:" && normalizedProtocol !== "https:") {
    return null;
  }

  return `${normalizedProtocol}//${normalizedHost}${pathname || "/"}${search || ""}${hash || ""}`;
};

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

  const code = payload?.code?.trim() || payload?.error?.trim();
  const requestId = payload?.request_id?.trim() || payload?.requestId?.trim();
  const detail = [code, requestId ? `request_id=${requestId}` : ""].filter(Boolean).join(", ");
  const message = payload?.message?.trim() || payload?.error?.trim() || `请求失败（${response.status}）`;
  return new RepositoryError(detail ? `${message}（${detail}）` : message, response.status, code, payload?.retryAfterSeconds);
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
    if (error instanceof RepositoryError && (error.status === 401 || error.status === 403 || error.status === 404)) {
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
  switch (status.trim().toLowerCase()) {
    case "creating":
    case "provisioning":
    case "pending":
    case "queued":
      return "provisioning";
    case "paused":
      return "paused";
    case "running":
    case "active":
    case "ready":
    case "succeeded":
    case "success":
      return "active";
    case "failed":
    case "error":
      return "failed";
    case "deleting":
    case "deleted":
      return "deleting";
    default:
      return "draft";
  }
};

const projectInstanceToBot = (instance: CtlInstancePayload, draft?: BotDraft): Bot => {
  return {
    id: instance.instance_id,
    sandboxId: instance.sandbox_id,
    name: draft?.name?.trim() || "Hermes宝宝",
    type: draft?.type || "ops",
    template: draft?.template?.trim() || "OpenClaw Runtime",
    mission: draft?.mission?.trim() || "",
    scenario: draft?.scenario?.trim() || "实例工作台",
    createdAt: instance.created_at,
    status: draft?.status || mapInstanceStatusToBotStatus(instance.status),
  };
};

const mapBotBornCard = (payload: CtlBotBornCardPayload): BotBornCard => ({
  instanceId: payload.instance_id,
  userId: payload.user_id,
  sandboxId: payload.sandbox_id,
  status: payload.status,
  createdAt: payload.created_at,
  updatedAt: payload.updated_at,
  timeoutAt: payload.timeout_at,
  bornDateForChina: payload.born_date_for_china,
  bornNumberForChina: payload.born_number_for_china,
});

/* ── Usage API ── */
interface UsagePayload {
  used_credits: number;
  total_credits: number;
  total_requests: number;
}

export const fetchUsage = async (baseUrl: string): Promise<{ usedCredits: number; totalCredits: number; totalRequests: number }> => {
  const payload = await requestEnvelope<UsagePayload>(baseUrl, "/v1/me/usage", { method: "GET" });
  return {
    usedCredits: payload.used_credits ?? 0,
    totalCredits: payload.total_credits ?? 0,
    totalRequests: payload.total_requests ?? 0,
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
          status: bot.status === "active" ? "running" : bot.status === "failed" ? "failed" : "queued",
          updatedAt: new Date().toISOString(),
        }) satisfies Deployment),
        releases: primaryBot ? defaultVersionsForBot(primaryBot.id) : [],
        billing: defaultBillingSummary,
      } satisfies DashboardSnapshot;
    },

    async createBot(input) {
      const body: Record<string, unknown> = {
        timeout: DEFAULT_INSTANCE_TIMEOUT_SECONDS,
      };
      if (input?.soulTemplateId) {
        body.soul_template_id = input.soulTemplateId;
      }

      const created = await requestEnvelope<CtlInstancePayload>(baseUrl, "/v1/instances", {
        method: "POST",
        body,
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

    async renameBot(botId: string, name: string): Promise<Bot> {
      const data = await requestEnvelope<CtlInstancePayload>(baseUrl, `/v1/instances/${encodeURIComponent(botId)}`, {
        method: "PUT",
        body: { name },
      });
      // 同步更新本地 draft，确保后续读取 name 一致
      const drafts = readBotDrafts();
      drafts[botId] = { ...(drafts[botId] ?? {}), name };
      writeBotDrafts(drafts);
      return projectInstanceToBot(data, drafts[botId]);
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

    async getBotBornCard(botId) {
      const payload = await requestEnvelope<CtlBotBornCardPayload>(baseUrl, `/v1/instances/${encodeURIComponent(botId)}/borncard`, {
        method: "GET",
      });
      return mapBotBornCard(payload);
    },

    async configureQQChannel(botId, input) {
      const appId = input.appId.trim();
      const appSecret = input.appSecret.trim();
      const account = input.account?.trim();

      if (!appId || !appSecret) {
        throw new RepositoryError("请先填写 QQ App ID 和 App Secret。", 400, "invalid_channel_config");
      }

      const payload = await requestEnvelope<CtlConfigureChannelPayload>(baseUrl, `/v1/instances/${encodeURIComponent(botId)}/channels/config`, {
        method: "POST",
        body: {
          channel: "qqbot",
          token: `${appId}:${appSecret}`,
          account: account || undefined,
        },
      });

      return mapChannelConfigResult(payload);
    },

    async createWeixinLoginSession(botId) {
      const payload = await requestEnvelope<{ session_id: string; status: string }>(baseUrl, `/v1/instances/${encodeURIComponent(botId)}/channels/weixin/login-sessions`, {
        method: "POST",
        body: {},
      });
      return { sessionId: payload.session_id, status: payload.status };
    },

    async getWeixinLoginSession(botId, sessionId) {
      return requestEnvelope<WeixinLoginSession>(baseUrl, `/v1/instances/${encodeURIComponent(botId)}/channels/weixin/login-sessions/${encodeURIComponent(sessionId)}`, {
        method: "GET",
      });
    },

    async cancelWeixinLoginSession(botId, sessionId) {
      return requestEnvelope<WeixinLoginSession>(baseUrl, `/v1/instances/${encodeURIComponent(botId)}/channels/weixin/login-sessions/${encodeURIComponent(sessionId)}/cancel`, {
        method: "POST",
      });
    },

    async *subscribeWeixinLoginSessionEvents(botId, sessionId, signal) {
      const url = buildUrl(baseUrl, `/v1/instances/${encodeURIComponent(botId)}/channels/weixin/login-sessions/${encodeURIComponent(sessionId)}/events`);
      const headers: Record<string, string> = { Accept: "text/event-stream" };
      const authToken = readStoredAuthToken();
      if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
      }

      const response = await fetch(url, { headers, credentials: "include", signal });
      if (!response.ok) {
        throw new RepositoryError(`SSE 连接失败（${response.status}）`, response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) {
        throw new RepositoryError("SSE 响应体为空", 0);
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let currentData = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              currentData = line.slice(6);
            } else if (line === "" && currentEvent) {
              try {
                const data = JSON.parse(currentData);
                yield { event: currentEvent, data };
              } catch {
                // skip malformed SSE data
              }
              currentEvent = "";
              currentData = "";
            } else if (line.startsWith(": ")) {
              // keepalive comment, ignore
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },

    async listSoulTemplates() {
      const payload = await requestEnvelope<{ items: Array<{ id: string; name: string; description: string }> }>(baseUrl, "/v1/soul-templates", {
        method: "GET",
      });
      return payload.items ?? [];
    },

    async execDebugCommand(botId, command) {
      // debug/exec 协议：命令执行失败时后端会返回 HTTP 500，但 body.details
      // 里仍带有完整的命令结果（status/exit_code/output），需要把这种「业务
      // 失败但有结果」的情况和真正的「接口错误」区分开。
      //
      // - 200 + envelope.data：命令成功，按原逻辑返回
      // - 5xx + body.details：命令执行失败，但 details.output 含业务结果（如
      //   hermes_version_too_old），上层据此解析友好提示
      // - 5xx 无 details：真正的接口错误，按通用 RepositoryError 抛出
      const path = `/v1/instances/${encodeURIComponent(botId)}/debug/exec`;
      const headers = new Headers({ "Content-Type": "application/json" });
      const authToken = readStoredAuthToken();
      if (authToken) {
        headers.set("Authorization", `Bearer ${authToken}`);
      }

      let response: Response;
      try {
        response = await fetch(buildUrl(baseUrl, path), {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({ command, run_as_user: "agentuser" }),
        });
      } catch {
        throw new RepositoryError("认证服务不可用，请先启动 Go auth 服务。", 0, "network_error");
      }

      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      // 优先识别 details 字段：只要带 details.output / details.exit_code，
      // 就视为命令已经执行过，返回标准化结果让上层解析。
      const details = (body as {
        details?: { status?: string; exit_code?: number; output?: string };
      } | null)?.details;
      if (details && (typeof details.output === "string" || typeof details.exit_code === "number")) {
        return {
          status: details.status ?? "",
          exitCode: typeof details.exit_code === "number" ? details.exit_code : -1,
          output: details.output ?? "",
        };
      }

      if (!response.ok) {
        if (response.status === 401) {
          broadcastUnauthorized();
        }
        const errPayload = body as ApiErrorPayload | null;
        const code = errPayload?.code?.trim() || errPayload?.error?.trim();
        const requestId = errPayload?.request_id?.trim() || errPayload?.requestId?.trim();
        const detail = [code, requestId ? `request_id=${requestId}` : ""].filter(Boolean).join(", ");
        const message = errPayload?.message?.trim() || errPayload?.error?.trim() || `请求失败（${response.status}）`;
        throw new RepositoryError(
          detail ? `${message}（${detail}）` : message,
          response.status,
          code,
          errPayload?.retryAfterSeconds,
        );
      }

      // 200 走正常 envelope 解析
      const envelope = body as APIEnvelope<{
        status: string;
        exit_code: number;
        output: string;
      }> | null;
      const data = envelope?.data;
      return {
        status: data?.status ?? "",
        exitCode: data?.exit_code ?? -1,
        output: data?.output ?? "",
      };
    },

    async resetInstanceConfig(botId: string) {
      const payload = await requestEnvelope<{
        key_id: string;
        key_prefix: string;
        config: {
          provider_name: string;
          base_url: string;
          model_id: string;
          api: string;
          api_key: string;
        };
      }>(baseUrl, `/v1/instances/${encodeURIComponent(botId)}/config/reset`, {
        method: "POST",
      });
      return {
        keyId: payload?.key_id,
        keyPrefix: payload?.key_prefix,
        config: {
          providerName: payload?.config?.provider_name,
          baseUrl: payload?.config?.base_url,
          modelId: payload?.config?.model_id,
          api: payload?.config?.api,
          apiKey: payload?.config?.api_key,
        },
      };
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
  async prepareInviteCode(code: string) {
    await request<void>(baseUrl, "/auth/invite/prepare", {
      method: "POST",
      body: { code },
    });
  },
  async activateInviteCode(code: string) {
    const response = await request<{ user: User }>(baseUrl, "/auth/invite/activate", {
      method: "POST",
      body: { code },
    });
    return response.user;
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
  async verifyRealname(input) {
    return request<RealnameVerifyResult>(baseUrl, "/auth/realname/verify", {
      method: "POST",
      body: input,
    });
  },
  async requestEmailBind(input) {
    return request<{ cooldownSeconds: number }>(baseUrl, "/auth/email/bind/request", {
      method: "POST",
      body: input,
    });
  },
  async createTatDeviceBind(input): Promise<TatDeviceBindResult> {
    const response = await request<TatDeviceBindPayload>(baseUrl, "/auth/tat/device-bind", {
      method: "POST",
      body: {
        callback_url: input.callbackUrl,
        device_name: input.deviceName,
      },
    });
    return {
      status: response.status,
      ticket: response.ticket,
      callbackUrl: response.callback_url,
      redirectUrl: response.redirect_url,
      expiresAt: response.expires_at,
      registrationCode: response.registration_code ?? null,
      registration: response.registration
        ? {
            region: response.registration.region,
            registerCodeId: response.registration.register_code_id,
            registerCodeValue: response.registration.register_code_value,
            requestId: response.registration.request_id,
          }
        : undefined,
    };
  },
  getOAuthStartUrl(provider, options) {
    // local-proxy 模式 baseUrl 是空字符串，buildUrl 拼出来是相对路径 `/auth/...`。
    // URL 构造器不接受相对路径，所以传 window.location.origin 当 base；
    // 当 baseUrl 是绝对 URL（如 https://lightclaw.tech）时，第二个参数会被忽略。
    const base = typeof window !== "undefined" ? window.location.origin : "https://lightclaw.tech";
    const startURL = new URL(buildUrl(baseUrl, `/auth/oauth/${provider}/start`), base);
    if (provider === "wechat" && options?.wechatMode) {
      startURL.searchParams.set("mode", options.wechatMode);
    }
    const relayIssuerBaseURL = configuredOAuthRelayIssuerBaseURL();
    if (relayIssuerBaseURL) {
      startURL.searchParams.set("relay_mode", "issuer");
      startURL.searchParams.set("issuer_redirect_uri", buildUrl(relayIssuerBaseURL, `/auth/oauth/${provider}/callback`));
    }
    const returnTo = currentOAuthReturnTo();
    if (returnTo) {
      startURL.searchParams.set("return_to", returnTo);
    }
    return startURL.toString();
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
  async listBundles() {
    const payload = await requestEnvelope<{ bundles: Bundle[] }>(baseUrl, "/v1/bundles", {
      method: "GET",
    });
    return payload.bundles ?? [];
  },
  async createPass(bundleId) {
    return requestEnvelope<Pass>(baseUrl, "/v1/passes", {
      method: "POST",
      body: { bundle_id: bundleId },
    });
  },
  async listMyPasses() {
    const payload = await requestEnvelope<{ passes: Pass[] }>(baseUrl, "/v1/passes", {
      method: "GET",
    });
    return payload.passes ?? [];
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

  if (authApiBaseUrl === null) {
    return createFakeRepositories();
  }

  return createHttpRepositories(authApiBaseUrl);
};

export { RepositoryError };
export { resolveAPIURL };
