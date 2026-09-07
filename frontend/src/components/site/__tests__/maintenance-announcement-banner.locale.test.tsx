import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
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
  vi.unstubAllGlobals();
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
    expect(
      screen.getByText(
        /LightVela will upgrade the Hermes Agent version from 22:00 on Sep 7, 2026 to 02:00 the next day \(SGT\)/,
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

  it("tracks whether the global announcement is still inside the viewport", async () => {
    let observerCallback: IntersectionObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();

    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          observerCallback = callback;
        }

        observe = observe;
        disconnect = disconnect;
      },
    );

    const { unmount } = render(
      <LocaleOverrideProvider locale="en-US">
        <MaintenanceAnnouncementBanner trackViewport />
      </LocaleOverrideProvider>,
    );
    const banner = await screen.findByRole("status");

    expect(observe).toHaveBeenCalledWith(banner);

    act(() => {
      observerCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(document.body).toHaveClass("lw-announcement-in-viewport");

    act(() => {
      observerCallback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(document.body).not.toHaveClass("lw-announcement-in-viewport");

    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(document.body).not.toHaveClass("lw-announcement-in-viewport");
  });

  it("does not render the retired public beta announcement after the Hermes notice expires", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.UTC(2026, 8, 8, 0, 0, 0));

    render(
      <LocaleOverrideProvider locale="en-US">
        <MaintenanceAnnouncementBanner />
      </LocaleOverrideProvider>,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/LightVela public beta and billing start Aug 18, 2026/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("View details")).not.toBeInTheDocument();
  });
});
