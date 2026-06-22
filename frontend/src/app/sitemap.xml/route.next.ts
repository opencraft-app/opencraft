import { DOCS_ROUTE_LOCALES, DOCS_ROUTE_SLUGS, type DocsRouteLocale } from '@next-site/docs-route-manifest';
import { DEFAULT_PUBLIC_DOCS_LOCALE } from '@next-site/public-locale';

export const dynamic = 'force-static';

const baseUrl = 'https://lightvela.com';

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function docsPath(locale: DocsRouteLocale | 'default', slug: readonly string[]) {
  const suffix = slug.length > 0 ? `/${slug.join('/')}` : '';
  if (locale === 'default') return `/docs${suffix}`;
  return `/${locale}/docs${suffix}`;
}

export function GET() {
  const urls = [
    '',
    '/about',
    '/changelog',
    '/en-us',
    '/en-us/about',
    '/zh-cn',
    '/zh-cn/about',
    '/zh-sg',
    '/zh-sg/about',
    ...DOCS_ROUTE_SLUGS[DEFAULT_PUBLIC_DOCS_LOCALE].map((slug) => docsPath('default', slug)),
    ...DOCS_ROUTE_LOCALES.flatMap((locale) =>
      DOCS_ROUTE_SLUGS[locale].map((slug) => docsPath(locale, slug)),
    ),
  ];
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((path) => `  <url><loc>${escapeXml(`${baseUrl}${path}`)}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n');

  return new Response(body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
    },
  });
}
