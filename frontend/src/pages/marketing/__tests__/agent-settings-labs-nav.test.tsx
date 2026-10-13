import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  useReferralEnabled: () => false,
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
        bot: { ...(bots.find((bot) => bot.id === id) ?? buildBot()), id, status: "active" },
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
  AgentDeepSeekHarnessPanel: ({ botId }: { botId: string }) => <div data-testid="dsh-panel" data-instance-id={botId}>DeepSeek Harness panel</div>,
}));

// 导航测试不加载聊天/通道 SDK，避免动态依赖的浏览器 CSS 干扰 jsdom。
vi.mock("@/pages/marketing/agent-chat-panel", () => ({ AgentChatPanel: () => null }));
vi.mock("@/pages/marketing/agent-channel-panel", () => ({ ChannelPanel: () => null }));

const createNavigation = (botId?: string): AppNavigationValue => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  navigate: vi.fn(),
  pathname: "/agents/labs/deepseek-harness",
  search: botId ? `?bot=${botId}` : "",
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

const renderLabPage = (botId?: string) => render(
  <AppNavigationProvider value={createNavigation(botId)}>
    <AgentSettingsPage sectionId="deepseek-harness" showHeader={false} />
  </AppNavigationProvider>,
);

describe("AgentSettingsPage 实验室导航", () => {
  it.each([0, 1, 2, 3])("同实例的第 %i 个 Bot 使用实例 DSH 地址", async (index) => {
    bots = Array.from({ length: 4 }, (_, i) => ({
      ...buildBot(),
      id: i === 0 ? "ins_shared_dsh" : `profile_dsh_${i}`,
      instanceId: "ins_shared_dsh",
      profileId: `profile_dsh_${i}`,
      isDefault: i === 0,
    }));
    renderLabPage(bots[index]!.id);
    await waitFor(() => expect(screen.getByTestId("dsh-panel")).toHaveAttribute("data-instance-id", "ins_shared_dsh"));
  });

  it("不同实例的 Bot 不复用主 Bot 的 DSH 地址", async () => {
    bots = [buildBot(), { ...buildBot(), id: "profile_other", instanceId: "ins_other_dsh", isDefault: false }];
    renderLabPage("profile_other");
    await waitFor(() => expect(screen.getByTestId("dsh-panel")).toHaveAttribute("data-instance-id", "ins_other_dsh"));
  });

  it("旧 Bot 没有 instanceId 时回退使用 Bot ID", async () => {
    bots = [{ ...buildBot(), instanceId: undefined }];
    renderLabPage("bot_dsh_lab");
    await waitFor(() => expect(screen.getByTestId("dsh-panel")).toHaveAttribute("data-instance-id", "bot_dsh_lab"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(min-width: 1024px)", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
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

  // The persistent /agents console keeps this page mounted across sections, so the
  // sidebar tab must follow the route (e.g. Explore workbench → "创建我的工作台" → Chat).
  it("follows the route section with the sidebar tab while staying mounted", async () => {
    const navigation = createNavigation();
    const view = render(
      <AppNavigationProvider value={navigation}>
        <AgentSettingsPage sectionId="deepseek-harness" showHeader={false} />
      </AppNavigationProvider>,
    );
    const tab = (name: string) => screen.getAllByRole("tab", { name })[0]!;
    await waitFor(() => expect(tab("探索")).toHaveAttribute("aria-selected", "true"));
    view.rerender(
      <AppNavigationProvider value={{ ...navigation, pathname: "/agents/skills" }}>
        <AgentSettingsPage sectionId="skill" showHeader={false} />
      </AppNavigationProvider>,
    );
    await waitFor(() => expect(tab("日常")).toHaveAttribute("aria-selected", "true"));
    expect(tab("探索")).toHaveAttribute("aria-selected", "false");
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

  it("在 Bot 竖栏的管理菜单提供重启和删除操作", async () => {
    renderLabPage();
    expect(await screen.findByRole("button", { name: /切换到 Hermes Lab/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "管理 Bot" }));
    expect(screen.getByRole("button", { name: "重启" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除整个 Agent" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
  });

  it("重启失败后在竖栏管理入口提示，并在菜单中展示错误", async () => {
    execDebugCommand.mockRejectedValue(new Error("网关重启失败"));
    renderLabPage();
    const manage = screen.getByRole("button", { name: "管理 Bot" });
    await userEvent.click(manage);
    await userEvent.click(screen.getByRole("button", { name: "重启" }));
    await userEvent.click(screen.getByRole("button", { name: "确认重启" }));

    await waitFor(() => expect(manage.querySelector(".bg-red-500")).toBeInTheDocument());
    if (manage.getAttribute("aria-expanded") === "false") await userEvent.click(manage);
    expect(screen.getByRole("alert")).toHaveTextContent("网关重启失败");
  });

  it.each([
    { isDefault: true, action: "删除整个 Agent", confirm: "确认删除 Agent" },
    { isDefault: false, action: "删除 Bot", confirm: "确认删除 Bot" },
  ])("$action 请求期间显示转圈并防止重复提交", async ({ isDefault, action, confirm }) => {
    bots = [{ ...buildBot(), isDefault }];
    let finishDelete!: () => void;
    deleteBot.mockImplementation(() => new Promise<void>((resolve) => { finishDelete = resolve; }));
    renderLabPage();

    await userEvent.click(await screen.findByRole("button", { name: "管理 Bot" }));
    await userEvent.click(screen.getByRole("button", { name: action }));
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

    await userEvent.click(await screen.findByRole("button", { name: "管理 Bot" }));
    await userEvent.click(screen.getByRole("button", { name: "删除整个 Agent" }));
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
