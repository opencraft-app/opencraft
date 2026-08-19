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
