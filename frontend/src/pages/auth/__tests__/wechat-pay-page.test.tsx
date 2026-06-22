/**
 * 单测：frontend/src/pages/auth/wechat-pay-page.tsx（OAuth 链路对齐跑通版 commit 82e35e22）
 *
 * 覆盖的状态机分支：
 *   - 无订单 query + 微信内 + 已拿 openid → openid-only 态展示 OpenID
 *   - 无订单 query + 微信内 + 未尝试 → 自动跳后端 OAuth start
 *   - 无订单 query + 微信内 + 已尝试仍无 openid → openid-only 态提示重试
 *   - 无订单 query + 非微信浏览器 → openid-only 态（不跳 OAuth，不报错）
 *   - 完整订单 query + 已过期 → expired 态
 *   - 完整订单 query + 非微信浏览器 → 保持 loading（不跳 OAuth、不调 order-url）
 *   - 完整订单 query + 微信内 + 有 openid + need_charge=0 → success 态
 *   - 完整订单 query + 微信内 + 有 openid + need_charge=1 → 调用 wxSign
 *   - 完整订单 query + 微信内 + 有 openid + order-url 失败 → error 态
 *   - 完整订单 query + 微信内 + 已尝试 OAuth 仍无 openid → 保持 loading（OAuth effect short-circuit）
 *   - 兼容 hash / 微信命名（wx_openid）的 openid 字段
 *   - 自定义 VITE_WECHAT_PAY_AUTH_BASE_URL 覆盖默认后端
 */
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as redirectModule from "@/lib/browser-redirect";
import * as wxSignModule from "@tencent/tcb-jssdk/lib/saasSdk/wxSign";
import type { CreatePassOrderUrlResult } from "@/domain/types";
import { WeChatPayPage } from "@/pages/auth/wechat-pay-page";

const renderPage = (route = "/auth/wechat-pay") => {
  window.history.pushState({}, "", route);
  return render(
    <MemoryRouter initialEntries={[route]}>
      <WeChatPayPage />
    </MemoryRouter>,
  );
};

