import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const runtimeMock = vi.hoisted(() => ({
  language: "es",
  authReady: true,
  isAuthenticated: false,
  isSubscribed: false,
  bots: [] as Array<{ id: string }>,
}));
const trackDatongClickMock = vi.hoisted(() => vi.fn());
const prepareReferralCodeMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: runtimeMock.language } }),
}));
vi.mock("@/components/site/login-modal", () => ({ LoginModal: () => <div data-testid="current-login-modal" /> }));
vi.mock("@/components/site/user-avatar-menu", () => ({ UserAvatarMenu: () => null }));
vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => ({
    bots: runtimeMock.bots,
    isSubscribed: runtimeMock.isSubscribed,
    hasResolvedPasses: true,
    passesLoading: false,
    passesError: false,
    refreshPasses: vi.fn(),
  }),
}));
vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    authReady: runtimeMock.authReady,
    isAuthenticated: runtimeMock.isAuthenticated,
  }),
}));
vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({ auth: { prepareReferralCode: prepareReferralCodeMock } }),
}));
vi.mock("@/lib/oauth", () => ({ oauthErrorMessage: () => null }));
vi.mock("@/lib/region", async () => {
  const actual = await vi.importActual<typeof import("@/lib/region")>("@/lib/region");
  return { ...actual, isGlobal: true };
});
vi.mock("@/observability/datong-tracker", () => ({
  trackDatongClick: trackDatongClickMock,
}));
vi.mock("@next-site/language-switcher", () => ({ renderNextLanguageSwitcher: () => null }));

import { PublicHeaderAuthIsland } from "@next-site/public-header-auth-island";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  (globalThis as { React?: typeof React }).React = React;
  runtimeMock.language = "es";
  runtimeMock.authReady = true;
  runtimeMock.isAuthenticated = false;
  runtimeMock.isSubscribed = false;
  runtimeMock.bots = [];
  prepareReferralCodeMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  routerMock.push.mockReset();
  trackDatongClickMock.mockReset();
});

