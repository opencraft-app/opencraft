import { afterEach, describe, expect, it } from "vitest";

import {
  BLOG_POSTS,
  formatBlogPublishedAt,
  formatBlogPublishedDate,
  getBlogPost,
} from "@/pages/marketing/blog-content";

const originalTimeZone = process.env.TZ;

describe("Blog publishing dates", () => {
  afterEach(() => {
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

  it("assigns one approved author to every published post", async () => {
    const { BLOG_POSTS } = await import("@/pages/marketing/blog-content");

    expect(BLOG_POSTS).toHaveLength(7);
    expect(BLOG_POSTS.map((post) => post.author)).toEqual([
      "Cassidy Shi",
      "Cassidy Shi",
      "Cassidy Shi",
      "Cassidy Shi",
      "Cassidy Shi",
      "Cassidy Shi",
      "Cassidy Shi",
    ]);
  });

  it.each([
    "zh-CN",
    "zh-SG",
    "zh-Hant",
    "id-ID",
    "es",
    "ja-JP",
    "ko-KR",
  ] as const)("localizes Blog metadata for %s without changing the cover image", (locale) => {
    const localized = getBlogPost("dsh-revived-broken-hermes-agent", locale);

    expect(localized).toBeDefined();
    expect(localized?.title).not.toBe("For Just $0.03, DSH Brought a Broken Hermes Agent Back to Life");
    expect(localized?.coverImage).toBe("/assets/blog/dsh-revived-broken-hermes-agent/cover.webp");
  });

  it.each([
    ["zh-CN", "一个新问题，让这对组合有了新的使命。"],
    ["zh-SG", "一个新问题，让这对组合有了新的使命。"],
    ["zh-Hant", "一個新問題，讓這對組合有了新的使命。"],
  ] as const)("localizes the full Hermes repair walkthrough for %s", (locale, expectedOpening) => {
    const localized = getBlogPost("dsh-revived-broken-hermes-agent", locale);
    const paragraphs = localized?.content.filter((block) => block.type === "paragraph") ?? [];

    expect(paragraphs.some((block) => block.content.includes(expectedOpening))).toBe(true);
    expect(localized?.content.find((block) => block.type === "code")).toMatchObject({
      content: "given https://skillhub.cn/install/skillhub.md, install @user_70854421/hermes-agent-skill-for-dsh.",
    });
  });

  it.each(["zh-CN", "zh-SG", "zh-Hant", "id-ID", "es", "ja-JP", "ko-KR"] as const)(
    "localizes body copy for every public non-English locale: %s",
    (locale) => {
      for (const sourcePost of BLOG_POSTS) {
        const localized = getBlogPost(sourcePost.slug, locale);
        const sourceParagraph = sourcePost.content.find((block) => block.type === "paragraph");
        const localizedParagraph = localized?.content.find((block) => block.type === "paragraph");

        expect(localizedParagraph?.type).toBe("paragraph");
        expect(sourceParagraph?.type).toBe("paragraph");
        if (sourceParagraph?.type !== "paragraph" || localizedParagraph?.type !== "paragraph") continue;

        const sourceText = sourceParagraph.content
          .filter((inline): inline is string => typeof inline === "string")
          .join("");
        const localizedText = localizedParagraph.content
          .filter((inline): inline is string => typeof inline === "string")
          .join("");

        expect(localizedText).not.toBe(sourceText);
      }
    },
  );

  it.each(["zh-CN", "zh-SG", "zh-Hant", "id-ID", "es", "ja-JP", "ko-KR"] as const)(
    "localizes every review-scope image alt for %s",
    (locale) => {
      const reviewScopePostSlugs = new Set([
        "dsh-revived-broken-hermes-agent",
        "hermes-deepseek-harness-10x-efficiency",
        "tencent-cloud-agent-early-taste-of-meta-muse",
      ]);

      for (const sourcePost of BLOG_POSTS.filter((post) => reviewScopePostSlugs.has(post.slug))) {
        const localized = getBlogPost(sourcePost.slug, locale);
        const sourceImages = sourcePost.content.filter((block) => block.type === "image");
        const localizedImages = localized?.content.filter((block) => block.type === "image") ?? [];

        expect(localizedImages).toHaveLength(sourceImages.length);
        for (const [index, sourceImage] of sourceImages.entries()) {
          expect(localizedImages[index]).toMatchObject({
            type: "image",
            alt: expect.not.stringContaining(sourceImage.alt),
          });
        }
      }
    },
  );

  it("keeps the Meta Muse LightVela sign-up paragraph as plain copy", () => {
    const post = getBlogPost("tencent-cloud-agent-early-taste-of-meta-muse");
    const signUpParagraph = post?.content.find(
      (block) =>
        block.type === "paragraph" &&
        block.content.includes(
          "With a free trial on offer, he signed up - why not. Registration is simple (WeChat, QQ, or phone number on the China site), and when he spotted the international site at a different domain - lightvela.ai - he went straight there. If you know, you know.",
        ),
    );

    expect(signUpParagraph).toMatchObject({
      type: "paragraph",
      content: [
        "With a free trial on offer, he signed up - why not. Registration is simple (WeChat, QQ, or phone number on the China site), and when he spotted the international site at a different domain - lightvela.ai - he went straight there. If you know, you know.",
      ],
    });
  });
});
