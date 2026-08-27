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
    expect(publicSiteHref("/changelog", "zh-CN", { localized: true })).toBe("/changelog");
    expect(publicSiteHref("/changelog", "en-US", { localized: true })).toBe("/en-us/changelog");
  });

  it("keeps English as the unprefixed default in global builds", async () => {
    const { publicSiteHref } = await loadPublicSiteNavigation("global");

    expect(publicSiteHref("/", "en-US", { localized: true })).toBe("/");
    expect(publicSiteHref("/", "zh-CN", { localized: true })).toBe("/zh-sg");
    expect(publicSiteHref("/", "zh-SG", { localized: true })).toBe("/zh-sg");
    expect(publicSiteHref("/", "id-ID", { localized: true })).toBe("/id-id");
    expect(publicSiteHref("/docs/overview", "en-US", { localized: true })).toBe("/docs/overview");
    expect(publicSiteHref("/docs/overview", "zh-CN", { localized: true })).toBe("/zh-sg/docs/overview");
    expect(publicSiteHref("/docs/overview", "zh-SG", { localized: true })).toBe("/zh-sg/docs/overview");
    expect(publicSiteHref("/docs/overview", "id-ID", { localized: true })).toBe("/id-id/docs/overview");
    expect(publicSiteHref("/changelog", "en-US", { localized: true })).toBe("/changelog");
    expect(publicSiteHref("/changelog", "zh-CN", { localized: true })).toBe("/zh-sg/changelog");
    expect(publicSiteHref("/changelog", "id-ID", { localized: true })).toBe("/id-id/changelog");
    expect(publicSiteHref("/subscribe", "id-ID", { localized: true })).toBe("/id-id/subscribe");
    expect(publicSiteHref("/support", "id-ID", { localized: true })).toBe("/id-id/support");
    expect(publicSiteHref("/about", "es", { localized: true })).toBe("/es/about");
    expect(publicSiteHref("/agents", "es", { localized: true })).toBe("/agents");
  });
});

describe("PUBLIC_SITE_NAV_ITEMS pricing entry", () => {
  it("exposes a pricing entry pointing to /subscribe visible on the global site", async () => {
    const { PUBLIC_SITE_NAV_ITEMS } = await loadPublicSiteNavigation("global");

    const pricing = PUBLIC_SITE_NAV_ITEMS.find((item) => item.section === "pricing");

    expect(pricing).toBeDefined();
    expect(pricing?.href).toBe("/subscribe");
    // 国际站也需展示 Pricing 入口：不应再被 cnOnly 限制为仅国内站。
    expect(pricing?.cnOnly).toBeFalsy();
    expect(pricing?.label["en-US"]).toBe("Pricing");
  });
});
