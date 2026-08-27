import React, { type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocaleOverride } from "@/i18n/t";

const navigationMock = vi.hoisted(() => ({
  usePathname: vi.fn(() => "/"),
}));

vi.mock("@/contexts/agent-context", () => ({ OpenClawProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/contexts/repository-context", () => ({ RepositoryProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/contexts/runtime-config-context", () => ({ RuntimeConfigProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/contexts/session-context", () => ({ SessionProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/observability/datong-page-effect", () => ({ DatongPageEffect: () => null }));
vi.mock("@/observability/datong-tracker-bridge", () => ({ DatongTrackerBridge: () => null }));
vi.mock("@/observability/product-analytics-bridge", () => ({ ProductAnalyticsBridge: () => null }));
vi.mock("@/observability/rum-user-bridge", () => ({ RumUserBridge: () => null }));
vi.mock("next/navigation", () => ({ usePathname: navigationMock.usePathname }));
vi.mock("@/lib/region", () => ({
  DEFAULT_LOCALE: "en-US",
  isCN: false,
  isGlobal: true,
  readLocaleFromPath: (pathname: string) => {
    if (pathname.startsWith("/zh-hant")) return "zh-Hant";
    if (pathname.startsWith("/zh")) return "zh-CN";
    if (pathname.startsWith("/en")) return "en-US";
    return null;
  },
}));
vi.mock("@/components/site/maintenance-announcement-banner", async () => {
  const ReactRuntime = await import("react");
  const { useLocaleOverride } = await import("@/i18n/t");
  return {
    MaintenanceAnnouncementBanner: () =>
      ReactRuntime.createElement(
        "div",
        { "data-testid": "maintenance-announcement-locale" },
        useLocaleOverride(),
      ),
  };
});
vi.mock("@/components/site/cookie-consent-banner", () => ({
  CookieConsentBanner: () => <div data-testid="cookie-consent-banner" />,
}));

describe("PublicSiteAppProviders", () => {
  let PublicSiteAppProviders: (typeof import("@next-site/public-site-providers"))["PublicSiteAppProviders"];
  let PublicSiteLocaleBridge: (typeof import("@next-site/public-site-providers"))["PublicSiteLocaleBridge"];

  beforeEach(async () => {
    (globalThis as { React?: typeof React }).React = React;
    navigationMock.usePathname.mockReturnValue("/");
    ({ PublicSiteAppProviders, PublicSiteLocaleBridge } = await import("@next-site/public-site-providers"));
  });

  afterEach(() => {
    cleanup();
  });

  it("mounts the cookie consent banner for public Next routes", () => {
    render(
      <PublicSiteAppProviders>
        <main>Page content</main>
      </PublicSiteAppProviders>,
    );

    expect(screen.getByTestId("cookie-consent-banner")).toBeInTheDocument();
  });

  it("does not mount the announcement banner on public Next routes", () => {
    navigationMock.usePathname.mockReturnValue("/zh-hant/");

    render(
      <PublicSiteAppProviders>
        <main>Page content</main>
      </PublicSiteAppProviders>,
    );

    expect(screen.queryByTestId("maintenance-announcement-locale")).not.toBeInTheDocument();
  });

  it("bridges the Spanish public route to the Spanish i18n dictionary", () => {
    function LocaleProbe() {
      return <div data-testid="locale-override">{useLocaleOverride()}</div>;
    }

    render(
      <PublicSiteLocaleBridge locale="es">
        <LocaleProbe />
      </PublicSiteLocaleBridge>,
    );

    expect(screen.getByTestId("locale-override")).toHaveTextContent("es");
  });
});
