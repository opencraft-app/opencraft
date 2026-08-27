import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "es" } }),
}));
vi.mock("@/components/site/login-modal", () => ({ LoginModal: () => null }));
vi.mock("@/components/site/user-avatar-menu", () => ({ UserAvatarMenu: () => null }));
vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => ({ bots: [], isSubscribed: false }),
}));
vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({ authReady: true, isAuthenticated: false }),
}));
vi.mock("@/lib/oauth", () => ({ oauthErrorMessage: () => null }));
vi.mock("@/observability/datong-tracker", () => ({ trackDatongClick: vi.fn() }));
vi.mock("@next-site/language-switcher", () => ({ renderNextLanguageSwitcher: () => null }));

import { PublicHeaderAuthIsland } from "@next-site/public-header-auth-island";

afterEach(() => {
  cleanup();
  routerMock.push.mockReset();
});

describe("PublicHeaderAuthIsland", () => {
  it("infers Spanish auth actions from the runtime language", () => {
    (globalThis as { React?: typeof React }).React = React;
    render(<PublicHeaderAuthIsland showLanguageSwitcher={false} />);

    expect(screen.getByRole("button", { name: "Crear ahora" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Iniciar sesión" }).length).toBeGreaterThan(0);
  });
});
