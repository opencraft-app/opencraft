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
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 7, 22, 12, 0, 0));
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
  it("renders the Aug 22 maintenance window in Beijing time", async () => {
    render(<MaintenanceAnnouncementBanner />);

    expect(
      await screen.findByText(
        "LightVela 将于北京时间 2026 年 8 月 22 日 22:00-次日 06:00 升级 Hermes Agent 版本，期间对话和任务可能短暂中断，带来不便敬请谅解。",
      ),
    ).toBeInTheDocument();
  });

  it("removes the maintenance announcement at 06:00 Beijing time", async () => {
    const expiresAt = Date.UTC(2026, 7, 22, 22, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(expiresAt - 1_000);

    render(<MaintenanceAnnouncementBanner />);
    await act(async () => undefined);

    expect(screen.getByRole("status")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_000));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
