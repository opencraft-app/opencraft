import type { AnchorHTMLAttributes, ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CookieConsentBanner } from "@/components/site/cookie-consent-banner";
import {
  COOKIE_CONSENT_NECESSARY,
  COOKIE_CONSENT_STORAGE_KEY,
} from "@/lib/cookie-consent";

const routeState = vi.hoisted(() => ({
  language: "en-US",
  pathname: "/en-us",
}));

vi.mock("@/lib/region", () => ({ isGlobal: true }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: {
      language: routeState.language,
    },
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routeState.pathname,
}));

type NextLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  children: ReactNode;
  href: string;
};

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: NextLinkProps) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const renderBanner = () =>
  render(
    <MemoryRouter>
      <CookieConsentBanner />
    </MemoryRouter>,
  );

describe("CookieConsentBanner", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    window.localStorage.clear();
    routeState.language = "en-US";
    routeState.pathname = "/en-us";
  });

  it("links the English banner to the matching localized cookie policy", () => {
    renderBanner();

    expect(screen.getByRole("link", { name: "Cookie Policy" })).toHaveAttribute("href", "/en-us/cookie-policy");
  });

  it("uses Chinese copy and links Chinese routes to the Chinese cookie policy", () => {
    routeState.language = "zh-CN";
    routeState.pathname = "/zh-cn/about";

    renderBanner();

    expect(screen.getByRole("link", { name: "Cookie 政策" })).toHaveAttribute("href", "/zh-cn/cookie-policy");
  });

  it("stores a necessary-only choice and hides the banner", () => {
    renderBanner();

    fireEvent.click(screen.getByRole("button", { name: "Necessary only" }));

    expect(window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY)).toBe(COOKIE_CONSENT_NECESSARY);
    expect(screen.queryByRole("heading", { name: "Cookie Policy" })).not.toBeInTheDocument();
  });
});
