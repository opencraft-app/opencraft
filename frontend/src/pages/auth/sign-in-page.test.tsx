import { MemoryRouter } from "react-router-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    google: null,
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

describe("SignInPage", () => {
  beforeEach(() => {
    setGitHubLoginVisible(false);
    repositories.auth.getOAuthStartUrl.mockReset();
    repositories.auth.getOAuthStartUrl.mockImplementation((provider: OAuthProvider) => oauthStartUrls[provider]);
  });

  it("renders QQ/WeChat login and guest button", () => {
    render(
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "使用 QQ 登录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用微信登录" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "使用 GitHub 登录" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "游客体验" })).toBeInTheDocument();
    expect(screen.getByText("选择一种方式开始体验。")).toBeInTheDocument();
  });

  it("reveals GitHub login only after show_github_login() is called", async () => {
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

  it("uses backend-owned QQ and WeChat start urls when the oauth buttons are clicked", () => {
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
