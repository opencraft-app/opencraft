import { afterEach, describe, expect, it, vi } from "vitest";

async function loadPublicSiteNavigation(region: "cn" | "global") {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_REGION", region);
  return import("@/lib/public-site-navigation");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("publicSiteHref", () => {
  it("keeps Chinese as the unprefixed default in cn builds", async () => {
    const { publicSiteHref } = await loadPublicSiteNavigation("cn");

    expect(publicSiteHref("/", "zh-CN", { localized: true })).toBe("/");
    expect(publicSiteHref("/", "en-US", { localized: true })).toBe("/en-us");
    expect(publicSiteHref("/", "zh-SG", { localized: true })).toBe("/zh-sg");
    expect(publicSiteHref("/docs/overview", "zh-CN", { localized: true })).toBe("/docs/overview");
    expect(publicSiteHref("/docs/overview", "en-US", { localized: true })).toBe("/en-us/docs/overview");
  });

  it("keeps English as the unprefixed default in global builds", async () => {
    const { publicSiteHref } = await loadPublicSiteNavigation("global");

    expect(publicSiteHref("/", "en-US", { localized: true })).toBe("/");
    expect(publicSiteHref("/", "zh-CN", { localized: true })).toBe("/zh-cn");
    expect(publicSiteHref("/", "zh-SG", { localized: true })).toBe("/zh-sg");
    expect(publicSiteHref("/docs/overview", "en-US", { localized: true })).toBe("/docs/overview");
    expect(publicSiteHref("/docs/overview", "zh-CN", { localized: true })).toBe("/zh-cn/docs/overview");
  });
});
