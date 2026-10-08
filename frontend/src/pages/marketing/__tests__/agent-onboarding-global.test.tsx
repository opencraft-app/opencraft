import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenClawBot } from "@/contexts/agent-context";
import type { User } from "@/domain/types";
import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";
import { AgentSettingsPage } from "@/pages/marketing/agent-settings-page";
import { journeyHref, resolveCtaRoute } from "@/lib/cta-journey";
import { setConsoleShowEnabled } from "@/lib/console-show-event";

const addBot = vi.fn();
const deleteBot = vi.fn();
let maxBots = 5;
let multiBotEnabled = true;
let currentLocale = "en-US";
let activePass: { expired_time: string; created_time: string; credit_available: number; status: string } | null = null;
const navigateMock = vi.fn();
const execDebugCommand = vi.fn();
const testRegion = vi.hoisted(() => ({ isCN: false, isGlobal: true }));

let currentSessionUser: User;
let bots: OpenClawBot[] = [];

vi.mock("@/i18n/t", () => ({
  // 可变 locale 用于验证实际页面调用方传入日期格式化语言。
  useCurrentLocale: () => currentLocale,
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
  useCloudDesktopEnabled: () => false,
  usePaidBillingEnabled: () => false,
  useMultiBotEnabled: () => multiBotEnabled,
  useReferralEnabled: () => false,
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
    botsLoading: false,
    hasResolvedBots: true,
    deleteBot,
    user: {
      email: "user@example.com",
      plan: { name: "启航套餐", tier: "plus", trialDays: 7, aiCredits: 1000, usedCredits: 0, totalRequests: 0, maxBots },
    },
    refreshBots: vi.fn(),
    refreshPasses: vi.fn(),
    isSubscribed: true,
    passesLoading: false,
    passesError: false,
    addBot,
    activePass,
  }),
}));

const listMyPasses = vi.fn().mockResolvedValue([]);

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
    plans: { getRenewPrice: vi.fn(), createRenewOrder: vi.fn(), listMyPasses },
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

function buildBot(): OpenClawBot {
  return {
    id: "ins-372",
    instanceId: "ins-372",
    profileId: "profile-372",
    isDefault: true,
    name: "Existing Bot",
    personality: "默认设定",
    personalityEmoji: "H",
    intro: "",
    status: "running",
    createdAt: "2026-09-18T00:00:00.000Z",
    connectedChannels: [],
    installedSkills: [],
  };
}

const createNavigation = (search: string): AppNavigationValue => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  navigate: navigateMock,
  pathname: "/agents",
  search,
  setSearchParams: vi.fn(),
});

const page = (search: string, sectionId?: "chat" | "overview") => (
  <AppNavigationProvider value={createNavigation(search)}>
    <AgentSettingsPage showHeader={false} sectionId={sectionId} />
  </AppNavigationProvider>
);

function GlobalFirstBotJourney({ initialSearch }: { initialSearch: string }) {
  const [search, setSearch] = useState(initialSearch);
  const navigate = useCallback<AppNavigationValue["navigate"]>((to, options) => {
    navigateMock(to, options);
    setSearch(typeof to === "string" ? new URL(to, "https://lightvela.ai").search : to.search ?? "");
  }, []);
  const navigation = useMemo(() => ({ ...createNavigation(search), navigate }), [search, navigate]);
  return <AppNavigationProvider value={navigation}><AgentSettingsPage showHeader={false} /></AppNavigationProvider>;
}

vi.mock("@/pages/marketing/agent-chat-panel", () => ({
  AgentChatPanel: () => <div data-testid="agent-chat" />,
}));

vi.mock("@/pages/marketing/opencraft-embedded-workbench", () => ({
  AgentChatMigrationSurface: ({ enabled, legacy, locale, profileId, region }: {
    enabled: boolean; legacy: ReactNode; locale: string; profileId: string; region: string;
  }) => enabled
    ? <div data-testid="opencraft-chat" data-locale={locale} data-profile-id={profileId} data-region={region} />
    : legacy,
}));

