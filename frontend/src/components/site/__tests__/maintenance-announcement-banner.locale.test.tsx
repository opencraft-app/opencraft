import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { LocaleOverrideProvider } from "@/i18n/t";
import { MaintenanceAnnouncementBanner } from "../maintenance-announcement-banner";

const navigationMock = vi.hoisted(() => ({
  usePathname: vi.fn(() => "/"),
}));

vi.mock("next/navigation", () => ({
  usePathname: navigationMock.usePathname,
}));

vi.mock("@/lib/region", () => ({
  DEFAULT_LOCALE: "en-US",
  REGION: "global",
  isCN: false,
  isGlobal: true,
  localizedPath: (path: string) => path,
  readLocaleFromPath: () => null,
  switchLocaleInPath: (path: string) => path,
  langPrefixRedirectTarget: () => null,
}));

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 11, 12, 0, 0));
  window.localStorage.clear();
  navigationMock.usePathname.mockReturnValue("/");
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("MaintenanceAnnouncementBanner route locale", () => {
  it("renders the Oct 11 maintenance window in English on a localized global homepage", async () => {
    navigationMock.usePathname.mockReturnValue("/en-us/");

    render(
      <LocaleOverrideProvider locale="en-US">
        <MaintenanceAnnouncementBanner />
      </LocaleOverrideProvider>,
    );

    expect(
      await screen.findByText(
        /LightVela will perform a system upgrade from 22:00 on Oct 11, 2026 to 06:00 the next day \(SGT\)/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /LightVela will perform a system upgrade from 22:00 on Oct 11, 2026 to 06:00 the next day \(SGT\)/,
      ),
    ).toHaveClass("mx-auto");
    expect(screen.getByRole("status").firstElementChild).toHaveClass("mx-8");
    expect(
      screen.queryByRole("button", { name: /previous announcement/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /next announcement/i }),
    ).not.toBeInTheDocument();
  });

  it("does not render the retired announcement after the upgrade notice expires", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.UTC(2026, 9, 12, 0, 0, 0));

    render(
      <LocaleOverrideProvider locale="en-US">
        <MaintenanceAnnouncementBanner />
      </LocaleOverrideProvider>,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/LightVela will perform a system upgrade/),
    ).not.toBeInTheDocument();
  });
});
