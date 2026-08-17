import React, { type ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/region", () => ({
  isGlobal: true,
}));

const getCreditValue = (tab: HTMLElement) => {
  const text = tab.textContent?.trim() ?? "";
  if (text.startsWith("10000")) return "10000";
  if (text.startsWith("4500")) return "4500";
  if (text.startsWith("200")) return "200";
  if (text.startsWith("100")) return "100";
  return null;
};

const getCreditTabs = () =>
  screen
    .getAllByRole("tab")
    .filter((tab) => getCreditValue(tab) !== null);

const getCreditTab = (credit: string) => {
  const tab = getCreditTabs().find((item) => getCreditValue(item) === credit);
  if (!tab) throw new Error(`Missing ${credit} credit tab`);
  return tab;
};

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

describe("SubscribePage", () => {
  beforeEach(() => {
    cleanup();
    vi.resetModules();
    vi.unstubAllEnvs();
    resetState();
    (globalThis as { React?: typeof React }).React = React;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows low credit tiers first and selects them by default", async () => {
    const { SubscribePage } = await import("@next-site/subscribe-page");

    render(<SubscribePage />);

    await screen.findByRole("tab", { name: "4500" });

    await waitFor(() => {
      expect(getCreditTabs().map(getCreditValue)).toEqual([
        "100",
        "4500",
        "200",
        "10000",
      ]);
    });
    expect(getCreditTab("4500")).toHaveAttribute("aria-selected", "false");
    expect(getCreditTab("10000")).toHaveAttribute("aria-selected", "false");
    expect(getCreditTab("100")).toHaveAttribute("aria-selected", "true");
    expect(getCreditTab("200")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("14天免费体验")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "退款规则" })).toHaveAttribute(
      "href",
      "/docs/plans/#%E9%80%80%E6%AC%BE%E8%A7%84%E5%88%99",
    );
  });
});

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
