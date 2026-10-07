import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenClawBot } from "@/contexts/agent-context";
import type { Pass, User } from "@/domain/types";
import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";
import { AgentSettingsPage } from "@/pages/marketing/agent-settings-page";

const execDebugCommand = vi.fn();
const refreshProfile = vi.fn();
const listMyPasses = vi.fn().mockResolvedValue([]);
const deleteBot = vi.fn();

let currentSessionUser: User;
let bots: OpenClawBot[] = [];
let activePass: Pass | null = null;

vi.mock("@/i18n/t", () => ({
  // 组件里用它按 locale 格式化日期（Intl），mock 固定成 zh-CN
  useCurrentLocale: () => "zh-CN",
  t: (text: string) => text,
  useT: () => (text: string) => text,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "zh-CN", resolvedLanguage: "zh-CN" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("@/lib/region", () => ({
  DEFAULT_LOCALE: "zh-CN",
  isCN: true,
  isGlobal: false,
  readLocaleFromPath: () => null,
}));

vi.mock("@/contexts/runtime-config-context", () => ({
  useMultiBotEnabled: () => true,
  useCloudDesktopEnabled: () => false,
  usePaidBillingEnabled: () => false,
  useRealnamePhoneVerificationEnabled: () => false,
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    session: {
      user: currentSessionUser,
      currentSubscription: null,
    },
    isAuthenticated: true,
    authReady: true,
    refreshProfile,
  }),
}));

vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => ({
    bots,
    botsLoading: false,
    deleteBot,
    user: {
      plan: {
        name: "启航套餐",
        tier: "plus",
        trialDays: 7,
        aiCredits: 1000,
        usedCredits: 100,
        totalRequests: 0,
        maxBots: 1,
      },
    },
    refreshBots: vi.fn(),
    refreshPasses: vi.fn(),
    isSubscribed: true,
    passesLoading: false,
    passesError: false,
    addBot: vi.fn(),
    activePass,
  }),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    bots: {
      execDebugCommand,
      getRescueExportStatus: vi.fn().mockResolvedValue(null),
      getHermesImportStatus: vi.fn().mockResolvedValue(null),
      startRescueExport: vi.fn(),
      resetInstanceConfig: vi.fn(),
      getSettingsSnapshot: vi.fn().mockImplementation(async (id: string) => ({
        bot: { ...buildBot(), id, status: "active" },
      })),
      getDashboardSnapshot: vi.fn().mockResolvedValue({ bots }),
    },
    plans: {
      getRenewPrice: vi.fn(),
      createRenewOrder: vi.fn(),
      listMyPasses,
    },
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

// 导航测试不加载聊天/通道 SDK，避免动态依赖的浏览器 CSS 干扰 jsdom。
vi.mock("@/pages/marketing/agent-chat-panel", () => ({ AgentChatPanel: () => null }));
vi.mock("@/pages/marketing/agent-channel-panel", () => ({ ChannelPanel: () => null }));

const createNavigation = (): AppNavigationValue => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  navigate: vi.fn(),
  pathname: "/agents/labs/deepseek-harness",
  search: "",
  setSearchParams: vi.fn(),
});

const buildBot = (): OpenClawBot => ({
  id: "bot_dsh_lab",
  instanceId: "bot_dsh_lab",
  profileId: "profile_dsh_lab",
  isDefault: true,
  name: "Hermes Lab",
  personality: "默认设定",
  personalityEmoji: "H",
  intro: "",
  status: "running",
  createdAt: "2026-08-20T00:00:00.000Z",
  connectedChannels: [],
  installedSkills: [],
});

const buildPass = (bundleType?: string): Pass & { bundle_type?: string } => ({
  pass_id: "pass_agent_nav",
  user_id: "usr_dsh_lab",
  bundle_id: "bundle_agent_nav",
  bundle_name: "Agent Nav",
  bundle_type: bundleType,
  created_time: "2026-08-20T00:00:00.000Z",
  expired_time: "2099-08-20T00:00:00.000Z",
  credit_total: 1000,
  credit_available: 900,
});

const renderLabPage = () => render(
  <AppNavigationProvider value={createNavigation()}>
    <AgentSettingsPage sectionId="deepseek-harness" showHeader={false} />
  </AppNavigationProvider>,
);

