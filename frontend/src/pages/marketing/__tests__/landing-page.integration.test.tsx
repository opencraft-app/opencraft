import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LandingPage, LandingPageView } from "@/pages/marketing/landing-page";
import i18n from "@/i18n";
import { isGlobal } from "@/lib/region";

type TestSessionUser = {
  id: string;
  name: string;
  inviteRequired: boolean;
  createdAt: string;
};

const sessionState = vi.hoisted((): {
  authReady: boolean;
  isAuthenticated: boolean;
  session: { stage: string; user: TestSessionUser | null };
} => ({
  authReady: true,
  isAuthenticated: false,
  session: { stage: "anonymous", user: null },
}));
const prepareReferralCode = vi.hoisted(() => vi.fn());
const agentState = vi.hoisted(() => ({ bots: [] as Array<{ id: string }>, isSubscribed: false }));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => sessionState,
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({ auth: { prepareReferralCode } }),
}));

vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => agentState,
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
    onCreateClick,
  }: {
    authSnapshot?: { authReady: boolean; isAuthenticated: boolean };
    onLoginClick?: () => void;
    onCreateClick?: () => void;
  }) =>
    authSnapshot?.isAuthenticated ? (
      <div>avatar menu<button type="button" onClick={onCreateClick}>header create</button></div>
    ) : (
      <button type="button" onClick={onLoginClick}>
        登录
      </button>
    ),
}));
vi.mock("@/imports/Frame2147230025/sections/HeroSection", () => ({
  default: ({ onCreateClick }: { onCreateClick: () => void }) => <button onClick={onCreateClick}>hero create</button>,
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
  default: ({ onCreateClick }: { onCreateClick: () => void }) => <button onClick={onCreateClick}>footer create</button>,
}));
vi.mock("@/components/site/product-chrome", () => ({
  ProductFooter: () => <div>footer</div>,
}));
vi.mock("@/pages/marketing/scenario-tasks/OverviewAutomationTasksSection", () => ({
  OverviewAutomationTasksSection: ({
    onEnable,
    packs,
  }: {
    onEnable: (pack: { name: string }) => void;
    packs: Array<{ name: string }>;
  }) => (
    <div data-testid="overview-automations">
      {packs.map((pack) => pack.name).join("|")}
      <button type="button" onClick={() => packs[0] && onEnable(packs[0])}>open automation</button>
    </div>
  ),
}));

afterEach(async () => {
  sessionState.authReady = true;
  sessionState.isAuthenticated = false;
  sessionState.session = { stage: "anonymous", user: null };
  agentState.bots = [];
  agentState.isSubscribed = false;
  prepareReferralCode.mockReset().mockResolvedValue(undefined);
  await i18n.changeLanguage("zh-CN");
  cleanup();
});

describe("LandingPage", () => {
  it.each(["hero", "header", "footer"])("opens creation from the %s CTA for subscribed users without bots", (origin) => {
    sessionState.isAuthenticated = true;
    agentState.isSubscribed = true;
    const navigateTo = vi.fn();
    render(<LandingPageView navigateTo={navigateTo} authSnapshot={{ authReady: true, isAuthenticated: true }} />);

    fireEvent.click(screen.getByRole("button", { name: `${origin} create` }));

    expect(navigateTo).toHaveBeenCalledWith("/agents?create=1");
  });

  it("renders the overview automations on the public home page", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <LandingPage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("overview-automations")).toHaveTextContent(
      isGlobal ? "Water & medication reminders" : "喝水与吃药提醒",
    );
  });

  it("navigates automation actions to the Agent page instead of operating an Agent on the landing page", () => {
    const navigateTo = vi.fn();

    render(<LandingPageView navigateTo={navigateTo} />);

    fireEvent.click(screen.getByRole("button", { name: "open automation" }));

    expect(navigateTo).toHaveBeenCalledWith("/agents/automations");
  });

  it("renders overview automation cards in Traditional Chinese for zh-Hant", async () => {
    await i18n.changeLanguage("zh-Hant");

    render(
      <LandingPageView
        navigateTo={vi.fn()}
        publicLocale="zh-Hant"
        publicLocalized
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("overview-automations")).toHaveTextContent("喝水與吃藥提醒");
    });
    expect(screen.getByTestId("overview-automations")).not.toHaveTextContent("喝水与吃药提醒");
  });

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

  it("claims a referral link immediately for an authenticated user", async () => {
    sessionState.isAuthenticated = true;
    sessionState.session = {
      stage: "authenticated",
      user: { id: "usr_existing", name: "Existing User", inviteRequired: false, createdAt: "2026-04-23T00:00:00Z" },
    };

    render(
      <MemoryRouter initialEntries={["/?ref=hbygspxsad"]}>
        <LandingPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(prepareReferralCode).toHaveBeenCalledWith("HBYGSPXSAD");
    });
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
