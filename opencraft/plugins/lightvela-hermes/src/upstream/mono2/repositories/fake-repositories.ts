// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type {
  AuthSessionSnapshot,
  BillingSummary,
  Bot,
  BotChannelConfigResult,
  BotRuntime,
  BotVersion,
  Bundle,
  BundlePrice,
  CreateDianshiPassOrderAndPayResult,
  CreatePassOrderAndPayResult,
  CreatePassOrderResult,
  CreatePassOrderUrlResult,
  CurrentSubscription,
  DeletePassResult,
  Pass,
  PassRenewPrice,
  ToolBinding,
  User,
  WorkspaceMessage,
} from "../domain/types";
import { planCatalog } from "../domain/plan-catalog";
import { getAccountPreviewOverrides } from "./account-preview-states";
import type { OAuthProvider, WeChatOAuthMode } from "../lib/oauth";
import type {
  BotRepository,
  DashboardSnapshot,
  PaymentMethod,
  RealnameFaceIdAttempt,
  RealnameFaceIdAttemptState,
  Repositories,
  SettingsSnapshot,
  WorkspaceSnapshot,
} from "./types";

const NETWORK_DELAY_MS = 320;
const DEBUG_EXEC_OPENCLAW_CONFIG_COMMAND = "openclaw_config";
const DEBUG_EXEC_STDOUT_STREAM = "stdout";
const FAKE_AUTH_STORAGE_KEY = "lightclaw-fake-auth-v1";
const LOCAL_PREVIEW_AUTH_ENABLED =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_LOCAL_PREVIEW_AUTH === "1")
  || (typeof process !== "undefined" && process.env.VITE_LOCAL_PREVIEW_AUTH === "1")
  || import.meta.env?.VITE_LOCAL_PREVIEW_AUTH === "1";
const LOCAL_PREVIEW_BOT_ID = "bot_local_preview";

// 重置配置相关的假数据常量
const FAKE_RESET_PROVIDER_NAME = "custom";
const FAKE_RESET_BASE_URL = "https://api.example.invalid";
const FAKE_RESET_MODEL_ID = "fake-model";
const FAKE_RESET_API = "chat_completions";
const FACE_ID_ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;

type FakeFaceIdAttemptRecord = {
  attemptId: string;
  userId: string;
  state: RealnameFaceIdAttemptState;
  verificationUrl: string;
  expiresAt: string;
  facePollCount: number;
};

const fakeFaceIdAttempts = new Map<string, FakeFaceIdAttemptRecord>();

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const nowIso = () => new Date().toISOString();
const fakeOAuthStartURL = (
  provider: OAuthProvider,
  wechatMode?: WeChatOAuthMode,
  switchAccount = false,
  returnTo?: string,
) => {
  const startURL = new URL(`https://lightclaw.tech/auth/oauth/${provider}/start`);
  if (provider === "wechat" && wechatMode) {
    startURL.searchParams.set("mode", wechatMode);
  }
  if (switchAccount) {
    startURL.searchParams.set("switch_account", "true");
  }
  const target = returnTo ?? (typeof window !== "undefined" ? window.location?.href : undefined);
  if (target) {
    startURL.searchParams.set("return_to", target);
  }
  return startURL.toString();
};

const normalizePhone = (value: string) => value.replace(/[^\d+]/g, "").replace(/^(\+?86)/, "").trim();

const isValidChinaMainlandPhone = (value: string) => /^1\d{10}$/.test(normalizePhone(value));

const mockUser = (input: { email?: string; phone?: string; name?: string }): User => {
  const { email, phone, name } = input;
  return {
    id: "usr_01hxa2f",
    name: name ?? (phone ? `用户${normalizePhone(phone).slice(-4)}` : email?.split("@")[0]) ?? "Operator",
    email,
    phone: phone ? normalizePhone(phone) : undefined,
    avatarUrl: "/auth/profile/avatar",
    inviteRequired: false,
    createdAt: nowIso(),
  };
};

// ─────────────────────────────────────────────────────────────────────────
// 账号管理页 —— 本地假数据交互状态预设
//
// 目的：用真实账号页组件 + 假数据，覆盖所有交互状态，便于本地预览调试。
// 用法：访问 /account?state=<key>，getSession 会按 key 返回对应的完整假用户；
//       或用页面右下角的「预览状态切换器」直接点选。
// 预设清单集中维护在 account-preview-states.ts（切换器与本文件共用）。
// ─────────────────────────────────────────────────────────────────────────
const ACCOUNT_PREVIEW_BASE_USER: User = {
  id: "usr_01hxa2f",
  name: "本地预览用户",
  phone: "13800138000",
  email: undefined,
  avatarUrl: "/auth/profile/avatar",
  inviteRequired: false,
  createdAt: nowIso(),
};

/** 从当前 URL 读取 ?state= 预设 key（仅浏览器环境）。 */
const readAccountPreviewStateKey = (): string | null => {
  if (typeof window === "undefined") return null;
  try {
    const key = new URLSearchParams(window.location.search).get("state");
    return key && key.trim().length > 0 ? key.trim() : null;
  } catch {
    return null;
  }
};

/** 构造带交互状态预设的账号预览用户。 */
const buildAccountPreviewUser = (stateKey: string | null): User => {
  return { ...ACCOUNT_PREVIEW_BASE_USER, createdAt: nowIso(), ...getAccountPreviewOverrides(stateKey) };
};

const toSessionSnapshot = (user: User): AuthSessionSnapshot => ({
  user,
  currentSubscription: null,
  impersonated: false,
  authenticatedAt: nowIso(),
});

const readStoredAuthSession = (): AuthSessionSnapshot | null => {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(FAKE_AUTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as AuthSessionSnapshot;
  } catch {
    return null;
  }
};

const writeStoredAuthSession = (session: AuthSessionSnapshot | null) => {
  if (typeof window === "undefined") {
    return;
  }

  if (!session) {
    window.localStorage.removeItem(FAKE_AUTH_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(FAKE_AUTH_STORAGE_KEY, JSON.stringify(session));
};

const updateStoredUser = (mutate: (user: User) => User) => {
  const session = readStoredAuthSession();
  if (!session) {
    return null;
  }
  const next = {
    ...session,
    user: mutate(session.user),
  } satisfies AuthSessionSnapshot;
  writeStoredAuthSession(next);
  return next;
};

const revokeBlobAvatarUrl = (avatarUrl?: string) => {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }
  if (avatarUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(avatarUrl);
  }
};

const toPublicFaceIdAttempt = (record: FakeFaceIdAttemptRecord): RealnameFaceIdAttempt => ({
  attemptId: record.attemptId,
  state: record.state,
  verificationUrl: record.verificationUrl,
  expiresAt: record.expiresAt,
});

const expireFakeAttemptIfNeeded = (record: FakeFaceIdAttemptRecord) => {
  if (record.state === "succeeded" || record.state === "failed" || record.state === "expired") {
    return record;
  }
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    record.state = "expired";
  }
  return record;
};

const baseBilling: BillingSummary = {
  tier: "free",
  monthCost: 0,
  budgetLimit: 29,
  estimatedMonthEnd: 12,
  tokenSpend: 314_000,
  runMinutes: 892,
};

const runtimeFor = (botId: string): BotRuntime => ({
  botId,
  health: "healthy",
  latencyMs: 482,
  throughputPerMinute: 148,
  lastHeartbeatAt: nowIso(),
  activeSessions: 26,
  tokenUsage: 3140,
});

const defaultTools: ToolBinding[] = [
  {
    id: "tool_1",
    name: "用户画像查询",
    provider: "mcp",
    enabled: true,
    lastRunAt: nowIso(),
  },
  {
    id: "tool_2",
    name: "订单状态检索",
    provider: "http",
    enabled: true,
    lastRunAt: nowIso(),
  },
  {
    id: "tool_3",
    name: "会话摘要生成",
    provider: "native",
    enabled: false,
    lastRunAt: nowIso(),
  },
];

