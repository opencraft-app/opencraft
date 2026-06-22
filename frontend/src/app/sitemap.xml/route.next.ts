import { DOCS_ROUTE_LOCALES, DOCS_ROUTE_SLUGS, type DocsRouteLocale } from '@next-site/docs-route-manifest';
import { DEFAULT_PUBLIC_DOCS_LOCALE } from '@next-site/public-locale';
import {
  buildDocsAlternates,
  buildPublicAlternates,
  lastModified,
  localizedDocsPath,
  localizedPublicPath,
  SEO_DOCS_ROUTE_LOCALES,
  SEO_PUBLIC_URL_LANGS,
  siteUrl,
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
  const origin = siteUrl();
  const alternates = entry.alternates ?? {};
  return [
    '  <url>',
    `    <loc>${escapeXml(`${origin}${entry.path === '/' ? '' : entry.path}`)}</loc>`,
    `    <lastmod>${escapeXml(lastModified())}</lastmod>`,
    ...Object.entries(alternates).map(([hreflang, path]) =>
      `    <xhtml:link rel="alternate" hreflang="${escapeXml(hreflang)}" href="${escapeXml(`${origin}${path === '/' ? '' : path}`)}" />`,
    ),
    '  </url>',
  ].join('\n');
}

function docsAvailableLocales(slug: readonly string[]): DocsRouteLocale[] {
  return SEO_DOCS_ROUTE_LOCALES.filter((locale) =>
    DOCS_ROUTE_SLUGS[locale].some((candidate) => sameSlug(candidate, slug)),
  );
}

function sameSlug(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

export function GET() {
  const publicPaths = ['/', '/about', '/changelog', '/privacy-policy', '/cookie-policy', '/open-source-licenses'];
  const publicEntries: SitemapEntry[] = [
    ...publicPaths.map((path) => ({ path, alternates: buildPublicAlternates(path) })),
    ...SEO_PUBLIC_URL_LANGS.flatMap((lang) =>
      publicPaths.map((path) => ({
        path: localizedPublicPath(path, lang),
        alternates: buildPublicAlternates(path),
      })),
    ),
  ];

  const defaultDocsEntries: SitemapEntry[] = DOCS_ROUTE_SLUGS[DEFAULT_PUBLIC_DOCS_LOCALE].map((slug) => ({
    path: localizedDocsPath('default', slug),
    alternates: buildDocsAlternates(slug, docsAvailableLocales(slug)),
  }));
  const localizedDocsEntries: SitemapEntry[] = DOCS_ROUTE_LOCALES.filter((locale) =>
    SEO_DOCS_ROUTE_LOCALES.includes(locale),
  ).flatMap((locale) =>
    DOCS_ROUTE_SLUGS[locale].map((slug) => ({
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
