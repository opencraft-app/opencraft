import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setGitHubLoginVisible } from "@/lib/github-login-visibility";
import * as oauthModule from "@/lib/oauth";
import { LoginModal } from "@/components/site/login-modal";
import type { OAuthProvider } from "@/lib/oauth";

const repositories = {
  auth: {
    getOAuthStartUrl: vi.fn((provider: OAuthProvider) => {
      switch (provider) {
        case "qq":
          return "https://lightclaw.tech/auth/oauth/qq/start";
        case "wechat":
          return "https://lightclaw.tech/auth/oauth/wechat/start";
        case "google":
          return "https://lightclaw.tech/auth/oauth/google/start";
        case "github":
          return "https://lightclaw.tech/auth/oauth/github/start";
        default:
          return null;
      }
    }),
  },
};

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => repositories,
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    session: { stage: "anonymous", user: null },
  }),
}));

describe("LoginModal", () => {
  it("renders both QQ and WeChat login entries on the shared login surface", () => {
    setGitHubLoginVisible(false);
    render(<LoginModal open onClose={vi.fn()} />);

    expect(screen.getByRole("button", { name: "QQQQ账号登录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "微信微信账号登录" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "GitHub 登录" })).not.toBeInTheDocument();
  });

  it("uses backend-owned QQ and WeChat start urls after the user accepts the agreement", () => {
    const redirectSpy = vi.spyOn(oauthModule, "redirectToOAuthStart").mockImplementation(() => undefined);

    render(<LoginModal open onClose={vi.fn()} />);

    const [agreeCheckbox] = screen.getAllByRole("checkbox");
    expect(agreeCheckbox).toBeDefined();
    fireEvent.click(agreeCheckbox as HTMLElement);
    const [qqButton] = screen.getAllByRole("button", { name: "QQQQ账号登录" });
    const [wechatButton] = screen.getAllByRole("button", { name: "微信微信账号登录" });
    expect(qqButton).toBeDefined();
    expect(wechatButton).toBeDefined();
    fireEvent.click(qqButton as HTMLElement);
    fireEvent.click(wechatButton as HTMLElement);

    expect(redirectSpy).toHaveBeenNthCalledWith(1, "https://lightclaw.tech/auth/oauth/qq/start");
    expect(redirectSpy).toHaveBeenNthCalledWith(2, "https://lightclaw.tech/auth/oauth/wechat/start");
    redirectSpy.mockRestore();
  });

  it("shows the GitHub entry only after show_github_login() is invoked", async () => {
    setGitHubLoginVisible(false);
    render(<LoginModal open onClose={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "GitHub 登录" })).not.toBeInTheDocument();
    (window.show_github_login as () => boolean)();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "GitHub 登录" })).toBeInTheDocument();
    });
  });
});
