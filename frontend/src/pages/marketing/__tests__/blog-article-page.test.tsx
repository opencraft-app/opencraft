import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as blogContent from "@/pages/marketing/blog-content";

import { BlogArticlePage } from "@/pages/marketing/blog-article-page";

vi.mock("@/lib/region", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/region")>()),
  isGlobal: true,
}));

vi.mock("@/i18n/t", () => ({
  // 组件里用它按 locale 格式化日期（Intl），mock 固定成 zh-CN
  useCurrentLocale: () => "zh-CN",
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BlogArticlePage", () => {
  it("preserves source language and leaves missing images blank without broken requests", () => {
    const source = blogContent.BLOG_POSTS[0];
    if (!source) throw new Error("Expected an existing article fixture");
    vi.spyOn(blogContent, "getBlogPost").mockReturnValueOnce({
      ...source,
      language: "zh-CN",
      title: "中文原稿",
      coverImage: null,
      content: [
        { type: "image", src: null, alt: "待补封面" },
        { type: "paragraph", content: ["保留中文正文"] },
        { type: "image", src: null, alt: "待补截图" },
      ],
    });
    const { container } = render(<BlogArticlePage slug={source.slug} publicLocale="en-US" />);
    expect(screen.getByRole("article")).toHaveAttribute("lang", "zh-CN");
    expect(screen.getByText("保留中文正文")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelectorAll("div.aspect-video")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it.each(blogContent.getBlogPosts())("renders $slug with source language, author, ordered images and sharing", (post) => {
    render(<BlogArticlePage slug={post.slug} publicLocale="en-US" />);
    const article = screen.getByRole("article");
    expect(article).toHaveAttribute("lang", post.language);
    expect(within(article).getByRole("heading", { name: post.title })).toBeInTheDocument();
    expect(within(article).getByText(post.author)).toBeInTheDocument();
    expect(Array.from(article.querySelectorAll("img")).map((image) => image.getAttribute("src"))).toEqual(
      post.content.flatMap((block) => block.type === "image" && block.src ? [block.src] : []),
    );
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/blog");
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Share X" })).toHaveAttribute("href", expect.stringContaining(encodeURIComponent(`/blog/${post.slug}`)));
  });

  it("switches the same article between English, simplified and traditional Chinese", () => {
    const slug = "lightvela-personal-ai-cloud-now-live";
    const { rerender } = render(<BlogArticlePage slug={slug} publicLocale="en-US" />);
    expect(screen.getByRole("article")).toHaveAttribute("lang", "en");
    for (const locale of ["zh-SG", "zh-Hant", "en-US"] as const) {
      rerender(<BlogArticlePage slug={slug} publicLocale={locale} publicLocalized={locale !== "en-US"} />);
      const post = blogContent.getBlogPost(slug, locale)!;
      expect(screen.getByRole("article")).toHaveAttribute("lang", post.language);
      expect(screen.getByRole("heading", { name: post.title })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", locale === "en-US" ? "/blog" : locale === "zh-SG" ? "/zh-sg/blog" : "/zh-hant/blog");
      if (locale === "zh-SG") expect(screen.getByText("LightVela 的起点，是 OpenClaw 掀起的个人 AI 热潮。")).toBeInTheDocument();
      if (locale === "zh-Hant") expect(screen.getByText("LightVela 的起點，是 OpenClaw 掀起的個人 AI 熱潮。")).toBeInTheDocument();
      if (locale === "en-US") expect(screen.getByText("LightVela began with the wave of interest in personal AI sparked by OpenClaw.")).toBeInTheDocument();
    }
  });
});
