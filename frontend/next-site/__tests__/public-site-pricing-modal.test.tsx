import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@next-site/pricing-modal", () => ({
  PricingModal: ({ open, resumePayReturn, locale, localized }: { open: boolean; resumePayReturn?: boolean; locale?: string; localized?: boolean }) => (
    <div data-testid="pricing-modal" data-resume={resumePayReturn ? "yes" : "no"} data-locale={locale} data-localized={localized ? "yes" : "no"}>{open ? "open" : "closed"}</div>
  ),
}));

import { PublicSitePricingModalProvider } from "@next-site/public-site-pricing-modal";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});

const renderWithEntry = (anchorHtml: string) => {
  const container = document.createElement("div");
  container.innerHTML = anchorHtml;
  document.body.appendChild(container);
  render(<PublicSitePricingModalProvider>{null}</PublicSitePricingModalProvider>);
  return container.querySelector("a")!;
};

describe("PublicSitePricingModalProvider", () => {
  it("opens the pricing modal for a subscribe entry outside the header", () => {
    const anchor = renderWithEntry('<a href="/subscribe">Free trial</a>');

    fireEvent.click(anchor);

    expect(screen.getByTestId("pricing-modal")).toHaveTextContent("open");
  });

  it("keeps the standalone page for the top navigation pricing link", () => {
    const anchor = renderWithEntry(
      '<div class="lw-public-site-header"><a href="/subscribe">Pricing</a></div>',
    );

    fireEvent.click(anchor);

    expect(screen.getByTestId("pricing-modal")).toHaveTextContent("closed");
  });

  it("does not intercept other links", () => {
    const anchor = renderWithEntry('<a href="/docs/overview">Docs</a>');

    fireEvent.click(anchor);

    expect(screen.getByTestId("pricing-modal")).toHaveTextContent("closed");
  });

  it("uses the active localized route for the pricing dialog", () => {
    window.history.replaceState({}, "", "/zh-cn/");
    const anchor = renderWithEntry('<a href="/zh-cn/subscribe">Free trial</a>');
    fireEvent.click(anchor);

    expect(screen.getByTestId("pricing-modal")).toHaveAttribute("data-locale", "zh-CN");
    expect(screen.getByTestId("pricing-modal")).toHaveAttribute("data-localized", "yes");
  });

  it("resumes a payment return on the host page", () => {
    window.history.replaceState({}, "", "/?pay_return=1&pay_plan=launch");
    render(<PublicSitePricingModalProvider>{null}</PublicSitePricingModalProvider>);

    expect(screen.getByTestId("pricing-modal")).toHaveTextContent("open");
    expect(screen.getByTestId("pricing-modal")).toHaveAttribute("data-resume", "yes");
  });

  it("leaves the standalone subscribe page to handle its own payment return", () => {
    window.history.replaceState({}, "", "/subscribe?pay_return=1");
    render(<PublicSitePricingModalProvider>{null}</PublicSitePricingModalProvider>);

    expect(screen.getByTestId("pricing-modal")).toHaveTextContent("closed");
  });
});
