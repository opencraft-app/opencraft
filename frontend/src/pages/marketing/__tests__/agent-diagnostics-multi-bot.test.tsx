import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenClawBot } from "@/contexts/agent-context";
import type { User } from "@/domain/types";
import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";
import { setConsoleShowEnabled } from "@/lib/console-show-event";
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
  // 组件里用它按 locale 格式化日期（Intl），mock 固定成 zh-CN
  useCurrentLocale: () => "zh-CN",
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
  useCloudDesktopEnabled: () => false,
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

vi.mock("@/pages/marketing/agent-chat-panel", () => ({
  AgentChatPanel: () => null,
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

describe("multi-Bot diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConsoleShowEnabled(false);
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

  it("disables session repair while an instance restore is running", async () => {
    getHermesImportStatus.mockResolvedValue({phase:"wait_tat",logs:[{message:"shared restore progress",level:"info"}]});
    render(page("ins-1"));

    await screen.findByText("当前已有 Agent 恢复任务运行中。");
    const repairCard = screen.getByRole("heading", { name: "会话修复" }).closest("article");
    expect(repairCard).not.toBeNull();
    expect(within(repairCard!).getByRole("button", { name: "执行" })).toBeDisabled();
  });

  it("disables every other maintenance entry while session repair is running", async () => {
    let resolveRepair: ((value: { status: string; exitCode: number; output: string }) => void) | undefined;
    execDebugCommand.mockImplementation((_botId, command) => {
      if (!command.includes("sessions repair")) {
        return Promise.resolve({ status: "SUCCESS", exitCode: 0, output: "done" });
      }
      return new Promise<{ status: string; exitCode: number; output: string }>((resolve) => {
        resolveRepair = resolve;
      });
    });
    render(page("ins-1"));
    await screen.findByText("Agent 备份与恢复");

    const repairCard = screen.getByRole("heading", { name: "会话修复" }).closest("article");
    if (!repairCard) throw new Error("session repair card not found");
    fireEvent.click(within(repairCard).getByRole("button", { name: "执行" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "确认修复" }));
    expect(await within(repairCard).findByRole("button", { name: "修复中..." })).toBeDisabled();

    const resetConfigCard = screen.getByRole("heading", { name: "重置模型配置" }).closest("article");
    const resetAgentCard = screen.getByRole("heading", { name: "重置 Hermes（保留数据）" }).closest("article");
    if (!resetConfigCard || !resetAgentCard) throw new Error("maintenance card not found");
    await waitFor(() => {
      expect(within(resetConfigCard).getByRole("button", { name: "执行" })).toBeDisabled();
      expect(within(resetAgentCard).getByRole("button", { name: "执行" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "备份到邮箱" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "从备份恢复" })).toBeDisabled();
    });

    resolveRepair?.({ status: "SUCCESS", exitCode: 0, output: "repaired" });
    await waitFor(() => expect(within(resetConfigCard).getByRole("button", { name: "执行" })).toBeEnabled());
  });

  it("keeps single-Bot maintenance available and shows quota-disabled creation", async () => {
    bots = [buildBot()];
    const view = render(page("ins-1"));
    await waitFor(() => expect(screen.getAllByRole("button", {name:"执行"})[0]).toBeEnabled());
    expect(screen.getByRole("button", {name:"新建 Bot"})).toBeDisabled();
    expect(view.container.querySelector(".lv-agent-profile > .lucide-chevron-down")).not.toBeInTheDocument();
    expect(screen.getByText("重置 Hermes（保留数据）")).toBeInTheDocument();
    expect(screen.getByRole("button", {name:"备份到邮箱"})).toBeEnabled();
  });

  it("opens the onboarding panel from the create entry without a legacy dialog", async () => {
    maxBots = 5;
    render(page("ins-1"));
    // 入口常驻，不依赖 revealHiddenTools()
    const createButton = screen.getByRole("button", { name: "新建 Bot" });
    expect(createButton).toBeEnabled();
    fireEvent.click(createButton);
    /*
     * 现在点「新建 Bot」直接进创建引导（选头像 + 填名字），
     * 不再弹旧的「创建 Bot」弹窗 —— 那个弹窗只问名字，会让用户填两次。
     */
    // 「换一批」是引导页独有的头像操作，用它确认进的是引导而非旧弹窗
    expect(await screen.findByRole("button", { name: "换一批" })).toBeInTheDocument();
    expect(screen.queryByText("创建 Bot")).not.toBeInTheDocument();
    // 「空白创建」已从复制来源里移除，下拉只列可复制的 bot
    expect(screen.queryByRole("radio", { name: "空白创建" })).not.toBeInTheDocument();
  });

  /*
   * 从 master 侧冲突里拆出来的断言。
   *
   * master 那条测试把两件事写在一起：①隐藏工具仍需 show() ②点「新建 Bot」
   * 弹旧的「创建 Bot」弹窗。②与本分支的实现互斥（入口已改为直接进引导，
   * 见上一条），但①以及按钮顺序、remount 后入口不丢，都跟创建流程无关，
   * 是独立的有效约束 —— 所以单独留一条，不跟着弹窗一起丢掉。
   */
  it("still hides advanced tools behind show() and keeps the create entry across remounts", async () => {
    maxBots = 5;
    const view = render(page("ins-1"));
    expect(screen.getByRole("button", { name: "新建 Bot" })).toBeEnabled();
    // 「终端」这类高级工具仍藏在 console 的 show() 后面
    expect(screen.queryByRole("link", { name: "终端" })).not.toBeInTheDocument();
    const show = (window as Window & { show?: () => void }).show;
    expect(show).toBeTypeOf("function");
    act(() => show?.());
    expect(screen.getByRole("link", { name: "终端" })).toBeInTheDocument();
    expect(
      Array.from(view.container.querySelectorAll(".lv-agent-actions button"))
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["新建 Bot", "重启", "请先删除其他 Bot，再删除主 Bot"]);
    expect(view.container.querySelector(".lv-agent-profile > .lucide-chevron-down"))
      .toHaveAttribute("aria-hidden", "true");
    // 切换 bot 与整页重挂后，入口都不该消失
    view.rerender(page("sales"));
    expect(screen.getByRole("button", { name: "新建 Bot" })).toBeInTheDocument();
    view.unmount();
    render(page("ins-1"));
    expect(screen.getByRole("button", { name: "新建 Bot" })).toBeEnabled();
  });

  it("shows global Bot creation without show() while keeping advanced tools hidden", () => {
    maxBots = 5;
    testRegion.isCN = false;
    testRegion.isGlobal = true;
    const view = render(page("ins-1"));

    expect(screen.getByRole("button", { name: "新建 Bot" })).toBeEnabled();
    expect(screen.queryByRole("link", { name: "终端" })).not.toBeInTheDocument();
    const show = (window as Window & { show?: () => void }).show;
    expect(show).toBeTypeOf("function");
    act(() => show?.());

    expect(screen.getByRole("button", { name: "新建 Bot" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "终端" })).toBeInTheDocument();
    expect(Array.from(view.container.querySelectorAll(".lv-agent-actions button")).map((button) => button.getAttribute("aria-label"))).toEqual([
      "新建 Bot", "重启", "请先删除其他 Bot，再删除主 Bot",
    ]);
    maxBots = 1;
    view.rerender(page("ins-1"));
    expect(screen.getByRole("button", { name: "新建 Bot" })).toBeDisabled();
    multiBotEnabled = false;
    view.rerender(page("ins-1"));
    expect(screen.queryByRole("button", { name: "新建 Bot" })).not.toBeInTheDocument();
  });

  it("explains a disabled create icon in a portaled tooltip", async () => {
    maxBots = 1;
    render(page("ins-1"));
    const createButton = screen.getByRole("button", { name: "新建 Bot" });
    expect(createButton).toBeDisabled();
    const tooltipTrigger = createButton.parentElement;
    expect(tooltipTrigger).toHaveAttribute("tabindex", "0");
    fireEvent.focus(tooltipTrigger!);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(
      "当前套餐最多可创建 1 个 Bot（含主 Bot），请升级套餐或删除已有 Bot 后再创建。",
    );
    expect(tooltip.parentElement).toBe(document.body);
    fireEvent.keyDown(tooltipTrigger!, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("rechecks the current quota when creation is submitted from the panel", async () => {
    bots = [buildBot()];
    maxBots = 2;
    const view = render(page("ins-1"));
    fireEvent.click(screen.getByRole("button", { name: "新建 Bot" }));
    expect(await screen.findByRole("button", { name: "换一批" })).toBeInTheDocument();

    /*
     * 这条守的保障没变，只是入口从旧弹窗换成了引导页：
     * 打开创建界面之后配额才被占满，此时提交必须重新校验、不能真的去建。
     * 否则用户会拿到一个后端拒绝的失败，或超额建出第三个 bot。
     */
    bots = [buildBot(), { ...buildBot(), id: "sales", profileId: "sales", isDefault: false, name: "Sales" }];
    view.rerender(page("ins-1"));
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(screen.getAllByText(
        "当前套餐最多可创建 2 个 Bot（含主 Bot），请升级套餐或删除已有 Bot 后再创建。",
      ).length).toBeGreaterThan(0);
    });
    expect(addBot).not.toHaveBeenCalled();
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

  it("does not bypass the multi-Bot feature flag", () => {
    maxBots = 5;
    multiBotEnabled = false;
    render(page("ins-1"));
    expect(screen.queryByRole("button", { name: "新建 Bot" })).not.toBeInTheDocument();
  });
});
