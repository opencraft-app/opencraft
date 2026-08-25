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
      "zh-CN": "https://lightvela.com/about/",
      "en-US": "https://lightvela.ai/about/",
      "zh-SG": "https://lightvela.ai/zh-sg/about/",
      "zh-Hant": "https://lightvela.ai/zh-hant/about/",
      "id-ID": "https://lightvela.ai/id-id/about/",
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

  it("keeps cn canonical/og on the bare path (never /zh-cn/)", async () => {
    // 国内站只有 zh-CN 一种语言，裸路径即唯一正式 URL：
    // canonical / og:url / hreflang 三处必须一致指向裸路径，
    // 否则会与「不再生成 /zh-cn/ 路由」的改动自相矛盾。
    const { buildDocsAlternates, canonicalDocsPath, createPublicMetadata } =
      await importSeoWithRegion("cn");

    const page = createPublicMetadata({
      path: "/about",
      locale: "zh-CN",
      title: "关于 LightVela",
      description: "关于 LightVela。",
    });

    expect(page.alternates?.canonical).toBe("/about");
    expect(page.openGraph?.url).toBe("https://lightvela.com/about/");
    expect(page.alternates?.languages?.["zh-CN"]).toBe("https://lightvela.com/about/");

    expect(canonicalDocsPath("zh-cn", ["plans"])).toBe("/zh-cn/docs/plans");
    const docs = createPublicMetadata({
      // 国内站文档页实际传入的是裸路径（不再有 /zh-cn/ 路由）
      path: canonicalDocsPath("default", ["plans"]),
      locale: "zh-CN",
      title: "订阅方案",
      description: "订阅方案说明。",
      alternates: buildDocsAlternates(["plans"], ["zh-cn"]),
    });

    expect(docs.alternates?.canonical).toBe("/docs/plans");
    expect(docs.openGraph?.url).toBe("https://lightvela.com/docs/plans/");
    expect(docs.alternates?.languages?.["zh-CN"]).toBe("https://lightvela.com/docs/plans/");
  });

  it("guards [lang] routes with the same set generateStaticParams uses", async () => {
    // 曾经 generateStaticParams 用 SEO_PREFIXED_PUBLIC_URL_LANGS（已排除 en-us），
    // 而运行时守卫用 publicRouteLocaleFromLang（含全部 5 种语言）——
    // 结果 /en-us/about/ 在 dev 下返回 200、静态导出后却是 404，两边行为不一致。
    const { prefixedPublicRouteLocale, SEO_PREFIXED_PUBLIC_URL_LANGS } = await importSeoWithRegion("global");

    expect([...SEO_PREFIXED_PUBLIC_URL_LANGS]).toEqual(["zh-sg", "zh-hant", "id-id"]);
    // 默认语言只有裸路径，前缀路由一律拒绝
    expect(prefixedPublicRouteLocale("en-us")).toBeNull();
    expect(prefixedPublicRouteLocale("zh-cn")).toBeNull();
    expect(prefixedPublicRouteLocale("zh-sg")).toEqual({ locale: "zh-SG", localized: true });
    expect(prefixedPublicRouteLocale("id-id")).toEqual({ locale: "id-ID", localized: true });
    expect(prefixedPublicRouteLocale("fr")).toBeNull();
  });

  it("generates no prefixed routes at all on the cn build", async () => {
    const { prefixedPublicRouteLocale, SEO_PREFIXED_PUBLIC_URL_LANGS } = await importSeoWithRegion("cn");

    expect([...SEO_PREFIXED_PUBLIC_URL_LANGS]).toEqual([]);
    for (const lang of ["zh-cn", "en-us", "zh-sg", "zh-hant", "id-id"]) {
      expect(prefixedPublicRouteLocale(lang)).toBeNull();
    }
  });

  it("keeps the current build site URL override for page URLs", async () => {    const { absolutePageUrlForSeoRegion } = await importSeoWithRegion("global");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://preview.example.com");

    expect(absolutePageUrlForSeoRegion("global", "/about")).toBe("https://preview.example.com/about/");
    expect(absolutePageUrlForSeoRegion("cn", "/zh-cn/about")).toBe("https://lightvela.com/zh-cn/about/");
  });

  it("uses unprefixed English and prefixed zh-SG/id-ID URLs in docs hreflang", async () => {
    const { buildDocsAlternates, canonicalDocsPath } = await importSeoWithRegion("global");

    expect(canonicalDocsPath("en-us", ["overview"])).toBe("/docs/overview");
    expect(canonicalDocsPath("zh-sg", ["overview"])).toBe("/zh-sg/docs/overview");
    expect(canonicalDocsPath("id-id", ["overview"])).toBe("/id-id/docs/overview");

    expect(buildDocsAlternates(["overview"], ["en-us", "zh-cn", "zh-sg", "id-id"])).toEqual({
      "x-default": "https://lightvela.ai/docs/overview/",
      "zh-CN": "https://lightvela.com/docs/overview/",
      "en-US": "https://lightvela.ai/docs/overview/",
      "zh-SG": "https://lightvela.ai/zh-sg/docs/overview/",
      "id-ID": "https://lightvela.ai/id-id/docs/overview/",
    });
  });

  it("publishes only canonical global routes in the sitemap", async () => {
    await importSeoWithRegion("global");
    const { GET } = await import("../src/app/sitemap.xml/route.next");
    const xml = await GET().text();
    const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);

    expect(locations).toContain("https://lightvela.ai/about/");
    expect(locations).toContain("https://lightvela.ai/zh-sg/about/");
    expect(locations).toContain("https://lightvela.ai/id-id/about/");
    expect(locations).toContain("https://lightvela.ai/docs/overview/");
    expect(locations).toContain("https://lightvela.ai/zh-sg/docs/overview/");
    expect(locations).toContain("https://lightvela.ai/id-id/docs/overview/");
    expect(locations).not.toContain("https://lightvela.ai/en-us/about/");
    expect(locations).not.toContain("https://lightvela.ai/docs/");
    expect(locations).not.toContain("https://lightvela.ai/en-us/docs/overview/");
    expect(locations.every((location) => location.endsWith("/"))).toBe(true);
    // lastmod 现在逐 URL 取「内容更新日期」（真源 src/content/docs/last-updated.json），
    // 只有文档页有；营销 / 法律页不输出。断言它一律是纯日期，
    // 不会因为每天重新构建而变化 —— 这正是曾经用构建时间填充导致的问题。
    const lastmods = [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((match) => match[1]);
    expect(lastmods.length).toBeGreaterThan(0);
    expect(lastmods.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))).toBe(true);
    expect(xml).not.toContain("<lastmod>2026-07-21</lastmod>");
  });

  it("no longer derives sitemap dates from the build date", async () => {
    // `lastModified()` 曾是 sitemap 的唯一时间来源，现已从 sitemap 移除。
    vi.stubEnv("NEXT_PUBLIC_BUILD_DATE", "2026-07-21");
    await importSeoWithRegion("global");
    const { GET } = await import("../src/app/sitemap.xml/route.next");
    const xml = await GET().text();

    expect(xml).not.toContain("2026-07-21");
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
