import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
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
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 12, 12, 0, 0));
  window.localStorage.clear();
  navigationMock.usePathname.mockReturnValue("/");
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("MaintenanceAnnouncementBanner global site", () => {
  it.each(["/", "/en-us/"])("does not render on %s", (pathname) => {
    navigationMock.usePathname.mockReturnValue(pathname);

    render(<MaintenanceAnnouncementBanner />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(document.body).not.toHaveClass("lw-has-announcement");
  });
});
