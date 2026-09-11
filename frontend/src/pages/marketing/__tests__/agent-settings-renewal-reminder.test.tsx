import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";
import type { Pass, User } from "@/domain/types";
import { AgentSettingsPage } from "@/pages/marketing/agent-settings-page";
import type { OpenClawBot } from "@/contexts/agent-context";

const refreshPasses = vi.fn();
const getRenewPrice = vi.fn();
const createRenewOrder = vi.fn();
const listMyPasses = vi.fn();
const execDebugCommand = vi.fn();
const refreshProfile = vi.fn();
const getModifyCheckout = vi.fn();
const listBundles = vi.fn();

let activePass: Pass | null = null;
let passUpgradeFailed = false;
let passUpgradePaused = false;
let returningUpgrade = false;
let bots: OpenClawBot[] = [];
let currentSessionUser: User;

vi.mock("@/i18n/t", () => ({
  t: (text: string, options?: Record<string, unknown>) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (raw, name: string) => {
    const value = options?.[name];
    return value === undefined || value === null ? raw : String(value);
  }),
  useT: () => (text: string, options?: Record<string, unknown>) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (raw, name: string) => {
    const value = options?.[name];
    return value === undefined || value === null ? raw : String(value);
  }),
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
  usePaidBillingEnabled: () => true,
  useMultiBotEnabled: () => true,
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
    deleteBot: vi.fn(),
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
    refreshPasses,
    isSubscribed: true,
    addBot: vi.fn(),
    activePass,
    passUpgradeFailed,
    passUpgradePaused,
    returningUpgrade,
    passesLoading: returningUpgrade,
    retryPassUpgrade: refreshPasses,
  }),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    bots: {
      execDebugCommand,
    },
    plans: {
      getRenewPrice,
      createRenewOrder,
      listMyPasses,
      getModifyCheckout,
      listBundles,
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

const createNavigation = (): AppNavigationValue => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  navigate: vi.fn(),
  pathname: "/agents/skills",
  search: "",
  setSearchParams: vi.fn(),
});

const buildBot = (): OpenClawBot => ({
  id: "bot_renewal",
  name: "Hermes Renewal",
  personality: "默认设定",
  personalityEmoji: "✨",
  intro: "",
  status: "running",
  createdAt: "2026-07-01T00:00:00.000Z",
  connectedChannels: [],
  installedSkills: [],
});

const buildPass = (): Pass => ({
  pass_id: "pass_agent_renewal",
  user_id: "usr_agent_renewal",
  bundle_id: "bundle_launch",
  bundle_name: "启航套餐",
  created_time: "2026-07-01T00:00:00.000Z",
  expired_time: "2026-07-30T00:00:00.000Z",
  isolated_time: null,
  deleted_time: null,
  credit_total: 1000,
  credit_available: 900,
});

const renderAgentSettingsPage = () => render(
  <AppNavigationProvider value={createNavigation()}>
    <AgentSettingsPage sectionId="skill" showHeader={false} />
  </AppNavigationProvider>,
);

