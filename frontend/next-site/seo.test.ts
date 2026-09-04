import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DOCS_ROUTE_SLUGS } from "./docs-route-manifest";

vi.mock("@next-site/public-pages", () => ({
  PublicAboutPage: () => null,
  PublicBlogPage: () => null,
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

type JsonLdElement = {
  props: {
    dangerouslySetInnerHTML: {
      __html: string;
    };
  };
};

type JsonLdWrapperElement = {
  type: (props: { id: string; data: unknown }) => unknown;
  props: {
    id: string;
    data: unknown;
  };
};

function jsonLdData(node: unknown): unknown {
  const wrapper = node as JsonLdWrapperElement;
  const element = wrapper.type(wrapper.props) as JsonLdElement;
  return JSON.parse(element.props.dangerouslySetInnerHTML.__html);
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

  it("omits international social sameAs links from cn structured data", async () => {
    const { OrganizationJsonLd, SiteJsonLd } = await importSeoWithRegion("cn");

    const siteData = jsonLdData(SiteJsonLd());
    const organizationData = jsonLdData(OrganizationJsonLd());

    expect(siteData).toEqual([
      expect.not.objectContaining({
        sameAs: expect.arrayContaining([
          "https://discord.gg/Myh58xEMe2",
          "https://chat.whatsapp.com/KLF9OvdAj4sDdojG20JA9b",
        ]),
      }),
      expect.any(Object),
    ]);
    expect(organizationData).not.toHaveProperty("sameAs");
  });

  it("keeps global structured data linked to official international profiles", async () => {
    const { OrganizationJsonLd, SiteJsonLd } = await importSeoWithRegion("global");

    const [siteOrganization] = jsonLdData(SiteJsonLd()) as [{ sameAs: string[] }];
    const organization = jsonLdData(OrganizationJsonLd()) as { sameAs: string[] };

    expect(siteOrganization.sameAs).toEqual(
      expect.arrayContaining([
        "https://discord.gg/Myh58xEMe2",
        "https://chat.whatsapp.com/KLF9OvdAj4sDdojG20JA9b",
        "https://x.com/agentlightvela",
        "https://www.youtube.com/@TencentLightVela",
      ]),
    );
    expect(organization.sameAs).toEqual(
      expect.arrayContaining(["https://x.com/agentlightvela", "https://www.youtube.com/@TencentLightVela"]),
    );
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
      es: "https://lightvela.ai/es/about/",
      "ja-JP": "https://lightvela.ai/ja-jp/about/",
      "ko-KR": "https://lightvela.ai/ko-kr/about/",
    });
  });

  it("keeps English-only Blog content alternates on the global site", async () => {
    const { buildGlobalEnglishContentAlternates } = await importSeoWithRegion("global");

    expect(buildGlobalEnglishContentAlternates("/blog")).toEqual({
      "x-default": "https://lightvela.ai/blog/",
      "en-US": "https://lightvela.ai/blog/",
    });
  });

  it("publishes Spanish, Japanese and Korean SEO from the registry", async () => {
    const {
      SEO_ALL_DOCS_ROUTE_LOCALES,
      SEO_ALL_PUBLIC_URL_LANGS,
      SEO_DOCS_ROUTE_LOCALES,
      SEO_PUBLIC_URL_LANGS,
      buildPublicAlternates,
      createPublicMetadata,
    } = await importSeoWithRegion("global");

    expect(SEO_PUBLIC_URL_LANGS).toEqual([
      "en-us", "zh-sg", "zh-hant", "id-id", "es", "ja-jp", "ko-kr",
    ]);
    expect(SEO_DOCS_ROUTE_LOCALES).toEqual([
      "en-us", "zh-sg", "zh-hant", "id-id", "es", "ja-jp", "ko-kr",
    ]);
    expect(SEO_ALL_PUBLIC_URL_LANGS).toEqual([
      "zh-cn", "en-us", "zh-sg", "zh-hant", "id-id", "es", "ja-jp", "ko-kr",
    ]);
    expect(SEO_ALL_DOCS_ROUTE_LOCALES).toEqual([
      "zh-cn", "en-us", "zh-sg", "zh-hant", "id-id", "es", "ja-jp", "ko-kr",
    ]);
    expect(buildPublicAlternates("/es/about")).toMatchObject({
      es: "https://lightvela.ai/es/about/",
    });
    expect(Object.keys(buildPublicAlternates("/es/about"))).toEqual(
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

  it("builds self-consistent Japanese metadata before the release switch is opened", async () => {
    const { createPublicMetadata } = await importSeoWithRegion("global");

    const metadata = createPublicMetadata({
      path: "/ja-jp/about",
      locale: "ja-JP",
      title: "LightVelaについて",
      description: "LightVelaのクラウドAIエージェントについて紹介します。",
    });

    expect(metadata.alternates?.canonical).toBe("/ja-jp/about");
    expect(metadata.openGraph?.url).toBe("https://lightvela.ai/ja-jp/about/");
    expect(metadata.openGraph?.locale).toBe("ja_JP");
    expect(metadata.keywords).toEqual(expect.arrayContaining(["クラウドAIエージェント", "AIアシスタント"]));
  });

  it("uses Japanese SoftwareApplication structured data", async () => {
    const { SOFTWARE_APPLICATION_DESCRIPTIONS } = await importSeoWithRegion("global");
    const description = SOFTWARE_APPLICATION_DESCRIPTIONS["ja-JP"];

    expect(description).toContain("長期的に使える自分専用のAIアシスタント");
    expect(description).not.toContain("越聊越懂你");
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

    expect([...SEO_PREFIXED_PUBLIC_URL_LANGS]).toEqual([
      "zh-sg", "zh-hant", "id-id", "es", "ja-jp", "ko-kr",
    ]);
    // 默认语言只有裸路径，前缀路由一律拒绝
    expect(prefixedPublicRouteLocale("en-us")).toBeNull();
    expect(prefixedPublicRouteLocale("zh-cn")).toBeNull();
    expect(prefixedPublicRouteLocale("zh-sg")).toEqual({ locale: "zh-SG", localized: true });
    expect(prefixedPublicRouteLocale("id-id")).toEqual({ locale: "id-ID", localized: true });
    expect(prefixedPublicRouteLocale("es")).toEqual({ locale: "es", localized: true });
    expect(prefixedPublicRouteLocale("ja-jp")).toEqual({ locale: "ja-JP", localized: true });
    expect(prefixedPublicRouteLocale("ko-kr")).toEqual({ locale: "ko-KR", localized: true });
    expect(prefixedPublicRouteLocale("fr")).toBeNull();
  });

  it("generates no prefixed routes at all on the cn build", async () => {
    const { prefixedPublicRouteLocale, SEO_PREFIXED_PUBLIC_URL_LANGS } = await importSeoWithRegion("cn");

    expect([...SEO_PREFIXED_PUBLIC_URL_LANGS]).toEqual([]);
    for (const lang of ["zh-cn", "en-us", "zh-sg", "zh-hant", "id-id", "es"]) {
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
    expect(locations).toContain("https://lightvela.ai/ja-jp/about/");
    expect(locations).toContain("https://lightvela.ai/ko-kr/about/");
    expect(locations).toContain("https://lightvela.ai/ja-jp/docs/overview/");
    expect(locations).toContain("https://lightvela.ai/ko-kr/docs/overview/");
    expect(locations).not.toContain("https://lightvela.ai/es/docs/");
    for (const slug of DOCS_ROUTE_SLUGS.es.filter((parts) => parts.length > 0)) {
      expect(locations).toContain(`https://lightvela.ai/es/docs/${slug.join("/")}/`);
    }
    expect(locations).not.toContain("https://lightvela.ai/es/subscribe/");
    expect(locations).not.toContain("https://lightvela.ai/es/support/");
    expect(locations.some((location) => location.includes("/ja-jp/"))).toBe(true);
    expect(locations.some((location) => location.includes("/ko-kr/"))).toBe(true);
    expect(locations.some((location) => location.startsWith("https://lightvela.com/es"))).toBe(false);
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
      ["/es", "LightVela | Tu agente personal de IA en la nube", () => import("../src/app/(site)/[lang]/page.intl")],
      ["/es/about", "Acerca de LightVela", () => import("../src/app/(site)/[lang]/about/page.intl")],
      ["/es/blog", "Blog", () => import("../src/app/(site)/[lang]/blog/page.intl")],
      ["/es/changelog", "Novedades", () => import("../src/app/(site)/[lang]/changelog/page.intl")],
      ["/es/cookie-policy", "Política de cookies", () => import("../src/app/(site)/[lang]/cookie-policy/page.intl")],
      ["/es/open-source-licenses", "Aviso de código abierto", () => import("../src/app/(site)/[lang]/open-source-licenses/page.intl")],
      ["/es/privacy-policy", "Política de privacidad", () => import("../src/app/(site)/[lang]/privacy-policy/page.intl")],
      ["/es/subscribe", "Elige un plan", () => import("../src/app/(site)/[lang]/subscribe/page.intl")],
      ["/es/terms-of-service", "Términos del servicio", () => import("../src/app/(site)/[lang]/terms-of-service/page.intl")],
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

  it("keeps subscribe noindex in Spanish", async () => {
    vi.stubEnv("NEXT_PUBLIC_REGION", "global");
    vi.stubEnv("VITE_REGION", "global");
    const { generateMetadata: subscribeMetadata } = await import("../src/app/(site)/[lang]/subscribe/page.intl");

    await expect(subscribeMetadata({ params: Promise.resolve({ lang: "es" }) })).resolves.toMatchObject({
      robots: { index: false, follow: false },
    });
  });
});

describe("Japanese public page metadata copy", () => {
  it("provides Japanese title and description for all nine future localized routes", async () => {
    const { japaneseRouteDescription, japaneseRouteTitle } = await import("../src/lib/seo-data.ja");
    const paths = [
      "/",
      "/about",
      "/blog",
      "/changelog",
      "/cookie-policy",
      "/open-source-licenses",
      "/privacy-policy",
      "/subscribe",
      "/terms-of-service",
    ] as const;

    for (const path of paths) {
      expect(japaneseRouteTitle(path)).toMatch(/[ぁ-んァ-ヶ一-龯]/u);
      expect(japaneseRouteDescription(path)).toMatch(/[ぁ-んァ-ヶ一-龯]/u);
    }
  });
});

describe("Korean public page metadata copy", () => {
  it("provides Korean title and description for all nine future localized routes", async () => {
    const { koreanRouteDescription, koreanRouteTitle } = await import("../src/lib/seo-data.ko");
    const paths = [
      "/",
      "/about",
      "/blog",
      "/changelog",
      "/cookie-policy",
      "/open-source-licenses",
      "/privacy-policy",
      "/subscribe",
      "/terms-of-service",
    ] as const;

    for (const path of paths) {
      expect(koreanRouteTitle(path)).toMatch(/[가-힣]/u);
      expect(koreanRouteDescription(path)).toMatch(/[가-힣]/u);
    }
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
