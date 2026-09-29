import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BlogPage } from "@/pages/marketing/blog-page";

vi.mock("@/lib/region", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/region")>()),
  isGlobal: true,
}));

vi.mock("@/i18n/t", () => ({
  // 组件里用它按 locale 格式化日期（Intl），mock 固定成 zh-CN
  useCurrentLocale: () => "zh-CN",
  useT: () => (text: string) => text,
}));

vi.mock("@/components/site/legal-footer", () => ({
  LegalFooter: () => <footer>footer</footer>,
}));

vi.mock("@/components/site/public-site-header", () => ({
  PublicSiteHeader: ({ appearance }: { appearance?: string }) => (
    <header data-appearance={appearance}>header</header>
  ),
}));

afterEach(cleanup);

describe("BlogPage", () => {
  it("shows only the replacement articles and filters by their categories", () => {
    render(<BlogPage />);
    expect(screen.getByRole("heading", { name: "博客" })).toBeInTheDocument();
    const cards = screen.getAllByRole("link");
    expect(cards).toHaveLength(4);
    expect(screen.getAllByText("Walker Cao")).toHaveLength(3);
    expect(screen.getByText("Jasmin Zhao")).toBeInTheDocument();
    expect(cards[0]?.querySelector("h2")).toHaveAttribute("lang", "en");
    expect(cards[0]).toHaveAttribute("href", "/blog/lightvela-personal-ai-cloud-now-live");
    expect(cards[1]?.querySelector("h2")).toHaveAttribute("lang", "en");
    expect(cards[3]?.querySelector("img")).toHaveAttribute("src", "/assets/blog/hermes-deepseek-harness-10x-efficiency/cover-supplied.webp");
    expect(screen.queryByText("Cassidy Shi")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "产品" }));
    expect(screen.getByRole("button", { name: "产品" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: /Personal AI in the Cloud/ })).toHaveAttribute("href", "/blog/lightvela-personal-ai-cloud-now-live");
    fireEvent.click(screen.getByRole("button", { name: "使用场景" }));
    expect(screen.getAllByRole("link")).toHaveLength(3);
    expect(screen.queryByText("Jasmin Zhao")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "公告" }));
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(screen.getAllByRole("link")).toHaveLength(4);
  });

  it("preserves source titles while localizing article links and dates", () => {
    render(<BlogPage publicLocale="zh-Hant" publicLocalized />);
    const card = screen.getByRole("link", { name: /只花 0.25/ });
    expect(card).toHaveAttribute("href", "/zh-hant/blog/dsh-revived-broken-hermes-agent");
    const time = card.querySelector("time");
    expect(time).toHaveTextContent(new Intl.DateTimeFormat("zh-Hant", {
      dateStyle: "long", timeZone: "Asia/Shanghai",
    }).format(new Date(time?.getAttribute("datetime") ?? "")));
    expect(within(card).getByText("Walker Cao")).toBeInTheDocument();
  });
});
