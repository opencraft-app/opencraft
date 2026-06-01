import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WeChatPayPage } from "@/pages/auth/wechat-pay-page";

const renderPage = (route = "/auth/wechat-pay") => {
  window.history.pushState({}, "", route);
  return render(
    <MemoryRouter initialEntries={[route]}>
      <WeChatPayPage />
    </MemoryRouter>,
  );
};

describe("WeChatPayPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("在微信内展示支付承接占位状态", () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 iPhone MicroMessenger/8.0.49",
      configurable: true,
    });

    renderPage();

    expect(screen.getByRole("heading", { name: "确认微信支付" })).toBeInTheDocument();
    expect(screen.getByText("等待后端支付参数接入。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "支付能力接入中" })).toBeDisabled();
  });

  it("展示回跳里获取到的 OpenID", () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 iPhone MicroMessenger/8.0.49",
      configurable: true,
    });

    renderPage("/auth/wechat-pay?openid=o-lightvela-123");

    expect(screen.getByText("当前 OpenID")).toBeInTheDocument();
    expect(screen.getByText("o-lightvela-123")).toBeInTheDocument();
  });

  it("兼容 hash 中带回的 OpenID", () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 iPhone MicroMessenger/8.0.49",
      configurable: true,
    });

    renderPage("/auth/wechat-pay#openid=o-lightvela-hash");

    expect(screen.getByText("o-lightvela-hash")).toBeInTheDocument();
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
