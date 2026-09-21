/*
 * 创建 Bot 全路径回归测试。
 *
 * 为什么单独一份：之前几轮修「点模板不进流程」时，测试能过但真机一直失败，
 * 根因是 mock 失真 —— addBot 返回的实例状态不是 provisioning，而页面上那个
 * 「刷新恢复」effect（URL 没有 ?creating= 但后端有 provisioning 实例 → 把
 * isCreating 翻成 true）恰恰只在 provisioning 时触发。所以这里的 addBot
 * 严格模拟真实后端：先返回 provisioning，再转 running。
 *
 * 覆盖三条入口：
 *   A. 订阅回跳（URL 带 ?creating=<id>，实例已 running）
 *   B. 已有 bot 时点「新建 Bot」（多 bot 引导，实例现场创建）
 *   C. 空白创建（不选模板，直接填名字）
 * 每条都验证：面板不被重挂载、配置流程真的跑起来、引导独占整页。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenClawBot } from "@/contexts/agent-context";
import type { User } from "@/domain/types";
import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";
import { AgentSettingsPage } from "@/pages/marketing/agent-settings-page";

const navigateMock = vi.fn();
const execDebugCommand = vi.fn();
const testRegion = vi.hoisted(() => ({ isCN: true, isGlobal: false }));

let currentSessionUser: User;
let bots: OpenClawBot[] = [];
let addBotImpl: (params: { name: string; createMode?: string; sourceBotId?: string }) => Promise<OpenClawBot>;

const addBot = vi.fn((params: { name: string; createMode?: string; sourceBotId?: string }) => addBotImpl(params));

vi.mock("@/i18n/t", () => ({
  // 组件里用它按 locale 格式化日期（Intl），mock 固定成 zh-CN
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
      plan: {
        name: "启航套餐", tier: "plus", trialDays: 7,
        aiCredits: 1000, usedCredits: 0, totalRequests: 0, maxBots: 5,
      },
    },
    refreshBots: vi.fn(),
    refreshPasses: vi.fn(),
    isSubscribed: true,
    passesLoading: false,
    passesError: false,
    addBot,
    activePass: null,
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
        bot: { ...buildBot(id), status: "active" },
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

// 创建路径不测试聊天/通道 SDK，避免动态加载其浏览器 CSS。
vi.mock("@/pages/marketing/agent-chat-panel", () => ({ AgentChatPanel: () => null }));
vi.mock("@/pages/marketing/agent-channel-panel", () => ({ ChannelPanel: () => null }));

function buildBot(id = "ins-main", overrides: Partial<OpenClawBot> = {}): OpenClawBot {
  return {
    id,
    instanceId: id,
    profileId: `profile-${id}`,
    isDefault: true,
    name: "主 Bot",
    personality: "默认设定",
    personalityEmoji: "H",
    intro: "",
    status: "running",
    createdAt: "2026-09-18T00:00:00.000Z",
    connectedChannels: [],
    installedSkills: [],
    ...overrides,
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

/** 等引导表单出现（「换一批」是表单独有的头像操作） */
const waitForForm = () => waitFor(() => {
  expect(screen.getByRole("button", { name: "换一批" })).toBeInTheDocument();
});

/** 点模板卡片 → 弹窗 → 点「创建」 */
const pickTemplate = async (name: string) => {
  const span = screen.getByText(name, { selector: "span" });
  fireEvent.click(span.closest("button")!);
  await waitFor(() => {
    expect(document.querySelector("[role=dialog]")).not.toBeNull();
  });
  const buttons = screen.getAllByRole("button", { name: "创建" });
  fireEvent.click(buttons[buttons.length - 1]!);
};

const settle = (ms = 700) => new Promise((r) => { setTimeout(r, ms); });

/*
 * 断言配置清单已铺开。
 *
 * 用 textContent 而不是 getByText：CreatingLoadingView 外层是
 * framer-motion 的 motion.div，initial={{ opacity: 0 }} 在 jsdom 下不会被
 * 动画推进，getByText 会因「元素不可见」查不到，但节点其实已经渲染了。
 *
 * 判据取「正在保存 Bot 资料」—— 所有路径都有这一步；soul 那步的文案会随
 * 模式变化（写入人设 / 更新名称与简介），不适合做判据。
 */
const expectSetupRunning = () => waitFor(() => {
  const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
  // 进入配置视图（咖啡杯文案）即证明没被弹回表单
  expect(text).toMatch(/喂咖啡|已创建，但有/);
  // 且沙箱命令真的下发了
  expect(execDebugCommand.mock.calls.length).toBeGreaterThan(0);
}, { timeout: 3000 });

