import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AGENTS_HOME_PATH, SUBSCRIBE_PATH } from "@/lib/agent-routes";

/* ── mocks ── */

const routerPushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
}));

const sessionState = {
  authReady: true,
  isAuthenticated: false,
};
vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    authReady: sessionState.authReady,
    isAuthenticated: sessionState.isAuthenticated,
  }),
}));

const openClawState = {
  bots: [] as { id: string }[],
  hasResolvedPasses: true,
  isSubscribed: false,
  passesError: false,
  passesLoading: false,
  refreshPasses: vi.fn(),
};
vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => openClawState,
}));

const regionState = vi.hoisted(() => ({ isGlobal: false }));
vi.mock("@/lib/region", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/region")>()),
  get isGlobal() { return regionState.isGlobal; },
}));

/* 被测 hook 在上面 mock 之后再导入，确保 mock 生效。 */
import {
  armPostLoginRedirect,
  disarmPostLoginRedirect,
  REOPEN_PRICING_MODAL_EVENT,
  usePostLoginRedirect,
} from "../use-post-login-redirect";

const resetState = () => {
  window.localStorage.removeItem("lightvela:bot-created:u1");
  regionState.isGlobal = false;
  routerPushMock.mockClear();
  openClawState.refreshPasses.mockReset();
  sessionState.authReady = true;
  sessionState.isAuthenticated = false;
  openClawState.bots = [];
  openClawState.hasResolvedPasses = true;
  openClawState.isSubscribed = false;
  openClawState.passesError = false;
  openClawState.passesLoading = false;
  disarmPostLoginRedirect();
};

beforeEach(resetState);
afterEach(resetState);

describe("usePostLoginRedirect — OAuth 整页跳转回跳分流", () => {
  it.each(["en-US", "zh-SG", "zh-Hant", "id-ID", "es", "ja-JP", "ko-KR"] as const)(
    "global %s: both login paths open first-bot creation without a locale prefix",
    async (locale) => {
      regionState.isGlobal = true;
      sessionState.isAuthenticated = true;
      openClawState.isSubscribed = true;
      armPostLoginRedirect();
      const { result } = renderHook(() => usePostLoginRedirect({ locale }));
      await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith("/agents?create=1"));
      expect(sessionStorage.getItem("lc_post_login_redirect")).toBeNull();

      routerPushMock.mockClear();
      act(() => result.current());
      await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith("/agents?create=1"));
    },
  );

  it("armed + 已登录已订阅：回跳后自动分流到控制台 /agents", async () => {
    // 用户点登录前 arm（OAuth 整页跳转），回跳后已是登录态且已订阅
    armPostLoginRedirect();
    sessionState.isAuthenticated = true;
    openClawState.isSubscribed = true;
    openClawState.bots = [{ id: "bot-1" }];

    renderHook(() => usePostLoginRedirect({ locale: "zh-CN" }));

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith(AGENTS_HOME_PATH);
    });
    // 消费后意图应被清除，避免二次误触发
    expect(sessionStorage.getItem("lc_post_login_redirect")).toBeNull();
  });

  it("returns a subscribed account with no current Bot to creation regardless of browser history", async () => {
    window.localStorage.setItem("lightvela:bot-created:u1", "1");
    armPostLoginRedirect();
    sessionState.isAuthenticated = true;
    openClawState.isSubscribed = true;

    renderHook(() => usePostLoginRedirect({ locale: "zh-CN" }));
    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith("/agents?create=1"));
  });

  it("armed + 已登录未订阅：回跳后留在订阅页 /subscribe", async () => {
    armPostLoginRedirect();
    sessionState.isAuthenticated = true;
    openClawState.isSubscribed = false;

    renderHook(() => usePostLoginRedirect({ locale: "zh-CN" }));

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith(SUBSCRIBE_PATH);
    });
  });

  it("returns an unsubscribed visitor to the pricing modal after OAuth", async () => {
    const reopen = vi.fn((event: Event) => { (event as CustomEvent<{ handled: boolean }>).detail.handled = true; });
    window.addEventListener(REOPEN_PRICING_MODAL_EVENT, reopen);
    try {
      sessionState.isAuthenticated = true;
      armPostLoginRedirect('pricing-modal');
      renderHook(() => usePostLoginRedirect({ locale: 'zh-CN' }));
      await waitFor(() => expect(reopen).toHaveBeenCalledTimes(1));
      expect(routerPushMock).not.toHaveBeenCalled();
      expect(sessionStorage.getItem('lc_post_login_redirect')).toBeNull();
    } finally {
      window.removeEventListener(REOPEN_PRICING_MODAL_EVENT, reopen);
    }
  });

  it("未 arm（未经登录动作）+ 已登录：不自动分流，避免误跳", async () => {
    // 已订阅用户只是正常访问，没有点过登录 → 不应被自动带走
    sessionState.isAuthenticated = true;
    openClawState.isSubscribed = true;
    openClawState.bots = [{ id: "bot-1" }];

    renderHook(() => usePostLoginRedirect({ locale: "zh-CN" }));

    await new Promise((r) => setTimeout(r, 50));
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("弹窗内登录成功（onSuccess → redirectAfterLogin）也分流", async () => {
    // 手机验证码登录：不整页跳转，靠 onSuccess 触发
    sessionState.isAuthenticated = true;
    openClawState.isSubscribed = true;
    openClawState.bots = [{ id: "bot-1" }];

    const { result } = renderHook(() => usePostLoginRedirect({ locale: "zh-CN" }));
    result.current();

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith(AGENTS_HOME_PATH);
    });
  });

  it("waits for this refresh before using a previously resolved entitlement", async () => {
    sessionState.isAuthenticated = true;
    openClawState.isSubscribed = true;
    let finishRefresh: (() => void) | undefined;
    openClawState.refreshPasses.mockImplementation(() => new Promise<void>((resolve) => { finishRefresh = resolve; }));
    const { result } = renderHook(() => usePostLoginRedirect({ locale: "zh-CN" }));

    await act(async () => { result.current(); });
    expect(routerPushMock).not.toHaveBeenCalled();
    expect(finishRefresh).toBeDefined();
    await act(async () => { finishRefresh?.(); });
    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith("/agents?create=1"));
  });

  it("keeps the current page and reports a failed entitlement refresh", async () => {
    sessionState.isAuthenticated = true;
    const onEntitlementUnavailable = vi.fn();
    openClawState.refreshPasses.mockImplementation(async () => { openClawState.passesError = true; });
    const { result, rerender } = renderHook(() => usePostLoginRedirect({ locale: "zh-CN", onEntitlementUnavailable }));

    await act(async () => { result.current(); });
    rerender();
    await waitFor(() => expect(onEntitlementUnavailable).toHaveBeenCalledTimes(1));
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  it("keeps the current page and reports a timed-out entitlement refresh", async () => {
    vi.useFakeTimers();
    try {
      sessionState.isAuthenticated = true;
      openClawState.hasResolvedPasses = false;
      const onEntitlementUnavailable = vi.fn();
      let finishRefresh: (() => void) | undefined;
      openClawState.refreshPasses.mockImplementation(() => new Promise<void>((resolve) => { finishRefresh = resolve; }));
      const { result } = renderHook(() => usePostLoginRedirect({ locale: "zh-CN", onEntitlementUnavailable }));

      await act(async () => { result.current(); });
      act(() => { vi.advanceTimersByTime(2501); });
      expect(onEntitlementUnavailable).toHaveBeenCalledTimes(1);
      openClawState.hasResolvedPasses = true;
      openClawState.isSubscribed = true;
      await act(async () => { finishRefresh?.(); });
      expect(routerPushMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
