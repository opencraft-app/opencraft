// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { planCatalog } from "../domain/plan-catalog";
import { INSTANCE_BOT_ERROR_CODE } from "../domain/instance-bot-errors";
import { defaultHermesAgentName } from "../i18n/default-agent-name";
import { resolveConfiguredAuthApiBaseUrl } from "../lib/auth-api-base";
import { createDebugExecRequestBody } from "../lib/debug-exec-request";
import type {
  AuthSessionSnapshot,
  BillingSummary,
  Bot,
  BotChannelConfigResult,
  BotTerminalSession,
  BotRuntime,
  BotSiblingsUnknownReason,
  BotVersion,
  Bundle,
  CreateDianshiPassOrderAndPayResult,
  CreatePassOrderAndPayResult,
  CreatePassOrderResult,
  CreatePassOrderUrlResult,
  CurrentSubscription,
  DeletePassResult,
  Deployment,
  InviteCodeValidation,
  KnowledgeSource,
  Pass,
  PassModifyBundles,
  PassModifyOrder,
  PassModifyCheckout,
  PassOrderStatus,
  PassRenewPrice,
  ToolBinding,
  User,
  WeixinLoginSession,
  WorkspaceMessage,
} from "../domain/types";
import type {
  CreditOrderResult,
  CreditOrderUrlResult,
  CreditPackageItem,
  CreditProduct,
  CreditQuote,
} from "../domain/credit-pack";
import { createFakeRepositories } from "./fake-repositories";
import {
  createBotIdentity,
  normalizeBotLifecycle,
  planBotCreation,
  type BotIdentity,
} from "@lightvela/agent-core";
import type {
  AuthRepository,
  BotRepository,
  CreditRepository,
  DashboardSnapshot,
  FederationAuthorizationContext,
  FederationAuthorizationInput,
  FederationTicketResult,
  OIDCAuthorizationContext,
  OIDCAuthorizationInput,
  OIDCAuthorizationResult,
  PlanRepository,
  RealnameVerifyResult,
  Repositories,
  SettingsSnapshot,
  TatDeviceBindResult,
  TencentCloudRedirectResult,
  WorkerActionStatusLog,
  WorkerActionStatusResult,
  WorkspaceSnapshot,
} from "./types";

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

interface DebugExecStreamEvent {
  type?: string;
  stream?: string;
  chunk?: string;
  response?: {
    status?: string;
    exit_code?: number;
    output?: string;
  };
}

const DEBUG_EXEC_STREAM_EVENT = {
  error: "error",
  finished: "finished",
  stderr: "stderr",
  stdout: "stdout",
} as const;

function parseDebugExecSsePart(part: string): { eventType: string; data: string } | null {
  let eventType = "";
  const dataLines: string[] = [];
  part.split("\n").forEach((rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("event: ")) eventType = line.slice(7).trim();
    if (line.startsWith("data: ")) dataLines.push(line.slice(6));
  });
  return dataLines.length > 0 ? { eventType, data: dataLines.join("\n") } : null;
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

interface FederationContextPayload {
  client: {
    id: string;
    display_name: string;
  };
  redirect_uri: string;
  state: string;
  session: {
    authenticated: boolean;
    user?: User;
  };
}

interface FederationTicketPayload {
  redirect_url: string;
  expires_at: string;
}

interface OIDCContextPayload {
  client: {
    id: string;
    display_name: string;
  };
  redirect_uri: string;
  state: string;
  response_type: "code";
  scope: string;
  code_challenge: string;
  code_challenge_method: "S256";
  nonce: string;
  session: {
    authenticated: boolean;
    user?: User;
  };
}

interface OIDCAuthorizationPayload {
  redirect_url: string;
  expires_at: string;
}

interface CtlInstancePayload {
  instance_id: string;
  sandbox_id?: string;
  name?: string;
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

interface CtlInstanceBotPayload {
  bot_id: string;
  instance_id: string;
  profile_id: string;
  name: string;
  description?: string;
  is_default: boolean;
  status: string;
  gateway_running?: boolean;
  created_from: "blank" | "clone";
  source_bot_id?: string;
  created_at: string;
  updated_at: string;
  weixin_owner?: {
    bot_id: string;
    profile_id: string;
    bot_name?: string;
    status: string;
  };
}

interface CtlListInstanceBotsPayload {
  items: CtlInstanceBotPayload[];
}

interface CtlConfigureChannelPayload {
  status: string;
  channel: string;
  gateway_restarted: boolean;
  output?: string;
}

interface WorkerActionStartPayload {
  action_run_id: string;
  workflow_id: string;
  run_id?: string;
  action: string;
  bot_id: string;
  status: string;
}

interface WorkerActionUploadPayload {
  action: string;
  bot_id: string;
  object_key: string;
  object_url: string;
  upload_url: string;
  expires_at: string;
  status: string;
}

type WorkerActionStatusPayload = Record<string, unknown>;

const AUTH_TOKEN_STORAGE_KEY = "vela.lightvela.session-token.v1";
const OAUTH_SESSION_TOKEN_FRAGMENT_KEY = "session_token";
const HTTP_BOT_DRAFTS_STORAGE_KEY = "lightclaw-http-bot-drafts-v1";
const DEFAULT_INSTANCE_TIMEOUT_SECONDS = 60 * 60;
const DEFAULT_RESCUE_EXPORT_REMOTE_PATH = "/home/agentuser/.hermes";
export const AUTH_UNAUTHORIZED_EVENT = "lightclaw:auth-unauthorized";
export const AUTH_SERVICE_UNAVAILABLE_MESSAGE = "认证服务暂时不可用，请稍后重试。";

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

const createNetworkUnavailableError = (cause?: unknown) => {
  // message 会进入终端用户的 toast；诊断细节仅保留在 cause。
  const error = new RepositoryError(AUTH_SERVICE_UNAVAILABLE_MESSAGE, 0, "network_error");
  if (cause !== undefined) (error as RepositoryError & { cause?: unknown }).cause = cause;
  return error;
};

const isNestedBotsUnavailable = (error: unknown) => {
  if (error instanceof RepositoryError) {
    return error.status === 404 || error.status === 405;
  }
  return error instanceof TypeError && /body.*(unusable|read)/i.test(error.message);
};

const isNestedBotsTemporarilyUnavailable = (error: unknown) => {
  return isNestedBotsUnavailable(error)
    || (error instanceof RepositoryError && (
      error.status === 403 && error.code === "PASS_MODIFYING"
      || error.status === 500 && error.code === INSTANCE_BOT_ERROR_CODE.profileFailed
    ));
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
  impersonated: payload.session.impersonated === true,
  authenticatedAt: payload.session.authenticatedAt,
  sessionToken: payload.session.sessionToken,
});

