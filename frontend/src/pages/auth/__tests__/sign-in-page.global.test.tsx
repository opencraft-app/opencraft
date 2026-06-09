/**
 * SignInPage 国际站测试
 * ──────────────────────────────────────────────────────────────
 * 为什么单独拆一个测试文件？
 *   `VISIBLE_OAUTH_PROVIDERS` 在 `@/lib/oauth` 模块加载期就根据 `isGlobal`
 *   求值并冻结。Vitest 中只有在**文件顶层**使用 `vi.mock("@/lib/region", ...)`
 *   才能在被测模块首次加载时就命中 mock；同文件内 `vi.doMock + resetModules`
 *   的路径因测试文件自身已 import 过 `@/lib/oauth`，会存在模块缓存不确定性。
 */
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setGitHubLoginVisible } from "@/lib/github-login-visibility";
import * as oauthModule from "@/lib/oauth";
import type { OAuthProvider } from "@/lib/oauth";
import { SignInPage } from "@/pages/auth/sign-in-page";

/* 顶层 mock：确保 `@/lib/oauth` 加载时看到的 isGlobal === true */
vi.mock("@/lib/region", () => ({
  REGION: "global",
  isCN: false,
  isGlobal: true,
  DEFAULT_LOCALE: "en-US",
}));

const repositories = {
  auth: {
    getOAuthStartUrl: vi.fn(),
  },
};

const oauthStartUrls = {
  qq: "https://lightvela.com/auth/oauth/qq/start",
  wechat: "https://lightvela.com/auth/oauth/wechat/start",
  google: "https://lightvela.com/auth/oauth/google/start",
  github: "https://lightvela.com/auth/oauth/github/start",
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

describe("SignInPage (国际站 isGlobal=true)", () => {
  beforeEach(() => {
    setGitHubLoginVisible(false);
    repositories.auth.getOAuthStartUrl.mockReset();
    repositories.auth.getOAuthStartUrl.mockImplementation((provider: OAuthProvider) => oauthStartUrls[provider]);
  });

  /* 项目未启用全局 auto cleanup，这里显式清理前一个 render 的 DOM，避免跨 it 污染 */
  afterEach(() => {
    cleanup();
  });

  it("仅展示 GitHub 登录，隐藏 Google / QQ / 微信", () => {
    render(
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "使用 GitHub 登录" })).toBeInTheDocument();
    /* Google 入口暂时下线（VISIBLE_OAUTH_PROVIDERS 不再包含 google） */
    expect(screen.queryByRole("button", { name: "使用 Google 登录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "使用 QQ 登录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "使用微信登录" })).not.toBeInTheDocument();
  });

  it("点击 GitHub 时跳转到后端下发的 start URL", () => {
    const redirectSpy = vi.spyOn(oauthModule, "redirectToOAuthStart").mockImplementation(() => undefined);

    render(
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "使用 GitHub 登录" }));

    expect(redirectSpy).toHaveBeenNthCalledWith(1, oauthStartUrls.github);
    redirectSpy.mockRestore();
  });

  it("国际站 show_github_login() 彩蛋不追加按钮（GitHub 本来就在）", () => {
    render(
      <MemoryRouter>
        <SignInPage />
      </MemoryRouter>,
    );

    const githubButtons = screen.getAllByRole("button", { name: "使用 GitHub 登录" });
    expect(githubButtons).toHaveLength(1);

    (window.show_github_login as () => boolean)();

    /* 触发后数量仍为 1，验证不会重复渲染 */
    const after = screen.getAllByRole("button", { name: "使用 GitHub 登录" });
    expect(after).toHaveLength(1);
  });
});
