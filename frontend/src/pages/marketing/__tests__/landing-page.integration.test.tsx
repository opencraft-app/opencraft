import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "@/pages/marketing/landing-page";

const sessionState = vi.hoisted(() => ({
  authReady: true,
  isAuthenticated: false,
  session: { stage: "anonymous", user: null },
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => sessionState,
}));

vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => ({
    bots: [],
    isSubscribed: false,
  }),
}));

vi.mock("@/components/site/login-modal", () => ({
  LoginModal: ({ open, initialError }: { open: boolean; initialError?: string | null }) =>
    open ? <div data-testid="login-modal-error">{initialError}</div> : null,
  InviteCodeModal: () => null,
}));

vi.mock("@/components/site/public-site-header", () => ({
  PublicSiteHeader: ({
    authSnapshot,
    onLoginClick,
  }: {
    authSnapshot?: { authReady: boolean; isAuthenticated: boolean };
    onLoginClick?: () => void;
  }) =>
    authSnapshot?.isAuthenticated ? (
      <div>avatar menu</div>
    ) : (
      <button type="button" onClick={onLoginClick}>
        登录
      </button>
    ),
}));
vi.mock("@/imports/Frame2147230025/sections/HeroSection", () => ({
  default: () => <div>hero</div>,
}));
vi.mock("@/imports/Frame2147230025/sections/BrandIconsSection", () => ({
  default: () => <div>brand icons</div>,
}));
vi.mock("@/imports/Frame2147230025/sections/FeatureSection", () => ({
  default: () => <div>features</div>,
  CardsSection: () => <div>cards</div>,
}));
vi.mock("@/imports/Frame2147230025/sections/ProcessSection", () => ({
  default: () => <div>process</div>,
}));
vi.mock("@/imports/Frame2147230025/sections/CtaSection", () => ({
  default: () => <div>cta</div>,
}));
vi.mock("@/components/site/product-chrome", () => ({
  ProductFooter: () => <div>footer</div>,
}));

afterEach(() => {
  sessionState.authReady = true;
  sessionState.isAuthenticated = false;
  sessionState.session = { stage: "anonymous", user: null };
  cleanup();
});

describe("LandingPage", () => {
  it("renders the signed-in header state after the global session hydrates", () => {
    sessionState.isAuthenticated = true;
    sessionState.session = {
      stage: "authenticated",
      user: { id: "usr_1", name: "QQ User", inviteRequired: false, createdAt: "2026-06-23T00:00:00Z" },
    };

    render(
      <MemoryRouter initialEntries={["/"]}>
        <LandingPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("avatar menu")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
  });

  it("opens the shared QQ/WeChat login modal from the public header login action", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <LandingPage />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId("login-modal-error")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(screen.getByTestId("login-modal-error")).toBeInTheDocument();
  });

  it("passes the shared oauth error message through to the login modal", async () => {
    render(
      <MemoryRouter initialEntries={["/?oauth_error=wechat_sign_in_failed"]}>
        <LandingPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("login-modal-error")).toHaveTextContent("微信登录暂时失败，请稍后重试。");
    });
  });
});
