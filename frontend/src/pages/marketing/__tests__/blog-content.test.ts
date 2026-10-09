import { afterEach, describe, expect, it, vi } from "vitest";
import translations from "../blog-content-regional-translations.json";
import { LOCALE_DEFINITIONS } from "@/i18n/locales.config";

import {
  BLOG_POSTS,
  formatBlogPublishedAt,
  formatBlogPublishedDate,
  getBlogPost,
  getBlogPosts,
  cleanBlogTrialUrl,
} from "@/pages/marketing/blog-content";

const region = vi.hoisted(() => ({ isGlobal: true }));
vi.mock("@/lib/region", () => ({ get isGlobal() { return region.isGlobal; } }));
const originalTimeZone = process.env.TZ;

describe("Blog publishing dates", () => {
  afterEach(() => {
    region.isGlobal = true;
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  });

  it("formats the detail timestamp in the requested locale and Beijing time", () => {
    const publishedAt = "2026-09-01T00:30:00+08:00";
    process.env.TZ = "UTC";

    expect(formatBlogPublishedAt(publishedAt, "zh-Hant")).toBe(
      new Intl.DateTimeFormat("zh-Hant", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Shanghai",
      }).format(new Date(publishedAt)),
    );
  });

  it("formats the listing date in the requested locale and Beijing time", () => {
    const publishedAt = "2026-09-01T00:30:00+08:00";
    process.env.TZ = "UTC";

    expect(formatBlogPublishedDate(publishedAt, "zh-Hant")).toBe(
      new Intl.DateTimeFormat("zh-Hant", {
        dateStyle: "long",
        timeZone: "Asia/Shanghai",
      }).format(new Date(publishedAt)),
    );
  });

  it.each([true, false])("uses the selected language for complete article translations, global=%s", (global) => {
    region.isGlobal = global;
    for (const { code: locale } of LOCALE_DEFINITIONS) {
      const language = !global || locale === "zh-SG" || locale === "zh-CN" ? "zh-CN" : locale === "en-US" ? "en" : locale;
      const posts = getBlogPosts(locale);
      expect(posts.map((post) => post.slug)).toEqual(BLOG_POSTS.map((post) => post.slug));
      for (const [index, post] of posts.entries()) {
        expect(post.language).toBe(language);
        expect(post.coverImage).toBe(BLOG_POSTS[index]?.coverImage);
        expect(post.content.filter((block) => block.type === "image")).toEqual(BLOG_POSTS[index]?.content.filter((block) => block.type === "image"));
        const prose = JSON.stringify({title: post.title, excerpt: post.excerpt, content: post.content.filter((block) => block.type !== "image")});
        if (["en", "es", "id-ID", "ms-MY"].includes(language)) expect(prose).not.toMatch(/[\u4e00-\u9fff]/);
        else if (language === "ko-KR") expect(post.title).toMatch(/[\uac00-\ud7af]/);
        else expect(post.title).toMatch(/[\u4e00-\u9fff]/);
        expect(prose).not.toMatch(/[?&](from|utm_)/);
      }
    }
    const intro = getBlogPost("lightvela-personal-ai-cloud-now-live");
    expect(JSON.stringify(intro)).toContain(global ? "https://lightvela.ai/" : "https://lightvela.com/");
  });

  it.each(["es", "id-ID", "ja-JP", "ko-KR"] as const)("has complete %s translations without silently returning English or Chinese prose", (language) => {
    const dictionary: Readonly<Record<string, string>> = translations[language];
    const texts = BLOG_POSTS.flatMap((post) => [post.title, post.excerpt, ...post.content.flatMap((block) => {
      const inline = (part: string | { label: string }) => typeof part === "string" ? part : part.label;
      switch (block.type) {
        case "image": return [];
        case "heading": return [block.text];
        case "code": return [block.content];
        case "paragraph": return block.content.map(inline);
        case "ordered-list": return [block.ariaLabel, ...block.items.flatMap((item) => item.map(inline))];
        case "unordered-list": return block.items.flatMap((item) => item.map(inline));
      }
    })]);
    const english: Readonly<Record<string, string>> = translations.en;
    for (const source of texts) {
      expect(dictionary, `${language}: ${source}`).toHaveProperty(source);
      const translated = dictionary[source];
      expect(translated?.trim()).not.toBe("");
      if (/^https?:\/\//.test(source) || source === "Skills.sh") {
        expect(translated).toBe(source);
      } else {
        expect(translated).not.toBe(source);
        expect(translated).not.toBe(english[source] ?? source);
      }
      for (const identifier of source.match(/@user_\d+\/[a-z0-9-]+|\/home\/agentuser\/|state\.db|website-builder/g) ?? []) {
        expect(translated).toContain(identifier);
      }
    }
  });

  it("cleans tracking fields in trial URL labels and destinations without changing external references", () => {
    expect(cleanBlogTrialUrl("https://lightvela.ai/?from=social_x&utm_source=x&ref=blog")).toBe("https://lightvela.ai/");
    expect(cleanBlogTrialUrl("https://example.com/?from=reference")).toBe("https://example.com/?from=reference");
    region.isGlobal = false;
    expect(cleanBlogTrialUrl("https://lightvela.ai/?from=x")).toBe("https://lightvela.com/");
  });

  it("publishes only the four approved articles with their confirmed authors", () => {
    expect(BLOG_POSTS.map(({ slug, author, category, language }) => ({ slug, author, category, language }))).toEqual([
      { slug: "lightvela-personal-ai-cloud-now-live", author: "Jasmin Zhao", category: "product", language: "en" },
      { slug: "dsh-revived-broken-hermes-agent", author: "Walker Cao", category: "use-case", language: "zh-CN" },
      { slug: "hermes-dsh-pelican-cup", author: "Walker Cao", category: "use-case", language: "zh-CN" },
      { slug: "hermes-deepseek-harness-10x-efficiency", author: "Walker Cao", category: "use-case", language: "zh-CN" },
    ]);
  });

  it("keeps retired drafts out of direct article lookup", async () => {
    const { ARCHIVED_BLOG_POSTS } = await import("../blog-content-archive");
    expect(ARCHIVED_BLOG_POSTS).toHaveLength(7);
    const active = new Set(BLOG_POSTS.map((post) => post.slug));
    for (const post of ARCHIVED_BLOG_POSTS.filter((post) => !active.has(post.slug))) {
      expect(getBlogPost(post.slug)).toBeUndefined();
    }
  });

  it("keeps all supplied image paths local and resolvable", async () => {
    const { existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    expect(getBlogPost("hermes-deepseek-harness-10x-efficiency")?.coverImage).toBe("/assets/blog/hermes-deepseek-harness-10x-efficiency/cover-supplied.webp");
    for (const post of BLOG_POSTS) {
      const images = post.content.filter((block) => block.type === "image");
      expect(images[0]?.src).toBe(post.coverImage);
      for (const image of images) {
        if (!image.src) continue;
        expect(image.src).toMatch(/^\/assets\/blog\/.+\.webp$/);
        expect(existsSync(resolve(process.cwd(), "public", image.src.slice(1)))).toBe(true);
      }
    }
    expect(JSON.stringify(BLOG_POSTS)).not.toMatch(/qpic\.cn|doc.weixin.qq.com|<插入/);
  });
});
