import { afterEach, describe, expect, it } from "vitest";

import { formatBlogPublishedAt, formatBlogPublishedDate } from "@/pages/marketing/blog-content";

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
});
