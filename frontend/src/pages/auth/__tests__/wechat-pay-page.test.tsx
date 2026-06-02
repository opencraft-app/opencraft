import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as oauthModule from "@/lib/oauth";
import { WeChatPayPage } from "@/pages/auth/wechat-pay-page";

const renderPage = (route = "/auth/wechat-pay") => {
  window.history.pushState({}, "", route);
  return render(
    <MemoryRouter initialEntries={[route]}>
      <WeChatPayPage />
    </MemoryRouter>,
  );
};

let redirectSpy: ReturnType<typeof vi.spyOn>;

describe("WeChatPayPage", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_AUTH_API_BASE_URL", "https://lightclaw.tech");
    redirectSpy = vi.spyOn(oauthModule, "redirectToOAuthStart").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("在微信内自动发起 base 授权获取 OpenID", () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 iPhone MicroMessenger/8.0.49",
      configurable: true,
    });

    renderPage();

    expect(screen.getByRole("heading", { name: "确认微信支付" })).toBeInTheDocument();
    expect(screen.getByText("等待后端支付参数接入。")).toBeInTheDocument();
    expect(screen.getByText("正在获取 OpenID")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "支付能力接入中" })).toBeDisabled();
    expect(redirectSpy).toHaveBeenCalledTimes(1);
    const redirected = new URL(redirectSpy.mock.calls[0]?.[0] ?? "");
    expect(`${redirected.origin}${redirected.pathname}`).toBe("https://lightclaw.tech/auth/oauth/wechat/start");
    expect(redirected.searchParams.get("mode")).toBe("official_account");
    expect(redirected.searchParams.get("scope")).toBe("base");
    expect(redirected.searchParams.get("return_to")).toBe("http://localhost:3000/auth/wechat-pay?openid_auth_attempted=1");
  });

  it("base 授权回跳仍没有 OpenID 时停止自动刷新", () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 iPhone MicroMessenger/8.0.49",
      configurable: true,
    });

    renderPage("/auth/wechat-pay?openid_auth_attempted=1");

    expect(screen.getByText("未能获取到 OpenID，请重新打开支付页面重试。")).toBeInTheDocument();
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("展示回跳里获取到的 OpenID", () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 iPhone MicroMessenger/8.0.49",
      configurable: true,
    });

    renderPage("/auth/wechat-pay?openid=o-lightvela-123");

    expect(screen.getByText("当前 OpenID")).toBeInTheDocument();
    expect(screen.getByText("o-lightvela-123")).toBeInTheDocument();
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("兼容 hash 中带回的 OpenID", () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 iPhone MicroMessenger/8.0.49",
      configurable: true,
    });

    renderPage("/auth/wechat-pay#openid=o-lightvela-hash");

    expect(screen.getByText("o-lightvela-hash")).toBeInTheDocument();
  });

  it("兼容微信命名的 OpenID 参数", () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 iPhone MicroMessenger/8.0.49",
      configurable: true,
    });

    renderPage("/auth/wechat-pay?wx_openid=o-lightvela-wx");

    expect(screen.getByText("o-lightvela-wx")).toBeInTheDocument();
  });

  it("普通浏览器提示在微信内打开", () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148 Safari/604.1",
      configurable: true,
    });

    renderPage();

    expect(screen.getByRole("heading", { name: "请在微信内打开" })).toBeInTheDocument();
    expect(screen.getByText("当前页面需要微信环境来获取 OpenID，请复制链接后在微信中打开。")).toBeInTheDocument();
    expect(screen.getByText("尚未获取到 OpenID")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "等待微信内打开" })).toBeDisabled();
  });
});