const setUserAgent = (userAgent: string) => {
  Object.defineProperty(window.navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
};

const WECHAT_UA = "Mozilla/5.0 iPhone MicroMessenger/8.0.49";
const SAFARI_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148 Safari/604.1";

let redirectSpy: ReturnType<typeof vi.spyOn>;
let wxSignSpy: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn>;

const mockOrderUrlResult = (overrides: Partial<CreatePassOrderUrlResult> = {}): CreatePassOrderUrlResult => ({
  deal_name: "20260601000001",
  pay_url: "https://buy.cloud.tencent.com/pay?token=demo",
  token_id: "tok_demo_001",
  order_id: "midas_order_001",
  midas_app_id: "1450000123",
  need_charge: 1,
  uin: "1000000",
  app_id: "1257654321",
  ...overrides,
});

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.stubEnv("VITE_AUTH_API_BASE_URL", "https://api-sandbox-bj-7.lightclaw.tech");
  redirectSpy = vi.spyOn(redirectModule, "redirectBrowserTo").mockImplementation(() => undefined);
  wxSignSpy = vi.spyOn(wxSignModule, "wxSign").mockImplementation(() => undefined);
  fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: mockOrderUrlResult() }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("WeChatPayPage / 无订单 query（联调占位 / 旧行为兼容）", () => {
  it("微信内 + 未尝试授权 → 自动跳后端 OAuth start", () => {
    setUserAgent(WECHAT_UA);
    renderPage();

    expect(redirectSpy).toHaveBeenCalledTimes(1);
    const redirected = new URL(redirectSpy.mock.calls[0]?.[0] ?? "");
    expect(`${redirected.origin}${redirected.pathname}`).toBe("https://lightclaw.tech/auth/oauth/wechat/start");
    expect(redirected.searchParams.get("mode")).toBe("official_account");
    expect(redirected.searchParams.get("scope")).toBe("base");
    expect(redirected.searchParams.get("return_to")).toBe(
      "http://localhost:3000/auth/wechat-pay?openid_auth_attempted=1",
    );
  });

  it("微信内 + 已尝试授权仍无 openid → 进 openid-only 态提示重试", () => {
    setUserAgent(WECHAT_UA);
    renderPage("/auth/wechat-pay?openid_auth_attempted=1");

    expect(
      screen.getByText("未能获取到 OpenID，请重新打开支付页面重试。"),
    ).toBeInTheDocument();
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("微信内 + 已拿 openid → openid-only 态展示 openid", () => {
    setUserAgent(WECHAT_UA);
    renderPage("/auth/wechat-pay?openid=o-lightvela-123");

    expect(screen.getByText("当前 OpenID")).toBeInTheDocument();
    expect(screen.getByText("o-lightvela-123")).toBeInTheDocument();
    expect(redirectSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("兼容 hash 中带回的 openid", () => {
    setUserAgent(WECHAT_UA);
    renderPage("/auth/wechat-pay#openid=o-lightvela-hash");

    expect(screen.getByText("o-lightvela-hash")).toBeInTheDocument();
  });

  it("兼容微信命名 wx_openid", () => {
    setUserAgent(WECHAT_UA);
    renderPage("/auth/wechat-pay?wx_openid=o-lightvela-wx");

    expect(screen.getByText("o-lightvela-wx")).toBeInTheDocument();
  });

  it("非微信浏览器 → openid-only 态（OAuth effect short-circuit，不跳转）", () => {
    setUserAgent(SAFARI_UA);
    renderPage();

    /* 跑通版行为：非微信不跳 OAuth；本页仅进占位态提示仍未拿到 OpenID */
    expect(redirectSpy).not.toHaveBeenCalled();
    expect(
      screen.getByText("未能获取到 OpenID，请重新打开支付页面重试。"),
    ).toBeInTheDocument();
  });

  it("支持显式覆盖支付 OpenID 授权后端", () => {
    vi.stubEnv("VITE_WECHAT_PAY_AUTH_BASE_URL", "https://wechat-pay-auth.example.com/");
    setUserAgent(WECHAT_UA);
    renderPage();

    const redirected = new URL(redirectSpy.mock.calls[0]?.[0] ?? "");
    expect(`${redirected.origin}${redirected.pathname}`).toBe(
      "https://wechat-pay-auth.example.com/auth/oauth/wechat/start",
    );
  });
});

describe("WeChatPayPage / 完整支付链路（A 方案）", () => {
  /** 构造一个未过期的二维码 query；ttl=10 分钟 */
  const buildOrderQuery = (overrides: Record<string, string> = {}) => {
    const params = new URLSearchParams({
      d: "20260601000001",                          // dealName
      ac: "AC-7f3e4b29c1d24e6a9b1f0e8d7a5c4b30",   // authCode
      e: String(Date.now() + 10 * 60 * 1000),      // expiresAt
      n: "专业版套餐",                              // bundleName
      ...overrides,
    });
    return params.toString();
  };

  beforeEach(() => {
    vi.stubEnv("VITE_WX_BUY_HOST", "buy.cloud.tencent.com");
    vi.stubEnv("VITE_WX_PAY_PRODUCT_ID", "lightvela_pro_v1");
  });

  it("已过期 → expired 态（OAuth effect 与业务解耦，UI 显示 expired 即正确）", () => {
    setUserAgent(WECHAT_UA);
    const expired = new URLSearchParams({
      d: "20260601000001",
      e: String(Date.now() - 1000),
    });
    renderPage(`/auth/wechat-pay?${expired.toString()}`);

    /* 业务 effect 已识别过期并显示 expired 态 */
    expect(screen.getByRole("heading", { name: "二维码已失效" })).toBeInTheDocument();
    /* 关键：order-url 不应被调用（避免对已过期的 authCode 浪费请求） */
    expect(fetchMock).not.toHaveBeenCalled();
    /* 注意：OAuth effect 跟业务态解耦（对齐跑通版 commit 82e35e22 的单一职责），
       即使过期也会照常发 OAuth；这是预期行为，不影响最终 UI */
  });

  it("非微信浏览器 + 完整订单 → 保持 loading，不跳 OAuth、不调 order-url", () => {
    setUserAgent(SAFARI_UA);
    renderPage(`/auth/wechat-pay?${buildOrderQuery()}`);

    /* 对齐跑通版：OAuth effect 依赖 inWeChat，非微信环境下 short-circuit；业务 effect 因 !openId 不会跰order-url */
    expect(redirectSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    /* 页面停在 loading 态，由文案兜底 */
    expect(screen.getByText("正在准备支付...")).toBeInTheDocument();
  });

  it("微信内 + 无 openid + 未尝试 → 跳后端 OAuth", () => {
    setUserAgent(WECHAT_UA);
    renderPage(`/auth/wechat-pay?${buildOrderQuery()}`);

    expect(redirectSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("微信内 + 已尝试 OAuth 仍无 openid → 保持 loading（OAuth effect short-circuit，不陷死循环）", () => {
    setUserAgent(WECHAT_UA);
    renderPage(`/auth/wechat-pay?${buildOrderQuery({ openid_auth_attempted: "1" })}`);

    /* 跑通版行为：不重复跳 OAuth；业务 effect 因 !openId 也不跰 order-url；页面停在 loading */
    expect(redirectSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("正在准备支付...")).toBeInTheDocument();
  });

  it("零元订单（need_charge=0）→ success 态", async () => {
    setUserAgent(WECHAT_UA);
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: mockOrderUrlResult({ need_charge: 0 }) }));
    renderPage(`/auth/wechat-pay?${buildOrderQuery({ openid: "o-zero-charge" })}`);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api-sandbox-bj-7.lightclaw.tech/v1/passes/order-url");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      deal_names: ["20260601000001"],
      platform: "mobile",
      wx_open_id: "o-zero-charge",
      auth_code: "AC-7f3e4b29c1d24e6a9b1f0e8d7a5c4b30",
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "已完成" })).toBeInTheDocument();
    });
    expect(wxSignSpy).not.toHaveBeenCalled();
  });

  it("正常订单（need_charge=1）→ 调用 wxSign 拉起委托划扣，OpenId 字段使用后端返回 uin", async () => {
    setUserAgent(WECHAT_UA);
    renderPage(`/auth/wechat-pay?${buildOrderQuery({ openid: "o-real-charge" })}`);

    await waitFor(() => {
      expect(wxSignSpy).toHaveBeenCalledTimes(1);
    });
    const wxSignArgs = wxSignSpy.mock.calls[0]?.[0];
    expect(wxSignArgs).toMatchObject({
      BuyHost: "buy.cloud.tencent.com",
      Url: "https://buy.cloud.tencent.com/pay?token=demo",
      OpenId: "1000000",
      AppId: "1450000123",
      ProductId: "lightvela_pro_v1",
      Target: "_self",
      Close: true,
    });
  });

  it("续费场景（带 pid）→ 走 getRenewOrderUrl", async () => {
    setUserAgent(WECHAT_UA);
    renderPage(`/auth/wechat-pay?${buildOrderQuery({ openid: "o-renew", pid: "pass_2024_pro_001" })}`);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api-sandbox-bj-7.lightclaw.tech/v1/passes/pass_2024_pro_001/renew/order-url",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      deal_names: ["20260601000001"],
      platform: "mobile",
      wx_open_id: "o-renew",
      auth_code: "AC-7f3e4b29c1d24e6a9b1f0e8d7a5c4b30",
    });
  });

  it("order-url 接口失败 → error 态展示后端报错", async () => {
    setUserAgent(WECHAT_UA);
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "auth_code 已过期", code: "AUTH_CODE_INVALID" }, 400));
    /* 屏蔽 console.error 噪音 */
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderPage(`/auth/wechat-pay?${buildOrderQuery({ openid: "o-fail" })}`);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "支付遇到问题" })).toBeInTheDocument();
    });
    expect(screen.getByText(/auth_code 已过期/)).toBeInTheDocument();
    expect(wxSignSpy).not.toHaveBeenCalled();
  });

  it("loading 态：默认渲染 spinner + bundleName 标题 + 「正在准备支付...」", async () => {
    setUserAgent(WECHAT_UA);
    /* 让 order-url 永不 resolve，状态停留在 loading */
    fetchMock.mockReturnValueOnce(new Promise(() => undefined));
    renderPage(`/auth/wechat-pay?${buildOrderQuery({ openid: "o-pending" })}`);

    expect(screen.getByRole("heading", { name: "LightVela 专业版套餐 购买" })).toBeInTheDocument();
    expect(screen.getByText("正在准备支付...")).toBeInTheDocument();
  });

  it("oauth_error 出现时直接进 error 态", () => {
    setUserAgent(WECHAT_UA);
    renderPage(`/auth/wechat-pay?${buildOrderQuery({ oauth_error: "wechat_state_mismatch" })}`);

    expect(screen.getByRole("heading", { name: "支付遇到问题" })).toBeInTheDocument();
    expect(screen.getByText("微信授权失败，请重试。")).toBeInTheDocument();
    expect(redirectSpy).not.toHaveBeenCalled();
  });
});
