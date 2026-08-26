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
  | undefined;

export function docsSlug(_prefix: DocsLocalePrefix, slug?: string[]) {
  const pageSlug = slug && slug.length > 0 ? slug : ['overview'];
  return pageSlug;
}

/**
 * 文档页「最后更新于」文案。
 *
 * GEO 用途：AI 检索引擎会用页面新鲜度判断事实可信度。价格、公测状态、渠道清单
 * 这类动态事实若没有时间戳，引擎无法判断该信息是否过期，可能转而引用第三方描述。
 *
 * 时间来自 frontmatter 的 `last_updated`（真源：`src/content/docs/last-updated.json`），
 * **不是构建时间** —— 每天重新构建不会让日期变化，只有内容真的改了才变。
 * 与 sitemap 的 `<lastmod>` 同源，不存在第二处时间镜像。
 *
 * 清单缺条目时返回 null（不渲染），而不是回退到构建日期：
 * 一个错的时间戳比没有时间戳更糟 —— 引擎会信任它。
 * `--check` 会保证清单与磁盘一一对应，正常构建不会走到这个分支。
 */
function lastUpdatedLabel(prefix: DocsLocalePrefix, lastUpdated?: string): string | null {
  if (!lastUpdated) return null;

  if (prefix === ID_ID_URL_LANG) return `Terakhir diperbarui ${lastUpdated}`;
  if (prefix === EN_US_URL_LANG) return `Last updated ${lastUpdated}`;
  // 中文语系（zh-cn / zh-sg / zh-hant）与国内站默认路径统一用中文
  return `最后更新于 ${lastUpdated}`;
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
  const docsBreadcrumbName = prefix === ID_ID_URL_LANG ? 'Dokumentasi' : 'Docs';
  const lastUpdated = lastUpdatedLabel(prefix, page.data.last_updated);

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
        {lastUpdated ? (
          <p className="lv-docs-last-updated mt-12 mb-8 border-t border-[var(--lv-border,#e9ecf1)] pt-6 text-sm text-[var(--text-tertiary,#8a8f98)]">
            {lastUpdated}
          </p>
        ) : null}
      </DocsPage>
      <BreadcrumbJsonLd
        items={[
          { name: 'LightVela', path: '/' },
          { name: docsBreadcrumbName, path: canonicalDocsPath(prefix ?? 'default', []) },
          { name: page.data.title, path: breadcrumbRoutePath },
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
    description: page.data.description ?? '',
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
