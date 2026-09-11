import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenClawBot } from "@/contexts/agent-context";
import type { User } from "@/domain/types";
import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";
import { AgentSettingsPage } from "@/pages/marketing/agent-settings-page";

const execDebugCommand = vi.fn();
const refreshProfile = vi.fn();
const getRescueExportStatus = vi.fn();
const getHermesImportStatus = vi.fn();
const startRescueExport = vi.fn();
const resetInstanceConfig = vi.fn();
const botRepository = { execDebugCommand, getRescueExportStatus, getHermesImportStatus, startRescueExport, resetInstanceConfig };

let currentSessionUser: User;
let bots: OpenClawBot[] = [];
let maxBots = 1;
let multiBotEnabled = true;

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
  useMultiBotEnabled: () => multiBotEnabled,
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
      email: "user@example.com",
      plan: {
        name: "启航套餐",
        tier: "plus",
        trialDays: 7,
        aiCredits: 1000,
        usedCredits: 100,
        totalRequests: 0,
        maxBots,
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
    bots: botRepository,
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
  pathname: "/agents/diagnostics",
  search: "",
  setSearchParams: vi.fn(),
});

const buildBot = (): OpenClawBot => ({
  id: "ins-1",
  instanceId: "ins-1",
  profileId: "main",
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


const page = (botId: string) => (
  <AppNavigationProvider value={{ ...createNavigation(), search: "?bot=" + botId }}>
    <AgentSettingsPage sectionId="diagnostics" showHeader={false} />
  </AppNavigationProvider>
);

const revealHiddenTools = () => {
  const show = (window as Window & { show?: unknown }).show;
  if (typeof show !== "function") throw new Error("show() helper is not installed");
  act(() => { show(); });
};

describe("multi-Bot diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    maxBots = 1;
    multiBotEnabled = true;
    currentSessionUser = {
      id: "usr-test", name: "Agent User", email: "user@example.com",
      inviteRequired: false, realnameVerified: true, realnameLevel: "idcard_2fa",
      createdAt: "2026-08-20T00:00:00.000Z",
    };
    bots = [buildBot(), { ...buildBot(), id: "sales", profileId: "sales", isDefault: false, name: "Sales" }];
    getRescueExportStatus.mockResolvedValue(null);
    getHermesImportStatus.mockResolvedValue(null);
    execDebugCommand.mockResolvedValue({ status: "SUCCESS", exitCode: 0, output: "root log" });
  });
  afterEach(cleanup);

  it("only shows instance maintenance on main and scopes logs after switching", async () => {
    const view = render(page("ins-1"));
    await screen.findByText("Agent 备份与恢复");
    await waitFor(() => expect(getRescueExportStatus).toHaveBeenCalledWith("ins-1"));
    expect(screen.getAllByRole("button", { name: "执行" })[0]).toBeDisabled();
    fireEvent.click(screen.getAllByRole("button", {name:"查询"})[0]!);
    await screen.findByText("root log");
    expect(execDebugCommand).toHaveBeenLastCalledWith("ins-1", "hermes -p 'default' logs --since 1h");

    view.rerender(page("sales"));
    await waitFor(() => expect(screen.queryByText("Agent 备份与恢复")).not.toBeInTheDocument());
    const chatTab = screen.getByRole("tab", { name: "对话" });
    expect(chatTab).toBeDisabled();
    expect(chatTab).not.toHaveAttribute("title");
    expect(chatTab).toHaveAccessibleDescription("对话功能目前仅支持主 Bot");
    expect(screen.getByRole("tooltip", { name: "对话功能目前仅支持主 Bot" })).toHaveClass("lv-agent-action-tooltip");
    expect(screen.queryByText("重装 Agent（保留数据）")).not.toBeInTheDocument();
    expect(screen.queryByText("root log")).not.toBeInTheDocument();
    expect(resetInstanceConfig).not.toHaveBeenCalled();
    execDebugCommand.mockResolvedValue({status:"SUCCESS", exitCode:0, output:"sales log"});
    fireEvent.click(screen.getAllByRole("button", {name:"查询"})[0]!);
    await screen.findByText("sales log");
    expect(execDebugCommand).toHaveBeenLastCalledWith("sales", "hermes -p 'sales' logs --since 1h");
    expect(getRescueExportStatus.mock.calls.every(([id]) => id === "ins-1")).toBe(true);
  });

  it("retains instance backup progress and disables maintenance when returning from a sibling", async () => {
    getRescueExportStatus.mockResolvedValue({phase:"prepare_archive",logs:[{message:"shared backup progress",level:"info"}]});
    const view = render(page("ins-1"));
    await screen.findByText("当前已有 Agent 备份任务运行中。");
    getRescueExportStatus.mockImplementation(() => new Promise(() => {}));
    view.rerender(page("sales"));
    await waitFor(() => expect(screen.queryByText("Agent 备份与恢复")).not.toBeInTheDocument());
    view.rerender(page("ins-1"));
    await screen.findByText("当前已有 Agent 备份任务运行中。");
    const maintenance = screen.getAllByRole("button", {name:"执行"});
    expect(maintenance.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(startRescueExport).not.toHaveBeenCalled();
  });

  it("keeps single-Bot maintenance available and new-Bot creation hidden", async () => {
    bots = [buildBot()];
    render(page("ins-1"));
    await waitFor(() => expect(screen.getAllByRole("button", {name:"执行"})[0]).toBeEnabled());
    expect(screen.queryByRole("button", {name:"新建 Bot"})).not.toBeInTheDocument();
    expect(screen.getByRole("button", {name:"备份到邮箱"})).toBeEnabled();
  });

  it("reveals Bot creation with show() and resets visibility on page remount", async () => {
    maxBots = 5;
    const view = render(page("ins-1"));
    expect(screen.queryByRole("button", { name: "新建 Bot" })).not.toBeInTheDocument();
    revealHiddenTools();
    fireEvent.click(screen.getByRole("button", { name: "新建 Bot" }));
    expect(await screen.findByText("创建 Bot")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    view.rerender(page("sales"));
    expect(screen.getByRole("button", { name: "新建 Bot" })).toBeInTheDocument();
    view.unmount();
    render(page("ins-1"));
    expect(screen.queryByRole("button", { name: "新建 Bot" })).not.toBeInTheDocument();
  });

  it("keeps the create button visible but disabled with a quota tooltip at capacity", () => {
    maxBots = 1;
    render(page("ins-1"));
    revealHiddenTools();
    const createButton = screen.getByRole("button", { name: "新建 Bot" });
    expect(createButton).toBeDisabled();
    expect(createButton).toHaveTextContent("新建 Bot");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "当前套餐最多可创建 1 个 Bot（含主 Bot），请升级套餐或删除已有 Bot 后再创建。",
    );
  });

  it("does not bypass the feature flag with show()", () => {
    maxBots = 5;
    multiBotEnabled = false;
    render(page("ins-1"));
    revealHiddenTools();
    expect(screen.queryByRole("button", { name: "新建 Bot" })).not.toBeInTheDocument();
  });
});