describe("PublicHeaderAuthIsland", () => {
  it("opens the current login modal for an anonymous referral visitor", async () => {
    window.history.replaceState(null, "", "/?ref=ABC234");
    render(<PublicHeaderAuthIsland locale="zh-CN" showLanguageSwitcher={false} />);
    await waitFor(() => expect(screen.getByTestId("current-login-modal")).toBeInTheDocument());
  });

  it("does not open referral login for an existing authenticated user", () => {
    window.history.replaceState(null, "", "/?ref=ABC234");
    runtimeMock.isAuthenticated = true;
    render(<PublicHeaderAuthIsland locale="zh-CN" showLanguageSwitcher={false} />);
    expect(screen.queryByTestId("current-login-modal")).toBeNull();
  });

  it("claims a referral link for an existing authenticated user", async () => {
    window.history.replaceState(null, "", "/?ref=hy23lavsfz");
    runtimeMock.isAuthenticated = true;

    render(<PublicHeaderAuthIsland locale="zh-CN" showLanguageSwitcher={false} />);

    await waitFor(() => expect(prepareReferralCodeMock).toHaveBeenCalledWith("HY23LAVSFZ"));
  });
  it("keeps locale dictionaries and closed auth UI out of the initial header chunk", () => {
    const source = readFileSync(
      path.join(process.cwd(), "next-site/public-header-auth-island.tsx"),
      "utf8",
    );

    expect(source).not.toContain('import { useTranslation } from \'react-i18next\'');
    expect(source).not.toContain("import { LoginModal }");
    expect(source).not.toContain("import { UserAvatarMenu }");
    expect(source).toContain("import('@/components/site/login-modal')");
    expect(source).toContain("import('@/components/site/user-avatar-menu')");
  });

  it("uses the homepage language-and-login treatment across international public pages", () => {
    render(<PublicHeaderAuthIsland locale="es" showLanguageSwitcher={false} />);

    expect(screen.queryByRole("button", { name: "Crear ahora" })).not.toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Iniciar sesión" })) {
      expect(button).toHaveClass("bg-black/90", "text-white");
    }
  });

  it.each([
    ["zh-CN", "开始使用"],
    ["zh-SG", "开始使用"],
    ["zh-Hant", "開始使用"],
    ["en-US", "Enter LightVela"],
    ["id-ID", "Masuk ke LightVela"],
    ["es", "Entrar a LightVela"],
    ["ja-JP", "LightVelaを開く"],
    ["ko-KR", "LightVela 열기"],
  ] as const)("shows the homepage product entry for %s", (locale, label) => {
    runtimeMock.isAuthenticated = true;
    runtimeMock.isSubscribed = true;
    render(
      <PublicHeaderAuthIsland
        locale={locale}
        showLanguageSwitcher={false}
        showProductEntry
      />,
    );

    const links = screen.getAllByRole("link", { name: label });
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/agents");
    }
  });

  it("keeps the product entry off non-home public pages", () => {
    runtimeMock.isAuthenticated = true;
    runtimeMock.isSubscribed = true;
    render(<PublicHeaderAuthIsland locale="en-US" showLanguageSwitcher={false} />);

    expect(screen.queryByRole("link", { name: "Enter LightVela" })).not.toBeInTheDocument();
  });

  it("hides the product entry before purchase", () => {
    runtimeMock.isAuthenticated = true;
    runtimeMock.isSubscribed = false;
    render(
      <PublicHeaderAuthIsland locale="en-US" showLanguageSwitcher={false} showProductEntry />,
    );

    expect(screen.queryByRole("link", { name: "Enter LightVela" })).not.toBeInTheDocument();
  });

  it("keeps anonymous homepage actions unchanged", () => {
    render(
      <PublicHeaderAuthIsland
        locale="zh-CN"
        showLanguageSwitcher={false}
        showProductEntry
        promoteFreeTrial
        loginOnly={false}
      />,
    );

    expect(screen.queryByRole("link", { name: "开始使用" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "免费试用" })).toBeInTheDocument();
  });

  it("tracks the desktop product entry without changing its native target", () => {
    runtimeMock.isAuthenticated = true;
    runtimeMock.isSubscribed = true;
    render(
      <PublicHeaderAuthIsland locale="en-US" showLanguageSwitcher={false} showProductEntry />,
    );

    const link = screen.getAllByRole("link", { name: "Enter LightVela" })[0]!;
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);

    expect(trackDatongClickMock).toHaveBeenCalledWith("agent_enter_console_btn", {
      pgid: "home",
      params: { surface: "desktop", target: "/agents" },
    });
  });

  it("supports the international homepage login-only treatment", () => {
    (globalThis as { React?: typeof React }).React = React;
    render(<PublicHeaderAuthIsland locale="en-US" showLanguageSwitcher={false} loginOnly />);

    expect(screen.queryByRole("button", { name: "Create Now" })).not.toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Sign In" })) {
      expect(button).toHaveClass("bg-black/90", "text-white");
    }
  });

  it("keeps login-only auth copy localized", () => {
    (globalThis as { React?: typeof React }).React = React;
    render(<PublicHeaderAuthIsland locale="id-ID" showLanguageSwitcher={false} loginOnly />);

    for (const button of screen.getAllByRole("button", { name: "Masuk" })) {
      expect(button).toHaveClass("bg-black/90", "text-white");
    }
    expect(screen.queryByRole("button", { name: "Sign In" })).not.toBeInTheDocument();
  });

  it("uses the shared Free trial copy on the international homepage CTA", () => {
    (globalThis as { React?: typeof React }).React = React;
    render(
      <PublicHeaderAuthIsland
        locale="en-US"
        showLanguageSwitcher={false}
        showProductEntry
        promoteFreeTrial
        loginOnly={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Free trial" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start free" })).not.toBeInTheDocument();
  });

  it("sends anonymous CTA clicks straight to the subscribe page (plan A)", () => {
    (globalThis as { React?: typeof React }).React = React;
    render(
      <PublicHeaderAuthIsland
        locale="en-US"
        showLanguageSwitcher={false}
        showProductEntry
        promoteFreeTrial
        loginOnly={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Free trial" }));

    // 方案 A：未登录直接进订阅页看套餐（点“订阅”时才在订阅页引导登录）。
    // 国际站会带语言前缀（如 /en-us/subscribe），故只断言落点是订阅页。
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith(expect.stringMatching(/\/subscribe$/));
    expect(trackDatongClickMock).toHaveBeenCalledWith("header_create_now_btn", {
      pgid: "home",
      params: { has_bots: false, target: "subscribe" },
    });
  });
});
