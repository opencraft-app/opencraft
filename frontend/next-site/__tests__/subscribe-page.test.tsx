import React, { type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  beginPassUpgrade: vi.fn(),
  activePass: null as unknown,
  latestPass: null as unknown,
  /* usePostLoginRedirect（订阅页 LoginModal onSuccess 分流）所需的权益快照字段。 */
  hasResolvedPasses: true,
  passesLoading: false,
  passesError: false,
};

vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => openClawState,
}));

/* usePostLoginRedirect 使用 next/navigation 的 useRouter；测试环境需 mock 掉。 */
const routerPushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
}));

const sessionState = {
  authReady: true,
  isAuthenticated: false,
  user: null as { id?: string; realnameVerified?: boolean } | null,
};

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    authReady: sessionState.authReady,
    isAuthenticated: sessionState.isAuthenticated,
    session: {
      stage: sessionState.isAuthenticated ? "authenticated" : "anonymous",
      user: sessionState.user,
    },
  }),
}));

/* 登录态会走 listBundles 拉真实套餐；回跳用例要靠它拿到 planList 才能解析 pay_plan。 */
const listBundlesMock = vi.fn();
const createPassOrderMock = vi.fn();
const createDianshiPassOrderAndPayMock = vi.fn();
const listMyPassesMock = vi.fn();
const listModifyBundlesMock = vi.fn();
const getModifyCheckoutMock = vi.fn();
vi.mock("@/pages/marketing/upgrade-pass-modal", () => ({ UpgradePassModal: ({ targetBundleId, initialOption, onPaid }: { targetBundleId: string; initialOption?: { modify_price: { real_total_cost: number } }; onPaid: (checkout: { dealName: string; targetBundleId: string }) => void }) => <div role="dialog">Upgrade {targetBundleId}<span>Quote {initialOption?.modify_price.real_total_cost}</span><button onClick={() => onPaid({ dealName: "paid-upgrade", targetBundleId })}>模拟支付完成</button></div> }));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    plans: {
      listBundles: listBundlesMock,
      listMyPasses: listMyPassesMock,
      listModifyBundles: listModifyBundlesMock,
      getModifyCheckout: getModifyCheckoutMock,
      createPassOrder: createPassOrderMock,
      createDianshiPassOrderAndPay: createDianshiPassOrderAndPayMock,
    },
  }),
}));

vi.mock("@/contexts/runtime-config-context", () => ({
  usePaidBillingEnabled: () => true,
  useRealnamePhoneVerificationEnabled: () => false,
}));

