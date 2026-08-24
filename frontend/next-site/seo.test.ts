import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DOCS_ROUTE_SLUGS } from "./docs-route-manifest";

vi.mock("@next-site/public-pages", () => ({
  PublicAboutPage: () => null,
  PublicChangelogPage: () => null,
  PublicHomePage: () => null,
}));
vi.mock("@next-site/legal-pages", () => ({
  PublicCookiePolicyPage: () => null,
  PublicOpenSourceLicensesPage: () => null,
  PublicPrivacyPolicyPage: () => null,
  PublicTermsOfServicePage: () => null,
}));
vi.mock("@next-site/subscribe-page-client", () => ({ SubscribePageClient: () => null }));
vi.mock("@next-site/support-page-client", () => ({ SupportPageClient: () => null }));

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
      "id-ID": "https://lightvela.ai/id-id/about/",
      es: "https://lightvela.ai/es/about/",
    });
  });

  it("publishes Spanish SEO without exposing hidden Japanese or Korean locales", async () => {
    const {
      SEO_ALL_DOCS_ROUTE_LOCALES,
      SEO_ALL_PUBLIC_URL_LANGS,
      SEO_DOCS_ROUTE_LOCALES,
      SEO_PUBLIC_URL_LANGS,
      buildPublicAlternates,
      createPublicMetadata,
    } = await importSeoWithRegion("global");

    expect(SEO_PUBLIC_URL_LANGS).toEqual(["en-us", "zh-sg", "zh-hant", "id-id", "es"]);
    expect(SEO_DOCS_ROUTE_LOCALES).toEqual(["en-us", "zh-sg", "zh-hant", "id-id", "es"]);
    expect(SEO_ALL_PUBLIC_URL_LANGS).toEqual(["zh-cn", "en-us", "zh-sg", "zh-hant", "id-id", "es"]);
    expect(SEO_ALL_DOCS_ROUTE_LOCALES).toEqual(["zh-cn", "en-us", "zh-sg", "zh-hant", "id-id", "es"]);
    expect(buildPublicAlternates("/es/about")).toMatchObject({
      es: "https://lightvela.ai/es/about/",
    });
    expect(Object.keys(buildPublicAlternates("/es/about"))).not.toEqual(
      expect.arrayContaining(["ja-JP", "ko-KR"]),
    );

    const metadata = createPublicMetadata({
      path: "/es/about",
      locale: "es",
      title: "Acerca de LightVela",
      description: "Conoce LightVela.",
    });
    expect(metadata.alternates?.canonical).toBe("/es/about");
    expect(metadata.openGraph?.url).toBe("https://lightvela.ai/es/about/");
    expect(metadata.openGraph?.locale).toBe("es_ES");
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

  it("uses unprefixed English and prefixed zh-SG/id-ID URLs in docs hreflang", async () => {
    const { buildDocsAlternates, canonicalDocsPath } = await importSeoWithRegion("global");

    expect(canonicalDocsPath("en-us", ["overview"])).toBe("/docs/overview");
    expect(canonicalDocsPath("zh-sg", ["overview"])).toBe("/zh-sg/docs/overview");
    expect(canonicalDocsPath("id-id", ["overview"])).toBe("/id-id/docs/overview");

    expect(buildDocsAlternates(["overview"], ["en-us", "zh-cn", "zh-sg", "id-id"])).toEqual({
      "x-default": "https://lightvela.ai/docs/overview/",
      "zh-CN": "https://lightvela.com/zh-cn/docs/overview/",
      "en-US": "https://lightvela.ai/docs/overview/",
      "zh-SG": "https://lightvela.ai/zh-sg/docs/overview/",
      "id-ID": "https://lightvela.ai/id-id/docs/overview/",
    });
  });

  it("adds Spanish docs hreflang only when the manifest reports a real equivalent", async () => {
    const { buildDocsAlternates } = await importSeoWithRegion("global");

    expect(buildDocsAlternates(["overview"], ["en-us", "es", "zh-sg", "id-id"])).toMatchObject({
      es: "https://lightvela.ai/es/docs/overview/",
    });
    expect(buildDocsAlternates(["overview"], ["en-us", "zh-sg", "id-id"])).not.toHaveProperty("es");
  });

  it("publishes only canonical global routes in the sitemap", async () => {
    await importSeoWithRegion("global");
    const { GET } = await import("../src/app/sitemap.xml/route.next");
    const xml = await GET().text();
    const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);

    expect(locations).toContain("https://lightvela.ai/about/");
    expect(locations).toContain("https://lightvela.ai/zh-sg/about/");
    expect(locations).toContain("https://lightvela.ai/id-id/about/");
    expect(locations).toContain("https://lightvela.ai/es/");
    expect(locations).toContain("https://lightvela.ai/es/about/");
    expect(locations).toContain("https://lightvela.ai/docs/overview/");
    expect(locations).toContain("https://lightvela.ai/zh-sg/docs/overview/");
    expect(locations).toContain("https://lightvela.ai/id-id/docs/overview/");
    expect(locations).toContain("https://lightvela.ai/es/docs/overview/");
    expect(locations).not.toContain("https://lightvela.ai/es/docs/");
    for (const slug of DOCS_ROUTE_SLUGS.es.filter((parts) => parts.length > 0)) {
      expect(locations).toContain(`https://lightvela.ai/es/docs/${slug.join("/")}/`);
    }
    expect(locations).not.toContain("https://lightvela.ai/es/subscribe/");
    expect(locations).not.toContain("https://lightvela.ai/es/support/");
    expect(locations.some((location) => location.includes("/ja-jp/"))).toBe(false);
    expect(locations.some((location) => location.includes("/ko-kr/"))).toBe(false);
    expect(locations.some((location) => location.startsWith("https://lightvela.com/es"))).toBe(false);
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

  it("keeps the CN release set isolated from Spanish and hidden locales", async () => {
    const { SEO_DOCS_ROUTE_LOCALES, SEO_PUBLIC_URL_LANGS } = await importSeoWithRegion("cn");

    expect(SEO_PUBLIC_URL_LANGS).toEqual(["zh-cn"]);
    expect(SEO_DOCS_ROUTE_LOCALES).toEqual(["zh-cn"]);
  });
});

describe("Spanish public page metadata", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("provides unique Spanish metadata for all nine localized public pages", async () => {
    vi.stubEnv("NEXT_PUBLIC_REGION", "global");
    vi.stubEnv("VITE_REGION", "global");
    const pages = [
      ["/es", "LightVela | Tu agente personal de IA en la nube", () => import("../src/app/(site)/[lang]/page.next")],
      ["/es/about", "Acerca de LightVela", () => import("../src/app/(site)/[lang]/about/page.next")],
      ["/es/changelog", "Novedades", () => import("../src/app/(site)/[lang]/changelog/page.next")],
      ["/es/cookie-policy", "Política de cookies", () => import("../src/app/(site)/[lang]/cookie-policy/page.next")],
      ["/es/open-source-licenses", "Aviso de código abierto", () => import("../src/app/(site)/[lang]/open-source-licenses/page.next")],
      ["/es/privacy-policy", "Política de privacidad", () => import("../src/app/(site)/[lang]/privacy-policy/page.next")],
      ["/es/subscribe", "Elige un plan", () => import("../src/app/(site)/[lang]/subscribe/page.next")],
      ["/es/support", "Ayuda y comentarios", () => import("../src/app/(site)/[lang]/support/page.next")],
      ["/es/terms-of-service", "Términos del servicio", () => import("../src/app/(site)/[lang]/terms-of-service/page.next")],
    ] as const;

    for (const [path, title, load] of pages) {
      const page = await load();
      const metadata = await page.generateMetadata({ params: Promise.resolve({ lang: "es" }) });
      expect(metadata.title).toEqual(path === "/es" ? { absolute: title } : title);
      expect(metadata.description).toEqual(expect.any(String));
      expect(metadata.description).not.toMatch(/LightVela is|Choose the|Submit feedback|Policy|Notice|Terms/);
      expect(metadata.alternates?.canonical).toBe(path);
      expect(metadata.openGraph?.url).toBe(`https://lightvela.ai${path}/`);
      expect(metadata.openGraph?.locale).toBe("es_ES");
    }
    const descriptions = await Promise.all(
      pages.map(async ([, , load]) => {
        const page = await load();
        const metadata = await page.generateMetadata({ params: Promise.resolve({ lang: "es" }) });
        return metadata.description;
      }),
    );
    expect(new Set(descriptions).size).toBe(9);
  });

  it("keeps subscribe and support noindex in Spanish", async () => {
    vi.stubEnv("NEXT_PUBLIC_REGION", "global");
    vi.stubEnv("VITE_REGION", "global");
    const [{ generateMetadata: subscribeMetadata }, { generateMetadata: supportMetadata }] = await Promise.all([
      import("../src/app/(site)/[lang]/subscribe/page.next"),
      import("../src/app/(site)/[lang]/support/page.next"),
    ]);

    await expect(subscribeMetadata({ params: Promise.resolve({ lang: "es" }) })).resolves.toMatchObject({
      robots: { index: false, follow: false },
    });
    await expect(supportMetadata({ params: Promise.resolve({ lang: "es" }) })).resolves.toMatchObject({
      robots: { index: false, follow: false },
    });
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
