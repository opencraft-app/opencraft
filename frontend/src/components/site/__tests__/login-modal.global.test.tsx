/**
 * LoginModal 国际站测试
 * ──────────────────────────────────────────────────────────────
 * 理由同 sign-in-page.global.test.tsx：
 *   需要在 `@/lib/oauth` 模块加载期就让 `isGlobal === true`，
 *   因此把国际站用例放在独立文件，通过文件顶层 `vi.mock` 生效。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setGitHubLoginVisible } from "@/lib/github-login-visibility";
import * as oauthModule from "@/lib/oauth";
import { LoginModal } from "@/components/site/login-modal";
import type { OAuthProvider } from "@/lib/oauth";

vi.mock("@/lib/region", () => ({
  REGION: "global",
  isCN: false,
  isGlobal: true,
  DEFAULT_LOCALE: "en-US",
  readLocaleFromPath: vi.fn(() => "en-US"),
}));

const repositories = {
  auth: {
    getOAuthStartUrl: vi.fn((provider: OAuthProvider) => {
      switch (provider) {
        case "qq":
          return "https://lightvela.com/auth/oauth/qq/start";
        case "wechat":
          return "https://lightvela.com/auth/oauth/wechat/start";
        case "google":
          return "https://lightvela.com/auth/oauth/google/start";
        case "github":
          return "https://lightvela.com/auth/oauth/github/start";
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

const renderLoginModal = () => render(
  <MemoryRouter>
    <LoginModal open onClose={vi.fn()} />
  </MemoryRouter>,
);

describe("LoginModal (国际站 isGlobal=true)", () => {
  beforeEach(() => {
    setGitHubLoginVisible(false);
  });

  afterEach(() => {
    cleanup();
  });

  it("仅展示 GitHub 入口，隐藏 Google / QQ / 微信", () => {
    renderLoginModal();

    /* 国际站 i18n locale = en-US，按钮文案转为英文 */
    expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeInTheDocument();
    /* Google 入口暂时下线（VISIBLE_OAUTH_PROVIDERS 不再包含 google） */
    expect(screen.queryByRole("button", { name: "Sign in with Google" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in with QQ/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in with WeChat/ })).not.toBeInTheDocument();
  });

  it("勾选协议后点击 GitHub 跳转后端下发的 start URL", () => {
    const redirectSpy = vi.spyOn(oauthModule, "redirectToOAuthStart").mockImplementation(() => undefined);

    renderLoginModal();

    const [agreeCheckbox] = screen.getAllByRole("checkbox");
    expect(agreeCheckbox).toBeDefined();
    fireEvent.click(agreeCheckbox as HTMLElement);

    fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));

    expect(redirectSpy).toHaveBeenNthCalledWith(1, "https://lightvela.com/auth/oauth/github/start");
    redirectSpy.mockRestore();
  });
});
