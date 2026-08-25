import {
  DOCS_ROUTE_LOCALES,
  DOCS_ROUTE_SLUGS,
  docsLastUpdated,
  type DocsRouteLocale,
} from '@next-site/docs-route-manifest';
import { DEFAULT_PUBLIC_DOCS_LOCALE } from '@next-site/public-locale';
import {
  absolutePageUrlForSeoRegion,
  buildDocsAlternates,
  buildPublicAlternates,
  localizedDocsPath,
  localizedPublicPath,
  SEO_ALL_DOCS_ROUTE_LOCALES,
  SEO_DOCS_ROUTE_LOCALES,
  SEO_PUBLIC_URL_LANGS,
  seoRegion,
} from '@next-site/seo';

export const dynamic = 'force-static';

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

type SitemapEntry = {
  path: string;
  alternates?: Record<string, string>;
  /**
   * 内容最后更新日期（YYYY-MM-DD）。
   *
   * ⚠️ 只在能确定「内容实际更新时间」时才填。曾用构建时间填充，
   * 结果每天重新构建都让全站 lastmod 变化 —— Google 会因此不再信任这个信号
   * （官方明确说 lastmod 必须一致准确，否则会被忽略）。
   *
   * 文档页有真源（`src/content/docs/last-updated.json`）；
   * 营销 / 法律页的内容散落在 tsx 与 i18n 字典里，没有可靠的单一时间，
   * 因此**不输出 lastmod** —— 省略比编造更好，Google 允许省略。
   */
  lastModified?: string;
};

function sitemapUrl(entry: SitemapEntry): string {
  const alternates = entry.alternates ?? {};
  return [
    '  <url>',
    `    <loc>${escapeXml(absolutePageUrlForSeoRegion(seoRegion(), entry.path))}</loc>`,
    ...(entry.lastModified ? [`    <lastmod>${escapeXml(entry.lastModified)}</lastmod>`] : []),
    ...Object.entries(alternates).map(([hreflang, path]) =>
      `    <xhtml:link rel="alternate" hreflang="${escapeXml(hreflang)}" href="${escapeXml(path)}" />`,
    ),
    '  </url>',
  ].join('\n');
}

function docsAvailableLocales(slug: readonly string[]): DocsRouteLocale[] {
  return SEO_ALL_DOCS_ROUTE_LOCALES.filter((locale) =>
    DOCS_ROUTE_SLUGS[locale].some((candidate) => sameSlug(candidate, slug)),
  );
}

function sameSlug(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

export function GET() {
  const globalBuild = seoRegion() === 'global';
  const publicPaths = [
    '/',
    '/about',
    '/changelog',
    '/privacy-policy',
    '/terms-of-service',
    '/cookie-policy',
    '/open-source-licenses',
  ];
  /**
   * 需要额外输出「带语言前缀」条目的语言。
   *
   * - 国际站：默认语言 en-US 走裸路径，其余语言（zh-sg / zh-hant / id-id）各有前缀 URL。
   * - 国内站：唯一语言 zh-CN 就是裸路径，**不存在 `/zh-cn/` 路由**。
   *   若在此输出 `/zh-cn/...`，sitemap 会出现一批需 301 或 404 的重复 URL，
   *   与 canonical（self-canonical 到裸路径）互相矛盾。
   */
  const localizedPublicLangs = globalBuild
    ? SEO_PUBLIC_URL_LANGS.filter((lang) => lang !== 'en-us')
    : [];
  const publicEntries: SitemapEntry[] = [
    ...publicPaths.map((path) => ({ path, alternates: buildPublicAlternates(path) })),
    ...localizedPublicLangs.flatMap((lang) =>
      publicPaths.map((path) => ({
        path: localizedPublicPath(path, lang),
        alternates: buildPublicAlternates(path),
      })),
    ),
  ];

  const defaultDocsEntries: SitemapEntry[] = DOCS_ROUTE_SLUGS[DEFAULT_PUBLIC_DOCS_LOCALE]
    // 排除空 slug（即 `/docs/`）：该 URL 返回 200，但渲染的内容与 `/docs/overview/` 相同，
    // 且其 canonical 已指向 `/docs/overview/`。sitemap 只应收录「self-canonical 的 200 终点」，
    // 收录一个 canonical 指向别处的 URL 会与 canonical 信号自相矛盾。
    // 更彻底的做法是在 CDN 层 301（已写入 edgeone.json，见 scripts/write-edgeone-config.mjs）。
    .filter((slug) => slug.length > 0)
    .map((slug) => ({
      path: localizedDocsPath('default', slug),
      alternates: buildDocsAlternates(slug, docsAvailableLocales(slug)),
      lastModified: docsLastUpdated(DEFAULT_PUBLIC_DOCS_LOCALE, slug),
    }));
  // 同上：国内站唯一语言 zh-CN 即裸路径，不输出 `/zh-cn/docs/...` 重复条目
  const localizedDocsEntries: SitemapEntry[] = (globalBuild ? DOCS_ROUTE_LOCALES : []).filter(
    (locale) => SEO_DOCS_ROUTE_LOCALES.includes(locale) && locale !== 'en-us',
  ).flatMap((locale) =>
    DOCS_ROUTE_SLUGS[locale]
      // 同上：`/{lang}/docs/` 空 slug 的 canonical 指向 `/{lang}/docs/overview/`
      .filter((slug) => slug.length > 0)
      .map((slug) => ({
        path: localizedDocsPath(locale, slug),
        alternates: buildDocsAlternates(slug, docsAvailableLocales(slug)),
        lastModified: docsLastUpdated(locale, slug),
      })),
  );

  const urls = [...publicEntries, ...defaultDocsEntries, ...localizedDocsEntries];
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls.map(sitemapUrl),
    '</urlset>',
    '',
  ].join('\n');

  return new Response(body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
    },
  });
}