describe("create bot: all entry paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    testRegion.isCN = true;
    testRegion.isGlobal = false;
    currentSessionUser = {
      id: "usr-test", name: "Agent User", email: "user@example.com",
      inviteRequired: false, realnameVerified: true, realnameLevel: "idcard_2fa",
      createdAt: "2026-08-20T00:00:00.000Z",
    };
    execDebugCommand.mockResolvedValue({ status: "success", exitCode: 0, output: "" });
    /*
     * 严格模拟真实后端：新实例先是 provisioning。
     * 这一点是关键 —— 之前的 mock 直接给 running，把「刷新恢复」effect
     * 这条真实故障路径整个跳过了，导致测试能过而真机失败。
     */
    addBotImpl = async ({ name }) => {
      const id = `ins-new-${bots.length}`;
      const created = buildBot(id, {
        name,
        isDefault: false,
        status: "provisioning",
        // profileId 必须是真实的独立 profile：页面有个守卫，
        // 拿到空或 "main" 会判定「档案未就绪」并退回表单（防止写脏主 bot）
        profileId: `profile-${id}`,
      });
      bots = [...bots, created];
      return created;
    };
  });
  afterEach(cleanup);

  it("A. subscribe redirect: template pick runs the setup flow", async () => {
    bots = [buildBot("ins-sub", { name: "育儿参谋", status: "running" })];
    render(page("?creating=ins-sub"));
    await waitForForm();

    await pickTemplate("育儿参谋");
    await settle();

    // 不该被弹回表单
    expect(screen.queryByRole("button", { name: "换一批" })).not.toBeInTheDocument();
    // 已就绪的实例应完成配置并进入总览；不能把卡在进度页当成成功。
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(
      "/agents/overview?bot=ins-sub", { replace: true },
    ));
    expect(execDebugCommand.mock.calls.some(([id, command]) =>
      id === "ins-sub" && command.includes("__CTL_SOUL_EOF__"),
    )).toBe(true);
    expect(addBot).not.toHaveBeenCalled();
  });

  it("B. multi-bot: creating a second bot keeps the panel mounted", async () => {
    bots = [buildBot("ins-main", { name: "主 Bot" })];
    render(page("?bot=ins-main"));

    fireEvent.click(await screen.findByRole("button", { name: "新建 Bot" }));
    await waitForForm();

    await pickTemplate("育儿参谋");
    await settle();

    // 新实例是 provisioning —— 这正是「刷新恢复」effect 会翻转 isCreating 的时机
    expect(addBot).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "换一批" })).not.toBeInTheDocument();
    /*
     * 判据用「正在保存 Bot 资料」：它在所有路径下都有。
     * soul 那步的文案会随模式变（写入人设 / 更新名称与简介 / 保留模式），
     * 拿它当判据会误报成「流程没跑起来」。
     */
    await expectSetupRunning();
    expect(execDebugCommand.mock.calls.length).toBeGreaterThan(0);
  });

  it("B2. multi-bot onboarding takes over the whole page", async () => {
    bots = [buildBot("ins-main", { name: "主 Bot" })];
    render(page("?bot=ins-main"));

    fireEvent.click(await screen.findByRole("button", { name: "新建 Bot" }));
    await waitForForm();

    /*
     * 引导必须独占整页。
     * 真实故障：配置进度清单和「总览 / 我的 Bot」同屏出现 —— 设置区的条件
     * 只看 !isCreating && activeBot，没排除引导态。
     */
    expect(screen.queryByText("总览")).not.toBeInTheDocument();
    expect(screen.queryByText("我的 Bot")).not.toBeInTheDocument();
    expect(screen.queryByText("Skills panel")).not.toBeInTheDocument();
  });

  it("C. blank create: no template, just a name", async () => {
    bots = [buildBot("ins-main", { name: "主 Bot" })];
    render(page("?bot=ins-main"));

    fireEvent.click(await screen.findByRole("button", { name: "新建 Bot" }));
    await waitForForm();

    const nameInput = document.getElementById("lv-onboarding-name")!;
    fireEvent.change(nameInput, { target: { value: "空白小助手" } });
    // 表单自己的「创建」（不开模板弹窗）
    fireEvent.click(screen.getAllByRole("button", { name: "创建" })[0]!);
    await settle();

    expect(addBot).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "换一批" })).not.toBeInTheDocument();
    // 空白创建也要写资料
    await expectSetupRunning();
  });

  it("D. subscribe path onboarding also takes over the whole page", async () => {
    bots = [buildBot("ins-sub", { name: "育儿参谋", status: "running" })];
    render(page("?creating=ins-sub"));
    await waitForForm();

    expect(screen.queryByText("总览")).not.toBeInTheDocument();
    expect(screen.queryByText("Skills panel")).not.toBeInTheDocument();
  });
});
