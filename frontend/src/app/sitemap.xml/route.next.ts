import { DOCS_ROUTE_LOCALES, DOCS_ROUTE_SLUGS, type DocsRouteLocale } from '@next-site/docs-route-manifest';
import { DEFAULT_PUBLIC_DOCS_LOCALE } from '@next-site/public-locale';
import {
  absolutePageUrlForSeoRegion,
  buildDocsAlternates,
  buildPublicAlternates,
  lastModified,
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
};

function sitemapUrl(entry: SitemapEntry): string {
  const alternates = entry.alternates ?? {};
  const modified = lastModified();
  return [
    '  <url>',
    `    <loc>${escapeXml(absolutePageUrlForSeoRegion(seoRegion(), entry.path))}</loc>`,
    ...(modified ? [`    <lastmod>${escapeXml(modified)}</lastmod>`] : []),
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
    '/cookie-policy',
    '/open-source-licenses',
  ];
  const localizedPublicLangs = SEO_PUBLIC_URL_LANGS.filter((lang) => !globalBuild || lang !== 'en-us');
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
    .filter((slug) => !globalBuild || slug.length > 0)
    .map((slug) => ({
      path: localizedDocsPath('default', slug),
      alternates: buildDocsAlternates(slug, docsAvailableLocales(slug)),
    }));
  const localizedDocsEntries: SitemapEntry[] = DOCS_ROUTE_LOCALES.filter((locale) =>
    SEO_DOCS_ROUTE_LOCALES.includes(locale) && (!globalBuild || locale !== 'en-us'),
  ).flatMap((locale) =>
    DOCS_ROUTE_SLUGS[locale]
      .filter((slug) => !globalBuild || slug.length > 0)
      .map((slug) => ({
        path: localizedDocsPath(locale, slug),
        alternates: buildDocsAlternates(slug, docsAvailableLocales(slug)),
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