const botStore = new Map<string, Bot>();
const messageStore = new Map<string, WorkspaceMessage[]>();

const seedMessagesFor = (botId: string) => {
  if (messageStore.has(botId)) {
    return;
  }

  messageStore.set(botId, [
    {
      id: `msg_${Date.now()}_sys`,
      role: "system",
      text: "测试工作台已准备好，可直接发送提示词进行验证。",
      createdAt: nowIso(),
    },
    {
      id: `msg_${Date.now()}_assistant`,
      role: "assistant",
      text: "你好，我是 Hermes Bot，随时可以开始一次真实对话演练。",
      createdAt: nowIso(),
    },
  ]);
};

const ensureLocalPreviewBot = (): Bot | null => {
  if (!LOCAL_PREVIEW_AUTH_ENABLED) return null;
  const existing = botStore.get(LOCAL_PREVIEW_BOT_ID) ?? [...botStore.values()][0];
  if (existing) return existing;

  const bot: Bot = {
    id: LOCAL_PREVIEW_BOT_ID,
    instanceId: LOCAL_PREVIEW_BOT_ID,
    profileId: "main",
    isDefault: true,
    createdFrom: "blank",
    name: "我的Hermes",
    type: "support",
    template: "通用对话模板",
    mission: "本地预览 Agent 控制台",
    scenario: "本地预览",
    createdAt: nowIso(),
    status: "active",
  };
  botStore.set(bot.id, bot);
  seedMessagesFor(bot.id);
  return bot;
};

const versionsFor = (botId: string): BotVersion[] => [
  {
    id: `ver_${botId}_118`,
    botId,
    label: "v1.18",
    createdAt: nowIso(),
    actor: "ops@lightclaw.ai",
    notes: "提示词边界强化与超时保护",
    rollbackAvailable: true,
  },
  {
    id: `ver_${botId}_117`,
    botId,
    label: "v1.17",
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    actor: "ml@lightclaw.ai",
    notes: "模型参数微调",
    rollbackAvailable: true,
  },
];

const assertMode = async (mode: "live" | "empty" | "error" = "live") => {
  await wait(NETWORK_DELAY_MS);
  if (mode === "error") {
    throw new Error("服务暂时不可用，请稍后重试。");
  }
};

/* ─── 套餐/权益 mock 数据 ─── */

/**
 * mock 价格构造器。入参以「元」为单位以方便编辑，内部转为「分」以与后端询价接口保持一致。
 */
const buildFakePrice = (yuan: number): BundlePrice => {
  const cents = Math.round(yuan * 100);
  return {
    price: cents,
    total_cost: cents,
    real_total_cost: cents,
    currency: "CNY",
    discount: 1.0,
  };
};

const FAKE_BUNDLES: Bundle[] = [
  {
    bundle_id: "bundle_free_7d",
    bundle_name: "免费试用 7天",
    description: [
      { Key: "Agent", Value: "1个" },
    ],
    bundle_state: "ONLINE",
    agent_quota: 1,
    credit: 0,
    // 免费试用套餐，price = null 表示不走付费架构
    price: null,
    time_span: 7,
    time_unit: "d",
    bundle_sales_available_count: 99,
    bundle_sales_total_count: 100,
    bundle_sales_state: "AVAILABLE",
    created_time: "2026-04-18T18:52:37Z",
    updated_time: "2026-04-18T18:54:31Z",
  },
  {
    bundle_id: "bundle_launch_01",
    bundle_name: "启航 Launch",
    description: [
      { Key: "Agent", Value: "1个" },
      { Key: "独立环境", Value: "" },
      { Key: "7×24小时在线", Value: "" },
    ],
    bundle_state: "ONLINE",
    agent_quota: 1,
    credit: 100,
    price: buildFakePrice(49.0),
    time_span: 1,
    time_unit: "m",
    bundle_sales_available_count: 99,
    bundle_sales_total_count: 100,
    bundle_sales_state: "AVAILABLE",
    created_time: "2026-04-18T18:52:37Z",
    updated_time: "2026-04-18T18:54:31Z",
  },
];

const FAKE_PASSES_STORAGE_KEY = "lightclaw-fake-passes-v1";
const ACCOUNT_PREVIEW_PASS_STATE_QUERY_KEY = "passState";

const readAccountPreviewPassStateKey = (): string | null => {
  if (typeof window === "undefined") return null;
  try {
    const key = new URLSearchParams(window.location.search).get(ACCOUNT_PREVIEW_PASS_STATE_QUERY_KEY);
    return key && key.trim().length > 0 ? key.trim() : null;
  } catch {
    return null;
  }
};

const buildExpiringAccountPreviewPass = (): Pass => {
  const now = Date.now();
  return {
    pass_id: "pass-preview-expiring",
    user_id: ACCOUNT_PREVIEW_BASE_USER.id,
    bundle_id: "bundle_launch_01",
    bundle_name: "启航 Launch",
    created_time: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    expired_time: new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString(),
    isolated_time: null,
    deleted_time: null,
    updated_time: new Date(now).toISOString(),
    agent_quota_total: 1,
    agent_quota_available: 0,
    credit_total: 100,
    credit_available: 88,
  };
};

