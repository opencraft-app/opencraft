import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AccountActionLink,
  AccountInfoRow,
  AccountSectionHeader,
  AccountStatusBadge,
  accountCardClass,
} from "@/components/account";

describe("account surface primitives", () => {
  it("exposes the shared account card classes", () => {
    expect(accountCardClass).toContain("rounded-md");
    expect(accountCardClass).toContain("border");
    expect(accountCardClass).toContain("shadow-[0_10px_30px_rgba(15,23,42,0.04)]");
  });

  it("renders section headings and information rows with visible semantics", () => {
    render(
      <>
        <AccountSectionHeader title="Profile" description="Account details" />
        <AccountInfoRow label="Email" value="person@example.com" description="Primary contact" />
      </>,
    );

    expect(screen.getByRole("heading", { name: "Profile" })).toBeVisible();
    expect(screen.getByText("Email")).toBeVisible();
    expect(screen.getByText("person@example.com")).toBeVisible();
    expect(screen.getByText("person@example.com")).toHaveClass("min-w-0", "break-words");
    expect(screen.getByText("Primary contact")).toBeVisible();
  });

  it("marks each status badge with its tone", () => {
    render(
      <div>
        <AccountStatusBadge tone="neutral">Neutral</AccountStatusBadge>
        <AccountStatusBadge tone="success">Success</AccountStatusBadge>
        <AccountStatusBadge tone="warning">Warning</AccountStatusBadge>
        <AccountStatusBadge tone="danger">Danger</AccountStatusBadge>
      </div>,
    );

    expect(screen.getByText("Neutral")).toHaveAttribute("data-tone", "neutral");
    expect(screen.getByText("Success")).toHaveAttribute("data-tone", "success");
    expect(screen.getByText("Warning")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText("Danger")).toHaveAttribute("data-tone", "danger");
  });

  it("preserves action link accessibility props and destination", () => {
    render(
      <AccountActionLink to="/account/security" aria-label="Open security settings" icon={<span aria-hidden="true">→</span>}>
        Security
      </AccountActionLink>,
    );

    expect(screen.getByRole("link", { name: "Open security settings" })).toHaveAttribute("href", "/account/security");
  });
});
