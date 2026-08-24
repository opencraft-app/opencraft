import { notFound } from 'next/navigation';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/page';

import { getMDXComponents } from '../mdx-components';
import {
  BreadcrumbJsonLd,
  buildDocsAlternates,
  canonicalDocsPath,
  createPublicMetadata,
  localizedDocsPath,
  SEO_ALL_DOCS_ROUTE_LOCALES,
  type SeoLocale,
} from './seo';
import { source } from './source';
import { DOCS_ROUTE_SLUGS, type DocsRouteLocale } from './docs-route-manifest';
import {
  EN_US_LOCALE,
  EN_US_URL_LANG,
  ES_LOCALE,
  ES_URL_LANG,
  ID_ID_LOCALE,
  ID_ID_URL_LANG,
  ZH_CN_LOCALE,
  ZH_CN_URL_LANG,
  ZH_HANT_LOCALE,
  ZH_HANT_URL_LANG,
  ZH_SG_LOCALE,
  ZH_SG_URL_LANG,
} from './public-locale';

export type DocsLocalePrefix =
  | typeof EN_US_URL_LANG
  | typeof ZH_CN_URL_LANG
  | typeof ZH_SG_URL_LANG
  | typeof ZH_HANT_URL_LANG
  | typeof ID_ID_URL_LANG
  | typeof ES_URL_LANG
  | undefined;

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
  const breadcrumbRoutePath = canonicalDocsPath(prefix ?? 'default', docsSlug(prefix, slug));
  const breadcrumbName = docsBreadcrumbName(prefix);

  return (
    <>
      <DocsPage toc={page.data.toc} full={page.data.full} className="lv-docs-page">
        <DocsTitle
          className={
            page.data.hide_description
              ? 'lv-docs-title !mb-6 !text-[2rem] !font-bold !leading-[1.2] !tracking-normal'
              : 'lv-docs-title !mb-3 !text-[2rem] !font-bold !leading-[1.2] !tracking-normal'
          }
        >
          {page.data.title}
        </DocsTitle>
        {page.data.hide_description ? null : (
          <DocsDescription className="lv-docs-description !mb-8 !text-base !leading-[1.7]">
            {page.data.description}
          </DocsDescription>
        )}
        <DocsBody className="prose-doc lv-docs-prose">
          <MDX components={getMDXComponents()} />
        </DocsBody>
      </DocsPage>
      <BreadcrumbJsonLd
        items={[
          { name: 'LightVela', path: '/' },
          { name: breadcrumbName, path: canonicalDocsPath(prefix ?? 'default', []) },
          { name: page.data.title, path: breadcrumbRoutePath },
        ]}
      />
    </>
  );
}

export function docsBreadcrumbName(prefix: DocsLocalePrefix): string {
  if (prefix === ID_ID_URL_LANG) return 'Dokumentasi';
  if (prefix === ES_URL_LANG) return 'Documentación';
  return 'Docs';
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
  // 通过单一 lookup 表避免多分支魔法字符串比较（url-lang → SEO locale）。
  const PREFIX_TO_SEO_LOCALE = {
    [EN_US_URL_LANG]: EN_US_LOCALE,
    [ZH_CN_URL_LANG]: ZH_CN_LOCALE,
    [ZH_SG_URL_LANG]: ZH_SG_LOCALE,
    [ZH_HANT_URL_LANG]: ZH_HANT_LOCALE,
    [ID_ID_URL_LANG]: ID_ID_LOCALE,
    [ES_URL_LANG]: ES_LOCALE,
  } as const satisfies Record<Exclude<DocsLocalePrefix, undefined>, SeoLocale>;
  return prefix ? PREFIX_TO_SEO_LOCALE[prefix] : ZH_CN_LOCALE;
}

function docsAvailableLocales(slug: readonly string[]): DocsRouteLocale[] {
  return SEO_ALL_DOCS_ROUTE_LOCALES.filter((locale) =>
    DOCS_ROUTE_SLUGS[locale].some((candidate) => sameSlug(candidate, slug)),
  );
}

function sameSlug(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}