describe("AgentSettingsPage 实验室导航", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteBot.mockReset();
    deleteBot.mockResolvedValue(undefined);
    delete (window as Window & { show?: unknown }).show;
    currentSessionUser = {
      id: "usr_dsh_lab",
      name: "Agent User",
      email: "user@example.com",
      inviteRequired: false,
      realnameVerified: true,
      realnameLevel: "idcard_2fa",
      createdAt: "2026-08-20T00:00:00.000Z",
    };
    bots = [buildBot()];
    activePass = null;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps account, billing, and cloud storage reachable at the bottom of the mobile drawer", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    renderLabPage();

    await userEvent.click(screen.getByRole("button", { name: "展开导航" }));
    const drawer = screen.getByRole("dialog", { name: "侧边栏视图切换" });
    const footer = drawer.querySelector(".lv-agents-sidebar-footer");
    expect(footer).toBeInTheDocument();
    expect(footer?.previousElementSibling).toHaveClass("lv-agents-sidebar-middle");
    await userEvent.click(within(drawer).getByRole("button", { name: "打开用户菜单" }));

    expect(screen.getByRole("link", { name: "云存储" })).toHaveAttribute("href", "/agents/files");
    expect(screen.getByRole("link", { name: "套餐与费用" })).toHaveAttribute("href", "/account/billing");
    expect(screen.getByRole("link", { name: "账号" })).toHaveAttribute("href", "/account");

    await userEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
    expect(drawer.querySelector(".lv-agent-account-trigger")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "账号管理" })).not.toBeInTheDocument();
  });

  it("将实验室作为独立分组并标记 DeepSeek Harness 当前页", async () => {
    renderLabPage();

    const navigation = await screen.findByRole("navigation", { name: "探索" });
    const growthGroup = within(navigation).getByRole("group", { name: "成长" });
    const manageGroup = within(navigation).getByRole("group", { name: "管理" });
    const labsGroup = within(navigation).getByRole("group", { name: "实验室" });

    expect(labsGroup.parentElement).toBe(growthGroup.parentElement);
    expect(manageGroup.parentElement).toBe(growthGroup.parentElement);
    expect([...navigation.querySelectorAll('[role="group"]')]).toEqual([growthGroup, manageGroup, labsGroup]);
    expect(within(manageGroup).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/agents/models", "/agents/diagnostics", "/agents/settings",
    ]);
    expect(within(growthGroup).queryByText("实验室")).not.toBeInTheDocument();
    expect(within(labsGroup).queryByRole("button", { name: "实验室" })).not.toBeInTheDocument();

    const deepSeekLink = within(labsGroup).getByRole("link", { name: "DeepSeek Harness" });
    expect(deepSeekLink).toHaveAttribute("href", "/agents/labs/deepseek-harness");
    expect(deepSeekLink).toHaveAttribute("aria-current", "page");
    expect(await screen.findByText("DeepSeek Harness panel")).toBeInTheDocument();
  });

  it("直接展示 Agent 顶部的重启和删除图标操作", async () => {
    renderLabPage();

    await screen.findByText("Hermes Lab");
    expect(screen.getByRole("button", { name: "重启" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除整个 Agent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
  });

  it.each([
    { isDefault: true, action: "删除整个 Agent", confirm: "确认删除 Agent" },
    { isDefault: false, action: "删除 Bot", confirm: "确认删除 Bot" },
  ])("$action 请求期间显示转圈并防止重复提交", async ({ isDefault, action, confirm }) => {
    bots = [{ ...buildBot(), isDefault }];
    let finishDelete!: () => void;
    deleteBot.mockImplementation(() => new Promise<void>((resolve) => { finishDelete = resolve; }));
    renderLabPage();

    await userEvent.click(await screen.findByRole("button", { name: action }));
    await userEvent.type(screen.getByPlaceholderText("请输入 {{name}}"), "Hermes Lab");
    await userEvent.click(screen.getByRole("button", { name: confirm }));

    const deletingButton = screen.getByRole("button", { name: "删除中..." });
    expect(deletingButton).toBeDisabled();
    expect(deletingButton).toHaveAttribute("aria-busy", "true");
    expect(deletingButton.querySelector(".motion-safe\\:animate-spin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    await userEvent.click(deletingButton);
    expect(deleteBot).toHaveBeenCalledTimes(1);

    await act(async () => { finishDelete(); });
    expect(screen.queryByRole("button", { name: "删除中..." })).not.toBeInTheDocument();
  });

  it("删除失败后恢复确认操作并显示错误", async () => {
    let failDelete!: (error: Error) => void;
    deleteBot.mockImplementation(() => new Promise<void>((_, reject) => { failDelete = reject; }));
    renderLabPage();

    await userEvent.click(await screen.findByRole("button", { name: "删除整个 Agent" }));
    await userEvent.type(screen.getByPlaceholderText("请输入 {{name}}"), "Hermes Lab");
    await userEvent.click(screen.getByRole("button", { name: "确认删除 Agent" }));
    await act(async () => { failDelete(new Error("删除请求失败")); });

    expect(screen.getByText("删除请求失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认删除 Agent" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();
  });

  it("在日常中显示通道、技能、定时任务和对话", async () => {
    renderLabPage();

    await userEvent.click(screen.getByRole("tab", { name: "日常" }));
    const navigation = await screen.findByRole("navigation", { name: "日常" });
    expect(within(navigation).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(expect.arrayContaining([
      "/agents/channels",
      "/agents/skills",
      "/agents/automations",
    ]));
    expect(within(navigation).getByText("对话")).toBeInTheDocument();
    expect(within(navigation).queryByRole("link", { name: "模型" })).not.toBeInTheDocument();
  });

  it.each([undefined, "ai", "free", "general", "unknown"])(
    "在 %s 类型套餐的日常中不显示模型入口",
    async (bundleType) => {
      activePass = buildPass(bundleType);
      renderLabPage();
      await userEvent.click(screen.getByRole("tab", { name: "日常" }));
      const navigation = await screen.findByRole("navigation", { name: "日常" });
      expect(within(navigation).queryByRole("link", { name: "模型" })).not.toBeInTheDocument();
    },
  );
});