describe("AgentSettingsPage renewal reminder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    delete (window as Window & { show?: unknown }).show;
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    currentSessionUser = {
      id: "usr_agent_renewal",
      name: "Agent User",
      email: "user@example.com",
      inviteRequired: false,
      realnameVerified: true,
      realnameLevel: "idcard_2fa",
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    bots = [buildBot()];
    activePass = buildPass();
    passUpgradeFailed = false;
    passUpgradePaused = false;
    returningUpgrade = false;
    getRenewPrice.mockResolvedValue({
      bundle_id: "bundle_launch",
      price: 4900,
      total_cost: 4900,
      real_total_cost: 4900,
      currency: "CNY",
      discount: 100,
    });
    createRenewOrder.mockResolvedValue({
      order_id: "order_agent_renewal",
      pass_id: "pass_agent_renewal",
      auth_code: "auth_agent_renewal",
      deal_names: ["renew_deal_agent"],
    });
    listMyPasses.mockResolvedValue([]);
    getModifyCheckout.mockResolvedValue({ checkout: { deal_name: "upgrade", big_order_id: "upgrade-big", target_bundle_id: "bundle_cruise", local_status: "paid_pending_provision" } });
    listBundles.mockResolvedValue([{ bundle_id: "bundle_cruise", bundle_name: "巡航套餐" }]);
    refreshPasses.mockResolvedValue(undefined);
  });

  it("shows recovery instead of an endless spinner when a return has no Pass", async () => {
    activePass = null;
    passUpgradePaused = true;
    returningUpgrade = true;
    renderAgentSettingsPage();
    expect(screen.getByRole("status")).toHaveTextContent("暂时无法确认升级进度");
    expect(screen.getByRole("button", { name: "刷新状态" })).toBeInTheDocument();
    expect(screen.queryByText("Skills panel")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "创建 Agent" })).not.toBeInTheDocument();
  });

  it("shows the target plan without credits and hides Bot controls while the Pass is modifying", async () => {
    activePass = { ...buildPass(), status: "modifying" };
    const view = renderAgentSettingsPage();

    expect(screen.getByRole("status")).toHaveTextContent("正在为 Hermes Agent 升级套餐");
    expect(await screen.findByText("巡航套餐")).toBeInTheDocument();
    expect(screen.getByText("目标套餐")).toBeInTheDocument();
    expect(screen.queryByText("当前套餐")).not.toBeInTheDocument();
    expect(screen.queryByText("启航套餐")).not.toBeInTheDocument();
    expect(screen.queryByText("模型积分")).not.toBeInTheDocument();
    expect(screen.getByText("到期时间")).toBeInTheDocument();
    expect(screen.queryByText("Hermes Renewal")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建 Bot" })).not.toBeInTheDocument();

    activePass = { ...buildPass(), bundle_name: "巡航套餐", status: "active" };
    view.rerender(
      <AppNavigationProvider value={createNavigation()}>
        <AgentSettingsPage sectionId="skill" showHeader={false} />
      </AppNavigationProvider>,
    );
    expect(screen.queryByText("正在为 Hermes Agent 升级套餐")).not.toBeInTheDocument();
    expect(screen.getByText("Hermes Renewal")).toBeInTheDocument();
  });

  it("keeps Bot controls hidden and shows support guidance after upgrade delivery fails", () => {
    activePass = { ...buildPass(), status: "modifying" };
    passUpgradeFailed = true;
    renderAgentSettingsPage();
    expect(screen.getByRole("status")).toHaveTextContent("套餐升级失败");
    expect(screen.getByText("订单已关闭或失败，请联系支持确认后再操作。")).toBeInTheDocument();
    expect(screen.queryByText("Hermes Renewal")).not.toBeInTheDocument();
    expect(screen.queryByText("套餐升级中，完成后将自动展示 Agent。")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建 Bot" })).not.toBeInTheDocument();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    vi.useRealTimers();
  });

  it("keeps bottom spacing between settings content and the product footer", () => {
    renderAgentSettingsPage();

    expect(screen.getByRole("main")).toHaveClass("pb-6");
  });

  it("labels the domestic navigation entry as advanced settings", () => {
    renderAgentSettingsPage();

    expect(screen.getByRole("link", { name: "高级设置" })).toBeInTheDocument();
  });

  it("keeps the desktop settings navigation independent from content scrolling", () => {
    renderAgentSettingsPage();

    const sidebar = screen.getByRole("navigation", { name: "实例配置导航" }).closest("aside");
    expect(sidebar).toHaveClass("lv-agents-sidebar-scroll-isolated");
    expect(sidebar).not.toHaveClass("lg:sticky", "lg:top-[84px]");
    expect(sidebar?.nextElementSibling).toHaveClass("lg:col-start-2");
  });

  it("shows an orange renewal reminder near the active agent status and opens the renewal modal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderAgentSettingsPage();

    const reminder = screen.getByRole("button", { name: "套餐剩余 3 天到期，点击续费" });
    expect(reminder).toHaveTextContent("临近到期");
    expect(reminder).not.toHaveAttribute("title");
    expect(reminder).toHaveClass("is-warning", "cursor-pointer");

    const tooltip = screen.getByRole("tooltip");
    expect(reminder).toHaveAttribute("aria-describedby", tooltip.id);
    expect(tooltip).toHaveTextContent("剩余 3 天到期");
    expect(tooltip).toHaveClass(
      "rounded-[6px]",
      "border",
      "border-[var(--border-subtle)]",
      "bg-white",
      "px-3",
      "py-1.5",
      "text-[11px]",
      "font-medium",
      "pointer-events-auto",
      "select-text",
      "shadow-[0_8px_24px_rgba(15,23,42,0.12)]",
    );

    const renewAction = within(tooltip).getByRole("button", { name: "立即续费" });
    expect(renewAction).toHaveAttribute("type", "button");
    expect(renewAction).toHaveClass("cursor-pointer");

    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(renewAction);

    expect(await screen.findByRole("heading", { name: "续费套餐" })).toBeInTheDocument();
    expect(screen.getByText("生效中")).toBeInTheDocument();
  });

  it("keeps revealed advanced tools in the same grouped navigation structure", async () => {
    renderAgentSettingsPage();

    await waitFor(() => {
      expect(typeof (window as Window & { show?: unknown }).show).toBe("function");
    });
    act(() => {
      (window as Window & { show?: () => boolean }).show?.();
    });

    const navigation = screen.getByRole("navigation", { name: "实例配置导航" });
    const terminalLink = within(navigation).getByRole("link", { name: "终端" });
    const advancedToolsList = terminalLink.closest(".lv-agents-nav-group-items");

    expect(advancedToolsList).toBeInstanceOf(HTMLUListElement);
    if (!(advancedToolsList instanceof HTMLUListElement)) return;
    expect(within(advancedToolsList).getAllByRole("listitem")).toHaveLength(2);
    expect(within(advancedToolsList).getByRole("link", { name: "终端" })).toBe(terminalLink);
    expect(within(advancedToolsList).getByRole("link", { name: "浏览器" })).toBeInTheDocument();

    for (const label of ["配置", "使用", "成长", "管理"]) {
      const group = within(navigation).getByRole("group", { name: label });
      const visibleLabel = within(group).getByText(label);

      expect(group).toHaveAttribute("aria-labelledby", visibleLabel.id);
      expect(group).not.toHaveAttribute("aria-label");
      expect(within(group).getByRole("list")).toBeInTheDocument();
    }
  });

  it("shows the realname guide in the renewal modal when an unverified user clicks the renewal reminder", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    currentSessionUser = {
      ...currentSessionUser,
      realnameVerified: false,
      realnameLevel: "none",
    };

    renderAgentSettingsPage();

    const reminder = screen.getByRole("button", { name: "套餐剩余 3 天到期，点击续费" });
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(reminder);

    expect(await screen.findByRole("heading", { name: "续费套餐" })).toBeInTheDocument();
    expect(await screen.findByText("续费前需先")).toBeInTheDocument();
    expect(screen.getByText("，完成后再确认续费。")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "更新实名认证信息" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "确认续费" })).toBeDisabled();
    expect(screen.queryByRole("dialog", { name: "实名认证" })).not.toBeInTheDocument();
    expect(getRenewPrice).not.toHaveBeenCalled();
    expect(createRenewOrder).not.toHaveBeenCalled();

    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(
      screen.getByRole("button", { name: "更新实名认证信息" }),
    );

    expect(screen.queryByRole("heading", { name: "续费套餐" })).not.toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: "实名认证" })).toBeInTheDocument();
  });
});