const readStoredPasses = (): Pass[] => {
  if (typeof window === "undefined") {
    return [];
  }
  if (readAccountPreviewPassStateKey() === "expiring") {
    return [buildExpiringAccountPreviewPass()];
  }
  try {
    const raw = window.localStorage.getItem(FAKE_PASSES_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    return JSON.parse(raw) as Pass[];
  } catch {
    return [];
  }
};

const writeStoredPasses = (passes: Pass[]) => {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(FAKE_PASSES_STORAGE_KEY, JSON.stringify(passes));
};

const computeExpiredIso = (bundle: Bundle): string => {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const span = bundle.time_unit === "m" ? bundle.time_span * 30 * dayMs : bundle.time_span * dayMs;
  return new Date(now + span).toISOString();
};

export const createFakeRepositories = (): Repositories => {
  let paymentMethods: PaymentMethod[] = [];

  return {
    auth: {
      async signInWithCode({ phone }) {
        await wait(NETWORK_DELAY_MS);
        if (!isValidChinaMainlandPhone(phone)) {
          throw new Error("手机号格式不正确。");
        }
        const session = toSessionSnapshot(mockUser({ phone }));
        writeStoredAuthSession(session);
        return session;
      },
      async prepareInviteCode() {
        await wait(NETWORK_DELAY_MS);
      },
      async activateInviteCode() {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        if (!session) {
          throw new Error("未登录或登录已失效。");
        }
        const next = {
          ...session,
          user: {
            ...session.user,
            inviteRequired: false,
          },
        };
        writeStoredAuthSession(next);
        return next.user;
      },
      async signUpWithCode({ name, phone }) {
        await wait(NETWORK_DELAY_MS);
        if (!isValidChinaMainlandPhone(phone)) {
          throw new Error("手机号格式不正确。");
        }
        const session = toSessionSnapshot(mockUser({ phone, name }));
        writeStoredAuthSession(session);
        return session;
      },
      async validateInviteCode(code) {
        await wait(NETWORK_DELAY_MS);
        return { code, state: "valid", message: "邀请码校验已关闭。" };
      },
      async getSession() {
        await wait(NETWORK_DELAY_MS);
        // 账号页交互状态预览：URL 带 ?state= 时，按预设强制重置会话（便于切换状态查看）。
        const previewStateKey = readAccountPreviewStateKey();
        if (previewStateKey) {
          const previewSession = toSessionSnapshot(buildAccountPreviewUser(previewStateKey));
          writeStoredAuthSession(previewSession);
          return previewSession;
        }
        const session = readStoredAuthSession();
        if (session) return session;
        if (!LOCAL_PREVIEW_AUTH_ENABLED) return null;

        const previewSession = toSessionSnapshot(buildAccountPreviewUser(null));
        writeStoredAuthSession(previewSession);
        return previewSession;
      },
      async getProfile() {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        if (!session) {
          throw new Error("未登录或登录已失效。");
        }
        return session.user;
      },
      async updateProfile({ name }) {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        if (!session) {
          throw new Error("未登录或登录已失效。");
        }
        const next = {
          ...session,
          user: {
            ...session.user,
            name,
          },
        };
        writeStoredAuthSession(next);
        return next.user;
      },
      async uploadAvatar(file) {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        if (!session) {
          throw new Error("未登录或登录已失效。");
        }

        revokeBlobAvatarUrl(session.user.avatarUrl);

        const next = {
          ...session,
          user: {
            ...session.user,
            avatarUrl: URL.createObjectURL(file),
          },
        };
        writeStoredAuthSession(next);
        return next.user;
      },
      async deleteAccount() {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        revokeBlobAvatarUrl(session?.user.avatarUrl);
        writeStoredAuthSession(null);
      },
      async startRealnameFaceIdAttempt({ consent }) {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        if (!session) {
          throw new Error("未登录或登录已失效。");
        }
        if (!consent) {
          throw new Error("请先阅读并同意相关说明。");
        }

        const attemptId = `fake-faceid-${Math.random().toString(36).slice(2, 10)}`;
        const record: FakeFaceIdAttemptRecord = {
          attemptId,
          userId: session.user.id,
          state: "pending",
          verificationUrl: `https://faceid.example.invalid/${attemptId}`,
          expiresAt: new Date(Date.now() + FACE_ID_ATTEMPT_LIFETIME_MS).toISOString(),
          facePollCount: 0,
        };
        fakeFaceIdAttempts.set(attemptId, record);
        return toPublicFaceIdAttempt(record);
      },
      async getCurrentRealnameFaceIdAttempt() {
        await wait(NETWORK_DELAY_MS / 2);
        const session = readStoredAuthSession();
        if (!session) {
          throw new Error("未登录或登录已失效。");
        }
        const record = Array.from(fakeFaceIdAttempts.values())
          .filter((item) => item.userId === session.user.id)
          .reverse()
          .find((item) => !["succeeded", "failed", "expired"].includes(item.state));
        if (!record) {
          throw Object.assign(new Error("实名认证记录不存在。"), { status: 404 });
        }
        return toPublicFaceIdAttempt(expireFakeAttemptIfNeeded(record));
      },
      async getRealnameFaceIdAttempt(attemptId) {
        await wait(NETWORK_DELAY_MS / 2);
        const session = readStoredAuthSession();
        if (!session) {
          throw new Error("未登录或登录已失效。");
        }
        const record = fakeFaceIdAttempts.get(attemptId);
        if (!record || record.userId !== session.user.id) {
          throw new Error("实名认证记录不存在。");
        }

        expireFakeAttemptIfNeeded(record);
        if (record.state === "pending") {
          record.facePollCount += 1;
          if (record.facePollCount >= 2) {
            record.state = "face_succeeded";
          }
          return toPublicFaceIdAttempt(record);
        }
        if (record.state === "face_succeeded") {
          record.state = "phone_pending";
          return toPublicFaceIdAttempt(record);
        }
        return toPublicFaceIdAttempt(record);
      },
      async verifyRealnameFaceIdPhone(attemptId, { code, phone }) {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        const record = fakeFaceIdAttempts.get(attemptId);
        if (!session || !record || record.userId !== session.user.id) {
          throw new Error("实名认证记录不存在。");
        }
        if (!code.trim()) {
          throw new Error("验证码不能为空。");
        }
        const candidatePhone = phone?.trim() || session.user.phone?.trim() || "";
        if (!/^1\d{10}$/.test(candidatePhone)) {
          throw new Error("手机号格式不正确。");
        }
        if (session.user.phone?.trim() && session.user.phone.trim() !== candidatePhone) {
          throw new Error("当前手机号已变更，请重新开始实名认证。");
        }
        if (record.state !== "face_succeeded" && record.state !== "phone_pending") {
          throw new Error("请先完成人脸核身。");
        }
        record.state = "succeeded";
        updateStoredUser((user) => ({
          ...user,
          phone: candidatePhone,
          realnameVerified: true,
          realnameLevel: "phone_3fa",
          realnameSyncStatus: "succeeded",
        }));
        return toPublicFaceIdAttempt(record);
      },
      async finalizeRealnameFaceIdAttempt(attemptId) {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        const record = fakeFaceIdAttempts.get(attemptId);
        if (!session || !record || record.userId !== session.user.id) {
          throw new Error("实名认证记录不存在。");
        }
        if (record.state !== "shadow_pending" && record.state !== "succeeded") {
          throw new Error("实名认证尚未完成。");
        }
        record.state = "succeeded";
        updateStoredUser((user) => ({
          ...user,
          realnameVerified: true,
          realnameLevel: "phone_3fa",
          realnameSyncStatus: "succeeded",
        }));
        return toPublicFaceIdAttempt(record);
      },
      async verifyRealname({ name, idCard }) {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        if (!session) {
          throw new Error("未登录或登录已失效。");
        }
        // 前端假实现：不接触真实证件库，直接视为认证通过；
        // nameMasked 规则与后端一致：首字符 + 其后全部 *
        const masked = name.length > 0 ? `${name[0]}${"*".repeat(Math.max(0, name.length - 1))}` : "";
        const phoneVerifiedInSession = Boolean(session.user.phone?.trim());
        const nextRealnameLevel = phoneVerifiedInSession ? "phone_3fa" : "idcard_2fa";
        const nextRealnameSyncStatus = phoneVerifiedInSession ? "succeeded" : "pending";
        const next = {
          ...session,
          user: {
            ...session.user,
            realnameVerified: phoneVerifiedInSession,
            realnameLevel: nextRealnameLevel,
            realnameSyncStatus: nextRealnameSyncStatus,
          },
        } satisfies AuthSessionSnapshot;
        writeStoredAuthSession(next);
        return {
          ok: true,
          verified: true,
          nameMasked: masked,
          idCardMasked: idCard ? `${idCard.slice(0, 4)}********${idCard.slice(-4)}` : "",
          requestId: "fake-realname",
          phoneVerificationRequired: !phoneVerifiedInSession,
          phoneVerificationSkipped: phoneVerifiedInSession,
          realnameLevel: nextRealnameLevel,
          shadowBindingStatus: phoneVerifiedInSession ? "active" : undefined,
        };
      },
      async sendSmsCode() {
        await wait(NETWORK_DELAY_MS / 2);
        return { cooldownSeconds: 60 };
      },
      async sendRealnameFaceIdPhoneCode(_attemptId, _input) {
        await wait(NETWORK_DELAY_MS / 2);
        return { cooldownSeconds: 60 };
      },
      async verifyRealnamePhone() {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        if (!session) {
          throw new Error("未登录或登录已失效。");
        }
        const activeAttempt = Array.from(fakeFaceIdAttempts.values()).find((item) => item.userId === session.user.id && (
          item.state === "face_succeeded" || item.state === "phone_pending"
        ));
        if (!activeAttempt) {
          throw new Error("请先完成人脸核身。");
        }
        activeAttempt.state = "shadow_pending";
        writeStoredAuthSession({
          ...session,
          user: {
            ...session.user,
            realnameVerified: false,
            realnameLevel: "phone_3fa",
            realnameSyncStatus: "pending",
          },
        });
        return {
          ok: true,
          realnameLevel: "phone_3fa",
          realnameSyncStatus: "pending",
          shadowBindingStatus: "pending",
        };
      },
      async retryRealnameSync() {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        if (!session) {
          throw new Error("未登录或登录已失效。");
        }
        const activeAttempt = Array.from(fakeFaceIdAttempts.values()).find((item) => item.userId === session.user.id && (
          item.state === "shadow_pending" || item.state === "failed" || item.state === "phone_pending"
        ));
        if (activeAttempt) {
          activeAttempt.state = "shadow_pending";
        }
        const next = {
          ...session,
          user: {
            ...session.user,
            realnameVerified: false,
            realnameLevel: "phone_3fa",
            realnameSyncStatus: "pending" as const,
          },
        };
        writeStoredAuthSession(next);
        return {
          ok: true,
          user: next.user,
          realnameSyncStatus: "pending" as const,
          shadowBindingStatus: "pending",
        };
      },
      async sendPhoneChangeCode() {
        await wait(NETWORK_DELAY_MS / 2);
        return { cooldownSeconds: 60 };
      },
      async verifyPhoneChange({ phone }) {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        if (!session) {
          throw new Error("未登录或登录已失效。");
        }
        if (!isValidChinaMainlandPhone(phone)) {
          throw new Error("手机号格式不正确。");
        }
        const next = {
          ...session,
          user: {
            ...session.user,
            phone: normalizePhone(phone),
          },
        };
        writeStoredAuthSession(next);
        return next.user;
      },
      async requestEmailBind({ email }) {
        await wait(NETWORK_DELAY_MS / 2);
        const session = readStoredAuthSession();
        if (!session) {
          throw new Error("未登录或登录已失效。");
        }
        if (!email.includes("@")) {
          throw new Error("邮箱格式不正确。");
        }
        return { cooldownSeconds: 60 };
      },
      async createTatDeviceBind({ callbackUrl }) {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        if (!session) {
          throw new Error("未登录或登录已失效。");
        }
        const redirectUrl = new URL(callbackUrl);
        redirectUrl.searchParams.set("ticket", "fake-register-code-id");
        redirectUrl.searchParams.set("region", "ap-guangzhou");
        redirectUrl.searchParams.set("register_code_id", "fake-register-code-id");
        redirectUrl.searchParams.set("register_code_value", "fake-register-code-value");
        redirectUrl.searchParams.set("registration_code", "fake-register-code-value");
        return {
          status: "register_code_issued",
          ticket: "fake-register-code-id",
          callbackUrl,
          redirectUrl: redirectUrl.toString(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          registrationCode: "fake-register-code-value",
          registration: {
            region: "ap-guangzhou",
            registerCodeId: "fake-register-code-id",
            registerCodeValue: "fake-register-code-value",
            requestId: "fake-tat-request-id",
          },
        };
      },
      async createTencentCloudRedirect(targetPath = "/developer/security/cancel") {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        if (!session) {
          throw new Error("未登录或登录已失效。");
        }
        const redirectUrl = new URL("https://cloud.tencent.com/login/saas/jumpLoginByCode");
        redirectUrl.searchParams.set("code", "fake.auth-code");
        redirectUrl.searchParams.set("platform", "Lightclaw");
        redirectUrl.searchParams.set("s_url", `https://console.cloud.tencent.com${targetPath}`);
        return {
          redirectUrl: redirectUrl.toString(),
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        };
      },
      async listPaymentMethods() {
        await wait(NETWORK_DELAY_MS / 2);
        return { total: paymentMethods.length, items: paymentMethods };
      },
      async createPaymentMethodSignOrder(languageCode) {
        await wait(NETWORK_DELAY_MS / 2);
        const redirectUrl = new URL("https://sandbox-card.centauriglobal.com/sign/fake-contract");
        redirectUrl.searchParams.set("language_code", languageCode);
        return {
          contractCode: "fake-contract",
          redirectUrl: redirectUrl.toString(),
        };
      },
      async setDefaultPaymentMethod(contractCode) {
        await wait(NETWORK_DELAY_MS / 2);
        paymentMethods = paymentMethods.map((method) => ({
          ...method,
          isDefault: method.contractCode === contractCode,
        }));
      },
      async deletePaymentMethod(contractCode) {
        await wait(NETWORK_DELAY_MS / 2);
        paymentMethods = paymentMethods.filter((method) => method.contractCode !== contractCode);
      },
      async getFederationAuthorizationContext(input) {
        await wait(NETWORK_DELAY_MS / 2);
        const session = readStoredAuthSession();
        return {
          ...input,
          clientDisplayName: "Personal Site",
          currentSession: session ? {
            user: {
              id: session.user.id,
              name: session.user.name,
              email: session.user.email,
              phone: session.user.phone,
              avatarUrl: session.user.avatarUrl,
            },
          } : null,
        };
      },
      async issueFederationTicket(input) {
        await wait(NETWORK_DELAY_MS / 2);
        if (!readStoredAuthSession()) {
          throw new Error("未登录或登录已失效。");
        }
        const redirectUrl = new URL(input.redirectUri);
        redirectUrl.searchParams.set("ticket", "fake-federation-ticket");
        if (input.state) {
          redirectUrl.searchParams.set("state", input.state);
        }
        return {
          redirectUrl: redirectUrl.toString(),
          expiresAt: new Date(Date.now() + 5_000).toISOString(),
        };
      },
      async getOIDCAuthorizationContext(input) {
        await wait(NETWORK_DELAY_MS / 2);
        const session = readStoredAuthSession();
        return {
          ...input,
          clientDisplayName: "LightVela Sites",
          currentSession: session ? {
            user: {
              id: session.user.id,
              name: session.user.name,
              email: session.user.email,
              phone: session.user.phone,
              avatarUrl: session.user.avatarUrl,
            },
          } : null,
        };
      },
      async authorizeOIDC(input) {
        await wait(NETWORK_DELAY_MS / 2);
        if (!readStoredAuthSession()) {
          throw new Error("未登录或登录已失效。");
        }
        const redirectUrl = new URL(input.redirectUri);
        redirectUrl.searchParams.set("code", "fake-oidc-code");
        if (input.state) {
          redirectUrl.searchParams.set("state", input.state);
        }
        return {
          redirectUrl: redirectUrl.toString(),
          expiresAt: new Date(Date.now() + 5_000).toISOString(),
        };
      },
      async prepareFederationSwitch() {
        await wait(NETWORK_DELAY_MS / 2);
      },
      async cancelFederationSwitch() {
        await wait(NETWORK_DELAY_MS / 2);
      },
      getOAuthStartUrl(provider: OAuthProvider, options) {
        return fakeOAuthStartURL(provider, options?.wechatMode, options?.switchAccount, options?.returnTo);
      },
      async signInAsGuest() {
        await wait(NETWORK_DELAY_MS);
        const guest = mockUser({ name: "游客体验者" });
        const session = toSessionSnapshot(guest);
        writeStoredAuthSession(session);
        return session;
      },
      async signOut() {
        await wait(NETWORK_DELAY_MS / 2);
        writeStoredAuthSession(null);
      },
    },
    plans: {
      async listModifyBundles(passId) {
        const pass = readStoredPasses().find(item => item.pass_id === passId);
        return { source_bundle_id: pass?.bundle_id ?? '', modify_bundle_set: [] };
      },
      async createModifyOrder() { throw new Error('Upgrade checkout requires a connected billing service'); },
      async getModifyCheckout() { return { checkout: null }; },
      async getModifyOrderUrl() { throw new Error('Upgrade checkout requires a connected billing service'); },
      async refreshModifyPaymentAuthorization() { throw new Error('Upgrade checkout requires a connected billing service'); },
      async getOrderStatus() { throw new Error('Order status requires a connected billing service'); },
      async getCurrentSubscription() {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        return session?.currentSubscription ?? null;
      },
      async getPlanPreview() {
        await wait(NETWORK_DELAY_MS);
        const session = readStoredAuthSession();
        return {
          currentCandidate: session?.currentSubscription?.tier ?? "free",
          plans: planCatalog,
          confirmationNeeded: session?.currentSubscription?.status !== "active",
        };
      },
      async updateSubscription(tier) {
        await wait(NETWORK_DELAY_MS);
        const currentSubscription: CurrentSubscription = {
          tier,
          code: tier === "plus" ? "lite" : tier === "max" ? "pro" : "free",
          status: "active" as const,
          currentPeriodStart: nowIso(),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        const session = readStoredAuthSession();
        if (session) {
          writeStoredAuthSession({
            ...session,
            currentSubscription,
          });
        }
        return currentSubscription;
      },
      async listBundles(_query) {
        await wait(NETWORK_DELAY_MS);
        // mock 不区分是否传 query；实际后端会根据 query 返回不同价格
        return FAKE_BUNDLES.filter((b) => b.bundle_state === "ONLINE");
      },
      async createPass(bundleId) {
        await wait(NETWORK_DELAY_MS);
        const bundle = FAKE_BUNDLES.find((b) => b.bundle_id === bundleId);
        if (!bundle) {
          throw new Error("套餐已下架");
        }
        const existing = readStoredPasses();
        if (existing.some((p) => !p.deleted_time && new Date(p.expired_time).getTime() > Date.now())) {
          const err = new Error("您已拥有权益，无需重复购买") as Error & { code?: string };
          err.code = "PASS_ALREADY_EXISTS";
          throw err;
        }
        const session = readStoredAuthSession();
        const nowString = nowIso();
        const pass: Pass = {
          pass_id: `pass-fake-${Date.now().toString(36)}`,
          user_id: session?.user.id ?? "usr_fake",
          bundle_id: bundle.bundle_id,
          bundle_name: bundle.bundle_name,
          uin: 0,
          app_id: 0,
          created_time: nowString,
          expired_time: computeExpiredIso(bundle),
          isolated_time: null,
          deleted_time: null,
          updated_time: nowString,
          agent_quota_total: bundle.agent_quota,
          agent_quota_available: bundle.agent_quota,
          credit_total: bundle.credit,
          credit_available: bundle.credit,
        };
        writeStoredPasses([...existing, pass]);
        return pass;
      },
      async getCreatePrerequisites() {
        await wait(NETWORK_DELAY_MS);
        return {
          site_kind: "cn",
          shadow_account_enabled: false,
          shadow_bound: false,
        };
      },
      async sendShadowBindingSms(_input) {
        await wait(NETWORK_DELAY_MS);
      },
      async verifyShadowBindingPhone(_input) {
        await wait(NETWORK_DELAY_MS);
      },
      async createPassOrder(input): Promise<CreatePassOrderResult> {
        // mock 代替联调文档 §2.1（v1.7.31 + CodeBuddy AuthCode）：伪造 deal_names 与 auth_code。
        await wait(NETWORK_DELAY_MS);
        const bundle = FAKE_BUNDLES.find((b) => b.bundle_id === input.bundle_id);
        if (!bundle) {
          const err = new Error("套餐已下架") as Error & { code?: string };
          err.code = "BUNDLE_NOT_FOUND";
          throw err;
        }
        const existing = readStoredPasses();
        if (existing.some((p) => !p.deleted_time && new Date(p.expired_time).getTime() > Date.now())) {
          const err = new Error("您已有有效套餐，无法重复购买") as Error & { code?: string };
          err.code = "PASS_ALREADY_EXISTS";
          throw err;
        }
        const dealName = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // CodeBuddy 同款一次性 auth_code，mock 下是随机 UUID；实际后端由
        // POST /billing/saas/generate-authcode 或在下单接口内部生成
        const authCode = `mock-ac-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
        return { deal_names: [dealName], auth_code: authCode };
      },
      async getPassOrderUrl(input, _init): Promise<CreatePassOrderUrlResult> {
        // mock 代替联调文档 §2.2（v1.7.31 + CodeBuddy AuthCode）：
        //   PC 端：    input 只带 deal_names + platform: "pc"
        //   中转页：   input 额外带 wx_code + auth_code（二选一）或 wx_open_id
        // _init.headers 在 fake 模式下不需验证
        await wait(NETWORK_DELAY_MS);
        const dealName = input.deal_names[0] ?? `mock-${Date.now()}`;
        const tokenId = `E-${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        return {
          deal_name: dealName,
          // mock pay_url 指向 about:blank，联调时会被真实后端返回的 jifei 收银台 URL 覆盖
          pay_url: `about:blank#mock-pay-${dealName}`,
          token_id: tokenId,
          order_id: `${Date.now()}${Math.floor(Math.random() * 100000)}`,
          midas_app_id: "1450008583",
          need_charge: 1,
          uin: "700000164995",
          app_id: "251202221",
        };
      },
      async createPassOrderAndPay(input): Promise<CreatePassOrderAndPayResult> {
        // mock 代替联调文档 §2.2：一体化下单+支付，不返 pay_url
        await wait(NETWORK_DELAY_MS);
        const bundle = FAKE_BUNDLES.find((b) => b.bundle_id === input.bundle_id);
        if (!bundle) {
          const err = new Error("套餐已下架") as Error & { code?: string };
          err.code = "BUNDLE_NOT_FOUND";
          throw err;
        }
        return {
          deal_name: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          big_order_id: `${Date.now()}`,
        };
      },
      async createDianshiPassOrderAndPay(input): Promise<CreateDianshiPassOrderAndPayResult> {
        await wait(NETWORK_DELAY_MS);
        const bundle = FAKE_BUNDLES.find((b) => b.bundle_id === input.bundle_id);
        if (!bundle) {
          const err = new Error("套餐已下架") as Error & { code?: string };
          err.code = "BUNDLE_NOT_FOUND";
          throw err;
        }
        return {
          deal_name: `mock-dianshi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          big_order_id: `${Date.now()}`,
        };
      },
      async getRenewPrice(passId, input): Promise<PassRenewPrice> {
        // mock 代替联调文档 §3.1：返回分为单位的价格
        await wait(NETWORK_DELAY_MS);
        const passes = readStoredPasses();
        const pass = passes.find((p) => p.pass_id === passId);
        if (!pass) {
          const err = new Error("pass not owned by user") as Error & { code?: string };
          err.code = "PASS_NOT_FOUND";
          throw err;
        }
        const bundle = FAKE_BUNDLES.find((b) => b.bundle_id === pass.bundle_id);
        // bundle.price.real_total_cost 已是分，直接乘有效期倍数即可
        const baseCents = bundle?.price?.real_total_cost ?? 0;
        const cents = Math.round(baseCents * input.period);
        return {
          bundle_id: pass.bundle_id,
          price: cents,
          total_cost: cents,
          real_total_cost: cents,
          currency: "CNY",
          discount: 100,
        };
      },
      async createRenewOrder(passId, _input): Promise<CreatePassOrderResult> {
        // mock 代替联调文档 §3.2（v1.7.31 + CodeBuddy AuthCode）：续费下单同时生成 auth_code
        await wait(NETWORK_DELAY_MS);
        const passes = readStoredPasses();
        if (!passes.some((p) => p.pass_id === passId)) {
          const err = new Error("pass not owned by user") as Error & { code?: string };
          err.code = "PASS_NOT_FOUND";
          throw err;
        }
        const dealName = `mock-renew-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const authCode = `mock-ac-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
        return { deal_names: [dealName], auth_code: authCode };
      },
      async getRenewOrderUrl(passId, input, _init): Promise<CreatePassOrderUrlResult> {
        // mock 代替联调文档 §3.3（v1.7.31 新增）：拿完整支付信息
        await wait(NETWORK_DELAY_MS);
        const passes = readStoredPasses();
        if (!passes.some((p) => p.pass_id === passId)) {
          const err = new Error("pass not owned by user") as Error & { code?: string };
          err.code = "PASS_NOT_FOUND";
          throw err;
        }
        const dealName = input.deal_names[0] ?? `mock-renew-${Date.now()}`;
        const tokenId = `E-${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
        return {
          deal_name: dealName,
          pay_url: `about:blank#mock-pay-${dealName}`,
          token_id: tokenId,
          order_id: `${Date.now()}${Math.floor(Math.random() * 100000)}`,
          midas_app_id: "1450008583",
          need_charge: 1,
          uin: "700000164995",
          app_id: "251202221",
        };
      },
      async createRenewOrderAndPay(passId, _input): Promise<CreatePassOrderAndPayResult> {
        // mock 代替联调文档 §3.3：续费下单+支付（仅联调）
        await wait(NETWORK_DELAY_MS);
        const passes = readStoredPasses();
        if (!passes.some((p) => p.pass_id === passId)) {
          const err = new Error("pass not owned by user") as Error & { code?: string };
          err.code = "PASS_NOT_FOUND";
          throw err;
        }
        return {
          deal_name: `mock-renew-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          big_order_id: `${Date.now()}`,
        };
      },
      async deletePass(passId): Promise<DeletePassResult> {
        // mock 代替联调文档 §4.1：销毁 pass
        await wait(NETWORK_DELAY_MS);
        const passes = readStoredPasses();
        const target = passes.find((p) => p.pass_id === passId);
        if (!target) {
          const err = new Error("pass not found") as Error & { code?: string };
          err.code = "PASS_NOT_FOUND";
          throw err;
        }
        if (!target.isolated_time) {
          const err = new Error("pass not isolated") as Error & { code?: string };
          err.code = "PASS_NOT_ISOLATED";
          throw err;
        }
        // mock 同步将 pass 从存储中移除（真实后端是异步任务，需轮询）
        writeStoredPasses(passes.filter((p) => p.pass_id !== passId));
        return { deleted: true };
      },
      async listMyPasses() {
        await wait(NETWORK_DELAY_MS);
        return readStoredPasses();
      },
    },
    bots: createBotRepository(),
  };
};

const createBotRepository = (): BotRepository => {
  const fakeConnectedChannels = new Set<string>();
  const fakeConfiguredDshProviders = new Set<string>();
  let fakeDshInstalled = false;
  let fakeDshInstallationPollCount = 0;
  let fakeDshTaskId = "";
  const fakeDshInstallationSteps = [
    { stage: "preflight", progress: 10, message: "正在检查实例环境" },
    { stage: "resolve_latest", progress: 20, message: "正在获取最新版本" },
    { stage: "snapshot_resolved", progress: 28, message: "已锁定安装版本" },
    { stage: "runtime_lockfile", progress: 35, message: "正在生成 DSH 依赖锁" },
    { stage: "runtime_install", progress: 48, message: "正在安装 DSH 运行环境" },
    { stage: "profile_lockfile", progress: 56, message: "正在生成插件依赖锁" },
    { stage: "profile_install", progress: 68, message: "正在安装 SkillHub 与渠道插件" },
    { stage: "validate_candidate", progress: 75, message: "正在检查安装内容" },
    { stage: "activate", progress: 85, message: "正在切换运行环境" },
    { stage: "health_check", progress: 95, message: "正在检查运行状态" },
    { stage: "cleanup", progress: 99, message: "正在清理旧运行环境" },
    { stage: "completed", progress: 100, message: "DeepSeek Harness 安装完成" },
  ] as const;

  const fakeDshProviders = {
    cn: ["deepseek", "minimax-cn", "moonshotai-cn", "qwen-token-plan-cn", "openrouter"],
    global: ["deepseek", "minimax", "minimax-cn", "moonshotai", "moonshotai-cn", "openrouter", "anthropic", "groq", "openai"],
  } as const;
  const fakeDshProviderNames: Record<string, string> = {
    deepseek: "DeepSeek",
    minimax: "MiniMax",
    "minimax-cn": "MiniMax CN",
    moonshotai: "Moonshot AI",
    "moonshotai-cn": "Moonshot AI CN",
    "qwen-token-plan-cn": "Qwen Token Plan CN",
    openrouter: "OpenRouter",
    anthropic: "Anthropic",
    groq: "Groq",
    openai: "OpenAI",
  };
  const fakeDshSecretTransportPublicKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlfPhpfKnEnuYvdgdhoS//1lLcu4FH8xtRFSAhF6JJO27KYZI6UfhC09cdp+cKq5AyLxONpY6XWg8ozZptWu5xHDZQ9zjT2HPB20Alvb/ekO46RFL9tq7u7QlG6IRDGSRzFPboOH2VxmzpqPmuLs3jnBuUidatqjmKSmkP3tWgp/ztQR2MaNi/M07yqEBHuHFKsaSBn5yE1k18+6ER5J9GR0jJFF+QpvF/mnNKoSFkELvcy6C89nYTVMBMh+NbNLkVu7fTpbmu7JegAEMm1GSFgRcuF2uYADaRxJX8b4un7qRh6fISNECU0p7LwDvllUp6Nox7mYTEW74qTiusFwgLQIDAQAB";

  const fakeChannelStatusOutput = () => JSON.stringify({
    success: true,
    data: {
      platforms: Array.from(fakeConnectedChannels).map((name) => ({
        name,
        status: "connected",
      })),
    },
    error: null,
  });

  const maybeApplyFakeChannelCommand = (command: string) => {
    if (command.includes("strip_slack_env") && command.includes("SLACK_BOT_TOKEN")) {
      fakeConnectedChannels.delete("slack");
      return;
    }

    if (command.includes("SLACK_BOT_TOKEN") && command.includes("SLACK_APP_TOKEN")) {
      fakeConnectedChannels.add("slack");
    }
  };

  const maybeHandleFakeDshCommand = (command: string) => {
    if (command.includes("sudo -n systemctl status deepseek-harness.service --no-pager")) {
      return {
        status: "Succeeded",
        exitCode: 0,
        output: JSON.stringify(fakeDshInstalled
          ? { installed: true, status: "running", service_status: "active", healthy: true }
          : { installed: false, status: "not-installed", service_status: "inactive", healthy: false }),
      };
    }

    if (command.includes("systemd-run") && command.includes("install-deepseek-harness.sh")) {
      fakeDshTaskId = command.match(/--unit=lightvela-dsh-install-(dshi-[0-9a-f]{32})/)?.[1] ?? "";
      fakeDshInstallationPollCount = 0;
      return { status: "Succeeded", exitCode: 0, output: "" };
    }

    if (command.includes("sudo -n cat /var/lib/lightvela/dsh/installations/")) {
      fakeDshInstallationPollCount += 1;
      const stepIndex = Math.min(
        Math.floor((fakeDshInstallationPollCount - 1) / 2),
        fakeDshInstallationSteps.length - 1,
      );
      const step = fakeDshInstallationSteps[stepIndex]!;
      const completed = step.stage === "completed";
      if (completed) fakeDshInstalled = true;
      return {
        status: "Succeeded",
        exitCode: 0,
        output: JSON.stringify({
          task_id: fakeDshTaskId,
          status: completed ? "succeeded" : "running",
          stage: step.stage,
          progress: step.progress,
          message: step.message,
          updated_at: nowIso(),
        }),
      };
    }

    if (command.includes("sudo -n systemctl restart deepseek-harness.service")) {
      return { status: "Succeeded", exitCode: fakeDshInstalled ? 0 : 1, output: "" };
    }

    if (command.includes("openssl genpkey") && command.includes(".lightvela-secret-transport")) {
      return { status: "Succeeded", exitCode: 0, output: fakeDshSecretTransportPublicKey };
    }

    const region = command.match(/providers --region (cn|global)/)?.[1] as "cn" | "global" | undefined;
    if (region) {
      return {
        status: "Succeeded",
        exitCode: 0,
        output: JSON.stringify({
          providers: fakeDshProviders[region].map((id) => ({
            id,
            displayName: fakeDshProviderNames[id],
            configured: fakeConfiguredDshProviders.has(id),
            active: id === "deepseek",
            writable: true,
          })),
        }),
      };
    }

    const provider = command.match(/configure --provider ([a-z0-9-]+)/)?.[1];
    if (provider) {
      fakeConfiguredDshProviders.add(provider);
      return { status: "Succeeded", exitCode: 0, output: "" };
    }

    const removedProvider = command.match(/remove-provider --provider ([a-z0-9-]+)/)?.[1];
    if (removedProvider) {
      fakeConfiguredDshProviders.delete(removedProvider);
      return {
        status: "Succeeded",
        exitCode: 0,
        output: JSON.stringify({ ok: true, provider: removedProvider, configured: false }),
      };
    }

    return null;
  };

  return {
    async getDashboardSnapshot(mode = "live") {
      await assertMode(mode);
      ensureLocalPreviewBot();

      if (mode === "empty") {
        return {
          runtime: null,
          alerts: [],
          bots: [],
          deployments: [],
          releases: [],
          billing: {
            ...baseBilling,
            tokenSpend: 0,
            runMinutes: 0,
            estimatedMonthEnd: 0,
          },
        } satisfies DashboardSnapshot;
      }

      const bots = [...botStore.values()];
      const primaryBot = bots[0] ?? null;

      if (!primaryBot) {
        return {
          runtime: null,
          alerts: [],
          bots: [],
          deployments: [],
          releases: [],
          billing: {
            ...baseBilling,
            tokenSpend: 0,
            runMinutes: 0,
            estimatedMonthEnd: 0,
          },
        } satisfies DashboardSnapshot;
      }

      return {
        runtime: runtimeFor(primaryBot.id),
        alerts: [
          {
            id: "alert_1",
            title: "延迟短时波动",
            severity: "warning",
            message: "最近 5 分钟 p95 延迟超过 700ms。",
            createdAt: nowIso(),
            resolved: false,
          },
          {
            id: "alert_2",
            title: "知识库同步恢复",
            severity: "info",
            message: "外部数据源已恢复增量同步。",
            createdAt: nowIso(),
            resolved: true,
          },
        ],
        bots,
        deployments: bots.map((bot) => ({
          id: `dep_${bot.id}`,
          botId: bot.id,
          environment: "production",
          region: "ap-southeast-1",
          status: "running",
          updatedAt: nowIso(),
        })),
        releases: versionsFor(primaryBot.id),
        billing: baseBilling,
      };
    },

    async createBot(input) {
      await wait(NETWORK_DELAY_MS);
      const suffix = Math.random().toString(36).slice(2, 8);
      const bot: Bot = {
        id: `bot_${suffix}`,
        instanceId: LOCAL_PREVIEW_BOT_ID,
        profileId: `profile_${suffix}`,
        isDefault: false,
        description: input?.description,
        createdFrom: input?.createMode ?? "blank",
        sourceBotId: input?.sourceBotId,
        name: input?.name ?? "Hermes 新助手",
        type: "support",
        template: "通用对话模板",
        mission: "提升用户咨询响应效率",
        scenario: "ToC 消费者服务",
        createdAt: nowIso(),
        status: "active",
      };

      botStore.set(bot.id, bot);
      seedMessagesFor(bot.id);
      return bot;
    },

    async destroyBot(botId) {
      await wait(NETWORK_DELAY_MS);
      botStore.delete(botId);
      messageStore.delete(botId);
    },

    async retryBot(botId) {
      await wait(NETWORK_DELAY_MS);
      const bot = botStore.get(botId);
      if (!bot) return null;
      const updated = { ...bot, status: "active" as const };
      botStore.set(botId, updated);
      return updated;
    },

    async renameBot(botId, name) {
      await wait(NETWORK_DELAY_MS);
      const bot = botStore.get(botId);
      if (!bot) throw new Error("Bot not found");
      const updated = { ...bot, name };
      botStore.set(botId, updated);
      return updated;
    },

    async updateBotProfile(botId, patch) {
      await wait(NETWORK_DELAY_MS);
      const existing = botStore.get(botId);
      if (!existing) {
        throw new Error("Bot 不存在，请先在仪表盘创建。");
      }

      const next: Bot = {
        ...existing,
        ...patch,
      };

      botStore.set(botId, next);
      return next;
    },

    async getWorkspaceSnapshot(botId, mode = "live") {
      await assertMode(mode);
      const bot = botStore.get(botId);

      if (!bot) {
        throw new Error("请先在仪表盘创建第一个 Bot。");
      }

      if (mode === "empty") {
        return {
          bot,
          runtime: null,
          messages: [],
          quickActions: [],
        } satisfies WorkspaceSnapshot;
      }

      seedMessagesFor(bot.id);
      const messages = messageStore.get(bot.id) ?? [];
      return {
        bot,
        runtime: runtimeFor(bot.id),
        messages,
        quickActions: ["回归测试", "高并发模拟", "发布前检查"],
      };
    },

    async sendWorkspaceMessage(botId, text) {
      await wait(NETWORK_DELAY_MS);
      const bot = botStore.get(botId);
      if (!bot) {
        throw new Error("Bot 不存在，请先创建。");
      }
      const existing = messageStore.get(bot.id) ?? [];
      const next: WorkspaceMessage[] = [
        ...existing,
        {
          id: `msg_${Date.now()}_user`,
          role: "user",
          text,
          createdAt: nowIso(),
        },
        {
          id: `msg_${Date.now()}_assistant`,
          role: "assistant",
          text: "已收到你的测试请求。原型环境已记录本次运行轨迹。",
          createdAt: nowIso(),
        },
      ];
      messageStore.set(bot.id, next);
      return next;
    },

    async getSettingsSnapshot(botId, mode = "live") {
      await assertMode(mode);
      const bot = botStore.get(botId) ?? (botId === LOCAL_PREVIEW_BOT_ID ? ensureLocalPreviewBot() : null);

      if (!bot) {
        throw new Error("请先在仪表盘创建 Bot，再进入设置中心。");
      }

      if (mode === "empty") {
        return {
          bot,
          versions: [],
          tools: [],
          knowledge: [],
          auditEvents: [],
          billing: {
            ...baseBilling,
            tokenSpend: 0,
            runMinutes: 0,
            estimatedMonthEnd: 0,
          },
        } satisfies SettingsSnapshot;
      }

      return {
        bot,
        versions: versionsFor(bot.id),
        tools: defaultTools,
        knowledge: [
          {
            id: "ks_1",
            name: "客服知识库",
            type: "docs",
            status: "ready",
            updatedAt: nowIso(),
          },
          {
            id: "ks_2",
            name: "订单数据库",
            type: "sql",
            status: "syncing",
            updatedAt: nowIso(),
          },
        ],
        auditEvents: [
          {
            id: "audit_1",
            actor: "ops@lightclaw.ai",
            action: "更新",
            target: "Model temperature",
            timestamp: nowIso(),
            detail: "参数从 0.5 调整为 0.4",
          },
          {
            id: "audit_2",
            actor: "ml@lightclaw.ai",
            action: "回滚",
            target: "Prompt bundle",
            timestamp: new Date(Date.now() - 3_600_000).toISOString(),
            detail: "因回归异常恢复到 v1.17",
          },
        ],
        billing: baseBilling,
      } satisfies SettingsSnapshot;
    },

    async getTerminalSession(botId) {
      await wait(NETWORK_DELAY_MS / 2);
      const bot = botStore.get(botId);
      if (!bot) {
        throw new Error("Bot 不存在，请先创建。");
      }

      return {
        sandboxId: `sb_${bot.id}`,
        poolId: "pool-demo",
        sessionId: `session_${bot.id}`,
        region: "ap-beijing",
        instanceId: `ins_${bot.id}`,
        ownerUin: "10001",
        loginUin: "10002",
        appId: 12345,
        wsUrl: "wss://example.invalid/ws",
        cols: 120,
        rows: 32,
        timeoutSeconds: 3600,
        username: "agentuser",
        workingDirectory: "/home/agentuser",
      };
    },

    async configureQQChannel(botId, input) {
      await wait(NETWORK_DELAY_MS);
      const bot = botStore.get(botId);
      if (!bot) {
        throw new Error("Bot 不存在，请先创建。");
      }
      if (!input.appId.trim() || !input.appSecret.trim()) {
        throw new Error("请先填写 QQ App ID 和 App Secret。");
      }

      return {
        status: "Succeeded",
        channel: "qqbot",
        gatewayRestarted: true,
        output: `configured ${botId} with ${input.appId.trim()}:***`,
      } satisfies BotChannelConfigResult;
    },

    async createWeixinLoginSession(botId) {
      await wait(NETWORK_DELAY_MS);
      const bot = botStore.get(botId);
      if (!bot) {
        throw new Error("Bot 不存在，请先创建。");
      }
      return { sessionId: `wxlogin_fake_${Date.now()}`, status: "starting" };
    },

    async claimUniqueChannel() {},

    async confirmUniqueChannel() {},

    async releaseUniqueChannel() {},

    async getWeixinLoginSession(_botId, sessionId) {
      await wait(NETWORK_DELAY_MS);
      return {
        session_id: sessionId,
        status: "waiting_qr",
        qr_url: "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=https://lightclaw.ai/wechat-fake",
      };
    },

    async cancelWeixinLoginSession(_botId, sessionId) {
      await wait(NETWORK_DELAY_MS);
      return { session_id: sessionId, status: "cancelled" };
    },

    async *subscribeWeixinLoginSessionEvents(_botId, _sessionId, _signal) {
      // fake implementation: emit snapshot then finished
      await wait(500);
      yield {
        event: "snapshot",
        data: {
          session_id: _sessionId,
          status: "waiting_qr",
          qr_url: "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=https://lightclaw.ai/wechat-fake",
        },
      };
    },

    async listSoulTemplates() {
      await wait(NETWORK_DELAY_MS);
      return [
        { id: "gentle", name: "温柔陪伴", description: "温暖细腻，善于倾听与安慰" },
        { id: "humor", name: "幽默风趣", description: "轻松搞笑，让对话充满欢乐" },
        { id: "pro", name: "专业干练", description: "高效务实，直击问题核心" },
      ];
    },

    async execDebugCommand(_botId, command) {
      const dshResult = maybeHandleFakeDshCommand(command);
      if (dshResult) return dshResult;
      await wait(NETWORK_DELAY_MS);
      if (command === DEBUG_EXEC_OPENCLAW_CONFIG_COMMAND) {
        return {
          status: "Succeeded",
          exitCode: 0,
          output: JSON.stringify({ models: {}, channels: {}, gateway: {} }),
        };
      }
      maybeApplyFakeChannelCommand(command);
      if (command.includes("acli channel status")) {
        return { status: "Succeeded", exitCode: 0, output: fakeChannelStatusOutput() };
      }
      return { status: "Succeeded", exitCode: 0, output: "" };
    },

    async execDebugCommandStream(_botId, command, onChunk) {
      await wait(NETWORK_DELAY_MS);
      maybeApplyFakeChannelCommand(command);
      const result = command === DEBUG_EXEC_OPENCLAW_CONFIG_COMMAND
        ? { status: "Succeeded", exitCode: 0, output: JSON.stringify({ models: {}, channels: {}, gateway: {} }) }
        : command.includes("acli channel status")
          ? { status: "Succeeded", exitCode: 0, output: fakeChannelStatusOutput() }
          : maybeHandleFakeDshCommand(command) ?? { status: "Succeeded", exitCode: 0, output: "" };
      if (result.output) onChunk({ stream: DEBUG_EXEC_STDOUT_STREAM, chunk: result.output });
      return result;
    },

    async startRescueExport(botId) {
      await wait(NETWORK_DELAY_MS);
      const bot = botStore.get(botId);
      if (!bot) {
        throw new Error("Bot 不存在，请先创建。");
      }
      const actionRunId = `worker-action-${bot.id}-rescue_export`;
      return {
        actionRunId,
        workflowId: actionRunId,
        runId: `run_${Date.now()}`,
        action: "rescue_export",
        botId: bot.id,
        status: "accepted",
      };
    },

    async getRescueExportStatus(botId) {
      await wait(NETWORK_DELAY_MS);
      const bot = botStore.get(botId);
      if (!bot) {
        throw new Error("Bot 不存在，请先创建。");
      }
      return {
        workflowId: `worker-action-${bot.id}-rescue_export`,
        runId: "run_fake",
        phase: "completed",
        logs: [
          { time: new Date(Date.now() - 90000).toISOString(), phase: "locating", message: "正在定位 Agent 运行环境。", level: "info" },
          { time: new Date(Date.now() - 45000).toISOString(), phase: "copy_archive", message: "正在上传导出包。", level: "info" },
          { time: new Date().toISOString(), phase: "completed", message: "导出完成，结果已发送到绑定邮箱。", level: "success" },
        ],
      };
    },

    async importHermesWorkspace(botId, file) {
      await wait(NETWORK_DELAY_MS);
      const bot = botStore.get(botId);
      if (!bot) {
        throw new Error("Bot 不存在，请先创建。");
      }
      if (!file.name.toLowerCase().endsWith(".zip")) {
        throw new Error("请选择 Hermes 导出的 zip 文件。");
      }
      const actionRunId = `worker-action-${bot.id}-hermes_import`;
      return {
        actionRunId,
        workflowId: actionRunId,
        runId: `run_${Date.now()}`,
        action: "hermes_import",
        botId: bot.id,
        status: "accepted",
      };
    },

    async getHermesImportStatus(botId) {
      await wait(NETWORK_DELAY_MS);
      const bot = botStore.get(botId);
      if (!bot) {
        throw new Error("Bot 不存在，请先创建。");
      }
      return {
        workflowId: `worker-action-${bot.id}-hermes_import`,
        runId: "run_fake",
        phase: "completed",
        logs: [
          { time: new Date(Date.now() - 90000).toISOString(), phase: "locating", message: "正在定位 Agent 运行环境。", level: "info" },
          { time: new Date(Date.now() - 45000).toISOString(), phase: "wait_tat", message: "导入命令执行中。", level: "info" },
          { time: new Date().toISOString(), phase: "completed", message: "导入完成，结果已发送到绑定邮箱。", level: "success" },
        ],
      };
    },

    async resetInstanceConfig(_botId) {
      await wait(NETWORK_DELAY_MS);
      const fakeKey = `sk-fake-${Math.random().toString(36).slice(2, 10)}`;
      return {
        keyId: `key-fake-${Math.random().toString(36).slice(2, 10)}`,
        keyPrefix: fakeKey.slice(0, 6),
        config: {
          providerName: FAKE_RESET_PROVIDER_NAME,
          baseUrl: FAKE_RESET_BASE_URL,
          modelId: FAKE_RESET_MODEL_ID,
          api: FAKE_RESET_API,
          apiKey: fakeKey,
        },
      };
    },
  };
};
