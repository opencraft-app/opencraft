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
const resetToPlatformDefault = vi.fn();
const addBot = vi.fn();
const botRepository = { execDebugCommand, getRescueExportStatus, getHermesImportStatus, startRescueExport, resetInstanceConfig };
const testRegion = vi.hoisted(() => ({ isCN: true, isGlobal: false }));

let currentSessionUser: User;
let bots: OpenClawBot[] = [];
let maxBots = 1;
let multiBotEnabled = true;

vi.mock("@/i18n/t", () => ({
  t: (text: string) => (
    testRegion.isGlobal && text === "已有 Bot 正在删除中，请稍后刷新页面后再创建。"
      ? "A Bot is being deleted. Refresh the page in a moment before creating another."
      : text
  ),
  useT: () => (text: string) => (
    testRegion.isGlobal && text === "已有 Bot 正在删除中，请稍后刷新页面后再创建。"
      ? "A Bot is being deleted. Refresh the page in a moment before creating another."
      : text
  ),
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
    addBot,
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

vi.mock("@/pages/marketing/agent-model-config/model-config-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/pages/marketing/agent-model-config/model-config-client")>();
  return {
    ...actual,
    createHermesModelConfigClient: () => ({ resetToPlatformDefault }),
  };
});

vi.mock("@/components/site/product-chrome", () => ({
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
    testRegion.isCN = true;
    testRegion.isGlobal = false;
    currentSessionUser = {
      id: "usr-test", name: "Agent User", email: "user@example.com",
      inviteRequired: false, realnameVerified: true, realnameLevel: "idcard_2fa",
      createdAt: "2026-08-20T00:00:00.000Z",
    };
    bots = [buildBot(), { ...buildBot(), id: "sales", profileId: "sales", isDefault: false, name: "Sales" }];
    getRescueExportStatus.mockResolvedValue(null);
    getHermesImportStatus.mockResolvedValue(null);
    execDebugCommand.mockResolvedValue({ status: "SUCCESS", exitCode: 0, output: "root log" });
    resetInstanceConfig.mockResolvedValue({
      keyId: "key-default",
      keyPrefix: "sk-default",
      config: {
        providerName: "custom",
        baseUrl: "https://gateway.lightvela.test/v1",
        modelId: "auto",
        api: "chat_completions",
        apiKey: "platform-default-secret",
      },
    });
    resetToPlatformDefault.mockResolvedValue({ primary: null, fallbacks: [], configuredModels: [] });
    addBot.mockResolvedValue({ ...buildBot(), id: "created", profileId: "created", isDefault: false });
  });
  afterEach(cleanup);

  it("only shows instance maintenance on main and scopes logs after switching", async () => {
    const view = render(page("ins-1"));
    await screen.findByText("Agent 备份与恢复");
    expect(screen.getByText("查看 Hermes Agent 日志，并集中执行相关维护操作")).toBeInTheDocument();
    await waitFor(() => expect(getRescueExportStatus).toHaveBeenCalledWith("ins-1"));
    expect(screen.getAllByRole("button", { name: "执行" })[0]).toBeEnabled();
    fireEvent.click(screen.getAllByRole("button", {name:"查询"})[0]!);
    await screen.findByText("root log");
    expect(execDebugCommand).toHaveBeenLastCalledWith("ins-1", "hermes -p 'default' logs --since 1h -n 50");

    view.rerender(page("sales"));
    await waitFor(() => expect(screen.queryByText("Agent 备份与恢复")).not.toBeInTheDocument());
    expect(screen.getByText("查看当前 Bot 的日志和模型配置；Agent 级维护请在主 Bot 中操作")).toBeInTheDocument();
    const chatTab = screen.getByRole("tab", { name: "对话" });
    expect(chatTab).toBeDisabled();
    expect(chatTab).not.toHaveAttribute("title");
    expect(chatTab).toHaveAccessibleDescription("对话功能目前仅支持主 Bot");
    expect(screen.getByRole("tooltip", { name: "对话功能目前仅支持主 Bot" })).toHaveClass("lv-agent-action-tooltip");
    expect(screen.queryByText("重置 Hermes（保留数据）")).not.toBeInTheDocument();
    expect(screen.queryByText("root log")).not.toBeInTheDocument();
    expect(resetInstanceConfig).not.toHaveBeenCalled();
    execDebugCommand.mockResolvedValue({status:"SUCCESS", exitCode:0, output:"sales log"});
    fireEvent.click(screen.getAllByRole("button", {name:"查询"})[0]!);
    await screen.findByText("sales log");
    expect(execDebugCommand).toHaveBeenLastCalledWith("sales", "hermes -p 'sales' logs --since 1h -n 50");
    expect(getRescueExportStatus.mock.calls.every(([id]) => id === "ins-1")).toBe(true);
  });

  it("resets only the selected named Profile with the platform default key", async () => {
    render(page("sales"));

    const card = (await screen.findByRole("heading", { name: "重置模型配置" })).closest("article");
    expect(card).not.toBeNull();
    const execute = card!.querySelector("button") as HTMLButtonElement;
    expect(execute).toBeEnabled();
    fireEvent.click(execute);
    fireEvent.click(await screen.findByRole("button", { name: "确认重置" }));

    await waitFor(() => expect(resetInstanceConfig).toHaveBeenCalledWith("sales"));
    expect(resetToPlatformDefault).toHaveBeenCalledWith({
      apiKey: "platform-default-secret",
      model: {
        id: "auto",
        providerKey: "custom",
        providerName: "custom",
        baseUrl: "https://gateway.lightvela.test/v1",
        routeBaseUrl: "https://gateway.lightvela.test/v1",
        apiMode: "chat_completions",
        keyEnv: "",
      },
    });
    expect(execDebugCommand).toHaveBeenCalledWith("sales", "acli gateway restart --agent 'sales'");
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
    expect(screen.getByText("重置 Hermes（保留数据）")).toBeInTheDocument();
    expect(screen.getByRole("button", {name:"备份到邮箱"})).toBeEnabled();
  });

  it("reveals Bot creation with show() and resets visibility on page remount", async () => {
    maxBots = 5;
    const view = render(page("ins-1"));
    expect(screen.queryByRole("button", { name: "新建 Bot" })).not.toBeInTheDocument();
    revealHiddenTools();
    fireEvent.click(screen.getByRole("button", { name: "新建 Bot" }));
    expect(await screen.findByText("创建 Bot")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "空白创建" }));
    expect(screen.getByText("主 Bot 当前主模型及其 Provider 凭据")).toBeInTheDocument();
    expect(screen.getByText("备用模型、其他已配置模型、人设、记忆、Skills、通道和定时任务")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    view.rerender(page("sales"));
    expect(screen.getByRole("button", { name: "新建 Bot" })).toBeInTheDocument();
    view.unmount();
    render(page("ins-1"));
    expect(screen.queryByRole("button", { name: "新建 Bot" })).not.toBeInTheDocument();
  });

  it("shows the disabled create quota tooltip below the button without sidebar clipping", async () => {
    maxBots = 1;
    render(page("ins-1"));
    revealHiddenTools();
    const createButton = screen.getByRole("button", { name: "新建 Bot" });
    expect(createButton).toBeDisabled();
    expect(createButton).toHaveTextContent("新建 Bot");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    const tooltipTrigger = createButton.parentElement;
    expect(tooltipTrigger).not.toBeNull();
    Object.defineProperty(tooltipTrigger, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 84,
        right: 304,
        top: 275,
        bottom: 311,
        width: 220,
        height: 36,
        x: 84,
        y: 275,
        toJSON: () => ({}),
      }),
    });
    fireEvent.mouseEnter(tooltipTrigger!);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(
      "当前套餐最多可创建 1 个 Bot（含主 Bot），请升级套餐或删除已有 Bot 后再创建。",
    );
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip).toHaveClass("fixed");
    expect(tooltip).toHaveStyle({ left: "194px", top: "319px" });
    expect(tooltipTrigger).toHaveAttribute("aria-describedby", tooltip.id);
    expect(tooltip.querySelector("[aria-hidden='true']")).toHaveClass("bottom-full");

    fireEvent.keyDown(tooltipTrigger!, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.focus(tooltipTrigger!);
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
  });

  it("rechecks the current quota when the create dialog is confirmed", async () => {
    bots = [buildBot()];
    maxBots = 2;
    const view = render(page("ins-1"));
    revealHiddenTools();
    fireEvent.click(screen.getByRole("button", { name: "新建 Bot" }));
    expect(await screen.findByText("创建 Bot")).toBeInTheDocument();

    bots = [buildBot(), { ...buildBot(), id: "sales", profileId: "sales", isDefault: false, name: "Sales" }];
    view.rerender(page("ins-1"));
    fireEvent.click(screen.getByRole("button", { name: "确认创建" }));

    expect(addBot).not.toHaveBeenCalled();
    expect(screen.getAllByText(
      "当前套餐最多可创建 2 个 Bot（含主 Bot），请升级套餐或删除已有 Bot 后再创建。",
    ).length).toBeGreaterThan(0);
  });

  it("localizes the deleting-Bot limit message on the global empty state", () => {
    testRegion.isCN = false;
    testRegion.isGlobal = true;
    multiBotEnabled = false;
    bots = [{ ...buildBot(), status: "deleting" }];

    render(page("ins-1"));

    expect(screen.getByText(
      "A Bot is being deleted. Refresh the page in a moment before creating another.",
    )).toBeInTheDocument();
    expect(screen.queryByText("已有 Bot 正在删除中，请稍后刷新页面后再创建。")).not.toBeInTheDocument();
  });

  it("does not bypass the feature flag with show()", () => {
    maxBots = 5;
    multiBotEnabled = false;
    render(page("ins-1"));
    revealHiddenTools();
    expect(screen.queryByRole("button", { name: "新建 Bot" })).not.toBeInTheDocument();
  });
});
