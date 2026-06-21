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

vi.mock("@/imports/Frame2147230025/sections/HeaderSection", () => ({
  default: () => <div>navbar</div>,
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
