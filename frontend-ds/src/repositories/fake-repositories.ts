import type {
  AuthSessionSnapshot,
  BillingSummary,
  Bot,
  BotChannelConfigResult,
  BotRuntime,
  BotVersion,
  CurrentSubscription,
  InviteCodeValidation,
  ToolBinding,
  User,
  WorkspaceMessage,
} from "@/domain/types";
import { planCatalog } from "@/domain/plan-catalog";
import type {
  BotRepository,
  DashboardSnapshot,
  Repositories,
  SettingsSnapshot,
  WorkspaceSnapshot,
} from "@/repositories/types";

const NETWORK_DELAY_MS = 320;
const FAKE_AUTH_STORAGE_KEY = "lightclaw-fake-auth-v1";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const nowIso = () => new Date().toISOString();

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
    inviteRequired: true,
    createdAt: nowIso(),
  };
};

const toSessionSnapshot = (user: User): AuthSessionSnapshot => ({
  user,
  currentSubscription: null,
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

const revokeBlobAvatarUrl = (avatarUrl?: string) => {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }
  if (avatarUrl?.startsWith("blob:")) {
    URL.revokeObjectURL(avatarUrl);
  }
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
      text: "你好，我是 Lightclaw Bot，随时可以开始一次真实对话演练。",
      createdAt: nowIso(),
    },
  ]);
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

const inviteValidation = (code: string): InviteCodeValidation => {
  if (code.toUpperCase() === "VALID2026") {
    return { code, state: "valid", message: "邀请码有效，可加入 Lightclaw 内测。" };
  }

  if (code.toUpperCase() === "EXPIRED2026") {
    return { code, state: "expired", message: "邀请码已过期，请申请新的邀请码。" };
  }

  if (code.toUpperCase() === "USED2026") {
    return { code, state: "used", message: "邀请码已被使用。" };
  }

  return { code, state: "invalid", message: "邀请码不存在，请检查输入。" };
};

const assertMode = async (mode: "live" | "empty" | "error" = "live") => {
  await wait(NETWORK_DELAY_MS);
  if (mode === "error") {
    throw new Error("服务暂时不可用，请稍后重试。");
  }
};

export const createFakeRepositories = (): Repositories => {
  return {
    auth: {
      async signInWithCode({ phone, code, inviteCode }) {
        await wait(NETWORK_DELAY_MS);
        if (!isValidChinaMainlandPhone(phone)) {
          throw new Error("手机号格式不正确。");
        }
        if (code !== "123456") {
          throw new Error("验证码不正确。");
        }
        if (inviteCode) {
          const validation = inviteValidation(inviteCode);
          if (validation.state !== "valid") {
            throw new Error(validation.message);
          }
        }
        const session = toSessionSnapshot(mockUser({ phone }));
        writeStoredAuthSession(session);
        return session;
      },
      async sendVerificationCode({ phone }) {
        await wait(NETWORK_DELAY_MS);
        if (!isValidChinaMainlandPhone(phone)) {
          throw new Error("手机号格式不正确。");
        }
        return { cooldownSeconds: 60 };
      },
      async prepareInviteCode(code) {
        await wait(NETWORK_DELAY_MS);
        const validation = inviteValidation(code);
        if (validation.state !== "valid") {
          throw new Error(validation.message);
        }
      },
      async activateInviteCode(code) {
        await wait(NETWORK_DELAY_MS);
        const validation = inviteValidation(code);
        if (validation.state !== "valid") {
          throw new Error(validation.message);
        }
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
      async signUpWithCode({ name, phone, code, inviteCode }) {
        await wait(NETWORK_DELAY_MS);
        if (!isValidChinaMainlandPhone(phone)) {
          throw new Error("手机号格式不正确。");
        }
        if (code !== "123456") {
          throw new Error("验证码不正确。");
        }
        if (inviteCode) {
          const validation = inviteValidation(inviteCode);
          if (validation.state !== "valid") {
            throw new Error(validation.message);
          }
        }
        const session = toSessionSnapshot(mockUser({ phone, name }));
        writeStoredAuthSession(session);
        return session;
      },
      async validateInviteCode(code) {
        await wait(NETWORK_DELAY_MS);
        return inviteValidation(code);
      },
      async getSession() {
        await wait(NETWORK_DELAY_MS);
        return readStoredAuthSession();
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
      getOAuthStartUrl() {
        return null;
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
    },
    bots: createBotRepository(),
  };
};

const createBotRepository = (): BotRepository => {
  return {
    async getDashboardSnapshot(mode = "live") {
      await assertMode(mode);

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
      const bot: Bot = {
        id: `bot_${Math.random().toString(36).slice(2, 8)}`,
        name: input?.name ?? "Lightclaw 新助手",
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
      const bot = botStore.get(botId);

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
      };
    },

    async getBotBornCard(botId) {
      await wait(NETWORK_DELAY_MS / 2);
      const bot = botStore.get(botId);
      if (!bot) {
        throw new Error("Bot 不存在，请先创建。");
      }

      const createdDate = new Date(bot.createdAt);
      const bornDateForChina = `${createdDate.getUTCFullYear()}-${String(createdDate.getUTCMonth() + 1).padStart(2, "0")}-${String(createdDate.getUTCDate()).padStart(2, "0")}`;
      let bornNumber = 0;
      for (let i = 0; i < bot.id.length; i++) {
        bornNumber = ((bornNumber << 3) + bornNumber) + bot.id.charCodeAt(i);
      }

      return {
        instanceId: bot.id,
        userId: "usr_mock",
        sandboxId: `sb_${bot.id}`,
        status: bot.status,
        createdAt: bot.createdAt,
        updatedAt: bot.createdAt,
        timeoutAt: undefined,
        bornDateForChina,
        bornNumberForChina: (Math.abs(bornNumber) % 500) + 1,
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
  };
};
