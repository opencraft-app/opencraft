import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BlogArticlePage } from "@/pages/marketing/blog-article-page";

vi.mock("@/lib/region", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/region")>()),
  isGlobal: true,
}));

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

vi.mock("@/components/site/legal-footer", () => ({
  LegalFooter: () => <footer>footer</footer>,
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
      "/assets/blog/basketball-shoe-storefront-with-lightvela-workbench/cover-light.png",
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

  it("renders the Meta Muse article with the temporary cover and ordered screenshots", () => {
    render(<BlogArticlePage slug="tencent-cloud-agent-early-taste-of-meta-muse" />);

    expect(
      screen.getByRole("heading", { name: "Tencent's Cloud Agent Gave an Early Taste of Meta's Muse" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "A Discovery: Tencent LightVela" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "First Hands-On with LightVela" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Scheduled tasks" })).toBeInTheDocument();

    const article = screen.getAllByRole("article").find((candidate) =>
      candidate.textContent?.includes("Tencent's Cloud Agent Gave an Early Taste of Meta's Muse"),
    );
    if (!article) throw new Error("Expected the Meta Muse article to be rendered");

    const images = within(article).getAllByRole("img");
    expect(images).toHaveLength(19);
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/cover.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/01-mark-zuckerberg-muse.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/02-meta-stock.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/03-muse-waitlist.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/04-lightvela-home.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/05-about-lightvela.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/06-subscription-credits.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/07-chat-empty.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/08-meta-stock-analysis.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/09-chat-token-counter.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/10-scheduled-tasks-dashboard.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/11-scheduled-task-monitor.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/12-scheduled-task-setup.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/13-scheduled-task-results-overview.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/14-scheduled-task-results-details.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/15-scheduled-task-results-more.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/16-channels-wechat.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/17-wechat-voice-clarification.png",
      "/assets/blog/tencent-cloud-agent-early-taste-of-meta-muse/18-wechat-delivery.png",
    ]);
    expect(within(article).getByText("Cassidy Shi")).toBeInTheDocument();
    expect(within(article).getByText(/With a free trial on offer/)).toBeInTheDocument();
    expect(article.querySelector('a[href*="doc.weixin.qq.com"]')).toBeNull();
    expect(within(article).getByRole("heading", { name: "Share" })).toBeInTheDocument();
  });
});
