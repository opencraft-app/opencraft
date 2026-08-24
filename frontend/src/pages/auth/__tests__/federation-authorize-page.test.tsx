import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FederationAuthorizePage } from "@/pages/auth/federation-authorize-page";

vi.mock("@/observability/posthog", () => ({
  captureProductEvent: vi.fn(),
  PRODUCT_ANALYTICS_EVENTS: {
    LOGIN_MODAL_OPENED: "login_modal_opened",
    OAUTH_PROVIDER_CLICKED: "oauth_provider_clicked",
  },
  PRODUCT_ANALYTICS_LOCATIONS: { LOGIN_MODAL: "login_modal" },
}));

const authorizeOIDC = vi.fn();
const getOIDCAuthorizationContext = vi.fn();
const navigate = vi.fn();
const prepareFederationSwitch = vi.fn();
const cancelFederationSwitch = vi.fn();
const OIDC_CLIENT_ID = "site-gateway";
const OIDC_CLIENT_NAME = "LightVela Sites";
const OIDC_REDIRECT_URI = "https://sites-auth.lightvela.site/auth/lightvela/callback";
let sessionState: {
  authReady: boolean;
  session: {
    stage: "anonymous" | "authenticated";
    user: {
      id: string;
      name: string;
      email?: string;
      avatarUrl?: string;
    } | null;
  };
};

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    auth: {
      getOIDCAuthorizationContext,
      getOAuthStartUrl: (provider: string) => `https://lightclaw.tech/auth/oauth/${provider}/start`,
      authorizeOIDC,
      prepareFederationSwitch,
      cancelFederationSwitch,
    },
  }),
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => sessionState,
}));

