import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BlogPage } from "@/pages/marketing/blog-page";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => text,
}));

vi.mock("@/components/site/lightvela-footer", () => ({
  LightVelaFooter: () => <footer>footer</footer>,
}));

vi.mock("@/components/site/public-site-header", () => ({
  PublicSiteHeader: () => <header>header</header>,
}));

describe("BlogPage", () => {
  it("renders article cards with accessible category switches", () => {
    render(<BlogPage />);

    expect(screen.getByRole("heading", { name: "博客" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "公告" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("link", { name: /Using Hermes Agent as a Discord bot/ })).toHaveAttribute(
      "href",
      "/blog/using-hermes-agent-as-a-discord-bot",
    );
    expect(screen.getByRole("link", { name: /I Recreated Claude Tag with LightVela/ })).toHaveAttribute(
      "href",
      "/blog/recreated-claude-tag-with-lightvela",
    );
    const latestCard = screen.getByRole("link", { name: /I Recreated Claude Tag with LightVela/ });
    expect(screen.queryByText(/I host my mega Discord server with over 600 users/)).not.toBeInTheDocument();
    expect(latestCard.querySelector("img")).toHaveClass("rounded-md");
    expect(latestCard.querySelector("h2")).toHaveClass("line-clamp-2", "min-h-[2.5rem]", "text-pretty");
    expect(latestCard.querySelector("time")).toHaveTextContent("September 1, 2026");
    expect(latestCard.parentElement).toHaveClass("lg:grid-cols-3");

    fireEvent.click(screen.getByRole("button", { name: "产品" }));

    expect(screen.getByRole("button", { name: "产品" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("link", { name: /Using Hermes Agent as a Discord bot/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "使用场景" }));

    expect(screen.getByRole("link", { name: /Using Hermes Agent as a Discord bot/ })).toBeInTheDocument();
  });
});
