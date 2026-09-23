import React, { type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@next-site/app-route-shell", () => ({
  AppRouteShell: ({ children }: { children: ReactNode }) => <>{children}</>,
  ProductSetupRouteLoading: () => null,
}));

vi.mock("@next-site/public-header-auth-island", () => ({
  PublicHeaderAuthIsland: ({
    locale,
    loginOnly,
  }: {
    locale: string;
    loginOnly?: boolean;
  }) => (
    <div
      data-testid="header-auth-island"
      data-locale={locale}
      data-login-only={String(loginOnly)}
    />
  ),
}));

vi.mock("@next-site/public-site-providers", () => ({
  PublicSiteLocaleBridge: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@next-site/subscribe-page", () => ({
  SubscribePage: ({ authControls }: { authControls?: ReactNode }) => <>{authControls}</>,
}));

vi.mock("@next-site/language-switcher", () => ({ renderNextLanguageSwitcher: vi.fn() }));
vi.mock("@next-site/user-menu-link", () => ({ renderNextPublicSiteHeaderLink: vi.fn() }));

import { SubscribePageClient } from "@next-site/subscribe-page-client";

beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
});

afterEach(cleanup);

describe("SubscribePageClient", () => {
  it("keeps only the login action in the subscribe page header", () => {
    render(<SubscribePageClient locale="zh-CN" localized={false} />);

    expect(screen.getByTestId("header-auth-island")).toHaveAttribute(
      "data-login-only",
      "true",
    );
  });
});
