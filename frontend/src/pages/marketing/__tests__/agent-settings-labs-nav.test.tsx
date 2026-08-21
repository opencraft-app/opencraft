import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenClawBot } from "@/contexts/agent-context";
import type { User } from "@/domain/types";
import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";
import { AgentSettingsPage } from "@/pages/marketing/agent-settings-page";

const execDebugCommand = vi.fn();
const refreshProfile = vi.fn();

let currentSessionUser: User;
let bots: OpenClawBot[] = [];

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
  isCN: true,
  isGlobal: false,
  readLocaleFromPath: () => null,
}));

vi.mock("@/contexts/runtime-config-context", () => ({
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
    addBot: vi.fn(),
    activePass: null,
  }),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    bots: { execDebugCommand },
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

const createNavigation = (): AppNavigationValue => ({
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
  navigate: vi.fn(),
  pathname: "/agents/labs/deepseek-harness",
  search: "",
  setSearchParams: vi.fn(),
});

const buildBot = (): OpenClawBot => ({
  id: "bot_dsh_lab",
  name: "Hermes Lab",
  personality: "默认设定",
  personalityEmoji: "H",
  intro: "",
  status: "running",
  createdAt: "2026-08-20T00:00:00.000Z",
  connectedChannels: [],
  installedSkills: [],
});

const renderLabPage = () => render(
  <AppNavigationProvider value={createNavigation()}>
    <AgentSettingsPage sectionId="deepseek-harness" showHeader={false} />
  </AppNavigationProvider>,
);

describe("AgentSettingsPage 实验室导航", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  afterEach(() => {
    cleanup();
  });

  it("在管理分组中展开实验室并标记 DeepSeek Harness 当前页", async () => {
    const user = userEvent.setup();
    renderLabPage();

    const navigation = await screen.findByRole("navigation", { name: "实例配置导航" });
    const manageGroup = within(navigation).getByRole("group", { name: "管理" });
    const labsToggle = within(manageGroup).getByRole("button", { name: "实验室" });

    expect(labsToggle).toHaveAttribute("aria-expanded", "true");
    expect(labsToggle).toHaveAttribute("aria-controls");
    const controlledListId = labsToggle.getAttribute("aria-controls");
    expect(controlledListId).toBeTruthy();
    const controlledList = document.getElementById(controlledListId ?? "");
    expect(controlledList).toBeInstanceOf(HTMLUListElement);
    expect(controlledList).not.toHaveAttribute("hidden");

    const deepSeekLink = within(manageGroup).getByRole("link", { name: "DeepSeek Harness" });
    expect(deepSeekLink).toHaveAttribute("href", "/agents/labs/deepseek-harness");
    expect(deepSeekLink).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("DeepSeek Harness panel")).toBeInTheDocument();

    await user.click(labsToggle);
    expect(labsToggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(controlledListId ?? "")).toBe(controlledList);
    expect(controlledList).toHaveAttribute("hidden");
    expect(within(manageGroup).queryByRole("link", { name: "DeepSeek Harness" })).not.toBeInTheDocument();

    await user.click(labsToggle);
    expect(labsToggle).toHaveAttribute("aria-expanded", "true");
    expect(controlledList).not.toHaveAttribute("hidden");
    expect(within(manageGroup).getByRole("link", { name: "DeepSeek Harness" })).toBeInTheDocument();
  });
});