const buildUrl = (baseUrl: string, path: string) => `${baseUrl}${path}`;

const resolveOAuthStartBaseURL = (baseUrl: string) => {
  // local-proxy keeps OAuth start/callback on the dev server origin so the
  // state cookie and returned session token survive the browser redirect flow.
  return baseUrl === "" ? "" : baseUrl;
};

const configuredOAuthRelayIssuerBaseURL = (): string | null => {
  const configured = (
    (typeof process !== "undefined" ? process.env.NEXT_PUBLIC_OAUTH_RELAY_ISSUER_BASE_URL : undefined)
    ?? import.meta.env?.VITE_OAUTH_RELAY_ISSUER_BASE_URL
  )?.trim();
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
    throw createNetworkUnavailableError();
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

const stringField = (payload: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
};

const booleanField = (payload: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
};

const normalizeWorkerActionLogs = (value: unknown): WorkerActionStatusLog[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const logs: WorkerActionStatusLog[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const payload = item as Record<string, unknown>;
    const message = stringField(payload, "message", "Message");
    if (!message) {
      continue;
    }
    logs.push({
      time: stringField(payload, "time", "Time"),
      phase: stringField(payload, "phase", "Phase"),
      message,
      level: stringField(payload, "level", "Level"),
    });
  }
  return logs;
};

const normalizeWorkerActionStatus = (payload: WorkerActionStatusPayload): WorkerActionStatusResult => {
  const phase = stringField(payload, "phase", "Phase") ?? "unknown";
  const error = stringField(payload, "error", "Error");
  const logs = normalizeWorkerActionLogs(payload.logs ?? payload.Logs);
  return {
    workflowId: stringField(payload, "workflow_id", "workflowId", "WorkflowID"),
    runId: stringField(payload, "run_id", "runId", "RunID"),
    phase,
    error,
    dryRun: booleanField(payload, "dry_run", "dryRun", "DryRun"),
    logs,
  };
};

const normalizeNullableWorkerActionStatus = (payload: WorkerActionStatusPayload): WorkerActionStatusResult | null => {
  const status = normalizeWorkerActionStatus(payload);
  return status.phase === "not_found" || status.phase === "idle" ? null : status;
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
    throw createNetworkUnavailableError();
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
  const lifecycle = normalizeBotLifecycle(status);
  return lifecycle === "running" ? "active" : lifecycle;
};

const legacyDefaultHermesAgentNames = new Set(["Hermes宝宝", "Hermes寶寶", "Baby Hermes", "Bebé Hermes"]);

const resolveLegacyDraftBotName = (draft?: BotDraft) => {
  const draftName = draft?.name?.trim();
  if (!draftName || legacyDefaultHermesAgentNames.has(draftName)) {
    return undefined;
  }
  return draftName;
};

const projectInstanceToBot = (instance: CtlInstancePayload, draft?: BotDraft): Bot => {
  return {
    id: instance.instance_id,
    instanceId: instance.instance_id,
    profileId: "main",
    isDefault: true,
    sandboxId: instance.sandbox_id,
    name: instance.name?.trim() || resolveLegacyDraftBotName(draft) || defaultHermesAgentName(),
    type: draft?.type || "ops",
    template: draft?.template?.trim() || "OpenClaw Runtime",
    mission: draft?.mission?.trim() || "",
    scenario: draft?.scenario?.trim() || "实例工作台",
    createdAt: instance.created_at,
    status: draft?.status || mapInstanceStatusToBotStatus(instance.status),
  };
};

const projectInstanceBotToBot = (
  instance: CtlInstancePayload,
  instanceBot: CtlInstanceBotPayload,
  draft?: BotDraft,
): Bot => {
  const backendName = instanceBot.name?.trim();
  const leakedRootProfileName = instanceBot.is_default
    && instanceBot.profile_id === "main"
    && instanceBot.bot_id === instanceBot.instance_id
    && backendName === "default";
  const displayName = leakedRootProfileName ? undefined : backendName;

  return {
    id: instanceBot.bot_id,
    instanceId: instanceBot.instance_id,
    profileId: instanceBot.profile_id,
    isDefault: instanceBot.is_default,
    gatewayRunning: instanceBot.gateway_running,
    description: instanceBot.description,
    createdFrom: instanceBot.created_from,
    sourceBotId: instanceBot.source_bot_id,
    weixinOwner: instanceBot.weixin_owner ? {
      botId: instanceBot.weixin_owner.bot_id,
      profileId: instanceBot.weixin_owner.profile_id,
      botName: instanceBot.weixin_owner.bot_name,
      status: instanceBot.weixin_owner.status,
    } : undefined,
    sandboxId: instance.sandbox_id,
    name: displayName || resolveLegacyDraftBotName(draft) || defaultHermesAgentName(),
    type: draft?.type || "ops",
    template: draft?.template?.trim() || "OpenClaw Runtime",
    mission: draft?.mission?.trim() || instanceBot.description || "",
    scenario: draft?.scenario?.trim() || "实例工作台",
    createdAt: instanceBot.created_at,
    status: draft?.status || mapInstanceStatusToBotStatus(instanceBot.status),
  };
};

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
  const botScopeCache = new Map<string, BotIdentity>();
  const instanceCache = new Map<string, CtlInstancePayload>();

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
    const instances = Array.isArray(response.items) ? response.items : [];
    instanceCache.clear();
    instances.forEach((instance) => instanceCache.set(instance.instance_id, instance));
    // Instances whose Bot list came from the single-instance projection instead of
    // /bots, mapped to why the real list was unavailable. Their root Bot must not be
    // treated as a legacy single-Bot instance: sibling Bots may exist on the server
    // even though this list cannot show them.
    const projectedInstanceReasons = new Map<string, BotSiblingsUnknownReason>();
    const bots = (await Promise.all(instances.map(async (instance) => {
      if (mapInstanceStatusToBotStatus(instance.status) !== "active") {
        projectedInstanceReasons.set(instance.instance_id, "instance_stopped");
        return [projectInstanceToBot(instance, drafts[instance.instance_id])];
      }
      try {
        const nested = await requestEnvelope<CtlListInstanceBotsPayload>(
          baseUrl,
          `/v1/instances/${encodeURIComponent(instance.instance_id)}/bots`,
          { method: "GET" },
        );
        if (Array.isArray(nested.items) && nested.items.every((bot) => typeof bot.bot_id === "string")) {
          return nested.items.map((bot) => projectInstanceBotToBot(instance, bot, drafts[bot.bot_id]));
        }
      } catch (error) {
        if (!isNestedBotsTemporarilyUnavailable(error)) {
          throw error;
        }
        // Backend rollout and pass upgrades can make profiles briefly unavailable; keep the root Bot visible.
      }
      // The instance is running, so this is a transient /bots outage rather than a
      // stopped instance. Callers must not tell the user to start the instance.
      projectedInstanceReasons.set(instance.instance_id, "bot_list_unavailable");
      return [projectInstanceToBot(instance, drafts[instance.instance_id])];
    }))).flat();
    botScopeCache.clear();
    bots.forEach((bot) => {
      const instanceId = bot.instanceId ?? bot.id;
      const projectedReason = projectedInstanceReasons.get(instanceId);
      const identity = createBotIdentity({
        botId: bot.id,
        instanceId,
        profileId: bot.profileId,
        isDefault: bot.isDefault,
      });
      botScopeCache.set(bot.id, {
        ...identity,
        legacy: projectedReason !== undefined,
      });
      // Surface the incomplete-list signal to the UI on both sites so a temporary
      // /bots outage never makes a projected root Bot look authoritative.
      bot.siblingsUnknown = projectedReason;
    });
    return bots;
  };

  const getBotByID = async (botId: string): Promise<Bot> => {
    const bot = (await listBots()).find((item) => item.id === botId);
    if (!bot) {
      throw new RepositoryError("Bot 不存在或无权访问。", 404, "instance_bot_not_found");
    }
    return bot;
  };

  const resolveBotScope = async (botId: string) => {
    const cached = botScopeCache.get(botId);
    if (cached) return cached;
    // Direct legacy callers still pass the instance ID before dashboard hydration.
    return createBotIdentity({ botId, instanceId: botId });
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
      const displayName = input?.name?.trim() || defaultHermesAgentName();
      const creationPlan = planBotCreation({
        supportsNestedBots: true,
        instances: Array.from(instanceCache.values()).map((instance) => ({
          instanceId: instance.instance_id,
          status: instance.status,
        })),
        intent: {
          name: displayName,
          description: input?.description,
          soulTemplateId: input?.soulTemplateId,
          mode: input?.createMode,
          sourceBotId: input?.sourceBotId,
          initialSoul: input?.initialSoul,
        },
      });

      if (creationPlan.kind === "create-nested-bot") {
        const instance = instanceCache.get(creationPlan.instanceId);
        if (instance) {
          const created = await requestEnvelope<CtlInstanceBotPayload>(
            baseUrl,
            `/v1/instances/${encodeURIComponent(instance.instance_id)}/bots`,
            {
              method: "POST",
              body: {
                name: creationPlan.name,
                description: creationPlan.description,
                create_mode: creationPlan.mode,
                source_bot_id: creationPlan.sourceBotId,
                initial_soul: creationPlan.initialSoul,
              },
            },
          );
          const bot = projectInstanceBotToBot(instance, created, readBotDrafts()[created.bot_id]);
          botScopeCache.set(bot.id, createBotIdentity({
            botId: bot.id,
            instanceId: created.instance_id,
            profileId: created.profile_id,
            isDefault: created.is_default,
          }));
          return bot;
        }
      }

      const body: Record<string, unknown> = {
        timeout: DEFAULT_INSTANCE_TIMEOUT_SECONDS,
        name: creationPlan.name,
      };
      if (creationPlan.kind === "create-instance" && creationPlan.soulTemplateId) {
        body.soul_template_id = creationPlan.soulTemplateId;
      }

      const created = await requestEnvelope<CtlInstancePayload>(baseUrl, "/v1/instances", {
        method: "POST",
        body,
      });

      if (mapInstanceStatusToBotStatus(created.status) !== "active") {
        const bot = projectInstanceToBot(created, readBotDrafts()[created.instance_id]);
        botScopeCache.set(bot.id, createBotIdentity({
          botId: bot.id,
          instanceId: created.instance_id,
          profileId: "main",
          isDefault: true,
        }));
        instanceCache.set(created.instance_id, created);
        return bot;
      }
      try {
        const nested = await requestEnvelope<CtlListInstanceBotsPayload>(
          baseUrl,
          `/v1/instances/${encodeURIComponent(created.instance_id)}/bots`,
          { method: "GET" },
        );
        const items = Array.isArray(nested.items) ? nested.items : [];
        const main = items.find((item) => item.is_default) ?? items[0];
        if (main?.bot_id) {
          const bot = projectInstanceBotToBot(created, main, readBotDrafts()[main.bot_id]);
          botScopeCache.set(bot.id, createBotIdentity({
            botId: bot.id,
            instanceId: main.instance_id,
            profileId: main.profile_id,
            isDefault: main.is_default,
          }));
          instanceCache.set(created.instance_id, created);
          return bot;
        }
      } catch (error) {
        if (!isNestedBotsUnavailable(error)) {
          throw error;
        }
        // The root instance remains the compatibility Bot until the nested API is available.
      }
      const bot = projectInstanceToBot(created, readBotDrafts()[created.instance_id]);
      botScopeCache.set(bot.id, createBotIdentity({
        botId: bot.id,
        instanceId: created.instance_id,
        profileId: "main",
        isDefault: true,
      }));
      instanceCache.set(created.instance_id, created);
      return bot;
    },

    async destroyBot(botId) {
      const scope = await resolveBotScope(botId);
      if (scope.isDefault || scope.legacy) {
        // Destroying the main Bot destroys the whole instance. `legacy` scopes come from the
        // single-instance projection, so sibling Bots may exist even though this client cannot
        // see them — both cases must go through the guard. The query flag is kept for older
        // backends where the guard is still opt-in; newer ones enforce it by default.
        await requestEnvelope<CtlInstancePayload>(
          baseUrl,
          `/v1/instances/${encodeURIComponent(scope.instanceId)}?require_single_bot=true`,
          { method: "DELETE" },
        );
      } else {
        await requestEnvelope<CtlInstanceBotPayload>(
          baseUrl,
          `/v1/instances/${encodeURIComponent(scope.instanceId)}/bots/${encodeURIComponent(botId)}`,
          { method: "DELETE" },
        );
      }

      const deletedBotIds = scope.isDefault
        ? [...botScopeCache.entries()]
          .filter(([, cachedScope]) => cachedScope.instanceId === scope.instanceId)
          .map(([cachedBotId]) => cachedBotId)
        : [botId];
      const drafts = readBotDrafts();
      let draftsChanged = false;
      deletedBotIds.forEach((deletedBotId) => {
        if (drafts[deletedBotId]) {
          delete drafts[deletedBotId];
          draftsChanged = true;
        }
        messageStore.delete(deletedBotId);
        botScopeCache.delete(deletedBotId);
      });
      if (draftsChanged) {
        writeBotDrafts(drafts);
      }
      if (scope.isDefault) instanceCache.delete(scope.instanceId);
    },

    async renameBot(botId: string, name: string): Promise<Bot> {
      const scope = await resolveBotScope(botId);
      const drafts = readBotDrafts();
      const data = await requestEnvelope<CtlInstanceBotPayload>(
        baseUrl,
        `/v1/instances/${encodeURIComponent(scope.instanceId)}/bots/${encodeURIComponent(botId)}`,
        { method: "PUT", body: { name } },
      );
      const instance = await requestEnvelope<CtlInstancePayload>(baseUrl, `/v1/instances/${encodeURIComponent(scope.instanceId)}`, {
        method: "GET",
      });
      return projectInstanceBotToBot(instance, data, drafts[botId]);
    },

    async updateBotProfile(botId, patch) {
      const drafts = readBotDrafts();
      const { name: _ignoredName, ...draftPatch } = patch;
      drafts[botId] = {
        ...(drafts[botId] ?? {}),
        ...draftPatch,
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
      const { instanceId } = await resolveBotScope(botId);
      return requestEnvelope<BotTerminalSession>(baseUrl, `/v1/instances/${encodeURIComponent(instanceId)}/tat/session`, {
        method: "POST",
      });
    },

    async configureQQChannel(botId, input) {
      const appId = input.appId.trim();
      const appSecret = input.appSecret.trim();
      const account = input.account?.trim();

      if (!appId || !appSecret) {
        throw new RepositoryError("请先填写 QQ App ID 和 App Secret。", 400, "invalid_channel_config");
      }

      const { instanceId, profileId, legacy } = await resolveBotScope(botId);
      const payload = await requestEnvelope<CtlConfigureChannelPayload>(baseUrl, `/v1/instances/${encodeURIComponent(instanceId)}/channels/config`, {
        method: "POST",
        body: {
          channel: "qqbot",
          token: `${appId}:${appSecret}`,
          account: account || undefined,
          profile_id: legacy ? undefined : profileId,
        },
      });

      return mapChannelConfigResult(payload);
    },

    async createWeixinLoginSession(botId) {
      const { instanceId, profileId } = await resolveBotScope(botId);
      const payload = await requestEnvelope<{ session_id: string; status: string }>(baseUrl, `/v1/instances/${encodeURIComponent(instanceId)}/channels/weixin/login-sessions`, {
        method: "POST",
        body: { bot_id: botId, profile_id: profileId },
      });
      return { sessionId: payload.session_id, status: payload.status };
    },

    async claimUniqueChannel(botId, channel) {
      const { instanceId } = await resolveBotScope(botId);
      await requestEnvelope(baseUrl, `/v1/instances/${encodeURIComponent(instanceId)}/bots/${encodeURIComponent(botId)}/channel-bindings/${channel}`, {
        method: "PUT",
      });
    },

    async confirmUniqueChannel(botId, channel) {
      const { instanceId } = await resolveBotScope(botId);
      await requestEnvelope(baseUrl, `/v1/instances/${encodeURIComponent(instanceId)}/bots/${encodeURIComponent(botId)}/channel-bindings/${channel}`, {
        method: "POST",
      });
    },

    async releaseUniqueChannel(botId, channel) {
      const { instanceId } = await resolveBotScope(botId);
      await requestEnvelope(baseUrl, `/v1/instances/${encodeURIComponent(instanceId)}/bots/${encodeURIComponent(botId)}/channel-bindings/${channel}`, {
        method: "DELETE",
      });
    },

    async getWeixinLoginSession(botId, sessionId) {
      const { instanceId } = await resolveBotScope(botId);
      return requestEnvelope<WeixinLoginSession>(baseUrl, `/v1/instances/${encodeURIComponent(instanceId)}/channels/weixin/login-sessions/${encodeURIComponent(sessionId)}`, {
        method: "GET",
      });
    },

    async cancelWeixinLoginSession(botId, sessionId) {
      const { instanceId } = await resolveBotScope(botId);
      return requestEnvelope<WeixinLoginSession>(baseUrl, `/v1/instances/${encodeURIComponent(instanceId)}/channels/weixin/login-sessions/${encodeURIComponent(sessionId)}/cancel`, {
        method: "POST",
      });
    },

    async *subscribeWeixinLoginSessionEvents(botId, sessionId, signal) {
      const { instanceId } = await resolveBotScope(botId);
      const url = buildUrl(baseUrl, `/v1/instances/${encodeURIComponent(instanceId)}/channels/weixin/login-sessions/${encodeURIComponent(sessionId)}/events`);
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

    async retryBot(botId) {
      const scope = await resolveBotScope(botId);
      if (scope.legacy) {
        throw new RepositoryError("当前 Bot 不支持修复操作。", 409, "instance_bot_retry_unsupported");
      }
      const retried = await requestEnvelope<CtlInstanceBotPayload>(
        baseUrl,
        `/v1/instances/${encodeURIComponent(scope.instanceId)}/bots/${encodeURIComponent(botId)}/retry`,
        { method: "POST" },
      );
      if (retried.status === "deleted") {
        botScopeCache.delete(botId);
        return null;
      }
      const instance = instanceCache.get(scope.instanceId) ?? {
        instance_id: scope.instanceId,
        status: "Running",
        created_at: retried.created_at,
      };
      const bot = projectInstanceBotToBot(instance, retried, readBotDrafts()[retried.bot_id]);
      botScopeCache.set(bot.id, createBotIdentity({
        botId: bot.id,
        instanceId: retried.instance_id,
        profileId: retried.profile_id,
        isDefault: retried.is_default,
      }));
      return bot;
    },

    async listSoulTemplates() {
      const payload = await requestEnvelope<{ items: Array<{ id: string; name: string; description: string }> }>(baseUrl, "/v1/soul-templates", {
        method: "GET",
      });
      return payload.items ?? [];
    },

    async execDebugCommand(botId, command, options) {
      // debug/exec 协议：命令执行失败时后端会返回 HTTP 500，但 body.details
      // 里仍带有完整的命令结果（status/exit_code/output），需要把这种「业务
      // 失败但有结果」的情况和真正的「接口错误」区分开。
      //
      // - 200 + envelope.data：命令成功，按原逻辑返回
      // - 5xx + body.details：命令执行失败，但 details.output 含业务结果（如
      //   hermes_version_too_old），上层据此解析友好提示
      // - 5xx 无 details：真正的接口错误，按通用 RepositoryError 抛出
      const { instanceId } = await resolveBotScope(botId);
      const path = `/v1/instances/${encodeURIComponent(instanceId)}/debug/exec`;
      const headers = new Headers({ "Content-Type": "application/json" });
      const authToken = readStoredAuthToken();
      if (authToken) {
        headers.set("Authorization", `Bearer ${authToken}`);
      }

      const abortController = new AbortController();
      const timeoutMs = options?.timeoutMs;
      const timeoutId = typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => abortController.abort(), timeoutMs)
        : undefined;
      let response: Response;
      try {
        response = await fetch(buildUrl(baseUrl, path), {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify(createDebugExecRequestBody(command)),
          signal: abortController.signal,
        });
      } catch (error) {
        if (abortController.signal.aborted) {
          throw new Error(`debug_exec_timeout:${timeoutMs ?? 0}`);
        }
        throw createNetworkUnavailableError(error);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
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

    async execDebugCommandStream(botId, command, onChunk, options) {
      const { instanceId } = await resolveBotScope(botId);
      const path = `/v1/instances/${encodeURIComponent(instanceId)}/debug/exec`;
      const headers = new Headers({
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      });
      const authToken = readStoredAuthToken();
      if (authToken) headers.set("Authorization", `Bearer ${authToken}`);

      const abortController = new AbortController();
      const timeoutMs = options?.timeoutMs;
      const timeoutId = typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => abortController.abort(), timeoutMs)
        : undefined;
      try {
        const response = await fetch(buildUrl(baseUrl, path), {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify(createDebugExecRequestBody(command)),
          signal: abortController.signal,
        });
        if (!response.ok) {
          if (response.status === 401) broadcastUnauthorized();
          let message = `请求失败（${response.status}）`;
          try {
            const body = await response.json() as ApiErrorPayload;
            message = body.message?.trim() || body.error?.trim() || message;
          } catch {
            // Keep the status-based fallback when the error body is not JSON.
          }
          throw new RepositoryError(message, response.status);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("Command output stream is not readable.");
        const decoder = new TextDecoder();
        let buffer = "";
        let output = "";
        let finalResponse: DebugExecStreamEvent["response"];
        let sawErrorEvent = false;

        const consumePart = (part: string) => {
          const parsed = parseDebugExecSsePart(part);
          if (!parsed) return;
          let event: DebugExecStreamEvent;
          try {
            event = JSON.parse(parsed.data) as DebugExecStreamEvent;
          } catch {
            return;
          }
          const eventType = event.type || parsed.eventType;
          if ((eventType === DEBUG_EXEC_STREAM_EVENT.stdout || eventType === DEBUG_EXEC_STREAM_EVENT.stderr) && event.chunk) {
            output += event.chunk;
            onChunk({ stream: event.stream || eventType, chunk: event.chunk });
          }
          if ((eventType === DEBUG_EXEC_STREAM_EVENT.finished || eventType === DEBUG_EXEC_STREAM_EVENT.error) && event.response) {
            finalResponse = event.response;
          }
          if (eventType === DEBUG_EXEC_STREAM_EVENT.error) sawErrorEvent = true;
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split(/\r?\n\r?\n/);
            buffer = parts.pop() ?? "";
            parts.forEach(consumePart);
          }
          buffer += decoder.decode();
          if (buffer.trim()) consumePart(buffer);
        } finally {
          reader.releaseLock();
        }

        if (finalResponse) {
          return {
            status: finalResponse.status || "FAILED",
            exitCode: typeof finalResponse.exit_code === "number" ? finalResponse.exit_code : -1,
            output: finalResponse.output || output,
          };
        }
        return {
          status: output && !sawErrorEvent ? "SUCCESS" : "FAILED",
          exitCode: output && !sawErrorEvent ? 0 : -1,
          output,
        };
      } catch (error) {
        if (abortController.signal.aborted) {
          throw new Error(`debug_exec_timeout:${timeoutMs ?? 0}`);
        }
        if (error instanceof RepositoryError || error instanceof Error && error.message === "Command output stream is not readable.") {
          throw error;
        }
        throw createNetworkUnavailableError();
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    },

    async startRescueExport(botId: string) {
      const { instanceId } = await resolveBotScope(botId);
      const payload = await requestEnvelope<WorkerActionStartPayload>(baseUrl, "/api/worker-actions", {
        method: "POST",
        body: {
          bot_id: instanceId,
          action: "rescue_export",
          params: {
            archive_mode: "hermes",
            remote_paths: [DEFAULT_RESCUE_EXPORT_REMOTE_PATH],
          },
        },
      });
      return {
        actionRunId: payload.action_run_id,
        workflowId: payload.workflow_id,
        runId: payload.run_id,
        action: payload.action,
        botId: payload.bot_id,
        status: payload.status,
      };
    },

    async getRescueExportStatus(botId: string) {
      try {
        const { instanceId } = await resolveBotScope(botId);
        const payload = await requestEnvelope<WorkerActionStatusPayload>(
          baseUrl,
          `/api/worker-actions?bot_id=${encodeURIComponent(instanceId)}&action=rescue_export`,
          { method: "GET" },
        );
        return normalizeNullableWorkerActionStatus(payload);
      } catch (err) {
        if (err instanceof RepositoryError && err.status === 404 && err.code === "action_not_found") {
          return null;
        }
        throw err;
      }
    },

    async importHermesWorkspace(botId: string, file: File) {
      if (!file.name.toLowerCase().endsWith(".zip")) {
        throw new RepositoryError("请选择 Hermes 导出的 zip 文件。", 400, "hermes_import_zip_required");
      }
      const { instanceId } = await resolveBotScope(botId);
      const upload = await requestEnvelope<WorkerActionUploadPayload>(baseUrl, "/api/worker-actions", {
        method: "POST",
        body: {
          bot_id: instanceId,
          action: "hermes_import_upload",
          params: {
            file_name: file.name,
            byte_size: file.size,
          },
        },
      });
      const putResp = await fetch(upload.upload_url, {
        method: "PUT",
        headers: { "Content-Type": "application/zip" },
        body: file,
      });
      if (!putResp.ok) {
        throw new RepositoryError(`上传导入包失败（${putResp.status}）`, putResp.status, "hermes_import_upload_failed");
      }
      const payload = await requestEnvelope<WorkerActionStartPayload>(baseUrl, "/api/worker-actions", {
        method: "POST",
        body: {
          bot_id: instanceId,
          action: "hermes_import",
          params: {
            object_key: upload.object_key,
            object_url: upload.object_url,
          },
        },
      });
      return {
        actionRunId: payload.action_run_id,
        workflowId: payload.workflow_id,
        runId: payload.run_id,
        action: payload.action,
        botId: payload.bot_id,
        status: payload.status,
      };
    },

    async getHermesImportStatus(botId: string) {
      try {
        const { instanceId } = await resolveBotScope(botId);
        const payload = await requestEnvelope<WorkerActionStatusPayload>(
          baseUrl,
          `/api/worker-actions?bot_id=${encodeURIComponent(instanceId)}&action=hermes_import`,
          { method: "GET" },
        );
        return normalizeNullableWorkerActionStatus(payload);
      } catch (err) {
        if (err instanceof RepositoryError && err.status === 404 && err.code === "action_not_found") {
          return null;
        }
        throw err;
      }
    },

    async resetInstanceConfig(botId: string) {
      const { instanceId } = await resolveBotScope(botId);
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
      }>(baseUrl, `/v1/instances/${encodeURIComponent(instanceId)}/config/reset`, {
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
  async prepareReferralCode(code: string) {
    const normalized = code.trim().toUpperCase();
    await requestEnvelope(baseUrl, `/v1/referrals/codes/${encodeURIComponent(normalized)}`, {
      method: "GET",
    });
    await request<void>(baseUrl, "/auth/referral/prepare", {
      method: "POST",
      body: { code: normalized },
    });
  },
  async issueReferralCode() {
    const payload = await requestEnvelope<{
      code: string;
      url: string;
      campaign_id: string;
      campaign_name: string;
      starts_at: string;
      ends_at: string;
    }>(baseUrl, "/v1/referrals/me/code", { method: "POST" });
    return {
      code: payload.code,
      url: payload.url,
      campaignId: payload.campaign_id,
      campaignName: payload.campaign_name,
      startsAt: payload.starts_at,
      endsAt: payload.ends_at,
    };
  },
  async getReferralStats() {
    const payload = await requestEnvelope<{
      successful_referrals: number;
      granted_credits: number;
      pending_rewards: number;
      granted_rewards: number;
    }>(baseUrl, "/v1/referrals/me/stats", { method: "GET" });
    return {
      successfulReferrals: payload.successful_referrals,
      grantedCredits: payload.granted_credits,
      pendingRewards: payload.pending_rewards,
      grantedRewards: payload.granted_rewards,
    };
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
  async startRealnameFaceIdAttempt(input) {
    return request(baseUrl, "/auth/realname/faceid/attempts", {
      method: "POST",
      body: input,
    });
  },
  async getCurrentRealnameFaceIdAttempt() {
    return request(baseUrl, "/auth/realname/faceid/attempts/current", {
      method: "GET",
    });
  },
  async getRealnameFaceIdAttempt(attemptId) {
    return request(baseUrl, `/auth/realname/faceid/attempts/${encodeURIComponent(attemptId)}`, {
      method: "GET",
    });
  },
  async sendRealnameFaceIdPhoneCode(attemptId, input) {
    return request(baseUrl, `/auth/realname/faceid/attempts/${encodeURIComponent(attemptId)}/send-phone-code`, {
      method: "POST",
      body: input,
    });
  },
  async verifyRealnameFaceIdPhone(attemptId, input) {
    return request(baseUrl, `/auth/realname/faceid/attempts/${encodeURIComponent(attemptId)}/verify-phone`, {
      method: "POST",
      body: input,
    });
  },
  async finalizeRealnameFaceIdAttempt(attemptId) {
    return request(baseUrl, `/auth/realname/faceid/attempts/${encodeURIComponent(attemptId)}/finalize`, {
      method: "POST",
    });
  },
  async verifyRealname(input) {
    return request<RealnameVerifyResult>(baseUrl, "/auth/realname/verify", {
      method: "POST",
      body: input,
    });
  },
  async sendSmsCode(input) {
    return request(baseUrl, "/auth/sms/send", {
      method: "POST",
      body: input,
    });
  },
  async verifyRealnamePhone(input) {
    return request(baseUrl, "/auth/realname/verify-phone", {
      method: "POST",
      body: input,
    });
  },
  async retryRealnameSync() {
    return request(baseUrl, "/auth/realname/sync/retry", {
      method: "POST",
    });
  },
  async sendPhoneChangeCode(input) {
    return request(baseUrl, "/auth/profile/phone/send", {
      method: "POST",
      body: input,
    });
  },
  async verifyPhoneChange(input) {
    const response = await request<{ user: User }>(baseUrl, "/auth/profile/phone/verify", {
      method: "POST",
      body: input,
    });
    return response.user;
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
  async createTencentCloudRedirect(targetPath): Promise<TencentCloudRedirectResult> {
    return request<TencentCloudRedirectResult>(baseUrl, "/auth/tencent-cloud/redirect", {
      method: "POST",
      body: targetPath ? { targetPath } : {},
    });
  },
  async listPaymentMethods() {
    return request(baseUrl, "/auth/payment-methods?page=1&pageSize=100", {
      method: "GET",
    });
  },
  async createPaymentMethodSignOrder(languageCode) {
    return request(baseUrl, "/auth/payment-methods/sign-orders", {
      method: "POST",
      body: { languageCode },
    });
  },
  async setDefaultPaymentMethod(contractCode) {
    await request<void>(baseUrl, `/auth/payment-methods/${encodeURIComponent(contractCode)}/default`, {
      method: "PUT",
    });
  },
  async deletePaymentMethod(contractCode) {
    await request<void>(baseUrl, `/auth/payment-methods/${encodeURIComponent(contractCode)}`, {
      method: "DELETE",
    });
  },
  async getFederationAuthorizationContext(input: FederationAuthorizationInput): Promise<FederationAuthorizationContext> {
    const query = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      state: input.state,
    });
    const payload = await request<FederationContextPayload>(
      baseUrl,
      `/auth/federation/context?${query.toString()}`,
      { method: "GET" },
    );
    return {
      clientId: payload.client.id,
      clientDisplayName: payload.client.display_name,
      redirectUri: payload.redirect_uri,
      state: payload.state,
      currentSession: payload.session.authenticated && payload.session.user ? {
        user: {
          id: payload.session.user.id,
          name: payload.session.user.name,
          email: payload.session.user.email,
          phone: payload.session.user.phone,
          avatarUrl: payload.session.user.avatarUrl,
        },
      } : null,
    };
  },
  async issueFederationTicket(input: FederationAuthorizationInput): Promise<FederationTicketResult> {
    const payload = await request<FederationTicketPayload>(baseUrl, "/auth/federation/tickets", {
      method: "POST",
      body: {
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        state: input.state,
      },
    });
    return {
      redirectUrl: payload.redirect_url,
      expiresAt: payload.expires_at,
    };
  },
  async getOIDCAuthorizationContext(input: OIDCAuthorizationInput): Promise<OIDCAuthorizationContext> {
    const query = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      state: input.state,
      response_type: input.responseType,
      scope: input.scope,
      code_challenge: input.codeChallenge,
      code_challenge_method: input.codeChallengeMethod,
      nonce: input.nonce,
    });
    const payload = await request<OIDCContextPayload>(
      baseUrl,
      `/oauth2/authorize/context?${query.toString()}`,
      { method: "GET" },
    );
    return {
      clientId: payload.client.id,
      clientDisplayName: payload.client.display_name,
      redirectUri: payload.redirect_uri,
      state: payload.state,
      responseType: payload.response_type,
      scope: payload.scope,
      codeChallenge: payload.code_challenge,
      codeChallengeMethod: payload.code_challenge_method,
      nonce: payload.nonce,
      currentSession: payload.session.authenticated && payload.session.user ? {
        user: {
          id: payload.session.user.id,
          name: payload.session.user.name,
          email: payload.session.user.email,
          phone: payload.session.user.phone,
          avatarUrl: payload.session.user.avatarUrl,
        },
      } : null,
    };
  },
  async authorizeOIDC(input: OIDCAuthorizationInput): Promise<OIDCAuthorizationResult> {
    const payload = await request<OIDCAuthorizationPayload>(baseUrl, "/oauth2/authorize", {
      method: "POST",
      body: {
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        state: input.state,
        response_type: input.responseType,
        scope: input.scope,
        code_challenge: input.codeChallenge,
        code_challenge_method: input.codeChallengeMethod,
        nonce: input.nonce,
      },
    });
    return {
      redirectUrl: payload.redirect_url,
      expiresAt: payload.expires_at,
    };
  },
  async prepareFederationSwitch() {
    await request(baseUrl, "/auth/federation/switch/prepare", { method: "POST" });
  },
  async cancelFederationSwitch() {
    await request(baseUrl, "/auth/federation/switch", { method: "DELETE" });
  },
  getOAuthStartUrl(provider, options) {
    const base = typeof window !== "undefined" ? window.location.origin : "https://lightclaw.tech";
    const oauthStartBaseURL = resolveOAuthStartBaseURL(baseUrl);
    const startURL = new URL(buildUrl(oauthStartBaseURL, `/auth/oauth/${provider}/start`), base);
    if (provider === "wechat" && options?.wechatMode) {
      startURL.searchParams.set("mode", options.wechatMode);
    }
    if (options?.switchAccount) {
      startURL.searchParams.set("switch_account", "true");
    }
    const relayIssuerBaseURL = configuredOAuthRelayIssuerBaseURL();
    if (relayIssuerBaseURL) {
      startURL.searchParams.set("relay_mode", "issuer");
      startURL.searchParams.set("issuer_redirect_uri", buildUrl(relayIssuerBaseURL, `/auth/oauth/${provider}/callback`));
    }
    const returnTo = options?.returnTo ?? currentOAuthReturnTo();
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
  async listModifyBundles(passId) {
    return requestEnvelope<PassModifyBundles>(baseUrl, `/v1/passes/${encodeURIComponent(passId)}/modify/bundles`, { method: 'GET' });
  },
  async getModifyCheckout(passId) {
    return requestEnvelope<PassModifyCheckout>(baseUrl, `/v1/passes/${encodeURIComponent(passId)}/modify/checkout`, { method: 'GET' });
  },
  async createModifyOrder(passId, input) {
    return requestEnvelope<PassModifyOrder>(baseUrl, `/v1/passes/${encodeURIComponent(passId)}/modify/order`, { method: 'POST', body: input });
  },
  async getModifyOrderUrl(passId, input) {
    return requestEnvelope<CreatePassOrderUrlResult>(baseUrl, `/v1/passes/${encodeURIComponent(passId)}/modify/order-url`, { method: 'POST', body: input });
  },
  async refreshModifyPaymentAuthorization(passId, input) {
    return requestEnvelope<{ auth_code: string }>(baseUrl, `/v1/passes/${encodeURIComponent(passId)}/modify/payment-authorization`, { method: 'POST', body: input });
  },
  async getOrderStatus(dealName) {
    return requestEnvelope<PassOrderStatus>(baseUrl, `/v1/orders/${encodeURIComponent(dealName)}/status`, { method: 'GET' });
  },
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
  async listBundles(query) {
    // 联调文档 §1.1：传 time_span / time_unit 携带询价参数；不传则降级到无价格模式
    const search = new URLSearchParams();
    if (query?.time_span !== undefined) {
      search.set("time_span", String(query.time_span));
    }
    if (query?.time_unit !== undefined) {
      search.set("time_unit", query.time_unit);
    }
    const path = search.toString() ? `/v1/bundles?${search.toString()}` : "/v1/bundles";
    const payload = await requestEnvelope<{ bundles: Bundle[] }>(baseUrl, path, {
      method: "GET",
    });
    return payload.bundles ?? [];
  },
  async createPass(bundleId) {
    // 联调文档 §5.2：试用入口（国际站使用，国内站走 createPassOrder）
    return requestEnvelope<Pass>(baseUrl, "/v1/passes", {
      method: "POST",
      body: { bundle_id: bundleId },
    });
  },
  async getCreatePrerequisites() {
    return requestEnvelope<{ site_kind: string; shadow_account_enabled: boolean; shadow_bound: boolean }>(
      baseUrl,
      "/v1/instances/create-prerequisites",
      { method: "GET" },
    );
  },
  async sendShadowBindingSms(input) {
    await request(baseUrl, "/v1/shadow/binding/send-sms", {
      method: "POST",
      body: input,
    });
  },
  async verifyShadowBindingPhone(input) {
    await request(baseUrl, "/v1/shadow/binding/verify-phone", {
      method: "POST",
      body: input,
    });
  },
  async createPassOrder(input) {
    // 联调文档 §2.1（v1.7.31 拆分）：纯下单仅拿 { deal_names }，拉支付 URL 走 getPassOrderUrl
    return requestEnvelope<CreatePassOrderResult>(baseUrl, "/v1/passes/order", {
      method: "POST",
      body: input,
    });
  },
  async getPassOrderUrl(input, init) {
    // 联调文档 §2.2（v1.7.31 + CodeBuddy AuthCode）：
    //   PC 端：   body 只带 deal_names + platform: "pc"，request 函数自动补 Bearer 鉴权
    //   中转页：  body 额外带 wx_code + auth_code；本地无 token 时 request 会跳过 Authorization（见 line 318-321）
    //                后端检测到 auth_code 后绕过 Bearer 鉴权、用 auth_code 反查 user_id。
    return requestEnvelope<CreatePassOrderUrlResult>(baseUrl, "/v1/passes/order-url", {
      method: "POST",
      body: input,
      headers: init?.headers,
    });
  },
  async createPassOrderAndPay(input) {
    // 联调文档 §2.2：仅联调测试用，现网禁止暴露给真实用户
    return requestEnvelope<CreatePassOrderAndPayResult>(baseUrl, "/v1/passes/order-and-pay", {
      method: "POST",
      body: input,
    });
  },
  async createDianshiPassOrderAndPay(input) {
    return requestEnvelope<CreateDianshiPassOrderAndPayResult>(baseUrl, "/v1/passes/dianshi/order-and-pay", {
      method: "POST",
      body: input,
    });
  },
  async getRenewPrice(passId, input) {
    // 联调文档 §3.1：续费询价 — 单位是分（cents）
    return requestEnvelope<PassRenewPrice>(baseUrl, `/v1/passes/${encodeURIComponent(passId)}/renew/price`, {
      method: "POST",
      body: input,
    });
  },
  async createRenewOrder(passId, input) {
    // 联调文档 §3.2（v1.7.31 拆分）：续费纯下单仅拿 { deal_names }
    return requestEnvelope<CreatePassOrderResult>(baseUrl, `/v1/passes/${encodeURIComponent(passId)}/renew/order`, {
      method: "POST",
      body: input,
    });
  },
  async getRenewOrderUrl(passId, input, init) {
    // 联调文档 §3.3（v1.7.31 + CodeBuddy AuthCode）：调用模式同 getPassOrderUrl。
    return requestEnvelope<CreatePassOrderUrlResult>(baseUrl, `/v1/passes/${encodeURIComponent(passId)}/renew/order-url`, {
      method: "POST",
      body: input,
      headers: init?.headers,
    });
  },
  async createRenewOrderAndPay(passId, input) {
    // 联调文档 §3.3：续费下单+支付一体化（仅联调）
    return requestEnvelope<CreatePassOrderAndPayResult>(baseUrl, `/v1/passes/${encodeURIComponent(passId)}/renew/order-and-pay`, {
      method: "POST",
      body: input,
    });
  },
  async deletePass(passId) {
    // 联调文档 §4.1：销毁 pass — 仅 isolated 状态可调，前端需轮询 listMyPasses 确认
    return requestEnvelope<DeletePassResult>(baseUrl, `/v1/passes/${encodeURIComponent(passId)}/delete`, {
      method: "POST",
    });
  },
  async listMyPasses() {
    const payload = await requestEnvelope<{ passes: Pass[] }>(baseUrl, "/v1/passes", {
      method: "GET",
    });
    return payload.passes ?? [];
  },
});

/*
 * 积分包仓储。对应 credit 服务，路由见 credit/internal/httpapi/server.go:35-53。
 *
 * 本期只接入 products / inquiry / packages 三个只读接口。
 * 下单（/v1/credit/packages/order）与支付未接入：trade 侧 payURL 恒为空
 * （trade/internal/logic/creditorder/service.go:178,229），拿不到微信二维码
 * 或信用卡托管页地址，购买流程无法闭环。
 */
const createHttpCreditRepository = (baseUrl: string): CreditRepository => ({
  async listCreditProducts() {
    const payload = await requestEnvelope<CreditProduct[]>(baseUrl, "/v1/credit/products", {
      method: "GET",
    });
    return payload ?? [];
  },
  async inquireCreditPrice(productId) {
    /* timeSpan/timeUnit 固定 1 个月：本期只售 1 个月有效期积分包。
       ⚠️ 直出 JSON（无 envelope）——与 products 不同，联调文档 §5；
       后端 server.go 的 inquiry 用 writeJSON(out) 直出 QuoteResult。 */
    return request<CreditQuote>(baseUrl, "/v1/credit/inquiry", {
      method: "POST",
      body: { product_id: productId, time_span: 1, time_unit: "m" },
    });
  },
  async createCreditOrder(productId) {
    /* 商品与周期必须与询价一致；该接口直出 JSON（无 envelope），响应为 camelCase */
    return request<CreditOrderResult>(baseUrl, "/v1/credit/packages/order", {
      method: "POST",
      body: { product_id: productId, time_span: 1, time_unit: "m" },
    });
  },
  async createCreditOrderUrl(input) {
    /* 直出 JSON（无 envelope）。订单不存在/归属不符/类型不符时后端返回 404 */
    return request<CreditOrderUrlResult>(baseUrl, "/v1/credit/packages/order-url", {
      method: "POST",
      body: input,
    });
  },
  async listCreditPackages() {
    const payload = await request<{ credits?: CreditPackageItem[] }>(baseUrl, "/v1/credit/packages", {
      method: "GET",
    });
    return payload.credits ?? [];
  },
});

export const createHttpRepositories = (baseUrl: string): Repositories => {
  bootstrapStoredAuthTokenFromLocation();
  return {
    ...createFakeRepositories(),
    auth: createHttpAuthRepository(baseUrl),
    plans: createHttpPlanRepository(baseUrl),
    bots: createHttpBotRepository(baseUrl),
    credit: createHttpCreditRepository(baseUrl),
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