vi.mock("@/i18n/t", () => ({
  useT: () => (zh: string) => zh,
  // LoginModal 等组件用 `useLocaleOverride() ?? i18n.language` 判定语言，
  // 返回 null 表示无路由级覆盖，保持用例原有语言行为。
  useLocaleOverride: () => null,
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

/* 本文件保持国内站语义（不 mock @/lib/region，沿用真实 REGION 默认 "cn"）：
   下方用例断言「退款规则」链接，而该链接由 subscribe-page 的 `{isCN && ...}` 条件渲染。
   国际站（isGlobal）专属用例请放到 subscribe-page.global.test.tsx，
   参照 login-modal.test.tsx / login-modal.global.test.tsx 的拆分约定 ——
   vi.mock 是模块级全局的，同一文件无法让两种站点语义并存。 */

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
  openClawState.beginPassUpgrade = vi.fn();
  openClawState.activePass = null;
  openClawState.latestPass = null;
  openClawState.hasResolvedPasses = true;
  openClawState.passesLoading = false;
  openClawState.passesError = false;
  routerPushMock.mockReset();
  sessionState.authReady = true;
  sessionState.isAuthenticated = false;
  sessionState.user = null;
  listBundlesMock.mockReset();
  listMyPassesMock.mockReset().mockResolvedValue([]);
  listModifyBundlesMock.mockReset().mockResolvedValue({ source_bundle_id: "", modify_bundle_set: [] });
  getModifyCheckoutMock.mockReset().mockResolvedValue({ checkout: null });
  createPassOrderMock.mockReset();
  createPassOrderMock.mockResolvedValue({
    deal_names: ["legacy-deal-1"],
    auth_code: "legacy-auth-code",
  });
  createDianshiPassOrderAndPayMock.mockReset();
  createDianshiPassOrderAndPayMock.mockResolvedValue({
    deal_name: "dianshi-deal-1",
    big_order_id: "dianshi-big-1",
  });
  /* listBundles 直接返回 Bundle[]，不是 { bundles } 包装。 */
  listBundlesMock.mockResolvedValue([buildBundle("bundle_cruise_ai_01", "巡游 Cruise")]);
  navigateMock.mockReset();
  window.history.replaceState({}, "", "/subscribe");
};

describe("SubscribePage", () => {
  /**
   * 源码契约：「我已完成支付」手动确认按钮已移除。
   * 轮询是唯一自动接棒途径（超时后也持续轮询），用户无需手动确认。
   * 用源码断言而非组件渲染：组件级用例曾在 7a6bf73ee 因测试站点语义冲突被重构移除。
   */
  it("no longer renders the manual pay-confirm button", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "next-site/subscribe-page.tsx"),
      "utf8",
    );
    expect(source).not.toContain("onManualConfirm");
    expect(source).not.toContain('t("我已完成支付")');
    /* 超时后不得停止轮询：按钮没了，轮询是唯一自动开通途径。 */
    const timeoutBlock = source.match(
      /Date\.now\(\) - startedAt > PAY_POLL_TIMEOUT_MS[\s\S]{0,400}?\n\s{6}\}/,
    )?.[0] ?? "";
    expect(timeoutBlock).not.toContain("clearInterval");
  });

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

  it("shows AI tiers first and selects them by default", async () => {
    const { SubscribePage } = await import("@next-site/subscribe-page");

    render(<SubscribePage />);

    await screen.findByRole("tab", { name: "4500" });

    await waitFor(() => {
      expect(getCreditTabs().map(getCreditValue)).toEqual([
        "4500",
        "100",
        "10000",
        "200",
      ]);
    });
    expect(getCreditTab("4500")).toHaveAttribute("aria-selected", "true");
    expect(getCreditTab("10000")).toHaveAttribute("aria-selected", "true");
    expect(getCreditTab("100")).toHaveAttribute("aria-selected", "false");
    expect(getCreditTab("200")).toHaveAttribute("aria-selected", "false");
    /* 启航 AI 默认选中且为首单免费 3 天（2026-09-02 国内站口径）：¥0 + 免费标签。
       巡游 AI 无免费试用，仍展示「首月 6 折」（合法共存，不做否定断言）。 */
    expect(screen.getAllByText("首单免费 3 天").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("14天免费体验")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "退款规则" })).toHaveAttribute(
      "href",
      "/docs/plans/#%E9%80%80%E6%AC%BE%E8%A7%84%E5%88%99",
    );
  });

  it("keeps quoted zero-price bundles on the legacy order flow in CN", async () => {
    openClawState.isLoggedIn = true;
    sessionState.isAuthenticated = true;
    sessionState.user = { realnameVerified: true };
    listBundlesMock.mockResolvedValue([
      {
        bundle_id: "bundle_launch_zero",
        bundle_name: "启航 Launch",
        description: [],
        bundle_state: "ONLINE",
        bundle_type: "general",
        agent_quota: 1,
        credit: 100,
        price: {
          price: 750,
          total_cost: 750,
          real_total_cost: 0,
          currency: "CNY",
          discount: 0,
        },
        time_span: 1,
        time_unit: "m",
        bundle_sales_available_count: 100,
        bundle_sales_total_count: 100,
        bundle_sales_state: "AVAILABLE",
      },
    ]);

    const { SubscribePage } = await import("@next-site/subscribe-page");
    const user = userEvent.setup();
    render(<SubscribePage />);

    await user.click(await screen.findByRole("button", { name: "免费订阅" }));
    expect(screen.getByRole("heading", { name: "确认订单" })).toBeInTheDocument();
    expect(screen.getByText("微信支付")).toBeInTheDocument();
    expect(screen.queryByText("信用卡支付")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /支付/ }));
    await waitFor(() => {
      expect(createPassOrderMock).toHaveBeenCalledWith({
        bundle_id: "bundle_launch_zero",
        period: 1,
        time_unit: "m",
      });
    });
    expect(createDianshiPassOrderAndPayMock).not.toHaveBeenCalled();
  });

  it("refreshes passes when an authenticated user opens the subscribe page", async () => {
    openClawState.isLoggedIn = true;
    sessionState.isAuthenticated = true;
    sessionState.user = { realnameVerified: true };

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    await waitFor(() => {
      expect(openClawState.refreshPasses).toHaveBeenCalledTimes(1);
    });
  });

  /* issue #73 红线：已订阅用户在订阅页登录成功后应自动跳控制台 /agents，不停在订阅页再次购买。
     覆盖两条登录路径：
     - OAuth 整页跳转：点订阅弹登录前 armPostLoginRedirect()，回跳后由 usePostLoginRedirect 消费分流；
     - 手机验证码弹窗内登录：LoginModal onSuccess → redirectAfterLogin()。
     这里做源码级断言，保证两条接线都不被回归掉；具体分流行为由 use-post-login-redirect.test 覆盖。 */
  it("wires post-login redirect (both OAuth-return and in-modal login) into the subscribe page", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "next-site/subscribe-page.tsx"),
      "utf8",
    );
    expect(source).toContain("usePostLoginRedirect");
    // OAuth 整页跳转路径：弹登录前 arm，关闭弹窗 disarm
    expect(source).toContain("armPostLoginRedirect()");
    expect(source).toContain("disarmPostLoginRedirect()");
    // 弹窗内登录路径：onSuccess 接 redirectAfterLogin
    expect(source).toContain("onSuccess={() => redirectAfterLogin()}");
  });

  it("disables subscription actions when an active pass is already present", async () => {
    openClawState.isLoggedIn = true;
    openClawState.activePass = {
      pass_id: "pass-existing",
      bundle_id: "bundle_cruise_ai_01",
    };
    sessionState.isAuthenticated = true;
    sessionState.user = { realnameVerified: true };

    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);

    expect(await screen.findByRole("button", { name: "当前订阅" })).toBeDisabled();
  });

  function setupUpgradeQuote() {
    openClawState.isLoggedIn = true;
    openClawState.isSubscribed = true;
    sessionState.isAuthenticated = true;
    sessionState.user = { id: "u1" };
    const pass = { status: "active", pass_id: "p1", user_id: "u1", bundle_id: "source", bundle_name: "启航", expired_time: "2099-01-01" };
    openClawState.activePass = pass;
    listMyPassesMock.mockResolvedValue([pass]);
    listBundlesMock.mockResolvedValue([
      { ...buildBundle("source", "启航 Launch"), bundle_type: "general", credit: 100 },
      { ...buildBundle("target", "巡游 Cruise"), bundle_type: "general", credit: 200 },
      { ...buildBundle("unrelated-target", "巡游 Cruise"), credit: 10000 },
    ]);
    const quote = { source_bundle_id: "source", modify_bundle_set: [{ target_bundle_id: "target", bundle: { bundle_id: "target", bundle_name: "巡游", cpu: 4, memory: 8, system_disk_size: 80, credit: 200 }, modify_price: { currency: "CNY", real_total_cost: 167 } }] };
    listModifyBundlesMock.mockResolvedValue(quote);
    return quote;
  }

  it("loads a fresh upgrade quote on the button before opening the populated modal", async () => {
    const quote = setupUpgradeQuote();
    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);
    const button = await screen.findByRole("button", { name: "升级至此套餐" });
    let resolveQuote!: (value: typeof quote) => void;
    listModifyBundlesMock.mockReturnValueOnce(new Promise(resolve => { resolveQuote = resolve; }));
    const reads = listModifyBundlesMock.mock.calls.length;
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveTextContent("正在查询升级差价...");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(listModifyBundlesMock).toHaveBeenCalledTimes(reads + 1);
    await act(async () => resolveQuote({ ...quote, modify_bundle_set: [{ ...quote.modify_bundle_set[0]!, modify_price: { currency: "CNY", real_total_cost: 234 } }] }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Quote 234");
    expect(button).toBeEnabled();
    expect(createPassOrderMock).not.toHaveBeenCalled();
  });

  it("keeps quote failures by the upgrade button and allows another attempt", async () => {
    setupUpgradeQuote();
    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);
    const button = await screen.findByRole("button", { name: "升级至此套餐" });
    listModifyBundlesMock.mockRejectedValueOnce(new Error("offline"));
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("升级询价失败，请稍后重试。");
    expect(screen.getByRole("alert")).not.toHaveTextContent("offline");
    expect(button.parentElement).toContainElement(screen.getByRole("alert"));
    expect(button).toBeEnabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(await screen.findByRole("dialog")).toHaveTextContent("Quote 167");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["source", "target", "price"])("does not open the upgrade modal for an invalid fresh %s", async (invalid) => {
    const quote = setupUpgradeQuote();
    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);
    const button = await screen.findByRole("button", { name: "升级至此套餐" });
    listModifyBundlesMock.mockResolvedValueOnce(invalid === "source" ? { ...quote, source_bundle_id: "changed" } : invalid === "target" ? { ...quote, modify_bundle_set: [] } : { ...quote, modify_bundle_set: [{ ...quote.modify_bundle_set[0]!, modify_price: { currency: "CNY", real_total_cost: NaN } }] });
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("当前套餐已变化或该升级目标暂不可用，请刷新后重试。");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it.each(["logout", "variant", "duration"])("ignores a late upgrade quote after %s", async (change) => {
    const quote = setupUpgradeQuote();
    const { SubscribePage } = await import("@next-site/subscribe-page");
    const { rerender } = render(<SubscribePage />);
    const button = await screen.findByRole("button", { name: "升级至此套餐" });
    let resolveQuote!: (value: typeof quote) => void;
    listModifyBundlesMock.mockReturnValueOnce(new Promise(resolve => { resolveQuote = resolve; }));
    await userEvent.click(button);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    if (change === "logout") { sessionState.isAuthenticated = false; rerender(<SubscribePage />); }
    else if (change === "variant") await userEvent.click(getCreditTab("10000"));
    else await userEvent.click(screen.getByRole("tab", { name: "季付" }));
    await act(async () => resolveQuote(quote));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "正在查询升级差价..." })).not.toBeInTheDocument();
  });

  it("keeps the newer quote loading when a cancelled request finishes", async () => {
    const quote = setupUpgradeQuote();
    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);
    const button = await screen.findByRole("button", { name: "升级至此套餐" });
    let resolveOld!: (value: typeof quote) => void;
    let resolveNew!: (value: typeof quote) => void;
    listModifyBundlesMock
      .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveNew = resolve; }));
    await userEvent.click(button);
    await userEvent.click(getCreditTab("10000"));
    await userEvent.click(getCreditTab("200"));
    await userEvent.click(button);
    await act(async () => resolveOld(quote));
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => resolveNew({ ...quote, modify_bundle_set: [{ ...quote.modify_bundle_set[0]!, modify_price: { currency: "CNY", real_total_cost: 345 } }] }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Quote 345");
    expect(button).toBeEnabled();
  });

  it("selects source and legal target by bundle ID, enabling only the upgrade checkout", async () => {
    openClawState.isLoggedIn = true;
    openClawState.isSubscribed = true;
    sessionState.isAuthenticated = true;
    sessionState.user = { id: "u1" };
    const pass = { status: "active", pass_id: "p1", user_id: "u1", bundle_id: "source", bundle_name: "启航", expired_time: "2099-01-01" };
    openClawState.activePass = pass;
    listMyPassesMock.mockResolvedValue([pass]);
    listBundlesMock.mockResolvedValue([
      { ...buildBundle("source", "启航 Launch"), bundle_type: "general", credit: 100 },
      { ...buildBundle("unrelated-ai", "启航 Launch"), credit: 4500 },
      { ...buildBundle("target", "巡游 Cruise"), bundle_type: "general", credit: 200 },
      { ...buildBundle("unrelated-target", "巡游 Cruise"), credit: 10000 },
    ]);
    listModifyBundlesMock.mockResolvedValue({ source_bundle_id: "source", modify_bundle_set: [{ target_bundle_id: "target", bundle: { bundle_id: "target", credit: 200 }, modify_price: { currency: "CNY", real_total_cost: 100 } }] });
    window.history.replaceState({}, "", "/subscribe/?upgrade_pass_id=p1");
    const { SubscribePage } = await import("@next-site/subscribe-page");
    const { rerender } = render(<SubscribePage />);
    const upgrade = await screen.findByRole("button", { name: "升级至此套餐" });
    expect(upgrade).toBeEnabled();
    expect(upgrade).toHaveStyle({ background: "rgba(0,0,0,0.90)", color: "#FFFFFF" });
    expect(screen.queryByRole("button", { name: "查看升级进度" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "当前订阅" })).toBeDisabled();
    expect(getCreditTab("100")).toHaveAttribute("aria-selected", "true");
    expect(getCreditTab("200")).toHaveAttribute("aria-selected", "true");
    // Unrelated variants remain independent. Selecting a legal target restores its source.
    await userEvent.click(getCreditTab("4500"));
    expect(getCreditTab("200")).toHaveAttribute("aria-selected", "true");
    await userEvent.click(getCreditTab("10000"));
    expect(getCreditTab("4500")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "升级至此套餐" })).not.toBeInTheDocument();
    await userEvent.click(getCreditTab("200"));
    expect(getCreditTab("100")).toHaveAttribute("aria-selected", "true");
    // The inverse direction is also a click interaction, not just an initial default.
    await userEvent.click(getCreditTab("10000"));
    await userEvent.click(getCreditTab("4500"));
    await userEvent.click(getCreditTab("100"));
    expect(getCreditTab("200")).toHaveAttribute("aria-selected", "true");
    await userEvent.click(upgrade);
    expect(await screen.findByRole("dialog")).toHaveTextContent("Upgrade target");
    expect(createPassOrderMock).not.toHaveBeenCalled();
    sessionState.isAuthenticated = false;
    rerender(<SubscribePage />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    sessionState.isAuthenticated = true;
    rerender(<SubscribePage />);
    await screen.findByRole("button", { name: "升级至此套餐" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("starts upgrade loading before navigating to agents as soon as payment is confirmed", async () => {
    openClawState.isLoggedIn = true;
    openClawState.isSubscribed = true;
    sessionState.isAuthenticated = true;
    sessionState.user = { id: "u1" };
    const pass = { status: "active", pass_id: "p1", user_id: "u1", bundle_id: "source", bundle_name: "启航", expired_time: "2099-01-01" };
    openClawState.activePass = pass;
    listMyPassesMock.mockResolvedValue([pass]);
    listBundlesMock.mockResolvedValue([
      { ...buildBundle("source", "启航 Launch"), bundle_type: "general", credit: 100 },
      { ...buildBundle("target", "巡游 Cruise"), bundle_type: "general", credit: 200 },
    ]);
    listModifyBundlesMock.mockResolvedValue({ source_bundle_id: "source", modify_bundle_set: [{ target_bundle_id: "target", bundle: { bundle_id: "target", credit: 200 }, modify_price: { currency: "CNY", real_total_cost: 100 } }] });
    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);
    await userEvent.click(await screen.findByRole("button", { name: "升级至此套餐" }));
    expect(navigateMock).not.toHaveBeenCalled();
    // Navigation must not wait for another Pass read, which can still be stale or unavailable.
    openClawState.refreshPasses.mockImplementation(() => new Promise(() => {}));
    await userEvent.click(screen.getByRole("button", { name: "模拟支付完成" }));
    expect(openClawState.beginPassUpgrade).toHaveBeenCalledWith(pass, { dealName: "paid-upgrade", targetBundleId: "target" });
    expect(navigateMock).toHaveBeenCalledWith("/agents");
    expect(openClawState.beginPassUpgrade.mock.invocationCallOrder[0]).toBeLessThan(navigateMock.mock.invocationCallOrder[0]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("allows a backend-approved target in the same card without a tier or SP assumption", async () => {
    openClawState.isLoggedIn = true;
    openClawState.isSubscribed = true;
    sessionState.isAuthenticated = true;
    sessionState.user = { id: "u1" };
    const pass = { status: "active", pass_id: "p1", user_id: "u1", bundle_id: "source", expired_time: "2099-01-01" };
    openClawState.activePass = pass;
    listMyPassesMock.mockResolvedValue([pass]);
    listBundlesMock.mockResolvedValue([
      { ...buildBundle("source", "启航 Launch"), bundle_type: "general", credit: 100 },
      { ...buildBundle("same-card-target", "启航 Launch"), credit: 4500 },
      { ...buildBundle("unrelated", "巡游 Cruise"), credit: 10000 },
    ]);
    listModifyBundlesMock.mockResolvedValue({ source_bundle_id: "source", modify_bundle_set: [{ target_bundle_id: "same-card-target", bundle: { bundle_id: "same-card-target", credit: 4500 }, modify_price: { currency: "CNY", real_total_cost: 100 } }] });
    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);
    await waitFor(() => expect(getCreditTab("100")).toHaveAttribute("aria-selected", "true"));
    await userEvent.click(getCreditTab("4500"));
    expect(getCreditTab("4500")).toHaveAttribute("aria-selected", "true");
    await userEvent.click(getCreditTab("100"));
    expect(getCreditTab("100")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "升级至此套餐" })).not.toBeInTheDocument();
    await userEvent.click(getCreditTab("4500"));
    await userEvent.click(screen.getByRole("button", { name: "升级至此套餐" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Upgrade same-card-target");
  });

  it("leaves original AI defaults and locked actions unchanged when backend returns no targets", async () => {
    openClawState.isLoggedIn = true;
    openClawState.isSubscribed = true;
    sessionState.isAuthenticated = true;
    sessionState.user = { id: "u1" };
    const pass = { status: "active", pass_id: "p1", user_id: "u1", bundle_id: "source", expired_time: "2099-01-01" };
    openClawState.activePass = pass;
    listMyPassesMock.mockResolvedValue([pass]);
    listBundlesMock.mockResolvedValue([
      { ...buildBundle("source", "启航 Launch"), bundle_type: "general", credit: 100 },
      { ...buildBundle("unrelated", "启航 Launch"), credit: 4500 },
      { ...buildBundle("cruise-standard", "巡游 Cruise"), bundle_type: "general", credit: 200 },
      { ...buildBundle("cruise-ai", "巡游 Cruise"), credit: 10000 },
    ]);
    listModifyBundlesMock.mockResolvedValue({ source_bundle_id: "source", modify_bundle_set: [] });
    const { SubscribePage } = await import("@next-site/subscribe-page");
    render(<SubscribePage />);
    await waitFor(() => expect(listModifyBundlesMock).toHaveBeenCalledWith("p1"));
    expect(getCreditTab("4500")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "升级至此套餐" })).not.toBeInTheDocument();
    await userEvent.click(getCreditTab("100"));
    expect(getCreditTab("10000")).toHaveAttribute("aria-selected", "true");
    await userEvent.click(getCreditTab("200"));
    expect(getCreditTab("100")).toHaveAttribute("aria-selected", "true");
  });

  it.each(["PASS_EXPIRED", "PASS_ISOLATED"])("links domestic %s errors to billing", async (code) => {
    openClawState.isLoggedIn = true;
    sessionState.isAuthenticated = true;
    sessionState.user = { realnameVerified: true };
    createPassOrderMock.mockRejectedValue(Object.assign(new Error(code), { code }));
    const { SubscribePage } = await import("@next-site/subscribe-page");
    const user = userEvent.setup();
    render(<SubscribePage />);
    await user.click(await screen.findByRole("button", { name: /订阅|开通/ }));
    await user.click(screen.getByRole("button", { name: /支付/ }));
    expect(await screen.findByRole("link", { name: "前往续费" })).toHaveAttribute("href", "/account/billing");
  });

  it("refreshes pass state and closes checkout when ordering reports an existing pass", async () => {
    openClawState.isLoggedIn = true;
    sessionState.isAuthenticated = true;
    sessionState.user = { realnameVerified: true };
    createPassOrderMock.mockRejectedValue(
      Object.assign(new Error("pass already exists"), { code: "PASS_ALREADY_EXISTS" }),
    );

    const { SubscribePage } = await import("@next-site/subscribe-page");
    const user = userEvent.setup();
    render(<SubscribePage />);

    await waitFor(() => {
      expect(openClawState.refreshPasses).toHaveBeenCalledTimes(1);
    });
    await user.click(await screen.findByRole("button", { name: /订阅|开通/ }));
    await user.click(screen.getByRole("button", { name: /支付/ }));

    await waitFor(() => {
      expect(openClawState.refreshPasses).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "确认订单" })).not.toBeInTheDocument();
    });
    expect(screen.queryByText("您已有有效套餐，无需重复购买。")).not.toBeInTheDocument();
  });
});
