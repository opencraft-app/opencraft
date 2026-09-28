import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenClawBot } from "@/contexts/agent-context";
import type { User } from "@/domain/types";
import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";
import { AgentSettingsPage } from "@/pages/marketing/agent-settings-page";
import { journeyHref, resolveCtaRoute } from "@/lib/cta-journey";

const addBot = vi.fn();
let maxBots = 5;
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
    botsLoading: false,
    deleteBot: vi.fn(),
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

const page = (search: string) => (
  <AppNavigationProvider value={createNavigation(search)}>
    <AgentSettingsPage showHeader={false} />
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
  AgentChatPanel: () => null,
}));

vi.mock("@/pages/marketing/agent-overview-panel", () => ({
  AgentOverviewPanel: ({ heroStats }: { heroStats: { expiresAt: string | null } }) => <div>Bot overview {heroStats.expiresAt}</div>,
}));

// isCN is false before module evaluation: a CN-only feature constant must fail here.
describe("international Bot onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    maxBots = 5;
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
      "/agents/overview?bot=ins-372", { replace: true },
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

  it("opens the same guide when creating the first Bot from an empty account", async () => {
    bots = [];
    render(page(""));
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    expect(await screen.findByText("Industry Researcher", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByText("创建 Bot")).not.toBeInTheDocument();
  });

  it("defaults existing users to overview without forcing onboarding", async () => {
    render(page(""));
    expect(await screen.findByText("Bot overview")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "总览" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("button", { name: "换一批" })).not.toBeInTheDocument();
    expect(addBot).not.toHaveBeenCalled();
  });

  it("formats the overview expiry in the current language and updates on language switches", async () => {
    activePass = { expired_time: "2026-10-23T12:00:00Z", created_time: "2026-09-23T12:00:00Z", credit_available: 4500, status: "active" };
    const view = render(page(""));
    expect(await screen.findByText("Bot overview October 23, 2026")).toBeInTheDocument();
    currentLocale = "id-ID";
    view.rerender(page(""));
    expect(await screen.findByText("Bot overview 23 Oktober 2026")).toBeInTheDocument();
    currentLocale = "zh-CN";
    view.rerender(page(""));
    expect(await screen.findByText("Bot overview 2026年10月23日")).toBeInTheDocument();
  });

  it("opens the international guide for an additional Bot and enforces quota on submit", async () => {
    const view = render(page("?bot=ins-372"));
    fireEvent.click(screen.getByRole("button", { name: "新建 Bot" }));
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

  it.each(["running", "provisioning"] as const)("configures a %s target with skills.sh and opens its overview", async (status) => {
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
      "/agents/overview?bot=ins-372", { replace: true },
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
