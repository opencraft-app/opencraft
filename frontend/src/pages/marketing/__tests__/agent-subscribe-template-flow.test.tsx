import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenClawBot } from "@/contexts/agent-context";
import type { User } from "@/domain/types";
import { AppNavigationProvider, type AppNavigationValue } from "@/lib/app-navigation";
import { AgentSettingsPage } from "@/pages/marketing/agent-settings-page";

const addBot = vi.fn();
const navigateMock = vi.fn();
const execDebugCommand = vi.fn();
const testRegion = vi.hoisted(() => ({ isCN: true, isGlobal: false }));

let currentSessionUser: User;
let bots: OpenClawBot[] = [];

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
      plan: { name: "启航套餐", tier: "plus", trialDays: 7, aiCredits: 1000, usedCredits: 0, totalRequests: 0, maxBots: 5 },
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
    name: "育儿参谋",
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

/*
 * 订阅路径下「点模板 → 进配置流程」的端到端守卫。
 *
 * 真实故障：订阅后 URL 是 ?creating=<id>，而实例是后端随订阅建好的、进页面
 * 就已 running。页面上有三个 effect 会因此判定「创建已完成」：两个关 loading、
 * 一个把 URL 从 ?creating= 改写成 ?bot=。creatingParam 一消失，
 * showEarlyOnboarding 转 false，引导面板连同 activeTemplate / phase 一起被
 * 卸载 —— 用户点模板后毫无反应，或被弹回表单，配置一步都没跑。
 *
 * 修法是「引导一旦渲染就上锁」（onboardingLockRef），三个 effect 都让位。
 * 用 ref 而非 state：要在同一帧生效，setState 的批处理会留出窗口让 effect 抢跑。
 *
 * 这条测试走真实渲染而不是源码文本匹配 —— 前两轮我用文本断言修过同一个现象
 * 两次都没修对，因为断言只能证明「代码长这样」，证明不了「行为是对的」。
 */
describe("subscribe path: picking a template enters the setup flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    testRegion.isCN = true;
    testRegion.isGlobal = false;
    // 复现用户场景：订阅已建好实例，状态是 running
    bots = [buildBot()];
    currentSessionUser = {
      id: "usr-test", name: "Agent User", email: "user@example.com",
      inviteRequired: false, realnameVerified: true, realnameLevel: "idcard_2fa",
      createdAt: "2026-08-20T00:00:00.000Z",
    };
    execDebugCommand.mockResolvedValue({ status: "success", exitCode: 0, output: "" });
  });
  afterEach(cleanup);

  it.each(["running", "provisioning"] as const)("finishes setup for a %s target and opens its overview", async (status) => {
    bots = [{ ...buildBot(), status }];
    const view = render(page("?creating=ins-372"));

    // 先确认引导表单在
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "换一批" })).toBeInTheDocument();
    });


    // 点「育儿参谋」模板卡片（必须点 button 本身，不是里面的 span）
    const nameSpan = screen.getByText("育儿参谋", { selector: "span" });
    const card = nameSpan.closest("button");
    expect(card).not.toBeNull();
    fireEvent.click(card!);

    // 立刻观察一次（不等 waitFor 重试），看弹窗有没有开过
    await new Promise((r) => { setTimeout(r, 50); });
    // 模板详情弹窗要开得出来（面板没被卸载）
    expect(document.querySelector("[role=dialog]")).not.toBeNull();
    /*
     * 关键断言：URL 不能被改写。
     * 修复前这里是 2 次 navigate("/agents?bot=ins-372")，正是卸载的元凶。
     */
    expect(navigateMock).not.toHaveBeenCalled();

    // 点弹窗里的「创建」
    const createBtns = screen.queryAllByRole("button", { name: "创建" });
    fireEvent.click(createBtns[createBtns.length - 1]!);


    // 模拟实例从 provisioning 变 active，目标 profile 不能随过滤结果丢失。
    bots = [{ ...buildBot(), status: "running" }];
    view.rerender(page("?creating=ins-372"));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(
      "/agents/overview?bot=ins-372", { replace: true },
    ));
    expect(addBot).not.toHaveBeenCalled();
    expect(execDebugCommand.mock.calls.some(([id, command]) =>
      id === "ins-372" && command.includes("__CTL_SOUL_EOF__") && command.includes("profile-372"),
    )).toBe(true);
    expect(screen.queryByRole("button", { name: "换一批" })).not.toBeInTheDocument();
  });
});
