import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LandingPage } from "@/pages/marketing/landing-page";

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    isAuthenticated: false,
    session: { stage: "anonymous", user: null },
  }),
}));

vi.mock("@/contexts/openclaw-context", () => ({
  useOpenClaw: () => ({
    bots: [],
  }),
}));

vi.mock("@/components/site/login-modal", () => ({
  LoginModal: ({ open, initialError }: { open: boolean; initialError?: string | null }) =>
    open ? <div data-testid="login-modal-error">{initialError}</div> : null,
  InviteCodeModal: () => null,
}));

vi.mock("@/pages/marketing/landing/landing-navbar", () => ({
  LandingNavbar: () => <div>navbar</div>,
}));
vi.mock("@/pages/marketing/landing/hero-section", () => ({
  HeroSection: () => <div>hero</div>,
}));
vi.mock("@/pages/marketing/landing/what-it-does-section", () => ({
  WhatItDoesSection: () => <div>what</div>,
}));
vi.mock("@/pages/marketing/landing/where-to-use-section", () => ({
  WhereToUseSection: () => <div>where</div>,
}));
vi.mock("@/pages/marketing/landing/how-easy-section", () => ({
  HowEasySection: () => <div>easy</div>,
}));
vi.mock("@/pages/marketing/landing/why-trust-section", () => ({
  WhyTrustSection: () => <div>trust</div>,
}));
vi.mock("@/pages/marketing/landing/cta-footer-section", () => ({
  CTAFooterSection: () => <div>cta</div>,
}));

describe("LandingPage", () => {
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
