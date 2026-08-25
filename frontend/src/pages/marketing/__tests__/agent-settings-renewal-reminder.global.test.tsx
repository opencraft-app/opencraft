import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenClawBot } from "@/contexts/agent-context";
import type { Pass, User } from "@/domain/types";
import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";
import { AgentSettingsPage } from "@/pages/marketing/agent-settings-page";

const refreshPasses = vi.fn();
const getRenewPrice = vi.fn();
const createRenewOrder = vi.fn();
const listMyPasses = vi.fn();
const execDebugCommand = vi.fn();
const refreshProfile = vi.fn();

let activePass: Pass | null = null;
let bots: OpenClawBot[] = [];
let currentSessionUser: User;

vi.mock("@/i18n/t", () => {
  const translate = (text: string, options?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      "临近到期": "Expiring Soon",
      "即将到期": "Expiring Soon",
      "剩余 {{days}} 天到期": "{{days}} days left",
      "剩余 {{hours}} 小时到期": "{{hours}} hours left",
      "剩余不足 1 小时到期": "Less than 1 hour left",
    };
    const mapped = translations[text] ?? text;
    return mapped.replace(/\{\{\s*(\w+)\s*\}\}/g, (raw, name: string) => {
      const value = options?.[name];
      return value === undefined || value === null ? raw : String(value);
    });
  };

  return {
    t: translate,
    useT: () => translate,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "en-US", resolvedLanguage: "en-US" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("@/lib/region", () => ({
  DEFAULT_LOCALE: "en-US",
  isCN: false,
  isGlobal: true,
  readLocaleFromPath: () => "en-US",
}));

vi.mock("@/contexts/runtime-config-context", () => ({
  usePaidBillingEnabled: () => true,
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
        name: "Launch",
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
  id: "bot_global_renewal",
  name: "Hermes Global Renewal",
  personality: "Default",
  personalityEmoji: "✨",
  intro: "",
  status: "running",
  createdAt: "2026-07-01T00:00:00.000Z",
  connectedChannels: [],
  installedSkills: [],
});

const buildPass = (): Pass => ({
  pass_id: "pass_global_agent_renewal",
  user_id: "usr_global_agent_renewal",
  bundle_id: "bundle_launch",
  bundle_name: "Launch",
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

describe("AgentSettingsPage global renewal reminder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    currentSessionUser = {
      id: "usr_global_agent_renewal",
      name: "Global User",
      email: "global@example.com",
      inviteRequired: false,
      realnameVerified: true,
      realnameLevel: "none",
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    bots = [buildBot()];
    activePass = buildPass();
    getRenewPrice.mockResolvedValue({
      bundle_id: "bundle_launch",
      price: 4900,
      total_cost: 4900,
      real_total_cost: 4900,
      currency: "USD",
      discount: 100,
    });
    createRenewOrder.mockResolvedValue({
      order_id: "order_global_agent_renewal",
      pass_id: "pass_global_agent_renewal",
      auth_code: "auth_global_agent_renewal",
      deal_names: ["renew_deal_global_agent"],
    });
    listMyPasses.mockResolvedValue([]);
    refreshPasses.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not expose the domestic common settings navigation entry", () => {
    renderAgentSettingsPage();

    expect(screen.queryByText("高级设置")).not.toBeInTheDocument();
  });

  it("renders the global renewal reminder as a static compact badge", () => {
    renderAgentSettingsPage();

    const reminder = screen.getByText("Expiring Soon").closest(".lv-agent-renewal-badge") as HTMLElement | null;
    expect(reminder).not.toBeNull();
    expect(reminder?.tagName).toBe("SPAN");
    expect(reminder).toHaveTextContent("Expiring Soon");
    expect(reminder).toHaveTextContent("3 days left");
    expect(reminder).toHaveClass("lv-agent-renewal-badge");
    expect(reminder).not.toHaveAttribute("aria-label");
    expect(reminder).not.toHaveAttribute("aria-disabled");
    expect(reminder).not.toHaveAttribute("aria-describedby");
    expect(reminder).not.toHaveAttribute("role");
    expect(reminder).not.toHaveAttribute("title");
    expect(reminder?.querySelector("svg")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Expiring Soon|Coming Soon/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "续费套餐" })).not.toBeInTheDocument();
    expect(getRenewPrice).not.toHaveBeenCalled();
    expect(createRenewOrder).not.toHaveBeenCalled();
  });
});
