import { notFound } from 'next/navigation';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';

import { getMDXComponents } from '../mdx-components';
import {
  BreadcrumbJsonLd,
  buildDocsAlternates,
  createPublicMetadata,
  localizedDocsPath,
  SEO_ALL_DOCS_ROUTE_LOCALES,
  type SeoLocale,
} from './seo';
import { source } from './source';
import { DOCS_ROUTE_SLUGS, type DocsRouteLocale } from './docs-route-manifest';

export type DocsLocalePrefix = 'en-us' | 'zh-cn' | 'zh-sg' | undefined;

export function docsSlug(_prefix: DocsLocalePrefix, slug?: string[]) {
  const pageSlug = slug && slug.length > 0 ? slug : ['overview'];
  return pageSlug;
}

export function getDocsPage(prefix: DocsLocalePrefix, slug?: string[]) {
  const page = source.getPage(docsSlug(prefix, slug), prefix);
  if (!page) notFound();
  return page;
}

export function LightVelaDocsPage({ prefix, slug }: { prefix?: DocsLocalePrefix; slug?: string[] }) {
  const page = getDocsPage(prefix, slug);
  const MDX = page.data.body;
  const routePath = localizedDocsPath(prefix ?? 'default', docsSlug(prefix, slug));

  return (
    <>
      <DocsPage toc={page.data.toc} full={page.data.full} className="lv-docs-page">
        <DocsTitle className="lv-docs-title !mb-3 !text-[2rem] !font-bold !leading-[1.2] !tracking-normal">
          {page.data.title}
        </DocsTitle>
        <DocsDescription className="lv-docs-description !mb-8 !text-base !leading-[1.7]">
          {page.data.description}
        </DocsDescription>
        <DocsBody className="prose-doc lv-docs-prose">
          <MDX components={getMDXComponents()} />
        </DocsBody>
      </DocsPage>
      <BreadcrumbJsonLd
        items={[
          { name: 'LightVela', path: '/' },
          { name: 'Docs', path: localizedDocsPath(prefix ?? 'default', []) },
          { name: page.data.title, path: routePath },
        ]}
      />
    </>
  );
}

export function docsMetadata(prefix: DocsLocalePrefix, slug?: string[]) {
  const page = getDocsPage(prefix, slug);
  const pageSlug = docsSlug(prefix, slug);
  const routeLocale = docsSeoLocale(prefix);
  const availableLocales = docsAvailableLocales(pageSlug);

  return createPublicMetadata({
    path: localizedDocsPath(prefix ?? 'default', pageSlug),
    locale: routeLocale,
    title: page.data.title,
    description: page.data.description,
    alternates: buildDocsAlternates(pageSlug, availableLocales),
  });
}

function docsSeoLocale(prefix: DocsLocalePrefix): SeoLocale {
  if (prefix === 'en-us') return 'en-US';
  if (prefix === 'zh-sg') return 'zh-SG';
  return 'zh-CN';
}

function docsAvailableLocales(slug: readonly string[]): DocsRouteLocale[] {
  return SEO_ALL_DOCS_ROUTE_LOCALES.filter((locale) =>
    DOCS_ROUTE_SLUGS[locale].some((candidate) => sameSlug(candidate, slug)),
  );
}

function sameSlug(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}
