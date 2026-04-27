import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setGitHubLoginVisible } from "@/lib/github-login-visibility";
import * as oauthModule from "@/lib/oauth";
import type { OAuthProvider } from "@/lib/oauth";
import { SignInPage } from "@/pages/auth/sign-in-page";

const repositories = {
  auth: {
    getOAuthStartUrl: vi.fn(),
  },
};

const oauthStartUrls = {
  qq: "https://lightclaw.tech/auth/oauth/qq/start",
  wechat: "https://lightclaw.tech/auth/oauth/wechat/start",
  google: "https://lightclaw.tech/auth/oauth/google/start",
  github: "https://lightclaw.tech/auth/oauth/github/start",
} as const;

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    session: {},
    signInAsGuest: vi.fn(),
  }),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => repositories,
}));

describe("SignInPage (国内站 默认 isGlobal=false)", () => {
  beforeEach(() => {
    setGitHubLoginVisible(false);
    repositories.auth.getOAuthStartUrl.mockReset();
    repositories.auth.getOAuthStartUrl.mockImplementation((provider: OAuthProvider) => oauthStartUrls[provider]);
  });

  afterEach(() => {
    cleanup();
  });

  it("默认展示 QQ / 微信 / 游客按钮，不展示 GitHub / Google", () => {
    render(
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "使用 QQ 登录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用微信登录" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "使用 GitHub 登录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "使用 Google 登录" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "游客体验" })).toBeInTheDocument();
    expect(screen.getByText("选择一种方式开始体验。")).toBeInTheDocument();
  });

  it("调用 show_github_login() 彩蛋后才展示 GitHub 登录", async () => {
    render(
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("button", { name: "使用 GitHub 登录" })).not.toBeInTheDocument();

    (window.show_github_login as () => boolean)();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "使用 GitHub 登录" })).toBeInTheDocument();
    });
  });

  it("点击 QQ / 微信 按钮时跳转到后端下发的 start URL", () => {
    const redirectSpy = vi.spyOn(oauthModule, "redirectToOAuthStart").mockImplementation(() => undefined);

    render(
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "使用 QQ 登录" })[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "使用微信登录" })[0]!);

    expect(redirectSpy).toHaveBeenNthCalledWith(1, oauthStartUrls.qq);
    expect(redirectSpy).toHaveBeenNthCalledWith(2, oauthStartUrls.wechat);
    redirectSpy.mockRestore();
  });
});
