import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenClawBot } from "@/contexts/agent-context";
import type { User } from "@/domain/types";
import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";
import { AgentSettingsPage } from "@/pages/marketing/agent-settings-page";

/*
 * 订阅成功后命名向导（issue #73 方案 B）：
 * subscribe-page 支付成功后不再写死默认名自动建 Bot，而是跳到 /agents?create=1，
 * 控制台在订阅态就绪且账号还没有 Bot 时自动打开与「新建 Bot」一致的命名弹窗，
 * 让首次订阅与删除后重建走同一条命名流程。这里覆盖该消费逻辑。
 */

const addBot = vi.fn();
const navigateMock = vi.fn();
const testRegion = vi.hoisted(() => ({ isCN: true, isGlobal: false }));

let currentSessionUser: User;
let bots: OpenClawBot[] = [];
let isSubscribed = true;
let botsLoading = false;

vi.mock("@/i18n/t", () => ({
  t: (text: string) => text,
  useT: () => (text: string) => text,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "zh-CN", resolvedLanguage: "zh-CN" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("@/lib/region", () => ({
  DEFAULT_LOCALE: "zh-CN",
  get isCN() { return testRegion.isCN; },
  get isGlobal() { return testRegion.isGlobal; },
  readLocaleFromPath: () => null,
}));

vi.mock("@/contexts/runtime-config-context", () => ({
  usePaidBillingEnabled: () => false,
  useMultiBotEnabled: () => true,
  useRealnamePhoneVerificationEnabled: () => false,
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    session: { user: currentSessionUser, currentSubscription: null },
    isAuthenticated: true,
    authReady: true,
    refreshProfile: vi.fn(),
  }),
}));

vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => ({
    bots,
    botsLoading,
    deleteBot: vi.fn(),
    user: {
      email: "user@example.com",
      plan: { name: "启航套餐", tier: "plus", trialDays: 7, aiCredits: 1000, usedCredits: 0, totalRequests: 0, maxBots: 5 },
    },
    refreshBots: vi.fn(),
    refreshPasses: vi.fn(),
    isSubscribed,
    passesLoading: false,
    passesError: false,
    addBot,
    activePass: null,
  }),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    bots: { execDebugCommand: vi.fn(), getRescueExportStatus: vi.fn().mockResolvedValue(null), getHermesImportStatus: vi.fn().mockResolvedValue(null), startRescueExport: vi.fn(), resetInstanceConfig: vi.fn() },
    plans: { getRenewPrice: vi.fn(), createRenewOrder: vi.fn(), listMyPasses: vi.fn() },
  }),
}));

vi.mock("@/components/site/product-chrome", () => ({
  ProductFooter: () => null,
  ProductReturnHomeHeader: () => null,
}));

vi.mock("@/pages/marketing/agent-skills-panel", () => ({
  HermesAgentSkillsPanel: () => <div>Skills panel</div>,
}));

vi.mock("@/pages/marketing/agent-deepseek-harness-panel", () => ({
  AgentDeepSeekHarnessPanel: () => <div>DeepSeek Harness panel</div>,
}));

const buildBot = (): OpenClawBot => ({
  id: "ins-1",
  instanceId: "ins-1",
  profileId: "main",
  isDefault: true,
  name: "Hermes",
  personality: "默认设定",
  personalityEmoji: "H",
  intro: "",
  status: "running",
  createdAt: "2026-08-20T00:00:00.000Z",
  connectedChannels: [],
  installedSkills: [],
});

const createNavigation = (search: string): AppNavigationValue => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  navigate: navigateMock,
  pathname: "/agents",
  search,
  setSearchParams: vi.fn(),
});

const page = (search: string) => (
  <AppNavigationProvider value={createNavigation(search)}>
    <AgentSettingsPage showHeader={false} />
  </AppNavigationProvider>
);

describe("post-subscribe naming intent (/agents?create=1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testRegion.isCN = true;
    testRegion.isGlobal = false;
    isSubscribed = true;
    botsLoading = false;
    bots = [];
    currentSessionUser = {
      id: "usr-test", name: "Agent User", email: "user@example.com",
      inviteRequired: false, realnameVerified: true, realnameLevel: "idcard_2fa",
      createdAt: "2026-08-20T00:00:00.000Z",
    };
    addBot.mockResolvedValue({ ...buildBot(), id: "created", isDefault: false });
  });
  afterEach(cleanup);

  it("auto-opens the naming dialog for a subscribed user without any bot", async () => {
    render(page("?create=1"));

    // 与「新建 Bot」一致的命名弹窗（标题「创建 Bot」+ 名称输入框）应自动出现
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "创建 Bot" })).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText("请输入 Bot 名称")).toBeInTheDocument();
    // 首个创建不自动建 bot（等用户输入名字确认后才建）
    expect(addBot).not.toHaveBeenCalled();
    // 消费一次即清掉 create 参数，避免刷新/取消后重复自动弹出
    expect(navigateMock).toHaveBeenCalledWith("/agents", { replace: true });
  });

  it("does not open the naming dialog when the account already has a bot", async () => {
    bots = [buildBot()];

    render(page("?create=1"));

    // 已有 bot：不再引导命名，直接清掉 create 参数落到正常控制台
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith("/agents", { replace: true });
    });
    expect(screen.queryByRole("heading", { name: "创建 Bot" })).not.toBeInTheDocument();
  });

  it("does not auto-open naming while the subscription state is not ready yet", async () => {
    isSubscribed = false;

    render(page("?create=1"));

    // 订阅态尚未就绪（pass 未同步）时不误弹命名弹窗，也不清参数（等就绪后再消费）
    await Promise.resolve();
    expect(screen.queryByRole("heading", { name: "创建 Bot" })).not.toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalledWith("/agents", { replace: true });
  });
});
