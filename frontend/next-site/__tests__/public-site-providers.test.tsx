import React, { type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/agent-context", () => ({ OpenClawProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/contexts/repository-context", () => ({ RepositoryProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/contexts/runtime-config-context", () => ({ RuntimeConfigProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/contexts/session-context", () => ({ SessionProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/observability/datong-page-effect", () => ({ DatongPageEffect: () => null }));
vi.mock("@/observability/datong-tracker-bridge", () => ({ DatongTrackerBridge: () => null }));
vi.mock("@/observability/product-analytics-bridge", () => ({ ProductAnalyticsBridge: () => null }));
vi.mock("@/observability/rum-user-bridge", () => ({ RumUserBridge: () => null }));
vi.mock("@/components/site/maintenance-announcement-banner", () => ({ MaintenanceAnnouncementBanner: () => null }));
vi.mock("@/components/site/cookie-consent-banner", () => ({
  CookieConsentBanner: () => <div data-testid="cookie-consent-banner" />,
}));

describe("PublicSiteAppProviders", () => {
  let PublicSiteAppProviders: (typeof import("@next-site/public-site-providers"))["PublicSiteAppProviders"];

  beforeEach(async () => {
    (globalThis as { React?: typeof React }).React = React;
    ({ PublicSiteAppProviders } = await import("@next-site/public-site-providers"));
  });

  it("mounts the cookie consent banner for public Next routes", () => {
    render(
      <PublicSiteAppProviders>
        <main>Page content</main>
      </PublicSiteAppProviders>,
    );

    expect(screen.getByTestId("cookie-consent-banner")).toBeInTheDocument();
  });
});
