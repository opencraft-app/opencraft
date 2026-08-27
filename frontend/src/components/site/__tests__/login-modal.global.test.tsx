/**
 * LoginModal 国际站测试
 * ──────────────────────────────────────────────────────────────
 * 理由同 sign-in-page.global.test.tsx：
 *   需要在 `@/lib/oauth` 模块加载期就让 `isGlobal === true`，
 *   因此把国际站用例放在独立文件，通过文件顶层 `vi.mock` 生效。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setGitHubLoginVisible } from "@/lib/github-login-visibility";
import * as oauthModule from "@/lib/oauth";
import { LoginModal } from "@/components/site/login-modal";
import { LegalFooter } from "@/components/site/legal-footer";
import { LocaleOverrideProvider } from "@/i18n/t";
import type { OAuthProvider } from "@/lib/oauth";

vi.mock("@/observability/posthog", () => ({
  captureProductEvent: vi.fn(),
  PRODUCT_ANALYTICS_EVENTS: {
    LOGIN_MODAL_OPENED: "login_modal_opened",
    OAUTH_PROVIDER_CLICKED: "oauth_provider_clicked",
  },
  PRODUCT_ANALYTICS_LOCATIONS: { LOGIN_MODAL: "login_modal" },
}));

vi.mock("@/lib/region", () => ({
  REGION: "global",
  isCN: false,
  isGlobal: true,
  DEFAULT_LOCALE: "en-US",
  readLocaleFromPath: vi.fn(() => "en-US"),
  // 简化版：与真实实现一致地让默认语言（en-US）不带前缀，其余语言加前缀。
  // 本用例只覆盖英文场景，因此无需复刻 zh-CN → zh-sg 等 SEO 别名映射。
  localizedPath: (path: string, locale: string) =>
    locale === "en-US" ? path : `/${locale.toLowerCase()}${path}`,
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

const renderSpanish = (children: ReactNode) => render(
  <MemoryRouter>
    <LocaleOverrideProvider locale="es">{children}</LocaleOverrideProvider>
  </MemoryRouter>,
);

describe("LoginModal (国际站 isGlobal=true)", () => {
  beforeEach(() => {
    setGitHubLoginVisible(false);
  });

  afterEach(() => {
    cleanup();
  });

  it("展示 Google / GitHub 入口，隐藏 QQ / 微信", () => {
    renderLoginModal();

    /* 国际站 i18n locale = en-US，按钮文案转为英文 */
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in with GitHub" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in with QQ/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in with WeChat/ })).not.toBeInTheDocument();
  });

  it("国际站服务协议跳转站内服务条款", () => {
    renderLoginModal();

    expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute(
      "href",
      "/terms-of-service",
    );
  });

  it("keeps Spanish legal links under /es in the login modal and legal footer", () => {
    const modal = renderSpanish(<LoginModal open onClose={vi.fn()} />);
    expect(document.querySelector('a[href="/es/terms-of-service"]')).toBeInTheDocument();
    expect(document.querySelector('a[href="/es/privacy-policy"]')).toBeInTheDocument();
    expect(document.querySelector('a[href="/es/open-source-licenses"]')).toBeInTheDocument();
    modal.unmount();

    const footer = renderSpanish(<LegalFooter />);
    expect(footer.container.querySelector('a[href="/es/terms-of-service"]')).toBeInTheDocument();
    expect(footer.container.querySelector('a[href="/es/privacy-policy"]')).toBeInTheDocument();
    expect(footer.container.querySelector('a[href="/es/open-source-licenses"]')).toBeInTheDocument();
  });

  it("勾选协议后点击 Google 跳转后端下发的 start URL", () => {
    const redirectSpy = vi.spyOn(oauthModule, "redirectToOAuthStart").mockImplementation(() => undefined);

    renderLoginModal();

    const [agreeCheckbox] = screen.getAllByRole("checkbox");
    expect(agreeCheckbox).toBeDefined();
    fireEvent.click(agreeCheckbox as HTMLElement);

    fireEvent.click(screen.getByRole("button", { name: "Sign in with Google" }));

    expect(redirectSpy).toHaveBeenNthCalledWith(1, "https://lightvela.com/auth/oauth/google/start");
    redirectSpy.mockRestore();
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
