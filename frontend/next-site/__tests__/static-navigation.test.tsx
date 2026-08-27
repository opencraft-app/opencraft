import React, { type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UserAvatarMenu } from "@/components/site/user-avatar-menu";
import { CookieConsentBanner } from "@/components/site/cookie-consent-banner";
import { renderNextPublicSiteHeaderLink } from "@next-site/user-menu-link";

const nextLinkMock = vi.hoisted(() => vi.fn(() => null));

vi.mock("next/link", () => ({
  default: nextLinkMock,
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    div: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  },
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    session: {
      user: { name: "Static navigation user", avatarUrl: null },
      currentSubscription: null,
    },
    signOut: vi.fn(),
  }),
}));

vi.mock("@/contexts/agent-context", () => ({
  useOpenClaw: () => ({ activePass: null }),
}));

vi.mock("@/i18n/t", () => ({
  useT: () => (value: string) => value,
}));

vi.mock("@/lib/avatar-image", () => ({
  avatarImageUrl: () => "https://example.com/avatar.png",
}));

vi.mock("@/lib/region", () => ({
  isGlobal: true,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/en-us",
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: "en-US" },
  }),
}));

describe("static navigation links", () => {
  beforeEach(() => {
    (globalThis as { React?: typeof React }).React = React;
    nextLinkMock.mockClear();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("uses native anchors for public site header navigation", () => {
    render(
      renderNextPublicSiteHeaderLink({
        href: "/subscribe",
        children: "Pricing",
      }),
    );

    const link = screen.getByRole("link", { name: "Pricing" });
    expect(link).toHaveAttribute("href", "/subscribe");
    expect(link.tagName).toBe("A");
    expect(nextLinkMock).not.toHaveBeenCalled();
  });

  it("uses native anchors for the user avatar menu", () => {
    render(<UserAvatarMenu />);

    const avatarLink = screen.getByRole("link", { name: "avatar" });
    expect(avatarLink).toHaveAttribute("href", "/account");
    expect(avatarLink.tagName).toBe("A");
    expect(nextLinkMock).not.toHaveBeenCalled();
  });

  it("uses native anchors for the cookie consent policy link", () => {
    render(<CookieConsentBanner />);

    const policyLink = screen.getByRole("link", { name: "Cookie Policy" });
    expect(policyLink).toHaveAttribute("href", "/en-us/cookie-policy");
    expect(policyLink.tagName).toBe("A");
    expect(nextLinkMock).not.toHaveBeenCalled();
  });
});
