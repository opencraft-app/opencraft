import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";
import type { Pass } from "@/domain/types";
import { AgentSettingsPage } from "@/pages/marketing/agent-settings-page";
import type { OpenClawBot } from "@/contexts/agent-context";

const refreshPasses = vi.fn();
const getRenewPrice = vi.fn();
const createRenewOrder = vi.fn();
const listMyPasses = vi.fn();
const execDebugCommand = vi.fn();

let activePass: Pass | null = null;
let bots: OpenClawBot[] = [];

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
  useTranslation: () => ({ i18n: { language: "zh-CN" } }),
}));

vi.mock("@/lib/region", () => ({
  DEFAULT_LOCALE: "zh-CN",
  isCN: true,
  isGlobal: false,
}));

vi.mock("@/contexts/runtime-config-context", () => ({
  usePaidBillingEnabled: () => true,
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    session: {
      user: { id: "usr_agent_renewal", email: "user@example.com" },
      currentSubscription: null,
    },
    isAuthenticated: true,
    authReady: true,
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
    vi.setSystemTime(new Date("2026-07-27T00:00:00.000Z"));
    bots = [buildBot()];
    activePass = buildPass();
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
    refreshPasses.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows an orange renewal reminder near the active agent status and opens the renewal modal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderAgentSettingsPage();

    const reminder = screen.getByRole("button", { name: "套餐剩余 3 天到期，点击续费" });
    expect(reminder).toHaveTextContent("临近到期");
    expect(reminder).toHaveAttribute("title", "剩余 3 天到期");
    expect(reminder).toHaveClass("is-warning");

    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(reminder);

    expect(await screen.findByText("续费套餐")).toBeInTheDocument();
    expect(screen.getByText("生效中")).toBeInTheDocument();
  });
});
