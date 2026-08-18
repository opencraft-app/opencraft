import React, { type ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/site/public-site-header", () => ({
  PublicSiteHeader: ({ authControls }: { authControls?: ReactNode }) => (
    <header>{authControls}</header>
  ),
}));

vi.mock("@/components/site/legal-footer", () => ({
  LegalFooter: () => <footer />,
}));

vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => ({
    isLoggedIn: false,
    isSubscribed: false,
    subscribe: vi.fn(),
    addBot: vi.fn(),
    bots: [],
    user: null,
    refreshPasses: vi.fn(),
    activePass: null,
    latestPass: null,
  }),
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    authReady: true,
    isAuthenticated: false,
    session: {
      stage: "anonymous",
      user: null,
    },
  }),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    plans: {
      listBundles: vi.fn(),
    },
  }),
}));

vi.mock("@/contexts/runtime-config-context", () => ({
  usePaidBillingEnabled: () => true,
  useRealnamePhoneVerificationEnabled: () => false,
}));

vi.mock("@/i18n/t", () => ({
  useT: () => (zh: string) => zh,
  // LoginModal 等组件用 `useLocaleOverride() ?? i18n.language` 判定语言，
  // 返回 null 表示无路由级覆盖，保持用例原有语言行为。
  useLocaleOverride: () => null,
}));

vi.mock("@/lib/app-navigation", () => ({
  AppLink: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useAppNavigate: () => vi.fn(),
}));

const getCreditValue = (tab: HTMLElement) => {
  const text = tab.textContent?.trim() ?? "";
  if (text.startsWith("10000")) return "10000";
  if (text.startsWith("4500")) return "4500";
  if (text.startsWith("200")) return "200";
  if (text.startsWith("100")) return "100";
  return null;
};

const getCreditTabs = () =>
  screen
    .getAllByRole("tab")
    .filter((tab) => getCreditValue(tab) !== null);

const getCreditTab = (credit: string) => {
  const tab = getCreditTabs().find((item) => getCreditValue(item) === credit);
  if (!tab) throw new Error(`Missing ${credit} credit tab`);
  return tab;
};

describe("SubscribePage", () => {
  it("shows low credit tiers first and selects them by default", async () => {
    (globalThis as { React?: typeof React }).React = React;
    const { SubscribePage } = await import("@next-site/subscribe-page");

    render(<SubscribePage />);

    await screen.findByRole("tab", { name: "4500" });

    await waitFor(() => {
      expect(getCreditTabs().map(getCreditValue)).toEqual([
        "100",
        "4500",
        "200",
        "10000",
      ]);
    });
    expect(getCreditTab("4500")).toHaveAttribute("aria-selected", "false");
    expect(getCreditTab("10000")).toHaveAttribute("aria-selected", "false");
    expect(getCreditTab("100")).toHaveAttribute("aria-selected", "true");
    expect(getCreditTab("200")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("14天免费体验")).not.toBeInTheDocument();
  });
});
