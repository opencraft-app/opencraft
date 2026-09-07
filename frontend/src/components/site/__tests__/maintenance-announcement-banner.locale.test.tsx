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
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 7, 12, 0, 0));
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
  it("renders the Sep 7 maintenance window in English on a localized global homepage", async () => {
    navigationMock.usePathname.mockReturnValue("/en-us/");

    render(
      <LocaleOverrideProvider locale="en-US">
        <MaintenanceAnnouncementBanner />
      </LocaleOverrideProvider>,
    );

    expect(
      await screen.findByText(
        /LightVela will upgrade the Hermes Agent version from 22:00 on Sep 7, 2026 to 02:00 the next day \(SGT\)/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("status").firstElementChild).toHaveClass(
      "justify-start",
    );
    expect(screen.getByRole("status").firstElementChild).not.toHaveClass(
      "sm:justify-center",
    );
  });

  it("renders the global homepage announcement from the route locale", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.UTC(2026, 8, 8, 0, 0, 0));

    render(
      <LocaleOverrideProvider locale="en-US">
        <MaintenanceAnnouncementBanner />
      </LocaleOverrideProvider>,
    );

    expect(
      await screen.findByText(
        /LightVela public beta and billing start Aug 18, 2026/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("View details")).toBeInTheDocument();
    expect(screen.queryByText(/公测并计费/)).not.toBeInTheDocument();
  });
});
