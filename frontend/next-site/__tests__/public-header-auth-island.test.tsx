import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const runtimeMock = vi.hoisted(() => ({
  language: "es",
  authReady: true,
  isAuthenticated: false,
}));
const trackDatongClickMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: runtimeMock.language } }),
}));
vi.mock("@/components/site/login-modal", () => ({ LoginModal: () => null }));
vi.mock("@/components/site/user-avatar-menu", () => ({ UserAvatarMenu: () => null }));
vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => ({ bots: [], isSubscribed: false }),
}));
vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    authReady: runtimeMock.authReady,
    isAuthenticated: runtimeMock.isAuthenticated,
  }),
}));
vi.mock("@/lib/oauth", () => ({ oauthErrorMessage: () => null }));
vi.mock("@/observability/datong-tracker", () => ({
  trackDatongClick: trackDatongClickMock,
}));
vi.mock("@next-site/language-switcher", () => ({ renderNextLanguageSwitcher: () => null }));

import { PublicHeaderAuthIsland } from "@next-site/public-header-auth-island";

beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  runtimeMock.language = "es";
  runtimeMock.authReady = true;
  runtimeMock.isAuthenticated = false;
});

afterEach(() => {
  cleanup();
  routerMock.push.mockReset();
  trackDatongClickMock.mockReset();
});

describe("PublicHeaderAuthIsland", () => {
  it("infers Spanish auth actions from the runtime language", () => {
    render(<PublicHeaderAuthIsland showLanguageSwitcher={false} />);

    expect(screen.getByRole("button", { name: "Crear ahora" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Iniciar sesión" }).length).toBeGreaterThan(0);
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
    render(<PublicHeaderAuthIsland locale="en-US" showLanguageSwitcher={false} />);

    expect(screen.queryByRole("link", { name: "Enter LightVela" })).not.toBeInTheDocument();
  });

  it("keeps anonymous homepage actions unchanged", () => {
    render(
      <PublicHeaderAuthIsland
        locale="zh-CN"
        showLanguageSwitcher={false}
        showProductEntry
        promoteFreeTrial
      />,
    );

    expect(screen.queryByRole("link", { name: "开始使用" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "免费试用" })).toBeInTheDocument();
  });

  it("tracks the desktop product entry without changing its native target", () => {
    runtimeMock.isAuthenticated = true;
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
});
