import React, { type ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* 国际站（isGlobal）专属用例。
   与 subscribe-page.test.tsx（国内站，不 mock region）分文件维护 ——
   vi.mock 是模块级全局的，同一文件无法让 isCN / isGlobal 两种语义并存：
   国内站用例断言 `{isCN && ...}` 渲染的「退款规则」链接，
   而本文件的支付回跳用例依赖 `if (!isGlobal) return;` 才能进入接管逻辑。
   拆分方式参照 login-modal.test.tsx / login-modal.global.test.tsx。 */

vi.mock("@/components/site/public-site-header", () => ({
  PublicSiteHeader: ({ authControls }: { authControls?: ReactNode }) => (
    <header>{authControls}</header>
  ),
}));

vi.mock("@/components/site/legal-footer", () => ({
  LegalFooter: () => <footer />,
}));

/* 可变的 agent-context 桩：支付回跳用例需要「已登录 + 未发货 → 发货」的状态迁移。 */
const openClawState = {
  isLoggedIn: false,
  isSubscribed: false,
  subscribe: vi.fn(),
  addBot: vi.fn(),
  bots: [] as { id: string; status: string }[],
  user: null as unknown,
  refreshPasses: vi.fn(),
  activePass: null as unknown,
  latestPass: null as unknown,
};

vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => openClawState,
}));

const sessionState = {
  authReady: true,
  isAuthenticated: false,
};

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    authReady: sessionState.authReady,
    isAuthenticated: sessionState.isAuthenticated,
    session: {
      stage: sessionState.isAuthenticated ? "authenticated" : "anonymous",
      user: null,
    },
  }),
}));

/* 登录态会走 listBundles 拉真实套餐；回跳用例要靠它拿到 planList 才能解析 pay_plan。 */
const listBundlesMock = vi.fn();

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    plans: {
      listBundles: listBundlesMock,
    },
  }),
}));

vi.mock("@/contexts/runtime-config-context", () => ({
  usePaidBillingEnabled: () => true,
  useRealnamePhoneVerificationEnabled: () => false,
}));

vi.mock("@/i18n/t", () => ({
  useLocaleOverride: () => null,
  useT: () => (zh: string) => zh,
}));

const navigateMock = vi.fn();

vi.mock("@/lib/app-navigation", () => ({
  AppLink: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useAppNavigate: () => navigateMock,
}));

/* 必须完整列出被依赖链引用的导出：vi.mock 会整体替换模块，
   只给 isGlobal 会让 constants/legal.ts 等的 `import { isCN }` 抛
   「No "isCN" export is defined」并导致组件渲染失败。
   导出清单与 login-modal.global.test.tsx 保持一致。 */
vi.mock("@/lib/region", () => ({
  REGION: "global",
  isCN: false,
  isGlobal: true,
  DEFAULT_LOCALE: "en-US",
  readLocaleFromPath: () => null,
  localizedPath: (path: string) => path,
  switchLocaleInPath: (path: string) => path,
  langPrefixRedirectTarget: () => null,
}));

const buildBundle = (bundleId: string, bundleName: string) => ({
  bundle_id: bundleId,
  bundle_name: bundleName,
  bundle_state: "ONLINE" as const,
  bundle_type: "ai",
  time_unit: "m" as const,
  time_span: 1,
  price: 4900,
  total_cost: 4900,
  real_total_cost: 4900,
  currency: "USD",
  credit: 10000,
  bundle_sales_available_count: 100,
  bundle_sales_total_count: 100,
});

const resetState = () => {
  openClawState.isLoggedIn = false;
  openClawState.isSubscribed = false;
  openClawState.subscribe = vi.fn();
  openClawState.addBot = vi.fn();
  openClawState.bots = [];
  openClawState.refreshPasses = vi.fn().mockResolvedValue(undefined);
  openClawState.activePass = null;
  openClawState.latestPass = null;
  sessionState.authReady = true;
  sessionState.isAuthenticated = false;
  listBundlesMock.mockReset();
  /* listBundles 直接返回 Bundle[]，不是 { bundles } 包装。 */
  listBundlesMock.mockResolvedValue([buildBundle("bundle_cruise_ai_01", "巡游 Cruise")]);
  navigateMock.mockReset();
  window.history.replaceState({}, "", "/subscribe");
};

describe("SubscribePage payment return", () => {
  beforeEach(resetState);
  /* 必须显式卸载：上一个用例的 paying 弹窗若残留在 document 里，
     后续用例的「不应出现开通提示」断言会误判。 */
  afterEach(cleanup);

  /**
   * 弹窗被拦截时支付走 window.location.assign，付款后 return_url 回到全新页面，
   * 原窗口的 paying 轮询已销毁。带 pay_return 标记才能重新接棒等发货。
   */
  it("resumes the activation wait when returning from the hosted payment page", async () => {
    (globalThis as { React?: typeof React }).React = React;
    sessionState.isAuthenticated = true;
    openClawState.isLoggedIn = true;
    window.history.replaceState({}, "", "/subscribe?pay_return=1&pay_plan=bundle_cruise_ai_01");

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    /* 进入等发货态：既没有二维码也没有 pay_url，展示「正在开通套餐」 */
    expect(await screen.findByText("正在开通套餐")).toBeInTheDocument();
    expect(screen.getByText("正在确认支付结果并开通套餐，完成后将自动跳转")).toBeInTheDocument();
    /* 回跳场景无支付页可重开，不能渲染死按钮 */
    expect(screen.queryByRole("button", { name: "重新打开支付页" })).not.toBeInTheDocument();
    /* query 必须被清掉，避免刷新重复触发轮询 */
    expect(window.location.search).toBe("");
  });

  it("ignores the marker when the plan cannot be resolved but still refreshes passes", async () => {
    (globalThis as { React?: typeof React }).React = React;
    sessionState.isAuthenticated = true;
    openClawState.isLoggedIn = true;
    window.history.replaceState({}, "", "/subscribe?pay_return=1&pay_plan=not-a-real-plan");

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    await waitFor(() => {
      expect(openClawState.refreshPasses).toHaveBeenCalled();
    });
    /* 找不到套餐时不进 paying，避免卡在一个永远等不到结果的弹窗里 */
    expect(screen.queryByText("正在开通套餐")).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("does not resume without the payment return marker", async () => {
    (globalThis as { React?: typeof React }).React = React;
    sessionState.isAuthenticated = true;
    openClawState.isLoggedIn = true;
    /* 关键：带上 pay_plan 但**不带** pay_return。
       若只断言「不进 paying」，删掉 pay_return 校验后本用例仍会通过
       （因为无标记时 pay_plan 也为空，同样走不进 paying），断言就失去了鉴别力。
       这里让 plan 可解析，从而把「标记校验」变成唯一的区分条件。 */
    window.history.replaceState({}, "", "/subscribe?pay_plan=bundle_cruise_ai_01");

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    await screen.findByText("巡游 Cruise");

    expect(screen.queryByText("正在开通套餐")).not.toBeInTheDocument();
    expect(openClawState.addBot).not.toHaveBeenCalled();
    /* 没有回跳标记时不应清理 query，说明 effect 完全没接管。 */
    expect(window.location.search).toBe("?pay_plan=bundle_cruise_ai_01");
  });
});