vi.mock("@/pages/marketing/agent-overview-panel", () => ({
  AgentOverviewPanel: ({ heroStats }: { heroStats: { expiresAt: string | null } }) => <div>Bot overview {heroStats.expiresAt}</div>,
  HeroBanner: ({ stats }: { stats: { expiresAt: string | null } }) => <div>Bot overview {stats.expiresAt}</div>,
  LatestNewsSection: () => null,
  RecommendedAutomationsSection: () => null,
  BuddyProfileAvatar: () => null,
  useOverviewProfileEditor: () => ({ steps: null, writeError: null, applyProfile: vi.fn() }),
}));

// isCN is false before module evaluation: a CN-only feature constant must fail here.
describe("international Bot onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
    maxBots = 5;
    multiBotEnabled = true;
    testRegion.isCN = false;
    testRegion.isGlobal = true;
    setConsoleShowEnabled(false);
    currentLocale = "en-US";
    activePass = null;
    bots = [buildBot()];
    currentSessionUser = {
      id: "usr-test", name: "Agent User", email: "user@example.com",
      inviteRequired: false, realnameVerified: true, realnameLevel: "idcard_2fa",
      createdAt: "2026-08-20T00:00:00.000Z",
    };
    execDebugCommand.mockResolvedValue({ status: "success", exitCode: 0, output: "" });
  });
  afterEach(cleanup);

  it("shows international OpenCraft Chat by default and keeps it visible when show() toggles", async () => {
    render(page("?bot=ins-372", "chat"));
    const chat = await screen.findByTestId("opencraft-chat");
    expect(chat).toHaveAttribute("data-region", "intl");
    expect(chat).toHaveAttribute("data-locale", "en-US");
    expect(screen.getByRole("group", { name: "对话" })).toBeInTheDocument();
    expect(screen.queryByTestId("agent-chat")).not.toBeInTheDocument();
    const show = (window as Window & { show?: () => boolean }).show;
    expect(show).toBeTypeOf("function");
    act(() => { show?.(); });
    expect(screen.getByTestId("opencraft-chat")).toBe(chat);
    act(() => { show?.(); });
    expect(screen.getByTestId("opencraft-chat")).toBe(chat);
    expect(screen.getByRole("group", { name: "对话" })).toBeInTheDocument();
  });

  it("uses OpenCraft for an international non-default Bot", async () => {
    bots = [buildBot(), { ...buildBot(), id: "bot-child", profileId: "research", isDefault: false, name: "Research Bot" }];
    currentLocale = "ja-JP";
    render(page("?bot=bot-child", "chat"));
    const chat = await screen.findByTestId("opencraft-chat");
    expect(chat).toHaveAttribute("data-region", "intl");
    expect(chat).toHaveAttribute("data-profile-id", "research");
    expect(chat).toHaveAttribute("data-locale", "ja-JP");
    expect(screen.queryByTestId("agent-chat")).not.toBeInTheDocument();
  });

  describe("domestic multi-Bot rail", () => {
    beforeEach(() => {
      testRegion.isCN = true;
      testRegion.isGlobal = false;
      currentLocale = "zh-CN";
    });

    it("uses OpenCraft for domestic Chat without show", async () => {
      render(page("?bot=ins-372", "chat"));
      expect(await screen.findByTestId("opencraft-chat")).toBeInTheDocument();
      expect(screen.queryByTestId("agent-chat")).not.toBeInTheDocument();
    });

    it("shows all Bots in the separate rail without an overview entry", async () => {
      bots = [buildBot(), { ...buildBot(), id: "bot-child", profileId: "child", isDefault: false, name: "Research Bot" }];
      render(page("?bot=ins-372", "chat"));
      expect(await screen.findByRole("link", { name: /切换到 Research Bot/ })).toHaveAttribute("href", "/agents/chat/?bot=bot-child");
      expect(screen.getByRole("button", { name: /切换到 Existing Bot/ })).toHaveAttribute("aria-current", "true");
      expect(screen.queryByRole("link", { name: "总览" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "新建 Bot" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: /切换到 Existing Bot/ }));
      expect(navigateMock).not.toHaveBeenCalled();
    });

    it("opens the creation guide from the rail", async () => {
      render(page("", "chat"));
      fireEvent.click(await screen.findByRole("button", { name: "新建 Bot" }));
      expect(await screen.findByRole("button", { name: "换一批" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "创建" })).toBeInTheDocument();
      expect(addBot).not.toHaveBeenCalled();
    });

    it("keeps the creation quota restriction", async () => {
      maxBots = 1;
      render(page("", "chat"));
      expect(await screen.findByRole("button", { name: "新建 Bot" })).toBeDisabled();
      expect(addBot).not.toHaveBeenCalled();
    });

    it("keeps chat available when multi-Bot is disabled", async () => {
      multiBotEnabled = false;
      render(page("", "chat"));
      expect(await screen.findByTestId("opencraft-chat")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "总览" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "新建 Bot" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /切换到 Existing Bot/ })).not.toBeInTheDocument();
    });
  });

  it("creates and configures the first Bot from the international homepage entry", async () => {
    bots = [];
    // 国际站不依赖国内实名状态。
    currentSessionUser.realnameVerified = false;
    addBot.mockImplementationOnce(async ({ name }: { name: string }) => {
      const created = { ...buildBot(), name, status: "provisioning" as const };
      bots = [created];
      return created;
    });
    const target = journeyHref(resolveCtaRoute({
      isAuthenticated: true, isSubscribed: true, hasBots: false,
    }), "en-US", { localized: true });
    render(<GlobalFirstBotJourney initialSearch={new URL(target, "https://lightvela.ai").search} />);
    expect(await screen.findByText("Industry Researcher", { selector: "span" })).toBeInTheDocument();
    fireEvent.change(document.getElementById("lv-onboarding-name")!, { target: { value: "Global helper" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(addBot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(
      "/agents/chat?bot=ins-372", { replace: true },
    ));
    expect(execDebugCommand.mock.calls.some(([id, command]) =>
      id === "ins-372" && command.includes("__CTL_SOUL_EOF__"),
    )).toBe(true);
  });

  it("opens the subscription return in the international template guide", async () => {
    bots = [];
    render(page("?create=1"));
    expect(await screen.findByRole("button", { name: "换一批" })).toBeInTheDocument();
    expect(screen.getByText("Industry Researcher", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByText("育儿参谋")).not.toBeInTheDocument();
    expect(screen.queryByText("创建 Bot")).not.toBeInTheDocument();
    expect(addBot).not.toHaveBeenCalled();
  });

  it("automatically opens the guide for an empty account", async () => {
    bots = [];
    render(page(""));
    expect(await screen.findByRole("button", { name: "换一批" })).toBeInTheDocument();
    expect(await screen.findByText("Industry Researcher", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByText("创建 Bot")).not.toBeInTheDocument();
  });

  it("defaults existing users to chat without forcing onboarding", async () => {
    render(page(""));
    expect(await screen.findByTestId("opencraft-chat")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "总览" })).not.toBeInTheDocument();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/agents/chat?bot=ins-372", { replace: true }));
    expect(screen.queryByRole("button", { name: "换一批" })).not.toBeInTheDocument();
    expect(addBot).not.toHaveBeenCalled();
  });

  it("preserves the original redirect to an in-progress Bot creation", async () => {
    bots = [{ ...buildBot(), status: "provisioning" }];
    render(page(""));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(expect.stringContaining("creating=ins-372"), { replace: true }));
  });

  it("opens the original delete dialog for the selected Bot", async () => {
    bots = [buildBot(), { ...buildBot(), id: "bot-child", profileId: "child", isDefault: false, name: "Research Bot" }];
    render(page("?bot=bot-child", "chat"));
    fireEvent.click(await screen.findByRole("button", { name: "管理 Bot" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除 Bot" }));
    expect(screen.getByText("风险提示：")).toBeInTheDocument();
    expect(screen.getByText("删除后，当前 Bot 的会话、配置、已安装技能和记忆等数据将无法恢复。请谨慎操作！")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("请输入 {{name}}"), { target: { value: "Research Bot" } });
    fireEvent.click(screen.getByRole("button", { name: "确认删除 Bot" }));
    await waitFor(() => expect(deleteBot).toHaveBeenCalledWith("bot-child"));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("opens the same named delete confirmation from the embedded native request", async () => {
    bots = [buildBot(), { ...buildBot(), id: "bot-child", profileId: "child", isDefault: false, name: "Research Bot" }];
    const onDeleteRequestHandled = vi.fn();
    render(<AppNavigationProvider value={createNavigation("?bot=bot-child")}>
      <AgentSettingsPage
        showHeader={false}
        sectionId="overview"
        embedded
        deleteRequestId={1}
        deleteRequestBotId="bot-child"
        onDeleteRequestHandled={onDeleteRequestHandled}
      />
    </AppNavigationProvider>);
    expect(await screen.findByText("风险提示：")).toBeInTheDocument();
    expect(onDeleteRequestHandled).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "确认删除 Bot" })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("请输入 {{name}}"), { target: { value: "Research Bot" } });
    fireEvent.click(screen.getByRole("button", { name: "确认删除 Bot" }));
    await waitFor(() => expect(deleteBot).toHaveBeenCalledWith("bot-child"));
  });

  it("keeps the main Bot deletion blocked while another Bot shares its instance", async () => {
    bots = [buildBot(), { ...buildBot(), id: "bot-child", profileId: "child", isDefault: false, name: "Research Bot" }];
    const onDeleteRequestHandled = vi.fn();
    render(<AppNavigationProvider value={createNavigation("?bot=ins-372")}>
      <AgentSettingsPage
        showHeader={false}
        sectionId="overview"
        embedded
        deleteRequestId={1}
        deleteRequestBotId="ins-372"
        onDeleteRequestHandled={onDeleteRequestHandled}
      />
    </AppNavigationProvider>);
    await waitFor(() => expect(onDeleteRequestHandled).toHaveBeenCalledOnce());
    expect(screen.queryByText("风险提示：")).not.toBeInTheDocument();
    expect(deleteBot).not.toHaveBeenCalled();
  });

  it("keeps every Bot in the rail when the selected Bot changes", async () => {
    bots = [buildBot(), { ...buildBot(), id: "bot-child", profileId: "child", isDefault: false, name: "Research Bot" }];
    const view = render(page("?bot=ins-372", "chat"));
    expect(await screen.findByRole("link", { name: /切换到 Research Bot/ })).toBeInTheDocument();
    view.rerender(page("?bot=bot-child", "chat"));
    expect(screen.getByRole("link", { name: /切换到 Existing Bot/ })).toHaveAttribute("href", "/agents/chat/?bot=ins-372");
    expect(screen.getByRole("button", { name: /切换到 Research Bot/ })).toHaveAttribute("aria-current", "true");
  });

  it("redirects the retired overview URL to the selected Bot's chat", async () => {
    render(page("?bot=ins-372", "overview"));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/agents/chat?bot=ins-372", { replace: true }));
    expect(screen.queryByText("Bot overview")).not.toBeInTheDocument();
  });

  it("opens the international guide for an additional Bot and enforces quota on submit", async () => {
    const view = render(page("?bot=ins-372"));
    fireEvent.click(await screen.findByRole("button", { name: "新建 Bot" }));
    expect(await screen.findByText("Industry Researcher", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByText("育儿参谋")).not.toBeInTheDocument();
    maxBots = 1;
    view.rerender(page("?bot=ins-372"));
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(screen.getAllByText(
      "当前套餐最多可创建 1 个 Bot（含主 Bot），请升级套餐或删除已有 Bot 后再创建。",
    ).length).toBeGreaterThan(0));
    expect(addBot).not.toHaveBeenCalled();
  });

  it.each(["running", "provisioning"] as const)("configures a %s target with skills.sh and opens its chat", async (status) => {
    bots = [{ ...buildBot(), status }];
    const view = render(page("?creating=ins-372"));
    const card = (await screen.findByText("Industry Researcher", { selector: "span" })).closest("button");
    expect(card).not.toBeNull();
    fireEvent.click(card!);
    expect(navigateMock).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole("button", { name: "创建" });
    fireEvent.click(buttons[buttons.length - 1]!);
    bots = [{ ...buildBot(), status: "running" }];
    view.rerender(page("?creating=ins-372"));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(
      "/agents/chat?bot=ins-372", { replace: true },
    ));
    expect(addBot).not.toHaveBeenCalled();
    const skillCalls = execDebugCommand.mock.calls.filter(([, command]) => command.includes("skills-sh install"));
    expect(skillCalls.length).toBeGreaterThan(0);
    for (const [id, command] of skillCalls) {
      expect(id).toBe("ins-372");
      expect(command).toContain("mattpocock/skills/research");
      expect(command).toContain("profile-372");
    }
    expect(execDebugCommand.mock.calls.some(([, command]) => command.includes("acli skills install"))).toBe(false);
    expect(screen.queryByRole("button", { name: "换一批" })).not.toBeInTheDocument();
  });
});
