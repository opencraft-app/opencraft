import { describe, expect, it } from "vitest";

import { publicSiteHref } from "@/lib/public-site-navigation";

describe("publicSiteHref", () => {
  it("keeps localized home links compatible with static export filenames", () => {
    expect(publicSiteHref("/", "en-US", { localized: true })).toBe("/en-us");
    expect(publicSiteHref("/", "zh-SG", { localized: true })).toBe("/zh-sg");
    expect(publicSiteHref("/", "zh-CN", { localized: true })).toBe("/zh-cn");
  });

  it("keeps default Chinese docs on the unprefixed route", () => {
    expect(publicSiteHref("/docs/overview", "zh-CN", { localized: true })).toBe("/docs/overview");
    expect(publicSiteHref("/docs/overview", "en-US", { localized: true })).toBe("/en-us/docs/overview");
  });
});
