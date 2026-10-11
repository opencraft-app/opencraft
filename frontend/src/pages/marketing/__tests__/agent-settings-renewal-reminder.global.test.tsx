import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
let paidBillingEnabled = false;

vi.mock("@/i18n/t", () => {
  const translate = (text: string, options?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      "临近到期": "Expires soon",
      "即将到期": "Expires soon",
      "剩余 {{days}} 天到期": "{{days}} days left",
      "剩余 {{hours}} 小时到期": "{{hours}} hours left",
      "剩余不足 1 小时到期": "Less than 1 hour left",
      "高级设置": "Advanced Settings",
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
    useCurrentLocale: () => "en-US",
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
  useCloudDesktopEnabled: () => false,
  usePaidBillingEnabled: () => paidBillingEnabled,
  useMultiBotEnabled: () => true,
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
  ProductReturnHomeHeader: () => null,
}));

vi.mock("@/pages/marketing/agent-skills-panel", () => ({
  HermesAgentSkillsPanel: () => <div>Skills panel</div>,
}));

vi.mock("@/pages/marketing/agent-common-settings-panel", () => ({
  AgentCommonSettingsPanel: () => <div>Global common settings panel</div>,
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

const renderAgentSettingsPage = (sectionId: "skill" | "settings" = "skill") => render(
  <AppNavigationProvider value={createNavigation()}>
    <AgentSettingsPage sectionId={sectionId} showHeader={false} />
  </AppNavigationProvider>,
);

describe("AgentSettingsPage global renewal reminder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(min-width: 1024px)", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
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
    paidBillingEnabled = false;
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
    vi.unstubAllGlobals();
    cleanup();
    vi.useRealTimers();
  });

  it("exposes daily and explore navigation", () => {
    renderAgentSettingsPage();
    expect(screen.getByRole("tab", { name: "日常" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "探索" })).toBeInTheDocument();
  });

  it("mounts the advanced settings panel on the global site", async () => {
    renderAgentSettingsPage("settings");

    expect(await screen.findByText("Global common settings panel")).toBeInTheDocument();
  });

  it("shows the global reminder in the account entry without an unavailable renewal action", async () => {
    renderAgentSettingsPage();
    const accountEntry = screen.getByRole("button", { name: /打开用户菜单 3 days left/ });
    expect(accountEntry).toHaveTextContent("Expires soon");
    await userEvent.click(accountEntry);
    expect(screen.getByRole("status")).toHaveTextContent("3 days left");
    expect(screen.queryByRole("button", { name: "立即续费" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "续费套餐" })).not.toBeInTheDocument();
    expect(getRenewPrice).not.toHaveBeenCalled();
    expect(createRenewOrder).not.toHaveBeenCalled();
  });

  it("opens the renewal modal from the global reminder when paid billing is enabled", async () => {
    paidBillingEnabled = true;
    renderAgentSettingsPage();

    await userEvent.click(screen.getByRole("button", { name: /打开用户菜单 3 days left/ }));
    await userEvent.click(screen.getByRole("button", { name: "立即续费" }));

    expect(await screen.findByRole("heading", { name: "续费套餐" })).toBeInTheDocument();
    expect(getRenewPrice).toHaveBeenCalledWith("pass_global_agent_renewal", { period: 1, time_unit: "m" });
  });
});
