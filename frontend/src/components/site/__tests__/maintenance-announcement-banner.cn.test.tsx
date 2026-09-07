import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
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
  DEFAULT_LOCALE: "zh-CN",
  REGION: "cn",
  isCN: true,
  isGlobal: false,
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("MaintenanceAnnouncementBanner China maintenance window", () => {
  it("renders the Sep 7 maintenance window in Beijing time", async () => {
    render(<MaintenanceAnnouncementBanner />);

    expect(
      await screen.findByText(
        "LightVela 将于北京时间 2026 年 9 月 7 日 22:00-次日 02:00 升级 Hermes Agent 版本，期间对话和任务可能短暂中断，带来不便敬请谅解。",
      ),
    ).toBeInTheDocument();
  });

  it("ignores the dismissal state from the previous Hermes announcement", async () => {
    window.localStorage.setItem(
      "lw-announcement-dismissed:0822-hermes-agent-upgrade",
      "1",
    );

    render(<MaintenanceAnnouncementBanner />);

    expect(
      await screen.findByText(
        "LightVela 将于北京时间 2026 年 9 月 7 日 22:00-次日 02:00 升级 Hermes Agent 版本，期间对话和任务可能短暂中断，带来不便敬请谅解。",
      ),
    ).toBeInTheDocument();
  });

  it("marks the page while the announcement is visible", async () => {
    const { unmount } = render(<MaintenanceAnnouncementBanner />);

    await screen.findByRole("status");
    expect(document.body).toHaveClass("lw-has-announcement");

    unmount();
    expect(document.body).not.toHaveClass("lw-has-announcement");
  });

  it("removes the maintenance announcement at 02:00 Beijing time", async () => {
    const expiresAt = Date.UTC(2026, 8, 7, 18, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(expiresAt - 1_000);

    render(<MaintenanceAnnouncementBanner />);
    await act(async () => undefined);

    expect(screen.getByRole("status")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_000));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(document.body).not.toHaveClass("lw-has-announcement");
  });
});
