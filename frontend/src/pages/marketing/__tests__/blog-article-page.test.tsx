import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BlogArticlePage } from "@/pages/marketing/blog-article-page";

vi.mock("@/i18n/t", () => ({
  useT: () => (text: string) => {
    const translations: Record<string, string> = {
      "返回": "Back",
      "分享": "Share",
      "复制链接": "Copy link",
      "已复制": "Copied",
    };
    return translations[text] ?? text;
  },
}));

vi.mock("@/components/site/lightvela-footer", () => ({
  LightVelaFooter: () => <footer>footer</footer>,
}));

vi.mock("@/components/site/public-site-header", () => ({
  PublicSiteHeader: () => <header>header</header>,
}));

describe("BlogArticlePage", () => {
  it("renders the formatted English article and its supplied images", () => {
    render(<BlogArticlePage slug="using-hermes-agent-as-a-discord-bot" />);

    expect(
      screen.getByRole("heading", { name: "Using Hermes Agent as a Discord bot to drive my 600-user server engagement" }),
    ).toHaveClass("font-bold", "text-3xl", "sm:text-4xl");
    expect(screen.queryByRole("heading", { name: "Summary" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/blog");
    expect(screen.getByRole("heading", { name: "Connecting the bot" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Areas of improvement" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Discord bot setup steps" })).toBeInTheDocument();
    expect(screen.getByText(/Every Friday at 18:00, send a short reminder/)).toBeInTheDocument();
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(9);
    const coverImage = images[0];
    expect(coverImage).toBeDefined();
    if (!coverImage) throw new Error("Expected the article cover image to be rendered");
    expect(screen.getByRole("link", { name: "Back" }).compareDocumentPosition(coverImage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const backLink = screen.getByRole("link", { name: "Back" });
    expect(backLink.querySelector("span")?.className).toContain("no-underline");
    expect(coverImage.compareDocumentPosition(screen.getByRole("heading", { name: /Using Hermes Agent/ })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(coverImage).toHaveClass("aspect-video", "object-cover");
    expect(screen.getByRole("img", { name: /existing bots/ })).toHaveClass("max-w-[220px]");
    expect(screen.getByText(/Hermes Agent gave my 600-user Discord server/).closest("p")).toHaveClass("leading-[1.75rem]");
    expect(screen.getByRole("heading", { name: "Share" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Share X" })).toHaveAttribute(
      "href",
      expect.stringContaining("https%3A%2F%2Flightvela.ai%2Fblog%2Fusing-hermes-agent-as-a-discord-bot"),
    );
    expect(screen.getByRole("link", { name: "Share LinkedIn" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Share Facebook" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Discord Developer Portal" })[0]).toHaveAttribute(
      "href",
      "https://discord.com/developers/home",
    );
  });

  it("renders the Slack digital employee use case article", () => {
    render(<BlogArticlePage slug="recreated-claude-tag-with-lightvela" />);

    expect(
      screen.getByRole("heading", { name: "I Recreated Claude Tag with LightVela and Set Up a \“Digital Employee\” in Slack" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Step 1: Activate a LightVela plan" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Step 5: Connect Notion and turn chat into a knowledge base" })).toBeInTheDocument();
    expect(screen.getByText(/hermes mcp add/)).toBeInTheDocument();
    const article = screen.getAllByRole("article").find((candidate) =>
      candidate.textContent?.includes("I Recreated Claude Tag with LightVela"),
    );
    if (!article) throw new Error("Expected the Slack digital employee article to be rendered");
    expect(article).toHaveAttribute("lang", "en");
    expect(within(article).getByRole("link", { name: "Anthropic's official Claude Tag announcement" })).toHaveAttribute(
      "href",
      "https://www.anthropic.com/news/introducing-claude-tag",
    );
    expect(within(article).getByRole("img", { name: "Colorful Slack-inspired LightVela illustration" })).toBeInTheDocument();
    expect(within(article).getAllByRole("img")).toHaveLength(8);
    expect(within(article).getByRole("img", { name: /Slack conversation with LightVela/ })).toHaveAttribute(
      "src",
      expect.stringContaining("english"),
    );
  });

  it("renders the Workbench basketball shoe storefront article with its supplied images in order", () => {
    render(<BlogArticlePage slug="basketball-shoe-storefront-with-lightvela-workbench" />);

    expect(
      screen.getByRole("heading", {
        name: "I Vibe-Coded My Own Basketball Shoe Storefront with LightVela Workbench",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "My Expectations for the Site" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Why I Started with the Campaign Hub Template" })).toBeInTheDocument();
    expect(screen.getByText(/Build a premium ecommerce campaign hub/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "The Larger Lesson" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "LightVela’s Workbench is designed for static websites, so I treated the project as the storefront and campaign layer rather than the complete commerce backend.",
      ),
    ).toBeInTheDocument();

    const article = screen.getAllByRole("article").find((candidate) =>
      candidate.textContent?.includes("I Vibe-Coded My Own Basketball Shoe Storefront"),
    );
    if (!article) throw new Error("Expected the Workbench basketball shoe storefront article to be rendered");
    expect(within(article).getByText("Sep 3, 2026, 11:31 AM")).toBeInTheDocument();
    expect(within(article).getByText("Cassidy Shi")).toBeInTheDocument();
    const images = within(article).getAllByRole("img");
    expect(images).toHaveLength(8);
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "/assets/blog/basketball-shoe-storefront-with-lightvela-workbench/cover.png",
      "/assets/blog/basketball-shoe-storefront-with-lightvela-workbench/shoe-collection.png",
      "/assets/blog/basketball-shoe-storefront-with-lightvela-workbench/workbench.png",
      "/assets/blog/basketball-shoe-storefront-with-lightvela-workbench/agent-chat.png",
      "/assets/blog/basketball-shoe-storefront-with-lightvela-workbench/cloud-storage.png",
      "/assets/blog/basketball-shoe-storefront-with-lightvela-workbench/storefront.png",
      "/assets/blog/basketball-shoe-storefront-with-lightvela-workbench/storefront-story.png",
      "/assets/blog/basketball-shoe-storefront-with-lightvela-workbench/checkout-modal.png",
    ]);
    expect(within(article).getByRole("heading", { name: "Share" })).toBeInTheDocument();
    expect(within(article).getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(within(article).getByRole("link", { name: "Share X" })).toHaveAttribute(
      "href",
      expect.stringContaining("https%3A%2F%2Flightvela.ai%2Fblog%2Fbasketball-shoe-storefront-with-lightvela-workbench"),
    );
  });
});