vi.mock("@/components/site/product-chrome", () => ({
  ProductPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("FederationAuthorizePage", () => {
  beforeEach(() => {
    sessionState = {
      authReady: true,
      session: { stage: "anonymous", user: null },
    };
    window.history.replaceState(
      {},
      "",
      `/auth/federation/authorize?client_id=${OIDC_CLIENT_ID}&redirect_uri=${encodeURIComponent(OIDC_REDIRECT_URI)}&state=state-1&response_type=code&scope=openid+profile&code_challenge=challenge-1&code_challenge_method=S256&nonce=nonce-1`,
    );
    getOIDCAuthorizationContext.mockReset().mockResolvedValue({
      clientId: OIDC_CLIENT_ID,
      clientDisplayName: OIDC_CLIENT_NAME,
      redirectUri: OIDC_REDIRECT_URI,
      state: "state-1",
      responseType: "code",
      scope: "openid profile",
      codeChallenge: "challenge-1",
      codeChallengeMethod: "S256",
      nonce: "nonce-1",
      currentSession: null,
    });
    authorizeOIDC.mockReset().mockResolvedValue({
      redirectUrl: `${OIDC_REDIRECT_URI}?code=server-code&state=state-1`,
      expiresAt: "2026-08-21T10:00:05Z",
    });
    navigate.mockReset();
    prepareFederationSwitch.mockReset().mockResolvedValue(undefined);
    cancelFederationSwitch.mockReset().mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  it("已登出时打开现有登录弹窗", async () => {
    render(<FederationAuthorizePage navigate={navigate} />);

    expect(await screen.findByRole("dialog", { name: "登录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "微信账号登录" })).toBeInTheDocument();
  });

  it("已登录时展示当前账号并只使用服务端签发的跳转地址", async () => {
    sessionState = {
      authReady: true,
      session: {
        stage: "authenticated",
        user: {
          id: "usr_123",
          name: "Ada",
          email: "ada@example.com",
          avatarUrl: "https://cdn.example.com/ada.png",
        },
      },
    };
    getOIDCAuthorizationContext.mockResolvedValue({
      clientId: OIDC_CLIENT_ID,
      clientDisplayName: OIDC_CLIENT_NAME,
      redirectUri: OIDC_REDIRECT_URI,
      state: "state-1",
      responseType: "code",
      scope: "openid profile",
      codeChallenge: "challenge-1",
      codeChallengeMethod: "S256",
      nonce: "nonce-1",
      currentSession: { user: sessionState.session.user },
    });
    render(<FederationAuthorizePage navigate={navigate} />);

    expect(await screen.findByRole("dialog", { name: "确认授权登录" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Ada" })).toHaveAttribute("src", "https://cdn.example.com/ada.png");
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续" }));

    await waitFor(() => {
      expect(authorizeOIDC).toHaveBeenCalledWith({
        clientId: OIDC_CLIENT_ID,
        redirectUri: OIDC_REDIRECT_URI,
        state: "state-1",
        responseType: "code",
        scope: "openid profile",
        codeChallenge: "challenge-1",
        codeChallengeMethod: "S256",
        nonce: "nonce-1",
      });
      expect(navigate).toHaveBeenCalledWith(
        `${OIDC_REDIRECT_URI}?code=server-code&state=state-1`,
      );
    });
  });

  it("切换账号可返回当前账号确认且不删除当前会话", async () => {
    sessionState = {
      authReady: true,
      session: {
        stage: "authenticated",
        user: { id: "usr_123", name: "Ada" },
      },
    };
    getOIDCAuthorizationContext.mockResolvedValue({
      clientId: OIDC_CLIENT_ID,
      clientDisplayName: OIDC_CLIENT_NAME,
      redirectUri: OIDC_REDIRECT_URI,
      state: "state-1",
      responseType: "code",
      scope: "openid profile",
      codeChallenge: "challenge-1",
      codeChallengeMethod: "S256",
      nonce: "nonce-1",
      currentSession: { user: sessionState.session.user },
    });
    render(<FederationAuthorizePage navigate={navigate} />);

    fireEvent.click(await screen.findByRole("button", { name: "切换其他账号" }));
    await waitFor(() => expect(prepareFederationSwitch).toHaveBeenCalledOnce());
    expect(await screen.findByRole("dialog", { name: "切换其他账号" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回使用当前账号" }));
    await waitFor(() => expect(cancelFederationSwitch).toHaveBeenCalledOnce());
    expect(await screen.findByRole("dialog", { name: "确认授权登录" })).toBeInTheDocument();
    expect(authorizeOIDC).not.toHaveBeenCalled();
  });

  it("切换账号时关闭登录先取消切换再返回来源网站", async () => {
    sessionState = {
      authReady: true,
      session: { stage: "authenticated", user: { id: "usr_123", name: "Ada" } },
    };
    getOIDCAuthorizationContext.mockResolvedValue({
      clientId: OIDC_CLIENT_ID,
      clientDisplayName: OIDC_CLIENT_NAME,
      redirectUri: OIDC_REDIRECT_URI,
      state: "state-1",
      responseType: "code",
      scope: "openid profile",
      codeChallenge: "challenge-1",
      codeChallengeMethod: "S256",
      nonce: "nonce-1",
      currentSession: { user: sessionState.session.user },
    });
    render(<FederationAuthorizePage navigate={navigate} />);

    fireEvent.click(await screen.findByRole("button", { name: "切换其他账号" }));
    const switchDialog = await screen.findByRole("dialog", { name: "切换其他账号" });
    fireEvent.click(within(switchDialog).getByRole("button", { name: "关闭" }));

    await waitFor(() => {
      expect(cancelFederationSwitch).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith(
        `${OIDC_REDIRECT_URI}?error=access_denied&state=state-1`,
      );
    });
    expect(cancelFederationSwitch.mock.invocationCallOrder[0]!).toBeLessThan(navigate.mock.invocationCallOrder[0]!);
  });

  it("取消切换接口失败时仍返回来源网站", async () => {
    sessionState = {
      authReady: true,
      session: { stage: "authenticated", user: { id: "usr_123", name: "Ada" } },
    };
    getOIDCAuthorizationContext.mockResolvedValue({
      clientId: OIDC_CLIENT_ID,
      clientDisplayName: OIDC_CLIENT_NAME,
      redirectUri: OIDC_REDIRECT_URI,
      state: "state-1",
      responseType: "code",
      scope: "openid profile",
      codeChallenge: "challenge-1",
      codeChallengeMethod: "S256",
      nonce: "nonce-1",
      currentSession: { user: sessionState.session.user },
    });
    cancelFederationSwitch.mockRejectedValueOnce(new Error("network unavailable"));
    render(<FederationAuthorizePage navigate={navigate} />);

    fireEvent.click(await screen.findByRole("button", { name: "切换其他账号" }));
    const switchDialog = await screen.findByRole("dialog", { name: "切换其他账号" });
    fireEvent.click(within(switchDialog).getByRole("button", { name: "关闭" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(
      `${OIDC_REDIRECT_URI}?error=access_denied&state=state-1`,
    ));
  });

  it("关闭确认只返回经过 context 校验的 callback 并附加 access_denied", async () => {
    sessionState = {
      authReady: true,
      session: {
        stage: "authenticated",
        user: { id: "usr_123", name: "Ada" },
      },
    };
    getOIDCAuthorizationContext.mockResolvedValue({
      clientId: OIDC_CLIENT_ID,
      clientDisplayName: OIDC_CLIENT_NAME,
      redirectUri: OIDC_REDIRECT_URI,
      state: "state-1",
      responseType: "code",
      scope: "openid profile",
      codeChallenge: "challenge-1",
      codeChallengeMethod: "S256",
      nonce: "nonce-1",
      currentSession: { user: sessionState.session.user },
    });
    render(<FederationAuthorizePage navigate={navigate} />);

    fireEvent.click(await screen.findByRole("button", { name: "关闭" }));

    expect(navigate).toHaveBeenCalledWith(
      `${OIDC_REDIRECT_URI}?error=access_denied&state=state-1`,
    );
  });

  it("context 校验失败时不跳转到原始查询参数中的 callback", async () => {
    getOIDCAuthorizationContext.mockRejectedValue(new Error("invalid callback"));
    render(<FederationAuthorizePage navigate={navigate} />);

    expect(await screen.findByText("无法验证授权请求，请返回来源网站重试。")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("请求缺少 OIDC 必填参数时直接显示验证失败", async () => {
    window.history.replaceState(
      {},
      "",
      `/auth/federation/authorize?client_id=${OIDC_CLIENT_ID}&redirect_uri=${encodeURIComponent(OIDC_REDIRECT_URI)}&state=state-1&response_type=token&scope=profile&code_challenge_method=plain`,
    );

    render(<FederationAuthorizePage navigate={navigate} />);

    expect(await screen.findByText("无法验证授权请求，请返回来源网站重试。")).toBeInTheDocument();
    expect(getOIDCAuthorizationContext).not.toHaveBeenCalled();
  });
});
