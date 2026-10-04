import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenClawBot } from "@/contexts/agent-context";
import type { Pass, User } from "@/domain/types";
import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";
import { AgentSettingsPage } from "@/pages/marketing/agent-settings-page";

let currentSessionUser: User;
let bots: OpenClawBot[] = [];
let activePass: Pass | null = null;

vi.mock("@/i18n/t", () => ({
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
  usePaidBillingEnabled: () => false,
  useRealnamePhoneVerificationEnabled: () => false,
  useCloudDesktopEnabled: () => true,
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    session: {
      user: currentSessionUser,
      currentSubscription: null,
    },
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
      execDebugCommand: vi.fn(),
      getRescueExportStatus: vi.fn().mockResolvedValue(null),
      getHermesImportStatus: vi.fn().mockResolvedValue(null),
      startRescueExport: vi.fn(),
      resetInstanceConfig: vi.fn(),
      getSettingsSnapshot: vi.fn().mockImplementation(async (id: string) => ({
        bot: { ...buildBot(), id, status: "active" },
      })),
      getDashboardSnapshot: vi.fn().mockResolvedValue({ bots }),
      ensureDesktopSession: vi.fn().mockResolvedValue({ status: "Provisioning" }),
      getDesktopSession: vi.fn().mockResolvedValue({ status: "Provisioning" }),
    },
    plans: {
      getRenewPrice: vi.fn(),
      createRenewOrder: vi.fn(),
      listMyPasses: vi.fn(),
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

vi.mock("@/pages/marketing/agent-cloud-desktop-panel", () => ({
  AgentCloudDesktopPanel: () => <div>Cloud Desktop panel</div>,
}));

// 导航测试不加载聊天/通道 SDK，避免动态依赖的浏览器 CSS 干扰 jsdom。
vi.mock("@/pages/marketing/agent-chat-panel", () => ({ AgentChatPanel: () => null }));
vi.mock("@/pages/marketing/agent-channel-panel", () => ({ ChannelPanel: () => null }));

const createNavigation = (): AppNavigationValue => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  navigate: vi.fn(),
  pathname: "/agents/labs/cloud-desktop",
  search: "",
  setSearchParams: vi.fn(),
});

const buildBot = (): OpenClawBot => ({
  id: "bot_desktop_lab",
  instanceId: "bot_desktop_lab",
  profileId: "profile_desktop_lab",
  isDefault: true,
  name: "Desktop Lab",
  personality: "默认设定",
  personalityEmoji: "D",
  intro: "",
  status: "running",
  createdAt: "2026-09-23T00:00:00.000Z",
  connectedChannels: [],
  installedSkills: [],
});

const renderLabPage = () => render(
  <AppNavigationProvider value={createNavigation()}>
    <AgentSettingsPage sectionId="cloud-desktop" showHeader={false} />
  </AppNavigationProvider>,
);

describe("AgentSettingsPage 实验室 › 云桌面导航", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as Window & { show?: unknown }).show;
    currentSessionUser = {
      id: "usr_desktop_lab",
      name: "Agent User",
      email: "user@example.com",
      inviteRequired: false,
      realnameVerified: true,
      realnameLevel: "idcard_2fa",
      createdAt: "2026-09-23T00:00:00.000Z",
    };
    bots = [buildBot()];
    activePass = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("实验室分组包含云桌面入口并标记当前页", async () => {
    renderLabPage();

    const navigation = await screen.findByRole("navigation", { name: "探索" });
    const labsGroup = within(navigation).getByRole("group", { name: "实验室" });

    const desktopLink = within(labsGroup).getByRole("link", { name: "云桌面" });
    expect(desktopLink).toHaveAttribute("href", "/agents/labs/cloud-desktop");
    expect(desktopLink).toHaveAttribute("aria-current", "page");

    // DeepSeek Harness 入口仍然共存于实验室分组。
    const harnessLink = within(labsGroup).getByRole("link", { name: "DeepSeek Harness" });
    expect(harnessLink).not.toHaveAttribute("aria-current", "page");

    expect(await screen.findByText("Cloud Desktop panel")).toBeInTheDocument();
  });

  it("云桌面入口带 Beta 标记", async () => {
    renderLabPage();

    const navigation = await screen.findByRole("navigation", { name: "探索" });
    const labsGroup = within(navigation).getByRole("group", { name: "实验室" });
    const desktopLink = within(labsGroup).getByRole("link", { name: "云桌面" });

    expect(within(desktopLink).getByText("Beta")).toBeInTheDocument();
  });
});
