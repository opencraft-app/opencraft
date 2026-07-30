import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

async function importSeoWithRegion(region: "cn" | "global") {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_REGION", region);
  vi.stubEnv("VITE_REGION", region);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  vi.stubEnv("SITE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_CN_SITE_URL", "");
  vi.stubEnv("CN_SITE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_GLOBAL_SITE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_INTL_SITE_URL", "");
  vi.stubEnv("GLOBAL_SITE_URL", "");
  vi.stubEnv("INTL_SITE_URL", "");

  return import("./seo");
}

describe("next-site SEO origin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults the global build origin to lightvela.ai", async () => {
    const { siteUrl } = await importSeoWithRegion("global");

    expect(siteUrl()).toBe("https://lightvela.ai");
  });

  it("keeps the cn build origin on lightvela.com", async () => {
    const { siteUrl } = await importSeoWithRegion("cn");

    expect(siteUrl()).toBe("https://lightvela.com");
  });
});

describe("global public SEO URL contract", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("builds real hreflang URLs from a localized public path", async () => {
    const { buildPublicAlternates } = await importSeoWithRegion("global");

    expect(buildPublicAlternates("/en-us/about")).toEqual({
      "x-default": "https://lightvela.ai/about/",
      "zh-CN": "https://lightvela.com/zh-cn/about/",
      "en-US": "https://lightvela.ai/about/",
      "zh-SG": "https://lightvela.ai/zh-sg/about/",
      "zh-Hant": "https://lightvela.ai/zh-hant/about/",
    });
  });

  it("canonicalizes the explicit English prefix to the global default URL", async () => {
    const { createPublicMetadata } = await importSeoWithRegion("global");

    const metadata = createPublicMetadata({
      path: "/en-us/about",
      locale: "en-US",
      title: "About LightVela",
      description: "About LightVela.",
    });

    expect(metadata.alternates?.canonical).toBe("/about");
    expect(metadata.openGraph?.url).toBe("https://lightvela.ai/about/");
  });

  it("keeps the current build site URL override for page URLs", async () => {
    const { absolutePageUrlForSeoRegion } = await importSeoWithRegion("global");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://preview.example.com");

    expect(absolutePageUrlForSeoRegion("global", "/about")).toBe("https://preview.example.com/about/");
    expect(absolutePageUrlForSeoRegion("cn", "/zh-cn/about")).toBe("https://lightvela.com/zh-cn/about/");
  });

  it("uses unprefixed English and prefixed zh-SG URLs in docs hreflang", async () => {
    const { buildDocsAlternates, canonicalDocsPath } = await importSeoWithRegion("global");

    expect(canonicalDocsPath("en-us", ["overview"])).toBe("/docs/overview");
    expect(canonicalDocsPath("zh-sg", ["overview"])).toBe("/zh-sg/docs/overview");

    expect(buildDocsAlternates(["overview"], ["en-us", "zh-cn", "zh-sg"])).toEqual({
      "x-default": "https://lightvela.ai/docs/overview/",
      "zh-CN": "https://lightvela.com/zh-cn/docs/overview/",
      "en-US": "https://lightvela.ai/docs/overview/",
      "zh-SG": "https://lightvela.ai/zh-sg/docs/overview/",
    });
  });

  it("publishes only canonical global routes in the sitemap", async () => {
    await importSeoWithRegion("global");
    const { GET } = await import("../src/app/sitemap.xml/route.next");
    const xml = await GET().text();
    const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);

    expect(locations).toContain("https://lightvela.ai/about/");
    expect(locations).toContain("https://lightvela.ai/zh-sg/about/");
    expect(locations).toContain("https://lightvela.ai/docs/overview/");
    expect(locations).toContain("https://lightvela.ai/zh-sg/docs/overview/");
    expect(locations).not.toContain("https://lightvela.ai/en-us/about/");
    expect(locations).not.toContain("https://lightvela.ai/docs/");
    expect(locations).not.toContain("https://lightvela.ai/en-us/docs/overview/");
    expect(locations.every((location) => location.endsWith("/"))).toBe(true);
    expect(xml).not.toContain("<lastmod>");
  });

  it("uses an explicit build date instead of a stale hard-coded sitemap date", async () => {
    vi.stubEnv("NEXT_PUBLIC_BUILD_DATE", "2026-07-21");
    const { lastModified } = await importSeoWithRegion("global");

    expect(lastModified()).toBe("2026-07-21");
  });
});

describe("global docs internal links", () => {
  it("do not repeat the configuration directory from inside that directory", () => {
    const contentRoot = join(process.cwd(), "src", "content", "docs");
    const files = ["global", "en"].flatMap((locale) => {
      const directory = join(contentRoot, locale, "configuration");
      return readdirSync(directory)
        .filter((file) => file.endsWith(".md"))
        .map((file) => join(directory, file));
    });
    const offenders = files.filter((file) => readFileSync(file, "utf8").includes("](./configuration/"));

    expect(offenders).toEqual([]);
  });
});
